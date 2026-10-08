/**
 * GSC Observer（T5）—— 把 Search Analytics 查询结果落成 kind="gsc" 的 Observation。
 *
 * 与其他 Observer 一致：只映射，不采集。GSC 通道不落 RawEvidence
 * （API 响应可达上万行，且请求带 Bearer 凭证），因此：
 *   - evidenceRefs 留空，可追溯元数据放进 result / extractedEvidence：
 *     站点资源、日期范围、维度、行数、四项聚合、top rows；
 *   - 凭证（token / 私钥）绝不进入 Observation；
 *   - 全量明细由 API/页面即时获取，历史层只存「结论粒度」的汇总与 Top 行，
 *     这与 ai.ts 刻意剥掉 rawResponse 的取舍同源。
 */
import type { Store } from "../store";
import type { Observation, ObservationStatus } from "../evidence/types";
import { OBSERVATION_CONTRACT_VERSION, confidenceFor } from "../evidence/types";
import { assertValidObservation } from "../evidence/schema";
import type { GscQueryResult, GscRow, GscStatus } from "./types";

export const GSC_OBSERVER_VERSION = "gsc-observer@0.1.0";
export const GSC_PARSER_VERSION = "gsc-searchanalytics@0.1.0";
/** 落库的 Top 行数（按展示量排序），控制单条 Observation 体积 */
export const GSC_TOP_ROWS_TO_STORE = 100;

const GSC_SOURCE = "https://searchconsole.googleapis.com";

/** 小写四态 → S1 大写状态 */
function toObservationStatus(status: GscStatus): ObservationStatus {
  switch (status) {
    case "ok":
      return "OBSERVED"; // 空 rows 也是真实结论（该区间无数据）
    case "blocked":
      return "BLOCKED";
    case "unavailable":
      return "UNOBSERVABLE";
    case "error":
      return "ERROR";
  }
}

export interface GscTotals {
  clicks: number;
  impressions: number;
  avgCtr: number;
  /** 按展示量加权的平均位置 */
  avgPosition: number;
}

export interface GscObservationResult {
  siteUrl: string;
  startDate?: string;
  endDate?: string;
  dimensions?: string[];
  rowCount: number;
  totals: GscTotals;
  topRows: GscRow[];
}

function summarize(rows: GscRow[]): GscTotals {
  let clicks = 0;
  let impressions = 0;
  let posWeighted = 0;
  for (const r of rows) {
    clicks += r.clicks;
    impressions += r.impressions;
    posWeighted += r.position * r.impressions;
  }
  return {
    clicks,
    impressions,
    avgCtr: impressions > 0 ? clicks / impressions : 0,
    avgPosition: impressions > 0 ? posWeighted / impressions : 0,
  };
}

function buildResult(qr: GscQueryResult): GscObservationResult {
  const topRows = [...qr.rows]
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, GSC_TOP_ROWS_TO_STORE);
  return {
    siteUrl: qr.siteUrl ?? "",
    startDate: qr.startDate,
    endDate: qr.endDate,
    dimensions: qr.dimensions,
    rowCount: qr.rowCount ?? qr.rows.length,
    totals: summarize(qr.rows),
    topRows,
  };
}

/** 纯映射：GscQueryResult → Observation（不落库、不做 IO） */
export function buildGscObservation(qr: GscQueryResult, now: Date = new Date()): Observation {
  const usable = qr.status === "ok";
  const status = toObservationStatus(qr.status);
  const result = buildResult(qr);

  const observation: Observation = {
    id: "",
    contractVersion: OBSERVATION_CONTRACT_VERSION,
    type: "gsc",
    subject: `gsc:${qr.siteUrl ?? "unknown"}`,
    source: GSC_SOURCE,
    observedAt: now.toISOString(),
    observerVersion: GSC_OBSERVER_VERSION,
    parserVersion: GSC_PARSER_VERSION,
    // GSC 无 RawEvidence 落盘（见文件头），可追溯信息在 result/extractedEvidence
    evidenceRefs: [],
    status,
    statusReason: qr.statusReason,
    result,
    extractedEvidence: [
      { signal: "gsc.siteUrl", value: result.siteUrl, source: GSC_SOURCE },
      { signal: "gsc.dateRange", value: `${result.startDate ?? ""}~${result.endDate ?? ""}`, source: GSC_SOURCE },
      { signal: "gsc.rowCount", value: result.rowCount, source: GSC_SOURCE },
      { signal: "gsc.impressions", value: result.totals.impressions, source: GSC_SOURCE },
      { signal: "gsc.clicks", value: result.totals.clicks, source: GSC_SOURCE },
      { signal: "gsc.avgPosition", value: Number(result.totals.avgPosition.toFixed(2)), source: GSC_SOURCE },
    ],
    confidence: confidenceFor(usable ? 1 : 0, 1),
    coverage: {
      expected: 1,
      observed: usable ? 1 : 0,
      ratio: usable ? 1 : 0,
      missing: usable ? undefined : [result.siteUrl],
    },
    metadata: {
      extra: {
        dimensions: result.dimensions?.join(",") ?? "",
        httpStatus: qr.httpStatus ?? 0,
        note: "数据来自 Google Search Console Search Analytics API；凭证不入库",
      },
    },
    caveat:
      "GSC 指标为 Google 采样后的报告值（非逐次真实点击日志），位置为该区间均值，应作趋势参考。",
  };

  assertValidObservation(observation);
  return observation;
}

/** 落库（受调用方的 GEOKIT_EVIDENCE 总闸控制） */
export async function recordGscObservation(
  store: Store,
  qr: GscQueryResult
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  try {
    const observation = buildGscObservation(qr);
    const saved = await store.saveObservation(observation);
    return { ok: true, id: saved.id };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
