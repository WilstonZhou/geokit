import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { crawlSite } from "../../src/lib/crawler";
import type { Fetcher } from "../../src/lib/crawler/types";
import type { FetchResult } from "../../src/lib/fetcher";

/**
 * 集成测试：用内存假站点覆盖 crawlSite 全流程。
 * 不调用真实 fetch —— 所有 HTTP 行为由 fakeSites 提供。
 */

function fakeFetchResult(body: string, url: string, status = 200, finalUrl?: string): FetchResult {
  return {
    ok: status >= 200 && status < 300,
    status,
    finalUrl: finalUrl ?? url,
    headers: { "content-type": "text/html" },
    body,
    byteLength: body.length,
    bodyHash: "h",
    elapsedMs: 1,
    attempts: [{ attempt: 1, elapsedMs: 1, outcome: status >= 200 && status < 300 ? "ok" : "error" }],
    waitedMs: 0,
    request: { url, method: "GET", headers: {} },
    context: { purpose: "crawl", target: url, requestedAt: new Date().toISOString() },
  };
}

/** 站点映射：URL → { html, status, finalUrl } */
function makeFetcher(sites: Record<string, { body: string; status?: number; finalUrl?: string }>): Fetcher {
  return async (req) => {
    const entry = sites[req.url];
    if (!entry) {
      // 未知 URL：返回 404
      return fakeFetchResult("Not Found", req.url, 404);
    }
    return fakeFetchResult(entry.body, req.url, entry.status ?? 200, entry.finalUrl);
  };
}

describe("crawlSite 集成（假站点）", () => {
  it("BFS 多页爬取并解析", async () => {
    const sites: Record<string, { body: string }> = {
      "https://example.com/": {
        body: `<html><head><title>首页</title></head><body><h1>首页 H1</h1><a href="/about">关于</a><a href="/blog">博客</a></body></html>`,
      },
      "https://example.com/about": {
        body: `<html><head><title>关于</title></head><body><h1>关于我们</h1></body></html>`,
      },
      "https://example.com/blog": {
        body: `<html><head><title>博客</title></head><body><h1>博客</h1></body></html>`,
      },
      "https://example.com/robots.txt": {
        body: "User-agent: *\nAllow: /",
      },
    };
    const fetcher = makeFetcher(sites);
    const r = await crawlSite("example.com", {
      fetcher,
      config: { maxPages: 20, maxDepth: 2, concurrency: 1, minRequestIntervalMs: 0 },
    });
    assert.ok(r.pages.length >= 3, `期望至少爬 3 页，实际 ${r.pages.length}`);
    const urls = r.pages.map((p) => p.url).sort();
    assert.ok(urls.includes("https://example.com/"));
    assert.ok(urls.includes("https://example.com/about"));
    assert.ok(urls.includes("https://example.com/blog"));
  });

  it("不跟随外链", async () => {
    const sites: Record<string, { body: string }> = {
      "https://example.com/": {
        body: `<a href="https://other.com/page">外链</a><a href="/internal">内链</a>`,
      },
      "https://example.com/internal": {
        body: `<html></html>`,
      },
      "https://example.com/robots.txt": { body: "" },
    };
    const fetcher = makeFetcher(sites);
    const r = await crawlSite("example.com", {
      fetcher,
      config: { maxPages: 20, maxDepth: 2, concurrency: 1, minRequestIntervalMs: 0 },
    });
    const external = r.pages.filter((p) => p.url.startsWith("https://other.com"));
    assert.strictEqual(external.length, 0, "不应爬取外链");
    assert.ok(r.pages.some((p) => p.url === "https://example.com/internal"));
  });

  it("maxPages 上限触发 truncated", async () => {
    const sites: Record<string, { body: string }> = {
      "https://example.com/": {
        body: `<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>`,
      },
      "https://example.com/a": { body: "" },
      "https://example.com/b": { body: "" },
      "https://example.com/c": { body: "" },
      "https://example.com/robots.txt": { body: "" },
    };
    const fetcher = makeFetcher(sites);
    const r = await crawlSite("example.com", {
      fetcher,
      config: { maxPages: 2, maxDepth: 5, concurrency: 1, minRequestIntervalMs: 0 },
    });
    assert.strictEqual(r.truncated, true);
    assert.ok(r.reason);
  });

  it("maxDepth 上限不深爬", async () => {
    const sites: Record<string, { body: string }> = {
      "https://example.com/": { body: `<a href="/a">a</a>` },
      "https://example.com/a": { body: `<a href="/b">b</a>` },
      "https://example.com/b": { body: `<a href="/c">c</a>` },
      "https://example.com/c": { body: `<a href="/d">d</a>` },
      "https://example.com/d": { body: "" },
      "https://example.com/robots.txt": { body: "" },
    };
    const fetcher = makeFetcher(sites);
    const r = await crawlSite("example.com", {
      fetcher,
      config: { maxPages: 50, maxDepth: 1, concurrency: 1, minRequestIntervalMs: 0 },
    });
    // maxDepth=1：起点 0 + 一层 1 —— 不应爬到 /b /c /d
    const urls = r.pages.map((p) => p.url);
    assert.ok(urls.includes("https://example.com/"));
    assert.ok(urls.includes("https://example.com/a"));
    assert.ok(!urls.includes("https://example.com/b"));
    assert.ok(!urls.includes("https://example.com/c"));
    assert.ok(!urls.includes("https://example.com/d"));
  });

  it("403 标记为 blocked", async () => {
    const sites: Record<string, { body: string; status?: number }> = {
      "https://example.com/": { body: "Forbidden", status: 403 },
      "https://example.com/robots.txt": { body: "" },
    };
    const fetcher = makeFetcher(sites);
    const r = await crawlSite("example.com", {
      fetcher,
      config: { maxPages: 5, maxDepth: 1, concurrency: 1, minRequestIntervalMs: 0 },
    });
    const blocked = r.pages.filter((p) => p.blocked);
    assert.ok(blocked.length > 0, "应有 blocked 页面");
    assert.ok(blocked[0].blocked!.reason.includes("403"));
    assert.strictEqual(blocked[0].httpStatus, 403);
  });

  it("4xx / 5xx 当数据保留", async () => {
    const sites: Record<string, { body: string; status?: number }> = {
      "https://example.com/": {
        body: `<a href="/404page">404</a><a href="/500page">500</a>`,
      },
      "https://example.com/404page": { body: "Not Found", status: 404 },
      "https://example.com/500page": { body: "Error", status: 500 },
      "https://example.com/robots.txt": { body: "" },
    };
    const fetcher = makeFetcher(sites);
    const r = await crawlSite("example.com", {
      fetcher,
      config: { maxPages: 10, maxDepth: 1, concurrency: 1, minRequestIntervalMs: 0 },
    });
    const p404 = r.pages.find((p) => p.url === "https://example.com/404page");
    const p500 = r.pages.find((p) => p.url === "https://example.com/500page");
    assert.ok(p404, "404 应被保留");
    assert.strictEqual(p404!.httpStatus, 404);
    assert.ok(!p404!.blocked, "404 不应标 blocked（仅 403 才标）");
    assert.ok(p500, "500 应被保留");
    assert.strictEqual(p500!.httpStatus, 500);
  });

  it("重定向链被捕获", async () => {
    const sites: Record<string, { body: string; status?: number; finalUrl?: string }> = {
      "https://example.com/": {
        body: `<html><head><title>首页</title></head><body>OK</body></html>`,
        finalUrl: "https://example.com/index.html",
      },
      "https://example.com/robots.txt": { body: "" },
    };
    const fetcher = makeFetcher(sites);
    const r = await crawlSite("example.com", {
      fetcher,
      config: { maxPages: 5, maxDepth: 1, concurrency: 1, minRequestIntervalMs: 0 },
    });
    const home = r.pages[0];
    assert.ok(home.redirectChain.length > 0, "应捕获重定向链");
    assert.ok(home.redirectChain.includes("https://example.com/index.html"));
  });

  it("不调用真实 fetch", async () => {
    // 用一个会抛错的 fetcher —— 如果调用真实网络那 fetcher 不会被用
    let called = false;
    const fetcher: Fetcher = async (req) => {
      called = true;
      if (req.url === "https://example.com/robots.txt") {
        return fakeFetchResult("", req.url, 404);
      }
      return fakeFetchResult("<html></html>", req.url);
    };
    await crawlSite("example.com", {
      fetcher,
      config: { maxPages: 5, maxDepth: 1, concurrency: 1, minRequestIntervalMs: 0 },
    });
    assert.ok(called, "应使用注入的 fetcher，不调用真实 fetch");
  });

  it("生成站点图（节点与边）", async () => {
    const sites: Record<string, { body: string }> = {
      "https://example.com/": {
        body: `<a href="/a">a</a><a href="/b">b</a>`,
      },
      "https://example.com/a": { body: `<a href="/b">b</a>` },
      "https://example.com/b": { body: `` },
      "https://example.com/robots.txt": { body: "" },
    };
    const fetcher = makeFetcher(sites);
    const r = await crawlSite("example.com", {
      fetcher,
      config: { maxPages: 20, maxDepth: 2, concurrency: 1, minRequestIntervalMs: 0 },
    });
    assert.ok(r.graph.nodes.length >= 3);
    assert.ok(r.graph.edges.length >= 2);
    // /b 应有 2 条入边（首页 + /a）
    const bNode = r.graph.nodes.find((n) => n.url === "https://example.com/b");
    assert.ok(bNode);
    assert.ok(bNode!.inlinks >= 2, `/b 入链应 >= 2，实际 ${bNode!.inlinks}`);
  });
});
