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
 *
 * ─────────────────────────────────────────────────────────────
 * 持久化语义（★ 契约，SQLite / Diff 阶段不得重新解释）
 * ─────────────────────────────────────────────────────────────
 *   Evidence
 *     immutable
 *     append-only
 *     duplicate write 不覆盖原 Evidence
 *
 *   Observation
 *     Evidence 的派生 materialized result
 *     支持同 identity + 同版本的幂等重算
 *     同 run + 同版本      → materialized replacement（保持原 id）
 *     不同 run 或不同版本  → 新历史记录（原记录保留，新记录 replaces 指向它）
 *
 *   两者不是同一套语义，不要互相类推：
 *   Evidence 的 append-only 说的是「事实只增不改」；
 *   Observation 的 replacement 说的是「同一条结论被重算」，
 *   它既不是 update，也没有删除任何历史 —— 替换只发生在
 *   「同一 run 的同一版本」这一个格子内，那个格子里本来就只有一条记录。
 */

import type { FetchPurpose } from "../fetcher";

/**
 * 当前契约版本。
 *
 * 0.1.0 = Phase 0 冻结版（只有 `target`，语义分裂）
 * 0.2.0 = Phase 1 S1：新增 subject / source / provenance / contentHash /
 *         bodyRef / metadata / runId。旧字段全部保留，因此是**加法**而非替换。
 *
 * 版本号的意义不是「新旧」，而是让读取方能判断该走哪条归一化路径。
 */
export const EVIDENCE_CONTRACT_VERSION = "0.2.0";

/** Phase 0 冻结时写下的版本。读到它就说明这条记录缺失 canonical 字段，需要归一化 */
export const LEGACY_EVIDENCE_CONTRACT_VERSION = "0.1.0";

/**
 * Observation 契约版本。
 *
 * 0.1.0 = Phase 0 冻结版（只有 `kind` / `target`，无身份、无版本链）
 * 0.2.0 = Phase 1 S1：新增 subject / source / runId / observerVersion /
 *         parserVersion / strategyVersion / evidenceRefs / status /
 *         confidence / coverage / metadata / caveat / replaces /
 *         identityKey / versionKey。
 *
 * ★ 不做 migration —— 本仓库当前**没有任何 Observation 生产记录**
 *   （S1 之前 Observation 没有生产构造点），没有旧数据需要迁移。
 *   0.1.0 仅作为历史版本号保留在注释里，不提供读取侧归一化路径。
 */
export const OBSERVATION_CONTRACT_VERSION = "0.2.0";

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

/* ------------------------------------------------------------------ */
/* Evidence（canonical 视图）                                           */
/* ------------------------------------------------------------------ */

/**
 * provenance —— 「这次采集是怎么发生的」。
 *
 * 单独抽出来的原因：它是**溯源**信息，不是结论。放在一起就会有人在
 * provenance 里顺手塞进「这次排名第几」，而那属于 Observation。
 */
export interface EvidenceProvenance {
  method: string;
  /** 已脱敏的请求 URL */
  requestUrl: string;
  /** 重定向后的最终 URL */
  finalUrl: string;
  /** HTTP 状态码；0 表示根本没有拿到响应 */
  httpStatus: number;
  /** 已脱敏的请求头（Authorization 等一律 [REDACTED]） */
  requestHeaders: Record<string, string>;
  /** 已脱敏的响应头 */
  responseHeaders: Record<string, string>;
  requestedAt: string;
  elapsedMs: number;
  /** 因 per-domain 限速而等待的时间 */
  waitedMs: number;
  /** 总尝试次数 */
  attempts: number;
  error?: { kind: string; message: string };
}

/**
 * Evidence metadata —— 描述性附加信息。
 *
 * 与 provenance 的分界：provenance 回答「怎么发生的」，
 * metadata 回答「这次采集属于什么业务场景」。
 */
export interface EvidenceMetadata {
  purpose: FetchPurpose;
  /** 搜索引擎 id（serp 类证据） */
  engine?: string;
  /** 解析策略版本 —— 三家引擎的特殊解析必须可追踪（见 identity.SERP_STRATEGY_VERSIONS） */
  strategyVersion?: string;
  /** AI：请求时指定的模型 */
  requestedModel?: string;
  /** AI：厂商实际路由到的模型（若采集时已知；通常在观测阶段回填） */
  servedModel?: string;
  /** 其余采集上下文 */
  extra: Record<string, string | number | boolean | undefined>;
}

/**
 * canonical Evidence。
 *
 * 与 `RawEvidence`（磁盘记录）的关系：
 *   RawEvidence = 落盘形态，新旧契约混存
 *   Evidence    = 归一化视图，**字段必定齐全**
 *
 * 读取方一律拿到 Evidence —— 这样 Phase 0 写下的旧文件无需改写即可被
 * 正确索引（缺失的 subject / source 由归一化层从旧字段推导）。
 *
 * ★ 依旧不可变：Store 层没有 update / delete，只有 append。
 */
export interface Evidence extends RawEvidence {
  /** 被观测对象（canonical） */
  subject: string;
  /** 观测来源（canonical） */
  source: string;
  /** 观测发生时间 = timing.requestedAt */
  observedAt: string;
  /** HTTP 状态码；0 = 无响应 */
  status: number;
  provenance: EvidenceProvenance;
  /** 响应体内容 hash。body 不留存时，它是内容唯一的指纹 */
  contentHash: string;
  /** body 落盘位置；未留存时为 null */
  bodyRef: string | null;
  metadata: EvidenceMetadata;
  /** 关联一次完整观测批次。无 runId 时不参与去重（见 Store 的幂等策略） */
  runId?: string;
  /** 写入时由 Store 计算并落盘，用于去重与索引重建 */
  dedupeKey?: string;
  /** 由旧契约归一化而来时记录来源版本，便于统计存量 */
  migratedFrom?: string;
}

/* ------------------------------------------------------------------ */
/* Observation                                                         */
/* ------------------------------------------------------------------ */

/**
 * 覆盖度。
 *
 * 「置信度」说的是结论可不可信，「覆盖度」说的是**有多少目标真的观测到了**。
 * 两者不能合并：九个模型只观测到一个时，那个结论本身可能很准（high），
 * 但覆盖度只有 1/9（low）—— 它不足以代表整体。
 */
export interface Coverage {
  /** 期望覆盖的目标数 */
  expected: number;
  /** 真正拿到可用证据的目标数 */
  observed: number;
  /** observed / expected，0..1；expected=0 时为 0 */
  ratio: number;
  /** 未覆盖到的目标标识，便于诊断而非猜测 */
  missing?: string[];
}

export interface ObservationMetadata {
  /** AI：请求模型 */
  requestedModel?: string;
  /** AI：厂商实际路由到的模型 */
  servedModel?: string;
  /** AI：servedModel ≠ requestedModel 时置 true —— 厂商改过路由，历史口径需留意 */
  modelDrift?: boolean;
  /** AI：prompt 版本。改 prompt 必须递增，否则跨时间的观测无从比较 */
  promptVersion?: string;
  /** 采样参数快照（temperature / maxTokens …） */
  sampling?: Record<string, string | number | boolean>;
  extra?: Record<string, string | number | boolean | undefined>;
}

/**
 * 观测结论。
 *
 * 与 RawEvidence 的关键区别：它带 confidence 与 coverage。
 * 任何结论都必须能说清「有多可信」以及「覆盖了多少」——
 * 这是 GEOkit 「抓不到就说抓不到」原则在数据结构上的落点。
 *
 * ★ 支持重算：只要 evidenceRefs 还在、parserVersion 明确，
 *   就能在不重新采集的前提下，用新规则把历史再算一遍。
 *
 * ★ 持久化语义（详见文件头）：它是 Evidence 的派生 materialized result ——
 *   同 run + 同版本 → materialized replacement（保持原 id）；
 *   不同 run 或不同版本 → 新历史记录。不因它的替换反推 Evidence 可改。
 */
export type ObservationKind =
  | "rank"
  | "geo_score"
  | "ai_mention"
  | "robots_policy"
  | "llms_txt";

export type Confidence = "high" | "medium" | "low" | "unavailable";

/**
 * AI 观测六态（Phase 1 S1 定为正式契约）。
 *
 * 刻意不用布尔值：把「模型没提及」和「没能观测」混成一个 false，
 * 会污染所有下游判断。
 *
 * ─────────────────────────────────────────────────────────────
 * 哪些状态才是「结论」
 * ─────────────────────────────────────────────────────────────
 * 只有 MENTIONED / NOT_MENTIONED 是 determinable —— 可以拿来算命中率。
 *
 * INDETERMINATE 是 S1 新增的第六态，覆盖「拿到了响应、也能解析，但内容
 * 不足以判定」的情形：模型拒答（"我无法推荐具体厂商"）、答非所问、只复述
 * 问题。此前这些会被 `includes(brand)` 判成 NOT_MENTIONED 并计入分母，
 * 等于把「厂商不肯说」记账成「厂商不知道」。
 *
 * ★ INDETERMINATE **不进入 visibilityScore 分母**。
 */
export type AiObservationStatus =
  | "MENTIONED"
  | "NOT_MENTIONED"
  | "INDETERMINATE"
  | "BLOCKED"
  | "ERROR"
  | "UNOBSERVABLE";

/** 可判定状态 —— 只有这两种能进命中率分子/分母 */
export const AI_DETERMINABLE_STATUSES: readonly AiObservationStatus[] = [
  "MENTIONED",
  "NOT_MENTIONED",
];

export function isAiDeterminable(s: AiObservationStatus): boolean {
  return s === "MENTIONED" || s === "NOT_MENTIONED";
}

/** 观测状态（通用层）。AI 观测使用其中的六态子集 */
export type ObservationStatus =
  | "OBSERVED"
  | "PARTIAL"
  | "INDETERMINATE"
  | "MENTIONED"
  | "NOT_MENTIONED"
  | "BLOCKED"
  | "ERROR"
  | "UNOBSERVABLE";

export interface Observation<T = unknown> {
  id: string;
  contractVersion: string;

  /** 结论类型。取代 Phase 0 的 `kind`，语义不变、字段名对齐 S1 契约 */
  type: ObservationKind;
  /** @deprecated 旧契约字段名，保留仅为兼容，新代码一律用 `type` */
  kind?: ObservationKind;

  /** 被观测对象（与 Evidence.subject 同一 canonical 空间） */
  subject: string;
  /** 观测来源（与 Evidence.source 同一 canonical 空间） */
  source: string;
  observedAt: string;
  /** 所属观测批次。是「重算」与「新一次观测」的判定依据 */
  runId?: string;

  /** 产出该结论的 Observer 版本 */
  observerVersion: string;
  /** ★ 产生该结论的解析器版本。parser 升级后可据此区分口径 */
  parserVersion: string;
  /** 解析策略版本（如三家引擎的链接提取策略） */
  strategyVersion?: string;

  /** ★ 每条结论都要能指回它的原始素材 */
  evidenceRefs: string[];

  status: ObservationStatus;

  /** 结论取值。结构的稳定性由 parserVersion 保证 */
  result: T;

  /** 置信度。样本不完整时应为 low 而非 high */
  confidence: Confidence;

  /** 覆盖度。与 confidence 互补，不可互相替代 */
  coverage: Coverage;

  metadata: ObservationMetadata;

  /** 必须说明的保留意见。没有则省略 */
  caveat?: string;

  /** 同一 (subject, source, type, 版本, runId) 内重算时，指向被替换的记录 */
  replaces?: string;

  /** 由 Store 计算的身份键，用于「取最新一条」 */
  identityKey?: string;
  /** 由 Store 计算的版本键（observer+parser+strategy） */
  versionKey?: string;
}

/** 判定规则：什么时候该标 low —— 样本不完整时必须降级 */
export function confidenceFor(okCount: number, totalCount: number): Confidence {
  if (totalCount === 0 || okCount === 0) return "unavailable";
  const ratio = okCount / totalCount;
  if (ratio === 1) return "high";
  if (ratio >= 0.5) return "medium";
  return "low";
}
