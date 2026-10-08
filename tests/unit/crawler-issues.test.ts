/**
 * T4 站点级问题聚合 —— 每类问题「命中 / 不命中」两个方向。
 */
import { test, describe } from "node:test";
import * as assert from "node:assert";

import { analyzeSiteIssues } from "../../src/lib/crawler/issues";
import { computeShingles } from "../../src/lib/crawler/content";
import type { CrawlPage, CrawlResult } from "../../src/lib/crawler/types";

function makePage(over: Partial<CrawlPage> & { url: string }): CrawlPage {
  return {
    finalUrl: over.url,
    httpStatus: 200,
    redirectChain: [],
    title: "默认标题",
    metaDescription: "默认描述",
    h1: "默认 H1",
    canonical: over.url,
    noindex: false,
    hreflang: [],
    jsonLdTypes: ["WebSite"],
    internalLinks: 3,
    externalLinks: 1,
    wordCount: 500,
    geoScore: 85,
    seoScore: 80,
    geoBreakdown: [
      { id: "answer", label: "直接回答", score: 8, max: 10 },
      { id: "entity", label: "实体信息", score: 8, max: 10 },
    ],
    clickDepth: 0,
    outLinks: [],
    ...over,
  };
}

function makeResult(pages: CrawlPage[], nodes?: { url: string; inlinks: number; clickDepth: number; orphan: boolean }[]): CrawlResult {
  return {
    origin: "https://example.com",
    pages,
    graph: {
      nodes:
        nodes ??
        pages.map((p) => ({ url: p.url, inlinks: 2, clickDepth: p.clickDepth, orphan: false })),
      edges: [],
    },
    truncated: false,
    config: {
      maxPages: 100,
      maxDepth: 3,
      concurrency: 2,
      perPageTimeoutMs: 15000,
      totalBudgetMs: 120000,
      includeSubdomains: false,
      minRequestIntervalMs: 500,
      ua: "GEOkitBot",
    },
    startedAt: new Date().toISOString(),
    elapsedMs: 10,
  };
}

function typesOf(result: CrawlResult): Set<string> {
  return new Set(analyzeSiteIssues(result).issues.map((i) => i.type));
}

function issueOf(result: CrawlResult, type: string) {
  return analyzeSiteIssues(result).issues.find((i) => i.type === type);
}

/* 1. 重复 title / description / H1 -------------------------------- */

describe("T4-1 重复 title/desc/h1", () => {
  test("命中：两个 200 页面同 title → duplicate-title，带具体 URL 分组", () => {
    const r = makeResult([
      makePage({ url: "https://example.com/a", title: "相同标题" }),
      makePage({ url: "https://example.com/b", title: "相同标题" }),
    ]);
    const issue = issueOf(r, "duplicate-title");
    assert.ok(issue, "应产出 duplicate-title");
    assert.deepEqual(issue!.affectedUrls.sort(), [
      "https://example.com/a",
      "https://example.com/b",
    ]);
    assert.ok(issue!.evidence.some((e) => e.value === "相同标题"));
  });

  test("不命中：title 唯一时无 duplicate-title；noindex 页面不参与", () => {
    const r = makeResult([
      makePage({ url: "https://example.com/a", title: "标题 A" }),
      makePage({ url: "https://example.com/b", title: "标题 B", noindex: true }),
      makePage({ url: "https://example.com/c", title: "标题 B" }), // B noindex，与 C 同值也不报
    ]);
    assert.equal(typesOf(r).has("duplicate-title"), false);
  });
});

/* 2. 缺失 title / description / H1 / canonical --------------------- */

describe("T4-2 缺失字段", () => {
  test("命中：空 title/desc/h1/canonical 各自产出 missing-*", () => {
    const r = makeResult([
      makePage({
        url: "https://example.com/a",
        title: null,
        metaDescription: null,
        h1: null,
        canonical: null,
      }),
    ]);
    const t = typesOf(r);
    assert.ok(t.has("missing-title"));
    assert.ok(t.has("missing-meta-description"));
    assert.ok(t.has("missing-h1"));
    assert.ok(t.has("missing-canonical"));
    assert.equal(issueOf(r, "missing-title")?.severity, "high");
  });

  test("不命中：字段齐全时无 missing-*", () => {
    const r = makeResult([makePage({ url: "https://example.com/a" })]);
    const t = typesOf(r);
    assert.equal(t.has("missing-title"), false);
    assert.equal(t.has("missing-meta-description"), false);
    assert.equal(t.has("missing-h1"), false);
    assert.equal(t.has("missing-canonical"), false);
  });

  test("不命中：4xx 与 blocked 页面不报缺失（本来就不是可索引内容）", () => {
    const r = makeResult([
      makePage({
        url: "https://example.com/missing",
        httpStatus: 404,
        title: null,
        canonical: null,
      }),
      makePage({
        url: "https://example.com/forbidden",
        httpStatus: 403,
        blocked: { reason: "HTTP 403 Forbidden" },
        title: null,
      }),
    ]);
    const t = typesOf(r);
    assert.equal(t.has("missing-title"), false);
    assert.equal(t.has("missing-canonical"), false);
  });
});

/* 3. canonical 异常 ------------------------------------------------- */

describe("T4-3 canonical 异常", () => {
  test("命中：canonical 指向其他域名 → high", () => {
    const r = makeResult([
      makePage({ url: "https://example.com/a", canonical: "https://other.com/x" }),
    ]);
    const issue = issueOf(r, "canonical-anomaly");
    assert.ok(issue);
    assert.equal(issue!.severity, "high");
    assert.ok(issue!.evidence.some((e) => e.value === "other.com"));
  });

  test("命中：canonical 指向已爬 4xx 页 → high", () => {
    const r = makeResult([
      makePage({ url: "https://example.com/a", canonical: "https://example.com/dead" }),
      makePage({ url: "https://example.com/dead", httpStatus: 404, canonical: null }),
    ]);
    const issue = issueOf(r, "canonical-anomaly");
    assert.ok(issue);
    assert.equal(issue!.severity, "high");
    assert.ok(issue!.evidence.some((e) => e.value === 404));
  });

  test("不命中：自引用 canonical 正常时无异常", () => {
    const r = makeResult([
      makePage({ url: "https://example.com/a", canonical: "https://example.com/a" }),
    ]);
    assert.equal(typesOf(r).has("canonical-anomaly"), false);
  });
});

/* 4. 孤岛 / 深页 / 内链过少 ----------------------------------------- */

describe("T4-4 孤岛/深页/内链少", () => {
  test("命中：sitemap 有但 inlinks=0 → orphan-page", () => {
    const r = makeResult(
      [makePage({ url: "https://example.com/orphan" })],
      [{ url: "https://example.com/orphan", inlinks: 0, clickDepth: 1, orphan: true }]
    );
    assert.ok(issueOf(r, "orphan-page"));
  });

  test("命中：点击深度 > 2 → deep-page", () => {
    const r = makeResult([makePage({ url: "https://example.com/deep", clickDepth: 3 })]);
    const issue = issueOf(r, "deep-page");
    assert.ok(issue);
    assert.deepEqual(issue!.affectedUrls, ["https://example.com/deep"]);
  });

  test("不命中：深度 ≤ 2 不报 deep-page", () => {
    const r = makeResult([makePage({ url: "https://example.com/a", clickDepth: 2 })]);
    assert.equal(typesOf(r).has("deep-page"), false);
  });

  test("命中：inlinks < 2 且非孤岛 → low-inlinks", () => {
    const r = makeResult(
      [makePage({ url: "https://example.com/a" })],
      [{ url: "https://example.com/a", inlinks: 1, clickDepth: 1, orphan: false }]
    );
    assert.ok(issueOf(r, "low-inlinks"));
  });

  test("不命中：孤岛页不在 low-inlinks 里重复报告", () => {
    const r = makeResult(
      [makePage({ url: "https://example.com/o" })],
      [{ url: "https://example.com/o", inlinks: 0, clickDepth: 1, orphan: true }]
    );
    assert.equal(typesOf(r).has("low-inlinks"), false);
  });
});

/* 5. 跳转链 / 坏链 -------------------------------------------------- */

describe("T4-5 跳转与坏链", () => {
  test("命中：redirectChain 超过 2 跳 → long-redirect-chain", () => {
    const r = makeResult([
      makePage({
        url: "https://example.com/a",
        redirectChain: ["https://example.com/b", "https://example.com/c", "https://example.com/d"],
      }),
    ]);
    const issue = issueOf(r, "long-redirect-chain");
    assert.ok(issue);
    assert.equal(issue!.evidence.some((e) => e.value === 3), true);
  });

  test("不命中：单跳正常重定向不报", () => {
    const r = makeResult([
      makePage({ url: "https://example.com/a", redirectChain: ["https://example.com/a2"] }),
    ]);
    assert.equal(typesOf(r).has("long-redirect-chain"), false);
  });

  test("命中：链中跳回起点 → redirect-loop（high）", () => {
    const r = makeResult([
      makePage({
        url: "https://example.com/a",
        redirectChain: ["https://example.com/b", "https://example.com/a"],
      }),
    ]);
    const issue = issueOf(r, "redirect-loop");
    assert.ok(issue);
    assert.equal(issue!.severity, "high");
  });

  test("命中：内链指向已爬 4xx 页 → broken-internal-link，记录来源页", () => {
    const r = makeResult([
      makePage({ url: "https://example.com/a", outLinks: ["https://example.com/dead"] }),
      makePage({ url: "https://example.com/dead", httpStatus: 404, canonical: null }),
    ]);
    const issue = issueOf(r, "broken-internal-link");
    assert.ok(issue);
    assert.deepEqual(issue!.affectedUrls, ["https://example.com/a"]);
    assert.ok(issue!.evidence.some((e) => e.value === "https://example.com/dead"));
  });

  test("不命中：内链只指向 200 页时无坏链", () => {
    const r = makeResult([
      makePage({ url: "https://example.com/a", outLinks: ["https://example.com/b"] }),
      makePage({ url: "https://example.com/b" }),
    ]);
    assert.equal(typesOf(r).has("broken-internal-link"), false);
  });
});

/* 6. 结构化数据 ----------------------------------------------------- */

describe("T4-6 结构化数据覆盖", () => {
  test("命中：长正文且无 JSON-LD → missing-structured-data", () => {
    const r = makeResult([
      makePage({ url: "https://example.com/a", wordCount: 800, jsonLdTypes: [] }),
    ]);
    assert.ok(issueOf(r, "missing-structured-data"));
  });

  test("不命中：有 JSON-LD 或正文过短不报", () => {
    const r1 = makeResult([makePage({ url: "https://example.com/a", wordCount: 800 })]);
    assert.equal(typesOf(r1).has("missing-structured-data"), false);

    const r2 = makeResult([
      makePage({ url: "https://example.com/b", wordCount: 30, jsonLdTypes: [] }),
    ]);
    assert.equal(typesOf(r2).has("missing-structured-data"), false);
  });

  test("schemaCoverage 输出各类型占比", () => {
    const r = makeResult([
      makePage({ url: "https://example.com/a", jsonLdTypes: ["Article"] }),
      makePage({ url: "https://example.com/b", jsonLdTypes: ["Article", "Product"] }),
    ]);
    const cov = analyzeSiteIssues(r).schemaCoverage;
    const article = cov.find((c) => c.type === "Article");
    assert.equal(article?.pages, 2);
    assert.equal(article?.ratio, 1);
  });
});

/* 7. GEO 低分 + 共性弱维度 + 汇总 ----------------------------------- */

describe("T4-7 GEO 低分与共性维度", () => {
  test("命中：geoScore < 40 → high；40–59 → medium", () => {
    const r = makeResult([
      makePage({ url: "https://example.com/low", geoScore: 30 }),
      makePage({ url: "https://example.com/mid", geoScore: 55 }),
    ]);
    const lows = analyzeSiteIssues(r).issues.filter((i) => i.type === "low-geo-score");
    const high = lows.find((i) => i.severity === "high");
    const med = lows.find((i) => i.severity === "medium");
    assert.deepEqual(high?.affectedUrls, ["https://example.com/low"]);
    assert.deepEqual(med?.affectedUrls, ["https://example.com/mid"]);
  });

  test("不命中：geoScore ≥ 60 无 low-geo-score", () => {
    const r = makeResult([makePage({ url: "https://example.com/a", geoScore: 75 })]);
    assert.equal(typesOf(r).has("low-geo-score"), false);
  });

  test("命中：同一弱维度出现在 ≥3 页 → weak-geo-dimension", () => {
    const weak = [
      { id: "entity", label: "实体信息", score: 3, max: 10 },
    ];
    const r = makeResult([
      makePage({ url: "https://example.com/a", geoBreakdown: weak }),
      makePage({ url: "https://example.com/b", geoBreakdown: weak }),
      makePage({ url: "https://example.com/c", geoBreakdown: weak }),
    ]);
    const issue = issueOf(r, "weak-geo-dimension");
    assert.ok(issue);
    assert.equal(issue!.affectedUrls.length, 3);
    assert.ok(issue!.evidence.some((e) => e.value === "实体信息" || /实体信息/.test(JSON.stringify(e))));
  });

  test("不命中：弱维度不足 3 页不算共性问题；geoSummary 分布正确", () => {
    const weak = [{ id: "entity", label: "实体信息", score: 3, max: 10 }];
    const r = makeResult([
      makePage({ url: "https://example.com/a", geoScore: 85, geoBreakdown: weak }),
      makePage({ url: "https://example.com/b", geoScore: 85, geoBreakdown: weak }),
    ]);
    assert.equal(typesOf(r).has("weak-geo-dimension"), false);
    const summary = analyzeSiteIssues(r).geoSummary;
    assert.equal(summary.distribution.good, 2);
  });
});

/* 8. 疑似内容重复 --------------------------------------------------- */

describe("T4-8 疑似内容重复", () => {
  // 构造 ≥50 token 的长正文：英文按词、中文按字切，重复同一段保证高 Jaccard
  const basePara =
    "这是一段用于测试内容重复检测的中文正文 站点优化需要持续投入时间精力 " +
    "人工智能搜索正在改变流量分发方式 每个页面都应该提供独特价值 " +
    "结构化数据和清晰标题有助于模型理解 权威来源引用能够提升可信度 ".repeat(3);

  test("命中：两页正文大面积雷同 → duplicate-content，结论标注疑似与相似度", () => {
    const sh = computeShingles(basePara);
    assert.ok(sh && sh.length > 0, "测试正文应产生 shingle");
    const r = makeResult([
      makePage({ url: "https://example.com/a", contentShingles: sh! }),
      makePage({ url: "https://example.com/b", contentShingles: sh! }),
    ]);
    const issue = issueOf(r, "duplicate-content");
    assert.ok(issue, "应产出疑似内容重复");
    assert.equal(issue!.severity, "medium");
    assert.deepEqual(issue!.affectedUrls.sort(), [
      "https://example.com/a",
      "https://example.com/b",
    ]);
    // 证据里必须给得出相似度依据（Jaccard 百分比）
    assert.ok(/\d+%/.test(JSON.stringify(issue!.evidence)));
    assert.ok(/疑似/.test(issue!.title));
  });

  test("不命中：正文完全不同且无 shingle 的页面不产出重复问题", () => {
    const paraB =
      "完全不同的另一个话题 关于海洋生物迁徙路线与气候变化的研究观察记录 " +
      "企鹅磷虾海冰温度洋流生态系统南极夏季冬季捕食繁殖 ".repeat(3);
    const r = makeResult([
      makePage({ url: "https://example.com/a", contentShingles: computeShingles(basePara) ?? undefined }),
      makePage({ url: "https://example.com/b", contentShingles: computeShingles(paraB) ?? undefined }),
    ]);
    assert.equal(typesOf(r).has("duplicate-content"), false);
  });

  test("不命中：过短页面（<50 token）不产生 shingle，不参与重复检测", () => {
    assert.equal(computeShingles("<p>短内容</p>"), null);
  });
});

/* 汇总行为 ---------------------------------------------------------- */

describe("T4 汇总行为", () => {
  test("issues 按 severity（high>medium>low）排序", () => {
    const r = makeResult([
      makePage({ url: "https://example.com/a", title: null }), // missing-title high
      makePage({
        url: "https://example.com/orphan",
        clickDepth: 0,
      }),
      makePage({
        url: "https://example.com/b",
        wordCount: 800,
        jsonLdTypes: [],
      }),
    ]);
    r.graph.nodes = [
      { url: "https://example.com/a", inlinks: 2, clickDepth: 0, orphan: false },
      { url: "https://example.com/orphan", inlinks: 0, clickDepth: 1, orphan: true },
      { url: "https://example.com/b", inlinks: 2, clickDepth: 0, orphan: false },
    ];
    const issues = analyzeSiteIssues(r).issues;
    const rank = { high: 0, medium: 1, low: 2 };
    for (let i = 1; i < issues.length; i++) {
      assert.ok(rank[issues[i - 1].severity] <= rank[issues[i].severity]);
    }
  });

  test("issue id 对相同 URL 集合稳定（复检时同一问题 id 不变）", () => {
    const mk = () =>
      makeResult([
        makePage({ url: "https://example.com/a", title: "X" }),
        makePage({ url: "https://example.com/b", title: "X" }),
      ]);
    const id1 = issueOf(mk(), "duplicate-title")!.id;
    const id2 = issueOf(mk(), "duplicate-title")!.id;
    assert.equal(id1, id2);
    assert.ok(id1.startsWith("duplicate-title:"));
  });

  test("空爬取结果不产出任何问题", () => {
    const r = makeResult([]);
    assert.equal(analyzeSiteIssues(r).issues.length, 0);
  });
});
