/**
 * Store 接口 —— Phase 1 S2。
 *
 * ─────────────────────────────────────────────────────────────
 * 刻意先定接口、不定 schema
 * ─────────────────────────────────────────────────────────────
 * 本阶段只实现 JsonlStore。接口用 async 签名是**有意为之**：
 * 将来换 SQLite / Postgres 时实现可以替换，调用方一行不用改。
 * 反过来如果现在定成同步，换实现那天就是全仓改动。
 *
 * ─────────────────────────────────────────────────────────────
 * Evidence 持久化语义（★ 契约）
 * ─────────────────────────────────────────────────────────────
 *   immutable
 *   append-only
 *   duplicate write 不覆盖原 Evidence（命中去重即返回已有 id）
 *
 *   接口里没有 update、没有 delete —— 这是刻意的，不是遗漏。
 *
 * ─────────────────────────────────────────────────────────────
 * Observation 持久化语义（★ 契约）
 * ─────────────────────────────────────────────────────────────
 *   是 Evidence 的派生 materialized result
 *   支持同 identity + 同版本的幂等重算
 *   同 run + 同版本     → materialized replacement，保持原 id
 *                        （同一条观测被重算，逻辑上仍是同一条记录）
 *   不同 run 或不同版本 → 新历史记录（原记录保留，新记录 replaces 指向它）
 *
 *   ★ 这不是 update，也没有删除历史：替换只发生在「同一 run + 同一版本」
 *     这一个格子内，那个格子里本来就只存在一条记录。
 *   ★ Observation 的替换不触及 Evidence —— Evidence 侧永远是 append-only。
 *
 * ─────────────────────────────────────────────────────────────
 * 读取
 * ─────────────────────────────────────────────────────────────
 *   读取返回深拷贝 —— 调用方改动返回值不会污染存储
 *
 * ─────────────────────────────────────────────────────────────
 * 查询维度
 * ─────────────────────────────────────────────────────────────
 *   subject  被观测对象（site: / search: / ai-slot:）
 *   source   观测来源（http: / search-engine: / provider:）
 *   runId    观测批次
 *   time     时间范围（observedAt）
 *
 * 这四个维度是全部查询需求的正交集 —— 其余组合都能由它们筛出来，
 * 所以不为「可能用到」再加维度。
 */
import type {
  Evidence,
  Observation,
  ObservationKind,
  ObservationStatus,
  RawEvidenceKind,
} from "../evidence/types";

/** 时间范围。ISO 字符串比较即可，无需 Date 解析 */
export interface TimeRange {
  /** 含下界 */
  from?: string;
  /** 含上界 */
  to?: string;
}

export interface ListOptions extends TimeRange {
  /** 返回条数上限。不传 = 全部 */
  limit?: number;
  /** 排序方向，默认 desc（最近在前） */
  order?: "asc" | "desc";
}

export interface EvidenceQuery extends ListOptions {
  subject?: string;
  source?: string;
  kind?: RawEvidenceKind | string;
  runId?: string;
  /** 仅返回留存了 body 的（可重放） */
  bodyRetained?: boolean;
}

export interface ObservationQuery extends ListOptions {
  type?: ObservationKind | string;
  subject?: string;
  source?: string;
  runId?: string;
  status?: ObservationStatus | string;
  /**
   * 每个 identity（type+subject+source）只保留最新一条。
   * 用于「当前状态」这类查询；时间序列查询不要开。
   */
  latestOnly?: boolean;
}

export interface SaveEvidenceOptions {
  /** 随证据一同落盘的 body 原文。仅在 Evidence.bodyRef 已分配时写入 */
  body?: string;
  /**
   * 显式幂等键。给了它就不走自动推导 —— 用于「内容可能相同但语义上
   * 必须分开存」的场景（例如同一 URL 的两个不同用途的采集）。
   */
  idempotencyKey?: string;
}

export interface SaveObservationOptions {
  idempotencyKey?: string;
}

export interface SaveResult {
  id: string;
  /** true = 真的写入了新记录；false = 命中去重 / 发生替换 */
  created: boolean;
  /** created=false 且因重复而跳过时，指向已存在的记录 id */
  duplicateOf?: string;
  /** created=false 且因重算而替换时，指向被替换的记录 id */
  replaced?: string;
}

export interface Store {
  /* ── Evidence ──────────────────────────────────────────── */
  saveEvidence(
    ev: Evidence,
    opts?: SaveEvidenceOptions
  ): Promise<SaveResult>;
  getEvidence(id: string): Promise<Evidence | null>;
  listEvidence(q?: EvidenceQuery): Promise<Evidence[]>;
  findEvidenceBySubject(subject: string, opts?: ListOptions): Promise<Evidence[]>;
  findEvidenceBySource(source: string, opts?: ListOptions): Promise<Evidence[]>;
  findEvidenceByRun(runId: string, opts?: ListOptions): Promise<Evidence[]>;
  findEvidenceByTimeRange(from: string, to: string, opts?: ListOptions): Promise<Evidence[]>;

  /* ── Observation ───────────────────────────────────────── */
  saveObservation(
    obs: Observation,
    opts?: SaveObservationOptions
  ): Promise<SaveResult>;
  getObservation(id: string): Promise<Observation | null>;
  listObservations(q?: ObservationQuery): Promise<Observation[]>;
  findObservationsBySubject(subject: string, opts?: Omit<ObservationQuery, "subject">): Promise<Observation[]>;
  findObservationsBySource(source: string, opts?: Omit<ObservationQuery, "source">): Promise<Observation[]>;
  findObservationsByRun(runId: string, opts?: Omit<ObservationQuery, "runId">): Promise<Observation[]>;
  findObservationsByTimeRange(
    from: string,
    to: string,
    opts?: Omit<ObservationQuery, "from" | "to">
  ): Promise<Observation[]>;
}
