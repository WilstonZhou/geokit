/**
 * 鲸析 GEOkit — 竞品 GEO 评分对比（T8 维度 3）
 *
 * async：对竞品关键页面调用 auditUrl，礼貌爬取 + blocked 原则。
 * 若已有预收集的 PageAudit[] 则直接复用，不重复抓取。
 * 抓取失败（httpStatus===0 或 ≥400）按 blocked 标注，不留空。
 */

import { auditUrl } from "../audit";
import type { GeoVersion } from "../geo";
import type {
  DimensionComparison,
  GeoComparison,
  CompetitorDimensionValue,
  CompetitorEvidence,
  CompetitorStatus,
} from "./types";

/** 最小接口：PageAudit 与 CrawlPage 均满足 */
export interface GeoAuditSource {
  url: string;
  httpStatus: number;
  geoScore: number;
  geoBreakdown?: { id: string; label: string; score: number; max: number }[];
}

/** 判断页面是否可用于 GEO 评分（非 blocked） */
function isUsableAudit(a: GeoAuditSource): boolean {
  return a.httpStatus > 0 && a.httpStatus < 400;
}

/** 计算有效页面平均分 */
function averageScore(audits: GeoAuditSource[]): number {
  const usable = audits.filter(isUsableAudit);
  if (usable.length === 0) return 0;
  return Math.round((usable.reduce((sum, a) => sum + a.geoScore, 0) / usable.length) * 10) / 10;
}

/** 聚合六维明细均值 */
function averageBreakdown(audits: GeoAuditSource[]): { id: string; label: string; score: number; max: number }[] {
  const usable = audits.filter(isUsableAudit);
  if (usable.length === 0) return [];
  const dimMap = new Map<string, { label: string; scores: number[]; max: number }>();
  for (const a of usable) {
    for (const b of a.geoBreakdown ?? []) {
      const entry = dimMap.get(b.id) ?? { label: b.label, scores: [], max: b.max };
      entry.scores.push(b.score);
      dimMap.set(b.id, entry);
    }
  }
  return Array.from(dimMap.entries()).map(([id, entry]) => ({
    id,
    label: entry.label,
    score: Math.round((entry.scores.reduce((a, b) => a + b, 0) / entry.scores.length) * 10) / 10,
    max: entry.max,
  }));
}

/** 确定整体 status */
function determineGeoStatus(audits: GeoAuditSource[]): CompetitorStatus {
  if (audits.length === 0) return "unavailable";
  const usable = audits.filter(isUsableAudit);
  if (usable.length > 0) return "available";
  // 全部不可用 → blocked（至少有审计但全失败）
  return "blocked";
}

/** GEO 维度 gap（分数越高越好）。0 分是合法的真实观测值，不能当“无数据”。 */
function determineGeoGap(
  userScore: number | null,
  compScores: (number | null)[]
): "behind" | "ahead" | "parity" | "incomparable" {
  const validComps = compScores.filter((v): v is number => v !== null);
  // 用户或竞品缺少可用观测 → 无法对比；不要把“没数据”包装成 ahead/behind
  if (userScore === null || validComps.length === 0) return "incomparable";
  if (validComps.some((c) => c > userScore)) return "behind";
  if (validComps.some((c) => c < userScore)) return "ahead";
  return "parity";
}

export async function compareGeoScores(
  userDomain: string,
  competitors: string[],
  options: {
    userAudits?: GeoAuditSource[];
    competitorAudits?: { domain: string; audits: GeoAuditSource[] }[];
    competitorUrls?: { domain: string; urls: string[] }[];
    fetchProtocol?: boolean;
    geoVersion?: GeoVersion;
  }
): Promise<DimensionComparison<GeoComparison>> {
  const userAudits = options.userAudits ?? [];

  // 预收集竞品审计按 domain 索引
  const preCollected = new Map<string, GeoAuditSource[]>();
  for (const ca of options.competitorAudits ?? []) {
    preCollected.set(ca.domain, ca.audits);
  }

  // 现场抓取：对没有预收集数据的竞品，调用 auditUrl
  if (options.fetchProtocol && options.competitorUrls) {
    const toFetch = options.competitorUrls.filter((cu) => !preCollected.has(cu.domain));
    // 礼貌并发：每个竞品的 URL 并行抓取，竞品间也并行（URL 总数通常很少）
    const fetchResults = await Promise.all(
      toFetch.map(async (cu) => {
        const audits = await Promise.all(
          cu.urls.map((u) => auditUrl(u, { geoVersion: options.geoVersion }))
        );
        return { domain: cu.domain, audits };
      })
    );
    for (const fr of fetchResults) {
      preCollected.set(fr.domain, fr.audits);
    }
  }

  // 用户值
  const userStatus: CompetitorStatus =
    userAudits.length > 0 ? determineGeoStatus(userAudits) : "unavailable";
  // 只有 status=available 时平均分才是有效观测；全部 blocked 时 0 不是“得了 0 分”
  const userScore = userStatus === "available" ? averageScore(userAudits) : null;
  const userBreakdown = userStatus === "available" ? averageBreakdown(userAudits) : [];
  const userEvidence: CompetitorEvidence[] = userAudits.length > 0
    ? [
        { signal: "geo.averageScore", source: "PageAudit[]", value: userScore ?? 0 },
        { signal: "geo.pagesAudited", source: "PageAudit[]", value: userAudits.filter(isUsableAudit).length },
      ]
    : [];

  // 竞品值
  const competitorValues: CompetitorDimensionValue<GeoComparison>[] = competitors.map((comp) => {
    const compAudits = preCollected.get(comp) ?? [];
    if (compAudits.length === 0) {
      return {
        domain: comp,
        value: null,
        status: "unavailable" as CompetitorStatus,
        evidence: [],
      };
    }
    const score = averageScore(compAudits);
    const breakdown = averageBreakdown(compAudits);
    const status = determineGeoStatus(compAudits);
    const usableCount = compAudits.filter(isUsableAudit).length;
    return {
      domain: comp,
      value:
        status === "available"
          ? { averageScore: score, pagesAudited: usableCount, breakdown }
          : null,
      status,
      statusReason:
        status === "available" ? undefined : "竞品页面均不可用（blocked/抓取失败）",
      evidence: [
        { signal: "geo.averageScore", source: `PageAudit[] (${comp})`, value: score },
        { signal: "geo.pagesAudited", source: `PageAudit[] (${comp})`, value: usableCount },
      ],
    };
  });

  const compScores = competitorValues.map((c) =>
    c.value && c.status === "available" ? c.value.averageScore : null
  );
  const validCompScores = compScores.filter((v): v is number => v !== null);
  const gap = determineGeoGap(userScore, compScores);

  let summary: string;
  if (userStatus !== "available") {
    summary = "未提供用户可用的页面审计数据，无法对比 GEO 评分。";
  } else if (validCompScores.length === 0) {
    summary = "竞品没有可用的 GEO 评分数据，无法对比。";
  } else if (gap === "behind") {
    const leaders = competitorValues
      .filter(
        (c) =>
          c.status === "available" &&
          c.value &&
          (userScore ?? 0) < c.value.averageScore
      )
      .map((c) => `${c.domain}(${c.value!.averageScore})`);
    summary = `用户 GEO 均分 ${userScore}，落后：${leaders.join("、")}`;
  } else if (gap === "ahead") {
    summary = `用户 GEO 均分 ${userScore}，领先所有有数据的竞品。`;
  } else {
    summary = `用户 GEO 均分 ${userScore}，与竞品持平。`;
  }

  let gapDetail: string | undefined;
  if (gap === "behind") {
    // 找出用户弱维度（均分 < 竞品均分）
    const weakDims: string[] = [];
    for (const ub of userBreakdown) {
      for (const cv of competitorValues) {
        if (!cv.value || cv.status !== "available") continue;
        const compDim = cv.value.breakdown.find((b) => b.id === ub.id);
        if (compDim && compDim.score > ub.score) {
          weakDims.push(`${ub.label}: 用户 ${ub.score}/${ub.max} vs ${cv.domain} ${compDim.score}/${compDim.max}`);
          break;
        }
      }
    }
    if (weakDims.length > 0) gapDetail = weakDims.join("；");
  }

  return {
    dimension: "geo",
    userValue:
      userStatus === "available" && userScore !== null
        ? {
            averageScore: userScore,
            pagesAudited: userAudits.filter(isUsableAudit).length,
            breakdown: userBreakdown,
          }
        : null,
    userStatus,
    userStatusReason:
      userStatus === "unavailable"
        ? "未提供用户页面审计数据"
        : userStatus === "blocked"
          ? "用户页面均不可用（blocked/抓取失败）"
          : undefined,
    userEvidence,
    competitorValues,
    summary,
    gap,
    gapDetail,
  };
}
