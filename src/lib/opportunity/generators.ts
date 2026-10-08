/**
 * 鲸析 GEOkit — Opportunity Engine 七个生成器（T6，T10 新增 schema-issue）
 *
 * 每个生成器是纯函数：接受一段输入片段，返回 Opportunity[]。
 *
 * 铁律：**没有 evidence 就不输出** —— 没有 evidence 的"机会"不是机会，
 * 只是猜测。每个生成器返回的 Opportunity 都必须能在 diagnosis.evidence
 * 里指回具体观测信号。
 *
 * 不调任何大模型：建议全部来自规则与模板，可复现。
 */

import { createHash } from "node:crypto";
import type {
  Opportunity,
  OpportunityType,
  ImpactLevel,
  OpportunityEvidenceRef,
  Recommendation,
  Verification,
} from "./types";
import type { SiteAnalysis, SiteIssue } from "../crawler/issues";
import type { CitationAggregation } from "../visibility/aggregate";
import type { RobotsAnalysis, LlmsTxtAnalysis } from "../llms";
import type { GscOpportunity } from "../gsc/types";
import type { PageAudit } from "../audit";
import type { SchemaDiagnosis } from "../schema/types";
import type { CruxObservation } from "../crux/types";
import { METRIC_LABELS } from "../crux/types";
import { getDomain } from "../html";

/* ------------------------------------------------------------------ */
/* 公共工具                                                            */
/* ------------------------------------------------------------------ */

/** 稳定 id：type + target 的 sha1 短哈希。同 target 合并时 id 不变。 */
export function makeOpportunityId(type: OpportunityType, target: string): string {
  const h = createHash("sha1")
    .update(type + "|" + target, "utf8")
    .digest("hex")
    .slice(0, 8);
  return `${type}:${h}`;
}

/** 把 T4 的 IssueEvidence 转成本模块的 OpportunityEvidenceRef */
function issueEvidenceToRef(
  issue: SiteIssue,
  observationId?: string
): OpportunityEvidenceRef[] {
  return issue.evidence.map((e) => ({
    observationId,
    signal: e.fact,
    value: e.value,
  }));
}

/* ------------------------------------------------------------------ */
/* 1. weak-citeability —— GEO 低分维度 + 缺失信号                      */
/* ------------------------------------------------------------------ */

/**
 * 触发条件：T4 的 GeoSummary.lowestScoring 中存在 GEO 低分 URL
 *   （critical < 40 或 poor 40–59）。
 * 证据：该 URL 的 geoScore + 站点共性弱维度清单（来自 commonWeakDimensions）。
 */
export function genWeakCiteability(
  siteAnalysis: SiteAnalysis | undefined
): Opportunity[] {
  if (!siteAnalysis) return [];
  const { lowestScoring, commonWeakDimensions } = siteAnalysis.geoSummary;
  if (lowestScoring.length === 0) return [];

  /** 把共性弱维度铺成可读 evidence */
  const weakDimEvidence: OpportunityEvidenceRef[] = commonWeakDimensions.map(
    (d) => ({
      signal: `commonWeakDimension:${d.id}`,
      value: `${d.label}（${d.pages} 页弱）`,
    })
  );

  const out: Opportunity[] = [];
  for (const item of lowestScoring) {
    if (item.geoScore >= 60) continue; // 只对 critical/poor 触发
    const impact: ImpactLevel = item.geoScore < 40 ? "high" : "medium";
    const target = item.url;
    out.push({
      id: makeOpportunityId("weak-citeability", target),
      type: "weak-citeability",
      target,
      impact,
      effort: "medium",
      diagnosis: {
        summary: `该页面 GEO 评分 ${item.geoScore}，AI 引用友好度不足`,
        evidence: [
          { signal: "geoScore", value: item.geoScore },
          ...weakDimEvidence,
        ],
      },
      recommendations: [
        {
          action: "对照 GEO 六维明细补齐该页面最弱的 1–2 个维度",
          detail: weakDimEvidence.length
            ? `站点共性弱维度：${commonWeakDimensions.map((d) => d.label).join("、")}`
            : undefined,
        },
        {
          action: "确保正文首段给出可直接被引用的简洁结论",
        },
      ],
      sources: [],
      verification: {
        signalKey: "geoScore",
        direction: "increase",
        description: `下次复检时该 URL 的 geoScore 应升至 60+（当前 ${item.geoScore}）`,
      },
      affectedScope: 1,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 2. citation-gap —— AI 频繁引用某域名，用户域名缺席                   */
/* ------------------------------------------------------------------ */

const CITATION_GAP_HIGH_THRESHOLD = 5; // 被引用 ≥5 次视为高影响缺口
const CITATION_GAP_MEDIUM_THRESHOLD = 3; // 被引用 ≥3 次视为中等影响

/**
 * 触发条件：T2 的 CitationAggregation.citationGap 非空
 *   （域名被 AI 引用 ≥2 次且不是用户域名）。
 */
export function genCitationGap(
  agg: CitationAggregation | undefined,
  userDomain: string | undefined
): Opportunity[] {
  if (!agg || !userDomain) return [];
  if (agg.citationGap.length === 0) return [];
  const uDomain = getDomain(userDomain);

  const out: Opportunity[] = [];
  for (const gap of agg.citationGap) {
    const impact: ImpactLevel =
      gap.count >= CITATION_GAP_HIGH_THRESHOLD
        ? "high"
        : gap.count >= CITATION_GAP_MEDIUM_THRESHOLD
          ? "medium"
          : "low";
    out.push({
      id: makeOpportunityId("citation-gap", gap.domain),
      type: "citation-gap",
      target: gap.domain,
      impact,
      effort: "medium",
      diagnosis: {
        summary: `AI 答案 ${gap.count} 次引用 ${gap.domain}，而用户域名 ${uDomain} 缺席`,
        evidence: [
          { signal: `domainRanking.${gap.domain}.count`, value: gap.count },
          { signal: "userDomain", value: uDomain },
        ],
      },
      recommendations: [
        {
          action: `对照分析 ${gap.domain} 在该 query 主题下的内容优势`,
          detail: "对比内容深度、实体覆盖、来源标注、结构化数据",
        },
        {
          action: "补强该 query 主题下的内容深度与可引用性",
          detail: "聚焦直接回答、事实密度、可追溯引用",
        },
      ],
      sources: [],
      verification: {
        signalKey: "mentioned",
        direction: "appear",
        description: `下次复检时用户域名 ${uDomain} 应被该 query 的 AI 答案引用`,
      },
      affectedScope: 1,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 3. ai-crawl-protocol —— robots 屏蔽 AI 爬虫 / 缺 llms.txt            */
/* ------------------------------------------------------------------ */

/** 从 robotsAnalysis.url 或 llmsTxtAnalysis.url 推出站点 origin */
function siteOriginFrom(url: string): string {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.origin;
  } catch {
    return url;
  }
}

/**
 * 触发条件：
 *   - robotsAnalysis.policies 中存在 policy === "blocked"，或
 *   - llmsTxtAnalysis.exists === false。
 * 二者同 target（站点 origin）时由 mergeByTarget 合并为一条多建议机会。
 */
export function genAiCrawlProtocol(
  robots: RobotsAnalysis | undefined,
  llms: LlmsTxtAnalysis | undefined
): Opportunity[] {
  const out: Opportunity[] = [];

  if (robots) {
    const blocked = robots.policies.filter((p) => p.policy === "blocked");
    if (blocked.length > 0) {
      const target = siteOriginFrom(robots.url);
      out.push({
        id: makeOpportunityId("ai-crawl-protocol", target),
        type: "ai-crawl-protocol",
        target,
        impact: "high",
        effort: "low",
        diagnosis: {
          summary: `robots.txt 屏蔽了 ${blocked.length} 个 AI 爬虫`,
          evidence: blocked.map((p) => ({
            signal: `robots.policy.${p.crawler.ua}`,
            value: p.policy,
          })),
        },
        recommendations: [
          {
            action: `在 robots.txt 中放行被屏蔽的 AI 爬虫（${blocked.map((p) => p.crawler.ua).join("、")}）`,
            detail: "训练/检索引用类爬虫通常应放行，除非有明确的数据控制理由",
          },
        ],
        sources: [],
        verification: {
          signalKey: "aiOpennessScore",
          direction: "increase",
          description: "下次复检时 aiOpennessScore 应提升、被封禁 AI 爬虫数为 0",
        },
        affectedScope: blocked.length,
      });
    }
  }

  if (llms && !llms.exists) {
    const target = siteOriginFrom(llms.url);
    out.push({
      id: makeOpportunityId("ai-crawl-protocol", target),
      type: "ai-crawl-protocol",
      target,
      impact: "medium",
      effort: "low",
      diagnosis: {
          summary: "站点根目录缺失 llms.txt",
          evidence: [{ signal: "llmsTxt.exists", value: "absent" }],
        },
      recommendations: [
        {
          action: "在站点根目录创建 llms.txt，列出核心页面与一句话定位",
          detail: "可调用 MCP 工具 generate_llms_txt 基于真实导航生成草稿",
        },
      ],
      sources: [],
      verification: {
        signalKey: "llmsTxt.exists",
        direction: "appear",
        description: "下次复检时站点根目录应存在合规 llms.txt",
      },
      affectedScope: 1,
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* 4. site-issue-high —— T4 高影响项                                   */
/* ------------------------------------------------------------------ */

/**
 * 触发条件：T4 issues 中存在 severity === "high" 的问题。
 * 一个高影响问题对应一条机会（target = 受影响 URL 的第一个）。
 */
export function genSiteIssueHigh(
  siteAnalysis: SiteAnalysis | undefined
): Opportunity[] {
  if (!siteAnalysis) return [];
  const highs = siteAnalysis.issues.filter((i) => i.severity === "high");
  const out: Opportunity[] = [];
  for (const issue of highs) {
    const target = issue.affectedUrls[0] ?? issue.title;
    out.push({
      id: makeOpportunityId("site-issue-high", target),
      type: "site-issue-high",
      target,
      impact: "high",
      effort: "medium",
      diagnosis: {
        summary: issue.title,
        evidence: issueEvidenceToRef(issue),
      },
      recommendations: [
        {
          action: issue.suggestedFix,
          detail:
            issue.affectedUrls.length > 1
              ? `共影响 ${issue.affectedUrls.length} 个页面`
              : undefined,
        },
      ],
      sources: [],
      verification: {
        signalKey: "issueResolved",
        direction: "disappear",
        description: `下次复检时 ${issue.type} 应不再出现在该目标上`,
      },
      affectedScope: issue.affectedUrls.length,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 5. search-opportunity —— T5 GSC 机会（有则启用，无则跳过不报错）       */
/* ------------------------------------------------------------------ */

const SEARCH_HIGH_IMPACT_IMPRESSIONS = 1000; // 高曝光低 CTR 触发高影响门槛

/**
 * 触发条件：T5 GscOpportunity[] 非空。
 * 输入为 undefined 或空数组时返回 []，不报错 —— 这是任务的"优雅降级"要求。
 */
export function genSearchOpportunity(
  gscOpps: GscOpportunity[] | undefined
): Opportunity[] {
  if (!gscOpps || gscOpps.length === 0) return [];

  const out: Opportunity[] = [];
  for (const g of gscOpps) {
    let impact: ImpactLevel = "medium";
    let verification: Verification;
    if (g.kind === "high-impression-low-ctr") {
      impact = g.impressions >= SEARCH_HIGH_IMPACT_IMPRESSIONS ? "high" : "medium";
      verification = {
        signalKey: "ctr",
        direction: "increase",
        description: `下次复检时该词 CTR 应升至 2%+（当前 ${(g.ctr * 100).toFixed(2)}%）`,
      };
    } else if (g.kind === "ranking-opportunity") {
      impact = "medium";
      verification = {
        signalKey: "position",
        direction: "decrease",
        description: `下次复检时该词平均位置应进入前 3（当前 ${g.position.toFixed(1)}）`,
      };
    } else {
      // content-gap
      impact = "medium";
      verification = {
        signalKey: "pageInCrawl",
        direction: "appear",
        description: "下次复检时该 URL 应出现在站点爬取集合中",
      };
    }
    out.push({
      id: makeOpportunityId("search-opportunity", g.key),
      type: "search-opportunity",
      target: g.key,
      impact,
      effort: "medium",
      diagnosis: {
        summary: `GSC：${g.kind}（${g.key}）`,
        evidence: [
          { signal: "impressions", value: g.impressions },
          { signal: "clicks", value: g.clicks },
          { signal: "ctr", value: g.ctr },
          { signal: "position", value: g.position },
          ...g.evidence.map((e, i) => ({
            signal: `evidence[${i}]`,
            value: e,
          })),
        ],
      },
      recommendations: [{ action: g.suggestion }],
      sources: [],
      verification,
      affectedScope: g.impressions,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 6. missing-entity —— 作者/组织/发布时间/Schema 缺失                 */
/* ------------------------------------------------------------------ */

const SCHEMA_TYPES_WITH_DATE = new Set([
  "Article",
  "BlogPosting",
  "NewsArticle",
  "TechArticle",
  "Recipe",
  "Product",
  "Event",
]);

/** 检测单页缺失哪些实体信号 —— 返回缺失项与对应建议 */
function detectMissingEntities(audit: PageAudit): {
  missing: string[];
  evidence: OpportunityEvidenceRef[];
  recommendations: Recommendation[];
} {
  const missing: string[] = [];
  const evidence: OpportunityEvidenceRef[] = [];
  const recommendations: Recommendation[] = [];

  // Schema 缺失
  if (audit.jsonLdTypes.length === 0 && audit.wordCount >= 100) {
    missing.push("Schema");
    evidence.push({ signal: "jsonLdTypes", value: "[]" });
    recommendations.push({
      action: "为该页面添加 JSON-LD 结构化数据",
      detail: "按页面类型选择 Article / Product / Organization 等",
    });
  }

  // 作者缺失：ogTags 没有 article:author 且 jsonLdTypes 不含 Person/Article
  const hasAuthor =
    audit.ogTags["article:author"] ||
    audit.ogTags["og:article:author"] ||
    audit.jsonLdTypes.some((t) => t === "Person" || t === "Article");
  if (!hasAuthor) {
    missing.push("作者");
    evidence.push({ signal: "og:article:author", value: "(missing)" });
    recommendations.push({
      action: "明确标注页面作者",
      detail: "可用 og:article:author 或 JSON-LD Person",
    });
  }

  // 组织缺失：ogTags 没有 og:site_name 且 jsonLdTypes 不含 Organization
  const hasOrg =
    audit.ogTags["og:site_name"] ||
    audit.jsonLdTypes.some((t) => t === "Organization");
  if (!hasOrg) {
    missing.push("组织");
    evidence.push({ signal: "og:site_name", value: "(missing)" });
    recommendations.push({
      action: "标注发布组织",
      detail: "可用 og:site_name 或 JSON-LD Organization",
    });
  }

  // 发布时间缺失：ogTags 没有 article:published_time 且 jsonLdTypes 不含带日期的类型
  const hasDate =
    audit.ogTags["article:published_time"] ||
    audit.jsonLdTypes.some((t) => SCHEMA_TYPES_WITH_DATE.has(t));
  if (!hasDate) {
    missing.push("发布时间");
    evidence.push({ signal: "article:published_time", value: "(missing)" });
    recommendations.push({
      action: "标注发布时间",
      detail: "可用 article:published_time 或 JSON-LD datePublished",
    });
  }

  return { missing, evidence, recommendations };
}

/**
 * 触发条件：pageAudits 中存在缺失 Schema / 作者 / 组织 / 发布时间的页面。
 */
export function genMissingEntity(
  audits: PageAudit[] | undefined
): Opportunity[] {
  if (!audits || audits.length === 0) return [];
  const out: Opportunity[] = [];
  for (const audit of audits) {
    const { missing, evidence, recommendations } = detectMissingEntities(audit);
    if (missing.length === 0) continue;
    const target = audit.url;
    const hasSchemaMissing = missing.includes("Schema");
    const impact: ImpactLevel = hasSchemaMissing ? "medium" : "low";
    out.push({
      id: makeOpportunityId("missing-entity", target),
      type: "missing-entity",
      target,
      impact,
      effort: "low",
      diagnosis: {
        summary: `该页面缺失：${missing.join("、")}`,
        evidence,
      },
      recommendations,
      sources: audit.evidenceId ? [audit.evidenceId] : [],
      verification: {
        signalKey: "hasEntity",
        direction: "appear",
        description: "下次复检时该页面应具备完整作者/组织/发布时间/Schema 信号",
      },
      affectedScope: missing.length,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 7. schema-issue —— T10 Schema 缺失/不完整/内容不一致                */
/* ------------------------------------------------------------------ */

/**
 * 触发条件：T10 Schema 诊断中存在
 *   - 必填字段缺失（high），或
 *   - 推荐字段缺失/不完整、JSON-LD 与可见内容矛盾、实体标注不全（medium）。
 * 只诊断不自动改；建议引导用户复制 generate_schema_draft 草稿。
 */
export function genSchemaIssue(
  diagnoses: SchemaDiagnosis[] | undefined
): Opportunity[] {
  if (!diagnoses || diagnoses.length === 0) return [];
  const out: Opportunity[] = [];

  for (const d of diagnoses) {
    const requiredMissing = d.fieldChecks.filter(
      (f) => f.level === "required" && (f.status === "missing" || f.status === "empty")
    );
    const recommendedGap = d.fieldChecks.filter(
      (f) =>
        f.level === "recommended" &&
        (f.status === "missing" || f.status === "empty" || f.status === "incomplete")
    );
    const entityMissing = [
      d.entityClarity.author,
      d.entityClarity.organization,
      d.entityClarity.sameAs,
      d.entityClarity.contact,
      d.entityClarity.datePublished,
      d.entityClarity.dateModified,
    ].filter((s) => !s.present).length;

    // 无任何问题 → 不输出（没证据不输出）
    if (
      requiredMissing.length === 0 &&
      recommendedGap.length === 0 &&
      d.consistencyIssues.length === 0 &&
      entityMissing === 0
    ) {
      continue;
    }

    const target = d.url;
    const impact: ImpactLevel = requiredMissing.length > 0 ? "high" : "medium";

    const evidence: OpportunityEvidenceRef[] = [];
    for (const f of requiredMissing) {
      evidence.push({ signal: `schema.${d.detection.type}.required.${f.path}`, value: "missing" });
    }
    for (const f of recommendedGap.slice(0, 6)) {
      evidence.push({ signal: `schema.${d.detection.type}.recommended.${f.path}`, value: f.status });
    }
    for (const c of d.consistencyIssues) {
      evidence.push({
        signal: `schema.consistency.${c.kind}`,
        value: `${c.jsonLdValue ?? "-"} ≠ ${c.pageValue ?? "-"}`,
      });
    }
    if (entityMissing > 0) {
      evidence.push({ signal: "schema.entity.missingCount", value: entityMissing });
    }
    evidence.push({
      signal: "schema.detectedType",
      value: `${d.detection.type}(${d.detection.confidence})`,
    });

    const recommendations: Recommendation[] = [];
    if (requiredMissing.length > 0) {
      recommendations.push({
        action: `补全 ${d.detection.type} 页面的必填 Schema 字段：${requiredMissing
          .map((f) => f.path)
          .join("、")}`,
      });
    }
    if (recommendedGap.length > 0) {
      recommendations.push({
        action: `补全推荐字段：${recommendedGap.map((f) => f.path).join("、")}`,
        detail: "推荐字段直接影响 AI 对实体与内容结构的理解",
      });
    }
    for (const c of d.consistencyIssues) {
      recommendations.push({
        action:
          c.severity === "mismatch"
            ? `修正 ${c.kind}：JSON-LD 与页面内容互相矛盾`
            : `人工复核 ${c.kind}`,
        detail: c.detail,
      });
    }
    recommendations.push({
      action: "调用 MCP 工具 generate_schema_draft 获取可复制的 JSON-LD 草稿",
      detail: "草稿只含页面真实信息，拿不到的字段会标注需人工补充，需自行核对后发布",
    });

    out.push({
      id: makeOpportunityId("schema-issue", target),
      type: "schema-issue",
      target,
      impact,
      effort: "low",
      diagnosis: {
        summary:
          requiredMissing.length > 0
            ? `该页 Schema 缺 ${requiredMissing.length} 个必填字段、${recommendedGap.length} 个推荐字段`
            : `该页 Schema 有 ${recommendedGap.length + d.consistencyIssues.length} 处可改进项`,
        evidence,
      },
      recommendations,
      sources: [],
      verification: {
        signalKey: "schemaMissingRequiredCount",
        direction: "decrease",
        description: `下次复检时该 URL 的 Schema 必填缺失数应降为 0（当前 ${requiredMissing.length}）`,
      },
      affectedScope:
        requiredMissing.length + recommendedGap.length + d.consistencyIssues.length,
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* 8. poor-web-vitals —— T11 CrUX 真实用户性能指标为 poor                */
/* ------------------------------------------------------------------ */

/**
 * 触发条件：CruxObservation 中存在任一指标 category === "poor"。
 * 每条 URL 产生一条机会；影响范围 = poor 指标数。
 * 只观测不自动改；建议为规则模板（优化 LCP/INP/CLS 等）。
 */
export function genPoorWebVitals(
  observations: CruxObservation[] | undefined
): Opportunity[] {
  if (!observations || observations.length === 0) return [];
  const out: Opportunity[] = [];

  for (const obs of observations) {
    if (obs.status !== "ok" || !obs.metrics || obs.metrics.length === 0) continue;

    const poorMetrics = obs.metrics.filter((m) => m.category === "poor");
    const niMetrics = obs.metrics.filter((m) => m.category === "needs-improvement");

    // 无任何问题 → 不输出（没证据不输出）
    if (poorMetrics.length === 0 && niMetrics.length === 0) continue;

    const target = obs.target;
    const impact: ImpactLevel = poorMetrics.length > 0 ? "high" : "medium";

    const evidence: OpportunityEvidenceRef[] = [];
    for (const m of poorMetrics) {
      evidence.push({
        signal: `crux.${m.metric}.p75`,
        value: m.p75,
      });
    }
    for (const m of niMetrics.slice(0, 3)) {
      evidence.push({
        signal: `crux.${m.metric}.p75`,
        value: m.p75,
      });
    }
    evidence.push({
      signal: "crux.overallCategory",
      value: obs.overallCategory ?? "NONE",
    });

    const recommendations: Recommendation[] = [];
    for (const m of poorMetrics) {
      const label = METRIC_LABELS[m.metric] ?? m.metric;
      recommendations.push({
        action: `优化 ${label}（当前 p75=${m.p75}，超过 poor 阈值 ${m.niThreshold}）`,
        detail: getMetricOptimizationHint(m.metric),
      });
    }
    if (niMetrics.length > 0 && poorMetrics.length === 0) {
      recommendations.push({
        action: `改善 ${niMetrics.map((m) => METRIC_LABELS[m.metric] ?? m.metric).join("、")}`,
        detail: "当前处于 needs-improvement 区间，建议优化至 good 阈值以内",
      });
    }

    out.push({
      id: makeOpportunityId("poor-web-vitals", target),
      type: "poor-web-vitals",
      target,
      impact,
      effort: "medium",
      diagnosis: {
        summary:
          poorMetrics.length > 0
            ? `该页 ${poorMetrics.length} 项 Web Vitals 指标为 poor（${poorMetrics.map((m) => METRIC_LABELS[m.metric]).join("、")}）`
            : `该页 ${niMetrics.length} 项 Web Vitals 指标处于 needs-improvement 区间`,
        evidence,
      },
      recommendations,
      sources: [],
      verification: {
        signalKey: "crux.overallCategory",
        direction: "increase",
        description: `下次复检时该 URL 的 CrUX overallCategory 应提升（当前 ${obs.overallCategory}）`,
      },
      affectedScope: poorMetrics.length + niMetrics.length,
    });
  }

  return out;
}

/** 规则模板：各指标优化建议（不调 LLM，可复现） */
function getMetricOptimizationHint(metric: string): string {
  switch (metric) {
    case "largest_contentful_paint":
      return "优化图片/字体加载、减少渲染阻塞资源、使用 CDN、服务端渲染";
    case "interaction_to_next_paint":
      return "减少 JavaScript 执行时间、拆分长任务、优化事件处理程序";
    case "cumulative_layout_shift":
      return "为图片/视频设置尺寸属性、避免动态插入内容、使用 CSS transform 动画";
    case "first_contentful_paint":
      return "减少服务器响应时间、预加载关键资源、减少阻塞渲染的 CSS/JS";
    case "experimental_time_to_first_byte":
      return "优化服务器响应、使用 CDN、启用缓存、减少重定向";
    default:
      return "参考 web.dev 优化指南";
  }
}
