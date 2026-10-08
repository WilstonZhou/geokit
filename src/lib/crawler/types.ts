/**
 * 鲸析 GEOkit — 站点爬虫类型定义（T3）
 *
 * 爬虫的产出是「站点图 + 每页审计摘要 + 截断标记」，作为
 * Observation(kind="crawl") 落库。T4 站点级问题清单依赖此结果。
 */

import type { FetchRequest, FetchResult } from "../fetcher";

/** 可注入的 fetcher —— 集成测试用内存假站点，生产用 fetchWithPolicy */
export type Fetcher = (req: FetchRequest) => Promise<FetchResult>;

/** 爬取硬上限 —— 全部可配置，默认值保守不压目标站点 */
export interface CrawlConfig {
  /** 最大页面数（默认 100） */
  maxPages: number;
  /** 最大点击深度（默认 3，起点为 0） */
  maxDepth: number;
  /** 并发数（默认 2） */
  concurrency: number;
  /** 单请求超时 ms（默认 15000） */
  perPageTimeoutMs: number;
  /** 总耗时上限 ms（默认 120000 = 2 分钟） */
  totalBudgetMs: number;
  /** 是否包含子域（默认 false，仅同域） */
  includeSubdomains: boolean;
  /** 同 host 最小请求间隔 ms（默认 500） */
  minRequestIntervalMs: number;
  /** User-Agent（默认 GEOkitBot/0.1） */
  ua: string;
}

export const DEFAULT_CRAWL_CONFIG: CrawlConfig = {
  maxPages: 100,
  maxDepth: 3,
  concurrency: 2,
  perPageTimeoutMs: 15_000,
  totalBudgetMs: 120_000,
  includeSubdomains: false,
  minRequestIntervalMs: 500,
  ua: "GEOkitBot/0.1 (+https://geokit.dev/bot)",
};

/** 单页爬取结果 —— PageAudit 的子集，只保留站点级聚合需要的字段 */
export interface CrawlPage {
  url: string;
  finalUrl: string;
  httpStatus: number;
  /** 跳转链（不含起点，含终点） */
  redirectChain: string[];
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  canonical: string | null;
  noindex: boolean;
  hreflang: string[];
  jsonLdTypes: string[];
  internalLinks: number;
  externalLinks: number;
  wordCount: number;
  geoScore: number;
  seoScore: number;
  /** GEO 六维明细（T4 共性弱维度分析用，可选） */
  geoBreakdown?: { id: string; label: string; score: number; max: number }[];
  /** 被拦截（403/验证码）时如实标注，不绕过 */
  blocked?: { reason: string };
  /** 本页在站点图中的点击深度（起点为 0） */
  clickDepth: number;
  /** 本页指向的站内规范化 URL 列表 —— 用于构建站点图的边 */
  outLinks: string[];
  /**
   * 正文 n-gram shingle 的短哈希（T4 疑似内容重复检测用）。
   * 刻意只存哈希不存正文：体积小、可落库；空 body / 过短页面为 undefined。
   */
  contentShingles?: string[];
}

export interface GraphNode {
  url: string;
  /** 入链数 */
  inlinks: number;
  /** 从起点到此页的最短点击距离 */
  clickDepth: number;
  /** sitemap 里有但站内无内链指向 —— 孤岛页 */
  orphan: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface SiteGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface CrawlResult {
  origin: string;
  pages: CrawlPage[];
  graph: SiteGraph;
  /** 达到上限时返回已爬结果，标明截断 */
  truncated: boolean;
  reason?: string;
  config: CrawlConfig;
  startedAt: string;
  elapsedMs: number;
}

/** 两次爬取的 diff */
export interface CrawlDiffEntry {
  url: string;
  /** 本次有、上次无 */
  status: "added" | "removed" | "status-changed" | "unchanged";
  prevStatus?: number;
  curStatus?: number;
  prevTitle?: string | null;
  curTitle?: string | null;
}

export interface CrawlDiff {
  added: string[];
  removed: string[];
  statusChanged: CrawlDiffEntry[];
  /** 无变化的页面数 */
  unchangedCount: number;
}
