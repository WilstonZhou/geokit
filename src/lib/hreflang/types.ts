/**
 * 鲸析 GEOkit — hreflang 国际化检查类型定义（T12）
 *
 * 三种来源统一建模：
 *   1. HTML <link rel="alternate" hreflang="..." href="...">
 *   2. HTTP Link 响应头（Link: <url>; rel="alternate"; hreflang="..."）
 *   3. XML sitemap <xhtml:link rel="alternate" hreflang="..." href="...">
 *
 * 与爬虫解耦：调用方准备页面数据（html / headers / sitemapXml），
 * 本模块只做纯函数解析与规则检查。
 */

/** hreflang 条目来源 */
export type HreflangSource = "html" | "http-header" | "sitemap";

/** 单条 hreflang 声明 */
export interface HreflangEntry {
  /** 语言代码（如 zh-CN、en、x-default） */
  lang: string;
  /** 目标 URL */
  url: string;
  /** 来源 */
  source: HreflangSource;
  /** 原始文本（调试用） */
  raw?: string;
}

/** 页面级输入（调用方准备） */
export interface PageInput {
  /** 页面 URL */
  url: string;
  /** HTML 原文 */
  html?: string;
  /** HTTP 响应头（仅 Link 头相关） */
  headers?: Record<string, string>;
  /** canonical URL（从 HTML 解析） */
  canonical?: string;
  /** noindex 标记 */
  noindex?: boolean;
  /** HTTP 状态码（4xx/5xx 用于检测坏链） */
  httpStatus?: number;
  /** 跳转链（最终 URL 用于检测跳转） */
  redirectChain?: string[];
  /** html lang 属性 */
  htmlLang?: string;
  /** 正文文本（用于语言检测） */
  textContent?: string;
}

/** Sitemap 级输入 */
export interface SitemapInput {
  /** sitemap XML 原文 */
  xml: string;
  /** sitemap URL */
  url: string;
}

/** 检查类型 */
export const HREFLANG_CHECK_TYPES = [
  "missing-self-reference",
  "missing-reciprocal",
  "invalid-lang-code",
  "broken-target",
  "canonical-conflict",
  "missing-x-default",
  "lang-mismatch-suspect",
] as const;

export type HreflangCheckType = (typeof HREFLANG_CHECK_TYPES)[number];

/** 检查结果 */
export interface HreflangCheckResult {
  type: HreflangCheckType;
  severity: "high" | "medium" | "low";
  /** 一句话问题概述 */
  title: string;
  /** 受影响页面 URL 列表 */
  affectedUrls: string[];
  /** 证据（具体事实） */
  evidence: { fact: string; value?: string | number }[];
  /** 为什么影响 SEO/GEO */
  whyItMatters: string;
  /** 建议修复 */
  suggestedFix: string;
}

/** 站点级 hreflang 分析结果 */
export interface HreflangAnalysis {
  /** 是否为多语言站点（任一页面有 hreflang 声明） */
  isMultilingual: boolean;
  /** 站点级问题列表 */
  issues: HreflangCheckResult[];
  /** 每页 hreflang 声明汇总（调试用） */
  pageEntries: Map<string, HreflangEntry[]>;
}

/** 语言代码合法性（简化版：BCP 47 常见子集） */
export const VALID_LANG_CODES = new Set([
  "zh", "zh-CN", "zh-TW", "zh-HK",
  "en", "en-US", "en-GB", "en-AU", "en-CA",
  "ja", "ja-JP",
  "ko", "ko-KR",
  "fr", "fr-FR", "fr-CA",
  "de", "de-DE",
  "es", "es-ES", "es-MX",
  "pt", "pt-BR", "pt-PT",
  "ru", "ru-RU",
  "ar", "ar-SA",
  "it", "it-IT",
  "nl", "nl-NL",
  "pl", "pl-PL",
  "tr", "tr-TR",
  "vi", "vi-VN",
  "th", "th-TH",
  "id", "id-ID",
  "ms", "ms-MY",
  "x-default",
]);

/** 语言代码合法性检查（宽松：结构合法即可，不强制枚举） */
export function isValidLangCode(code: string): boolean {
  if (code === "x-default") return true;
  // BCP 47 简化：2-3 字母语言码 + 可选 2 字母地区码
  return /^[a-z]{2,3}(-[A-Z]{2})?$/i.test(code);
}

/** 语言代码规范化（小写-大写） */
export function normalizeLangCode(code: string): string {
  if (code === "x-default") return code;
  const parts = code.split("-");
  if (parts.length === 2) {
    return `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`;
  }
  return code.toLowerCase();
}

/** 从 URL 提取语言路径前缀（如 /zh-CN/、/en/） */
export function extractLangFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const match = u.pathname.match(/^\/([a-z]{2,3}(?:-[A-Z]{2})?)(?:\/|$)/i);
    return match ? normalizeLangCode(match[1]) : null;
  } catch {
    return null;
  }
}
