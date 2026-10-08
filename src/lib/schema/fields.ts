/**
 * 鲸析 GEOkit — Schema 字段目录、完整性检查与内容一致性（T10）。
 *
 * 字段目录按 Schema.org 官方定义精简为「必填 / 推荐」两级，常量全部导出。
 * 检查只针对页面中已有的 JSON-LD 节点 —— meta 与可见内容的有无
 * 属于实体清晰度与草稿生成的职责，不在此处混淆。
 */
import type { PageFacts, JsonLdNode } from "./extract";
import { nodesOfType, deepStr } from "./extract";
import { PAGE_TYPE_SCHEMA } from "./types";
import type {
  ConsistencyIssue,
  FieldCheck,
  FieldRequirementLevel,
  FieldStatus,
  PageType,
} from "./types";

/* ------------------------------------------------------------------ */
/* 字段目录（透明常量）                                                */
/* ------------------------------------------------------------------ */

export interface FieldSpec {
  path: string;
  level: FieldRequirementLevel;
}

/**
 * 每种页面类型的字段目录。
 * 依据 Schema.org（2026）：required = 官方标 Required 的最小可用集；
 * recommended = 官方 Recommended 中对 AI/搜索理解收益最高的子集。
 */
export const FIELD_CATALOG: Record<
  Exclude<PageType, "unknown">,
  { matchTypes: RegExp; fields: FieldSpec[] }
> = {
  article: {
    matchTypes: /Article|BlogPosting|NewsArticle|TechArticle|Report/i,
    fields: [
      { path: "headline", level: "required" },
      { path: "datePublished", level: "required" },
      { path: "author.name", level: "recommended" },
      { path: "publisher.name", level: "recommended" },
      { path: "dateModified", level: "recommended" },
      { path: "image", level: "recommended" },
      { path: "mainEntityOfPage", level: "recommended" },
      { path: "description", level: "recommended" },
    ],
  },
  product: {
    matchTypes: /^(Product|ProductGroup|ProductModel)$/i,
    fields: [
      { path: "name", level: "required" },
      { path: "image", level: "recommended" },
      { path: "description", level: "recommended" },
      { path: "brand.name", level: "recommended" },
      { path: "offers.price", level: "recommended" },
      { path: "offers.priceCurrency", level: "recommended" },
      { path: "offers.availability", level: "recommended" },
      { path: "sku", level: "recommended" },
      { path: "aggregateRating.ratingValue", level: "recommended" },
    ],
  },
  faq: {
    matchTypes: /FAQPage|QAPage/i,
    fields: [
      { path: "mainEntity", level: "required" },
      { path: "mainEntity[].name", level: "recommended" },
      { path: "mainEntity[].acceptedAnswer.text", level: "recommended" },
    ],
  },
  howto: {
    matchTypes: /HowTo/i,
    fields: [
      { path: "name", level: "required" },
      { path: "step", level: "required" },
      { path: "step[].text", level: "recommended" },
      { path: "totalTime", level: "recommended" },
      { path: "description", level: "recommended" },
      { path: "tool", level: "recommended" },
    ],
  },
  "local-business": {
    matchTypes: /LocalBusiness|Restaurant|Store|ProfessionalService/i,
    fields: [
      { path: "name", level: "required" },
      { path: "address", level: "required" },
      { path: "telephone", level: "recommended" },
      { path: "openingHours", level: "recommended" },
      { path: "address.streetAddress", level: "recommended" },
      { path: "address.addressLocality", level: "recommended" },
      { path: "url", level: "recommended" },
      { path: "geo", level: "recommended" },
    ],
  },
  organization: {
    matchTypes: /Organization|NGO|Corporation/i,
    fields: [
      { path: "name", level: "required" },
      { path: "url", level: "required" },
      { path: "logo", level: "recommended" },
      { path: "sameAs", level: "recommended" },
      { path: "contactPoint.telephone", level: "recommended" },
      { path: "contactPoint.email", level: "recommended" },
      { path: "address", level: "recommended" },
    ],
  },
  website: {
    matchTypes: /^WebSite$/i,
    fields: [
      { path: "name", level: "required" },
      { path: "url", level: "required" },
      { path: "potentialAction", level: "recommended" },
      { path: "description", level: "recommended" },
    ],
  },
};

/* ------------------------------------------------------------------ */
/* 字段取值                                                            */
/* ------------------------------------------------------------------ */

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

/**
 * 按路径取值。支持：
 *   a.b.c            普通嵌套（数组自动取首个）
 *   mainEntity[].x   数组所有元素的 a.b 值
 * 返回 null=不存在；{ kind:"array", values }=数组路径
 */
type PathResult =
  | { kind: "scalar"; exists: boolean; value: unknown }
  | { kind: "array"; total: number; values: unknown[] };

function readPath(root: Record<string, unknown>, path: string): PathResult {
  const parts = path.split(".");
  const arrayIdx = parts.findIndex((p) => p.endsWith("[]"));

  if (arrayIdx === -1) {
    let cur: unknown = root;
    for (const p of parts) {
      if (cur === null || typeof cur !== "object") {
        return { kind: "scalar", exists: false, value: undefined };
      }
      cur = (cur as Record<string, unknown>)[p];
      if (Array.isArray(cur)) cur = cur[0];
    }
    return { kind: "scalar", exists: cur !== undefined, value: cur };
  }

  // 数组路径：先定位到数组
  let cur: unknown = root;
  for (let i = 0; i < arrayIdx; i++) {
    if (cur === null || typeof cur !== "object") {
      return { kind: "array", total: 0, values: [] };
    }
    cur = (cur as Record<string, unknown>)[parts[i]!];
    if (Array.isArray(cur)) cur = cur[0];
  }
  const arrKey = parts[arrayIdx]!.slice(0, -2);
  cur = (cur as Record<string, unknown>)?.[arrKey];
  const items = Array.isArray(cur) ? cur : cur === undefined ? [] : [cur];
  const rest = parts.slice(arrayIdx + 1);
  const values = items.map((item) => {
    let v: unknown = item;
    for (const p of rest) {
      if (v === null || typeof v !== "object") return undefined;
      v = (v as Record<string, unknown>)[p];
      if (Array.isArray(v)) v = v[0];
    }
    return v;
  });
  return { kind: "array", total: items.length, values };
}

function displayValue(v: unknown): string | undefined {
  if (isEmptyValue(v)) return undefined;
  if (typeof v === "string") return v.slice(0, 120);
  try {
    return JSON.stringify(v)!.slice(0, 120);
  } catch {
    return String(v);
  }
}

/* ------------------------------------------------------------------ */
/* 完整性检查                                                          */
/* ------------------------------------------------------------------ */

export function checkFields(
  pageType: PageType,
  nodes: JsonLdNode[]
): FieldCheck[] {
  if (pageType === "unknown") return [];
  const catalog = FIELD_CATALOG[pageType];
  const target = nodesOfType(nodes, catalog.matchTypes)[0];
  // 页面没有该类型的 JSON-LD：目录全部记 missing
  if (!target) {
    return catalog.fields.map((f) => ({
      path: f.path,
      level: f.level,
      status: "missing" as FieldStatus,
    }));
  }

  const out: FieldCheck[] = [];
  for (const spec of catalog.fields) {
    const res = readPath(target.node, spec.path);

    if (res.kind === "array") {
      const filled = res.values.filter((v) => !isEmptyValue(v)).length;
      let status: FieldStatus = "missing";
      if (res.total === 0) status = "missing";
      else if (filled === res.total) status = "present";
      else status = "incomplete";
      out.push({
        path: spec.path,
        level: spec.level,
        status,
        observed: filled > 0 ? `${filled}/${res.total} 项已填` : undefined,
        note: status === "incomplete" ? "部分条目缺该字段" : undefined,
      });
      continue;
    }

    if (!res.exists || isEmptyValue(res.value)) {
      out.push({ path: spec.path, level: spec.level, status: "missing" });
    } else {
      out.push({
        path: spec.path,
        level: spec.level,
        status: "present",
        observed: displayValue(res.value),
      });
    }
  }

  // 主字段为空字符串的专门判定（字段在但为空）
  for (const c of out) {
    if (c.status !== "missing") continue;
    const res = readPath(target.node, c.path);
    if (
      res.kind === "scalar" &&
      res.exists &&
      (res.value === "" || res.value === null)
    ) {
      c.status = "empty";
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* 一致性检查：JSON-LD vs 页面可见内容                                 */
/* ------------------------------------------------------------------ */

function normText(s: string | undefined | null): string {
  return (s ?? "")
    .replace(/\s+/g, " ")
    .replace(/[|｜·]\s*[^|｜·]{2,40}$/, "") // 去掉标题尾部站名
    .trim()
    .toLowerCase();
}

/** 包含/被包含且长度差不超过 40% 视为一致 */
function textAgrees(a: string, b: string): boolean {
  const x = normText(a);
  const y = normText(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const longer = Math.max(x.length, y.length);
  const shorter = Math.min(x.length, y.length);
  if (shorter / longer < 0.6) return false;
  return x.includes(y) || y.includes(x);
}

function isoDay(v: unknown): string | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const t = Date.parse(v);
  if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 10);
  return undefined;
}

export function checkConsistency(
  pageType: PageType,
  facts: PageFacts
): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  if (pageType === "unknown") return issues;
  const catalog = FIELD_CATALOG[pageType];
  const target = nodesOfType(facts.jsonLdNodes, catalog.matchTypes)[0];
  if (!target) return issues;
  const n = target.node;

  // headline/name ↔ H1
  const jsonHeadline =
    deepStr(n, "headline") ?? deepStr(n, "name");
  if (jsonHeadline && facts.h1 && !textAgrees(jsonHeadline, facts.h1)) {
    issues.push({
      kind: "headline-h1-mismatch",
      severity: "mismatch",
      jsonLdValue: jsonHeadline,
      pageValue: facts.h1,
      detail: `JSON-LD ${deepStr(n, "headline") ? "headline" : "name"} 与页面 H1 不一致，搜索引擎与 AI 会对页面主题产生歧义`,
    });
  }

  // datePublished ↔ 页面日期（meta 或正文可见日期）
  const jsonDate = isoDay(n["datePublished"]);
  const pageDates = [facts.publishedDate, ...facts.visibleDates].filter(
    (d): d is string => !!d
  );
  if (jsonDate && pageDates.length > 0 && !pageDates.includes(jsonDate)) {
    issues.push({
      kind: "date-published-mismatch",
      severity: "mismatch",
      jsonLdValue: jsonDate,
      pageValue: pageDates[0],
      detail: "JSON-LD datePublished 与页面标注的日期不一致，时效性信号互相矛盾",
    });
  }

  // author.name ↔ meta author
  const jsonAuthor = deepStr(n, "author", "name");
  if (
    jsonAuthor &&
    facts.author &&
    !textAgrees(jsonAuthor, facts.author)
  ) {
    issues.push({
      kind: "author-mismatch",
      severity: "suspect",
      jsonLdValue: jsonAuthor,
      pageValue: facts.author,
      detail: "JSON-LD 作者署名与 meta author 不一致，建议人工复核",
    });
  }

  // 组织/官网：name ↔ og:site_name
  if (pageType === "organization" || pageType === "website") {
    const jsonName = deepStr(n, "name");
    const siteName = facts.ogSiteName ?? facts.title;
    if (jsonName && siteName && !textAgrees(jsonName, siteName)) {
      issues.push({
        kind: "title-mismatch",
        severity: "suspect",
        jsonLdValue: jsonName,
        pageValue: siteName,
        detail: "JSON-LD name 与站点名称不一致，建议人工复核",
      });
    }
  }

  return issues;
}

/** 主 Schema 类型名（供草稿与展示） */
export function schemaTypeOf(pageType: PageType): string | null {
  return pageType === "unknown" ? null : PAGE_TYPE_SCHEMA[pageType];
}
