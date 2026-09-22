/**
 * CLI 输出渲染（Phase 2 · S2-2）。
 *
 * 三种格式：
 *   json      机器读 —— 进 CI 产物、做 baseline、被别的工具解析
 *   markdown  人读 —— PR 评论、终端
 *   sarif     S2-3 才实现；这里**明确报错**，不静默退化成别的格式
 *
 * ★ 静默退化是最坏的错：调用方以为自己拿到了 SARIF，其实拿到的是 Markdown，
 *   然后在 GitHub Code Scanning 里看到一片空白，还查不出为什么。
 */
import type { CheckReport } from "./check";
import type { GateReport } from "./gate";
import type { DiffReport } from "./diff";

export type OutputFormat = "json" | "markdown";

export const OUTPUT_FORMATS: readonly OutputFormat[] = ["json", "markdown"];

export function parseFormat(raw: string | undefined): OutputFormat {
  const v = (raw ?? "markdown").toLowerCase();
  if (v === "sarif") {
    throw new Error("SARIF 输出在 S2-3 实现（geokit 当前版本尚未支持），请改用 --format=json|markdown");
  }
  if ((OUTPUT_FORMATS as readonly string[]).includes(v)) return v as OutputFormat;
  throw new Error(`未知输出格式 "${raw}"，可选：${OUTPUT_FORMATS.join(" | ")}`);
}

export function renderJson(v: unknown): string {
  return `${JSON.stringify(v, null, 2)}\n`;
}

/* ------------------------------------------------------------------ */
/* check                                                               */
/* ------------------------------------------------------------------ */

export function renderCheck(report: CheckReport, format: OutputFormat): string {
  if (format === "json") return renderJson(report);
  return renderCheckMarkdown(report);
}

function renderCheckMarkdown(r: CheckReport): string {
  const lines: string[] = [];
  lines.push(`# GEOkit 检查 · ${r.url}`);
  lines.push("");
  lines.push(`- 最终地址：${r.finalUrl ?? r.url}`);
  lines.push(`- HTTP：${r.httpStatus}`);
  lines.push(`- SEO ${r.seoScore} / GEO ${r.geoScore}`);
  lines.push(
    `- 问题：blocker ${r.counts.blocker} · major ${r.counts.major} · minor ${r.counts.minor}`
  );
  lines.push(`- 退出码：${r.exitCode}`);
  lines.push("");

  if (r.diagnoses.length === 0) {
    lines.push("没有问题项。");
  } else {
    lines.push("| 严重度 | issueId | 说明 | 自动修 |");
    lines.push("|---|---|---|---|");
    for (const d of r.diagnoses) {
      lines.push(
        `| ${d.severity} | \`${d.issueId}\` | ${escapeCell(d.detail)} | ${d.suggestedFix ? `\`${d.suggestedFix}\`` : "—"} |`
      );
    }
  }
  lines.push("");

  if (r.robots) {
    lines.push(`## robots.txt`);
    lines.push("");
    lines.push(`- ${r.robots.url}：${r.robots.exists ? "存在" : "缺失"}`);
    lines.push(`- AI 开放度：${r.robots.aiOpennessScore}`);
    lines.push(`- ${escapeCell(r.robots.summary)}`);
    lines.push("");
  }

  if (r.llms) {
    lines.push(`## llms.txt`);
    lines.push("");
    lines.push(`- ${r.llms.url}：${r.llms.exists ? `存在（${r.llms.bytes} 字节）` : "缺失"}`);
    lines.push(`- 评分：${r.llms.score}　待改进项：${r.llms.issueCount}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

/* ------------------------------------------------------------------ */
/* gate                                                                */
/* ------------------------------------------------------------------ */

export function renderGate(report: GateReport, format: OutputFormat): string {
  if (format === "json") return renderJson(report);
  return renderGateMarkdown(report);
}

function renderGateMarkdown(r: GateReport): string {
  const lines: string[] = [];
  lines.push(`# GEOkit 门禁 · ${r.decision.toUpperCase()}`);
  lines.push("");
  lines.push(`- 基线来源：${r.baseline.source}`);
  lines.push(`- 基线可用：${r.baseline.found ? "是" : "否"}`);
  if (r.deltas) {
    lines.push(
      `- 变化：SEO ${fmtNum(r.deltas.seoScore)} · GEO ${fmtNum(r.deltas.geoScore)}`
    );
    lines.push(
      `- 新增问题：blocker ${r.deltas.newBlocker} · major ${r.deltas.newMajor}`
    );
  }
  lines.push(`- 退出码：${r.exitCode}`);
  lines.push("");

  if (r.reasons.length > 0) {
    lines.push("## 判定依据");
    lines.push("");
    for (const reason of r.reasons) lines.push(`- ${reason}`);
  } else {
    lines.push("未触发任何门禁条件。");
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/* ------------------------------------------------------------------ */
/* diff                                                                */
/* ------------------------------------------------------------------ */

export function renderDiff(report: DiffReport, format: OutputFormat): string {
  if (format === "json") return renderJson(report);
  return renderDiffMarkdown(report);
}

function renderDiffMarkdown(r: DiffReport): string {
  const lines: string[] = [];
  const d = r.diff;
  lines.push(`# GEOkit 差异 · ${r.source}`);
  lines.push("");
  lines.push(`- 可比：${d.comparable ? "是" : `否（${d.incomparableReason ?? "未说明"}）`}`);
  lines.push(`- 时间：${d.previousObservedAt ?? "—"} → ${d.currentObservedAt ?? "—"}`);
  lines.push(
    `- 变化：${d.summary.improved} 改善 / ${d.summary.degraded} 退化 / ${d.summary.neutral} 持平 / ${d.summary.unknown} 不可判定`
  );
  lines.push("");

  if (!d.currentObservedAt) {
    // 「没有观测」≠「没有变化」—— 两者在 CI 里的含义天差地别
    lines.push(`没有可取到的观测（${d.incomparableReason ?? "missing_previous"}）—— 不是「没有变化」。`);
  } else if (d.changes.length === 0) {
    lines.push("无变化。");
  } else {
    lines.push("| 字段 | 方向 | 前 → 后 |");
    lines.push("|---|---|---|");
    for (const c of d.changes) {
      lines.push(
        `| \`${c.path}\` | ${c.direction} | ${JSON.stringify(c.previous)} → ${JSON.stringify(c.current)} |`
      );
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/* ------------------------------------------------------------------ */

function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return v > 0 ? `+${v}` : String(v);
}

function escapeCell(v: string): string {
  return v.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
