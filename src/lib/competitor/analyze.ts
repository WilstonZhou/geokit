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

export async function analyzeCompetitors(
  input: CompetitorInput
): Promise<CompetitorReport> {
  const { userDomain, competitors, fetchProtocol } = input;

  // ── 维度 1：SERP 位次（纯函数） ──
  const serpDim = compareSerpPositions(
    input.serpResults ?? [],
    userDomain,
    competitors
  );

  // ── 维度 2：AI 提及/引用（纯函数） ──
  const aiDim = compareAiMentions(
    input.aiCitations ?? [],
    userDomain,
    competitors
  );

  // ── 维度 3：GEO 评分（async） ──
  const userGeoSources: GeoAuditSource[] = input.userPageAudits ?? (input.userCrawl ? crawlToGeoSources(input.userCrawl) : []);
  const competitorGeoAudits = input.competitorPageAudits?.map((ca) => ({
    domain: ca.domain,
    audits: ca.audits,
  })) ?? [];
  // 如果竞品 crawl 数据可用，也转为 geo sources
  const competitorCrawlGeo = input.competitorCrawls?.map((cc) => ({
    domain: cc.domain,
    audits: crawlToGeoSources(cc.crawl),
  })) ?? [];
  // 合并预收集的 audits 和 crawl-derived sources
  const mergedGeoCompetitors = [...competitorGeoAudits, ...competitorCrawlGeo];
  const geoDim = await compareGeoScores(userDomain, competitors, {
    userAudits: userGeoSources,
    competitorAudits: mergedGeoCompetitors,
    competitorUrls: input.competitorPageUrls,
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
  const userSchemaSources = input.userPageAudits ?? (input.userCrawl ? crawlToSchemaSources(input.userCrawl) : []);
  const competitorSchemaSources = [
    ...(input.competitorPageAudits?.map((ca) => ({
      domain: ca.domain,
      sources: ca.audits,
    })) ?? []),
    ...(input.competitorCrawls?.map((cc) => ({
      domain: cc.domain,
      sources: crawlToSchemaSources(cc.crawl),
    })) ?? []),
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
