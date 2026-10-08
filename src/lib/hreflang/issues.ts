/**
 * 鲸析 GEOkit — hreflang 问题接入 T4 SiteIssue 结构（T12）
 *
 * 把 HreflangCheckResult 映射为 T4 的 SiteIssue，统一进入
 * analyzeSiteIssues 输出。
 */

import type { SiteIssue, IssueType } from "../crawler/issues";
import { ISSUE_SEVERITY } from "../crawler/issues";
import type { HreflangCheckResult, HreflangCheckType } from "./types";

/** Hreflang 问题类型 → T4 IssueType */
const TYPE_MAP: Record<HreflangCheckType, IssueType> = {
  "missing-self-reference": "hreflang-missing-self",
  "missing-reciprocal": "hreflang-missing-reciprocal",
  "invalid-lang-code": "hreflang-invalid-lang",
  "broken-target": "hreflang-broken-target",
  "canonical-conflict": "hreflang-canonical-conflict",
  "missing-x-default": "hreflang-missing-x-default",
  "lang-mismatch-suspect": "hreflang-lang-mismatch",
};

/** 把 HreflangCheckResult 转为 SiteIssue */
export function toSiteIssue(result: HreflangCheckResult): SiteIssue {
  return {
    id: `hreflang:${result.type}:${result.affectedUrls.sort().join(",").slice(0, 64)}`,
    type: TYPE_MAP[result.type] ?? result.type,
    severity: result.severity === "high"
      ? ISSUE_SEVERITY.HIGH
      : result.severity === "medium"
        ? ISSUE_SEVERITY.MEDIUM
        : ISSUE_SEVERITY.LOW,
    title: result.title,
    affectedUrls: result.affectedUrls,
    evidence: result.evidence,
    whyItMatters: result.whyItMatters,
    suggestedFix: result.suggestedFix,
  };
}

/** 批量转换 */
export function hreflangIssuesToSiteIssues(
  results: HreflangCheckResult[]
): SiteIssue[] {
  return results.map(toSiteIssue);
}
