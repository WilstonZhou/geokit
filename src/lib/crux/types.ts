/**
 * 鲸析 GEOkit — CrUX / Web Vitals 类型定义（T11）
 *
 * 数据源：Chrome UX Report API (CrUX)
 *   POST https://chromeuxreport.googleapis.com/v1/records:queryRecord
 *
 * 官方文档：https://developer.chrome.com/docs/crux/api
 *
 * 设计原则：
 *   - 不调 LLM，不调 PSI（PSI 已声明将剥离内嵌 CrUX）
 *   - 无 API key / 未启用 CrUX API → status=unavailable，不返回估算值
 *   - 429 / 403 / 4xx → 如实返回 blocked/error，附 statusReason
 *   - 指标阈值来自官方文档（developers.google.com/speed/docs/insights/v5/about）
 */

/** CrUX 指标名（蛇形，官方字段名） */
export const CRUX_METRICS = [
  "largest_contentful_paint",
  "interaction_to_next_paint",
  "cumulative_layout_shift",
  "first_contentful_paint",
  "experimental_time_to_first_byte",
] as const;

export type CruxMetricName = (typeof CRUX_METRICS)[number];

/** formFactor 合法取值 */
export const CRUX_FORM_FACTORS = ["DESKTOP", "PHONE", "TABLET"] as const;
export type CruxFormFactor = (typeof CRUX_FORM_FACTORS)[number];

/** 直方图分箱（来自官方响应结构） */
export interface CruxHistogramBin {
  /** 起始值（含）。首个 bin 的 start 为 0 */
  start: number;
  /** 结束值（不含）。最后一个 bin 无 end */
  end?: number;
  /** 该区间占比（0-1） */
  density: number;
}

/** 单个指标的原始响应结构 */
export interface CruxMetricData {
  histogram: CruxHistogramBin[];
  percentiles: {
    p75: number | string;
  };
}

/** CrUX API 响应结构（官方文档确认） */
export interface CruxApiResponse {
  record?: {
    key: {
      url?: string;
      origin?: string;
      formFactor?: CruxFormFactor;
    };
    metrics: Partial<Record<CruxMetricName, CruxMetricData>>;
    collectionPeriod: {
      firstDate: { year: number; month: number; day: number };
      lastDate: { year: number; month: number; day: number };
    };
  };
  error?: {
    code: number;
    message: string;
    status: string;
  };
}

/** 观测状态（与 GSC 六态语义对齐） */
export type CruxStatus = "ok" | "unavailable" | "blocked" | "error";

/** 单指标评估结果（p75 与阈值对比） */
export interface MetricEvaluation {
  metric: CruxMetricName;
  /** p75 值（毫秒；CLS 为无量纲小数） */
  p75: number;
  /** good/ni/poor 阈值（来自官方文档） */
  goodThreshold: number;
  niThreshold: number;
  /** 分类：good / needs-improvement / poor */
  category: "good" | "needs-improvement" | "poor";
  /** good 占比（0-1，来自 histogram） */
  goodDensity?: number;
  /** needs-improvement 占比 */
  niDensity?: number;
  /** poor 占比 */
  poorDensity?: number;
}

/** 单 URL/Origin 的观测结果 */
export interface CruxObservation {
  /** 输入的 url 或 origin */
  target: string;
  /** 是 URL 级还是 Origin 级 */
  scope: "url" | "origin";
  formFactor?: CruxFormFactor;
  /** 观测时间 */
  observedAt: string;
  /** API 返回的数据收集区间 */
  collectionPeriod?: {
    firstDate: string;
    lastDate: string;
  };
  status: CruxStatus;
  statusReason?: string;
  /** HTTP 状态码（API 调用结果） */
  httpStatus?: number;
  /** 各指标评估（仅 status=ok 时有值） */
  metrics?: MetricEvaluation[];
  /** 整体评级（任一指标为 poor 则 poor） */
  overallCategory?: "FAST" | "AVERAGE" | "SLOW" | "NONE";
  /** 数据来源：CrUX 真实用户数据或 PageSpeed Insights Lighthouse 实验室数据 */
  dataSource?: "crux" | "psi-lighthouse";
}

/** 批量观测输入 */
export interface BatchCheckInput {
  /** 页面 URL 列表 */
  urls?: string[];
  /** 源站 origin 列表 */
  origins?: string[];
  formFactor?: CruxFormFactor;
  /** 并发上限（默认 2，遵守官方 150 QPM 限制） */
  concurrency?: number;
  /** 同 host 最小间隔 ms（默认 500） */
  minIntervalMs?: number;
}

/** 客户端选项（含测试注入） */
export interface CruxClientOptions {
  apiKey?: string;
  formFactor?: CruxFormFactor;
  /** 请求超时（默认 15s） */
  timeoutMs?: number;
  /** 自定义 fetch（测试注入用） */
  fetchFn?: typeof fetch;
  /** 同 host 最小请求间隔 ms（默认 500） */
  minIntervalMs?: number;
}

/** 批量观测输出 */
export interface BatchCheckResult {
  total: number;
  ok: number;
  unavailable: number;
  blocked: number;
  error: number;
  observations: CruxObservation[];
  /** 触发速率限制时截断标记 */
  truncated?: boolean;
  truncatedReason?: string;
}

/** 官方阈值（单位：毫秒；CLS 为无量纲） */
export const CWV_THRESHOLDS: Record<CruxMetricName, { good: number; ni: number }> = {
  largest_contentful_paint: { good: 2500, ni: 4000 },
  interaction_to_next_paint: { good: 200, ni: 500 },
  cumulative_layout_shift: { good: 0.1, ni: 0.25 },
  first_contentful_paint: { good: 1800, ni: 3000 },
  experimental_time_to_first_byte: { good: 800, ni: 1800 },
};

/** 中文标签 */
export const METRIC_LABELS: Record<CruxMetricName, string> = {
  largest_contentful_paint: "LCP 最大内容绘制",
  interaction_to_next_paint: "INP 交互到下次绘制",
  cumulative_layout_shift: "CLS 累积布局偏移",
  first_contentful_paint: "FCP 首次内容绘制",
  experimental_time_to_first_byte: "TTFB 首字节时间",
};
