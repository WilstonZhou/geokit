/**
 * 鲸析 GEOkit — 竞品 SERP 位次对比（T8 维度 1）
 *
 * 纯函数，不 fetch。从预收集的 SerpResponse[] 提取用户与竞品的多引擎位次。
 * 抓不到的引擎按 blocked/unavailable 标注，不留空、不编造。
 */

import type { SerpResponse, SerpResultItem } from "../serp";
import { getDomain } from "../html";
import type {
  DimensionComparison,
  SerpComparison,
  CompetitorDimensionValue,
  CompetitorEvidence,
  CompetitorStatus,
} from "./types";

/** 把域名归一化为可注册域（剥 www、子域等） */
function normDomain(d: string): string {
  return getDomain(d.toLowerCase().trim());
}

/** 从 SERP items 中扫描某域名的排名 */
function scanItemRank(items: SerpResultItem[], domain: string): number | null {
  const target = normDomain(domain);
  for (const item of items) {
    if (normDomain(item.domain) === target) return item.position;
  }
  return null;
}

/**
 * 从单条 SerpResponse 提取某域名排名。
 * 优先用 collector 设好的 targetRank（user 专用），否则自己扫 items。
 */
function extractRank(serp: SerpResponse, domain: string, isUser: boolean): number | null {
  if (serp.status !== "ok") return null;
  // 用户优先用 targetRank（collector 已做过域名匹配）
  if (isUser && serp.targetFound && serp.targetRank !== null) return serp.targetRank;
  return scanItemRank(serp.items, domain);
}

/** 对一组 SerpResponse 计算某域名的聚合位次 */
interface RankAggregate {
  averageRank: number | null;
  enginesCovered: number;
  perEngineRanks: { engine: string; rank: number | null }[];
  status: CompetitorStatus;
  evidence: CompetitorEvidence[];
}

function aggregateRanks(
  serpResults: SerpResponse[],
  domain: string,
  isUser: boolean
): RankAggregate {
  // 按引擎分组（同一引擎可能有多个 keyword 的结果，取均值）
  const byEngine = new Map<string, SerpResponse[]>();
  for (const s of serpResults) {
    const list = byEngine.get(s.engine) ?? [];
    list.push(s);
    byEngine.set(s.engine, list);
  }

  const perEngineRanks: { engine: string; rank: number | null }[] = [];
  const allRanks: number[] = [];
  let enginesCovered = 0;
  let anyBlocked = false;
  let anyOk = false;

  for (const [engine, responses] of byEngine) {
    const ranks: number[] = [];
    for (const r of responses) {
      if (r.status === "ok") {
        anyOk = true;
        const rank = extractRank(r, domain, isUser);
        if (rank !== null) ranks.push(rank);
      } else if (r.status === "blocked" || r.status === "error") {
        anyBlocked = true;
      }
    }
    if (ranks.length > 0) {
      enginesCovered++;
      const avg = Math.round((ranks.reduce((a, b) => a + b, 0) / ranks.length) * 10) / 10;
      perEngineRanks.push({ engine, rank: avg });
      allRanks.push(avg);
    } else {
      perEngineRanks.push({ engine, rank: null });
    }
  }

  const averageRank =
    allRanks.length > 0
      ? Math.round((allRanks.reduce((a, b) => a + b, 0) / allRanks.length) * 10) / 10
      : null;

  // 状态判定：有 ok 的引擎 → available；全 blocked → blocked；否则 unavailable
  let status: CompetitorStatus;
  if (anyOk) status = "available";
  else if (anyBlocked) status = "blocked";
  else status = "unavailable";

  const evidence: CompetitorEvidence[] = [
    { signal: "serp.averageRank", source: "SerpResponse[]", value: averageRank ?? "null" },
    { signal: "serp.enginesCovered", source: "SerpResponse[]", value: enginesCovered },
  ];

  return { averageRank, enginesCovered, perEngineRanks, status, evidence };
}

/** 确定整体 gap（SERP 位次：越低越好） */
function determineSerpGap(
  userAvg: number | null,
  compAvgs: (number | null)[]
): "behind" | "ahead" | "parity" | "incomparable" {
  const validComps = compAvgs.filter((v): v is number => v !== null);
  if (userAvg === null && validComps.length === 0) return "incomparable";
  if (userAvg === null) return "behind"; // 用户未上榜，竞品上榜
  if (validComps.length === 0) return "ahead"; // 用户上榜，竞品均未上
  // 位次越低越好
  if (validComps.some((c) => c < userAvg)) return "behind";
  if (validComps.some((c) => c > userAvg)) return "ahead";
  return "parity";
}

export function compareSerpPositions(
  serpResults: SerpResponse[],
  userDomain: string,
  competitors: string[]
): DimensionComparison<SerpComparison> {
  // 无数据源
  if (!serpResults || serpResults.length === 0) {
    return {
      dimension: "serp",
      userValue: null,
      userStatus: "unavailable",
      userEvidence: [],
      competitorValues: competitors.map((d) => ({
        domain: d,
        value: null,
        status: "unavailable" as CompetitorStatus,
        evidence: [],
      })),
      summary: "未提供 SERP 数据，无法对比位次。",
      gap: "incomparable",
    };
  }

  const userAgg = aggregateRanks(serpResults, userDomain, true);

  const competitorValues: CompetitorDimensionValue<SerpComparison>[] = competitors.map((comp) => {
    const agg = aggregateRanks(serpResults, comp, false);
    return {
      domain: comp,
      value: {
        averageRank: agg.averageRank,
        enginesCovered: agg.enginesCovered,
        perEngineRanks: agg.perEngineRanks,
      },
      status: agg.status,
      evidence: agg.evidence,
    };
  });

  const compAvgs = competitorValues.map((c) => c.value?.averageRank ?? null);
  const gap = determineSerpGap(userAgg.averageRank, compAvgs);

  // 摘要
  const userRankText =
    userAgg.averageRank !== null ? `平均位次 ${userAgg.averageRank}` : "未上榜";
  const aheadCount = compAvgs.filter((c) => c !== null && (userAgg.averageRank === null || c < userAgg.averageRank)).length;
  let summary: string;
  if (gap === "incomparable") {
    summary = "用户与竞品均无 SERP 数据，无法对比。";
  } else if (gap === "behind") {
    summary = `用户${userRankText}，落后 ${aheadCount} 个竞品。`;
  } else if (gap === "ahead") {
    summary = `用户${userRankText}，领先全部竞品。`;
  } else {
    summary = `用户${userRankText}，与竞品持平。`;
  }

  let gapDetail: string | undefined;
  if (gap === "behind") {
    const leaders = competitorValues
      .filter((c) => c.value && c.value.averageRank !== null && (userAgg.averageRank === null || c.value.averageRank < userAgg.averageRank))
      .map((c) => `${c.domain}(${c.value!.averageRank})`);
    gapDetail = `领先的竞品：${leaders.join("、")}`;
  }

  return {
    dimension: "serp",
    userValue: {
      averageRank: userAgg.averageRank,
      enginesCovered: userAgg.enginesCovered,
      perEngineRanks: userAgg.perEngineRanks,
    },
    userStatus: userAgg.status,
    userEvidence: userAgg.evidence,
    competitorValues,
    summary,
    gap,
    gapDetail,
  };
}
