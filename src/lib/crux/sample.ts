/**
 * 鲸析 GEOkit — 页面类型性能观测智能抽样（Sprint 3 任务 3.1）
 *
 * 目标：告别「地毯式 API 轰炸」，从爬虫抓取到的全站页面中，
 * 复用 Schema 模块的 detectPageType 规则，按代表性页面类型进行智能抽样：
 *   - 最多 1 个 homepage
 *   - 最多 2 个 article
 *   - 最多 2 个 product/landing
 *   - 总数控制在 5 个页面以内，组成待观测队列。
 */

import type { CrawlPage } from "../crawler/types";
import { detectPageType } from "../schema/detect";
import type { PageFacts } from "../schema/extract";

/** 从 CrawlPage 组装最小可用的 PageFacts 供 detectPageType 判定 */
function crawlPageToFacts(page: CrawlPage): PageFacts {
  return {
    url: page.url,
    title: page.title,
    description: page.metaDescription,
    h1: page.h1,
    headings: page.h1 ? [{ level: 1, text: page.h1 }] : [],
    wordCount: page.wordCount,
    jsonLdNodes: (page.jsonLdTypes ?? []).map((t) => ({ types: [t], node: { "@type": t } })),
    rootTypes: page.jsonLdTypes ?? [],
    publishedRaw: null,
    modifiedRaw: null,
    publishedDate: null,
    modifiedDate: null,
    ogImage: null,
    author: null,
    ogSiteName: null,
    visibleDates: [],
    qaPairs: [],
    steps: [],
    prices: [],
    hasBuyAction: false,
    socialLinks: [],
    addressHints: [],
    hasSearchAction: false,
    tel: [],
    mailto: [],
    allMeta: {},
  };
}

/**
 * 从爬虫结果页面中按类型智能抽样性能观测页面队列。
 *
 * @param pages  爬虫输出的 CrawlPage 数组
 * @returns 待观测的 CrawlPage 队列（最多 1 个 homepage，最多 2 个 article，最多 2 个 product/landing，总量 ≤ 5）
 */
export function samplePagesForPerformance(pages: CrawlPage[]): CrawlPage[] {
  // 排除被拦截（403等）以及非 200 的失败页面
  const candidates = pages.filter((p) => !p.blocked && p.httpStatus === 200);

  const homepages: CrawlPage[] = [];
  const articles: CrawlPage[] = [];
  const productLandings: CrawlPage[] = [];

  for (const page of candidates) {
    const facts = crawlPageToFacts(page);
    const detection = detectPageType(facts);

    const isHome =
      detection.type === "website" ||
      (() => {
        try {
          const path = new URL(page.url).pathname;
          return path === "" || path === "/";
        } catch {
          return false;
        }
      })();

    if (isHome) {
      homepages.push(page);
    } else if (detection.type === "article") {
      articles.push(page);
    } else if (
      detection.type === "product" ||
      detection.type === "local-business" ||
      detection.type === "howto"
    ) {
      productLandings.push(page);
    }
  }

  // 约束规则：最多 1 个 homepage，最多 2 个 article，最多 2 个 product/landing
  const sampled: CrawlPage[] = [
    ...homepages.slice(0, 1),
    ...articles.slice(0, 2),
    ...productLandings.slice(0, 2),
  ];

  // 总数严格控制在 5 个页面以内
  return sampled.slice(0, 5);
}

