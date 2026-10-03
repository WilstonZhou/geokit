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
}

export interface JsonLdInfo {
  types: string[];
  hasAuthor: boolean;
  hasOrganization: boolean;
  hasDatePublished: boolean;
  hasDateModified: boolean;
  /** v2: 是否包含权威消歧属性（sameAs / identifier / url） */
  hasSameAs?: boolean;
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
