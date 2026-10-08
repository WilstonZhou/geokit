/**
 * 鲸析 GEOkit — Query Intelligence 核心类型（T7）
 *
 * 目标不是搜索量/KD，而是：
 *   Query → SERP → 搜索意图 → 实体/问题 → 竞品 → AI 答案 → 引用来源 → 内容缺口。
 *
 * 所有分析都是纯函数 + 规则驱动，不调用任何大模型。
 * 缺数据源时对应段落标 `unavailable`，绝不编造。
 */

import type { SerpResponse } from "../serp";
import type { CitationRecord } from "../evidence/types";
import type { GscOpportunity } from "../gsc/types";
import type { CrawlResult } from "../crawler/types";

/* ------------------------------------------------------------------ */
/* 意图分类                                                            */
/* ------------------------------------------------------------------ */

/** 五种搜索意图 —— 任务书明确要求，规则驱动判定 */
export type QueryIntent =
  | "informational" // 信息型：怎么/为什么/是什么
  | "comparative" // 对比型：vs/对比/区别/哪个好
  | "transactional" // 交易型：买/价格/优惠/下单
  | "local" // 本地型：附近/在哪/地址
  | "navigational"; // 导航型：品牌词/官网/登录

export type IntentConfidence = "high" | "medium" | "low";

/**
 * 意图分类结果。
 *
 * basis 必须列出触发规则的依据，让结论可追溯、可调试。
 * 当置信度低于 high 时建议看 basis 决定是否人工复核。
 */
export interface IntentClassification {
  intent: QueryIntent;
  confidence: IntentConfidence;
  /** 触发依据，每条说明哪个规则命中（query 文本特征 / SERP 结构特征） */
  basis: string[];
}

/* ------------------------------------------------------------------ */
/* 相关问题                                                            */
/* ------------------------------------------------------------------ */

/**
 * 从 SERP 标题 / AI 答案中提取的"相关问题"候选。
 *
 * 铁律：不得编造 —— 只能从实际观测到的文本中提取。
 * sources 标明每条问题的来源（serp:engine:pos=N 或 ai:model:answer）。
 */
export interface RelatedQuestion {
  question: string;
  /** 来源标签，如 "serp:baidu:pos=3" 或 "ai:gpt-4o:answer" */
  sources: string[];
}

/* ------------------------------------------------------------------ */
/* 竞品识别                                                            */
/* ------------------------------------------------------------------ */

/**
 * SERP 与 AI 答案里反复出现的域名/品牌。
 *
 * - serpCount/serpPositions 来自 SERP 结果
 * - aiMentionCount 来自 AI 引用 URL 的域名统计
 * - source 标明主要来源（serp / ai / both）
 */
export interface CompetitorAppearance {
  domain: string;
  serpCount: number;
  serpPositions: number[];
  aiMentionCount: number;
  source: "serp" | "ai" | "both";
}

/* ------------------------------------------------------------------ */
/* 内容缺口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 对照用户站点爬取结果（T3），指出"该 query 下竞品都有、用户站点没有"的话题。
 *
 * - topic: 该 query 下的子话题关键词（来自竞品 SERP 标题）
 * - competitorCoverage: N 个竞品中有 M 个覆盖了该话题
 * - userCoverage: 用户站点对该话题的覆盖情况
 * - evidence: 具体的竞品 URL 与标题，可追溯
 */
export interface ContentGap {
  topic: string;
  competitorCoverage: { covered: number; total: number };
  userCoverage: "none" | "partial" | "full";
  evidence: { competitorUrl: string; title: string }[];
}

/* ------------------------------------------------------------------ */
/* Query 聚类                                                          */
/* ------------------------------------------------------------------ */

/**
 * 基于共享 SERP 结果 URL 重合度的聚类。
 *
 * 两个 query 的 SERP URL 集合 Jaccard ≥ 阈值（默认 0.3）或共享 ≥ 2 条 URL
 * 时归为同一簇。簇内共享的 URL 列在 sharedUrls 里。
 */
export interface QueryCluster {
  /** 稳定 id：成员 query 的 sha1 短哈希 */
  id: string;
  queries: string[];
  /** 簇内任意两 query 的平均 Jaccard 重合度 */
  overlapScore: number;
  /** 簇内至少两 query 共享的 SERP URL */
  sharedUrls: string[];
}

/* ------------------------------------------------------------------ */
/* 数据源可用性                                                        */
/* ------------------------------------------------------------------ */

/**
 * 每段输入数据的可用性。
 *
 * - available: 数据已传入且非空
 * - unavailable: 数据缺失或为空 —— 对应分析段落跳过，不报错
 */
export type SourceAvailability = "available" | "unavailable";

/* ------------------------------------------------------------------ */
/* 引擎输入与输出                                                      */
/* ------------------------------------------------------------------ */

/**
 * 单 query 分析输入 —— 全部可选，缺哪段跳过对应段落，绝不报错。
 */
export interface QueryAnalysisInput {
  query: string;
  /** 多引擎 SERP 响应（已有观测可直接传入） */
  serpResults?: SerpResponse[];
  /** T2 AI 引用记录 */
  aiCitations?: CitationRecord[];
  /** T5 GSC 机会（可选） */
  gscOpportunities?: GscOpportunity[];
  /** T3 用户站点爬取结果，内容缺口分析用 */
  userCrawl?: CrawlResult;
  /** 用户域名，用于排除"自家"结果 */
  userDomain?: string;
}

/**
 * 单 query 完整分析结果。
 */
export interface QueryAnalysis {
  query: string;
  intent: IntentClassification;
  relatedQuestions: RelatedQuestion[];
  competitors: CompetitorAppearance[];
  contentGaps: ContentGap[];
  /** 各数据源可用性，便于 UI 标 unavailable */
  sourceAvailability: {
    serp: SourceAvailability;
    ai: SourceAvailability;
    gsc: SourceAvailability;
    crawl: SourceAvailability;
  };
  /** GSC 表现（可选传入则原样回显便于 UI 展示） */
  gsc?: GscOpportunity[];
}

/**
 * 聚类输入 —— 多个 query 各自的 SERP 结果。
 */
export interface QueryClusterInput {
  query: string;
  serpResults: SerpResponse[];
}

/**
 * 聚类参数。
 */
export interface ClusterOptions {
  /** Jaccard 阈值，默认 0.3 */
  jaccardThreshold?: number;
  /** 共享 URL 数下限（达到即归同簇，默认 2） */
  minSharedUrls?: number;
}
