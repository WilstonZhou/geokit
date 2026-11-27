/**
 * 鲸析 GEOkit — 竞品情报分析主入口（T8）
 *
 * 编排 5 个维度的对比：
 *   1. SERP 位次（纯函数）  2. AI 提及（纯函数）  3. GEO 评分（async）
 *   4. AI 抓取协议（async）  5. 结构化数据（纯函数）
 *
 * 纯函数维度不 fetch；async 维度仅在无预收集数据时才 fetch。
 * 缺数据源的维度标 unavailable 不报错。
 */

import type { CrawlResult } from "../crawler/types";
import type { CompetitorInput, CompetitorReport, DimensionComparison, CompetitorStatus, CompetitorDimension } from "./types";
import { compareSerpPositions } from "./serp";
import { compareAiMentions } from "./ai";
import { compareGeoScores, type GeoAuditSource } from "./geo";
import { compareAiCrawlProtocol } from "./protocol";
import { compareStructuredData } from "./schema";
import { buildGapList } from "./gaps";

/** 从 CrawlPage 提取 GEO 维度所需的最小字段 */
function crawlToGeoSources(crawl: CrawlResult): GeoAuditSource[] {
  return crawl.pages
    .filter((p) => !p.blocked)
    .map((p) => ({
      url: p.url,
      httpStatus: p.httpStatus,
      geoScore: p.geoScore,
      geoBreakdown: p.geoBreakdown,
    }));
}

/** 从 CrawlPage 提取 Schema 维度所需的最小字段 */
function crawlToSchemaSources(crawl: CrawlResult): { jsonLdTypes: string[] }[] {
  return crawl.pages.map((p) => ({ jsonLdTypes: p.jsonLdTypes ?? [] }));
}

/**
 * 输入硬上限。
 *
 * 竞品维度的现场抓取是 `Promise.all`：调用方传几千个 URL 会同时发起几千个
 * 请求。这里在业务入口统一收口，HTTP / MCP / 库调用三条路径都无法绕过。
 */
const MAX_COMPETITORS = 5;
const MAX_SERP_RESULTS = 50;
const MAX_AI_CITATIONS = 500;
const MAX_PAGE_AUDITS = 200;
const MAX_URLS_PER_COMPETITOR = 10;

function cap<T>(arr: T[] | undefined, max: number): T[] {
  return (arr ?? []).slice(0, max);
}

export async function analyzeCompetitors(
  input: CompetitorInput
): Promise<CompetitorReport> {
  const userDomain = input.userDomain;
  const competitors = Array.from(new Set(input.competitors)).slice(
    0,
    MAX_COMPETITORS
  );
  const fetchProtocol = input.fetchProtocol;
  const serpResults = cap(input.serpResults, MAX_SERP_RESULTS);
  const aiCitations = cap(input.aiCitations, MAX_AI_CITATIONS);
  const userPageAudits = cap(input.userPageAudits, MAX_PAGE_AUDITS);
  const competitorPageAudits = cap(input.competitorPageAudits, MAX_COMPETITORS).map(
    (ca) => ({ ...ca, audits: cap(ca.audits, MAX_PAGE_AUDITS) })
  );
  const competitorPageUrls = cap(input.competitorPageUrls, MAX_COMPETITORS).map(
    (cu) => ({ ...cu, urls: cap(cu.urls, MAX_URLS_PER_COMPETITOR) })
  );
  const competitorCrawls = cap(input.competitorCrawls, MAX_COMPETITORS);

  // ── 维度 1：SERP 位次（纯函数） ──
  const serpDim = compareSerpPositions(serpResults, userDomain, competitors);

  // ── 维度 2：AI 提及/引用（纯函数） ──
  const aiDim = compareAiMentions(aiCitations, userDomain, competitors);

  // ── 维度 3：GEO 评分（async） ──
  const userGeoSources: GeoAuditSource[] =
    userPageAudits.length > 0
      ? userPageAudits
      : input.userCrawl
        ? crawlToGeoSources(input.userCrawl).slice(0, MAX_PAGE_AUDITS)
        : [];
  const competitorGeoAudits = competitorPageAudits.map((ca) => ({
    domain: ca.domain,
    audits: ca.audits,
  }));
  // 如果竞品 crawl 数据可用，也转为 geo sources
  const competitorCrawlGeo = competitorCrawls.map((cc) => ({
    domain: cc.domain,
    audits: crawlToGeoSources(cc.crawl).slice(0, MAX_PAGE_AUDITS),
  }));
  // 合并预收集的 audits 和 crawl-derived sources
  const mergedGeoCompetitors = [...competitorGeoAudits, ...competitorCrawlGeo];
  const geoDim = await compareGeoScores(userDomain, competitors, {
    userAudits: userGeoSources,
    competitorAudits: mergedGeoCompetitors,
    competitorUrls: competitorPageUrls,
    fetchProtocol,
  });

  // ── 维度 4：AI 抓取协议（async） ──
  const protocolDim = await compareAiCrawlProtocol(userDomain, competitors, {
    userRobots: input.userRobots,
    userLlmsTxt: input.userLlmsTxt,
    competitorRobots: input.competitorRobots,
    competitorLlmsTxt: input.competitorLlmsTxt,
    fetchProtocol,
  });

  // ── 维度 5：结构化数据（纯函数） ──
  const userSchemaSources =
    userPageAudits.length > 0
      ? userPageAudits
      : input.userCrawl
        ? crawlToSchemaSources(input.userCrawl).slice(0, MAX_PAGE_AUDITS)
        : [];
  const competitorSchemaSources = [
    ...competitorPageAudits.map((ca) => ({
      domain: ca.domain,
      sources: ca.audits,
    })),
    ...competitorCrawls.map((cc) => ({
      domain: cc.domain,
      sources: crawlToSchemaSources(cc.crawl).slice(0, MAX_PAGE_AUDITS),
    })),
  ];
  const schemaDim = compareStructuredData(userSchemaSources, competitorSchemaSources);

  // ── 组装报告 ──
  const dimensions: DimensionComparison<unknown>[] = [
    serpDim,
    aiDim,
    geoDim,
    protocolDim,
    schemaDim,
  ];

  const gaps = buildGapList(dimensions);

  // 数据源可用性
  const sourceAvailability: Partial<Record<CompetitorDimension, CompetitorStatus>> = {
    serp: serpDim.userStatus,
    ai: aiDim.userStatus,
    geo: geoDim.userStatus,
    protocol: protocolDim.userStatus,
    schema: schemaDim.userStatus,
  };

  return {
    userDomain,
    competitors,
    dimensions,
    gaps,
    sourceAvailability,
  };
}
