/**
 * AI 观测状态计数 —— 六态的**唯一口径定义处**。
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么要把计数单独抽出来
 * ─────────────────────────────────────────────────────────────
 * Phase 0 的 `observedCount` 同时承担了两种语义：「拿到响应了」和
 * 「可以得出提及结论了」。在五态下这两者恰好相等，所以没人发现问题；
 * INDETERMINATE 一进来它们就分叉 —— 继续共用一个字段，命中率的分母
 * 就会随第六态的出现而悄悄改变含义。
 *
 * 现在把两者拆开，且**只在这里定义**。任何地方要算命中率，分母只能是
 * `determinableCount`。
 *
 * ─────────────────────────────────────────────────────────────
 * 六态语义
 * ─────────────────────────────────────────────────────────────
 *   MENTIONED       提到了，可判定
 *   NOT_MENTIONED   没提到，可判定
 *   INDETERMINATE   拿到响应但无法判定（拒答 / 答非所问）→ **不进分母**
 *   BLOCKED         被厂商拒绝（401/403/429…）—— 是厂商的态度
 *   ERROR           我们这边出错（网络/超时/解析失败）—— 是我们的故障
 *   UNOBSERVABLE    根本没有观测条件（未配 key）
 *
 * ★ BLOCKED 与 ERROR 必须分开：前者要换策略，后者要修代码。
 */
import type { AiObservationStatus } from "./types";

export const AI_OBSERVATION_STATES: readonly AiObservationStatus[] = [
  "MENTIONED",
  "NOT_MENTIONED",
  "INDETERMINATE",
  "BLOCKED",
  "ERROR",
  "UNOBSERVABLE",
];

/**
 * 一次 AI 可见性观测的计数快照。
 *
 * 命名刻意不复用 `observedCount` —— 那个字段留给旧 API 兼容，
 * 语义固定为 determinableCount。
 */
export interface AiStatusSummary {
  /** 参与的探针总数 */
  attemptedCount: number;
  /** 成功拿到可用响应的探针数 = MENTIONED + NOT_MENTIONED + INDETERMINATE */
  successfulCount: number;
  /** ★ 可判定探针数 = MENTIONED + NOT_MENTIONED。命中率的唯一合法分母 */
  determinableCount: number;
  /** 拿到响应但无法判定的探针数 */
  indeterminateCount: number;
  mentionedCount: number;
  notMentionedCount: number;
  /** 被厂商拒绝的探针数 —— 需要换策略 */
  blockedCount: number;
  /** 我方故障的探针数 —— 需要修代码 */
  errorCount: number;
  /** 无观测条件的探针数 —— 需要配 key */
  unobservableCount: number;
}

const EMPTY: AiStatusSummary = {
  attemptedCount: 0,
  successfulCount: 0,
  determinableCount: 0,
  indeterminateCount: 0,
  mentionedCount: 0,
  notMentionedCount: 0,
  blockedCount: 0,
  errorCount: 0,
  unobservableCount: 0,
};

/**
 * 纯函数：从一组状态算出全部计数。
 *
 * 抽成纯函数的理由同 buildVisibilityReport —— 口径这种东西一旦焊死在
 * async 流程里就只能在真实调用九个模型之后才能验证。
 */
export function summarizeAiStatuses(
  statuses: readonly AiObservationStatus[]
): AiStatusSummary {
  const s: AiStatusSummary = { ...EMPTY };
  for (const st of statuses) {
    s.attemptedCount++;
    switch (st) {
      case "MENTIONED":
        s.mentionedCount++;
        s.successfulCount++;
        s.determinableCount++;
        break;
      case "NOT_MENTIONED":
        s.notMentionedCount++;
        s.successfulCount++;
        s.determinableCount++;
        break;
      case "INDETERMINATE":
        s.indeterminateCount++;
        s.successfulCount++;
        // ★ 刻意不进 determinableCount —— 无法判定的样本不能稀释命中率
        break;
      case "BLOCKED":
        s.blockedCount++;
        break;
      case "ERROR":
        s.errorCount++;
        break;
      case "UNOBSERVABLE":
        s.unobservableCount++;
        break;
    }
  }
  return s;
}

/**
 * 命中率。分母恒为 determinableCount。
 *
 * determinableCount = 0 时返回 0 而不是 NaN —— 「一个都没观测到」必须
 * 表达成 0 分，而不是一个会让下游图表崩掉的 NaN。
 */
export function visibilityScoreOf(summary: AiStatusSummary): number {
  if (summary.determinableCount === 0) return 0;
  return Math.round((summary.mentionedCount / summary.determinableCount) * 100);
}
