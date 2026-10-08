/**
 * 鲸析 GEOkit — Schema / 实体诊断模块入口（T10）。
 */
export * from "./types";
export {
  extractFacts,
  parseJsonLdNodes,
  parseRootTypes,
  normalizeDate,
  type PageFacts,
  type JsonLdNode,
} from "./extract";
export {
  detectPageType,
  TYPE_PATTERNS,
  CONTENT_TYPE_PRIORITY,
  FAQ_MIN_QUESTIONS,
  HOWTO_MIN_STEPS,
  ARTICLE_MIN_WORDS,
} from "./detect";
export { FIELD_CATALOG, checkFields, checkConsistency } from "./fields";
export { checkEntityClarity } from "./entity";
export { generateDraft } from "./draft";
export {
  analyzeSchema,
  buildSchemaDraft,
  analyzeSchemaUrl,
  type SchemaUrlResult,
} from "./analyze";
