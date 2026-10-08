/**
 * GSC 凭证与令牌（T5，方案 a：凭证经环境变量传入，零新增依赖）
 *
 * 支持两种自备凭证：
 *   1. GOOGLE_OAUTH_ACCESS_TOKEN —— 直接可用的 OAuth access token（约 1 小时有效）
 *   2. GOOGLE_SERVICE_ACCOUNT_JSON（内联 JSON）或
 *      GOOGLE_APPLICATION_CREDENTIALS（service account JSON 文件路径）
 *      —— 用 node:crypto 手工构造 RS256 JWT 向 Google 换取 access token 并缓存。
 *
 * 安全红线：
 *   - access token / 私钥 / JWT assertion 绝不写进日志、错误消息或 Observation；
 *   - 对外只暴露「是哪种凭证、属于哪个 client_email」这类非敏感元数据。
 */
import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";

import type { GscCredential, ServiceAccountCredential } from "./types";

export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
export const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

/** 最小 HTTP 抽象 —— 默认走全局 fetch，测试可注入假实现 */
export interface GscHttpResponse {
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
}
export type GscHttp = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<GscHttpResponse>;

const defaultHttp: GscHttp = (url, init) =>
  fetch(url, init) as Promise<GscHttpResponse>;

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * 构造 service account 的 JWT assertion（RS256）。纯函数，便于单测。
 * `now` 可注入以固定 iat/exp。
 */
export function buildServiceAccountJwt(
  cred: ServiceAccountCredential,
  now: Date = new Date()
): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: cred.clientEmail,
      scope: GSC_SCOPE,
      aud: cred.tokenUri,
      iat,
      exp: iat + 3600,
    })
  );
  const signingInput = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  // private_key 已含 PEM 头尾（JSON 里是 \n 转义，JSON.parse 后即真实换行）
  const signature = signer.sign(cred.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

interface CachedToken {
  accessToken: string;
  /** 毫秒时间戳；提前 60s 视为过期，避免边界失效 */
  expiresAtMs: number;
}

/** 令牌提供者：access token 直接回；service account 换取并缓存 */
export interface TokenProvider {
  getToken: () => Promise<string>;
  /** 非敏感描述，供 UI/日志区分凭证类型（不含任何机密） */
  describe: () => string;
}

export function createTokenProvider(
  cred: GscCredential,
  http: GscHttp = defaultHttp
): TokenProvider {
  if (cred.kind === "access_token") {
    return {
      getToken: async () => cred.accessToken,
      describe: () => "oauth-access-token",
    };
  }

  let cache: CachedToken | null = null;

  const getToken = async (): Promise<string> => {
    if (cache && cache.expiresAtMs - 60_000 > Date.now()) {
      return cache.accessToken;
    }
    const assertion = buildServiceAccountJwt(cred);
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString();

    let res: GscHttpResponse;
    try {
      res = await http(cred.tokenUri, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch (e) {
      // 错误消息不含 assertion —— 只透传网络层错误描述
      throw new Error(
        `换取 GSC access token 时网络失败：${e instanceof Error ? e.message : "未知错误"}`
      );
    }

    if (!res.ok) {
      // 不打印响应体（可能含令牌相关细节），只给状态码
      throw new Error(`换取 GSC access token 被拒绝（HTTP ${res.status}）`);
    }

    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) {
      throw new Error("GSC token 端点响应缺少 access_token");
    }
    const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
    cache = {
      accessToken: data.access_token,
      expiresAtMs: Date.now() + expiresIn * 1000,
    };
    return data.access_token;
  };

  return {
    getToken,
    // 只暴露 client_email（邮箱不是机密，且帮助用户确认用了哪个服务账号）
    describe: () => `service-account:${cred.clientEmail}`,
  };
}

/* ------------------------------------------------------------------ */
/* 从环境变量解析凭证                                                   */
/* ------------------------------------------------------------------ */

interface ServiceAccountJson {
  client_email?: unknown;
  private_key?: unknown;
  token_uri?: unknown;
}

function parseServiceAccount(raw: string, source: string): ServiceAccountCredential {
  let parsed: ServiceAccountJson;
  try {
    parsed = JSON.parse(raw) as ServiceAccountJson;
  } catch {
    throw new Error(`${source} 不是合法的 service account JSON`);
  }
  if (
    typeof parsed.client_email !== "string" ||
    typeof parsed.private_key !== "string" ||
    !parsed.private_key.includes("PRIVATE KEY")
  ) {
    // 不回显文件内容，避免泄露私钥
    throw new Error(`${source} 缺少 client_email 或有效的 private_key`);
  }
  return {
    kind: "service_account",
    clientEmail: parsed.client_email,
    privateKey: parsed.private_key,
    tokenUri:
      typeof parsed.token_uri === "string" && parsed.token_uri
        ? parsed.token_uri
        : DEFAULT_TOKEN_URI,
  };
}

/**
 * 读取 GSC 凭证。优先级：显式 access token > 内联 SA JSON > SA JSON 文件路径。
 * 未配置任何凭证时返回 null（调用方据此返回 unavailable）。
 */
export function loadGscCredential(
  env: Record<string, string | undefined> = process.env
): GscCredential | null {
  const accessToken = env.GOOGLE_OAUTH_ACCESS_TOKEN?.trim();
  if (accessToken) return { kind: "access_token", accessToken };

  const saJson = env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (saJson) return parseServiceAccount(saJson, "GOOGLE_SERVICE_ACCOUNT_JSON");

  const saPath = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (saPath) {
    let raw: string;
    try {
      raw = readFileSync(saPath, "utf8");
    } catch {
      throw new Error(
        `GOOGLE_APPLICATION_CREDENTIALS 指向的文件无法读取：${saPath}`
      );
    }
    return parseServiceAccount(raw, "service account JSON 文件");
  }

  return null;
}
