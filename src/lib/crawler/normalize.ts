/**
 * 鲸析 GEOkit — 爬虫 URL 规范化与链接提取（T3）
 *
 * 与 evidence/identity.canonicalUrl 的差异：本模块面向站点图构建，
 * 排序 query 参数（同一页面的不同写法收敛成同一节点），
 * 而 canonicalUrl 保留 query 顺序（那是身份语义，重排会改变所指）。
 */
import { absolutize } from "../html";

/** 静态资源后缀集合 —— 这些 URL 不进入页面爬取队列 */
const STATIC_ASSET_EXTS = new Set([
  ".css", ".js", ".mjs", ".png", ".jpg", ".jpeg", ".gif", ".svg",
  ".pdf", ".zip", ".webp", ".ico", ".woff", ".woff2", ".ttf",
  ".mp4", ".webm", ".mp3",
]);

/**
 * 站点图节点 URL 规范化：
 *   - 去掉 fragment
 *   - query 参数按字母序排序（让 ?b=2&a=1 与 ?a=1&b=2 收敛为同一节点）
 *   - 默认去掉非根路径的尾斜杠；root "/" 保留
 *   - host 小写
 *
 * `trailingSlash: "keep"` 保留尾斜杠，用于需要严格保留原写法的场景。
 */
export function normalizeCrawlUrl(
  raw: string,
  opts: { trailingSlash?: "strip" | "keep" } = {}
): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return s;
  }
  u.hash = "";
  u.username = "";
  u.password = "";
  u.hostname = u.hostname.toLowerCase();

  // 排序 query
  if (u.searchParams.size > 0) {
    const pairs: [string, string][] = [];
    u.searchParams.forEach((v, k) => pairs.push([k, v]));
    pairs.sort((a, b) =>
      a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])
    );
    u.search = "";
    for (const [k, v] of pairs) u.searchParams.append(k, v);
  }

  const trailingSlash = opts.trailingSlash ?? "strip";
  if (trailingSlash === "strip") {
    let path = u.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    u.pathname = path;
  }
  return u.toString();
}

/** 判断 URL 是否指向静态资源（不进入页面爬取队列） */
export function isStaticAsset(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }
  const slash = path.lastIndexOf(".");
  if (slash === -1) return false;
  const ext = path.slice(slash).toLowerCase();
  return STATIC_ASSET_EXTS.has(ext);
}

/**
 * 判断 URL 是否与 origin 同域。
 * includeSubdomains=true 时，子域也算同域（如 www.example.com 对 example.com）。
 */
export function isSameDomain(
  url: string,
  origin: string,
  includeSubdomains: boolean
): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  let originHost: string;
  try {
    originHost = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === originHost) return true;
  if (includeSubdomains && host.endsWith("." + originHost)) return true;
  return false;
}

const LINK_RE = /<a\s[^>]*href=["']([^"']+)["']/gi;

/**
 * 从 HTML 提取所有 <a href> 链接，绝对化后只保留 http/https，去重。
 *
 * 不引入 cheerio / jsdom —— 单条正则足够覆盖站点图构建所需。
 * 失败的相对 URL 解析（absolutize 抛错时）按原值保留再过滤。
 */
export function extractLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(html)) !== null) {
    const href = (m[1] ?? "").trim();
    if (!href) continue;
    if (/^(#|mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    const abs = absolutize(href, baseUrl);
    if (!/^https?:\/\//i.test(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}
