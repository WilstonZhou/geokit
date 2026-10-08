/**
 * 鲸析 GEOkit — 竞品差距清单聚合（T8）
 *
 * 从 5 个维度的 DimensionComparison 提取 gap="behind" 的维度，
 * 组装成 CompetitorGap[] —— 可转入 Opportunity Engine。
 */

import type {
  DimensionComparison,
  CompetitorGap,
  CompetitorEvidence,
  GapSeverity,
  CompetitorDimension,
} from "./types";

/** 计算严重度：用户 null 或差距大 → high，中等 → medium，小幅 → low */
function severityFor(
  dimension: CompetitorDimension,
  userValue: unknown,
  leadingCompetitors: { value: unknown; gap: number }[]
): GapSeverity {
  if (userValue === null) return "high"; // 用户完全无数据，竞品有
  if (leadingCompetitors.length === 0) return "low";

  switch (dimension) {
    case "serp": {
      // 位次差距：差距 > 5 位 → high，> 2 → medium
      const maxGap = Math.max(...leadingCompetitors.map((c) => c.gap));
      if (maxGap > 5) return "high";
      if (maxGap > 2) return "medium";
      return "low";
    }
    case "ai":
    case "geo":
    case "protocol": {
      // 分数差距：> 20 → high，> 10 → medium
      const maxGap = Math.max(...leadingCompetitors.map((c) => c.gap));
      if (maxGap > 20) return "high";
      if (maxGap > 10) return "medium";
      return "low";
    }
    case "schema": {
      // 类型数差距：> 3 → high，> 1 → medium
      const maxGap = Math.max(...leadingCompetitors.map((c) => c.gap));
      if (maxGap > 3) return "high";
      if (maxGap > 1) return "medium";
      return "low";
    }
    default:
      return "medium";
  }
}

/** 从 DimensionComparison 提取领先的竞品 */
function extractLeadingCompetitors<T>(dim: DimensionComparison<T>): {
  domain: string;
  value: T;
  gap: number;
}[] {
  if (dim.gap !== "behind") return [];
  const result: { domain: string; value: T; gap: number }[] = [];

  for (const cv of dim.competitorValues) {
    if (cv.status !== "available" || cv.value === null) continue;
    // 判断该竞品是否领先于用户
    const isLeading = isCompetitorLeading(dim.dimension, dim.userValue, cv.value);
    if (!isLeading) continue;

    // 计算差距（维度特定）
    const gap = computeGap(dim.dimension, dim.userValue, cv.value);
    result.push({ domain: cv.domain, value: cv.value, gap });
  }
  return result;
}

/** 判断竞品是否领先于用户（维度特定） */
function isCompetitorLeading(dimension: CompetitorDimension, userValue: unknown, compValue: unknown): boolean {
  if (userValue === null) return true; // 用户无数据，竞品有 → 领先
  switch (dimension) {
    case "serp":
      // 位次越低越好
      return (compValue as { averageRank: number | null }).averageRank !== null &&
        (userValue as { averageRank: number | null }).averageRank !== null &&
        ((compValue as { averageRank: number }).averageRank < (userValue as { averageRank: number }).averageRank);
    case "ai":
      return ((compValue as { mentionCount: number }).mentionCount + (compValue as { citationCount: number }).citationCount) >
        ((userValue as { mentionCount: number }).mentionCount + (userValue as { citationCount: number }).citationCount);
    case "geo":
      return (compValue as { averageScore: number }).averageScore > (userValue as { averageScore: number }).averageScore;
    case "protocol":
      return (compValue as { aiOpennessScore: number }).aiOpennessScore > (userValue as { aiOpennessScore: number }).aiOpennessScore;
    case "schema":
      return (compValue as { typeCount: number }).typeCount > (userValue as { typeCount: number }).typeCount;
    default:
      return false;
  }
}

/** 计算差距绝对值（维度特定，用于严重度） */
function computeGap(dimension: CompetitorDimension, userValue: unknown, compValue: unknown): number {
  if (userValue === null) return 999; // 用户无数据 → 最大差距
  switch (dimension) {
    case "serp": {
      const u = (userValue as { averageRank: number | null }).averageRank;
      const c = (compValue as { averageRank: number | null }).averageRank;
      return u !== null && c !== null ? Math.abs(c - u) : 0;
    }
    case "ai": {
      const u = (userValue as { mentionCount: number; citationCount: number });
      const c = (compValue as { mentionCount: number; citationCount: number });
      return Math.abs((c.mentionCount + c.citationCount) - (u.mentionCount + u.citationCount));
    }
    case "geo":
      return Math.abs((compValue as { averageScore: number }).averageScore - (userValue as { averageScore: number }).averageScore);
    case "protocol":
      return Math.abs((compValue as { aiOpennessScore: number }).aiOpennessScore - (userValue as { aiOpennessScore: number }).aiOpennessScore);
    case "schema":
      return Math.abs((compValue as { typeCount: number }).typeCount - (userValue as { typeCount: number }).typeCount);
    default:
      return 0;
  }
}

/** 组装维度的 evidence */
function collectEvidence<T>(dim: DimensionComparison<T>): CompetitorEvidence[] {
  const ev: CompetitorEvidence[] = [...dim.userEvidence];
  for (const cv of dim.competitorValues) {
    if (cv.status === "available") ev.push(...cv.evidence);
  }
  return ev;
}

export function buildGapList(
  dimensions: DimensionComparison<unknown>[]
): CompetitorGap[] {
  const gaps: CompetitorGap[] = [];

  for (const dim of dimensions) {
    if (dim.gap !== "behind") continue;

    const leading = extractLeadingCompetitors(dim);
    if (leading.length === 0) continue;

    const gap: CompetitorGap = {
      dimension: dim.dimension,
      description: dim.gapDetail ?? dim.summary,
      evidence: collectEvidence(dim),
      affectedCompetitors: leading.map((l) => l.domain),
      severity: severityFor(
        dim.dimension,
        dim.userValue,
        leading.map((l) => ({ value: l.value, gap: l.gap }))
      ),
    };
    gaps.push(gap);
  }

  // 按 severity 排序：high → medium → low
  const order: Record<GapSeverity, number> = { high: 0, medium: 1, low: 2 };
  gaps.sort((a, b) => order[a.severity] - order[b.severity]);

  return gaps;
}
