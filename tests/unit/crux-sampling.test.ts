import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { CrawlPage } from "../../src/lib/crawler/types";
import {
  samplePagesForPerformance,
  queryPerformanceWithFallback,
} from "../../src/lib/crux";
import { genPoorWebVitals } from "../../src/lib/opportunity/generators";

function makeFakePage(
  url: string,
  opts: {
    status?: number;
    blocked?: boolean;
    jsonLdTypes?: string[];
    h1?: string;
    wordCount?: number;
  } = {}
): CrawlPage {
  return {
    url,
    finalUrl: url,
    httpStatus: opts.status ?? 200,
    redirectChain: [],
    title: "测试标题",
    metaDescription: "测试描述",
    h1: opts.h1 ?? "测试主标题",
    canonical: null,
    noindex: false,
    hreflang: [],
    jsonLdTypes: opts.jsonLdTypes ?? [],
    internalLinks: 1,
    externalLinks: 0,
    wordCount: opts.wordCount ?? 500,
    geoScore: 70,
    seoScore: 70,
    clickDepth: 1,
    outLinks: [],
    blocked: opts.blocked ? { reason: "HTTP 403 Forbidden" } : undefined,
  };
}

describe("Sprint 3: 性能观测与类型抽样闭环", () => {
  describe("3.1 页面类型智能抽样 (samplePagesForPerformance)", () => {
    it("从全站页面中按规则抽样（最多 1 home, 2 article, 2 product/landing, 总量 ≤ 5）", () => {
      const pages: CrawlPage[] = [
        // 2 个 Homepage 候选
        makeFakePage("https://example.com/", { jsonLdTypes: ["WebSite"] }),
        makeFakePage("https://example.com/index.html", { jsonLdTypes: ["WebSite"] }),
        // 3 个 Article 候选
        makeFakePage("https://example.com/blog/post-1", { jsonLdTypes: ["Article"] }),
        makeFakePage("https://example.com/blog/post-2", { jsonLdTypes: ["BlogPosting"] }),
        makeFakePage("https://example.com/news/article-3", { jsonLdTypes: ["NewsArticle"] }),
        // 3 个 Product / Landing 候选
        makeFakePage("https://example.com/product/item-1", { jsonLdTypes: ["Product"] }),
        makeFakePage("https://example.com/product/item-2", { jsonLdTypes: ["Product"] }),
        makeFakePage("https://example.com/store/item-3", { jsonLdTypes: ["LocalBusiness"] }),
        // 失败 / 拦截页面（应被直接忽略）
        makeFakePage("https://example.com/404-page", { status: 404 }),
        makeFakePage("https://example.com/blocked-page", { status: 403, blocked: true }),
      ];

      const sampled = samplePagesForPerformance(pages);

      // 总数 <= 5
      assert.ok(sampled.length <= 5, `抽样总数应 <= 5，实际为 ${sampled.length}`);

      // 验证不包含 404 或 blocked 页面
      assert.ok(!sampled.some((p) => p.httpStatus !== 200 || p.blocked));

      // 验证类型分布：最多 1 个 home, 最多 2 个 article, 最多 2 个 product
      const homeCount = sampled.filter((p) => p.url === "https://example.com/").length;
      assert.strictEqual(homeCount, 1, "应选出正好 1 个首页");

      const articleCount = sampled.filter((p) =>
        p.jsonLdTypes.some((t) => ["Article", "BlogPosting", "NewsArticle"].includes(t))
      ).length;
      assert.ok(articleCount <= 2, `文章最多 2 个，实际 ${articleCount}`);

      const productCount = sampled.filter((p) =>
        p.jsonLdTypes.some((t) => ["Product", "LocalBusiness"].includes(t))
      ).length;
      assert.ok(productCount <= 2, `产品/Landing 最多 2 个，实际 ${productCount}`);

      // 总计应为 1 + 2 + 2 = 5
      assert.strictEqual(sampled.length, 5);
    });

    it("空输入或全为失败页面时安全返回空数组", () => {
      assert.deepStrictEqual(samplePagesForPerformance([]), []);
      assert.deepStrictEqual(
        samplePagesForPerformance([makeFakePage("https://example.com/404", { status: 404 })]),
        []
      );
    });
  });

  describe("3.2 PSI 实验室数据 Fallback 与 Opportunity 触发", () => {
    it("CrUX 响应 404 时平滑降级调用 PSI，并在指标 poor 时触发 poor-web-vitals 机会", async () => {
      const targetUrl = "https://example.com/low-traffic-page";

      const mockFetch: typeof fetch = (async (input: RequestInfo | URL) => {
        const urlStr = String(input);
        // 如果是 CrUX 端点：模拟 404 NOT_FOUND（低流量页面无真实用户数据）
        if (urlStr.includes("chromeuxreport.googleapis.com")) {
          return {
            ok: false,
            status: 404,
            statusText: "Not Found",
            json: async () => ({
              error: {
                code: 404,
                message: "chrome ux report data not found",
                status: "NOT_FOUND",
              },
            }),
          } as Response;
        }

        // 如果是 PageSpeed Insights 端点：返回 Lighthouse 实验室基准数据 (Lab Data)
        if (urlStr.includes("pagespeedonline")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({
              lighthouseResult: {
                audits: {
                  "largest-contentful-paint": { numericValue: 4500.5 }, // poor (> 4000ms)
                  "cumulative-layout-shift": { numericValue: 0.05 }, // good (<= 0.1)
                  "total-blocking-time": { numericValue: 350.0 }, // needs-improvement
                  "first-contentful-paint": { numericValue: 1500.0 }, // good (<= 1800ms)
                  "server-response-time": { numericValue: 300.0 }, // good (<= 800ms)
                },
              },
            }),
          } as Response;
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      }) as typeof fetch;

      const obs = await queryPerformanceWithFallback(targetUrl, {
        apiKey: "fake-test-key",
        fetchFn: mockFetch,
      });

      // 验证降级成功且标注来源
      assert.strictEqual(obs.status, "ok");
      assert.strictEqual(obs.dataSource, "psi-lighthouse");
      assert.strictEqual(obs.overallCategory, "SLOW");
      assert.ok(obs.metrics && obs.metrics.length > 0);

      // 验证 LCP 评估为 poor
      const lcp = obs.metrics.find((m) => m.metric === "largest_contentful_paint");
      assert.ok(lcp);
      assert.strictEqual(lcp.category, "poor");
      assert.strictEqual(lcp.p75, 4500.5);

      // 验证输入到 Opportunity Engine 中正确触发 poor-web-vitals 机会
      const opportunities = genPoorWebVitals([obs]);
      assert.strictEqual(opportunities.length, 1);
      assert.strictEqual(opportunities[0].type, "poor-web-vitals");
      assert.strictEqual(opportunities[0].impact, "high");
      assert.strictEqual(opportunities[0].target, targetUrl);

      // 验证证据中包含 PSI 实验室指标事实
      const lcpEvidence = opportunities[0].diagnosis.evidence.find((e) =>
        e.signal.includes("largest_contentful_paint")
      );
      assert.ok(lcpEvidence);
      assert.strictEqual(lcpEvidence.value, 4500.5);
    });

    it("CrUX 正常响应时直接返回 CrUX 数据，不触发 PSI 降级", async () => {
      const targetUrl = "https://example.com/popular-page";
      let psiCalled = false;

      const mockFetch: typeof fetch = (async (input: RequestInfo | URL) => {
        const urlStr = String(input);
        if (urlStr.includes("chromeuxreport.googleapis.com")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({
              record: {
                key: { url: targetUrl },
                collectionPeriod: {
                  firstDate: { year: 2026, month: 9, day: 1 },
                  lastDate: { year: 2026, month: 9, day: 28 },
                },
                metrics: {
                  largest_contentful_paint: {
                    histogram: [{ start: 0, end: 2500, density: 0.9 }],
                    percentiles: { p75: 1800 },
                  },
                },
              },
            }),
          } as Response;
        }

        if (urlStr.includes("pagespeedonline")) {
          psiCalled = true;
          return { ok: true, status: 200, json: async () => ({}) } as Response;
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      }) as typeof fetch;

      const obs = await queryPerformanceWithFallback(targetUrl, {
        apiKey: "fake-test-key",
        fetchFn: mockFetch,
      });

      assert.strictEqual(obs.status, "ok");
      assert.strictEqual(obs.dataSource, "crux");
      assert.strictEqual(psiCalled, false, "CrUX 正常时不得调用 PSI");
    });
  });
});

