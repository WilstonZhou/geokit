/**
 * 请求 / 响应头脱敏。
 *
 * 为什么必须先于一切落盘逻辑写出来：AI Visibility 会把 API Key 放进
 * 请求头，robots / SERP 采集会带上 Cookie，第三方站点会通过 Set-Cookie
 * 下发会话凭证。任何一条流入 Evidence 存储，都等于把凭据写进了磁盘。
 *
 * 策略是「默认脱敏未知敏感项」而不是「列白名单」—— 漏网的代价远大于误脱。
 */

/** 完整替换为一律遮蔽的头部（大小写不敏感） */
const FULL_REDACT = new RegExp(
  [
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "api-key",
    "apikey",
    "x-auth-token",
    "auth-token",
    "access-token",
    "refresh-token",
    "x-csrf-token",
    "x-xsrf-token",
    "x-goog-api-key",
    "x-amz-security-token",
    "secret",
  ].join("|"),
  "i"
);

/** 保留结构但抹掉取值：Bearer xxx → Bearer [REDACTED] */
const VALUE_REDACT = /^(bearer|basic|token)\s+/i;

/** 名字里含这些词的一律遮蔽，防未知自定义 header */
const NAME_HINTS = /(key|token|secret|credential|password|session|passwd)/i;

export const REDACTED = "[REDACTED]";

/**
 * 脱敏一组 header。
 * 返回新对象，不修改入参。
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.trim();
    if (!key) continue;

    let value = String(rawValue ?? "");

    if (FULL_REDACT.test(key) || NAME_HINTS.test(key)) {
      out[key] = REDACTED;
      continue;
    }

    if (VALUE_REDACT.test(value)) {
      const scheme = value.split(/\s+/)[0];
      out[key] = `${scheme} ${REDACTED}`;
      continue;
    }

    // 长且高熵的取值（各类签名头）截断，避免凭空留一堆无用噪声
    if (value.length > 120) {
      value = `${value.slice(0, 40)}…[truncated ${value.length - 40}]`;
    }

    out[key] = value;
  }

  return out;
}

/**
 * URL 脱敏：query 里的常见凭据参数要去掉。
 * 例如某些 provider 走 URL 带 key 的鉴权方式。
 */
export function redactUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const sensitive = ["key", "api_key", "apikey", "access_token", "token", "sig", "signature"];
    for (const name of u.searchParams.keys()) {
      if (sensitive.includes(name.toLowerCase()) || NAME_HINTS.test(name)) {
        u.searchParams.set(name, REDACTED);
      }
    }
    return u.toString();
  } catch {
    return rawUrl;
  }
}

/** 开发期自检：确认没有凭据从脱敏网里漏出去 */
export function assertNoSecret(headers: Record<string, string>, forbidden: string[]): string[] {
  const leaks: string[] = [];
  const flat = JSON.stringify(headers);
  for (const f of forbidden) {
    if (f && f.length >= 8 && flat.includes(f)) leaks.push(f.slice(0, 6) + "…");
  }
  return leaks;
}
