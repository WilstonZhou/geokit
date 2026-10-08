/**
 * T8 竞品情报测试
 *
 * 覆盖：
 *   - 5 维度触发与 gap 判定
 *   - blocked/unavailable 降级
 *   - evidence 非空
 *   - 数据部分缺失场景
 *   - buildGapList 聚合
 *   - analyzeCompetitors 端到端（纯数据，无 fetch）
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { compareSerpPositions } from "../../src/lib/competitor/serp";
import { compareAiMentions } from "../../src/lib/competitor/ai";
import { compareGeoScores } from "../../src/lib/competitor/geo";
import { compareAiCrawlProtocol } from "../../src/lib/competitor/protocol";
import { compareStructuredData } from "../../src/lib/competitor/schema";
import { buildGapList } from "../../src/lib/competitor/gaps";
import { analyzeCompetitors } from "../../src/lib/competitor/analyze";
import type {
  CompetitorInput,
} from "../../src/lib/competitor/types";
import type { SerpResponse } from "../../src/lib/serp";
import type { CitationRecord } from "../../src/lib/evidence/types";
import type { GeoAuditSource } from "../../src/lib/competitor/geo";
import type { PageAudit } from "../../src/lib/audit";
import type { DimensionComparison } from "../../src/lib/competitor/types";

// ── Fixtures ──

function makeSerp(
  engine: string,
  engineName: string,
  keyword: string,
  items: { position: number; domain: string; url: string; title?: string }[],
  opts: { targetRank?: number | null; targetFound?: boolean; status?: string } = {}
): SerpResponse {
  return {
    engine: engine as SerpResponse["engine"],
    engineName,
    keyword,
    status: (opts.status ?? "ok") as SerpResponse["status"],
    items: items.map((i) => ({
      position: i.position,
      title: i.title ?? `Result ${i.position}`,
      url: i.url,
      domain: i.domain,
      snippet: "...",
      owned: false,
      redirectWrapper: false,
      resolved: true,
    })),
    targetRank: opts.targetRank ?? null,
    targetFound: opts.targetFound ?? false,
    fetchedAt: "2026-10-08T00:00:00Z",
    elapsedMs: 1000,
  };
}

function makeCitation(
  model: string,
  mentioned: boolean,
  citations: { url: string; position?: number }[],
  competitorsMentioned: string[] = []
): CitationRecord {
  return {
    query: "test query",
    model,
    answerText: "answer",
    mentioned,
    citations: citations.map((c) => ({ url: c.url, position: c.position })),
    citationsStatus: "ok",
    competitorsMentioned,
    observedAt: "2026-10-08T00:00:00Z",
  };
}

function makeGeoSource(url: string, score: number, httpStatus = 200): GeoAuditSource {
  return {
    url,
    httpStatus,
    geoScore: score,
    geoBreakdown: [
      { id: "citeability", label: "可引用性", score: Math.round(score * 0.3), max: 20 },
      { id: "structure", label: "结构化", score: Math.round(score * 0.2), max: 20 },
    ],
  };
}

function makeRobots(score: number, blockedCrawlers: string[] = []) {
  const policies = blockedCrawlers.map((name) => ({
    crawler: { ua: name, name, vendor: "v", purpose: "训练" as const, cnRelevant: false },
    policy: "blocked" as const,
    matchedRule: `Disallow: /`,
    implication: "blocked",
  }));
  return {
    url: "https://example.com/robots.txt",
    exists: true,
    raw: "User-agent: *\nDisallow:",
    sitemaps: [],
    policies,
    aiOpennessScore: score,
    summary: `AI 开放度 ${score}`,
    recommendations: [],
  };
}

function makeLlmsTxt(exists: boolean, score: number) {
  return {
    url: "https://example.com/llms.txt",
    exists,
    bytes: exists ? 200 : 0,
    lineCount: exists ? 10 : 0,
    hasTitle: exists,
    title: exists ? "Example" : null,
    hasBlockquoteSummary: exists,
    sections: exists ? 2 : 0,
    linkCount: exists ? 5 : 0,
    issues: [],
    score,
    raw: exists ? "..." : null,
    recommendations: [],
  };
}

// ── SERP 维度 ──

test("compareSerpPositions: 用户落后于竞品", () => {
  const serps = [
    makeSerp("baidu", "百度", "kw", [
      { position: 1, domain: "rival.com", url: "https://rival.com/a" },
      { position: 5, domain: "example.com", url: "https://example.com/a" },
    ], { targetRank: 5, targetFound: true }),
  ];
  const dim = compareSerpPositions(serps, "example.com", ["rival.com"]);
  assert.strictEqual(dim.gap, "behind");
  assert.strictEqual(dim.userValue!.averageRank, 5);
  assert.strictEqual(dim.competitorValues[0].value!.averageRank, 1);
  assert.ok(dim.userEvidence.length > 0, "evidence 非空");
});

test("compareSerpPositions: 用户领先", () => {
  const serps = [
    makeSerp("baidu", "百度", "kw", [
      { position: 1, domain: "example.com", url: "https://example.com/a" },
      { position: 3, domain: "rival.com", url: "https://rival.com/a" },
    ], { targetRank: 1, targetFound: true }),
  ];
  const dim = compareSerpPositions(serps, "example.com", ["rival.com"]);
  assert.strictEqual(dim.gap, "ahead");
});

test("compareSerpPositions: 无数据 → unavailable", () => {
  const dim = compareSerpPositions([], "example.com", ["rival.com"]);
  assert.strictEqual(dim.userStatus, "unavailable");
  assert.strictEqual(dim.gap, "incomparable");
  assert.strictEqual(dim.userValue, null);
});

test("compareSerpPositions: 引擎 blocked → blocked 状态", () => {
  const serps = [
    makeSerp("baidu", "百度", "kw", [], { status: "blocked" }),
  ];
  const dim = compareSerpPositions(serps, "example.com", ["rival.com"]);
  assert.strictEqual(dim.userStatus, "blocked");
});

// ── AI 维度 ──

test("compareAiMentions: 用户未被引用、竞品被引用 → behind", () => {
  const records = [
    makeCitation("gpt-4o", false, [{ url: "https://rival.com/a", position: 1 }], ["rival.com"]),
  ];
  const dim = compareAiMentions(records, "example.com", ["rival.com"]);
  assert.strictEqual(dim.gap, "behind");
  assert.strictEqual(dim.userValue!.citationCount, 0);
  assert.strictEqual(dim.competitorValues[0].value!.citationCount, 1);
});

test("compareAiMentions: 无数据 → unavailable", () => {
  const dim = compareAiMentions([], "example.com", ["rival.com"]);
  assert.strictEqual(dim.userStatus, "unavailable");
  assert.strictEqual(dim.gap, "incomparable");
});

test("compareAiMentions: 用户被引用更多 → ahead", () => {
  const records = [
    makeCitation("gpt-4o", true, [{ url: "https://example.com/a", position: 1 }], []),
    makeCitation("claude", true, [{ url: "https://example.com/b", position: 2 }], []),
  ];
  const dim = compareAiMentions(records, "example.com", ["rival.com"]);
  assert.strictEqual(dim.gap, "ahead");
  assert.strictEqual(dim.userValue!.citationCount, 2);
});

// ── GEO 维度 ──

test("compareGeoScores: 用户低分、竞品高分 → behind", async () => {
  const dim = await compareGeoScores("example.com", ["rival.com"], {
    userAudits: [makeGeoSource("https://example.com/a", 45)],
    competitorAudits: [{ domain: "rival.com", audits: [makeGeoSource("https://rival.com/a", 65)] }],
  });
  assert.strictEqual(dim.gap, "behind");
  assert.strictEqual(dim.userValue!.averageScore, 45);
  assert.strictEqual(dim.competitorValues[0].value!.averageScore, 65);
});

test("compareGeoScores: blocked 页面 → blocked 状态", async () => {
  const dim = await compareGeoScores("example.com", ["rival.com"], {
    userAudits: [makeGeoSource("https://example.com/a", 50)],
    competitorAudits: [{ domain: "rival.com", audits: [makeGeoSource("https://rival.com/a", 0, 403)] }],
  });
  assert.strictEqual(dim.competitorValues[0].status, "blocked");
});

test("compareGeoScores: 无数据 → unavailable", async () => {
  const dim = await compareGeoScores("example.com", ["rival.com"], {});
  assert.strictEqual(dim.userStatus, "unavailable");
  assert.strictEqual(dim.gap, "incomparable");
});

// ── Protocol 维度 ──

test("compareAiCrawlProtocol: 用户开放度低 → behind", async () => {
  const dim = await compareAiCrawlProtocol("example.com", ["rival.com"], {
    userRobots: makeRobots(30, ["GPTBot"]),
    userLlmsTxt: makeLlmsTxt(false, 0),
    competitorRobots: [{ domain: "rival.com", analysis: makeRobots(80, []) }],
    competitorLlmsTxt: [{ domain: "rival.com", analysis: makeLlmsTxt(true, 70) }],
  });
  assert.strictEqual(dim.gap, "behind");
  assert.strictEqual(dim.userValue!.aiOpennessScore, 30);
  assert.strictEqual(dim.competitorValues[0].value!.aiOpennessScore, 80);
});

test("compareAiCrawlProtocol: 无数据 → unavailable", async () => {
  const dim = await compareAiCrawlProtocol("example.com", ["rival.com"], {});
  assert.strictEqual(dim.userStatus, "unavailable");
  assert.strictEqual(dim.gap, "incomparable");
});

// ── Schema 维度 ──

test("compareStructuredData: 用户类型少 → behind", () => {
  const dim = compareStructuredData(
    [{ jsonLdTypes: ["Article"] }],
    [{ domain: "rival.com", sources: [{ jsonLdTypes: ["Article", "FAQPage", "Organization"] }] }]
  );
  assert.strictEqual(dim.gap, "behind");
  assert.strictEqual(dim.userValue!.typeCount, 1);
  assert.strictEqual(dim.competitorValues[0].value!.typeCount, 3);
});

test("compareStructuredData: 无数据 → incomparable", () => {
  const dim = compareStructuredData([], []);
  assert.strictEqual(dim.gap, "incomparable");
});

// ── Gaps ──

test("buildGapList: 只收集 behind 的维度", () => {
  const dims = [
    { dimension: "serp" as const, gap: "behind" as const, summary: "落后", gapDetail: "rival 领先", userValue: { averageRank: 5 }, userEvidence: [], competitorValues: [{ domain: "rival.com", value: { averageRank: 1 }, status: "available" as const, evidence: [] }] },
    { dimension: "ai" as const, gap: "ahead" as const, summary: "领先", userValue: { mentionCount: 5 }, userEvidence: [], competitorValues: [] },
  ];
  const gaps = buildGapList(dims as unknown as DimensionComparison<unknown>[]);
  assert.strictEqual(gaps.length, 1);
  assert.strictEqual(gaps[0].dimension, "serp");
  assert.ok(gaps[0].evidence.length >= 0);
});

// ── 端到端 ──

test("analyzeCompetitors: 五维度全预收集数据", async () => {
  const input: CompetitorInput = {
    userDomain: "example.com",
    competitors: ["rival.com"],
    serpResults: [
      makeSerp("baidu", "百度", "kw", [
        { position: 1, domain: "rival.com", url: "https://rival.com/a" },
        { position: 5, domain: "example.com", url: "https://example.com/a" },
      ], { targetRank: 5, targetFound: true }),
    ],
    aiCitations: [
      makeCitation("gpt-4o", false, [{ url: "https://rival.com/a", position: 1 }], ["rival.com"]),
    ],
    userPageAudits: [
      { url: "https://example.com/a", httpStatus: 200, geoScore: 40, geoBreakdown: [{ id: "citeability", label: "可引用性", score: 8, max: 20, comment: "" }], jsonLdTypes: ["Article"], title: null, titleLength: 0, metaDescription: null, metaDescriptionLength: 0, canonical: null, robotsMeta: null, hreflang: [], headings: [], ogTags: {}, twitterTags: {}, wordCount: 100, imageCount: 0, imagesWithoutAlt: 0, internalLinks: 0, externalLinks: 0, hasViewport: false, lang: null, checks: [], seoScore: 40, recommendations: [] } as unknown as PageAudit,
    ],
    competitorPageAudits: [
      { domain: "rival.com", audits: [
        { url: "https://rival.com/a", httpStatus: 200, geoScore: 65, geoBreakdown: [{ id: "citeability", label: "可引用性", score: 16, max: 20, comment: "" }], jsonLdTypes: ["Article", "FAQPage"], title: null, titleLength: 0, metaDescription: null, metaDescriptionLength: 0, canonical: null, robotsMeta: null, hreflang: [], headings: [], ogTags: {}, twitterTags: {}, wordCount: 200, imageCount: 0, imagesWithoutAlt: 0, internalLinks: 0, externalLinks: 0, hasViewport: false, lang: null, checks: [], seoScore: 65, recommendations: [] } as unknown as PageAudit,
      ] },
    ],
    userRobots: makeRobots(30, ["GPTBot"]),
    userLlmsTxt: makeLlmsTxt(false, 0),
    competitorRobots: [{ domain: "rival.com", analysis: makeRobots(80, []) }],
    competitorLlmsTxt: [{ domain: "rival.com", analysis: makeLlmsTxt(true, 70) }],
  };

  const report = await analyzeCompetitors(input);

  // 5 维度都在
  assert.strictEqual(report.dimensions.length, 5);
  // 有差距
  assert.ok(report.gaps.length > 0, "应有差距");
  // 每个差距都有 evidence
  for (const gap of report.gaps) {
    assert.ok(gap.evidence.length > 0, `差距 ${gap.dimension} 缺 evidence`);
    assert.ok(gap.affectedCompetitors.length > 0, `差距 ${gap.dimension} 缺 affectedCompetitors`);
  }
  // sourceAvailability 有 5 个维度
  assert.strictEqual(Object.keys(report.sourceAvailability!).length, 5);
});

test("analyzeCompetitors: 全部缺数据 → 全 unavailable", async () => {
  const input: CompetitorInput = {
    userDomain: "example.com",
    competitors: ["rival.com"],
  };
  const report = await analyzeCompetitors(input);
  assert.strictEqual(report.dimensions.length, 5);
  for (const dim of report.dimensions) {
    assert.strictEqual(dim.userStatus, "unavailable");
  }
  assert.strictEqual(report.gaps.length, 0);
});
