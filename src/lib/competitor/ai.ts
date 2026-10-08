/**
 * 鲸析 GEOkit — 竞品 AI 提及/引用对比（T8 维度 2）
 *
 * 纯函数，不 fetch。从预收集的 CitationRecord[] 聚合用户与竞品在 AI 答案中的
 * 被提及频次、被引用频次与引用位置。
 * 无 evidence 不输出结论，缺数据标 unavailable。
 */

import type { CitationRecord } from "../evidence/types";
import { getDomain } from "../html";
import type {
  DimensionComparison,
  AiComparison,
  CompetitorDimensionValue,
  CompetitorEvidence,
  CompetitorStatus,
} from "./types";

function normDomain(d: string): string {
  return getDomain(d.toLowerCase().trim());
}

/** 从 URL 提取归一化域名 */
function domainFromUrl(url: string): string {
  try {
    return normDomain(new URL(url).hostname);
  } catch {
    return "";
  }
}

interface AiAggregate {
  mentionCount: number;
  citationCount: number;
  averageCitationPosition: number | null;
  modelsMentioned: string[];
  status: CompetitorStatus;
  evidence: CompetitorEvidence[];
}

/**
 * 聚合某主体的 AI 提及/引用数据。
 *
 * @param records     CitationRecord 列表
 * @param domain      目标域名（用于匹配引用 URL）
 * @param brandOrDomain  用于匹配 competitorsMentioned / mentioned 的字符串
 * @param isUser      是否为用户主体（用户用 record.mentioned 字段）
 */
function aggregateAi(
  records: CitationRecord[],
  domain: string,
  brandOrDomain: string,
  isUser: boolean
): AiAggregate {
  const targetDomain = normDomain(domain);
  const targetBrand = brandOrDomain.toLowerCase().trim();

  let mentionCount = 0;
  let citationCount = 0;
  const citationPositions: number[] = [];
  const modelsMentionedSet = new Set<string>();
  let anyOk = false;

  for (const r of records) {
    // 只处理有效记录
    if (r.citationsStatus !== "ok" && r.citationsStatus !== "OBSERVED") continue;
    anyOk = true;

    // 提及判定
    let mentioned = false;
    if (isUser) {
      mentioned = r.mentioned;
    } else {
      // 竞品：检查 competitorsMentioned 是否包含该域名/品牌
      mentioned = (r.competitorsMentioned ?? []).some(
        (c) => c.toLowerCase().trim() === targetBrand || normDomain(c) === targetDomain
      );
    }
    if (mentioned) {
      mentionCount++;
      modelsMentionedSet.add(r.model);
    }

    // 引用判定：检查 citations URL 域名是否匹配
    let citedInThisRecord = false;
    for (const c of r.citations) {
      if (domainFromUrl(c.url) === targetDomain) {
        citationCount++;
        citedInThisRecord = true;
        if (c.position !== undefined && c.position !== null) {
          citationPositions.push(c.position);
        }
      }
    }
    if (citedInThisRecord) modelsMentionedSet.add(r.model);
  }

  const averageCitationPosition =
    citationPositions.length > 0
      ? Math.round((citationPositions.reduce((a, b) => a + b, 0) / citationPositions.length) * 10) / 10
      : null;

  const status: CompetitorStatus = anyOk ? "available" : "unavailable";

  const evidence: CompetitorEvidence[] = [
    { signal: "ai.mentionCount", source: "CitationRecord[]", value: mentionCount },
    { signal: "ai.citationCount", source: "CitationRecord[]", value: citationCount },
  ];

  return {
    mentionCount,
    citationCount,
    averageCitationPosition,
    modelsMentioned: Array.from(modelsMentionedSet),
    status,
    evidence,
  };
}

/** 确定 AI 维度 gap（提及/引用越多越好） */
function determineAiGap(
  userCount: number,
  compCounts: number[]
): "behind" | "ahead" | "parity" | "incomparable" {
  if (userCount === 0 && compCounts.every((c) => c === 0)) return "incomparable";
  if (compCounts.some((c) => c > userCount)) return "behind";
  if (compCounts.some((c) => c < userCount)) return "ahead";
  return "parity";
}

export function compareAiMentions(
  aiCitations: CitationRecord[],
  userDomain: string,
  competitors: string[]
): DimensionComparison<AiComparison> {
  if (!aiCitations || aiCitations.length === 0) {
    return {
      dimension: "ai",
      userValue: null,
      userStatus: "unavailable",
      userEvidence: [],
      competitorValues: competitors.map((d) => ({
        domain: d,
        value: null,
        status: "unavailable" as CompetitorStatus,
        evidence: [],
      })),
      summary: "未提供 AI 引用数据，无法对比。",
      gap: "incomparable",
    };
  }

  const userAgg = aggregateAi(aiCitations, userDomain, userDomain, true);

  const competitorValues: CompetitorDimensionValue<AiComparison>[] = competitors.map((comp) => {
    const agg = aggregateAi(aiCitations, comp, comp, false);
    return {
      domain: comp,
      value: {
        mentionCount: agg.mentionCount,
        citationCount: agg.citationCount,
        averageCitationPosition: agg.averageCitationPosition,
        modelsMentioned: agg.modelsMentioned,
      },
      status: agg.status,
      evidence: agg.evidence,
    };
  });

  // 以 citationCount 为主要对比指标
  const userScore = userAgg.mentionCount + userAgg.citationCount;
  const compScores = competitorValues.map(
    (c) => (c.value?.mentionCount ?? 0) + (c.value?.citationCount ?? 0)
  );
  const gap = determineAiGap(userScore, compScores);

  let summary: string;
  if (gap === "incomparable") {
    summary = "用户与竞品均未被 AI 提及或引用。";
  } else if (gap === "behind") {
    const leaders = competitorValues
      .filter((c) => (c.value!.mentionCount + c.value!.citationCount) > userScore)
      .map((c) => `${c.domain}(${c.value!.citationCount}次引用)`);
    summary = `用户被引用 ${userAgg.citationCount} 次，落后：${leaders.join("、")}`;
  } else if (gap === "ahead") {
    summary = `用户被提及 ${userAgg.mentionCount} 次、引用 ${userAgg.citationCount} 次，领先全部竞品。`;
  } else {
    summary = `用户与竞品在 AI 提及/引用上持平。`;
  }

  let gapDetail: string | undefined;
  if (gap === "behind") {
    const leaders = competitorValues
      .filter((c) => (c.value!.mentionCount + c.value!.citationCount) > userScore)
      .map((c) => `${c.domain}: 提及${c.value!.mentionCount}/引用${c.value!.citationCount}`);
    gapDetail = leaders.join("；");
  }

  return {
    dimension: "ai",
    userValue: {
      mentionCount: userAgg.mentionCount,
      citationCount: userAgg.citationCount,
      averageCitationPosition: userAgg.averageCitationPosition,
      modelsMentioned: userAgg.modelsMentioned,
    },
    userStatus: userAgg.status,
    userEvidence: userAgg.evidence,
    competitorValues,
    summary,
    gap,
    gapDetail,
  };
}
