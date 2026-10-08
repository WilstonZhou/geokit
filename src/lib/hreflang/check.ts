/**
 * 鲸析 GEOkit — hreflang 六类检查规则（T12）
 *
 * 纯函数：输入页面数据与 sitemap 数据，输出站点级问题列表。
 * 无多语言配置时返回空数组，不产生误报。
 */

import type {
  HreflangEntry,
  HreflangCheckResult,
  PageInput,
} from "./types";
import { isValidLangCode, normalizeLangCode } from "./types";
import { extractFromPage, extractFromSitemap } from "./extract";

/** 构建 URL → 条目集合映射（合并三种来源） */
function buildEntryMap(
  pages: PageInput[],
  sitemapXml?: string
): Map<string, HreflangEntry[]> {
  const map = new Map<string, HreflangEntry[]>();

  // 页面级来源（HTML + HTTP header）
  for (const page of pages) {
    const entries = extractFromPage(page);
    if (entries.length > 0) {
      map.set(page.url, entries);
    }
  }

  // sitemap 来源
  if (sitemapXml) {
    const sitemapEntries = extractFromSitemap(sitemapXml);
    for (const [url, entries] of sitemapEntries) {
      const existing = map.get(url) ?? [];
      map.set(url, [...existing, ...entries]);
    }
  }

  return map;
}

/** 1. 缺少自引用：页面有 hreflang 但未声明自己 */
export function checkMissingSelfReference(
  pageEntries: Map<string, HreflangEntry[]>
): HreflangCheckResult[] {
  const affected: string[] = [];
  const evidence: { fact: string; value?: string }[] = [];

  for (const [url, entries] of pageEntries) {
    const langs = new Set(entries.map((e) => e.lang));
    const hasSelf = entries.some((e) => e.url === url && e.lang !== "x-default");
    if (!hasSelf && langs.size > 0) {
      affected.push(url);
      evidence.push({
        fact: `页面声明了 ${langs.size} 个语言版本，但未包含自身`,
        value: url,
      });
    }
  }

  if (affected.length === 0) return [];

  return [{
    type: "missing-self-reference",
    severity: "high",
    title: "hreflang 缺少自引用",
    affectedUrls: affected,
    evidence,
    whyItMatters: "Google 要求每个语言版本必须包含指向自身的 hreflang，否则会被忽略",
    suggestedFix: "在每个页面的 hreflang 声明中添加指向自身的条目",
  }];
}

/** 2. 缺少回链：A 指向 B，但 B 未指回 A */
export function checkMissingReciprocal(
  pageEntries: Map<string, HreflangEntry[]>
): HreflangCheckResult[] {
  const affected: string[] = [];
  const evidence: { fact: string; value?: string }[] = [];

  for (const [url, entries] of pageEntries) {
    for (const entry of entries) {
      if (entry.lang === "x-default") continue;
      const targetEntries = pageEntries.get(entry.url);
      if (!targetEntries) {
        // 目标页面不在爬取范围内，无法验证回链
        continue;
      }
      // 回链：B 页面有指向 A 页面 URL 的条目即可（不强制 lang 匹配）
      const hasReciprocal = targetEntries.some((e) => e.url === url);
      if (!hasReciprocal) {
        affected.push(url);
        evidence.push({
          fact: `${url} 声明了 ${entry.lang} 版本 ${entry.url}，但该页面未回链`,
          value: entry.url,
        });
      }
    }
  }

  if (affected.length === 0) return [];

  return [{
    type: "missing-reciprocal",
    severity: "high",
    title: "hreflang 缺少回链",
    affectedUrls: [...new Set(affected)],
    evidence,
    whyItMatters: "Google 要求语言版本之间必须有双向回链，否则会被忽略",
    suggestedFix: "确保每个语言版本页面都包含指向其他所有语言版本的 hreflang",
  }];
}

/** 3. 语言/地区代码非法 */
export function checkInvalidLangCode(
  pageEntries: Map<string, HreflangEntry[]>
): HreflangCheckResult[] {
  const affected: string[] = [];
  const evidence: { fact: string; value?: string }[] = [];

  for (const [url, entries] of pageEntries) {
    for (const entry of entries) {
      if (!isValidLangCode(entry.lang)) {
        affected.push(url);
        evidence.push({
          fact: `语言代码 "${entry.lang}" 不符合 BCP 47 规范`,
          value: entry.lang,
        });
      }
    }
  }

  if (affected.length === 0) return [];

  return [{
    type: "invalid-lang-code",
    severity: "medium",
    title: "hreflang 语言代码非法",
    affectedUrls: [...new Set(affected)],
    evidence,
    whyItMatters: "非法的语言代码会被搜索引擎忽略，导致国际化配置失效",
    suggestedFix: "使用 BCP 47 标准语言代码（如 zh-CN、en-US）",
  }];
}

/** 4. 指向 4xx/跳转/noindex 页面 */
export function checkBrokenTarget(
  pageEntries: Map<string, HreflangEntry[]>,
  pages: PageInput[]
): HreflangCheckResult[] {
  const pageMap = new Map(pages.map((p) => [p.url, p]));
  const affected: string[] = [];
  const evidence: { fact: string; value?: string | number }[] = [];

  for (const [url, entries] of pageEntries) {
    for (const entry of entries) {
      const targetPage = pageMap.get(entry.url);
      if (!targetPage) continue;

      if (targetPage.httpStatus && targetPage.httpStatus >= 400) {
        affected.push(url);
        evidence.push({
          fact: `目标页面返回 ${targetPage.httpStatus}`,
          value: entry.url,
        });
      } else if (targetPage.noindex) {
        affected.push(url);
        evidence.push({
          fact: `目标页面有 noindex 标记`,
          value: entry.url,
        });
      } else if (targetPage.redirectChain && targetPage.redirectChain.length > 0) {
        affected.push(url);
        evidence.push({
          fact: `目标页面经过 ${targetPage.redirectChain.length} 次跳转`,
          value: entry.url,
        });
      }
    }
  }

  if (affected.length === 0) return [];

  return [{
    type: "broken-target",
    severity: "high",
    title: "hreflang 指向无效页面",
    affectedUrls: [...new Set(affected)],
    evidence,
    whyItMatters: "指向 4xx、跳转或 noindex 页面的 hreflang 会被搜索引擎忽略",
    suggestedFix: "确保 hreflang 目标页面可索引且返回 200",
  }];
}

/** 5. 与 canonical 冲突：hreflang 指向的 URL 与 canonical 不一致 */
export function checkCanonicalConflict(
  pageEntries: Map<string, HreflangEntry[]>,
  pages: PageInput[]
): HreflangCheckResult[] {
  const pageMap = new Map(pages.map((p) => [p.url, p]));
  const affected: string[] = [];
  const evidence: { fact: string; value?: string }[] = [];

  for (const [url, entries] of pageEntries) {
    for (const entry of entries) {
      const targetPage = pageMap.get(entry.url);
      if (!targetPage?.canonical) continue;

      if (targetPage.canonical !== entry.url) {
        affected.push(url);
        evidence.push({
          fact: `hreflang 指向 ${entry.url}，但该页 canonical 为 ${targetPage.canonical}`,
          value: entry.url,
        });
      }
    }
  }

  if (affected.length === 0) return [];

  return [{
    type: "canonical-conflict",
    severity: "medium",
    title: "hreflang 与 canonical 冲突",
    affectedUrls: [...new Set(affected)],
    evidence,
    whyItMatters: "hreflang 目标 URL 应与该页面的 canonical URL 一致，否则会被忽略",
    suggestedFix: "确保 hreflang 指向的 URL 与目标页面的 canonical 一致",
  }];
}

/** 6. x-default 缺失（severity=low，建议性） */
export function checkMissingXDefault(
  pageEntries: Map<string, HreflangEntry[]>
): HreflangCheckResult[] {
  const affected: string[] = [];
  const evidence: { fact: string }[] = [];

  for (const [url, entries] of pageEntries) {
    const hasXDefault = entries.some((e) => e.lang === "x-default");
    if (!hasXDefault && entries.length > 0) {
      affected.push(url);
      evidence.push({
        fact: `页面有 ${entries.length} 个语言版本声明，但缺少 x-default`,
      });
    }
  }

  if (affected.length === 0) return [];

  return [{
    type: "missing-x-default",
    severity: "low",
    title: "建议补充 x-default",
    affectedUrls: affected,
    evidence,
    whyItMatters: "x-default 告诉搜索引擎当用户语言不匹配时默认使用哪个版本",
    suggestedFix: "在 hreflang 声明中添加 x-default 指向默认语言版本",
  }];
}

/** 7. 语言声明与内容不一致（规则驱动，标注为「疑似」） */
export function checkLangMismatch(
  pages: PageInput[]
): HreflangCheckResult[] {
  const affected: string[] = [];
  const evidence: { fact: string; value?: string | number }[] = [];

  for (const page of pages) {
    if (!page.htmlLang || !page.textContent) continue;

    const declaredLang = normalizeLangCode(page.htmlLang);
    const text = page.textContent;

    // CJK 字符占比检测
    const cjkCount = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) ?? []).length;
    const cjkRatio = text.length > 0 ? cjkCount / text.length : 0;

    // 疑似规则：声明为中文但 CJK 占比 < 10%，或声明为英文但 CJK 占比 > 30%
    let suspect = false;
    let reason = "";

    if (declaredLang.startsWith("zh") && cjkRatio < 0.1) {
      suspect = true;
      reason = `声明为 ${declaredLang}，但 CJK 字符占比仅 ${(cjkRatio * 100).toFixed(1)}%`;
    } else if (declaredLang.startsWith("en") && cjkRatio > 0.3) {
      suspect = true;
      reason = `声明为 ${declaredLang}，但 CJK 字符占比高达 ${(cjkRatio * 100).toFixed(1)}%`;
    }

    if (suspect) {
      affected.push(page.url);
      evidence.push({
        fact: `疑似语言声明与内容不一致：${reason}`,
        value: page.htmlLang,
      });
    }
  }

  if (affected.length === 0) return [];

  return [{
    type: "lang-mismatch-suspect",
    severity: "low",
    title: "疑似语言声明与内容不一致",
    affectedUrls: affected,
    evidence,
    whyItMatters: "语言声明与实际内容不符会影响搜索引擎对页面语言的理解",
    suggestedFix: "检查 html lang 属性是否准确反映页面内容语言",
  }];
}

/** 站点级 hreflang 分析主入口 */
export function analyzeHreflang(
  pages: PageInput[],
  sitemapXml?: string
): {
  isMultilingual: boolean;
  issues: HreflangCheckResult[];
  pageEntries: Map<string, HreflangEntry[]>;
} {
  const pageEntries = buildEntryMap(pages, sitemapXml);
  const isMultilingual = pageEntries.size > 0;

  // 无任何 hreflang 配置且无任何语言声明信号 → 完全不适用
  const hasLangSignal = pages.some((p) => p.htmlLang || p.textContent);
  if (!isMultilingual && !hasLangSignal) {
    return {
      isMultilingual: false,
      issues: [],
      pageEntries,
    };
  }

  const issues: HreflangCheckResult[] = [];

  // hreflang 相关检查仅在多语言配置时启用
  if (isMultilingual) {
    issues.push(
      ...checkMissingSelfReference(pageEntries),
      ...checkMissingReciprocal(pageEntries),
      ...checkInvalidLangCode(pageEntries),
      ...checkBrokenTarget(pageEntries, pages),
      ...checkCanonicalConflict(pageEntries, pages),
      ...checkMissingXDefault(pageEntries),
    );
  }

  // lang-mismatch 独立于 hreflang：页面有 htmlLang + textContent 即可检测
  issues.push(...checkLangMismatch(pages));

  return {
    isMultilingual,
    issues,
    pageEntries,
  };
}
