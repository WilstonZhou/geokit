/**
 * 鲸析 GEOkit — 竞品结构化数据对比（T8 维度 5）
 *
 * 纯函数，不 fetch。从预收集的页面审计结果中聚合 JSON-LD 类型，
 * 对比用户与竞品的 Schema 覆盖面。
 */

import type {
  DimensionComparison,
  SchemaComparison,
  CompetitorDimensionValue,
  CompetitorEvidence,
  CompetitorStatus,
} from "./types";

/** 最小接口约束：任何带 jsonLdTypes 的对象都可输入 */
interface SchemaSource {
  jsonLdTypes: string[];
}

function collectTypes(sources: SchemaSource[]): string[] {
  const set = new Set<string>();
  for (const s of sources) {
    for (const t of s.jsonLdTypes ?? []) set.add(t);
  }
  return Array.from(set).sort();
}

/** 确定 Schema 维度 gap（类型越多越好） */
function determineSchemaGap(
  userCount: number | null,
  compCounts: number[]
): "behind" | "ahead" | "parity" | "incomparable" {
  // 任一侧没有可用观测就不能下 ahead/behind 结论
  if (userCount === null || compCounts.length === 0) return "incomparable";
  if (compCounts.some((c) => c > userCount)) return "behind";
  if (compCounts.some((c) => c < userCount)) return "ahead";
  return "parity";
}

export function compareStructuredData(
  userSources: SchemaSource[],
  competitorSources: { domain: string; sources: SchemaSource[] }[]
): DimensionComparison<SchemaComparison> {
  // 无数据源
  if ((!userSources || userSources.length === 0) &&
      (!competitorSources || competitorSources.length === 0)) {
    return {
      dimension: "schema",
      userValue: null,
      userStatus: "unavailable",
      userEvidence: [],
      competitorValues: (competitorSources ?? []).map((cs) => ({
        domain: cs.domain,
        value: null,
        status: "unavailable" as CompetitorStatus,
        evidence: [],
      })),
      summary: "未提供页面审计数据，无法对比结构化数据。",
      gap: "incomparable",
    };
  }

  const userTypes = collectTypes(userSources ?? []);
  const userStatus: CompetitorStatus = (userSources?.length ?? 0) > 0 ? "available" : "unavailable";
  const userEvidence: CompetitorEvidence[] = [
    { signal: "schema.typeCount", source: "PageAudit[]", value: userTypes.length },
    { signal: "schema.types", source: "PageAudit[]", value: userTypes.join(",") || "none" },
  ];

  const competitorValues: CompetitorDimensionValue<SchemaComparison>[] =
    competitorSources.map((cs) => {
      const types = collectTypes(cs.sources ?? []);
      const status: CompetitorStatus =
        (cs.sources?.length ?? 0) > 0 ? "available" : "unavailable";
      return {
        domain: cs.domain,
        value: status === "available" ? { types, typeCount: types.length } : null,
        status,
        statusReason: status === "available" ? undefined : "竞品无页面审计数据",
        evidence: [
          { signal: "schema.typeCount", source: `PageAudit[] (${cs.domain})`, value: types.length },
          { signal: "schema.types", source: `PageAudit[] (${cs.domain})`, value: types.join(",") || "none" },
        ],
      };
    });

  // 只让有可用数据的竞品参与 gap；unavailable 不能按 0 种类型算
  const availableComps = competitorValues.filter(
    (c) => c.status === "available" && c.value !== null
  );
  const compCounts = availableComps.map((c) => c.value!.typeCount);
  const gap = determineSchemaGap(
    userStatus === "available" ? userTypes.length : null,
    compCounts
  );

  let summary: string;
  if (userStatus !== "available") {
    summary = "未提供用户页面审计数据，无法对比结构化数据。";
  } else if (compCounts.length === 0) {
    summary = "竞品没有可用的结构化数据，无法对比。";
  } else if (gap === "behind") {
    const leaders = availableComps
      .filter((c) => c.value!.typeCount > userTypes.length)
      .map((c) => `${c.domain}(${c.value!.typeCount}种)`);
    summary = `用户覆盖 ${userTypes.length} 种 Schema，落后：${leaders.join("、")}`;
  } else if (gap === "ahead") {
    summary = `用户覆盖 ${userTypes.length} 种 Schema，领先所有有数据的竞品。`;
  } else {
    summary = `用户与竞品 Schema 覆盖面持平（${userTypes.length} 种）。`;
  }

  let gapDetail: string | undefined;
  if (gap === "behind") {
    // 找出竞品有、用户没有的类型
    const userSet = new Set(userTypes);
    const missingByComp = availableComps
      .filter((c) => c.value!.typeCount > userTypes.length)
      .map((c) => {
        const missing = c.value!.types.filter((t) => !userSet.has(t));
        return `${c.domain}: 缺 ${missing.join(",")}`;
      });
    gapDetail = missingByComp.join("；");
  }

  return {
    dimension: "schema",
    userValue:
      userStatus === "available"
        ? { types: userTypes, typeCount: userTypes.length }
        : null,
    userStatus,
    userStatusReason: userStatus === "available" ? undefined : "未提供用户页面审计数据",
    userEvidence,
    competitorValues,
    summary,
    gap,
    gapDetail,
  };
}
