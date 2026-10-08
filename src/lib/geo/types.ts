/**
 * GEO（生成式引擎优化）评分类型定义与契约。
 *
 * 遵循版本化演进哲学：评分模型会随大模型检索与引用机制的发展而迭代，
 * 每次重大规则或权重调整必须升级版本号，以确保历史数据具备可追溯性与明确比对边界。
 */

export type GeoVersion = "1.0.0" | "2.0.0";

export interface GeeBreakdown {
  id: string;
  label: string;
  score: number;
  max: number;
  comment: string;
}

export interface GeoResult {
  version: GeoVersion;
  /**
   * 评分规则细粒度版本（区别于 `version` 的模型代际）。
   *
   * - `version` 是用户可选的模型代际（"1.0.0" | "2.0.0"），决定走哪个 computeGeoV*；
   * - `scoringVersion` 跟踪同一代际内评分子规则/信号集的演进（如 "2.0.0" → "2.1.0"）。
   *
   * 当评分规则发生变化（新增信号、子权重重分配）时必须递增它，
   * 让 diff 引擎能在历史比对时识别「分数涨跌含规则换代成分」并给出提示，
   * 而不是把口径变化误读成站点真实表现变化。
   */
  scoringVersion: string;
  total: number;
  breakdown: GeeBreakdown[];
  recommendations: string[];
}

export interface ContentShape {
  paragraphs: number;
  lists: number;
  listItems: number;
  tables: number;
  quotes: number;
  codeBlocks: number;
  dataPoints: number;
  externalCitations: number;
  hasTldr: boolean;
  avgSentenceLength: number;
  /** v2: 是否具备首段高置信度直接回答（Direct Answer） */
  hasDirectAnswer?: boolean;
  /** v2: 是否包含标准 HTML5 语义地标标签（main, article, section 等） */
  hasSemanticLandmarks?: boolean;
  /** v2: 标题层级是否连续无跳跃（RAG Chunking 分块健康度） */
  headingContinuity?: boolean;
  /** v2.1: 是否具备 FAQ/Q&A 结构（FAQPage JSON-LD 或 ≥2 个疑问句 heading + 答案块） */
  hasFaqStructure?: boolean;
  /** v2.1: 结构化元素密度 (listItems + tables*3) / max(paragraphs,1) */
  structuredElementDensity?: number;
  /** v2.1: 作者是否具备权威链接（author.sameAs 或 article:author + 作者主页 a） */
  hasAuthorAuthority?: boolean;
  /** v2.1: 是否引用权威来源（.gov/.edu/.mil 或 ≥2 个不同权威域名） */
  hasAuthoritativeSources?: boolean;
  /** v2.1: 更新时间一致性（modified >= published 且 modified 距今 ≤365 天） */
  hasDateConsistency?: boolean;
}

export interface JsonLdInfo {
  types: string[];
  hasAuthor: boolean;
  hasOrganization: boolean;
  hasDatePublished: boolean;
  hasDateModified: boolean;
  /** v2: 是否包含权威消歧属性（sameAs / identifier） */
  hasSameAs?: boolean;
  /** v2.1: 是否检测到 FAQPage 类型（Q&A 摘要搬运首选信源） */
  hasFaqPage?: boolean;
  /** v2.1: 作者节点（author/creator）是否具备 sameAs 权威链接 */
  hasAuthorSameAs?: boolean;
}

export interface CheckItem {
  id: string;
  level: "pass" | "warn" | "fail";
  weight: number;
}

export interface GeoInput {
  html: string;
  checks: CheckItem[];
  contentShape: ContentShape;
  jsonLdTypes: string[];
  allMeta: Record<string, string>;
  wordCount: number;
  headings: { level: number; text: string }[];
  lang: string | null;
  canonical: string | null;
  ld: JsonLdInfo;
}
