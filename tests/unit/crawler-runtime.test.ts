import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  crawlSite,
  normalizeCrawlConfig,
  CRAWL_LIMITS,
} from "../../src/lib/crawler";
import type { Fetcher } from "../../src/lib/crawler/types";
import type { FetchResult } from "../../src/lib/fetcher";

function fakeResult(
  body: string,
  url: string,
  finalUrl?: string,
  redirectChain?: string[]
): FetchResult {
  return {
    ok: true,
    status: 200,
    finalUrl: finalUrl ?? url,
    redirectChain,
    headers: { "content-type": "text/html" },
    body,
    byteLength: body.length,
    bodyHash: "h",
    elapsedMs: 1,
    attempts: [{ attempt: 1, elapsedMs: 1, outcome: "ok" }],
    waitedMs: 0,
    request: { url, method: "GET", headers: {} },
    context: { purpose: "crawl", target: url, requestedAt: new Date().toISOString() },
  };
}

describe("crawler/runtime", () => {
  it("concurrency > 1 时真的并发（不再退化为 1）", async () => {
    const links = ["a", "b", "c", "d"];
    const sites: Record<string, string> = {
      "https://example.com/": links
        .map((p) => `<a href="/${p}">${p}</a>`)
        .join(""),
      "https://example.com/robots.txt": "User-agent: *\nAllow: /",
    };
    for (const p of links) {
      sites[`https://example.com/${p}`] = `<title>${p}</title><h1>${p}</h1>`;
    }

    let inFlight = 0;
    let maxInFlight = 0;
    const fetcher: Fetcher = async (req) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      const body = sites[req.url];
      return body === undefined
        ? fakeResult("Not Found", req.url)
        : fakeResult(body, req.url);
    };

    const result = await crawlSite("example.com", {
      fetcher,
      config: {
        concurrency: 4,
        maxPages: 20,
        maxDepth: 1,
        minRequestIntervalMs: 0,
      },
    });

    assert.ok(result.pages.length >= 5);
    assert.ok(
      maxInFlight >= 2,
      `期望并发抓取，实际 maxInFlight=${maxInFlight}`
    );
  });

  it("不可信 config 被钳制到硬上限", () => {
    const huge = normalizeCrawlConfig({
      maxPages: Number.POSITIVE_INFINITY,
      maxDepth: 1e9,
      concurrency: 1e9,
      perPageTimeoutMs: 1e12,
      totalBudgetMs: 1e15,
      minRequestIntervalMs: -1,
    });
    assert.equal(huge.maxPages, CRAWL_LIMITS.maxPages.max);
    assert.equal(huge.maxDepth, CRAWL_LIMITS.maxDepth.max);
    assert.equal(huge.concurrency, CRAWL_LIMITS.concurrency.max);
    assert.equal(huge.perPageTimeoutMs, CRAWL_LIMITS.perPageTimeoutMs.max);
    assert.equal(huge.totalBudgetMs, CRAWL_LIMITS.totalBudgetMs.max);
    assert.equal(huge.minRequestIntervalMs, 0);

    const small = normalizeCrawlConfig({
      maxPages: 0,
      concurrency: 0,
      totalBudgetMs: 1,
    });
    assert.equal(small.maxPages, CRAWL_LIMITS.maxPages.min);
    assert.equal(small.concurrency, CRAWL_LIMITS.concurrency.min);
    assert.equal(small.totalBudgetMs, CRAWL_LIMITS.totalBudgetMs.min);
  });

  it("同站 URL 重定向到站外：记录 finalUrl 但不分析外部内容", async () => {
    const sites: Record<string, string> = {
      "https://example.com/": "<h1>home</h1>",
      "https://example.com/robots.txt": "User-agent: *\nAllow: /",
    };
    const fetcher: Fetcher = async (req) => {
      if (req.url === "https://example.com/") {
        return fakeResult(
          `<h1>外部内容不应被分析</h1><a href="/secret">x</a>`,
          req.url,
          "https://evil.example/page",
          ["https://evil.example/page"]
        );
      }
      const body = sites[req.url];
      return body === undefined
        ? fakeResult("Not Found", req.url)
        : fakeResult(body, req.url);
    };

    const result = await crawlSite("example.com", {
      fetcher,
      config: { maxPages: 10, maxDepth: 1, minRequestIntervalMs: 0 },
    });
    const root = result.pages.find((p) => p.url === "https://example.com/");
    assert.ok(root);
    assert.equal(root!.finalUrl, "https://evil.example/page");
    assert.equal(root!.statusReason, "off_domain_redirect");
    assert.equal(root!.title, null);
    assert.equal(root!.outLinks.length, 0);
  });

  it("redirectChain 使用 fetcher 提供的逐跳链", async () => {
    const result = await crawlSite("example.com", {
      fetcher: async (req) => {
        if (req.url === "https://example.com/") {
          return fakeResult(
            "<h1>ok</h1>",
            req.url,
            "https://example.com/final",
            ["https://example.com/a", "https://example.com/final"]
          );
        }
        return fakeResult("Not Found", req.url);
      },
      config: { maxPages: 5, maxDepth: 0, minRequestIntervalMs: 0 },
    });
    assert.deepEqual(result.pages[0]!.redirectChain, [
      "https://example.com/a",
      "https://example.com/final",
    ]);
  });
});
