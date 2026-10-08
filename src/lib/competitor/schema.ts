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
  userCount: number,
  compCounts: number[]
): "behind" | "ahead" | "parity" | "incomparable" {
  if (userCount === 0 && compCounts.every((c) => c === 0)) return "incomparable";
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
      const status: CompetitorStatus = (cs.sources?.length ?? 0) > 0 ? "available" : "unavailable";
      return {
        domain: cs.domain,
        value: { types, typeCount: types.length },
        status,
        evidence: [
          { signal: "schema.typeCount", source: `PageAudit[] (${cs.domain})`, value: types.length },
          { signal: "schema.types", source: `PageAudit[] (${cs.domain})`, value: types.join(",") || "none" },
        ],
      };
    });

  const compCounts = competitorValues.map((c) => c.value?.typeCount ?? 0);
  const gap = determineSchemaGap(userTypes.length, compCounts);

  let summary: string;
  if (gap === "incomparable") {
    summary = "用户与竞品均无结构化数据。";
  } else if (gap === "behind") {
    const leaders = competitorValues
      .filter((c) => (c.value?.typeCount ?? 0) > userTypes.length)
      .map((c) => `${c.domain}(${c.value!.typeCount}种)`);
    summary = `用户覆盖 ${userTypes.length} 种 Schema，落后：${leaders.join("、")}`;
  } else if (gap === "ahead") {
    summary = `用户覆盖 ${userTypes.length} 种 Schema，领先全部竞品。`;
  } else {
    summary = `用户与竞品 Schema 覆盖面持平（${userTypes.length} 种）。`;
  }

  let gapDetail: string | undefined;
  if (gap === "behind") {
    // 找出竞品有、用户没有的类型
    const userSet = new Set(userTypes);
    const missingByComp = competitorValues
      .filter((c) => (c.value?.typeCount ?? 0) > userTypes.length)
      .map((c) => {
        const missing = (c.value!.types).filter((t) => !userSet.has(t));
        return `${c.domain}: 缺 ${missing.join(",")}`;
      });
    gapDetail = missingByComp.join("；");
  }

  return {
    dimension: "schema",
    userValue: { types: userTypes, typeCount: userTypes.length },
    userStatus,
    userEvidence,
    competitorValues,
    summary,
    gap,
    gapDetail,
  };
}
