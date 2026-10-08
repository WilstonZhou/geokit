/**
 * T7 Query Intelligence —— 触发 / 不触发 / 降级 / 确定性 / verify。
 */
import { test, describe } from "node:test";
import * as assert from "node:assert";

import {
  analyzeQuery,
  classifyIntent,
  extractRelatedQuestions,
  identifyCompetitors,
  findContentGaps,
  clusterQueries,
  DEFAULT_CLUSTER_OPTIONS,
  INTENT_PRIORITY,
  type QueryAnalysisInput,
  type QueryClusterInput,
} from "../../src/lib/query";
import type { SerpResponse } from "../../src/lib/serp";
import type { CitationRecord } from "../../src/lib/evidence/types";
import type { CrawlResult } from "../../src/lib/crawler/types";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeSerp(over: Partial<SerpResponse> = {}): SerpResponse {
  return {
    engine: "baidu",
    engineName: "百度",
    keyword: "test",
    status: "ok",
    items: [],
    targetRank: null,
    targetFound: false,
    fetchedAt: "2026-10-08T00:00:00Z",
    elapsedMs: 1000,
    ...over,
  };
}

function makeItem(over: Partial<SerpResponse["items"][number]> = {}): SerpResponse["items"][number] {
  return {
    position: 1,
    title: "测试",
    url: "https://example.com/x",
    domain: "example.com",
    snippet: "",
    owned: false,
    redirectWrapper: false,
    resolved: true,
    ...over,
  };
}

function makeCitation(over: Partial<CitationRecord> = {}): CitationRecord {
  return {
    query: "test",
    model: "gpt-4o",
    answerText: "测试答案",
    mentioned: false,
    citations: [],
    citationsStatus: "ok",
    competitorsMentioned: [],
    observedAt: "2026-10-08T00:00:00Z",
    ...over,
  };
}

function makeCrawl(over: Partial<CrawlResult> = {}): CrawlResult {
  return {
    origin: "https://example.com",
    pages: [],
    graph: { nodes: [], edges: [] },
    truncated: false,
    config: { maxPages: 100, maxDepth: 3, concurrency: 2, perPageTimeoutMs: 15000, totalBudgetMs: 120000, includeSubdomains: false, minRequestIntervalMs: 500, ua: "test" },
    startedAt: "2026-10-08T00:00:00Z",
    elapsedMs: 1000,
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* 1. classifyIntent                                                  */
/* ------------------------------------------------------------------ */

describe("T7-1 classifyIntent 规则驱动", () => {
  test("informational：query 含「怎么」", () => {
    const r = classifyIntent("跨境支付怎么选");
    assert.strictEqual(r.intent, "informational");
    assert.ok(r.basis.length > 0);
    assert.ok(r.confidence === "medium" || r.confidence === "high");
  });

  test("comparative：query 含「vs」", () => {
    const r = classifyIntent("Stripe vs PayPal");
    assert.strictEqual(r.intent, "comparative");
  });

  test("transactional：query 含「价格」", () => {
    const r = classifyIntent("跨境支付价格");
    assert.strictEqual(r.intent, "transactional");
  });

  test("local：query 含「附近」", () => {
    const r = classifyIntent("附近跨境支付");
    assert.strictEqual(r.intent, "local");
  });

  test("navigational：query 含「官网」", () => {
    const r = classifyIntent("Stripe 官网");
    assert.strictEqual(r.intent, "navigational");
  });

  test("默认 informational：无任何关键词命中 → low 置信", () => {
    const r = classifyIntent("abcxyz");
    assert.strictEqual(r.intent, "informational");
    assert.strictEqual(r.confidence, "low");
  });

  test("SERP 特征强化：电商域名出现 → transactional", () => {
    const serp = makeSerp({
      items: [makeItem({ position: 1, domain: "taobao.com", title: "x" })],
    });
    const r = classifyIntent("abcxyz", [serp]);
    assert.strictEqual(r.intent, "transactional");
    assert.ok(r.basis.some((b) => b.includes("电商")));
  });

  test("优先级：含「vs」+「买」→ transactional（优先级高于 comparative）", () => {
    const r = classifyIntent("vs 买 价格");
    assert.strictEqual(r.intent, "transactional");
  });

  test("SERP 标题含问句 → informational 强化", () => {
    const serp = makeSerp({
      items: [makeItem({ position: 1, title: "为什么跨境支付贵？" })],
    });
    const r = classifyIntent("abcxyz", [serp]);
    assert.strictEqual(r.intent, "informational");
    // query "abcxyz" 无文本规则命中；SERP 问句特征 +1 命中 → medium
    assert.ok(r.confidence === "medium" || r.confidence === "high");
  });
});

/* ------------------------------------------------------------------ */
/* 2. extractRelatedQuestions                                         */
/* ------------------------------------------------------------------ */

describe("T7-2 extractRelatedQuestions 不编造", () => {
  test("SERP 标题含问句 → 提取", () => {
    const serp = makeSerp({
      items: [makeItem({ position: 1, title: "怎么选跨境支付？" })],
    });
    const out = extractRelatedQuestions([serp], undefined);
    assert.strictEqual(out.length, 1);
    assert.ok(out[0].question.includes("怎么选"));
    assert.ok(out[0].sources[0].startsWith("serp:baidu:pos=1"));
  });

  test("AI 答案含问句 → 提取", () => {
    const ai = makeCitation({
      answerText: "跨境支付选 Stripe。怎么接入？看官方文档。",
    });
    const out = extractRelatedQuestions(undefined, [ai]);
    assert.strictEqual(out.length, 1);
    assert.ok(out[0].question.includes("怎么接入"));
    assert.ok(out[0].sources[0].startsWith("ai:gpt-4o:"));
  });

  test("合并：同问句多来源 → 一条多 sources", () => {
    const serp = makeSerp({
      items: [makeItem({ position: 1, title: "怎么选跨境支付" })],
    });
    const ai = makeCitation({ answerText: "怎么选跨境支付？看对比。" });
    const out = extractRelatedQuestions([serp], [ai]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].sources.length, 2);
  });

  test("不编造：无可提取文本 → 返回空数组", () => {
    const serp = makeSerp({ items: [makeItem({ title: "跨境电商" })] });
    assert.strictEqual(extractRelatedQuestions([serp], undefined).length, 0);
  });

  test("降级：两个都为 undefined", () => {
    assert.strictEqual(extractRelatedQuestions(undefined, undefined).length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* 3. identifyCompetitors                                             */
/* ------------------------------------------------------------------ */

describe("T7-3 identifyCompetitors", () => {
  test("SERP 来源 + 用户域名排除", () => {
    const serp = makeSerp({
      items: [
        makeItem({ position: 1, domain: "rival.com" }),
        makeItem({ position: 2, domain: "example.com" }), // 用户域名
        makeItem({ position: 3, domain: "rival.com" }),
      ],
    });
    const out = identifyCompetitors([serp], undefined, "example.com");
    // rival.com 出现 1 次（同 SERP 同域名去重）
    const rival = out.find((c) => c.domain === "rival.com");
    assert.ok(rival);
    assert.strictEqual(rival.serpCount, 1);
    assert.strictEqual(rival.source, "serp");
    // 用户域名被排除
    assert.ok(!out.find((c) => c.domain === "example.com"));
  });

  test("AI 引用来源 + 用户域名排除", () => {
    const ai = makeCitation({
      citations: [
        { url: "https://rival.com/a", title: "x" },
        { url: "https://example.com/b", title: "y" }, // 用户域名
      ],
    });
    const out = identifyCompetitors(undefined, [ai], "example.com");
    const rival = out.find((c) => c.domain === "rival.com");
    assert.ok(rival);
    assert.strictEqual(rival.aiMentionCount, 1);
    assert.strictEqual(rival.source, "ai");
  });

  test("both：SERP + AI 同时出现 → source=both", () => {
    const serp = makeSerp({
      items: [makeItem({ position: 1, domain: "rival.com" })],
    });
    const ai = makeCitation({
      citations: [{ url: "https://rival.com/a", title: "x" }],
    });
    const out = identifyCompetitors([serp], [ai], "example.com");
    const rival = out.find((c) => c.domain === "rival.com");
    assert.ok(rival);
    assert.strictEqual(rival.source, "both");
    assert.strictEqual(rival.serpCount, 1);
    assert.strictEqual(rival.aiMentionCount, 1);
  });

  test("降级：两个都为 undefined", () => {
    assert.strictEqual(identifyCompetitors(undefined, undefined, "x").length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* 4. findContentGaps                                                 */
/* ------------------------------------------------------------------ */

describe("T7-4 findContentGaps 对照 T3", () => {
  test("命中：竞品普遍覆盖、用户未覆盖的话题", () => {
    const serp = makeSerp({
      items: [
        makeItem({ position: 1, domain: "rival.com", title: "Stripe 跨境支付方案" }),
        makeItem({ position: 2, domain: "rival2.com", title: "Stripe 海外收款" }),
      ],
    });
    const competitors = [
      { domain: "rival.com", serpCount: 1, serpPositions: [1], aiMentionCount: 0, source: "serp" as const },
      { domain: "rival2.com", serpCount: 1, serpPositions: [2], aiMentionCount: 0, source: "serp" as const },
    ];
    const userCrawl = makeCrawl({
      pages: [{ url: "https://example.com/a", finalUrl: "", httpStatus: 200, redirectChain: [], title: "首页", metaDescription: null, h1: null, canonical: null, noindex: false, hreflang: [], jsonLdTypes: [], internalLinks: 0, externalLinks: 0, wordCount: 100, geoScore: 50, seoScore: 50, clickDepth: 0, outLinks: [] }],
    });
    const out = findContentGaps([serp], competitors, userCrawl);
    // Stripe 是话题关键词，被 2 个竞品覆盖，用户标题不含 stripe → 命中
    const stripeGap = out.find((g) => g.topic === "Stripe");
    assert.ok(stripeGap, "应识别 Stripe 为内容缺口");
    assert.strictEqual(stripeGap.userCoverage, "none");
    assert.strictEqual(stripeGap.competitorCoverage.covered, 2);
  });

  test("不命中：用户已覆盖话题", () => {
    const serp = makeSerp({
      items: [
        makeItem({ position: 1, domain: "rival.com", title: "Stripe 跨境支付" }),
        makeItem({ position: 2, domain: "rival2.com", title: "Stripe 海外" }),
      ],
    });
    const competitors = [
      { domain: "rival.com", serpCount: 1, serpPositions: [1], aiMentionCount: 0, source: "serp" as const },
      { domain: "rival2.com", serpCount: 1, serpPositions: [2], aiMentionCount: 0, source: "serp" as const },
    ];
    const userCrawl = makeCrawl({
      pages: [{ url: "https://example.com/a", finalUrl: "", httpStatus: 200, redirectChain: [], title: "stripe 跨境支付方案", metaDescription: null, h1: null, canonical: null, noindex: false, hreflang: [], jsonLdTypes: [], internalLinks: 0, externalLinks: 0, wordCount: 100, geoScore: 50, seoScore: 50, clickDepth: 0, outLinks: [] }],
    });
    const out = findContentGaps([serp], competitors, userCrawl);
    assert.ok(!out.find((g) => g.topic === "Stripe")); // 已覆盖 → 不输出
  });

  test("降级：缺 userCrawl → 返回空", () => {
    const serp = makeSerp({ items: [makeItem({ domain: "rival.com" })] });
    const competitors = [{ domain: "rival.com", serpCount: 1, serpPositions: [1], aiMentionCount: 0, source: "serp" as const }];
    assert.strictEqual(findContentGaps([serp], competitors, undefined).length, 0);
  });

  test("降级：缺 competitors → 返回空", () => {
    const serp = makeSerp();
    assert.strictEqual(findContentGaps([serp], undefined, makeCrawl()).length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* 5. clusterQueries                                                  */
/* ------------------------------------------------------------------ */

describe("T7-5 clusterQueries 确定性", () => {
  test("命中：两个 query 共享 ≥ 2 个 URL → 同簇", () => {
    const q1: QueryClusterInput = {
      query: "q1",
      serpResults: [makeSerp({
        items: [
          makeItem({ position: 1, url: "https://shared.com/a" }),
          makeItem({ position: 2, url: "https://shared.com/b" }),
        ],
      })],
    };
    const q2: QueryClusterInput = {
      query: "q2",
      serpResults: [makeSerp({
        items: [
          makeItem({ position: 1, url: "https://shared.com/a" }),
          makeItem({ position: 2, url: "https://shared.com/b" }),
        ],
      })],
    };
    const out = clusterQueries([q1, q2]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].queries.length, 2);
    assert.ok(out[0].overlapScore > 0);
    assert.ok(out[0].sharedUrls.length >= 2);
  });

  test("不命中：两 query 无共享 URL → 无簇", () => {
    const q1: QueryClusterInput = {
      query: "q1",
      serpResults: [makeSerp({ items: [makeItem({ url: "https://a.com/x" })] })],
    };
    const q2: QueryClusterInput = {
      query: "q2",
      serpResults: [makeSerp({ items: [makeItem({ url: "https://b.com/y" })] })],
    };
    assert.strictEqual(clusterQueries([q1, q2]).length, 0);
  });

  test("参数：调高 jaccardThreshold 使同簇不再成立", () => {
    const q1: QueryClusterInput = {
      query: "q1",
      serpResults: [makeSerp({
        items: [
          makeItem({ position: 1, url: "https://shared.com/a" }),
          makeItem({ position: 2, url: "https://shared.com/b" }),
          makeItem({ position: 3, url: "https://unique1.com/x" }),
        ],
      })],
    };
    const q2: QueryClusterInput = {
      query: "q2",
      serpResults: [makeSerp({
        items: [
          makeItem({ position: 1, url: "https://shared.com/a" }),
          makeItem({ position: 2, url: "https://shared.com/b" }),
          makeItem({ position: 3, url: "https://unique2.com/y" }),
        ],
      })],
    };
    // 默认阈值 0.3 → 应成簇（共享 2，Jaccard ≈ 0.5）
    assert.strictEqual(clusterQueries([q1, q2]).length, 1);
    // 阈值调到 0.9 + minSharedUrls 调到 3 → 两条路径都不再命中
    assert.strictEqual(
      clusterQueries([q1, q2], { jaccardThreshold: 0.9, minSharedUrls: 3 }).length,
      0
    );
  });

  test("确定性：同输入两次调用结果完全一致", () => {
    const q1: QueryClusterInput = {
      query: "q1",
      serpResults: [makeSerp({
        items: [
          makeItem({ position: 1, url: "https://shared.com/a" }),
          makeItem({ position: 2, url: "https://shared.com/b" }),
        ],
      })],
    };
    const q2: QueryClusterInput = { query: "q2", serpResults: [makeSerp({ items: [makeItem({ url: "https://shared.com/a" })] })] };
    const a = clusterQueries([q1, q2]);
    const b = clusterQueries([q1, q2]);
    assert.deepStrictEqual(a, b);
  });

  test("降级：单 query 输入 → 返回空", () => {
    assert.strictEqual(clusterQueries([{ query: "x", serpResults: [] }]).length, 0);
  });

  test("默认参数：DEFAULT_CLUSTER_OPTIONS 值符合预期", () => {
    assert.strictEqual(DEFAULT_CLUSTER_OPTIONS.jaccardThreshold, 0.3);
    assert.strictEqual(DEFAULT_CLUSTER_OPTIONS.minSharedUrls, 2);
  });
});

/* ------------------------------------------------------------------ */
/* 6. analyzeQuery 主入口                                             */
/* ------------------------------------------------------------------ */

describe("T7-6 analyzeQuery 主入口", () => {
  test("全字段缺失 → 全部 unavailable，不报错", () => {
    const out = analyzeQuery({ query: "怎么选跨境支付" });
    assert.strictEqual(out.sourceAvailability.serp, "unavailable");
    assert.strictEqual(out.sourceAvailability.ai, "unavailable");
    assert.strictEqual(out.sourceAvailability.gsc, "unavailable");
    assert.strictEqual(out.sourceAvailability.crawl, "unavailable");
    assert.strictEqual(out.relatedQuestions.length, 0);
    assert.strictEqual(out.competitors.length, 0);
    assert.strictEqual(out.contentGaps.length, 0);
    // intent 仍可基于 query 文本判定
    assert.strictEqual(out.intent.intent, "informational");
  });

  test("全字段齐全 → 各段落有输出", () => {
    const input: QueryAnalysisInput = {
      query: "跨境支付怎么选",
      serpResults: [makeSerp({
        items: [
          makeItem({ position: 1, domain: "rival.com", title: "怎么选跨境支付？" }),
          makeItem({ position: 2, domain: "rival2.com", title: "Stripe 方案" }),
        ],
      })],
      aiCitations: [makeCitation({
        answerText: "怎么选跨境支付？看对比。",
        citations: [{ url: "https://rival.com/a", title: "x" }],
      })],
      userDomain: "example.com",
      userCrawl: makeCrawl({
        pages: [{ url: "https://example.com/a", finalUrl: "", httpStatus: 200, redirectChain: [], title: "首页", metaDescription: null, h1: null, canonical: null, noindex: false, hreflang: [], jsonLdTypes: [], internalLinks: 0, externalLinks: 0, wordCount: 100, geoScore: 50, seoScore: 50, clickDepth: 0, outLinks: [] }],
      }),
    };
    const out = analyzeQuery(input);
    assert.strictEqual(out.sourceAvailability.serp, "available");
    assert.strictEqual(out.sourceAvailability.ai, "available");
    assert.strictEqual(out.sourceAvailability.crawl, "available");
    assert.ok(out.relatedQuestions.length > 0);
    assert.ok(out.competitors.length > 0);
    // intent 应为 informational（怎么）
    assert.strictEqual(out.intent.intent, "informational");
  });

  test("确定性：同输入两次调用结果完全一致", () => {
    const input: QueryAnalysisInput = {
      query: "跨境支付怎么选",
      serpResults: [makeSerp({
        items: [makeItem({ position: 1, domain: "rival.com", title: "怎么选跨境支付？" })],
      })],
      userDomain: "example.com",
    };
    const a = analyzeQuery(input);
    const b = analyzeQuery(input);
    assert.deepStrictEqual(a, b);
  });
});

/* ------------------------------------------------------------------ */
/* 7. INTENT_PRIORITY 透明                                            */
/* ------------------------------------------------------------------ */

describe("T7-7 INTENT_PRIORITY 透明", () => {
  test("优先级数值符合预期", () => {
    assert.strictEqual(INTENT_PRIORITY.navigational, 0);
    assert.strictEqual(INTENT_PRIORITY.transactional, 1);
    assert.strictEqual(INTENT_PRIORITY.local, 2);
    assert.strictEqual(INTENT_PRIORITY.comparative, 3);
    assert.strictEqual(INTENT_PRIORITY.informational, 4);
  });
});
