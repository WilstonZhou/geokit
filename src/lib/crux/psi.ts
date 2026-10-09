/**
 * 鲸析 GEOkit — PageSpeed Insights (PSI) 实验室数据降级通道（Sprint 3 任务 3.2）
 *
 * 目标：在查询单页性能时，优先调用真实用户数据 CrUX API；
 * 若目标为中低流量页面导致 CrUX 响应 404/无数据，且环境中配置了 API Key，
 * 则平滑降级调用 Google PageSpeed Insights API (Lighthouse Lab Data) 作为保底基准。
 */

import { analyzeCruxObservation } from "./analyze";
import { queryCrux } from "./client";
import type {
  CruxClientOptions,
  CruxMetricName,
  CruxObservation,
  MetricEvaluation,
} from "./types";
import { CWV_THRESHOLDS } from "./types";

const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

function getPsiApiKey(options?: CruxClientOptions): string | undefined {
  return (
    options?.apiKey ??
    process.env.PAGESPEED_API_KEY ??
    process.env.CRUX_API_KEY
  );
}

/** 评估单个实验室指标 */
function evaluateLabMetric(
  metric: CruxMetricName,
  value: number
): MetricEvaluation {
  const t = CWV_THRESHOLDS[metric];
  let category: "good" | "needs-improvement" | "poor";
  if (value <= t.good) {
    category = "good";
  } else if (value <= t.ni) {
    category = "needs-improvement";
  } else {
    category = "poor";
  }

  return {
    metric,
    p75: Math.round(value * 100) / 100,
    goodThreshold: t.good,
    niThreshold: t.ni,
    category,
  };
}

/**
 * 直接调用 Google PageSpeed Insights API 获取 Lighthouse 实验室基准数据。
 *
 * @param url  目标页面 URL
 * @param options  包含 API key、超时与可注入 fetchFn
 * @returns 构造为 CruxObservation 格式的性能结果；若未配置 key 或调用失败则返回 null
 */
export async function queryPageSpeedInsights(
  url: string,
  options?: CruxClientOptions
): Promise<CruxObservation | null> {
  const apiKey = getPsiApiKey(options);
  if (!apiKey) return null;

  const fetchImpl = options?.fetchFn ?? fetch;
  const timeoutMs = options?.timeoutMs ?? 20_000;
  const formFactor = options?.formFactor ?? "PHONE";
  const strategy = formFactor === "DESKTOP" ? "desktop" : "mobile";

  const endpoint = `${PSI_ENDPOINT}?url=${encodeURIComponent(url)}&key=${encodeURIComponent(apiKey)}&strategy=${strategy}&category=performance`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetchImpl(endpoint, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as {
      lighthouseResult?: {
        audits?: Record<string, { numericValue?: number }>;
      };
    };

    const audits = data.lighthouseResult?.audits;
    if (!audits) return null;

    const metrics: MetricEvaluation[] = [];

    // 1. LCP (largest-contentful-paint)
    if (typeof audits["largest-contentful-paint"]?.numericValue === "number") {
      metrics.push(
        evaluateLabMetric(
          "largest_contentful_paint",
          audits["largest-contentful-paint"].numericValue
        )
      );
    }

    // 2. CLS (cumulative-layout-shift)
    if (typeof audits["cumulative-layout-shift"]?.numericValue === "number") {
      metrics.push(
        evaluateLabMetric(
          "cumulative_layout_shift",
          audits["cumulative-layout-shift"].numericValue
        )
      );
    }

    // 3. INP / TBT (interaction-to-next-paint 或 total-blocking-time 实验室近似)
    const inpVal =
      audits["interaction-to-next-paint"]?.numericValue ??
      audits["total-blocking-time"]?.numericValue;
    if (typeof inpVal === "number") {
      metrics.push(evaluateLabMetric("interaction_to_next_paint", inpVal));
    }

    // 4. FCP (first-contentful-paint)
    if (typeof audits["first-contentful-paint"]?.numericValue === "number") {
      metrics.push(
        evaluateLabMetric(
          "first_contentful_paint",
          audits["first-contentful-paint"].numericValue
        )
      );
    }

    // 5. TTFB (server-response-time)
    if (typeof audits["server-response-time"]?.numericValue === "number") {
      metrics.push(
        evaluateLabMetric(
          "experimental_time_to_first_byte",
          audits["server-response-time"].numericValue
        )
      );
    }

    if (metrics.length === 0) return null;

    const hasPoor = metrics.some((m) => m.category === "poor");
    const hasNi = metrics.some((m) => m.category === "needs-improvement");
    const overallCategory = hasPoor ? "SLOW" : hasNi ? "AVERAGE" : "FAST";

    const nowIso = new Date().toISOString();

    return {
      target: url,
      scope: "url",
      formFactor,
      observedAt: nowIso,
      status: "ok",
      httpStatus: res.status,
      collectionPeriod: {
        firstDate: "Lighthouse",
        lastDate: "LabData",
      },
      overallCategory,
      metrics,
      dataSource: "psi-lighthouse",
    };
  } catch {
    return null;
  }
}

/**
 * 带有 PSI 平滑降级机制的单页面综合性能观测入口。
 *
 * 流程：
 * 1. 优先调用现有的 CrUX API 查询真实用户数据 (Field Data)。
 * 2. 如果 CrUX 响应 404 / 无数据 (低流量页面)，且环境中存在 API Key，平滑降级调用 Google PSI API。
 * 3. 返回最终观测结果。
 */
export async function queryPerformanceWithFallback(
  url: string,
  options?: CruxClientOptions
): Promise<CruxObservation> {
  const rawCrux = await queryCrux(
    { url, formFactor: options?.formFactor },
    options
  );
  const cruxObs = analyzeCruxObservation(rawCrux);

  if (cruxObs.status === "ok") {
    return {
      ...cruxObs,
      dataSource: "crux",
    };
  }

  // 判定是否是「无 CrUX 数据」需要降级的情形
  const isNoData =
    cruxObs.status === "unavailable" &&
    (cruxObs.httpStatus === 404 ||
      Boolean(cruxObs.statusReason?.includes("无 CrUX 数据")) ||
      Boolean(cruxObs.statusReason?.includes("not found")));

  if (isNoData) {
    const psiObs = await queryPageSpeedInsights(url, options);
    if (psiObs) {
      return psiObs;
    }
  }

  return cruxObs;
}

