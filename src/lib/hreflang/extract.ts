/**
 * 鲸析 GEOkit — hreflang 三种来源提取（T12）
 *
 * 1. HTML <link rel="alternate" hreflang="..." href="...">
 * 2. HTTP Link 响应头（Link: <url>; rel="alternate"; hreflang="..."）
 * 3. XML sitemap <xhtml:link rel="alternate" hreflang="..." href="...">
 */

import { findTags, getMeta } from "../html";
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

  // Link: <url1>; rel="alternate"; hreflang="en", <url2>; rel="alternate"; hreflang="zh-CN"
  const linkRe = /<([^>]+)>\s*;\s*rel="alternate"\s*;\s*hreflang="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(linkHeader)) !== null) {
    entries.push({
      lang: m[2],
      url: m[1],
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

    const linkRe = /<xhtml:link\s+rel="alternate"\s+hreflang="([^"]+)"\s+href="([^"]+)"\s*\/>/gi;
    let linkMatch: RegExpExecArray | null;
    while ((linkMatch = linkRe.exec(inner)) !== null) {
      pageEntries.push({
        lang: linkMatch[1],
        url: linkMatch[2],
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

  return entries;
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
