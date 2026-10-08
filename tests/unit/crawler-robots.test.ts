import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseRobots } from "../../src/lib/llms";
import {
  allowedByRobots,
  crawlDelayFor,
  fetchAndParseRobots,
} from "../../src/lib/crawler/robots";
import type { Fetcher } from "../../src/lib/crawler/types";
import type { FetchResult } from "../../src/lib/fetcher";

function fakeOk(body: string, url: string): FetchResult {
  return {
    ok: true,
    status: 200,
    finalUrl: url,
    headers: { "content-type": "text/plain" },
    body,
    byteLength: body.length,
    bodyHash: "h",
    elapsedMs: 1,
    attempts: [{ attempt: 1, elapsedMs: 1, outcome: "ok" }],
    waitedMs: 0,
    request: { url, method: "GET", headers: {} },
    context: { purpose: "robots", target: url, requestedAt: new Date().toISOString() },
  };
}

describe("crawler/robots", () => {
  describe("allowedByRobots", () => {
    it("Disallow /private 阻止 /private/page", () => {
      const p = parseRobots("User-agent: *\nDisallow: /private");
      const r = allowedByRobots(p, "/private/page", "GEOkitBot");
      assert.strictEqual(r.allowed, false);
      assert.ok(r.rule?.startsWith("Disallow"));
    });

    it("Disallow /private 允许 /public", () => {
      const p = parseRobots("User-agent: *\nDisallow: /private");
      const r = allowedByRobots(p, "/public", "GEOkitBot");
      assert.strictEqual(r.allowed, true);
    });

    it("最长匹配优先", () => {
      // /private/page 由更长的规则匹配，而不是 /private
      const txt = [
        "User-agent: *",
        "Disallow: /private",
        "Allow: /private/page",
      ].join("\n");
      const p = parseRobots(txt);
      const r = allowedByRobots(p, "/private/page", "GEOkitBot");
      assert.strictEqual(r.allowed, true);
    });

    it("同长度时 Allow 胜出", () => {
      const txt = [
        "User-agent: *",
        "Disallow: /path",
        "Allow: /path",
      ].join("\n");
      const p = parseRobots(txt);
      const r = allowedByRobots(p, "/path", "GEOkitBot");
      assert.strictEqual(r.allowed, true);
    });

    it("无规则时默认允许", () => {
      const p = parseRobots("User-agent: *\n");
      const r = allowedByRobots(p, "/anything", "GEOkitBot");
      assert.strictEqual(r.allowed, true);
      assert.strictEqual(r.rule, null);
    });

    it("空 path 视为匹配所有", () => {
      const txt = "User-agent: *\nDisallow:";
      const p = parseRobots(txt);
      const r = allowedByRobots(p, "/any", "GEOkitBot");
      assert.strictEqual(r.allowed, true);
    });

    it("精确 UA 组优先于通配组", () => {
      const txt = [
        "User-agent: GEOkitBot",
        "Allow: /private",
        "",
        "User-agent: *",
        "Disallow: /private",
      ].join("\n");
      const p = parseRobots(txt);
      const r = allowedByRobots(p, "/private", "GEOkitBot");
      assert.strictEqual(r.allowed, true);
    });
  });

  describe("crawlDelayFor", () => {
    it("从匹配 UA 的组提取 Crawl-delay", () => {
      const txt = [
        "User-agent: GEOkitBot",
        "Crawl-delay: 5",
        "",
        "User-agent: *",
        "Crawl-delay: 1",
      ].join("\n");
      assert.strictEqual(crawlDelayFor(txt, "GEOkitBot"), 5);
    });

    it("未声明时返回 null", () => {
      const txt = "User-agent: *\nDisallow: /a";
      assert.strictEqual(crawlDelayFor(txt, "GEOkitBot"), null);
    });

    it("group 特有：通配组的 delay 不影响精确组", () => {
      const txt = [
        "User-agent: *",
        "Crawl-delay: 1",
        "",
        "User-agent: GEOkitBot",
      ].join("\n");
      // GEOkitBot 没有自己的 Crawl-delay，精确组优先但无 delay 字段
      assert.strictEqual(crawlDelayFor(txt, "GEOkitBot"), null);
    });

    it("回退到通配组 delay", () => {
      const txt = [
        "User-agent: *",
        "Crawl-delay: 2",
      ].join("\n");
      assert.strictEqual(crawlDelayFor(txt, "GEOkitBot"), 2);
    });

    it("空文本返回 null", () => {
      assert.strictEqual(crawlDelayFor("", "GEOkitBot"), null);
    });
  });

  describe("fetchAndParseRobots", () => {
    it("200 返回 parsed 与 raw", async () => {
      const body = "User-agent: *\nDisallow: /private\nSitemap: https://example.com/sitemap.xml";
      const fetcher: Fetcher = async (req) => fakeOk(body, req.url);
      const r = await fetchAndParseRobots("https://example.com", fetcher);
      assert.ok(r.parsed !== null);
      assert.strictEqual(r.raw, body);
      assert.ok(r.sitemaps.includes("https://example.com/sitemap.xml"));
    });

    it("404 返回 null", async () => {
      const fetcher: Fetcher = async (req) => ({
        ...fakeOk("", req.url),
        ok: false,
        status: 404,
      });
      const r = await fetchAndParseRobots("https://example.com", fetcher);
      assert.strictEqual(r.parsed, null);
      assert.strictEqual(r.raw, null);
      assert.strictEqual(r.sitemaps.length, 0);
    });

    it("网络错误返回 null", async () => {
      const fetcher: Fetcher = async () => {
        throw new Error("network");
      };
      const r = await fetchAndParseRobots("https://example.com", fetcher);
      assert.strictEqual(r.parsed, null);
      assert.strictEqual(r.raw, null);
    });
  });
});
