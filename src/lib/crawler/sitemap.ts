/**
 * 鲸析 GEOkit — 站点 sitemap 解析（T3）
 *
 * 零依赖 XML 正则解析。不引入 fast-xml-parser / xml2js ——
 * sitemap 的结构足够简单：要么是 <urlset>（叶子，含 <url><loc>），
 * 要么是 <sitemapindex>（索引，含 <sitemap><loc>）。正则足够覆盖。
 *
 * 命名空间前缀（sm:、xmlns:）也能兼容：根标签用 startsWith 判定。
 */
import type { Fetcher } from "./types";

export interface ParsedSitemap {
  /** <urlset> 下的叶子 URL */
  urls: string[];
  /** <sitemapindex> 下的子索引 URL */
  sitemapIndexUrls: string[];
}

const LOC_RE = /<(?:[\w.-]+:)?loc>([\s\S]*?)<\/(?:[\w.-]+:)?loc>/gi;
const ROOT_URLSET_RE = /<[^>]*urlset[\s>]/i;
const ROOT_INDEX_RE = /<[^>]*sitemapindex[\s>]/i;

/**
 * 用正则解析 sitemap XML。
 *
 * 命名空间前缀（如 `<ns:urlset xmlns:ns="...">`）通过 startsWith 判定：
 * 只要根标签含 `urlset` 或 `sitemapindex` 即可路由。
 * 同一个文件不会既是 urlset 又是 sitemapindex —— 互斥。
 */
export function parseSitemapXml(xml: string): ParsedSitemap {
  const out: ParsedSitemap = { urls: [], sitemapIndexUrls: [] };
  if (!xml) return out;

  const isIndex = ROOT_INDEX_RE.test(xml);
  const isUrlset = ROOT_URLSET_RE.test(xml);
  // 既不是 index 也不是 urlset（畸形文件）—— 仍尝试从 <loc> 兜底，
  // 但分类上算 urls（多数情况是 urlset 写歪了）
  const target = isIndex ? out.sitemapIndexUrls : out.urls;

  LOC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LOC_RE.exec(xml)) !== null) {
    const loc = (m[1] ?? "").trim();
    if (!loc) continue;
    // 去 CDATA 包裹
    const cleaned = loc.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i, "$1").trim();
    if (cleaned) target.push(cleaned);
  }

  // 畸形文件既不命中 urlset 也不命中 index：上面的 target 默认走 urls，
  // 这里不动 —— 调用方拿到 urls，自然当 urlset 处理
  void isUrlset;
  return out;
}

/**
 * 从 robots.txt 声明的 sitemap 列表递归发现所有叶子 URL。
 *
 * robotsSitemaps 可能是 sitemap index 也可能是 urlset —— 解析后判断：
 * index 则递归抓取其内的 <sitemap><loc>，深度上限 maxDepth（默认 3）。
 * urlset 则把 <url><loc> 加入结果。所有 URL 去重。
 */
export async function discoverSitemaps(
  origin: string,
  robotsSitemaps: string[],
  fetcher: Fetcher,
  opts: { timeoutMs?: number; maxDepth?: number } = {}
): Promise<string[]> {
  const maxDepth = Math.max(0, opts.maxDepth ?? 3);
  const seen = new Set<string>();
  const leafUrls = new Set<string>();
  const queue: { url: string; depth: number }[] = [];

  // 入口：robots 声明的 sitemap；如果列表为空，尝试 {origin}/sitemap.xml 兜底
  const initial =
    robotsSitemaps.length > 0
      ? robotsSitemaps
      : [`${origin.replace(/\/$/, "")}/sitemap.xml`];

  for (const s of initial) {
    if (!seen.has(s)) {
      seen.add(s);
      queue.push({ url: s, depth: 0 });
    }
  }

  while (queue.length > 0) {
    const { url, depth } = queue.shift()!;
    if (depth > maxDepth) continue;
    try {
      const res = await fetcher({
        url,
        timeoutMs: opts.timeoutMs ?? 10_000,
        followRedirect: true,
        purpose: "crawl",
        target: url,
      });
      if (!res.ok || res.body === "") continue;
      const parsed = parseSitemapXml(res.body);
      for (const leaf of parsed.urls) {
        if (!seen.has(leaf)) {
          seen.add(leaf);
          leafUrls.add(leaf);
        }
      }
      if (depth < maxDepth) {
        for (const child of parsed.sitemapIndexUrls) {
          if (!seen.has(child)) {
            seen.add(child);
            queue.push({ url: child, depth: depth + 1 });
          }
        }
      }
    } catch {
      // 单个 sitemap 失败不阻断整体发现
    }
  }

  return Array.from(leafUrls);
}
