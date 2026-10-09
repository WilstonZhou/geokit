/**
 * Search Console Search Analytics 客户端（T5）
 *
 * 只做一件事：带 Bearer 令牌 POST searchAnalytics/query，分页拉全，
 * 并把 HTTP 结果分类为 ok / blocked / unavailable / error（小写四态）。
 *
 * 不分析、不落库 —— 分析在 analyze.ts（纯函数），编排在 index.ts。
 * 令牌通过 TokenProvider 获取，凭证绝不出现在 URL / 日志 / 结果里。
 */
import {
  createTokenProvider,
  loadGscCredential,
  type GscHttp,
  type GscHttpResponse,
  type TokenProvider,
} from "./auth";
import type {
  GscQueryParams,
  GscQueryResult,
  GscRow,
} from "./types";

const API_BASE = "https://searchconsole.googleapis.com/webmasters/v3";
/** 每页行数（API 单页上限 25000；取 1000 平衡请求数与限流风险） */
export const DEFAULT_PAGE_SIZE = 1000;
/** 安全上限：单次查询最多拉取的行数，防止异常分页失控 */
export const MAX_ROWS_HARD_CAP = 25_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const defaultHttp: GscHttp = (url, init) =>
  fetch(url, init) as Promise<GscHttpResponse>;

function sitePath(siteUrl: string): string {
  // sc-domain:example.com 与 https://example.com/ 都需整段编码
  return `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
}

function unavailable(reason: string): GscQueryResult {
  return { status: "unavailable", statusReason: reason, rows: [] };
}

interface ClientDeps {
  /** 注入 HTTP（测试用假响应）；默认全局 fetch */
  http?: GscHttp;
  /** 预置令牌提供者（测试绕过换取流程）；默认由环境变量凭证构建 */
  tokenProvider?: TokenProvider;
}

/**
 * 拉取 Search Analytics。永不因 HTTP 状态抛错 —— 一律装进 GscQueryResult。
 */
export async function querySearchAnalytics(
  params: GscQueryParams,
  deps: ClientDeps = {}
): Promise<GscQueryResult> {
  const http = deps.http ?? defaultHttp;

  // ── 参数校验：错误入参直接报 error，不发无效请求 ──
  if (!params.siteUrl?.trim()) {
    return { status: "error", statusReason: "siteUrl 为空，无法确定 Search Console 资源", rows: [] };
  }
  if (!DATE_RE.test(params.startDate) || !DATE_RE.test(params.endDate)) {
    return { status: "error", statusReason: "日期必须为 YYYY-MM-DD", rows: [] };
  }

  // ── 凭证：未配置 → unavailable（功能没开，不是故障）──
  let provider: TokenProvider;
  if (deps.tokenProvider) {
    provider = deps.tokenProvider;
  } else {
    let credential;
    try {
      credential = loadGscCredential();
    } catch (e) {
      return {
        status: "blocked",
        statusReason: `GSC 凭证无效：${e instanceof Error ? e.message : "未知错误"}`,
        rows: [],
      };
    }
    if (!credential) {
      return unavailable(
        "未配置 GSC 凭证：设置 GOOGLE_OAUTH_ACCESS_TOKEN，或 GOOGLE_SERVICE_ACCOUNT_JSON / GOOGLE_APPLICATION_CREDENTIALS 后可用"
      );
    }
    provider = createTokenProvider(credential);
  }

  let token: string;
  try {
    token = await provider.getToken();
  } catch (e) {
    // token 换取失败多为私钥/授权问题 —— 归 blocked（拿不到访问资格）
    return {
      status: "blocked",
      statusReason: `无法获取 GSC 访问令牌：${e instanceof Error ? e.message : "未知错误"}`,
      rows: [],
    };
  }

  const pageSize = Math.min(
    Math.max(1, params.rowLimit ?? DEFAULT_PAGE_SIZE),
    MAX_ROWS_HARD_CAP
  );

  const all: GscRow[] = [];
  let startRow = 0;
  // 分页：直到某页返回不足一整页，或触达硬上限
  for (;;) {
    const body = JSON.stringify({
      startDate: params.startDate,
      endDate: params.endDate,
      dimensions: params.dimensions ?? ["query"],
      rowLimit: pageSize,
      startRow,
      dataState: "final",
    });

    let res;
    try {
      res = await http(`${API_BASE}${sitePath(params.siteUrl)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body,
      });
    } catch (e) {
      return {
        status: "error",
        statusReason: `请求 Search Console 网络失败：${e instanceof Error ? e.message : "未知错误"}`,
        rows: all,
      };
    }

    if (!res.ok) {
      return classifyHttpError(res.status, all, params);
    }

    let data: { rows?: GscRow[] };
    try {
      data = (await res.json()) as { rows?: GscRow[] };
    } catch {
      return {
        status: "error",
        statusReason: "Search Console 返回了无法解析的 JSON",
        rows: all,
      };
    }

    const pageRows = Array.isArray(data.rows) ? data.rows : [];
    all.push(...pageRows);

    if (pageRows.length < pageSize) break; // 末页
    startRow += pageRows.length;
    if (all.length >= MAX_ROWS_HARD_CAP) break;
  }

  return {
    status: "ok",
    rows: all,
    siteUrl: params.siteUrl,
    startDate: params.startDate,
    endDate: params.endDate,
    dimensions: params.dimensions ?? ["query"],
    rowCount: all.length,
    ...(all.length === 0
      ? { statusReason: "该时间范围与维度下没有数据（API 返回空 rows）—— 这是真实结论，不是故障" }
      : {}),
  };
}

function _unavailableBase(reason: string): GscQueryResult {
  return { status: "unavailable", statusReason: reason, rows: [] };
}

function classifyHttpError(
  status: number,
  partial: GscRow[],
  params: GscQueryParams
): GscQueryResult {
  const base = {
    rows: partial,
    httpStatus: status,
    siteUrl: params.siteUrl,
    startDate: params.startDate,
    endDate: params.endDate,
  };
  if (status === 401) {
    return {
      ...base,
      status: "blocked",
      statusReason:
        "401 凭证无效或令牌过期：请检查 GOOGLE_OAUTH_ACCESS_TOKEN，或重新生成 service account 令牌",
    };
  }
  if (status === 403) {
    return {
      ...base,
      status: "blocked",
      statusReason:
        "403 无权访问该 Search Console 资源：请确认资源标识正确，并把对应账号（或 service account 邮箱）加为资源用户",
    };
  }
  if (status === 429) {
    return {
      ...base,
      status: "blocked",
      statusReason: "429 触发 Google API 配额/限流：请稍后重试或缩短查询范围",
    };
  }
  if (status >= 500) {
    return {
      ...base,
      status: "error",
      statusReason: `Search Console 服务端错误 HTTP ${status}，稍后重试`,
    };
  }
  return {
    ...base,
    status: "error",
    statusReason: `Search Console 返回未预期状态 HTTP ${status}`,
  };
}
