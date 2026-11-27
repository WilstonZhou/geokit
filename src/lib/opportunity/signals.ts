/**
 * Opportunity 复检用的纯信号计算。
 *
 * 这里的函数同时被「生成机会」和「复检机会」使用，保证两侧口径完全一致：
 * 生成时按什么条件判定缺失，复检时就按同一条件重新计算。
 */

/** 常见带发布时间的 Schema 类型 */
export const SCHEMA_TYPES_WITH_DATE = new Set([
  "Article",
  "BlogPosting",
  "NewsArticle",
  "TechArticle",
  "Recipe",
  "Product",
  "Event",
]);

/** PageAudit 中与 missing-entity 判定相关的结构子集 */
export interface EntityAuditSignals {
  jsonLdTypes: string[];
  wordCount: number;
  ogTags: Record<string, string>;
}

export type MissingEntityKind = "Schema" | "作者" | "组织" | "发布时间";

/**
 * 计算页面缺失的实体信号。
 *
 * 与 generators.ts 原逻辑逐条对应；复检时 readSignal 复用同一个函数，
 * 避免“生成用一套规则、复检用另一套规则”。
 */
export function missingEntityKinds(
  audit: EntityAuditSignals
): MissingEntityKind[] {
  const missing: MissingEntityKind[] = [];

  if (audit.jsonLdTypes.length === 0 && audit.wordCount >= 100) {
    missing.push("Schema");
  }

  const hasAuthor =
    Boolean(audit.ogTags["article:author"]) ||
    Boolean(audit.ogTags["og:article:author"]) ||
    audit.jsonLdTypes.some((t) => t === "Person" || t === "Article");
  if (!hasAuthor) missing.push("作者");

  const hasOrg =
    Boolean(audit.ogTags["og:site_name"]) ||
    audit.jsonLdTypes.some((t) => t === "Organization");
  if (!hasOrg) missing.push("组织");

  const hasDate =
    Boolean(audit.ogTags["article:published_time"]) ||
    audit.jsonLdTypes.some((t) => SCHEMA_TYPES_WITH_DATE.has(t));
  if (!hasDate) missing.push("发布时间");

  return missing;
}

export function missingEntityCount(audit: EntityAuditSignals): number {
  return missingEntityKinds(audit).length;
}

/** 从任意对象里安全读取 EntityAuditSignals 子集；字段缺失按空处理 */
export function asEntityAudit(value: unknown): EntityAuditSignals | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  return {
    jsonLdTypes: Array.isArray(o.jsonLdTypes)
      ? o.jsonLdTypes.filter((t): t is string => typeof t === "string")
      : [],
    wordCount: typeof o.wordCount === "number" ? o.wordCount : 0,
    ogTags:
      o.ogTags && typeof o.ogTags === "object"
        ? (o.ogTags as Record<string, string>)
        : {},
  };
}
