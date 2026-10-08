/**
 * 鲸析 GEOkit — CrUX 指标分析与评估（T11）
 *
 * 纯函数层：把 CruxRawObservation 的原始 record 解析为 MetricEvaluation[]，
 * 并给出整体评级（任一指标为 poor 则整体为 SLOW）。
 *
 * 阈值来自官方文档：
 *   https://developers.google.com/speed/docs/insights/v5/about
 *   LCP ≤2500ms good / ≤4000ms ni / >4000ms poor
 *   INP ≤200ms good / ≤500ms ni / >500ms poor
 *   CLS ≤0.1 good / ≤0.25 ni / >0.25 poor
 *   FCP ≤1800ms good / ≤3000ms ni / >3000ms poor
 *   TTFB ≤800ms good / ≤1800ms ni / >1800ms poor
 */

import type { CruxRawObservation } from "./client";
import type {
  CruxMetricName,
  CruxObservation,
  MetricEvaluation,
} from "./types";
import { CWV_THRESHOLDS } from "./types";

/** 从 histogram 计算三段占比 */
function calcDensities(histogram: { start: number; end?: number; density: number }[], thresholds: { good: number; ni: number }) {
  let good = 0;
  let ni = 0;
  let poor = 0;
  for (const bin of histogram) {
    const end = bin.end ?? Infinity;
    // 分箱可能跨越阈值（极少见，官方分箱即阈值），此处简化按 bin 中心分类
    const center = bin.end ? (bin.start + bin.end) / 2 : bin.start;
    if (end <= thresholds.good) {
      good += bin.density;
    } else if (bin.start >= thresholds.ni) {
      poor += bin.density;
    } else if (center < thresholds.ni) {
      ni += bin.density;
    } else {
      poor += bin.density;
    }
  }
  return { goodDensity: good, niDensity: ni, poorDensity: poor };
}

/** 单个指标评估 */
export function evaluateMetric(
  metric: CruxMetricName,
  data: { histogram: { start: number; end?: number; density: number }[]; percentiles: { p75: number | string } }
): MetricEvaluation {
  const thresholds = CWV_THRESHOLDS[metric];
  // CLS 的 p75 可能是字符串（如 "0.10"），需转换
  const p75 = typeof data.percentiles.p75 === "string" ? parseFloat(data.percentiles.p75) : data.percentiles.p75;

  let category: "good" | "needs-improvement" | "poor";
  if (p75 <= thresholds.good) {
    category = "good";
  } else if (p75 <= thresholds.ni) {
    category = "needs-improvement";
  } else {
    category = "poor";
  }

  const densities = calcDensities(data.histogram, thresholds);

  return {
    metric,
    p75,
    goodThreshold: thresholds.good,
    niThreshold: thresholds.ni,
    category,
    ...densities,
  };
}

/** 从原始观测解析出完整 CruxObservation */
export function analyzeCruxObservation(raw: CruxRawObservation): CruxObservation {
  const base: CruxObservation = {
    target: raw.target,
    scope: raw.scope,
    formFactor: raw.formFactor,
    observedAt: raw.observedAt,
    status: raw.status,
    statusReason: raw.statusReason,
    httpStatus: raw.httpStatus,
    collectionPeriod: raw.record?.collectionPeriod
      ? {
          firstDate: `${raw.record.collectionPeriod.firstDate.year}-${String(raw.record.collectionPeriod.firstDate.month).padStart(2, "0")}-${String(raw.record.collectionPeriod.firstDate.day).padStart(2, "0")}`,
          lastDate: `${raw.record.collectionPeriod.lastDate.year}-${String(raw.record.collectionPeriod.lastDate.month).padStart(2, "0")}-${String(raw.record.collectionPeriod.lastDate.day).padStart(2, "0")}`,
        }
      : undefined,
  };

  if (raw.status !== "ok" || !raw.record) {
    return base;
  }

  const metrics: MetricEvaluation[] = [];
  const recordMetrics = raw.record.metrics;

  for (const metricName of Object.keys(recordMetrics) as CruxMetricName[]) {
    const data = recordMetrics[metricName];
    if (!data) continue;
    metrics.push(evaluateMetric(metricName, data));
  }

  // 整体评级：任一指标为 poor → SLOW；任一 ni → AVERAGE；全 good → FAST
  let overallCategory: "FAST" | "AVERAGE" | "SLOW" | "NONE" = "NONE";
  if (metrics.length > 0) {
    if (metrics.some((m) => m.category === "poor")) {
      overallCategory = "SLOW";
    } else if (metrics.some((m) => m.category === "needs-improvement")) {
      overallCategory = "AVERAGE";
    } else {
      overallCategory = "FAST";
    }
  }

  return {
    ...base,
    metrics,
    overallCategory,
  };
}

/** 批量分析（把 batchQueryCruxRaw 的结果映射为 CruxObservation[]） */
export function analyzeCruxBatch(
  raws: CruxRawObservation[]
): CruxObservation[] {
  return raws.map(analyzeCruxObservation);
}
