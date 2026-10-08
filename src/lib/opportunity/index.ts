/**
 * 鲸析 GEOkit — Opportunity Engine 入口（T6）
 *
 * 公共 API：generateOpportunities / rankOpportunities / mergeByTarget /
 * verifyOpportunity / verifyOpportunities / countByType + 类型导出。
 */

export * from "./types";
export {
  genWeakCiteability,
  genCitationGap,
  genAiCrawlProtocol,
  genSiteIssueHigh,
  genSearchOpportunity,
  genMissingEntity,
  makeOpportunityId,
} from "./generators";
export {
  generateOpportunities,
  rankOpportunities,
  mergeByTarget,
  countByType,
  IMPACT_RANK,
  EFFORT_RANK,
} from "./engine";
export {
  verifyOpportunity,
  verifyOpportunities,
} from "./verify";
