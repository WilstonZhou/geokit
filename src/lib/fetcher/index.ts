/**
 * Unified Fetcher —— 收敛全系统散落的 HTTP 调用。
 *
 * 职责边界（Phase 0 明确定义）：
 *   Fetcher   负责采集：超时、重试、退避、限速、UA、provenance 采集
 *   Evidence  负责保存：把采集结果落成不可变事实
 *   Observer  负责生产结论：从 Evidence 产出 Observation
 *
 * Fetcher 不写 Evidence、不做解析、不产生业务结论。它只回答
 * 「这次请求发生了什么」，并把足以构成 provenance 的信息完整交出来。
 *
 * Phase 0 行为约束：
 *   - maxAttempts 默认 1（不重试）—— 历史版本无重试，保持行为零变化
 *   - 速率限制默认配额宽裕，单次调用不受影响
 *   二者都可按需开启，开启后即为有意的行为变化，需记录原因。
 */
import { createHash } from "node:crypto";

import { acquire, DEFAULT_POLICY, type RateLimitPolicy } from "./rate-limit";
import { assertSafeUrl, UnsafeUrlError } from "./safety";
import { redactHeaders } from "../evidence/redact";

export type FetchPurpose =
  | "serp"
  | "audit"
  | "robots"
  | "llms"
  | "ai-visibility"
  | "resolve-redirect"
  | "crawl";

export type FetchErrorKind =
  | "timeout"
  | "network"
  | "http_error"
  | "too_large"
  | "invalid_url"
  | "blocked_url"
  | "redirect_loop"
  | "rate_limited"
  | "aborted";

export interface FetchRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** 单次尝试超时。各调用点沿用自身历史值，避免行为漂移 */
  timeoutMs?: number;
  /** 含首次的总尝试次数。默认 1 = 不重试 */
  maxAttempts?: number;
  maxBytes?: number;
  /** 是否跟随重定向 */
  followRedirect?: boolean;
  /**
   * 是否读取响应体。默认 true。
   * 设为 false 时只取 finalUrl / status / headers 并立即 cancel 流，
   * 用于「只需要知道最终落到哪个域名」的重定向解析场景 —— 不产生额外流量。
   */
  readBody?: boolean;
  rateLimit?: RateLimitPolicy | false;
  purpose: FetchPurpose;
  /**
   * 业务对象标识，进入 provenance（如被审计的站点、搜索的引擎）。
   *
   * @deprecated Phase 1 S1 起语义分裂：serp/ai 通道存的是「来源」，
   * audit/llms 通道存的是「被观测对象」。新代码一律用 subject / source。
   * 保留它只为兼容 Phase 0 读者。
   */
  target?: string;
  /**
   * canonical 被观测对象（Phase 1）。例：`site:https://x.com`、`ai-slot:deepseek:deepseek-chat`。
   * 缺省时由 evidence 归一化层按 purpose + target + meta 推导。
   */
  subject?: string;
  /** canonical 观测来源（Phase 1）。例：`search-engine:baidu`、`provider:deepseek` */
  source?: string;
  /** 观测批次 id。去重与「重算 vs 新观测」的判定依据 */
  runId?: string;
  meta?: Record<string, string | number | boolean | undefined>;
}

export interface FetchError {
  kind: FetchErrorKind;
  message: string;
  retryable: boolean;
}

export interface FetchAttempt {
  attempt: number;
  elapsedMs: number;
  outcome: "ok" | "error";
  errorKind?: FetchErrorKind;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  /** 重定向后的最终 URL */
  finalUrl: string;
  /** 手动跟随的每一跳 URL（不含起点，含终点）；无重定向时为空数组 */
  redirectChain?: string[];
  /** 已脱敏的响应头 */
  headers: Record<string, string>;
  body: string;
  byteLength: number;
  bodyHash: string;
  elapsedMs: number;
  attempts: FetchAttempt[];
  waitedMs: number;
  request: {
    url: string;
    method: string;
    /** 已脱敏的请求头 */
    headers: Record<string, string>;
  };
  context: {
    purpose: FetchPurpose;
    /** @deprecated 语义分裂，见 FetchRequest.target */
    target?: string;
    subject?: string;
    source?: string;
    runId?: string;
    requestedAt: string;
    meta?: Record<string, string | number | boolean | undefined>;
  };
  error?: FetchError;
}

export const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 32);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function classify(err: unknown, timedOut: boolean): FetchError {
  const msg = err instanceof Error ? err.message : String(err);
  if (timedOut || /abort/i.test(msg)) {
    return { kind: "timeout", message: msg, retryable: true };
  }
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(msg)) {
    return { kind: "network", message: msg, retryable: true };
  }
  return { kind: "network", message: msg, retryable: false };
}

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isRedirect(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

interface LimitedBody {
  text: string;
  byteLength: number;
  tooLarge: boolean;
}

/** 流式读取响应体，超过 maxBytes 立即取消，不把整个 body 读进内存。 */
async function readBodyWithLimit(
  res: Response,
  maxBytes: number
): Promise<LimitedBody> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return { text: "", byteLength: declared, tooLarge: true };
  }

  if (!res.body) return { text: "", byteLength: 0, tooLarge: false };

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { text: "", byteLength: total, tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return { text: buffer.toString("utf8"), byteLength: buffer.length, tooLarge: false };
}

/**
 * 执行一次 HTTP 请求。这是全系统唯一的 fetch 出口。
 *
 * 安全约束：每一跳（含初始 URL 与重定向目标）都先经过 assertSafeUrl；
 * 响应体流式读取，超过 maxBytes 立即中断。
 */
export async function fetchWithPolicy(req: FetchRequest): Promise<FetchResult> {
  const started = Date.now();
  const requestedAt = new Date().toISOString();
  const url = req.url;
  const allowPrivate = process.env.GEOKIT_ALLOW_PRIVATE_URLS === "on";

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return failResult(req, requestedAt, Date.now() - started, {
      kind: "invalid_url",
      message: `URL 无法解析：${url}`,
      retryable: false,
    });
  }

  try {
    await assertSafeUrl(parsed.toString(), { allowPrivate });
  } catch (e) {
    return failResult(req, requestedAt, Date.now() - started, {
      kind: "blocked_url",
      message: e instanceof Error ? e.message : String(e),
      retryable: false,
    });
  }

  const maxAttempts = Math.max(1, req.maxAttempts ?? 1);
  const timeoutMs = req.timeoutMs ?? 15_000;
  const maxBytes = req.maxBytes ?? 8 * 1024 * 1024;
  const attempts: FetchAttempt[] = [];
  let waitedMs = 0;

  const requestHeaders: Record<string, string> = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    ...(req.headers ?? {}),
  };
  if (!requestHeaders["User-Agent"]) requestHeaders["User-Agent"] = DEFAULT_UA;

  let lastError: FetchError = { kind: "network", message: "未知错误", retryable: false };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptStart = Date.now();
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);

    try {
      let currentUrl = parsed.toString();
      let currentMethod = req.method ?? "GET";
      let currentBody = req.body;
      const redirectChain: string[] = [];
      let res: Response;

      for (;;) {
        if (req.rateLimit !== false) {
          const wait = acquire(
            new URL(currentUrl).host,
            req.rateLimit ?? DEFAULT_POLICY
          );
          if (wait > 0) {
            await sleep(wait);
            waitedMs += wait;
          }
        }

        res = await fetch(currentUrl, {
          method: currentMethod,
          headers: requestHeaders,
          body: currentBody,
          signal: ctrl.signal,
          redirect: "manual",
        });

        if (req.followRedirect === false || !isRedirect(res.status)) break;

        const location = res.headers.get("location");
        if (!location) break;

        if (redirectChain.length >= MAX_REDIRECTS) {
          await res.body?.cancel().catch(() => undefined);
          const err: FetchError = {
            kind: "redirect_loop",
            message: `重定向超过 ${MAX_REDIRECTS} 跳`,
            retryable: false,
          };
          attempts.push({
            attempt,
            elapsedMs: Date.now() - attemptStart,
            outcome: "error",
            errorKind: err.kind,
          });
          return failResult(req, requestedAt, Date.now() - started, err, attempts, waitedMs);
        }

        let nextUrl: string;
        try {
          nextUrl = new URL(location, currentUrl).toString();
        } catch {
          await res.body?.cancel().catch(() => undefined);
          const err: FetchError = {
            kind: "invalid_url",
            message: `重定向目标无法解析：${location}`,
            retryable: false,
          };
          attempts.push({
            attempt,
            elapsedMs: Date.now() - attemptStart,
            outcome: "error",
            errorKind: err.kind,
          });
          return failResult(req, requestedAt, Date.now() - started, err, attempts, waitedMs);
        }

        try {
          await assertSafeUrl(nextUrl, { allowPrivate });
        } catch (e) {
          await res.body?.cancel().catch(() => undefined);
          const err: FetchError = {
            kind: "blocked_url",
            message: e instanceof Error ? e.message : String(e),
            retryable: false,
          };
          attempts.push({
            attempt,
            elapsedMs: Date.now() - attemptStart,
            outcome: "error",
            errorKind: err.kind,
          });
          return failResult(req, requestedAt, Date.now() - started, err, attempts, waitedMs);
        }

        redirectChain.push(nextUrl);
        await res.body?.cancel().catch(() => undefined);

        // fetch 规范：303 一律改 GET；301/302 对非 GET 也改 GET；307/308 保持方法与 body
        if (
          res.status === 303 ||
          ((res.status === 301 || res.status === 302) && currentMethod !== "GET")
        ) {
          currentMethod = "GET";
          currentBody = undefined;
        }
        currentUrl = nextUrl;
      }

      let raw = "";
      let byteLength = 0;

      if (req.readBody === false) {
        // 只要 finalUrl —— 立即放弃流，避免下载无用的响应体
        try {
          await res.body?.cancel();
        } catch {
          /* 已不可读，忽略 */
        }
      } else {
        const limited = await readBodyWithLimit(res, maxBytes);
        if (limited.tooLarge) {
          const err: FetchError = {
            kind: "too_large",
            message: `响应体 ${limited.byteLength} 字节超过上限 ${maxBytes}`,
            retryable: false,
          };
          attempts.push({
            attempt,
            elapsedMs: Date.now() - attemptStart,
            outcome: "error",
            errorKind: err.kind,
          });
          return failResult(req, requestedAt, Date.now() - started, err, attempts, waitedMs);
        }
        raw = limited.text;
        byteLength = limited.byteLength;
      }

      const isServerish = res.status >= 500 || res.status === 429;
      attempts.push({
        attempt,
        elapsedMs: Date.now() - attemptStart,
        outcome: res.ok ? "ok" : "error",
        errorKind: res.ok ? undefined : "http_error",
      });

      if (!res.ok) {
        lastError = {
          kind: "http_error",
          message: `HTTP ${res.status}`,
          retryable: isServerish,
        };
        if (isServerish && attempt < maxAttempts) {
          await sleep(backoff(attempt));
          continue;
        }
      }

      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });

      return {
        ok: res.ok,
        status: res.status,
        finalUrl: res.url || currentUrl,
        redirectChain,
        headers: redactHeaders(headers),
        body: raw,
        byteLength,
        bodyHash: sha256(raw),
        elapsedMs: Date.now() - started,
        attempts,
        waitedMs,
        request: {
          url,
          method: req.method ?? "GET",
          headers: redactHeaders(requestHeaders),
        },
        context: {
          purpose: req.purpose,
          target: req.target,
          subject: req.subject,
          source: req.source,
          runId: req.runId,
          requestedAt,
          meta: req.meta,
        },
        error: res.ok ? undefined : lastError,
      };
    } catch (e) {
      if (e instanceof UnsafeUrlError) {
        return failResult(req, requestedAt, Date.now() - started, {
          kind: "blocked_url",
          message: e.message,
          retryable: false,
        }, attempts, waitedMs);
      }
      const err = classify(e, timedOut);
      lastError = err;
      attempts.push({
        attempt,
        elapsedMs: Date.now() - attemptStart,
        outcome: "error",
        errorKind: err.kind,
      });
      if (err.retryable && attempt < maxAttempts) {
        await sleep(backoff(attempt));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return failResult(req, requestedAt, Date.now() - started, lastError, attempts, waitedMs);
}

/** 指数退避 + jitter，避免多个失败请求同时重试形成尖峰 */
function backoff(attempt: number): number {
  const base = Math.min(8_000, 500 * 2 ** (attempt - 1));
  const jitter = Math.random() * 0.3 * base;
  return Math.round(base + jitter);
}

function failResult(
  req: FetchRequest,
  requestedAt: string,
  elapsedMs: number,
  error: FetchError,
  attempts: FetchAttempt[] = [],
  waitedMs = 0
): FetchResult {
  return {
    ok: false,
    status: 0,
    finalUrl: req.url,
    redirectChain: [],
    headers: {},
    body: "",
    byteLength: 0,
    bodyHash: "",
    elapsedMs,
    attempts,
    waitedMs,
    request: {
      url: req.url,
      method: req.method ?? "GET",
      headers: redactHeaders(req.headers ?? {}),
    },
    context: {
      purpose: req.purpose,
      target: req.target,
      subject: req.subject,
      source: req.source,
      runId: req.runId,
      requestedAt,
      meta: req.meta,
    },
    error,
  };
}

/** 便捷封装：只要文本内容，失败即抛（沿用历史调用点的错误处理习惯） */
export async function fetchText(req: FetchRequest): Promise<FetchResult> {
  return fetchWithPolicy(req);
}
