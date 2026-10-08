import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleJsonRpc } from "../../src/lib/mcp";
import type { Observation } from "../../src/lib/evidence/types";

async function callMcpTool(name: string, args: Record<string, unknown> = {}) {
  const res = await handleJsonRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return res as {
    jsonrpc: "2.0";
    id: number;
    result?: {
      content: { type: string; text: string }[];
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    error?: { code: number; message: string };
  };
}

describe("MCP Server Integration Tests", () => {
  it("tools/list lists all 24 registered tools", async () => {
    const listRes = (await handleJsonRpc({
      jsonrpc: "2.0",
      id: "init",
      method: "tools/list",
    })) as { result: { tools: { name: string; title: string }[] } };

    const tools = listRes.result.tools;
    const names = tools.map((t) => t.name);

    assert.strictEqual(tools.length, 24);
    assert.ok(names.includes("list_engines"));
    assert.ok(names.includes("check_serp_ranking"));
    assert.ok(names.includes("audit_page"));
    assert.ok(names.includes("check_ai_visibility"));
    assert.ok(names.includes("crawl_site"));
    assert.ok(names.includes("get_search_performance"));
    assert.ok(names.includes("analyze_search_opportunities"));
    assert.ok(names.includes("analyze_robots"));
    assert.ok(names.includes("analyze_llms_txt"));
    assert.ok(names.includes("generate_llms_txt"));
    assert.ok(names.includes("compare_with_openseo"));
    assert.ok(names.includes("diagnose_page"));
    assert.ok(names.includes("apply_fixes"));
    assert.ok(names.includes("diff_observations"));
    assert.ok(names.includes("list_observations"));
    assert.ok(names.includes("analyze_ai_citations"));
    assert.ok(names.includes("list_opportunities"));
    assert.ok(names.includes("verify_opportunity"));
    assert.ok(names.includes("analyze_query"));
    assert.ok(names.includes("cluster_queries"));
    assert.ok(names.includes("analyze_schema"));
    assert.ok(names.includes("generate_schema_draft"));
    assert.ok(names.includes("check_web_vitals"));
    // query_history 是 list_observations 的向后兼容别名,不在 tools/list 重复列出
    assert.ok(!names.includes("query_history"));
  });

  it("diagnose_page produces structured diagnoses from offline HTML", async () => {
    const sampleHtml = `<!doctype html>
<html>
<head><title>测试页面</title></head>
<body><h1>主标题</h1><img src="/logo.png"></body>
</html>`;

    const res = await callMcpTool("diagnose_page", {
      html: sampleHtml,
      url: "https://example.com/test",
    });

    assert.strictEqual(res.result?.isError, false);
    const data = res.result?.structuredContent as {
      url: string;
      counts: { blocker: number; major: number; minor: number };
      diagnoses: { issueId: string; severity: string; suggestedFix?: string }[];
    };
    assert.strictEqual(data.url, "https://example.com/test");
    assert.ok(data.counts.major > 0);
    assert.ok(data.diagnoses.some((d) => d.issueId === "desc/missing"));
    assert.ok(data.diagnoses.some((d) => d.issueId === "canonical/missing" && d.suggestedFix === "canonical"));
  });

  it("apply_fixes applies safe auto-fixes and is strictly idempotent", async () => {
    const sampleHtml = `<!doctype html>
<html>
<head><title>测试页面</title></head>
<body><h1>主标题</h1><img src="/logo.png"></body>
</html>`;

    const firstFix = await callMcpTool("apply_fixes", {
      html: sampleHtml,
      url: "https://example.com/test",
    });
    assert.strictEqual(firstFix.result?.isError, false);
    const data = firstFix.result?.structuredContent as {
      changed: boolean;
      fixedCount: number;
      html: string;
    };
    assert.strictEqual(data.changed, true);
    assert.ok(data.html.includes('rel="canonical"'));
    assert.ok(data.html.includes('name="viewport"'));
    assert.ok(data.html.includes('lang="zh-CN"'));
    assert.ok(data.html.includes('alt=""'));

    // Idempotency: run again on patched HTML
    const secondFix = await callMcpTool("apply_fixes", {
      html: data.html,
      url: "https://example.com/test",
    });
    const secondData = secondFix.result?.structuredContent as { changed: boolean; fixedCount: number };
    assert.strictEqual(secondData.changed, false);
    assert.strictEqual(secondData.fixedCount, 0);
  });

  it("list_observations returns store records and proper hint when empty", async () => {
    const res = await callMcpTool("list_observations", {
      type: "geo_score",
      limit: 10,
    });
    assert.strictEqual(res.result?.isError, false);
    const data = res.result?.structuredContent as {
      count: number;
      items: unknown[];
      hint?: string;
    };
    assert.strictEqual(typeof data.count, "number");
    assert.ok(Array.isArray(data.items));
    if (data.count === 0) {
      assert.strictEqual(typeof data.hint, "string");
    }
  });

  it("query_history alias still works for backward compatibility", async () => {
    const res = await callMcpTool("query_history", {
      type: "geo_score",
      limit: 10,
    });
    assert.strictEqual(res.result?.isError, false);
    const data = res.result?.structuredContent as { count: number; items: unknown[] };
    assert.strictEqual(typeof data.count, "number");
    assert.ok(Array.isArray(data.items));
  });

  it("diff_observations compares two observations accurately", async () => {
    const prevObs: Observation = {
      contractVersion: "0.2.0",
      id: "obs_prev",
      identityKey: "id1",
      versionKey: "v1",
      type: "ai_mention",
      subject: "ai-slot:deepseek:deepseek-chat",
      source: "provider:deepseek",
      status: "NOT_MENTIONED",
      observedAt: "2026-10-01T00:00:00Z",
      observerVersion: "ai-observer@0.1.0",
      parserVersion: "ai-visibility@0.1.0",
      confidence: "high",
      coverage: { expected: 1, observed: 1, ratio: 1 },
      evidenceRefs: ["ev1"],
      result: { mentioned: false },
      metadata: {},
    };

    const currObs: Observation = {
      ...prevObs,
      id: "obs_curr",
      status: "MENTIONED",
      observedAt: "2026-10-02T00:00:00Z",
      result: { mentioned: true },
    };

    const res = await callMcpTool("diff_observations", {
      prev: prevObs,
      curr: currObs,
    });
    assert.strictEqual(res.result?.isError, false);
    const data = res.result?.structuredContent as {
      diff: {
        comparable: boolean;
        summary: { improved: number; degraded: number };
      };
    };
    assert.strictEqual(data.diff.comparable, true);
    assert.strictEqual(data.diff.summary.improved, 1);
  });

  it("handles unknown tools and invalid arguments gracefully without crash", async () => {
    const unknownRes = await callMcpTool("unknown_non_existent", {});
    assert.strictEqual(unknownRes.result?.isError, true);
    assert.ok(unknownRes.result?.content[0]?.text.includes("未知工具"));

    const missingParamRes = await callMcpTool("apply_fixes", {});
    assert.strictEqual(missingParamRes.result?.isError, true);
  });
});
