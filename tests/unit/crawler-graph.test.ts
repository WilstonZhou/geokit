import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildSiteGraph } from "../../src/lib/crawler/graph";
import type { CrawlPage } from "../../src/lib/crawler/types";

function fakePage(
  url: string,
  outLinks: string[],
  depth = 0
): CrawlPage {
  return {
    url,
    finalUrl: url,
    httpStatus: 200,
    redirectChain: [],
    title: null,
    metaDescription: null,
    h1: null,
    canonical: null,
    noindex: false,
    hreflang: [],
    jsonLdTypes: [],
    internalLinks: outLinks.length,
    externalLinks: 0,
    wordCount: 0,
    geoScore: 0,
    seoScore: 0,
    clickDepth: depth,
    outLinks,
  };
}

describe("crawler/graph", () => {
  it("入链计数正确", () => {
    const pages: CrawlPage[] = [
      fakePage("https://x.com/a", ["https://x.com/b", "https://x.com/c"]),
      fakePage("https://x.com/b", ["https://x.com/c"]),
      fakePage("https://x.com/c", []),
    ];
    const g = buildSiteGraph(pages, []);
    const byUrl = new Map(g.nodes.map((n) => [n.url, n]));
    assert.strictEqual(byUrl.get("https://x.com/a")!.inlinks, 0);
    assert.strictEqual(byUrl.get("https://x.com/b")!.inlinks, 1);
    assert.strictEqual(byUrl.get("https://x.com/c")!.inlinks, 2);
  });

  it("clickDepth 来自页面", () => {
    const pages: CrawlPage[] = [
      fakePage("https://x.com/", [], 0),
      fakePage("https://x.com/a", [], 1),
      fakePage("https://x.com/b", [], 2),
    ];
    const g = buildSiteGraph(pages, []);
    const byUrl = new Map(g.nodes.map((n) => [n.url, n]));
    assert.strictEqual(byUrl.get("https://x.com/")!.clickDepth, 0);
    assert.strictEqual(byUrl.get("https://x.com/a")!.clickDepth, 1);
    assert.strictEqual(byUrl.get("https://x.com/b")!.clickDepth, 2);
  });

  it("孤岛标记：sitemap 里有但 inlinks=0", () => {
    const pages: CrawlPage[] = [
      fakePage("https://x.com/", ["https://x.com/a"]),
      fakePage("https://x.com/a", []),
      fakePage("https://x.com/orphan", []),
    ];
    // 首页不在 sitemap 里；/orphan 在 sitemap 里但无入链
    const sitemapUrls = ["https://x.com/orphan"];
    const g = buildSiteGraph(pages, sitemapUrls);
    const byUrl = new Map(g.nodes.map((n) => [n.url, n]));
    // 首页入链 0 但不在 sitemap —— 不是 orphan（按定义：必须在 sitemap 里）
    assert.strictEqual(byUrl.get("https://x.com/")!.orphan, false);
    // /a 有入链 —— 不是 orphan
    assert.strictEqual(byUrl.get("https://x.com/a")!.orphan, false);
    // /orphan 在 sitemap 里但 0 入链 —— 是 orphan
    assert.strictEqual(byUrl.get("https://x.com/orphan")!.orphan, true);
  });

  it("循环 A→B→A 不让构建崩溃", () => {
    const pages: CrawlPage[] = [
      fakePage("https://x.com/a", ["https://x.com/b"]),
      fakePage("https://x.com/b", ["https://x.com/a"]),
    ];
    const g = buildSiteGraph(pages, []);
    const byUrl = new Map(g.nodes.map((n) => [n.url, n]));
    // 双向循环，双方都应至少 1 入链
    assert.ok(byUrl.get("https://x.com/a")!.inlinks >= 1);
    assert.ok(byUrl.get("https://x.com/b")!.inlinks >= 1);
    // 边数 = 总出链数（每页 1 条）
    assert.strictEqual(g.edges.length, 2);
  });

  it("指向未爬到页面的出链不入图", () => {
    const pages: CrawlPage[] = [fakePage("https://x.com/a", ["https://x.com/ghost"])];
    const g = buildSiteGraph(pages, []);
    // ghost 没有节点 —— 边不应出现
    assert.strictEqual(g.edges.length, 0);
    assert.strictEqual(g.nodes.length, 1);
  });
});
