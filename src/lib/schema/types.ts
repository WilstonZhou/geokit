/**
 * 鲸析 GEOkit — Schema / 实体诊断类型定义（T10）。
 *
 * 设计铁律：
 *   1. 只诊断、只给草稿 —— 不自动修改站点；
 *   2. 每条结论必须有 evidence（signal + source + value），规则驱动可复现；
 *   3. 草稿零编造 —— JSON 正文只填页面真实存在的信息，
 *      拿不到的字段进 manualFields 清单而不是写进 JSON。
 */

/* ------------------------------------------------------------------ */
/* 页面类型                                                            */
/* ------------------------------------------------------------------ */

/**
 * 支持检测的页面类型。
 * unknown = 规则无法判定（如实告知，不硬猜）。
 */
export const PAGE_TYPES = [
  "article",
  "product",
  "faq",
  "howto",
  "local-business",
  "organization",
  "website",
  "unknown",
] as const;

export type PageType = (typeof PAGE_TYPES)[number];

/** 该类型对应的 Schema.org 主类型名（草稿 @type 用） */
export const PAGE_TYPE_SCHEMA: Record<Exclude<PageType, "unknown">, string> = {
  article: "Article",
  product: "Product",
  faq: "FAQPage",
  howto: "HowTo",
  "local-business": "LocalBusiness",
  organization: "Organization",
  website: "WebSite",
};

export type DetectionConfidence = "high" | "medium" | "low";

/** 单条判定依据 —— 类型检测为什么得出这个结论 */
export interface TypeSignal {
  /** 信号名，如 "jsonld:@type" / "meta:article:published_time" / "heading:questions" */
  signal: string;
  /** 观测值（简短可展示） */
  value: string;
  /** 来源：jsonld / meta / visible / url */
  source: "jsonld" | "meta" | "visible" | "url";
}

export interface PageTypeDetection {
  type: PageType;
  confidence: DetectionConfidence;
  /** 主判定依据（非空 —— unknown 时为空数组） */
  signals: TypeSignal[];
  /** 所有候选类型（含主类型），按置信度降序 */
  candidates: { type: PageType; confidence: DetectionConfidence }[];
}

/* ------------------------------------------------------------------ */
/* 字段检查与一致性                                                    */
/* ------------------------------------------------------------------ */

export type FieldRequirementLevel = "required" | "recommended";

export type FieldStatus =
  | "present" // 存在且有值
  | "empty" // 字段在但为空值（"" / null）
  | "incomplete" // 存在但不完整（如 offers 缺 price、Question 缺 acceptedAnswer）
  | "missing"; // 完全缺失

/** 一个 Schema 字段的检查结果 */
export interface FieldCheck {
  /** 字段路径，如 "headline" / "offers.price" / "mainEntity[].acceptedAnswer.text" */
  path: string;
  level: FieldRequirementLevel;
  status: FieldStatus;
  /** 现值（仅 present/incomplete 时带，便于人工核对） */
  observed?: string;
  note?: string;
}

export type ConsistencySeverity = "mismatch" | "suspect";

/**
 * JSON-LD 与页面可见内容的一致性问题。
 *
 * mismatch = 两侧都有明确值但互相矛盾；
 * suspect  = 只有一侧有值、或规范化后疑似不一致（弱判定，供人工复核）。
 */
export interface ConsistencyIssue {
  kind:
    | "headline-h1-mismatch"
    | "date-published-mismatch"
    | "author-mismatch"
    | "title-mismatch";
  severity: ConsistencySeverity;
  jsonLdValue?: string;
  pageValue?: string;
  detail: string;
}

/* ------------------------------------------------------------------ */
/* 实体清晰度                                                          */
/* ------------------------------------------------------------------ */

export interface EntitySignal {
  present: boolean;
  /** 观测到的值或形态，如 "Dr. GEO" / "sameAs×2" */
  value?: string;
  /** 来源：jsonld / meta / visible */
  source?: "jsonld" | "meta" | "visible";
}

export interface EntityClarity {
  author: EntitySignal;
  organization: EntitySignal;
  sameAs: EntitySignal;
  /** 联系方式：mailto / tel / 地址 任一 */
  contact: EntitySignal;
  datePublished: EntitySignal;
  dateModified: EntitySignal;
}

/* ------------------------------------------------------------------ */
/* 诊断结果                                                            */
/* ------------------------------------------------------------------ */

export interface SchemaDiagnosis {
  url: string;
  detection: PageTypeDetection;
  /** 页面中已存在的 JSON-LD @type 列表 */
  existingTypes: string[];
  /** 页面中已存在的 JSON-LD 原始节点（解析后），空数组=无 */
  existingNodes: unknown[];
  /** 对照页面类型的字段检查；unknown 类型时为空数组 */
  fieldChecks: FieldCheck[];
  consistencyIssues: ConsistencyIssue[];
  entityClarity: EntityClarity;
  /** 必填缺失数（机会分级用） */
  missingRequiredCount: number;
  /** 推荐缺失/不完整数 */
  missingRecommendedCount: number;
  /** 清单式建议（不含自动改动） */
  recommendations: string[];
}

/* ------------------------------------------------------------------ */
/* JSON-LD 草稿                                                        */
/* ------------------------------------------------------------------ */

/**
 * 需人工补充的字段说明 —— 刻意不进 JSON 正文（零编造）。
 */
export interface ManualField {
  /** 目标 JSON 路径，如 "offers.price" */
  path: string;
  /** 人可读字段名 */
  label: string;
  level: FieldRequirementLevel;
  /** 为什么需要 / 怎么填 */
  reason: string;
}

export interface SchemaDraft {
  url: string;
  pageType: PageType;
  schemaType: string | null;
  /**
   * 可直接复制的 JSON-LD 对象 —— **只含页面真实存在的值**。
   * 已序列化为字符串版本见 jsonLdString。
   */
  jsonLd: Record<string, unknown> | null;
  /** 序列化后的可复制正文（2 空格缩进）；无任何可填值时为 null */
  jsonLdString: string | null;
  /** 已从页面真实信息填入的字段路径 */
  filledFields: string[];
  /** 拿不到、需人工补充的字段（不出现在 jsonLd 中） */
  manualFields: ManualField[];
  /** 草稿基于哪些页面事实生成（供核对，防幻觉） */
  sourcedFrom: { field: string; source: string; value: string }[];
}
