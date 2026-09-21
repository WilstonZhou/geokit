/**
 * Evidence 与 Observation 契约。
 *
 * ─────────────────────────────────────────────────────────────
 * 职责边界（Phase 0 硬性约束）
 * ─────────────────────────────────────────────────────────────
 *   Fetcher   采集。吐出 FetchResult，不落盘。
 *   Evidence  保存。把 FetchResult 落成 RawEvidence，**不主动采集**。
 *   Observer  生产。从 RawEvidence 产出 Observation，**不改 RawEvidence**。
 *
 *   Fetcher ≠ Evidence ≠ Observer。三者不得互相吞并。
 *
 * ─────────────────────────────────────────────────────────────
 * 不可变约定
 * ─────────────────────────────────────────────────────────────
 *   RawEvidence  一次采集的事实。写入后永不修改、不删除。
 *                它是可以被重放的原始素材。
 *   Observation  派生的结论。允许在未来用新 parser / 新规则，
 *                基于同一批 RawEvidence 重新算一遍，得到新口径的历史。
 *
 *   正因为如此，二者必须分开 —— 合在一起就永远失去了重算能力。
 */

import type { FetchPurpose } from "../fetcher";

export const EVIDENCE_CONTRACT_VERSION = "0.1.0";

/**
 * 证据种类：**只能是原始素材**，不能混入任何结论。
 */
export type RawEvidenceKind =
  | "serp_html"
  | "page_html"
  | "robots_txt"
  | "llms_txt"
  | "llm_response"
  | "redirect_resolve";

/**
 * 不可变原始证据。
 *
 * 注意：这里没有任何「结论」字段。
 * 诸如「排第几」「提及了没有」这类判断一律属于 Observation。
 */
export interface RawEvidence {
  /** 证据唯一 id，写入时生成，永不变动 */
  id: string;
  /** 契约版本，用于将来平滑迁移 */
  contractVersion: string;
  kind: RawEvidenceKind;

  target: string;
  /** 已脱敏的最终请求 URL */
  requestUrl: string;

  request: {
    method: string;
    /** 脱敏后的请求头 */
    headers: Record<string, string>;
    /** 仅存摘要长度，不落原始 body（可能是含密钥的 API 调用体） */
    bodyByteLength: number;
  };

  response: {
    httpStatus: number;
    finalUrl: string;
    /** 脱敏后的响应头 */
    headers: Record<string, string>;
    bodyHash: string;
    byteLength: number;
    /** 是否留存了 body 本体 */
    bodyRetained: boolean;
    /** body 本体落盘位置；bodyRetained=false 时为 null */
    bodyRef: string | null;
  };

  timing: {
    requestedAt: string;
    elapsedMs: number;
    waitedMs: number;
    attempts: number;
  };

  /** 采集上下文：为什么抓、为谁抓 */
  context: {
    purpose: FetchPurpose;
    /** 引擎标识：搜索引擎类观测记录这是哪个引擎的返回页 */
    engine?: string;
    note?: string;
    meta?: Record<string, string | number | boolean | undefined>;
  };

  /** 采集失败时依然落证据 —— 「抓不到」本身就是一个需要留存的事实 */
  error?: {
    kind: string;
    message: string;
  };

  createdAt: string;
}

/**
 * 观测结论。
 *
 * 与 RawEvidence 的关键区别：它带 confidence 与 caveat。
 * 任何结论都必须能说清「有多可信」以及「哪里不完整」——
 * 这是 GEOkit 「抓不到就说抓不到」原则在数据结构上的落点。
 */
export type ObservationKind =
  | "rank"
  | "geo_score"
  | "ai_mention"
  | "robots_policy"
  | "llms_txt";

export type Confidence = "high" | "medium" | "low" | "unavailable";

/**
 * AI 观测专属状态。
 *
 * 刻意不用布尔值：把「模型没提及」和「没能观测」混成一个 false，
 * 会污染所有下游判断。
 */
export type AiObservationStatus =
  | "MENTIONED"
  | "NOT_MENTIONED"
  | "BLOCKED"
  | "ERROR"
  | "UNOBSERVABLE";

export interface Observation<T = unknown> {
  id: string;
  contractVersion: string;
  kind: ObservationKind;

  target: string;
  observedAt: string;

  /** 结论取值。结构的稳定性由 parserVersion 保证 */
  value: T;

  /** ★ 每条结论都要能指回它的原始素材 */
  sourceEvidenceIds: string[];

  /** ★ 产生该结论的解析器版本。parser 升级后可据此区分口径 */
  parserVersion: string;

  /** 置信度。样本不完整时应为 low 而非 high */
  confidence: Confidence;

  /** 必须说明的保留意见。没有则省略 */
  caveat?: string;

  /** AI 观测的状态位；非 AI 类观测不使用 */
  status?: AiObservationStatus;

  /** 产出该结论的执行者标识，便于排查 */
  producedBy?: string;

  meta?: Record<string, string | number | boolean | undefined>;
}

/** 判定规则：什么时候该标 low —— 样本不完整时必须降级 */
export function confidenceFor(okCount: number, totalCount: number): Confidence {
  if (totalCount === 0 || okCount === 0) return "unavailable";
  const ratio = okCount / totalCount;
  if (ratio === 1) return "high";
  if (ratio >= 0.5) return "medium";
  return "low";
}
