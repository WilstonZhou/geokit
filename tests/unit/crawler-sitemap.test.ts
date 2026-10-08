import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseSitemapXml, discoverSitemaps } from "../../src/lib/crawler/sitemap";
import type { Fetcher } from "../../src/lib/crawler/types";
import type { FetchResult } from "../../src/lib/fetcher";

function fakeOk(body: string, url: string): FetchResult {
  return {
    ok: true,
    status: 200,
    finalUrl: url,
    headers: { "content-type": "application/xml" },
    body,
    byteLength: body.length,
    bodyHash: "h",
    elapsedMs: 1,
    attempts: [{ attempt: 1, elapsedMs: 1, outcome: "ok" }],
    waitedMs: 0,
    request: { url, method: "GET", headers: {} },
    context: {
      purpose: "crawl",
      target: url,
      requestedAt: new Date().toISOString(),
    },
  };
}

describe("crawler/sitemap", () => {
  describe("parseSitemapXml", () => {
    it("从 urlset 提取叶子 URL", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc></url>
  <url><loc>https://example.com/a</loc></url>
  <url><loc>https://example.com/b</loc></url>
</urlset>`;
      const r = parseSitemapXml(xml);
      assert.strictEqual(r.urls.length, 3);
      assert.strictEqual(r.sitemapIndexUrls.length, 0);
      assert.ok(r.urls.includes("https://example.com/a"));
    });

    it("从 sitemapindex 提取子索引 URL", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap-2.xml</loc></sitemap>
</sitemapindex>`;
      const r = parseSitemapXml(xml);
      assert.strictEqual(r.sitemapIndexUrls.length, 2);
      assert.strictEqual(r.urls.length, 0);
    });

    it("空 xml 返回空数组", () => {
      const r = parseSitemapXml("");
      assert.strictEqual(r.urls.length, 0);
      assert.strictEqual(r.sitemapIndexUrls.length, 0);
    });

    it("没有 loc 标签返回空数组", () => {
      const xml = `<urlset><url></url></urlset>`;
      const r = parseSitemapXml(xml);
      assert.strictEqual(r.urls.length, 0);
    });

    it("支持命名空间前缀", () => {
      const xml = `<ns:urlset xmlns:ns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <ns:url><ns:loc>https://example.com/x</ns:loc></ns:url>
      </ns:urlset>`;
      const r = parseSitemapXml(xml);
      assert.strictEqual(r.urls.length, 1);
    });

    it("支持 CDATA 包裹的 loc", () => {
      const xml = `<urlset>
        <url><loc><![CDATA[https://example.com/y]]></loc></url>
      </urlset>`;
      const r = parseSitemapXml(xml);
      assert.strictEqual(r.urls.length, 1);
      assert.strictEqual(r.urls[0], "https://example.com/y");
    });

    it("畸形文件（既不是 urlset 也不是 index）兜底走 urls", () => {
      const xml = `<root><loc>https://example.com/z</loc></root>`;
      const r = parseSitemapXml(xml);
      assert.strictEqual(r.urls.length, 1);
    });
  });

  describe("discoverSitemaps", () => {
    it("从 robots sitemap 列表递归发现叶子 URL", async () => {
      const calls: string[] = [];
      const fetcher: Fetcher = async (req) => {
        calls.push(req.url);
        if (req.url === "https://example.com/sitemap.xml") {
          return fakeOk(
            `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://example.com/s1.xml</loc></sitemap><sitemap><loc>https://example.com/s2.xml</loc></sitemap></sitemapindex>`,
            req.url
          );
        }
        if (req.url === "https://example.com/s1.xml") {
          return fakeOk(
            `<?xml version="1.0"?><urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url></urlset>`,
            req.url
          );
        }
        if (req.url === "https://example.com/s2.xml") {
          return fakeOk(
            `<?xml version="1.0"?><urlset><url><loc>https://example.com/c</loc></url></urlset>`,
            req.url
          );
        }
        return fakeOk("", req.url);
      };

      const urls = await discoverSitemaps(
        "https://example.com",
        ["https://example.com/sitemap.xml"],
        fetcher,
        { maxDepth: 3 }
      );
      const set = new Set(urls);
      assert.ok(set.has("https://example.com/a"));
      assert.ok(set.has("https://example.com/b"));
      assert.ok(set.has("https://example.com/c"));
      // 不重复
      assert.strictEqual(urls.length, new Set(urls).size);
    });

    it("maxDepth=0 时不递归 sitemapindex", async () => {
      const fetcher: Fetcher = async (req) => {
        if (req.url === "https://example.com/sitemap.xml") {
          return fakeOk(
            `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://example.com/s1.xml</loc></sitemap></sitemapindex>`,
            req.url
          );
        }
        return fakeOk("", req.url);
      };
      const urls = await discoverSitemaps(
        "https://example.com",
        ["https://example.com/sitemap.xml"],
        fetcher,
        { maxDepth: 0 }
      );
      assert.strictEqual(urls.length, 0);
    });

    it("单个 sitemap 失败不阻断整体", async () => {
      const fetcher: Fetcher = async (req) => {
        if (req.url === "https://example.com/bad.xml") {
          return { ...fakeOk("", req.url), ok: false, status: 500 };
        }
        if (req.url === "https://example.com/ok.xml") {
          return fakeOk(
            `<?xml version="1.0"?><urlset><url><loc>https://example.com/ok1</loc></url></urlset>`,
            req.url
          );
        }
        return fakeOk("", req.url);
      };
      const urls = await discoverSitemaps(
        "https://example.com",
        ["https://example.com/bad.xml", "https://example.com/ok.xml"],
        fetcher
      );
      assert.ok(urls.includes("https://example.com/ok1"));
    });

    it("robots sitemap 列表为空时尝试 {origin}/sitemap.xml 兜底", async () => {
      const fetcher: Fetcher = async (req) => {
        if (req.url === "https://example.com/sitemap.xml") {
          return fakeOk(
            `<?xml version="1.0"?><urlset><url><loc>https://example.com/</loc></url></urlset>`,
            req.url
          );
        }
        return fakeOk("", req.url);
      };
      const urls = await discoverSitemaps(
        "https://example.com",
        [],
        fetcher
      );
      assert.ok(urls.includes("https://example.com/"));
    });
  });
});
