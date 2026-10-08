/**
 * 鲸析 GEOkit — Query Intelligence 主入口（T7）
 *
 * 对一个 query，把已有观测汇总成完整 QueryAnalysis：
 *   意图分类 → 相关问题 → 竞品识别 → 内容缺口 → GSC 表现（可选）。
 *
 * 输入字段全可选 —— 缺哪段对应段落标 unavailable，绝不报错。
 * 不调用任何大模型，结论全部来自规则与模板。
 */

import type {
  QueryAnalysisInput,
  QueryAnalysis,
  SourceAvailability,
} from "./types";
import { classifyIntent } from "./intent";
import { extractRelatedQuestions } from "./questions";
import { identifyCompetitors } from "./competitors";
import { findContentGaps } from "./contentGap";

function avail<T>(v: T[] | undefined): SourceAvailability {
  return v && v.length > 0 ? "available" : "unavailable";
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 对单个 query 做完整分析。
 *
 * @param input  QueryAnalysisInput —— 全字段可选
 * @returns QueryAnalysis —— 各段独立，缺数据段落标 unavailable
 */
export function analyzeQuery(input: QueryAnalysisInput): QueryAnalysis {
  const {
    query,
    serpResults,
    aiCitations,
    gscOpportunities,
    userCrawl,
    userDomain,
  } = input;

  const intent = classifyIntent(query, serpResults);
  const relatedQuestions = extractRelatedQuestions(serpResults, aiCitations);
  const competitors = identifyCompetitors(serpResults, aiCitations, userDomain);
  const contentGaps = findContentGaps(serpResults, competitors, userCrawl);

  return {
    query,
    intent,
    relatedQuestions,
    competitors,
    contentGaps,
    sourceAvailability: {
      serp: avail(serpResults),
      ai: avail(aiCitations),
      gsc: avail(gscOpportunities),
      crawl: userCrawl && userCrawl.pages.length > 0 ? "available" : "unavailable",
    },
    gsc: gscOpportunities && gscOpportunities.length > 0 ? gscOpportunities : undefined,
  };
}
