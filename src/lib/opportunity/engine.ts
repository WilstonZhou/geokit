/**
 * 鲸析 GEOkit — Opportunity Engine（T6）
 *
 * 引擎只做三件事：
 *   1. 调七个生成器，把"发现"翻译成"下一步动作"；
 *   2. 按 impact×effort 排序，同分按受影响范围排序；
 *   3. 同 target 上多条机会合并为一条多建议机会。
 *
 * 不调任何大模型。不主动采集 —— 上游各 T 把结论算好后整体传入。
 */

import type {
  Opportunity,
  OpportunityInput,
  ImpactLevel,
  EffortLevel,
  OpportunityType,
  Recommendation,
  OpportunityEvidenceRef,
} from "./types";
import {
  genWeakCiteability,
  genCitationGap,
  genAiCrawlProtocol,
  genSiteIssueHigh,
  genSearchOpportunity,
  genMissingEntity,
  genSchemaIssue,
  makeOpportunityId,
} from "./generators";

/* ------------------------------------------------------------------ */
/* 排序常量 —— 规则透明可读                                            */
/* ------------------------------------------------------------------ */

/** impact 越靠前越紧急：high=0, medium=1, low=2 */
export const IMPACT_RANK: Record<ImpactLevel, number> = { high: 0, medium: 1, low: 2 };
/** effort 越靠前越易做：low=0, medium=1, high=2 */
export const EFFORT_RANK: Record<EffortLevel, number> = { low: 0, medium: 1, high: 2 };

/* ------------------------------------------------------------------ */
/* 排序                                                                */
/* ------------------------------------------------------------------ */

/**
 * 排序：先 impact（high→low），再 effort（low→high），同分按 affectedScope 降序。
 * 这样最紧急且最易做的事排在最前。
 */
export function rankOpportunities(list: Opportunity[]): Opportunity[] {
  return [...list].sort(
    (a, b) =>
      IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact] ||
      EFFORT_RANK[a.effort] - EFFORT_RANK[b.effort] ||
      b.affectedScope - a.affectedScope ||
      a.type.localeCompare(b.type)
  );
}

/* ------------------------------------------------------------------ */
/* 合并 —— 同 target 上多条机会合并为一条多建议                       */
/* ------------------------------------------------------------------ */

function pickHigherImpact(a: ImpactLevel, b: ImpactLevel): ImpactLevel {
  return IMPACT_RANK[a] <= IMPACT_RANK[b] ? a : b;
}

function pickLowerEffort(a: EffortLevel, b: EffortLevel): EffortLevel {
  return EFFORT_RANK[a] <= EFFORT_RANK[b] ? a : b;
}

/**
 * 合并同 target 的多条机会。
 *
 * 合并规则：
 *   - id = makeOpportunityId(主机会 type, target)
 *   - type = 主机会 type（impact 最高、effort 最低的那条；同分取首条按 type 字典序）
 *   - impact = 所有 constituent 中最高
 *   - effort = 所有 constituent 中最低（最易做的代表整体）
 *   - diagnosis.evidence = 全部 evidence 去重后合并
 *   - recommendations = 全部建议合并（保持原顺序，去重相同 action）
 *   - sources = 全部 observation id 去重
 *   - verification = 主机会的 verification（每个机会的 signalKey 不同，无法合并）
 *   - affectedScope = 取最大值（保守估计合并后的影响范围）
 */
export function mergeByTarget(list: Opportunity[]): Opportunity[] {
  const groups = new Map<string, Opportunity[]>();
  for (const o of list) {
    const arr = groups.get(o.target);
    if (arr) arr.push(o);
    else groups.set(o.target, [o]);
  }

  const out: Opportunity[] = [];
  for (const [target, group] of groups) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }

    // 主机会 = impact 最高 & effort 最低；同分按 type 字典序取首条
    const sorted = rankOpportunities(group);
    const primary = sorted[0];

    const evidence: OpportunityEvidenceRef[] = [];
    const seenEvidence = new Set<string>();
    for (const o of group) {
      for (const e of o.diagnosis.evidence) {
        const key = `${e.signal}=${e.value ?? ""}`;
        if (!seenEvidence.has(key)) {
          seenEvidence.add(key);
          evidence.push(e);
        }
      }
    }

    const recommendations: Recommendation[] = [];
    const seenRec = new Set<string>();
    for (const o of group) {
      for (const r of o.recommendations) {
        if (!seenRec.has(r.action)) {
          seenRec.add(r.action);
          recommendations.push(r);
        }
      }
    }

    const sources = Array.from(new Set(group.flatMap((o) => o.sources)));

    const merged: Opportunity = {
      id: makeOpportunityId(primary.type, target),
      type: primary.type,
      target,
      impact: group.reduce(
        (acc, o) => pickHigherImpact(acc, o.impact),
        group[0].impact
      ),
      effort: group.reduce(
        (acc, o) => pickLowerEffort(acc, o.effort),
        group[0].effort
      ),
      diagnosis: {
        summary: group.map((o) => o.diagnosis.summary).join("；"),
        evidence,
      },
      recommendations,
      sources,
      verification: primary.verification,
      affectedScope: group.reduce(
        (max, o) => Math.max(max, o.affectedScope),
        0
      ),
    };
    out.push(merged);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 把"发现"翻译成"下一步动作"。
 *
 * 输入 OpportunityInput 的任意片段缺失时跳过对应机会类型，绝不报错。
 * 输出已排序、已合并。
 */
export function generateOpportunities(input: OpportunityInput): Opportunity[] {
  const all: Opportunity[] = [
    ...genWeakCiteability(input.siteAnalysis),
    ...genCitationGap(input.citationAggregation, input.userDomain),
    ...genAiCrawlProtocol(input.robotsAnalysis, input.llmsTxtAnalysis),
    ...genSiteIssueHigh(input.siteAnalysis),
    ...genSearchOpportunity(input.gscOpportunities),
    ...genMissingEntity(input.pageAudits),
    ...genSchemaIssue(input.schemaDiagnoses),
  ];

  // 铁律：没有 evidence 的机会不输出（生成器本应保证，此处兜底）
  const filtered = all.filter(
    (o) => o.diagnosis.evidence.length > 0 && o.recommendations.length > 0
  );

  return rankOpportunities(mergeByTarget(filtered));
}

/** 仅供单测与调试：按类型分组计数 */
export function countByType(list: Opportunity[]): Record<OpportunityType, number> {
  const counts: Record<OpportunityType, number> = {
    "weak-citeability": 0,
    "citation-gap": 0,
    "ai-crawl-protocol": 0,
    "site-issue-high": 0,
    "search-opportunity": 0,
    "missing-entity": 0,
    "schema-issue": 0,
  };
  for (const o of list) counts[o.type]++;
  return counts;
}
