/**
 * 鲸析 GEOkit — CrUX API 客户端（T11）
 *
 * 仅做 HTTP 调用与状态映射，不做指标评估。原始 record 透传到 analyze 层。
 *
 * 官方端点：
 *   POST https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=KEY
 *   Body: { url?: string; origin?: string; formFactor?: "DESKTOP"|"PHONE"|"TABLET"; metrics?: string[] }
 *
 * 状态映射：
 *   - 无 CRUX_API_KEY → unavailable（"未配置 API key"）
 *   - 404 NOT_FOUND → unavailable（"该 URL/源站无 CrUX 数据"）
 *   - 429 → blocked（"触发速率限制"）
 *   - 401/403 → blocked（"凭证无效或未启用 CrUX API"）
 *   - 其他 4xx/5xx → error（附原始 message）
 *
 * 并发与速率：
 *   - 官方限制 150 次/分钟/项目（约 2.5 QPS）
 *   - 本客户端串行执行（非真并发），配合可配置 minIntervalMs 默认 500ms
 *     以预留足够余量；遇 429 立即截断。
 */

import type {
  BatchCheckInput,
  BatchCheckResult,
  CruxApiResponse,
  CruxFormFactor,
  CruxClientOptions,
} from "./types";

const CRUX_ENDPOINT = "https://chromeuxreport.googleapis.com/v1/records:queryRecord";
const DEFAULT_MIN_INTERVAL_MS = 500;

/** 单条观测原始结果（含原始 record，供 analyze 层解析） */
export interface CruxRawObservation {
  target: string;
  scope: "url" | "origin";
  formFactor?: CruxFormFactor;
  observedAt: string;
  status: "ok" | "unavailable" | "blocked" | "error";
  statusReason?: string;
  httpStatus?: number;
  /** API 返回的 record（仅 status=ok 时有值） */
  record?: CruxApiResponse["record"];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getApiKey(options?: CruxClientOptions): string | undefined {
  return options?.apiKey ?? process.env.CRUX_API_KEY;
}

function formatDate(d: { year: number; month: number; day: number }): string {
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

/** 单条观测（URL 或 Origin 二选一） */
export async function queryCrux(
  params: { url?: string; origin?: string; formFactor?: CruxFormFactor },
  options?: CruxClientOptions
): Promise<CruxRawObservation> {
  const apiKey = getApiKey(options);
  const target = params.url ?? params.origin ?? "";
  const scope: "url" | "origin" = params.url ? "url" : "origin";
  const observedAt = new Date().toISOString();

  if (!apiKey) {
    return {
      target,
      scope,
      formFactor: params.formFactor,
      observedAt,
      status: "unavailable",
      statusReason: "未配置 CRUX_API_KEY",
    };
  }

  if (!params.url && !params.origin) {
    return {
      target,
      scope,
      formFactor: params.formFactor,
      observedAt,
      status: "error",
      statusReason: "必须提供 url 或 origin 参数",
    };
  }

  const fetchImpl = options?.fetchFn ?? fetch;
  const timeoutMs = options?.timeoutMs ?? 15_000;

  const body: Record<string, unknown> = {};
  if (params.url) body.url = params.url;
  if (params.origin) body.origin = params.origin;
  if (params.formFactor) body.formFactor = params.formFactor;

  const endpoint = `${CRUX_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;

  let httpStatus = 0;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    httpStatus = res.status;

    const data = (await res.json()) as CruxApiResponse;

    if (!res.ok) {
      const code = data.error?.code ?? res.status;
      const message = data.error?.message ?? res.statusText;
      const statusText = data.error?.status ?? "";

      if (code === 404 || statusText === "NOT_FOUND") {
        return {
          target,
          scope,
          formFactor: params.formFactor,
          observedAt,
          httpStatus,
          status: "unavailable",
          statusReason: "该 URL/源站无 CrUX 数据（chrome ux report data not found）",
        };
      }
      if (code === 429 || statusText === "RESOURCE_EXHAUSTED") {
        return {
          target,
          scope,
          formFactor: params.formFactor,
          observedAt,
          httpStatus,
          status: "blocked",
          statusReason: "触发速率限制（RESOURCE_EXHAUSTED / 429）",
        };
      }
      if (code === 401 || code === 403) {
        return {
          target,
          scope,
          formFactor: params.formFactor,
          observedAt,
          httpStatus,
          status: "blocked",
          statusReason: "凭证无效或未启用 Chrome UX Report API",
        };
      }
      return {
        target,
        scope,
        formFactor: params.formFactor,
        observedAt,
        httpStatus,
        status: "error",
        statusReason: `CrUX API 错误：${code} ${statusText} - ${message}`,
      };
    }

    if (!data.record) {
      return {
        target,
        scope,
        formFactor: params.formFactor,
        observedAt,
        httpStatus,
        status: "unavailable",
        statusReason: "API 响应中无 record 字段",
      };
    }

    return {
      target,
      scope,
      formFactor: params.formFactor,
      observedAt,
      httpStatus,
      status: "ok",
      record: data.record,
    };
  } catch (e) {
    return {
      target,
      scope,
      formFactor: params.formFactor,
      observedAt,
      httpStatus,
      status: "error",
      statusReason: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 批量观测（串行 + 间隔，遇 429 截断） */
export async function batchQueryCrux(
  input: BatchCheckInput,
  options?: CruxClientOptions
): Promise<BatchCheckResult> {
  const urls = input.urls ?? [];
  const origins = input.origins ?? [];
  const targets = [
    ...urls.map((u) => ({ url: u, formFactor: input.formFactor })),
    ...origins.map((o) => ({ origin: o, formFactor: input.formFactor })),
  ];

  const minIntervalMs = input.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

  const rawObservations: CruxRawObservation[] = [];
  let truncated = false;
  let truncatedReason: string | undefined;

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const obs = await queryCrux(t, options);
    rawObservations.push(obs);

    if (obs.status === "blocked" && obs.statusReason?.includes("速率限制")) {
      truncated = true;
      truncatedReason = `第 ${i + 1}/${targets.length} 个请求触发速率限制，已截断剩余请求`;
      break;
    }

    if (i < targets.length - 1 && minIntervalMs > 0) {
      await sleep(minIntervalMs);
    }
  }

  const ok = rawObservations.filter((o) => o.status === "ok").length;
  const unavailable = rawObservations.filter((o) => o.status === "unavailable").length;
  const blocked = rawObservations.filter((o) => o.status === "blocked").length;
  const error = rawObservations.filter((o) => o.status === "error").length;

  return {
    total: targets.length,
    ok,
    unavailable,
    blocked,
    error,
    observations: rawObservations.map((raw) => ({
      target: raw.target,
      scope: raw.scope,
      formFactor: raw.formFactor,
      observedAt: raw.observedAt,
      status: raw.status,
      statusReason: raw.statusReason,
      httpStatus: raw.httpStatus,
      collectionPeriod: raw.record?.collectionPeriod
        ? {
            firstDate: formatDate(raw.record.collectionPeriod.firstDate),
            lastDate: formatDate(raw.record.collectionPeriod.lastDate),
          }
        : undefined,
    })),
    truncated,
    truncatedReason,
  };
}

/** 批量观测（返回含原始 record 的版本，供 analyze 层使用） */
export async function batchQueryCruxRaw(
  input: BatchCheckInput,
  options?: CruxClientOptions
): Promise<{ rawObservations: CruxRawObservation[]; truncated: boolean; truncatedReason?: string }> {
  const urls = input.urls ?? [];
  const origins = input.origins ?? [];
  const targets = [
    ...urls.map((u) => ({ url: u, formFactor: input.formFactor })),
    ...origins.map((o) => ({ origin: o, formFactor: input.formFactor })),
  ];

  const minIntervalMs = input.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

  const rawObservations: CruxRawObservation[] = [];
  let truncated = false;
  let truncatedReason: string | undefined;

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const obs = await queryCrux(t, options);
    rawObservations.push(obs);

    if (obs.status === "blocked" && obs.statusReason?.includes("速率限制")) {
      truncated = true;
      truncatedReason = `第 ${i + 1}/${targets.length} 个请求触发速率限制，已截断剩余请求`;
      break;
    }

    if (i < targets.length - 1 && minIntervalMs > 0) {
      await sleep(minIntervalMs);
    }
  }

  return { rawObservations, truncated, truncatedReason };
}
