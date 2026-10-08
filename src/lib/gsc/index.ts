/**
 * GSC 能力编排（T5）：查询 Search Analytics →（总闸开启时）落 Observation → 机会分析。
 *
 * 未配置凭证 / 无权限 / 限流都返回带 statusReason 的显式状态，绝不编造数据；
 * 落库失败只记日志，不影响查询与分析结果返回（与其他通道一致）。
 */
import { evidenceEnabled } from "../evidence/store";
import { createStore } from "../store";
import type { Store } from "../store/types";

import { querySearchAnalytics } from "./client";
import { analyzeSearchOpportunities, type OpportunityAnalysis } from "./analyze";
import { recordGscObservation } from "./observe";
import type { GscHttp } from "./auth";
import type { TokenProvider } from "./auth";
import type { GscQueryParams, GscQueryResult } from "./types";

export interface GscDeps {
  http?: GscHttp;
  tokenProvider?: TokenProvider;
  /** 注入存档（测试用内存 store）；默认按环境变量创建 */
  store?: Store;
}

async function maybeRecord(qr: GscQueryResult, store?: Store): Promise<void> {
  if (!evidenceEnabled()) return;
  try {
    const r = await recordGscObservation(store ?? createStore(), qr);
    if (!r.ok) console.error("[geokit] GSC Observation 落库失败：", r.reason);
  } catch (e) {
    console.error(
      "[geokit] GSC Observation 落库异常：",
      e instanceof Error ? e.message : e
    );
  }
}

/** 拉取 Search Analytics，并在存证总闸开启时落一条 gsc Observation */
export async function getSearchPerformance(
  params: GscQueryParams,
  deps: GscDeps = {}
): Promise<GscQueryResult> {
  const qr = await querySearchAnalytics(params, {
    http: deps.http,
    tokenProvider: deps.tokenProvider,
  });
  await maybeRecord(qr, deps.store);
  return qr;
}

export interface SearchOpportunityResult extends GscQueryResult {
  analysis?: OpportunityAnalysis;
}

/** 拉取并做机会分析；可选 crawledUrls 用于内容缺口交叉 */
export async function analyzeSearchPerformance(
  params: GscQueryParams,
  opts: { crawledUrls?: string[] } & GscDeps = {}
): Promise<SearchOpportunityResult> {
  const qr = await getSearchPerformance(params, opts);
  if (qr.status !== "ok") return qr;
  return {
    ...qr,
    analysis: analyzeSearchOpportunities(qr.rows, {
      crawledUrls: opts.crawledUrls,
    }),
  };
}

export { querySearchAnalytics } from "./client";
export {
  analyzeSearchOpportunities,
  diffPeriods,
  findHighImpressionLowCtr,
  findRankingOpportunities,
  findContentGaps,
  HIGH_IMPRESSION_MIN,
  LOW_CTR_THRESHOLD,
  RANKING_POSITION_MIN,
  RANKING_POSITION_MAX,
} from "./analyze";
export { buildGscObservation, recordGscObservation } from "./observe";
export { loadGscCredential, createTokenProvider, buildServiceAccountJwt } from "./auth";
export type {
  GscQueryParams,
  GscQueryResult,
  GscRow,
  GscDimension,
  GscStatus,
  GscOpportunity,
  OpportunityKind,
  PeriodDiff,
  PeriodDiffEntry,
  GscCredential,
} from "./types";
