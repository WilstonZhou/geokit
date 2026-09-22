/**
 * 观测历史业务服务层 —— Phase 1 S7（只读时间维度 API）。
 *
 * ─────────────────────────────────────────────────────────────
 * 存在理由
 * ─────────────────────────────────────────────────────────────
 * 参数校验与「怎么读历史」原先无处可去。若写在 route 里，将来 MCP 也要
 * 读历史，就会出现两处各自解析一份参数 —— 那是口径漂移的温床。
 * 与 services/serp / services/visibility 同源：route 只做序列化。
 *
 * ─────────────────────────────────────────────────────────────
 * 只读
 * ─────────────────────────────────────────────────────────────
 * 本文件**不产出任何 Observation**，也不触发任何采集。
 * 它只回答「已经记下了什么」。想产生新数据请走 /api/audit、/api/serp、
 * /api/visibility —— 那三条路径才是采集入口。
 *
 * ─────────────────────────────────────────────────────────────
 * 空结果必须说清为什么
 * ─────────────────────────────────────────────────────────────
 * Observation 默认**不写入**（`GEOKIT_EVIDENCE` 总闸默认 off）。
 * 所以「查不到」最常见的含义是「从来没有记过」，而不是「记过但没匹配上」。
 * 返回空数组却不说明这一点，会让调用方误以为历史丢了 —— 因此空结果
 * 一律附 `hint`。抓不到就说是抓不到，这是本项目的底线。
 */
import type { URLSearchParams } from "node:url";

import { createStore, type Store } from "../store";
import type { ObservationQuery } from "../store/types";
import type { Observation, ObservationKind, ObservationStatus } from "../evidence/types";
import { evidenceEnabled } from "../evidence/store";
import { diffLatest, type DiffQuery, type ObservationDiff } from "../diff";

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** 契约允许的全部 type。校验用 —— 拼错的类型应当报 400，而不是静默返回空 */
export const OBSERVATION_KINDS: readonly ObservationKind[] = [
  "rank",
  "geo_score",
  "ai_mention",
  "robots_policy",
  "llms_txt",
];

/** 契约允许的全部 status。同上 */
export const OBSERVATION_STATUSES: readonly ObservationStatus[] = [
  "OBSERVED",
  "PARTIAL",
  "INDETERMINATE",
  "MENTIONED",
  "NOT_MENTIONED",
  "BLOCKED",
  "ERROR",
  "UNOBSERVABLE",
];

export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 500;

/* ------------------------------------------------------------------ */
/* 返回结构                                                            */
/* ------------------------------------------------------------------ */

export type ServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

export interface HistoryResponse {
  /** 归一化后的查询条件（回显，便于调用方确认自己到底查了什么） */
  query: Record<string, unknown>;
  /** 命中条数。**经过 limit 截断后的长度**，不是库内总量 */
  count: number;
  items: Observation[];
  /** 仅当 count === 0 时给出 —— 说明「为什么是空的」 */
  hint?: string;
}

export interface DiffResponse {
  query: Record<string, unknown>;
  diff: ObservationDiff;
}

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

function str(sp: URLSearchParams, key: string): string | undefined {
  const v = sp.get(key);
  if (v === null) return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function bool(sp: URLSearchParams, key: string): boolean | undefined {
  const v = str(sp, key);
  if (v === undefined) return undefined;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

/** 时间参数。必须是可解析的时间字符串 —— 否则范围查询会静默失效 */
function timeParam(sp: URLSearchParams, key: string): string | undefined {
  const v = str(sp, key);
  if (v === undefined) return undefined;
  return Number.isNaN(Date.parse(v)) ? undefined : v;
}

function bad(error: string): { ok: false; status: number; error: string } {
  return { ok: false, status: 400, error };
}

/**
 * 解析历史查询参数。
 *
 * ★ 失败一律 400 且**说清哪个参数不对** —— 静默忽略非法参数会让调用方
 *   拿着一份「看起来查过了但其实是空的」结果去做决策。
 */
export function parseHistoryQuery(
  sp: URLSearchParams
): ServiceResult<ObservationQuery> {
  const q: ObservationQuery = {};

  const type = str(sp, "type");
  if (type !== undefined) {
    if (!OBSERVATION_KINDS.includes(type as ObservationKind)) {
      return bad(`type 非法：${type}（可选：${OBSERVATION_KINDS.join(" / ")}）`);
    }
    q.type = type;
  }

  const status = str(sp, "status");
  if (status !== undefined) {
    if (!OBSERVATION_STATUSES.includes(status as ObservationStatus)) {
      return bad(`status 非法：${status}（可选：${OBSERVATION_STATUSES.join(" / ")}）`);
    }
    q.status = status;
  }

  const subject = str(sp, "subject");
  if (subject !== undefined) q.subject = subject;
  const source = str(sp, "source");
  if (source !== undefined) q.source = source;
  const runId = str(sp, "runId");
  if (runId !== undefined) q.runId = runId;

  const from = timeParam(sp, "from");
  const to = timeParam(sp, "to");
  if (str(sp, "from") !== undefined && from === undefined) return bad("from 不是可解析的时间");
  if (str(sp, "to") !== undefined && to === undefined) return bad("to 不是可解析的时间");
  if (from !== undefined) q.from = from;
  if (to !== undefined) q.to = to;

  const order = str(sp, "order");
  if (order !== undefined) {
    if (order !== "asc" && order !== "desc") return bad("order 只能是 asc 或 desc");
    q.order = order;
  }

  const limitRaw = str(sp, "limit");
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_HISTORY_LIMIT) {
      return bad(`limit 必须是 1..${MAX_HISTORY_LIMIT} 的整数`);
    }
    q.limit = n;
  }

  const latest = bool(sp, "latest");
  if (latest !== undefined) q.latestOnly = latest;

  return { ok: true, data: q };
}

/** 解析 diff 查询参数。subject 与 type 是定位一条时间线的必要条件 */
export function parseDiffQuery(sp: URLSearchParams): ServiceResult<DiffQuery> {
  const subject = str(sp, "subject");
  if (subject === undefined) return bad("缺少 subject —— diff 需要它定位时间线");

  const type = str(sp, "type");
  if (type === undefined) return bad("缺少 type —— diff 需要它定位时间线");
  if (!OBSERVATION_KINDS.includes(type as ObservationKind)) {
    return bad(`type 非法：${type}（可选：${OBSERVATION_KINDS.join(" / ")}）`);
  }

  const raw = str(sp, "to");
  let to: string | undefined;
  if (raw !== undefined) {
    if (Number.isNaN(Date.parse(raw))) return bad("to 不是可解析的时间");
    to = raw;
  }

  return {
    ok: true,
    data: { subject, type: type as ObservationKind, source: str(sp, "source"), to },
  };
}

/* ------------------------------------------------------------------ */
/* 读操作                                                              */
/* ------------------------------------------------------------------ */

function echo(q: ObservationQuery): Record<string, unknown> {
  return { ...q };
}

/**
 * 观测历史查询。
 *
 * `latest=1` 时每个 identity（type+subject+source）只留最新一条 ——
 * 那是「当前状态」查询，不是时间序列；做趋势图不要开。
 */
export async function listObservationHistory(
  sp: URLSearchParams,
  store: Store = createStore()
): Promise<ServiceResult<HistoryResponse>> {
  const parsed = parseHistoryQuery(sp);
  if (!parsed.ok) return parsed;

  const items = await store.listObservations({
    limit: DEFAULT_HISTORY_LIMIT,
    order: "desc",
    ...parsed.data,
  });

  const res: HistoryResponse = {
    query: echo({ limit: DEFAULT_HISTORY_LIMIT, order: "desc", ...parsed.data }),
    count: items.length,
    items,
  };

  if (items.length === 0) {
    res.hint = evidenceEnabled()
      ? "没有匹配的 Observation：该时间线下还没有记录，或过滤条件过窄"
      : "存证总闸当前关闭（GEOKIT_EVIDENCE=on 才会写入 Observation）—— 空结果是「还没记过」，不是查询失败";
  }

  return { ok: true, data: res };
}

/**
 * 最近两条观测的差异（读侧，直接复用 S6 的 diff 引擎）。
 *
 * 本函数**不判定**结果好坏 —— 那由 diff 的可比性规则决定；
 * 这里只负责把参数翻译成一次查询。
 */
export async function latestObservationDiff(
  sp: URLSearchParams,
  store: Store = createStore()
): Promise<ServiceResult<DiffResponse>> {
  const parsed = parseDiffQuery(sp);
  if (!parsed.ok) return parsed;

  const diff = await diffLatest(store, parsed.data);
  return { ok: true, data: { query: echo({ ...parsed.data }), diff } };
}
