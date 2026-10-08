/**
 * 鲸析 GEOkit — Google Search Console 数据接入类型（T5，可选能力）
 *
 * 原则：未配置凭证时整个能力返回 `unavailable` 并说明如何配置，
 * 不影响其他功能。零新增依赖：只用 fetch 调 Search Console API。
 */

export type GscDimension = "query" | "page" | "date" | "country" | "device";

/** Search Analytics 一行数据（维度值 + 四指标） */
export interface GscRow {
  /** 与请求 dimensions 顺序对应的维度值 */
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscQueryParams {
  /** Search Console 资源，如 sc-domain:example.com 或 https://example.com/ */
  siteUrl: string;
  /** YYYY-MM-DD */
  startDate: string;
  /** YYYY-MM-DD */
  endDate: string;
  dimensions?: GscDimension[];
  /** 单页行数，默认 1000，API 上限 25000 */
  rowLimit?: number;
}

/** 小写四态 —— 与 T1 观测模型一致，抓不到就说清为什么 */
export type GscStatus = "ok" | "blocked" | "unavailable" | "error";

export interface GscQueryResult {
  status: GscStatus;
  /** blocked/unavailable/error 时必填 —— schema 层同规则 */
  statusReason?: string;
  /** 401/403/429/5xx 等原始状态码，便于定位 */
  httpStatus?: number;
  rows: GscRow[];
  siteUrl?: string;
  startDate?: string;
  endDate?: string;
  dimensions?: GscDimension[];
  /** 实际分页拉取的总行数（可能受 rowLimit 限制） */
  rowCount?: number;
}

/* ── 凭证 ─────────────────────────────────────────────────────── */

export interface AccessTokenCredential {
  kind: "access_token";
  accessToken: string;
}

export interface ServiceAccountCredential {
  kind: "service_account";
  clientEmail: string;
  /** PEM 私钥（来自 service account JSON 的 private_key） */
  privateKey: string;
  /** 换取令牌的端点，默认 https://oauth2.googleapis.com/token */
  tokenUri: string;
}

export type GscCredential = AccessTokenCredential | ServiceAccountCredential;

/* ── 机会分析（纯函数产物）──────────────────────────────────────── */

export type OpportunityKind =
  | "high-impression-low-ctr"
  | "ranking-opportunity"
  | "content-gap";

export interface GscOpportunity {
  kind: OpportunityKind;
  /** 维度组合的展示名（query 或 URL） */
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  /** 触发该机会的具体阈值证据，人可读 */
  evidence: string[];
  /** 一句话建议 */
  suggestion: string;
}

export interface PeriodDiffEntry {
  key: string;
  clicksDelta: number;
  impressionsDelta: number;
  positionDelta: number;
  prev: { clicks: number; impressions: number; position: number };
  cur: { clicks: number; impressions: number; position: number };
}

export interface PeriodDiff {
  improved: PeriodDiffEntry[];
  declined: PeriodDiffEntry[];
  newKeys: string[];
  lostKeys: string[];
}
