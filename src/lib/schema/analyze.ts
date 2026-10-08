/**
 * 鲸析 GEOkit — Schema 诊断主编排（T10）。
 *
 * analyzeSchema 是纯函数（url + html），便于测试与离线注入；
 * analyzeSchemaUrl 负责抓取，失败如实抛出/返回错误状态，不伪造诊断。
 */
import { fetchWithPolicy } from "../fetcher";
import { extractFacts } from "./extract";
import { detectPageType } from "./detect";
import { checkFields, checkConsistency, schemaTypeOf } from "./fields";
import { checkEntityClarity } from "./entity";
import { generateDraft } from "./draft";
import type { SchemaDiagnosis, SchemaDraft } from "./types";

const FETCH_TIMEOUT_MS = 15_000;

/** 纯函数：从 HTML 完成 Schema / 实体诊断 */
export function analyzeSchema(url: string, html: string): SchemaDiagnosis {
  const facts = extractFacts(url, html);
  const detection = detectPageType(facts);
  const fieldChecks = checkFields(detection.type, facts.jsonLdNodes);
  const consistencyIssues = checkConsistency(detection.type, facts);
  const entityClarity = checkEntityClarity(facts);

  const existingTypes = Array.from(
    new Set(facts.jsonLdNodes.flatMap((n) => n.types))
  ).sort();

  const missingRequired = fieldChecks.filter(
    (f) => f.level === "required" && (f.status === "missing" || f.status === "empty")
  );
  const missingRecommended = fieldChecks.filter(
    (f) =>
      f.level === "recommended" &&
      (f.status === "missing" || f.status === "empty" || f.status === "incomplete")
  );

  const recommendations: string[] = [];

  if (detection.type === "unknown") {
    recommendations.push(
      "页面类型无法根据现有信号自动判定：请人工确认页面类型后，再按 Schema.org 选择对应结构化数据。"
    );
  } else if (existingTypes.length === 0) {
    recommendations.push(
      `页面未检测到任何 JSON-LD：建议按「${schemaTypeOf(detection.type)}」类型添加结构化数据，可调用 generate_schema_draft 获取可复制草稿。`
    );
  } else {
    if (missingRequired.length > 0) {
      recommendations.push(
        `补全 ${schemaTypeOf(detection.type)} 的必填字段：${missingRequired
          .map((f) => f.path)
          .join("、")}。`
      );
    }
    if (missingRecommended.length > 0) {
      recommendations.push(
        `建议补全推荐字段：${missingRecommended.map((f) => f.path).join("、")}。`
      );
    }
  }

  for (const issue of consistencyIssues) {
    recommendations.push(
      `${issue.severity === "mismatch" ? "修正不一致" : "人工复核"}：${issue.detail}`
    );
  }

  const entityMissing: string[] = [];
  if (!entityClarity.author.present) entityMissing.push("作者");
  if (!entityClarity.organization.present) entityMissing.push("组织");
  if (!entityClarity.sameAs.present) entityMissing.push("sameAs 权威链接");
  if (!entityClarity.contact.present) entityMissing.push("联系方式");
  if (!entityClarity.datePublished.present) entityMissing.push("发布时间");
  if (!entityClarity.dateModified.present) entityMissing.push("更新时间");
  if (entityMissing.length > 0) {
    recommendations.push(
      `实体标注不完整，缺失：${entityMissing.join("、")}；这些信号帮助 AI 确认内容的责任主体与时效。`
    );
  }

  return {
    url,
    detection,
    existingTypes,
    existingNodes: facts.jsonLdNodes.map((n) => n.node),
    fieldChecks,
    consistencyIssues,
    entityClarity,
    missingRequiredCount: missingRequired.length,
    missingRecommendedCount: missingRecommended.length,
    recommendations,
  };
}

/** 纯函数：基于诊断结果与 HTML 生成零编造草稿 */
export function buildSchemaDraft(url: string, html: string): SchemaDraft {
  const facts = extractFacts(url, html);
  const detection = detectPageType(facts);
  return generateDraft(url, detection.type, facts);
}

export interface SchemaUrlResult {
  ok: boolean;
  finalUrl: string;
  httpStatus: number;
  diagnosis?: SchemaDiagnosis;
  draft?: SchemaDraft;
  error?: string;
}

/** 抓取 URL 并完成诊断 + 草稿（不存证，诊断是建议性旁路） */
export async function analyzeSchemaUrl(inputUrl: string): Promise<SchemaUrlResult> {
  const normalized = /^https?:\/\//i.test(inputUrl.trim())
    ? inputUrl.trim()
    : `https://${inputUrl.trim()}`;

  const grabbed = await fetchWithPolicy({
    url: normalized,
    timeoutMs: FETCH_TIMEOUT_MS,
    followRedirect: true,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 GEOkitBot/0.1 (+https://geokit.dev/bot)",
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
    purpose: "audit",
    target: normalized,
  });

  const finalUrl = grabbed.finalUrl || normalized;
  if (!grabbed.ok || grabbed.body === "") {
    return {
      ok: false,
      finalUrl,
      httpStatus: grabbed.status,
      error: grabbed.error?.message ?? "页面抓取失败或正文为空",
    };
  }

  const diagnosis = analyzeSchema(finalUrl, grabbed.body);
  const draft = buildSchemaDraft(finalUrl, grabbed.body);
  return { ok: true, finalUrl, httpStatus: grabbed.status, diagnosis, draft };
}
