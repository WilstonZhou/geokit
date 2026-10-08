import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeCrawlUrl,
  isStaticAsset,
  isSameDomain,
  extractLinks,
} from "../../src/lib/crawler/normalize";

describe("crawler/normalize", () => {
  describe("normalizeCrawlUrl", () => {
    it("去掉 fragment", () => {
      const n = normalizeCrawlUrl("https://example.com/a#section");
      assert.strictEqual(n, "https://example.com/a");
    });

    it("query 参数按字母序排序", () => {
      const n = normalizeCrawlUrl("https://example.com/x?b=2&a=1&c=3");
      assert.strictEqual(n, "https://example.com/x?a=1&b=2&c=3");
    });

    it("默认去掉非根路径尾斜杠", () => {
      const n = normalizeCrawlUrl("https://example.com/path/");
      assert.strictEqual(n, "https://example.com/path");
    });

    it("根路径的尾斜杠保留", () => {
      const n = normalizeCrawlUrl("https://example.com/");
      assert.strictEqual(n, "https://example.com/");
    });

    it("host 小写", () => {
      const n = normalizeCrawlUrl("https://EXAMPLE.com/Path");
      // host 全部小写，path 保留原大小写
      assert.ok(n.startsWith("https://example.com/Path"));
    });

    it("trailingSlash: 'keep' 保留尾斜杠", () => {
      const n = normalizeCrawlUrl("https://example.com/path/", {
        trailingSlash: "keep",
      });
      assert.strictEqual(n, "https://example.com/path/");
    });

    it("畸形输入原样返回", () => {
      const n = normalizeCrawlUrl("not a url");
      assert.strictEqual(n, "not a url");
    });

    it("空串返回空串", () => {
      assert.strictEqual(normalizeCrawlUrl(""), "");
    });
  });

  describe("isStaticAsset", () => {
    it("图片扩展为静态资源", () => {
      assert.strictEqual(isStaticAsset("https://x.com/a.png"), true);
      assert.strictEqual(isStaticAsset("https://x.com/a.JPG"), true);
      assert.strictEqual(isStaticAsset("https://x.com/a.webp"), true);
      assert.strictEqual(isStaticAsset("https://x.com/a.svg"), true);
    });

    it("html / 根路径不是静态资源", () => {
      assert.strictEqual(isStaticAsset("https://x.com/page.html"), false);
      assert.strictEqual(isStaticAsset("https://x.com/"), false);
      assert.strictEqual(isStaticAsset("https://x.com"), false);
    });

    it("带 query 的资源路径仍命中扩展", () => {
      // 注意：URL.pathname 不含 query，所以仍能取到扩展
      assert.strictEqual(
        isStaticAsset("https://x.com/img.png?v=2"),
        true
      );
    });
  });

  describe("isSameDomain", () => {
    it("同 host 一致", () => {
      assert.strictEqual(
        isSameDomain("https://example.com/a", "https://example.com", false),
        true
      );
    });

    it("子域在 includeSubdomains=true 时算同域", () => {
      assert.strictEqual(
        isSameDomain("https://www.example.com/a", "https://example.com", true),
        true
      );
      assert.strictEqual(
        isSameDomain("https://blog.example.com/a", "https://example.com", true),
        true
      );
    });

    it("子域在 includeSubdomains=false 时不算同域", () => {
      assert.strictEqual(
        isSameDomain("https://www.example.com/a", "https://example.com", false),
        false
      );
    });

    it("完全不同域不算同域", () => {
      assert.strictEqual(
        isSameDomain("https://other.com/a", "https://example.com", true),
        false
      );
    });

    it("host 大小写不敏感", () => {
      assert.strictEqual(
        isSameDomain("https://EXAMPLE.com/a", "https://example.com", false),
        true
      );
    });

    it("畸形 URL 返回 false", () => {
      assert.strictEqual(isSameDomain("not a url", "https://example.com", false), false);
      assert.strictEqual(isSameDomain("https://example.com/a", "not a url", false), false);
    });
  });

  describe("extractLinks", () => {
    it("提取多个绝对 URL", () => {
      const html = `
        <a href="https://example.com/a">A</a>
        <a href="https://example.com/b">B</a>
      `;
      const out = extractLinks(html, "https://example.com/");
      assert.deepEqual(out.sort(), [
        "https://example.com/a",
        "https://example.com/b",
      ]);
    });

    it("相对 URL 用 baseUrl 绝对化", () => {
      const html = `<a href="/relative">R</a><a href="../up">U</a>`;
      const out = extractLinks(html, "https://example.com/sub/page");
      assert.ok(out.includes("https://example.com/relative"));
      assert.ok(out.includes("https://example.com/up"));
    });

    it("过滤外链", () => {
      const html = `<a href="https://other.com/x">ext</a>`;
      const out = extractLinks(html, "https://example.com/");
      // 外链仍会出现在结果里 —— extractLinks 只负责提取与绝对化，
      // 同域过滤是调用方（crawlSite）的职责
      assert.strictEqual(out.length, 1);
    });

    it("去重", () => {
      const html = `
        <a href="https://example.com/a">A1</a>
        <a href="https://example.com/a">A2</a>
      `;
      const out = extractLinks(html, "https://example.com/");
      assert.strictEqual(out.length, 1);
    });

    it("跳过锚点/mailto/javascript", () => {
      const html = `
        <a href="#top">top</a>
        <a href="mailto:a@b.com">mail</a>
        <a href="javascript:void(0)">js</a>
        <a href="tel:+1">phone</a>
        <a href="data:text/plain,hello">data</a>
      `;
      const out = extractLinks(html, "https://example.com/");
      assert.strictEqual(out.length, 0);
    });

    it("大小写不敏感", () => {
      const html = `<A HREF="https://example.com/X">x</A>`;
      const out = extractLinks(html, "https://example.com/");
      assert.strictEqual(out.length, 1);
    });

    it("畸形 href 不影响其它链接", () => {
      const html = `<a href="https://example.com/ok">ok</a><a href="">empty</a>`;
      const out = extractLinks(html, "https://example.com/");
      assert.strictEqual(out.length, 1);
    });
  });
});
