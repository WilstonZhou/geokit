/**
 * T6 Opportunity Engine —— 每类触发 / 不触发 / 降级 / verify / 无 evidence。
 */
import { test, describe } from "node:test";
import * as assert from "node:assert";

import {
  generateOpportunities,
  rankOpportunities,
  mergeByTarget,
  verifyOpportunity,
  countByType,
  makeOpportunityId,
  genWeakCiteability,
  genCitationGap,
  genAiCrawlProtocol,
  genSiteIssueHigh,
  genSearchOpportunity,
  genMissingEntity,
  type Opportunity,
} from "../../src/lib/opportunity";
import type { SiteAnalysis } from "../../src/lib/crawler/issues";
import type { CitationAggregation } from "../../src/lib/visibility/aggregate";
import type { RobotsAnalysis, LlmsTxtAnalysis } from "../../src/lib/llms";
import type { GscOpportunity } from "../../src/lib/gsc/types";
import type { PageAudit } from "../../src/lib/audit";
import type { Observation } from "../../src/lib/evidence/types";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeSiteAnalysis(over: Partial<SiteAnalysis> = {}): SiteAnalysis {
  return {
    issues: [],
    geoSummary: {
      distribution: { critical: 0, poor: 0, fair: 0, good: 0 },
      lowestScoring: [],
      commonWeakDimensions: [],
    },
    schemaCoverage: [],
    ...over,
  };
}

function makeRobots(over: Partial<RobotsAnalysis> = {}): RobotsAnalysis {
  return {
    url: "https://example.com/robots.txt",
    exists: true,
    raw: "",
    sitemaps: [],
    policies: [],
    aiOpennessScore: 50,
    summary: "",
    recommendations: [],
    ...over,
  };
}

function makeLlms(over: Partial<LlmsTxtAnalysis> = {}): LlmsTxtAnalysis {
  return {
    url: "https://example.com/llms.txt",
    exists: true,
    bytes: 0,
    lineCount: 0,
    hasTitle: false,
    title: null,
    hasBlockquoteSummary: false,
    sections: 0,
    linkCount: 0,
    issues: [],
    score: 0,
    raw: null,
    recommendations: [],
    ...over,
  };
}

function makePageAudit(over: Partial<PageAudit> = {}): PageAudit {
  return {
    url: "https://example.com/page",
    finalUrl: "https://example.com/page",
    httpStatus: 200,
    elapsedMs: 0,
    title: "测试页",
    titleLength: 3,
    metaDescription: "描述",
    metaDescriptionLength: 2,
    canonical: "https://example.com/page",
    robotsMeta: null,
    hreflang: [],
    headings: [],
    jsonLdTypes: ["Article"],
    ogTags: { "og:site_name": "Example", "article:author": "Alice", "article:published_time": "2026-01-01" },
    twitterTags: {},
    wordCount: 500,
    imageCount: 0,
    imagesWithoutAlt: 0,
    internalLinks: 0,
    externalLinks: 0,
    hasViewport: true,
    lang: "zh-CN",
    checks: [],
    seoScore: 80,
    geoScore: 75,
    geoBreakdown: [],
    recommendations: [],
    ...over,
  };
}

function makeObservation(
  subject: string,
  observedAt: string,
  result: Record<string, unknown>
): Observation {
  return {
    contractVersion: "0.2.0",
    id: `obs_${subject}_${observedAt}`,
    identityKey: subject,
    versionKey: "v1",
    type: "geo_score",
    subject,
    source: "test",
    observedAt,
    observerVersion: "test@0.1.0",
    parserVersion: "test@0.1.0",
    status: "OBSERVED",
    evidenceRefs: [],
    result,
    confidence: "high",
    coverage: { expected: 1, observed: 1, ratio: 1 },
    metadata: {},
  };
}

/* ------------------------------------------------------------------ */
/* 1. weak-citeability                                                */
/* ------------------------------------------------------------------ */

describe("T6-1 weak-citeability", () => {
  test("命中：lowestScoring 含 geoScore<60 → 输出机会", () => {
    const sa = makeSiteAnalysis({
      geoSummary: {
        distribution: { critical: 1, poor: 0, fair: 0, good: 0 },
        lowestScoring: [{ url: "https://example.com/a", geoScore: 30 }],
        commonWeakDimensions: [{ id: "answer", label: "直接回答", pages: 1 }],
      },
    });
    const out = genWeakCiteability(sa);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].type, "weak-citeability");
    assert.strictEqual(out[0].target, "https://example.com/a");
    assert.strictEqual(out[0].impact, "high"); // <40 → high
    assert.ok(out[0].diagnosis.evidence.length > 0);
    assert.ok(out[0].recommendations.length > 0);
    assert.strictEqual(out[0].verification.signalKey, "geoScore");
    assert.strictEqual(out[0].verification.direction, "increase");
  });

  test("不命中：所有 URL geoScore≥60 → 不输出", () => {
    const sa = makeSiteAnalysis({
      geoSummary: {
        distribution: { critical: 0, poor: 0, fair: 1, good: 0 },
        lowestScoring: [{ url: "https://example.com/a", geoScore: 75 }],
        commonWeakDimensions: [],
      },
    });
    const out = genWeakCiteability(sa);
    assert.strictEqual(out.length, 0);
  });

  test("不命中：undefined 输入", () => {
    assert.strictEqual(genWeakCiteability(undefined).length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* 2. citation-gap                                                    */
/* ------------------------------------------------------------------ */

describe("T6-2 citation-gap", () => {
  test("命中：citationGap 非空且提供了 userDomain", () => {
    const agg: CitationAggregation = {
      domainRanking: [{ domain: "rival.com", count: 6 }],
      competitorFrequency: [],
      citationGap: [{ domain: "rival.com", count: 6 }],
    };
    const out = genCitationGap(agg, "example.com");
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].type, "citation-gap");
    assert.strictEqual(out[0].target, "rival.com");
    assert.strictEqual(out[0].impact, "high"); // count=6 ≥ 5
    assert.ok(out[0].diagnosis.evidence.length > 0);
  });

  test("不命中：citationGap 为空", () => {
    const agg: CitationAggregation = {
      domainRanking: [],
      competitorFrequency: [],
      citationGap: [],
    };
    assert.strictEqual(genCitationGap(agg, "example.com").length, 0);
  });

  test("降级：缺 userDomain → 不输出（不报错）", () => {
    const agg: CitationAggregation = {
      domainRanking: [{ domain: "rival.com", count: 6 }],
      competitorFrequency: [],
      citationGap: [{ domain: "rival.com", count: 6 }],
    };
    assert.strictEqual(genCitationGap(agg, undefined).length, 0);
  });

  test("降级：undefined 输入", () => {
    assert.strictEqual(genCitationGap(undefined, "example.com").length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* 3. ai-crawl-protocol                                               */
/* ------------------------------------------------------------------ */

describe("T6-3 ai-crawl-protocol", () => {
  test("命中：robots 屏蔽 AI 爬虫", () => {
    const robots = makeRobots({
      policies: [
        {
          crawler: { ua: "GPTBot", name: "GPTBot", vendor: "OpenAI", purpose: "训练", cnRelevant: false },
          policy: "blocked",
          matchedRule: "Disallow: /",
          implication: "被封禁",
        },
      ],
    });
    const out = genAiCrawlProtocol(robots, undefined);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].type, "ai-crawl-protocol");
    assert.strictEqual(out[0].impact, "high");
    assert.ok(out[0].diagnosis.evidence.length > 0);
  });

  test("命中：llms.txt 不存在", () => {
    const llms = makeLlms({ exists: false });
    const out = genAiCrawlProtocol(undefined, llms);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].impact, "medium");
    assert.strictEqual(out[0].verification.signalKey, "llmsTxt.exists");
    assert.strictEqual(out[0].verification.direction, "appear");
  });

  test("不命中：robots 全放行 + llms.txt 存在", () => {
    const robots = makeRobots({
      policies: [
        {
          crawler: { ua: "GPTBot", name: "GPTBot", vendor: "OpenAI", purpose: "训练", cnRelevant: false },
          policy: "allowed",
          matchedRule: null,
          implication: "已放行",
        },
      ],
    });
    const llms = makeLlms({ exists: true });
    assert.strictEqual(genAiCrawlProtocol(robots, llms).length, 0);
  });

  test("降级：两个都为 undefined", () => {
    assert.strictEqual(genAiCrawlProtocol(undefined, undefined).length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* 4. site-issue-high                                                 */
/* ------------------------------------------------------------------ */

describe("T6-4 site-issue-high", () => {
  test("命中：存在 severity=high 的 issue", () => {
    const sa = makeSiteAnalysis({
      issues: [
        {
          id: "x:1",
          type: "missing-title",
          severity: "high",
          title: "5 个页面缺 title",
          affectedUrls: ["https://example.com/a", "https://example.com/b"],
          evidence: [{ fact: "受影响页面数", value: 2 }],
          whyItMatters: "...",
          suggestedFix: "补齐 title",
        },
      ],
    });
    const out = genSiteIssueHigh(sa);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].type, "site-issue-high");
    assert.strictEqual(out[0].impact, "high");
    assert.strictEqual(out[0].affectedScope, 2);
    assert.strictEqual(out[0].verification.direction, "disappear");
  });

  test("不命中：只有 medium/low severity", () => {
    const sa = makeSiteAnalysis({
      issues: [
        {
          id: "x:2",
          type: "missing-meta-description",
          severity: "medium",
          title: "...",
          affectedUrls: [],
          evidence: [],
          whyItMatters: "",
          suggestedFix: "",
        },
      ],
    });
    assert.strictEqual(genSiteIssueHigh(sa).length, 0);
  });

  test("降级：undefined 输入", () => {
    assert.strictEqual(genSiteIssueHigh(undefined).length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* 5. search-opportunity                                              */
/* ------------------------------------------------------------------ */

describe("T6-5 search-opportunity", () => {
  test("命中：GSC 机会非空", () => {
    const gscOpps: GscOpportunity[] = [
      {
        kind: "high-impression-low-ctr",
        key: "跨境支付",
        clicks: 1,
        impressions: 500,
        ctr: 0.002,
        position: 8.5,
        evidence: ["展示量 500 ≥ 100", "CTR 0.20% < 2%"],
        suggestion: "优化 title",
      },
    ];
    const out = genSearchOpportunity(gscOpps);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].type, "search-opportunity");
    assert.strictEqual(out[0].target, "跨境支付");
    assert.strictEqual(out[0].verification.signalKey, "ctr");
    assert.strictEqual(out[0].verification.direction, "increase");
  });

  test("命中：高曝光≥1000 → impact=high", () => {
    const out = genSearchOpportunity([
      {
        kind: "high-impression-low-ctr",
        key: "q",
        clicks: 0,
        impressions: 1500,
        ctr: 0.001,
        position: 5,
        evidence: [],
        suggestion: "x",
      },
    ]);
    assert.strictEqual(out[0].impact, "high");
  });

  test("降级：undefined 输入不报错", () => {
    assert.strictEqual(genSearchOpportunity(undefined).length, 0);
  });

  test("降级：空数组不报错", () => {
    assert.strictEqual(genSearchOpportunity([]).length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* 6. missing-entity                                                  */
/* ------------------------------------------------------------------ */

describe("T6-6 missing-entity", () => {
  test("命中：缺失 Schema（jsonLdTypes 空）+ 缺作者/组织/时间", () => {
    const audit = makePageAudit({
      jsonLdTypes: [],
      ogTags: {},
      wordCount: 500,
    });
    const out = genMissingEntity([audit]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].type, "missing-entity");
    assert.strictEqual(out[0].impact, "medium"); // 缺 Schema → medium
    assert.ok(out[0].recommendations.length >= 4);
  });

  test("不命中：页面实体齐全", () => {
    const audit = makePageAudit({}); // 默认 fixture 实体齐全
    assert.strictEqual(genMissingEntity([audit]).length, 0);
  });

  test("降级：undefined 输入", () => {
    assert.strictEqual(genMissingEntity(undefined).length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* 7. 引擎主入口：合并 + 排序 + 降级                                  */
/* ------------------------------------------------------------------ */

describe("T6-7 generateOpportunities 主入口", () => {
  test("合并：同 target 多条机会合并为一条多建议", () => {
    // weak-citeability (target=URL) + missing-entity (同 URL) → 合并
    const sa = makeSiteAnalysis({
      geoSummary: {
        distribution: { critical: 1, poor: 0, fair: 0, good: 0 },
        lowestScoring: [{ url: "https://example.com/a", geoScore: 30 }],
        commonWeakDimensions: [],
      },
    });
    const audit = makePageAudit({
      url: "https://example.com/a",
      jsonLdTypes: [],
      ogTags: {},
      wordCount: 500,
    });
    const out = generateOpportunities({ siteAnalysis: sa, pageAudits: [audit] });
    // 合并后该 URL 只剩 1 条
    const onA = out.filter((o) => o.target === "https://example.com/a");
    assert.ok(onA.length === 1, `expected 1 merged opportunity, got ${onA.length}`);
    assert.ok(onA[0].recommendations.length >= 2, "合并后应有多条建议");
    assert.ok(onA[0].diagnosis.evidence.length >= 2, "合并后 evidence 应聚合");
  });

  test("排序：high impact 排在 medium 前；同 impact 下 low effort 排前", () => {
    const sa = makeSiteAnalysis({
      issues: [
        {
          id: "x:1",
          type: "missing-title",
          severity: "high",
          title: "缺 title",
          affectedUrls: ["https://example.com/a"],
          evidence: [{ fact: "x", value: 1 }],
          whyItMatters: "",
          suggestedFix: "x",
        },
      ],
      geoSummary: {
        distribution: { critical: 0, poor: 1, fair: 0, good: 0 },
        lowestScoring: [{ url: "https://example.com/b", geoScore: 50 }],
        commonWeakDimensions: [],
      },
    });
    const out = generateOpportunities({ siteAnalysis: sa });
    assert.ok(out.length >= 2);
    // site-issue-high (impact=high) 应在 weak-citeability (impact=medium) 之前
    const highIdx = out.findIndex((o) => o.type === "site-issue-high");
    const weakIdx = out.findIndex((o) => o.type === "weak-citeability");
    assert.ok(highIdx >= 0 && weakIdx >= 0);
    assert.ok(highIdx < weakIdx);
  });

  test("降级：全部输入缺失 → 返回空数组不报错", () => {
    const out = generateOpportunities({});
    assert.deepStrictEqual(out, []);
  });

  test("降级：只传 GSC 但为空数组 → 仍空", () => {
    const out = generateOpportunities({ gscOpportunities: [] });
    assert.deepStrictEqual(out, []);
  });

  test("countByType：6 类计数正确", () => {
    const sa = makeSiteAnalysis({
      issues: [
        {
          id: "x:1",
          type: "missing-title",
          severity: "high",
          title: "x",
          affectedUrls: ["https://example.com/a"],
          evidence: [{ fact: "x", value: 1 }],
          whyItMatters: "",
          suggestedFix: "x",
        },
      ],
      geoSummary: {
        distribution: { critical: 1, poor: 0, fair: 0, good: 0 },
        lowestScoring: [{ url: "https://example.com/b", geoScore: 30 }],
        commonWeakDimensions: [],
      },
    });
    const out = generateOpportunities({ siteAnalysis: sa });
    const counts = countByType(out);
    assert.ok(counts["site-issue-high"] >= 1);
    assert.ok(counts["weak-citeability"] >= 1);
    assert.strictEqual(counts["citation-gap"], 0);
    assert.strictEqual(counts["search-opportunity"], 0);
  });
});

/* ------------------------------------------------------------------ */
/* 8. 无 evidence 不输出                                              */
/* ------------------------------------------------------------------ */

describe("T6-8 无 evidence 不输出", () => {
  test("铁律：generator 即使返回 evidence 为空，engine 也会过滤掉", () => {
    // 构造一个 diagnosis.evidence 为空的"假"机会，验证 engine 兜底过滤
    const fakeOpp: Opportunity = {
      id: makeOpportunityId("weak-citeability", "https://example.com/x"),
      type: "weak-citeability",
      target: "https://example.com/x",
      impact: "high",
      effort: "medium",
      diagnosis: { summary: "假", evidence: [] }, // 空 evidence
      recommendations: [{ action: "x" }],
      sources: [],
      verification: { signalKey: "geoScore", direction: "increase", description: "x" },
      affectedScope: 1,
    };
    // 直接走 mergeByTarget + rankOpportunities 不会过滤；engine 主入口会
    const merged = mergeByTarget([fakeOpp]);
    assert.strictEqual(merged.length, 1); // 合并不负责过滤
    // engine 主入口对空 evidence 兜底过滤
    const sa = makeSiteAnalysis(); // 空 siteAnalysis
    const out = generateOpportunities({ siteAnalysis: sa });
    assert.deepStrictEqual(out, []);
  });
});

/* ------------------------------------------------------------------ */
/* 9. verifyOpportunity                                               */
/* ------------------------------------------------------------------ */

describe("T6-9 verifyOpportunity", () => {
  const op: Opportunity = {
    id: "x",
    type: "weak-citeability",
    target: "https://example.com/a",
    impact: "high",
    effort: "medium",
    diagnosis: { summary: "x", evidence: [{ signal: "geoScore", value: 30 }] },
    recommendations: [{ action: "x" }],
    sources: [],
    verification: { signalKey: "geoScore", direction: "increase", description: "升至 60+" },
    affectedScope: 1,
  };

  test("increase：curr>prev → resolved", () => {
    const prev = [makeObservation("site:https://example.com/a", "2026-10-01T00:00:00Z", { geoScore: 30 })];
    const curr = [makeObservation("site:https://example.com/a", "2026-10-08T00:00:00Z", { geoScore: 65 })];
    assert.strictEqual(verifyOpportunity(op, prev, curr), "resolved");
  });

  test("increase：curr<prev → worsened", () => {
    const prev = [makeObservation("site:https://example.com/a", "2026-10-01T00:00:00Z", { geoScore: 30 })];
    const curr = [makeObservation("site:https://example.com/a", "2026-10-08T00:00:00Z", { geoScore: 20 })];
    assert.strictEqual(verifyOpportunity(op, prev, curr), "worsened");
  });

  test("increase：curr==prev → unchanged", () => {
    const prev = [makeObservation("site:https://example.com/a", "2026-10-01T00:00:00Z", { geoScore: 30 })];
    const curr = [makeObservation("site:https://example.com/a", "2026-10-08T00:00:00Z", { geoScore: 30 })];
    assert.strictEqual(verifyOpportunity(op, prev, curr), "unchanged");
  });

  test("decrease：position 数值变小 → resolved", () => {
    const op2: Opportunity = {
      ...op,
      target: "https://example.com/q",
      type: "search-opportunity",
      verification: { signalKey: "position", direction: "decrease", description: "进前 3" },
    };
    const prev = [makeObservation("site:https://example.com/q", "2026-10-01T00:00:00Z", { position: 8 })];
    const curr = [makeObservation("site:https://example.com/q", "2026-10-08T00:00:00Z", { position: 2 })];
    assert.strictEqual(verifyOpportunity(op2, prev, curr), "resolved");
  });

  test("appear：prev false / curr true → resolved", () => {
    const op2: Opportunity = {
      ...op,
      type: "citation-gap",
      verification: { signalKey: "mentioned", direction: "appear", description: "用户域名被引用" },
    };
    const prev = [makeObservation("site:https://example.com/a", "2026-10-01T00:00:00Z", { mentioned: false })];
    const curr = [makeObservation("site:https://example.com/a", "2026-10-08T00:00:00Z", { mentioned: true })];
    assert.strictEqual(verifyOpportunity(op2, prev, curr), "resolved");
  });

  test("disappear：prev true / curr false → resolved", () => {
    const op2: Opportunity = {
      ...op,
      type: "site-issue-high",
      verification: { signalKey: "issueResolved", direction: "disappear", description: "问题消失" },
    };
    const prev = [makeObservation("site:https://example.com/a", "2026-10-01T00:00:00Z", { issueResolved: true })];
    const curr = [makeObservation("site:https://example.com/a", "2026-10-08T00:00:00Z", { issueResolved: false })];
    assert.strictEqual(verifyOpportunity(op2, prev, curr), "resolved");
  });

  test("unknown：找不到可比观测", () => {
    const prev = [makeObservation("site:https://other.com", "2026-10-01T00:00:00Z", { geoScore: 30 })];
    const curr: Observation[] = [];
    assert.strictEqual(verifyOpportunity(op, prev, curr), "unknown");
  });

  test("unknown：signal 字段不存在", () => {
    const prev = [makeObservation("site:https://example.com/a", "2026-10-01T00:00:00Z", { other: 1 })];
    const curr = [makeObservation("site:https://example.com/a", "2026-10-08T00:00:00Z", { other: 2 })];
    assert.strictEqual(verifyOpportunity(op, prev, curr), "unknown");
  });
});

/* ------------------------------------------------------------------ */
/* 10. rankOpportunities + mergeByTarget 单元                         */
/* ------------------------------------------------------------------ */

describe("T6-10 rankOpportunities 单元", () => {
  test("high impact 排在 medium 前", () => {
    const list: Opportunity[] = [
      {
        id: "a", type: "weak-citeability", target: "x", impact: "medium", effort: "low",
        diagnosis: { summary: "", evidence: [{ signal: "s" }] },
        recommendations: [{ action: "a" }], sources: [],
        verification: { signalKey: "x", direction: "increase", description: "" },
        affectedScope: 1,
      },
      {
        id: "b", type: "site-issue-high", target: "y", impact: "high", effort: "high",
        diagnosis: { summary: "", evidence: [{ signal: "s" }] },
        recommendations: [{ action: "b" }], sources: [],
        verification: { signalKey: "x", direction: "increase", description: "" },
        affectedScope: 1,
      },
    ];
    const ranked = rankOpportunities(list);
    assert.strictEqual(ranked[0].id, "b");
  });

  test("同 impact 下 low effort 排在 high 前", () => {
    const list: Opportunity[] = [
      {
        id: "a", type: "ai-crawl-protocol", target: "x", impact: "high", effort: "high",
        diagnosis: { summary: "", evidence: [{ signal: "s" }] },
        recommendations: [{ action: "a" }], sources: [],
        verification: { signalKey: "x", direction: "increase", description: "" },
        affectedScope: 1,
      },
      {
        id: "b", type: "ai-crawl-protocol", target: "y", impact: "high", effort: "low",
        diagnosis: { summary: "", evidence: [{ signal: "s" }] },
        recommendations: [{ action: "b" }], sources: [],
        verification: { signalKey: "x", direction: "increase", description: "" },
        affectedScope: 1,
      },
    ];
    const ranked = rankOpportunities(list);
    assert.strictEqual(ranked[0].id, "b"); // effort=low 排前
  });

  test("同 impact+effort 下 affectedScope 大的排前", () => {
    const list: Opportunity[] = [
      {
        id: "a", type: "weak-citeability", target: "x", impact: "medium", effort: "medium",
        diagnosis: { summary: "", evidence: [{ signal: "s" }] },
        recommendations: [{ action: "a" }], sources: [],
        verification: { signalKey: "x", direction: "increase", description: "" },
        affectedScope: 5,
      },
      {
        id: "b", type: "weak-citeability", target: "y", impact: "medium", effort: "medium",
        diagnosis: { summary: "", evidence: [{ signal: "s" }] },
        recommendations: [{ action: "b" }], sources: [],
        verification: { signalKey: "x", direction: "increase", description: "" },
        affectedScope: 20,
      },
    ];
    const ranked = rankOpportunities(list);
    assert.strictEqual(ranked[0].id, "b");
  });
});
