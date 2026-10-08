/**
 * T10 Schema / 实体诊断 单测。
 *
 * 覆盖：
 *   - 7 种页面类型 + unknown 的检测（强信号/弱信号）
 *   - 字段缺失/不完整、JSON-LD 与页面内容一致性
 *   - 草稿 JSON 合法、结构正确
 *   - 铁律：页面里没有的信息绝不会出现在草稿里（零编造）
 *   - schema-issue 机会生成与引擎接线
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { analyzeSchema, buildSchemaDraft } from "../../src/lib/schema";
import {
  generateOpportunities,
  countByType,
} from "../../src/lib/opportunity";

/* ------------------------------------------------------------------ */
/* HTML 夹具                                                           */
/* ------------------------------------------------------------------ */

const ld = (o: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(o)}</script>`;

/** 测试用 JSON 窄化助手（避免 any） */
const asObj = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const articleJsonLd = ld({
  "@context": "https://schema.org",
  "@type": "BlogPosting",
  headline: "地热能源入门指南",
  datePublished: "2026-01-10",
  author: { "@type": "Person", name: "Dr. GEO" },
  publisher: { "@type": "Organization", name: "鲸析研究院" },
});

const ARTICLE_HTML = `<!doctype html><html lang="zh"><head>
<title>地热能源入门指南 | 鲸析</title>
<meta name="description" content="一篇关于地热的长文">
<meta property="og:site_name" content="鲸析研究院">
${articleJsonLd}
</head><body>
<h1>地热能源入门指南</h1>
<p>作者：Dr. GEO ｜ 发布于 2026-01-10</p>
<p>${"地热是来自地球内部的热能资源。".repeat(40)}</p>
</body></html>`;

/* ------------------------------------------------------------------ */
/* 1. 页面类型检测（每种类型）                                         */
/* ------------------------------------------------------------------ */

describe("T10 detectPageType — 七种类型 + unknown", () => {
  it("article：顶层 BlogPosting JSON-LD → high", () => {
    const d = analyzeSchema("https://x.com/a", ARTICLE_HTML);
    assert.equal(d.detection.type, "article");
    assert.equal(d.detection.confidence, "high");
    assert.ok(d.detection.signals.some((s) => s.signal === "root:@type"));
  });

  it("article：@graph 中 Article 与 Organization 共存时，内容类型胜出", () => {
    const html = `<html><head>${ld({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Organization", name: "Acme" },
        { "@type": "Article", headline: "正文标题", datePublished: "2026-02-01" },
      ],
    })}</head><body><h1>正文标题</h1></body></html>`;
    const d = analyzeSchema("https://x.com/post", html);
    assert.equal(d.detection.type, "article");
    assert.ok(!d.detection.candidates.some((c) => c.type === "organization"));
  });

  it("article：无 JSON-LD 但有 article:published_time → medium", () => {
    const html = `<html><head>
      <title>某文章</title>
      <meta property="article:published_time" content="2026-03-01T08:00:00Z">
      </head><body><h1>某文章</h1><p>${"内容".repeat(200)}</p></body></html>`;
    const d = analyzeSchema("https://x.com/a2", html);
    assert.equal(d.detection.type, "article");
    assert.equal(d.detection.confidence, "medium");
  });

  it("product：Product JSON-LD → high", () => {
    const html = `<html><head>${ld({ "@type": "Product", name: "地热泵 X1" })}</head>
      <body><h1>地热泵 X1</h1></body></html>`;
    const d = analyzeSchema("https://x.com/p", html);
    assert.equal(d.detection.type, "product");
    assert.equal(d.detection.confidence, "high");
  });

  it("product：价格 + 购买按钮（无 JSON-LD）→ medium", () => {
    const html = `<html><body><h1>某设备</h1>
      <p>售价 ¥12,800</p><button>加入购物车</button></body></html>`;
    const d = analyzeSchema("https://x.com/p2", html);
    assert.equal(d.detection.type, "product");
    assert.equal(d.detection.confidence, "medium");
    assert.ok(d.detection.signals.some((s) => s.signal === "content:buyAction"));
  });

  it("faq：FAQPage JSON-LD → high", () => {
    const html = `<html><head>${ld({
      "@type": "FAQPage",
      mainEntity: [{ "@type": "Question", name: "Q", acceptedAnswer: { text: "A" } }],
    })}</head><body></body></html>`;
    const d = analyzeSchema("https://x.com/faq", html);
    assert.equal(d.detection.type, "faq");
    assert.equal(d.detection.confidence, "high");
  });

  it("faq：≥2 个疑问句标题且后跟答案 → medium", () => {
    const html = `<html><body>
      <h2>什么是地热？</h2><p>地热是来自地球内部的热能，温度随深度增加。</p>
      <h2>地热如何利用？</h2><p>通过地源热泵把地下恒温层的热量置换出来供暖制冷。</p>
      </body></html>`;
    const d = analyzeSchema("https://x.com/faq2", html);
    assert.equal(d.detection.type, "faq");
    assert.equal(d.detection.confidence, "medium");
  });

  it("howto：HowTo JSON-LD → high", () => {
    const html = `<html><head>${ld({ "@type": "HowTo", name: "如何安装" })}</head>
      <body><h1>如何安装</h1></body></html>`;
    const d = analyzeSchema("https://x.com/h", html);
    assert.equal(d.detection.type, "howto");
    assert.equal(d.detection.confidence, "high");
  });

  it("howto：有序列表 ≥2 步（无 JSON-LD）→ medium", () => {
    const html = `<html><body><h1>安装教程</h1>
      <ol><li>关闭电源并检查管路</li><li>连接主机并注液排气</li><li>开机调试参数</li></ol>
      </body></html>`;
    const d = analyzeSchema("https://x.com/h2", html);
    assert.equal(d.detection.type, "howto");
    assert.equal(d.detection.confidence, "medium");
  });

  it("local-business：LocalBusiness JSON-LD → high", () => {
    const html = `<html><head>${ld({
      "@type": "LocalBusiness",
      name: "某地热公司",
      address: { "@type": "PostalAddress", streetAddress: "中关村 1 号" },
    })}</head><body></body></html>`;
    const d = analyzeSchema("https://x.com/lb", html);
    assert.equal(d.detection.type, "local-business");
    assert.equal(d.detection.confidence, "high");
  });

  it("local-business：tel 链接 + 地址文本 → medium", () => {
    const html = `<html><body>
      <a href="tel:+861012345678">拨打</a>
      <p>地址：北京市海淀区中关村大街 1 号</p>
      </body></html>`;
    const d = analyzeSchema("https://x.com/lb2", html);
    assert.equal(d.detection.type, "local-business");
    assert.equal(d.detection.confidence, "medium");
  });

  it("organization：仅 Organization JSON-LD → high", () => {
    const html = `<html><head>${ld({ "@type": "Organization", name: "某机构", url: "https://x.com" })}
      </head><body></body></html>`;
    const d = analyzeSchema("https://x.com/o", html);
    assert.equal(d.detection.type, "organization");
    assert.equal(d.detection.confidence, "high");
  });

  it("organization：/about 页 + 联系方式（无 JSON-LD）→ low", () => {
    const html = `<html><head><title>关于我们</title></head><body>
      <h1>关于我们</h1><a href="mailto:hi@x.com">联系</a></body></html>`;
    const d = analyzeSchema("https://x.com/about", html);
    assert.equal(d.detection.type, "organization");
    assert.equal(d.detection.confidence, "low");
  });

  it("website：仅 WebSite JSON-LD → high", () => {
    const html = `<html><head>${ld({ "@type": "WebSite", name: "某站", url: "https://x.com" })}
      </head><body></body></html>`;
    const d = analyzeSchema("https://x.com/", html);
    assert.equal(d.detection.type, "website");
    assert.equal(d.detection.confidence, "high");
  });

  it("website：根路径且无其他信号 → low", () => {
    const html = `<html><body><h1>某站</h1><nav>首页 产品</nav></body></html>`;
    const d = analyzeSchema("https://x.com/", html);
    assert.equal(d.detection.type, "website");
    assert.equal(d.detection.confidence, "low");
  });

  it("unknown：无类型信号时如实返回 unknown，不硬猜", () => {
    const html = `<html><body><p>hi</p></body></html>`;
    const d = analyzeSchema("https://x.com/random", html);
    assert.equal(d.detection.type, "unknown");
    assert.equal(d.detection.signals.length, 0);
    assert.equal(d.fieldChecks.length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* 2. 字段检查与一致性                                                 */
/* ------------------------------------------------------------------ */

describe("T10 checkFields / checkConsistency", () => {
  it("Article 缺 datePublished → required missing", () => {
    const html = `<html><head>${ld({ "@type": "Article", headline: "有标题无日期" })}
      </head><body><h1>有标题无日期</h1></body></html>`;
    const d = analyzeSchema("https://x.com/a3", html);
    const dp = d.fieldChecks.find((f) => f.path === "datePublished")!;
    assert.equal(dp.level, "required");
    assert.equal(dp.status, "missing");
    assert.ok(d.missingRequiredCount >= 1);
  });

  it("FAQPage 条目部分缺 acceptedAnswer.text → incomplete", () => {
    const html = `<html><head>${ld({
      "@type": "FAQPage",
      mainEntity: [
        { "@type": "Question", name: "Q1", acceptedAnswer: { "@type": "Answer", text: "A1" } },
        { "@type": "Question", name: "Q2" },
      ],
    })}</head><body></body></html>`;
    const d = analyzeSchema("https://x.com/faq3", html);
    const ans = d.fieldChecks.find((f) => f.path === "mainEntity[].acceptedAnswer.text")!;
    assert.equal(ans.status, "incomplete");
    assert.match(ans.observed ?? "", /1\/2/);
  });

  it("headline 与 H1 矛盾 → mismatch", () => {
    const html = `<html><head>${ld({
      "@type": "Article",
      headline: "完全无关的另一个标题",
      datePublished: "2026-01-01",
    })}</head><body><h1>地热能源入门指南</h1></body></html>`;
    const d = analyzeSchema("https://x.com/a4", html);
    const issue = d.consistencyIssues.find((c) => c.kind === "headline-h1-mismatch");
    assert.ok(issue);
    assert.equal(issue!.severity, "mismatch");
  });

  it("datePublished 与 meta 日期矛盾 → mismatch", () => {
    const html = `<html><head>
      <meta property="article:published_time" content="2026-05-05">
      ${ld({ "@type": "Article", headline: "标题", datePublished: "2025-01-01" })}
      </head><body><h1>标题</h1></body></html>`;
    const d = analyzeSchema("https://x.com/a5", html);
    const issue = d.consistencyIssues.find((c) => c.kind === "date-published-mismatch");
    assert.ok(issue);
    assert.equal(issue!.jsonLdValue, "2025-01-01");
    assert.equal(issue!.pageValue, "2026-05-05");
  });

  it("headline 与 H1 一致（仅差站点名后缀）→ 不报问题", () => {
    const html = `<html><head>${ld({
      "@type": "Article",
      headline: "地热能源入门指南",
      datePublished: "2026-01-10",
    })}</head><body><h1>地热能源入门指南</h1></body></html>`;
    const d = analyzeSchema("https://x.com/a6", html);
    assert.equal(d.consistencyIssues.length, 0);
  });

  it("实体清晰度：作者/组织/时间被标注时 present+来源", () => {
    const d = analyzeSchema("https://x.com/a7", ARTICLE_HTML);
    assert.equal(d.entityClarity.author.present, true);
    assert.equal(d.entityClarity.author.source, "jsonld");
    assert.equal(d.entityClarity.datePublished.present, true);
    assert.equal(d.entityClarity.organization.present, true);
  });
});

/* ------------------------------------------------------------------ */
/* 3. 草稿：合法 JSON + 零编造（验收核心）                             */
/* ------------------------------------------------------------------ */

describe("T10 generate_schema_draft — 合法且零编造", () => {
  it("草稿可被 JSON.parse 且 @context/@type 正确", () => {
    const draft = buildSchemaDraft("https://x.com/a8", ARTICLE_HTML);
    assert.ok(draft.jsonLdString);
    const parsed = JSON.parse(draft.jsonLdString!) as Record<string, unknown>;
    assert.equal(parsed["@context"], "https://schema.org");
    assert.equal(parsed["@type"], "Article");
  });

  it("article 草稿只填真实字段：headline/datePublished/author/publisher 与页面一致", () => {
    const draft = buildSchemaDraft("https://x.com/a9", ARTICLE_HTML);
    const parsed = asObj(JSON.parse(draft.jsonLdString!));
    assert.equal(parsed.headline, "地热能源入门指南");
    assert.equal(parsed.datePublished, "2026-01-10");
    assert.equal(asObj(parsed.author).name, "Dr. GEO");
    assert.equal(asObj(parsed.publisher).name, "鲸析研究院");
    assert.equal(parsed.mainEntityOfPage, "https://x.com/a9");
  });

  it("★ 零编造：页面没有的信息不出现在草稿，只出现在 manualFields", () => {
    // 产品页：仅标题/描述 + itemprop 数字价格（无币种），无品牌/评分/SKU/作者
    const html = `<html><head><title>某设备 Pro</title>
      <meta name="description" content="一款设备">
      </head><body><h1>某设备 Pro</h1>
      <span itemprop="price">199</span>
      <button>加入购物车</button>
      </body></html>`;
    const draft = buildSchemaDraft("https://shop.example.com/p1", html);
    assert.equal(draft.pageType, "product");
    assert.ok(draft.jsonLdString, "至少 name/description 可填，草稿非空");
    const parsed = asObj(JSON.parse(draft.jsonLdString!));

    // 页面没有的信息绝不能出现
    assert.equal(parsed.offers, undefined, "无币种不得生成 offers");
    assert.equal(parsed.brand, undefined, "品牌不得编造");
    assert.equal(parsed.aggregateRating, undefined, "评分严禁编造");
    assert.equal(parsed.sku, undefined, "SKU 不得编造");
    assert.equal(parsed.author, undefined, "作者不得编造");

    // 但必须在人工补充清单里被标注
    const manualPaths = draft.manualFields.map((m) => m.path);
    assert.ok(manualPaths.includes("offers.price"));
    assert.ok(manualPaths.includes("offers.priceCurrency"));
    assert.ok(manualPaths.includes("aggregateRating.ratingValue"));
  });

  it("价格与币种同时可观测时才生成 offers，且币种正确", () => {
    const html = `<html><body><h1>某设备</h1>
      <p>售价 ¥12,800</p><button>立即购买</button></body></html>`;
    const draft = buildSchemaDraft("https://shop.example.com/p2", html);
    const parsed = asObj(JSON.parse(draft.jsonLdString!));
    assert.equal(asObj(parsed.offers).priceCurrency, "CNY");
    assert.equal(asObj(parsed.offers).price, "12800");
    // availability 页面没有 → 不出现，转 manualFields
    assert.equal(asObj(parsed.offers).availability, undefined);
    assert.ok(draft.manualFields.some((m) => m.path === "offers.availability"));
  });

  it("faq 草稿从页面真实问答对生成 mainEntity", () => {
    const html = `<html><body>
      <h2>什么是地热？</h2><p>地热是来自地球内部的热能。</p>
      <h2>地热如何利用？</h2><p>通过地源热泵置换热量。</p>
      </body></html>`;
    const draft = buildSchemaDraft("https://x.com/faq4", html);
    const parsed = asObj(JSON.parse(draft.jsonLdString!));
    assert.equal(parsed["@type"], "FAQPage");
    const entities = asArr(parsed.mainEntity);
    assert.equal(entities.length, 2);
    const first = asObj(entities[0]);
    assert.equal(first.name, "什么是地热？");
    assert.match(String(asObj(first.acceptedAnswer).text), /地球内部/);
  });

  it("howto 草稿从有序列表生成 step", () => {
    const html = `<html><body><h1>安装教程</h1>
      <ol><li>关闭电源</li><li>连接主机</li></ol></body></html>`;
    const draft = buildSchemaDraft("https://x.com/h3", html);
    const parsed = asObj(JSON.parse(draft.jsonLdString!));
    assert.equal(parsed["@type"], "HowTo");
    const steps = asArr(parsed.step);
    assert.equal(steps.length, 2);
    assert.equal(asObj(steps[0]).text, "关闭电源");
  });

  it("保留页面已有的同类型 JSON-LD 字段（只补缺不覆盖）", () => {
    const html = `<html><head>${ld({
      "@type": "Article",
      headline: "已有标题",
      datePublished: "2026-01-01",
      keywords: ["地热", "热泵"],
      author: { "@type": "Person", name: "老张" },
    })}</head><body><h1>已有标题</h1>
      <meta property="article:modified_time" content="2026-09-01">
      </body></html>`;
    const draft = buildSchemaDraft("https://x.com/a10", html);
    const parsed = asObj(JSON.parse(draft.jsonLdString!));
    assert.deepEqual(parsed.keywords, ["地热", "热泵"]);
    assert.equal(asObj(parsed.author).name, "老张", "已有作者不得被覆盖");
    assert.equal(parsed.dateModified, "2026-09-01", "缺失字段从页面补齐");
  });

  it("organization 草稿的 sameAs 只取真实社交/权威外链", () => {
    const html = `<html><head>
      <meta property="og:site_name" content="某机构">
      </head><body><h1>某机构</h1>
      <a href="mailto:hi@example.com">联系</a>
      <a href="https://www.linkedin.com/company/acme" rel="me">LinkedIn</a>
      <a href="https://example.com/internal">内页</a>
      </body></html>`;
    const draft = buildSchemaDraft("https://example.com/about", html);
    const parsed = asObj(JSON.parse(draft.jsonLdString!));
    const sameAs = asArr(parsed.sameAs);
    assert.ok(Array.isArray(parsed.sameAs));
    assert.equal(sameAs.length, 1);
    assert.match(String(sameAs[0]), /linkedin/);
  });

  it("unknown 类型或无任何可填值时 jsonLd 为 null（不给空壳）", () => {
    const html = `<html><body><p>hi</p></body></html>`;
    const draft = buildSchemaDraft("https://x.com/u", html);
    assert.equal(draft.pageType, "unknown");
    assert.equal(draft.jsonLd, null);
    assert.equal(draft.jsonLdString, null);
  });

  it("sourcedFrom 中每个草稿字段都能指回页面来源", () => {
    const draft = buildSchemaDraft("https://x.com/a11", ARTICLE_HTML);
    assert.ok(draft.sourcedFrom.some((s) => s.field === "headline" && s.source !== ""));
    assert.ok(draft.sourcedFrom.some((s) => s.field === "datePublished"));
  });
});

/* ------------------------------------------------------------------ */
/* 4. Opportunity Engine 接线                                          */
/* ------------------------------------------------------------------ */

describe("T10 schema-issue opportunity", () => {
  it("必填缺失 → schema-issue(high) 机会，建议引导复制草稿", () => {
    const diagnosis = analyzeSchema(
      "https://x.com/a12",
      `<html><head>${ld({ "@type": "Article", headline: "无日期" })}</head>
       <body><h1>无日期</h1></body></html>`
    );
    const list = generateOpportunities({ schemaDiagnoses: [diagnosis] });
    const opp = list.find((o) => o.type === "schema-issue");
    assert.ok(opp);
    assert.equal(opp!.impact, "high");
    assert.equal(opp!.effort, "low");
    assert.equal(opp!.target, "https://x.com/a12");
    assert.ok(opp!.diagnosis.evidence.length > 0);
    assert.ok(
      opp!.recommendations.some((r) => r.action.includes("generate_schema_draft"))
    );
    assert.equal(opp!.verification.signalKey, "schemaMissingRequiredCount");
    assert.equal(opp!.verification.direction, "decrease");
  });

  it("完整页面 → 不产生 schema-issue 机会（无 evidence 不输出）", () => {
    // JSON-LD 覆盖全部必填+推荐字段，实体六信号齐全
    const html = `<html><head>${ld({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "完整文章标题",
      description: "完整摘要",
      image: "https://x.com/cover.jpg",
      datePublished: "2026-01-01",
      dateModified: "2026-09-01",
      mainEntityOfPage: "https://x.com/full",
      author: { "@type": "Person", name: "作者甲" },
      publisher: {
        "@type": "Organization",
        name: "发布机构",
        sameAs: ["https://www.linkedin.com/company/acme"],
        contactPoint: { "@type": "ContactPoint", telephone: "+86-10-12345678" },
      },
    })}</head><body><h1>完整文章标题</h1></body></html>`;
    const diagnosis = analyzeSchema("https://x.com/full", html);
    assert.equal(diagnosis.missingRequiredCount, 0);
    assert.equal(diagnosis.missingRecommendedCount, 0);
    assert.equal(diagnosis.consistencyIssues.length, 0);
    const list = generateOpportunities({ schemaDiagnoses: [diagnosis] });
    assert.equal(list.some((o) => o.type === "schema-issue"), false);
  });

  it("countByType 包含 schema-issue 键", () => {
    const counts = countByType([]);
    assert.ok("schema-issue" in counts);
    assert.equal(counts["schema-issue"], 0);
  });

  it("缺输入时优雅跳过（undefined / 空数组）", () => {
    assert.deepEqual(generateOpportunities({}), []);
    assert.deepEqual(generateOpportunities({ schemaDiagnoses: [] }), []);
  });
});

/* ------------------------------------------------------------------ */
/* 5. 端到端建议                                                       */
/* ------------------------------------------------------------------ */

describe("T10 analyzeSchema 建议", () => {
  it("无 JSON-LD 的文章建议添加 Schema 并指向草稿工具", () => {
    const html = `<html><head>
      <meta property="article:published_time" content="2026-03-01">
      </head><body><h1>某文章</h1><p>${"内容".repeat(200)}</p></body></html>`;
    const d = analyzeSchema("https://x.com/a14", html);
    assert.ok(d.recommendations.some((r) => r.includes("generate_schema_draft")));
    assert.ok(d.recommendations.some((r) => r.includes("Article")));
  });
});
