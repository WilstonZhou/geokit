/**
 * 鲸析 GEOkit — 竞品情报核心类型（T8）
 *
 * 不做反链对比。聚焦 AI 与 SERP 五个维度：
 *   1. SERP 位次   多引擎下用户与竞品的平均位次
 *   2. AI 提及     AI 答案里被提及/被引用的频次与位置
 *   3. GEO 评分    关键页面六维 GEO 评分对比
 *   4. AI 抓取协议 robots 对 AI 爬虫策略 + 是否有 llms.txt
 *   5. 结构化数据  JSON-LD 类型覆盖面
 *
 * 抓取失败一律按 blocked/unavailable 在对比表明确标注，不留空、不编造。
 * 所有对比结论必须有 evidence 支撑。
 */

import type { SerpResponse } from "../serp";
import type { CitationRecord } from "../evidence/types";
import type { PageAudit } from "../audit";
import type { RobotsAnalysis, LlmsTxtAnalysis } from "../llms";
import type { CrawlResult } from "../crawler/types";

/* ------------------------------------------------------------------ */
/* 维度与状态                                                          */
/* ------------------------------------------------------------------ */

export type CompetitorDimension = "serp" | "ai" | "geo" | "protocol" | "schema";

export const COMPETITOR_DIMENSIONS: CompetitorDimension[] = [
  "serp",
  "ai",
  "geo",
  "protocol",
  "schema",
];

/**
 * 竞品在某维度上的状态。
 *
 * - available   有可用数据
 * - blocked     抓取被拒/被限流（statusReason 必填）
 * - unavailable 数据源缺失或未传入
 * - error       抓取异常（statusReason 必填）
 */
export type CompetitorStatus = "available" | "blocked" | "unavailable" | "error";

/* ------------------------------------------------------------------ */
/* 证据                                                                */
/* ------------------------------------------------------------------ */

/**
 * 一条对比证据 —— 必须能追溯到具体观测。
 *
 * signal 是信号名（如 "serp.baidu.targetRank"），
 * source 是观测来源（如 "SerpResponse[baidu]"），
 * value 是观测值，note 可选补充说明。
 */
export interface CompetitorEvidence {
  signal: string;
  source: string;
  value?: string | number;
  note?: string;
}

/* ------------------------------------------------------------------ */
/* 各维度值类型                                                        */
/* ------------------------------------------------------------------ */

/** SERP 维度值 —— 用户/竞品在多引擎下的位次 */
export interface SerpComparison {
  averageRank: number | null;
  enginesCovered: number;
  perEngineRanks: { engine: string; rank: number | null }[];
}

/** AI 维度值 —— 用户/竞品在 AI 答案中的提及与引用 */
export interface AiComparison {
  /** 被提及次数（mentionCount） */
  mentionCount: number;
  /** 被引用为来源的次数 */
  citationCount: number;
  /** 引用位置的平均值（1 起），无引用为 null */
  averageCitationPosition: number | null;
  /** 提到过该主体的模型列表 */
  modelsMentioned: string[];
}

/** GEO 维度值 —— 关键页面 GEO 评分 */
export interface GeoComparison {
  averageScore: number;
  pagesAudited: number;
  /** 六维明细（取所有页中均值或首页，便于横向对比） */
  breakdown: { id: string; label: string; score: number; max: number }[];
}

/** AI 抓取协议维度值 —— robots AI 开放度 + llms.txt */
export interface ProtocolComparison {
  aiOpennessScore: number;
  hasLlmsTxt: boolean;
  llmsTxtScore: number;
  /** 被 robots 封禁的 AI 爬虫名 */
  blockedCrawlers: string[];
}

/** 结构化数据维度值 —— JSON-LD 类型覆盖 */
export interface SchemaComparison {
  types: string[];
  typeCount: number;
}

/* ------------------------------------------------------------------ */
/* 单维度对比结果                                                      */
/* ------------------------------------------------------------------ */

/**
 * 某竞品在某一维度上的取值与状态。
 *
 * value 为 null 时 status 必为非 available，statusReason 必填。
 */
export interface CompetitorDimensionValue<T> {
  domain: string;
  value: T | null;
  status: CompetitorStatus;
  statusReason?: string;
  evidence: CompetitorEvidence[];
}

/**
 * 一个维度的完整对比结果。
 *
 * - gap: 用户相对竞品的整体位置
 *   - behind    用户落后于至少一个竞品
 *   - ahead     用户领先于所有竞品
 *   - parity    用户与所有竞品持平（含都无数据）
 *   - incomparable 数据不足以判定（用户或所有竞品数据缺失）
 * - gapDetail: 落后/领先的具体说明
 */
export interface DimensionComparison<T> {
  dimension: CompetitorDimension;
  userValue: T | null;
  userStatus: CompetitorStatus;
  userStatusReason?: string;
  userEvidence: CompetitorEvidence[];
  competitorValues: CompetitorDimensionValue<T>[];
  /** 一句话总结 */
  summary: string;
  gap: "behind" | "ahead" | "parity" | "incomparable";
  gapDetail?: string;
}

/* ------------------------------------------------------------------ */
/* 差距清单                                                            */
/* ------------------------------------------------------------------ */

export type GapSeverity = "high" | "medium" | "low";

/**
 * 一条差距 —— 竞品领先的维度、领先幅度、具体证据。
 *
 * 用于转入 Opportunity Engine：差距即机会。
 */
export interface CompetitorGap {
  dimension: CompetitorDimension;
  description: string;
  evidence: CompetitorEvidence[];
  /** 哪些竞品在该维度领先 */
  affectedCompetitors: string[];
  severity: GapSeverity;
}

/* ------------------------------------------------------------------ */
/* 引擎输入与输出                                                      */
/* ------------------------------------------------------------------ */

/**
 * 竞品情报分析输入 —— 全部可选，缺数据源的维度标 unavailable 不报错。
 *
 * 纯函数维度（serp/ai/schema）不 fetch；
 * async 维度（geo/protocol）仅在无预收集数据时才 fetch。
 */
export interface CompetitorInput {
  userDomain: string;
  /** 1-5 个竞品域名 */
  competitors: string[];
  /** query 列表（SERP/AI 维度用） */
  queries?: string[];
  /** 预收集的 SERP 响应（避免重复抓取） */
  serpResults?: SerpResponse[];
  /** 预收集的 AI 引用记录 */
  aiCitations?: CitationRecord[];
  /** 用户站点关键页面的审计结果 */
  userPageAudits?: PageAudit[];
  /** 竞品关键页面的审计结果（已抓好的） */
  competitorPageAudits?: { domain: string; audits: PageAudit[] }[];
  /** 竞品关键页面 URL（需现场抓取时用） */
  competitorPageUrls?: { domain: string; urls: string[] }[];
  /** 用户站点的 robots 分析（预收集） */
  userRobots?: RobotsAnalysis;
  /** 用户站点的 llms.txt 分析（预收集） */
  userLlmsTxt?: LlmsTxtAnalysis;
  /** 竞品 robots 分析（预收集） */
  competitorRobots?: { domain: string; analysis: RobotsAnalysis }[];
  /** 竞品 llms.txt 分析（预收集） */
  competitorLlmsTxt?: { domain: string; analysis: LlmsTxtAnalysis }[];
  /** 是否允许现场抓取（geo/protocol 维度无预收集数据时） */
  fetchProtocol?: boolean;
  /** 用户站点爬取结果（schema 维度可用） */
  userCrawl?: CrawlResult;
  /** 竞品站点爬取结果（schema 维度可用） */
  competitorCrawls?: { domain: string; crawl: CrawlResult }[];
}

/**
 * 竞品情报完整报告。
 */
export interface CompetitorReport {
  userDomain: string;
  competitors: string[];
  /** 5 个维度的对比结果 */
  dimensions: DimensionComparison<unknown>[];
  /** 差距清单 —— 竞品领先的维度 */
  gaps: CompetitorGap[];
  /** 各数据源可用性 */
  sourceAvailability: Partial<Record<CompetitorDimension, CompetitorStatus>>;
}
