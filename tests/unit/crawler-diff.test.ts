import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { diffCrawlResults } from "../../src/lib/crawler/diff";
import type { CrawlPage, CrawlResult } from "../../src/lib/crawler/types";

function fakeResult(
  pages: CrawlPage[],
  overrides: Partial<CrawlResult> = {}
): CrawlResult {
  return {
    origin: "https://example.com",
    pages,
    graph: { nodes: [], edges: [] },
    truncated: false,
    startedAt: "2026-10-08T00:00:00.000Z",
    elapsedMs: 100,
    config: {
      maxPages: 100,
      maxDepth: 3,
      concurrency: 2,
      perPageTimeoutMs: 15_000,
      totalBudgetMs: 120_000,
      includeSubdomains: false,
      minRequestIntervalMs: 500,
      ua: "GEOkitBot",
    },
    ...overrides,
  };
}

function fakePage(url: string, httpStatus = 200, title: string | null = null): CrawlPage {
  return {
    url,
    finalUrl: url,
    httpStatus,
    redirectChain: [],
    title,
    metaDescription: null,
    h1: null,
    canonical: null,
    noindex: false,
    hreflang: [],
    jsonLdTypes: [],
    internalLinks: 0,
    externalLinks: 0,
    wordCount: 0,
    geoScore: 0,
    seoScore: 0,
    clickDepth: 0,
    outLinks: [],
  };
}

describe("crawler/diff", () => {
  it("added 页面：本次有、上次无", () => {
    const prev = fakeResult([fakePage("https://x.com/a")]);
    const cur = fakeResult([
      fakePage("https://x.com/a"),
      fakePage("https://x.com/b"),
    ]);
    const d = diffCrawlResults(prev, cur);
    assert.deepEqual(d.added, ["https://x.com/b"]);
  });

  it("removed 页面：上次有、本次无", () => {
    const prev = fakeResult([
      fakePage("https://x.com/a"),
      fakePage("https://x.com/b"),
    ]);
    const cur = fakeResult([fakePage("https://x.com/a")]);
    const d = diffCrawlResults(prev, cur);
    assert.deepEqual(d.removed, ["https://x.com/b"]);
  });

  it("statusChanged：200 → 404", () => {
    const prev = fakeResult([fakePage("https://x.com/a", 200)]);
    const cur = fakeResult([fakePage("https://x.com/a", 404)]);
    const d = diffCrawlResults(prev, cur);
    assert.strictEqual(d.statusChanged.length, 1);
    assert.strictEqual(d.statusChanged[0].status, "status-changed");
    assert.strictEqual(d.statusChanged[0].prevStatus, 200);
    assert.strictEqual(d.statusChanged[0].curStatus, 404);
  });

  it("title 变化也算 statusChanged", () => {
    const prev = fakeResult([fakePage("https://x.com/a", 200, "old")]);
    const cur = fakeResult([fakePage("https://x.com/a", 200, "new")]);
    const d = diffCrawlResults(prev, cur);
    assert.strictEqual(d.statusChanged.length, 1);
    assert.strictEqual(d.statusChanged[0].prevTitle, "old");
    assert.strictEqual(d.statusChanged[0].curTitle, "new");
  });

  it("unchanged 计数", () => {
    const prev = fakeResult([
      fakePage("https://x.com/a", 200, "T"),
      fakePage("https://x.com/b", 200, "U"),
    ]);
    const cur = fakeResult([
      fakePage("https://x.com/a", 200, "T"),
      fakePage("https://x.com/b", 200, "U"),
    ]);
    const d = diffCrawlResults(prev, cur);
    assert.strictEqual(d.unchangedCount, 2);
    assert.strictEqual(d.added.length, 0);
    assert.strictEqual(d.removed.length, 0);
    assert.strictEqual(d.statusChanged.length, 0);
  });

  it("两次完全相同的爬取：无 diff", () => {
    const r = fakeResult([fakePage("https://x.com/a", 200, "T")]);
    const d = diffCrawlResults(r, r);
    assert.strictEqual(d.added.length, 0);
    assert.strictEqual(d.removed.length, 0);
    assert.strictEqual(d.statusChanged.length, 0);
    assert.strictEqual(d.unchangedCount, 1);
  });
});
