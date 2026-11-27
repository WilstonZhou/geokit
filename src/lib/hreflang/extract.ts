/**
 * 鲸析 GEOkit — hreflang 三种来源提取（T12）
 *
 * 1. HTML <link rel="alternate" hreflang="..." href="...">
 * 2. HTTP Link 响应头（Link: <url>; rel="alternate"; hreflang="..."）
 * 3. XML sitemap <xhtml:link rel="alternate" hreflang="..." href="...">
 */

import { absolutize, findTags, getMeta, parseAttrs } from "../html";
import type { HreflangEntry, PageInput, SitemapInput } from "./types";

/** 从 HTML 提取 hreflang */
export function extractFromHtml(html: string): HreflangEntry[] {
  const entries: HreflangEntry[] = [];
  const linkTags = findTags(html, ["link"]);

  for (const tag of linkTags) {
    const rel = tag.attrs.rel?.toLowerCase() ?? "";
    if (rel !== "alternate") continue;

    const hreflang = tag.attrs.hreflang;
    const href = tag.attrs.href;
    if (!hreflang || !href) continue;

    entries.push({
      lang: hreflang,
      url: href,
      source: "html",
      raw: `<link rel="alternate" hreflang="${hreflang}" href="${href}">`,
    });
  }

  return entries;
}

/** 从 HTTP Link 响应头提取 hreflang */
export function extractFromHttpHeaders(headers: Record<string, string>): HreflangEntry[] {
  const entries: HreflangEntry[] = [];
  const linkHeader = headers["link"] ?? headers["Link"];
  if (!linkHeader) return entries;

  // Link: <url1>; rel="alternate"; hreflang="en", <url2>; ...
  // 参数顺序与额外参数（type/title）都可能变化，不能依赖固定顺序。
  const valueRe = /<([^>]+)>([^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = valueRe.exec(linkHeader)) !== null) {
    const url = m[1];
    const params = m[2] ?? "";
    const rel = /;\s*rel\s*=\s*"?([^";\s]+)"?/i.exec(params)?.[1];
    const lang = /;\s*hreflang\s*=\s*"?([^";\s]+)"?/i.exec(params)?.[1];
    if (!rel || rel.toLowerCase() !== "alternate" || !lang) continue;
    entries.push({
      lang,
      url,
      source: "http-header",
      raw: m[0],
    });
  }

  return entries;
}

/** 从 XML sitemap 提取 hreflang */
export function extractFromSitemap(xml: string): Map<string, HreflangEntry[]> {
  const entries = new Map<string, HreflangEntry[]>();

  // <url><loc>url</loc><xhtml:link rel="alternate" hreflang="en" href="url"/></url>
  const urlRe = /<url>\s*<loc>([^<]+)<\/loc>([\s\S]*?)<\/url>/gi;
  let urlMatch: RegExpExecArray | null;

  while ((urlMatch = urlRe.exec(xml)) !== null) {
    const pageUrl = urlMatch[1].trim();
    const inner = urlMatch[2];
    const pageEntries: HreflangEntry[] = [];

    const linkRe = /<(?:[\w.-]+:)?link\b([^>]*?)\/?>/gi;
    let linkMatch: RegExpExecArray | null;
    while ((linkMatch = linkRe.exec(inner)) !== null) {
      const attrs = parseAttrs(linkMatch[1] ?? "");
      if (attrs.rel?.toLowerCase() !== "alternate") continue;
      if (!attrs.hreflang || !attrs.href) continue;
      pageEntries.push({
        lang: attrs.hreflang,
        // sitemap 里的 href 通常是绝对地址；相对地址也按所在页面解析
        url: absolutize(attrs.href, pageUrl),
        source: "sitemap",
        raw: linkMatch[0],
      });
    }

    if (pageEntries.length > 0) {
      entries.set(pageUrl, pageEntries);
    }
  }

  return entries;
}

/** 从页面输入提取全部 hreflang（HTML + HTTP header） */
export function extractFromPage(page: PageInput): HreflangEntry[] {
  const entries: HreflangEntry[] = [];

  if (page.html) {
    entries.push(...extractFromHtml(page.html));
  }
  if (page.headers) {
    entries.push(...extractFromHttpHeaders(page.headers));
  }

  // 相对 href 先解析成绝对 URL，否则自引用/回链/canonical 检查全部对不上
  return entries.map((e) => ({
    ...e,
    url: absolutize(e.url, page.url),
  }));
}

/** 从 sitemap 输入提取全部 hreflang */
export function extractFromSitemapInput(sitemap: SitemapInput): Map<string, HreflangEntry[]> {
  return extractFromSitemap(sitemap.xml);
}

/** 提取 html lang 属性 */
export function extractHtmlLang(html: string): string | undefined {
  const htmlTag = findTags(html, ["html"])[0];
  return htmlTag?.attrs.lang;
}

/** 提取 canonical */
export function extractCanonical(html: string): string | undefined {
  const linkTags = findTags(html, ["link"]);
  for (const tag of linkTags) {
    if (tag.attrs.rel?.toLowerCase() === "canonical") {
      return tag.attrs.href;
    }
  }
  return undefined;
}

/** 提取 noindex */
export function extractNoindex(html: string): boolean {
  const robots = getMeta(html, "robots");
  return robots?.toLowerCase().includes("noindex") ?? false;
}

/** 提取正文文本（简化：去标签、取前 2000 字符） */
export function extractTextContent(html: string): string {
  // 复用 stripTags 或简单正则
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
}
