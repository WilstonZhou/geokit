/**
 * Diagnosis 层入口（Phase 2 · S2-1）。
 *
 * 链路位置：
 *
 *   analyze()  ──▶  checks[]  ──▶  diagnose()  ──▶  Diagnosis[]
 *                                                      │
 *                                      有 suggestedFix ─┴─▶ FIX_RULES（Auto Fix 的闸门）
 *
 * ★ 这一层是**只读**的：它不抓取、不改写 audit、不落盘。
 *   同一份 PageAudit 调两次必须得到完全相同的 Diagnosis[] ——
 *   CI 会反复触发，幂等不是优化，是前提。
 */
import type { PageAudit } from "../audit";

import { FIX_RULES, findFixRule, mapCheck, severityOf } from "./rules";
import type { DiagnoseInput, Diagnosis, FixContext, FixRule } from "./types";

export type { Diagnosis, FixContext, FixRule, Severity } from "./types";
export { FIX_RULES, severityOf } from "./rules";

/**
 * 把一次页面审计翻译成诊断列表。
 *
 * 只处理 fail / warn —— pass 不是问题，出诊断只会稀释真正要看的东西。
 */
export function diagnose(input: DiagnoseInput): Diagnosis[] {
  const { audit } = input;
  const targetUrl = audit.finalUrl ?? audit.url;
  const evidenceId = input.evidenceId ?? audit.evidenceId;

  const out: Diagnosis[] = [];
  for (const check of audit.checks) {
    const mapped = mapCheck(check);
    if (!mapped) continue;

    out.push({
      issueId: mapped.issueId,
      checkId: check.id,
      targetUrl,
      severity: severityOf(check),
      detail: check.detail,
      // undefined 时不写字段 —— 让「有没有证据」保持可见
      ...(evidenceId ? { evidenceId } : {}),
      ...(mapped.fixId ? { suggestedFix: mapped.fixId } : { manualFix: check.fix }),
    });
  }
  return out;
}

/** 从 PageAudit 直接诊断（最常用的一跳） */
export function diagnoseAudit(
  audit: PageAudit,
  opts: { evidenceId?: string } = {}
): Diagnosis[] {
  return diagnose({ audit, ...(opts.evidenceId ? { evidenceId: opts.evidenceId } : {}) });
}

/** 构造 patch 上下文 —— 值全部取自 audit 已算出的结果 */
export function buildFixContext(audit: {
  url?: string;
  finalUrl?: string;
  title?: string | null;
  metaDescription?: string | null;
  canonical?: string | null;
  lang?: string | null;
  ogTags?: Record<string, string>;
}): FixContext {
  return {
    url: audit.finalUrl ?? audit.url ?? "",
    title: audit.title ?? null,
    description: audit.metaDescription ?? null,
    canonical: audit.canonical ?? null,
    lang: audit.lang ?? null,
    ogTags: audit.ogTags ?? {},
  };
}

/** 只有带 suggestedFix 的才允许自动修 —— 闸门就这一处 */
export function autoFixable(diagnoses: Diagnosis[]): Diagnosis[] {
  return diagnoses.filter((d) => typeof d.suggestedFix === "string");
}

export interface FixAttempt {
  fixId: string;
  /** 是否真的改了。false = 无需修改（已存在 / 不适用），不是失败 */
  changed: boolean;
  html: string;
  /** false 时说明为什么没改 —— 必须能解释，否则等于静默跳过 */
  reason?: string;
}

/**
 * 应用一条修复规则。
 *
 * 幂等保证：`applies()` 为 false 时直接返回原串；
 * patch 完之后再跑一次 applies 必须为 false（测试有覆盖）。
 */
export function applyFix(html: string, fixId: string, ctx: FixContext): FixAttempt {
  const rule = findFixRule(fixId);
  if (!rule) {
    return { fixId, changed: false, html, reason: `规则库中不存在 fixId=${fixId}` };
  }
  if (!rule.applies(html, ctx)) {
    return { fixId, changed: false, html, reason: "目标已存在或不适用（不覆盖）" };
  }
  const patched = rule.patch(html, ctx);
  if (patched === null) {
    return { fixId, changed: false, html, reason: "无法安全定位插入点，放弃修改" };
  }
  return { fixId, changed: true, html: patched };
}

/**
 * 按诊断列表逐条应用可自动修的规则。
 *
 * 顺序执行、前一条的输出是后一条的输入 —— 保证「一次跑完再跑一次 = no-op」。
 */
export function applyFixes(
  html: string,
  diagnoses: Diagnosis[],
  ctx: FixContext
): { html: string; attempts: FixAttempt[] } {
  let current = html;
  const attempts: FixAttempt[] = [];

  for (const d of autoFixable(diagnoses)) {
    const fixId = d.suggestedFix!;
    const r = applyFix(current, fixId, ctx);
    attempts.push(r);
    if (r.changed) current = r.html;
  }

  return { html: current, attempts };
}
