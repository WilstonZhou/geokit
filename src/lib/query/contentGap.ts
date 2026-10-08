/**
 * 鲸析 GEOkit — Query 内容缺口分析（T7）
 *
 * 对照用户站点爬取结果（T3），指出"该 query 下竞品都有、用户站点没有"的话题。
 *
 * 判定方式：从竞品 SERP 标题提取话题关键词，检查用户爬取页面的标题是否覆盖。
 * 不调用任何大模型 —— 全部基于关键词匹配，结果可复现。
 */

import type { ContentGap, CompetitorAppearance } from "./types";
import type { SerpResponse } from "../serp";
import type { CrawlResult } from "../crawler/types";

/* ------------------------------------------------------------------ */
/* 话题提取                                                            */
/* ------------------------------------------------------------------ */

/** 中文停用词（避免"如何/为什么"等被当成话题） */
const STOP_WORDS = new Set([
  "的", "了", "是", "在", "和", "与", "或", "及", "或",
  "如何", "怎么", "为什么", "是什么", "什么是", "哪个", "哪款",
  "一个", "可以", "能够", "应该", "需要",
  "best", "the", "a", "an", "of", "to", "for", "and", "or",
  "vs", "对比", "比较", "区别",
  "买", "价格", "优惠", "官网", "登录",
]);

/** 把标题切成有意义的话题关键词（长度 2–8） */
function extractTopics(title: string): string[] {
  if (!title) return [];
  // 简单切分：中英文混合按空格 / 标点切，再按 2-4 字滑窗取候选
  const tokens = title
    .split(/[\s\-—·,，。：:、|｜()（）\[\]【】{}\"''`]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && t.length <= 12 && !STOP_WORDS.has(t.toLowerCase()));
  return tokens;
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 找出该 query 下"竞品都有、用户站点没有"的话题。
 *
 * @param serpResults  SERP 结果（取竞品域名的页面标题）
 * @param competitors  identifyCompetitors 的输出，限定为竞品域名
 * @param userCrawl    用户站点爬取（T3）
 * @returns ContentGap[]，按 competitorCoverage.covered 降序
 */
export function findContentGaps(
  serpResults?: SerpResponse[],
  competitors?: CompetitorAppearance[],
  userCrawl?: CrawlResult
): ContentGap[] {
  if (!serpResults || serpResults.length === 0 || !userCrawl || !competitors || competitors.length === 0) {
    return [];
  }

  // 1. 收集竞品域名集合
  const competitorDomains = new Set(competitors.map((c) => c.domain));

  // 2. 按"话题关键词"聚合竞品 SERP 标题
  //    topic → [{ competitorUrl, title }]
  const topicMap = new Map<string, { competitorUrl: string; title: string; domain: string }[]>();
  for (const serp of serpResults) {
    for (const item of serp.items) {
      const d = (item.domain || "").toLowerCase();
      if (!competitorDomains.has(d)) continue;
      const topics = extractTopics(item.title);
      // 同一标题切出多个 token —— 取前 3 个最有代表性的（首字最长）
      const picked = topics.slice(0, 3);
      for (const t of picked) {
        const arr = topicMap.get(t) ?? [];
        arr.push({ competitorUrl: item.url, title: item.title, domain: d });
        topicMap.set(t, arr);
      }
    }
  }

  // 3. 用户站点标题集合（小写）
  const userTitles = userCrawl.pages
    .map((p) => (p.title ?? "").toLowerCase())
    .filter((t) => t.length > 0);
  if (userTitles.length === 0) {
    // 用户站点没有任何标题 —— 全部都是缺口
  }

  const totalCompetitors = competitors.length;
  const out: ContentGap[] = [];
  for (const [topic, appearances] of topicMap) {
    // 该话题被几个不同竞品域名覆盖
    const uniqueCompetitorDomains = new Set(appearances.map((a) => a.domain));
    const covered = uniqueCompetitorDomains.size;
    // 至少 2 个竞品覆盖才算"普遍缺口"，否则噪声
    if (covered < 2) continue;

    // 用户站点是否覆盖该话题
    const userHas = userTitles.some((t) => t.includes(topic.toLowerCase()));
    let userCoverage: ContentGap["userCoverage"];
    if (!userHas) userCoverage = "none";
    else if (covered >= 3) userCoverage = "partial"; // 竞品有 3+ 个覆盖、用户只有一个标题命中
    else userCoverage = "full";

    // 只输出用户未覆盖或部分覆盖的话题
    if (userCoverage === "full") continue;

    out.push({
      topic,
      competitorCoverage: { covered, total: totalCompetitors },
      userCoverage,
      evidence: appearances.slice(0, 5).map((a) => ({
        competitorUrl: a.competitorUrl,
        title: a.title,
      })),
    });
  }

  return out.sort(
    (a, b) =>
      b.competitorCoverage.covered - a.competitorCoverage.covered ||
      b.evidence.length - a.evidence.length
  );
}

/** 仅供单测：暴露 STOP_WORDS 与 extractTopics 便于断言 */
export const __test = { STOP_WORDS, extractTopics };
