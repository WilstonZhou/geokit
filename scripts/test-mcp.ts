/**
 * MCP Server 自动化测试套件（Phase R1）。
 *
 * 验证：
 *   1. tools/list 完整暴露 12 个工具（原有 8 个 + 新增 4 个）
 *   2. diagnose_page（离线 HTML 与参数校验）
 *   3. apply_fixes（自动安全修复与幂等性）
 *   4. query_history（Store 历史查询契约与空结果 hint）
 *   5. diff_observations（时序对比与退化判断）
 *   6. 错误处理与未知工具兜底
 */
import { handleJsonRpc } from "../src/lib/mcp";
import type { Observation } from "../src/lib/evidence/types";

let passCount = 0;
let failCount = 0;

function ok(cond: boolean, name: string, detail?: unknown): void {
  if (cond) {
    passCount++;
    console.log(`  ✅ ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`);
  } else {
    failCount++;
    console.error(`  ❌ ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`);
  }
}

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

async function main() {
  console.log("\n── 1 MCP tools/list 登记核对 ──");
  const listRes = (await handleJsonRpc({
    jsonrpc: "2.0",
    id: "init",
    method: "tools/list",
  })) as { result: { tools: { name: string; title: string }[] } };

  const tools = listRes.result.tools;
  const toolNames = tools.map((t) => t.name);

  ok(tools.length === 12, "总工具数为 12", tools.length);
  ok(toolNames.includes("list_engines"), "包含 list_engines");
  ok(toolNames.includes("check_serp_ranking"), "包含 check_serp_ranking");
  ok(toolNames.includes("audit_page"), "包含 audit_page");
  ok(toolNames.includes("check_ai_visibility"), "包含 check_ai_visibility");
  ok(toolNames.includes("analyze_robots"), "包含 analyze_robots");
  ok(toolNames.includes("analyze_llms_txt"), "包含 analyze_llms_txt");
  ok(toolNames.includes("generate_llms_txt"), "包含 generate_llms_txt");
  ok(toolNames.includes("compare_with_openseo"), "包含 compare_with_openseo");
  ok(toolNames.includes("diagnose_page"), "★ 新增包含 diagnose_page");
  ok(toolNames.includes("apply_fixes"), "★ 新增包含 apply_fixes");
  ok(toolNames.includes("diff_observations"), "★ 新增包含 diff_observations");
  ok(toolNames.includes("query_history"), "★ 新增包含 query_history");

  console.log("\n── 2 diagnose_page：离线诊断与机器可读契约 ──");
  const sampleHtml = `<!doctype html>
<html>
<head>
  <title>测试页面</title>
</head>
<body>
  <h1>主标题</h1>
  <img src="/logo.png">
</body>
</html>`;

  const diagRes = await callMcpTool("diagnose_page", {
    html: sampleHtml,
    url: "https://example.com/test",
  });
  ok(!diagRes.result?.isError, "diagnose_page 执行成功且 isError 为 false");
  const diagData = diagRes.result?.structuredContent as {
    url: string;
    counts: { blocker: number; major: number; minor: number };
    diagnoses: { issueId: string; severity: string; suggestedFix?: string }[];
    exitCode: number;
  };
  ok(diagData.url === "https://example.com/test", "URL 正确回显", diagData.url);
  ok(diagData.counts.major > 0, "能检出 major 问题（缺少 description 或 alt）", diagData.counts);
  ok(
    diagData.diagnoses.some((d) => d.issueId === "desc/missing"),
    "诊断列表包含 desc/missing"
  );
  ok(
    diagData.diagnoses.some((d) => d.issueId === "canonical/missing" && d.suggestedFix === "canonical"),
    "诊断列表包含 canonical/missing 并给出 suggestedFix: canonical"
  );

  console.log("\n── 3 apply_fixes：安全自动修复与幂等性 ──");
  const fixRes = await callMcpTool("apply_fixes", {
    html: sampleHtml,
    url: "https://example.com/test",
  });
  ok(!fixRes.result?.isError, "apply_fixes 执行成功");
  const fixData = fixRes.result?.structuredContent as {
    changed: boolean;
    fixedCount: number;
    html: string;
    attempts: { fixId: string; changed: boolean }[];
  };
  ok(fixData.changed === true, "HTML 成功修补", fixData.fixedCount);
  ok(fixData.html.includes('rel="canonical"'), "已修补 canonical 标签");
  ok(fixData.html.includes('name="viewport"'), "已修补 viewport 标签");
  ok(fixData.html.includes('lang="zh-CN"'), "已修补 lang 属性");
  ok(fixData.html.includes('alt=""'), "已修补装饰图片空 alt 属性");

  // 幂等性测试：再次对修复后的 HTML 运行修复，必须 no-op（不重复添加）
  const fixAgain = await callMcpTool("apply_fixes", {
    html: fixData.html,
    url: "https://example.com/test",
  });
  const fixAgainData = fixAgain.result?.structuredContent as { changed: boolean; fixedCount: number };
  ok(fixAgainData.changed === false, "★ 幂等性保证：再次修复 changed 为 false", fixAgainData.fixedCount);

  console.log("\n── 4 query_history：Store 观测历史查询 ──");
  const histRes = await callMcpTool("query_history", {
    type: "geo_score",
    limit: 10,
  });
  ok(!histRes.result?.isError, "query_history 执行成功");
  const histData = histRes.result?.structuredContent as {
    count: number;
    items: unknown[];
    hint?: string;
  };
  ok(typeof histData.count === "number", "返回 count 字段", histData.count);
  ok(Array.isArray(histData.items), "返回 items 数组");
  if (histData.count === 0) {
    ok(typeof histData.hint === "string", "无数据时附带清晰原因 hint（抓不到就说抓不到）");
  }

  console.log("\n── 5 diff_observations：时序对比与退化判定 ──");
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

  const diffRes = await callMcpTool("diff_observations", {
    prev: prevObs,
    curr: currObs,
  });
  ok(!diffRes.result?.isError, "diff_observations 执行成功");
  const diffData = diffRes.result?.structuredContent as {
    diff: {
      comparable: boolean;
      summary: { improved: number; degraded: number };
    };
  };
  ok(diffData.diff.comparable === true, "NOT_MENTIONED → MENTIONED 可比性为 true");
  ok(diffData.diff.summary.improved === 1, "准确判定为改善（improved=1）", diffData.diff.summary);

  console.log("\n── 6 异常与未知工具容错 ──");
  const unknownRes = await callMcpTool("non_existent_tool", {});
  ok(unknownRes.result?.isError === true, "未知工具返回 isError=true 且不崩溃");
  ok(
    Boolean(unknownRes.result?.content[0]?.text.includes("未知工具")),
    "错误信息准确说明未知工具"
  );

  const missingParamRes = await callMcpTool("apply_fixes", {});
  ok(missingParamRes.result?.isError === true, "缺少参数返回 isError=true");

  console.log("\n────────────────────────────────────────────────────");
  console.log(`通过 ${passCount} 项，失败 ${failCount} 项\n`);
  if (failCount > 0) process.exit(1);
}

void main();
