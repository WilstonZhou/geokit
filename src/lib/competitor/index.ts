/**
 * 鲸析 GEOkit — 竞品情报（T8）
 *
 * 五维对比：SERP 位次 / AI 提及 / GEO 评分 / AI 抓取协议 / 结构化数据
 * 不做反链对比。聚焦 AI 与 SERP。
 */

export { analyzeCompetitors } from "./analyze";
export { compareSerpPositions } from "./serp";
export { compareAiMentions } from "./ai";
export { compareGeoScores } from "./geo";
export type { GeoAuditSource } from "./geo";
export { compareAiCrawlProtocol } from "./protocol";
export { compareStructuredData } from "./schema";
export { buildGapList } from "./gaps";
export type {
  CompetitorDimension,
  CompetitorStatus,
  CompetitorEvidence,
  DimensionComparison,
  CompetitorDimensionValue,
  CompetitorGap,
  CompetitorInput,
  CompetitorReport,
  GapSeverity,
  SerpComparison,
  AiComparison,
  GeoComparison,
  ProtocolComparison,
  SchemaComparison,
} from "./types";
