/**
 * 鲸析 GEOkit — Opportunity Engine 核心类型（T6）
 *
 * 把"发现了一个个独立问题"升级为"告诉用户下一步做什么"。
 *
 * 一个 Opportunity 是一段可执行的下一步建议：它必须有 evidence 支撑、
 * 必须可被复检验证、必须按 impact×effort 排序、必须能合并同一目标上的多个问题。
 *
 * 不调任何大模型：建议来自规则与模板，可复现。
 */

/* ------------------------------------------------------------------ */
/* 机会类型                                                            */
/* ------------------------------------------------------------------ */

/**
 * 七种机会类型，每一种都有明确的触发条件与测试。
 *
 * - weak-citeability    GEO 低分维度 + 缺失信号 → 该页对 AI 不够可引用
 * - citation-gap        AI 频繁引用某域名，用户域名缺席（来自 T2）
 * - ai-crawl-protocol   robots 屏蔽 AI 爬虫 / 缺 llms.txt
 * - site-issue-high     T4 高影响项
 * - search-opportunity  T5 GSC 机会，有则启用，无则跳过不报错
 * - missing-entity      作者/组织/发布时间/Schema 缺失
 * - schema-issue        T10 Schema 字段缺失/不完整、与可见内容不一致（T10）
 */
export const OPPORTUNITY_TYPES = [
  "weak-citeability",
  "citation-gap",
  "ai-crawl-protocol",
  "site-issue-high",
  "search-opportunity",
  "missing-entity",
  "schema-issue",
] as const;

export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

export const IMPACT_LEVELS = ["high", "medium", "low"] as const;
export type ImpactLevel = (typeof IMPACT_LEVELS)[number];

export const EFFORT_LEVELS = ["high", "medium", "low"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/* ------------------------------------------------------------------ */
/* 证据引用                                                            */
/* ------------------------------------------------------------------ */

/**
 * 机会对 evidence 的引用 —— 必须能追溯到具体观测。
 *
 * observationId 不一定都有（部分输入是直接传入的分析结果而非落库 Observation）；
 * 没有 observationId 时也必须给出 signal 与 value，让用户能手工核对。
 */
export interface OpportunityEvidenceRef {
  /** 关联的 Observation id；纯函数输入下可能为空 */
  observationId?: string;
  /** 信号名 —— 如 "geoScore"、"commonWeakDimensions[0]"、"citationGap[0].count" */
  signal: string;
  /** 信号值，便于在 UI 直接展示 */
  value?: string | number;
}

/**
 * 一条建议 —— 清单式，不含自动改动。
 *
 * 刻意把 action 与 detail 分开：action 是一句话动词短语，
 * detail 是限定条件/示例/避坑提示。
 */
export interface Recommendation {
  action: string;
  detail?: string;
}

/* ------------------------------------------------------------------ */
/* 验证闭环                                                            */
/* ------------------------------------------------------------------ */

/**
 * 机会的复检信号 —— 下一次跑同样的观测时，应该看到什么变化。
 *
 * signalKey 是 Observation.result 上某个字段名（或可达路径），
 * direction 描述期望的演化方向：
 *   - increase   数值变大才视为解决（如 geoScore、aiOpennessScore）
 *   - decrease   数值变小才视为解决（如 position、blocked crawler 数）
 *   - appear     之前不存在、之后出现的布尔/对象信号（如 mentioned=true）
 *   - disappear  之前存在、之后消失的信号（如 high 影响项消失）
 */
export interface Verification {
  signalKey: string;
  direction: "increase" | "decrease" | "appear" | "disappear";
  /** 人可读的期望描述，如「下次复检时 geoScore 应升至 60+」 */
  description: string;
}

/**
 * 复检判定结果。
 *
 * - resolved    信号按 direction 演化 → 机会已被解决
 * - unchanged   信号无显著变化
 * - worsened    信号反方向演化 → 情况恶化
 * - unknown     找不到可比的前后观测，无法判定
 */
export type OpportunityResolution =
  | "resolved"
  | "unchanged"
  | "worsened"
  | "unknown";

/* ------------------------------------------------------------------ */
/* Opportunity                                                        */
/* ------------------------------------------------------------------ */

export interface Opportunity {
  /** 稳定 id：type + target 的 sha1 短哈希；同 target 合并时 id 不变 */
  id: string;
  type: OpportunityType;
  /** 目标 —— URL / query / 域名，视机会类型而定 */
  target: string;
  impact: ImpactLevel;
  effort: EffortLevel;
  /**
   * 为什么存在这个机会。evidence 必须非空 —— 没证据不输出。
   * summary 是一句话结论，evidence 是支撑结论的可追溯信号。
   */
  diagnosis: {
    summary: string;
    evidence: OpportunityEvidenceRef[];
  };
  /** 清单式建议，不含自动改动 */
  recommendations: Recommendation[];
  /** 该机会来自哪些观测（Observation id 列表，可能为空） */
  sources: string[];
  /** 复检信号 */
  verification: Verification;
  /**
   * 受影响范围 —— 同分排序的 tie-breaker。
   * 一般是受影响 URL 数 / 该机会影响的页面数。
   */
  affectedScope: number;
}

/* ------------------------------------------------------------------ */
/* 引擎输入                                                            */
/* ------------------------------------------------------------------ */

import type { SiteAnalysis } from "../crawler/issues";
import type { CitationAggregation } from "../visibility/aggregate";
import type { RobotsAnalysis, LlmsTxtAnalysis } from "../llms";
import type { GscOpportunity } from "../gsc/types";
import type { PageAudit } from "../audit";
import type { SchemaDiagnosis } from "../schema/types";

/**
 * 引擎输入 —— 全部可选，缺哪段就跳过对应机会类型，绝不报错。
 *
 * 刻意不直接调爬虫/采集层：上游各 T（T2/T4/T5 + audit/llms）
 * 把结论算好后整体传入，引擎只做"把发现翻译成下一步动作"这一件事。
 */
export interface OpportunityInput {
  /** T4 站点级问题与 GEO 摘要 —— weak-citeability 与 site-issue-high 用 */
  siteAnalysis?: SiteAnalysis;
  /** T2 引用聚合 —— citation-gap 用 */
  citationAggregation?: CitationAggregation;
  /** 用户域名 —— citation-gap 与 target 计算用 */
  userDomain?: string;
  /** 协议层 robots —— ai-crawl-protocol 用 */
  robotsAnalysis?: RobotsAnalysis;
  /** 协议层 llms.txt —— ai-crawl-protocol 用 */
  llmsTxtAnalysis?: LlmsTxtAnalysis;
  /** T5 GSC 机会 —— search-opportunity 用，可选 */
  gscOpportunities?: GscOpportunity[];
  /** 页面审计 —— missing-entity 用 */
  pageAudits?: PageAudit[];
  /** T10 Schema 诊断 —— schema-issue 用，可选 */
  schemaDiagnoses?: SchemaDiagnosis[];
}
