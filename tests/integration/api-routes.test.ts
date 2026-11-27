import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { POST as auditPost } from "../../src/app/api/audit/route";
import { POST as crawlPost } from "../../src/app/api/crawl/route";
import { POST as gscPost } from "../../src/app/api/gsc/route";
import { POST as mcpPost } from "../../src/app/api/mcp/route";
import { POST as serpPost } from "../../src/app/api/serp/route";
import { POST as visibilityPost } from "../../src/app/api/visibility/route";

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("API 路由级回归", () => {
  it("audit 离线 HTML 可分析（不发网络请求）", async () => {
    const res = await auditPost(
      jsonRequest("http://localhost/api/audit", {
        url: "https://example.com/page",
        html: "<html><head><title>Hello</title><meta name=\"description\" content=\"d\"></head><body><h1>Hello</h1><p>正文内容。</p></body></html>",
      })
    );
    assert.equal(res.status, 200);
    const data = (await res.json()) as { url?: string; title?: string };
    assert.equal(data.url, "https://example.com/page");
    assert.equal(data.title, "Hello");
  });

  it("非字符串关键字返回 400，而不是在 trim() 处抛 500", async () => {
    const res = await serpPost(
      jsonRequest("http://localhost/api/serp", { keyword: 123 })
    );
    assert.equal(res.status, 400);
  });

  it("visibility/crawl/gsc 的非字符串必填字段同样返回 400", async () => {
    const v = await visibilityPost(
      jsonRequest("http://localhost/api/visibility", { brand: 1, topic: 2 })
    );
    assert.equal(v.status, 400);

    const c = await crawlPost(
      jsonRequest("http://localhost/api/crawl", { site: 42 })
    );
    assert.equal(c.status, 400);

    const g = await gscPost(
      jsonRequest("http://localhost/api/gsc", { siteUrl: 7 })
    );
    assert.equal(g.status, 400);
  });

  it("超过请求体上限返回 413", async () => {
    const big = "x".repeat(1_200_000);
    const res = await serpPost(
      jsonRequest("http://localhost/api/serp", { keyword: big })
    );
    assert.equal(res.status, 413);
    const data = (await res.json()) as { error?: string };
    assert.match(data.error ?? "", /上限/);
  });

  it("MCP HTTP 收到 null 返回 JSON-RPC Invalid Request", async () => {
    const res = await mcpPost(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
      })
    );
    assert.equal(res.status, 200);
    const data = (await res.json()) as { error?: { code: number } };
    assert.equal(data.error?.code, -32600);
  });
});
