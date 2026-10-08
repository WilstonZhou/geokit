/**
 * 鲸析 GEOkit — JSON-LD 草稿生成（T10 任务 4）。
 *
 * 铁律：零编造。
 *   - JSON 正文只放页面真实存在、来源可追溯的信息；
 *   - 拿不到的字段一律不进 JSON，进 manualFields 清单标注「需人工补充」；
 *   - 价格无币种不填、评分不做文本猜测、作者/品牌绝不臆造；
 *   - 已存在的 JSON-LD 同类型节点原样保留，只补缺不覆盖。
 */
import type { PageFacts } from "./extract";
import { nodesOfType } from "./extract";
import { FIELD_CATALOG } from "./fields";
import type {
  FieldRequirementLevel,
  ManualField,
  PageType,
  SchemaDraft,
} from "./types";

interface Built {
  json: Record<string, unknown>;
  filledFields: string[];
  sourcedFrom: { field: string; source: string; value: string }[];
  manualFields: ManualField[];
}

const SCHEMA_CONTEXT = "https://schema.org";

/** 字段补全的人可读理由（路径 → 为什么需要/怎么填） */
const FIELD_REASONS: Record<string, string> = {
  headline: "文章主标题，通常取页面 H1",
  datePublished: "首次发布日期（ISO 8601，如 2026-10-08）",
  "author.name": "作者真实姓名，可在正文署名处补充",
  "publisher.name": "发布机构名称",
  dateModified: "最近更新日期，页面有更新机制后务必回填",
  image: "代表性配图 URL（需可公开访问）",
  mainEntityOfPage: "规范文章 URL",
  description: "一句话摘要，可参考 meta description",
  name: "实体名称，通常取页面 H1 或站点名",
  "brand.name": "品牌名，以页面真实展示为准",
  "offers.price": "商品实际售价（数字）",
  "offers.priceCurrency": "ISO 4217 币种代码（如 CNY/USD）—— 仅有价格符号无法确定时需人工确认",
  "offers.availability": "供货状态（如 https://schema.org/InStock）",
  sku: "商品 SKU 编码",
  "aggregateRating.ratingValue": "评分必须来自真实评价系统，严禁编造（Google 会处罚虚假评分）",
  mainEntity: "问答条目数组：每条含问题 name 与 acceptedAnswer.text",
  "mainEntity[].name": "每个问题的完整表述",
  "mainEntity[].acceptedAnswer.text": "每个问题对应的答案正文",
  step: "步骤数组",
  "step[].text": "每一步的操作说明",
  totalTime: "预计耗时（ISO 8601 duration，如 PT30M）",
  tool: "所需工具清单",
  address: "商家地址（PostalAddress 结构）",
  telephone: "联系电话（E.164 建议带国家码）",
  openingHours: "营业时间（如 Mo-Fr 09:00-18:00）",
  "address.streetAddress": "街道门牌",
  "address.addressLocality": "城市",
  url: "规范 URL",
  geo: "经纬度坐标（GeoCoordinates）",
  logo: "机构 Logo URL",
  sameAs: "权威资料页/社交主页 URL 数组（维基百科、领英等）",
  "contactPoint.telephone": "客服电话",
  "contactPoint.email": "客服邮箱",
  potentialAction: "站内搜索动作（SearchAction，需真实搜索 URL 模板）",
};

function reasonOf(path: string): string {
  return FIELD_REASONS[path] ?? "按 Schema.org 规范补全该字段";
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function originOf(u: string): string {
  try {
    return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).origin;
  } catch {
    return u;
  }
}

class Builder {
  json: Record<string, unknown>;
  filledFields: string[] = [];
  sourcedFrom: { field: string; source: string; value: string }[] = [];

  constructor(seed: Record<string, unknown> | undefined, type: string) {
    this.json = seed ? deepClone(seed) : {};
    delete this.json["@context"];
    this.json["@type"] = type;
  }

  private has(path: string): boolean {
    const parts = path.split(".");
    let cur: unknown = this.json;
    for (const p of parts) {
      if (cur === null || typeof cur !== "object") return false;
      cur = (cur as Record<string, unknown>)[p];
      if (Array.isArray(cur)) cur = cur[0];
    }
    return cur !== undefined && cur !== null && cur !== "";
  }

  /** 仅在字段缺失/为空时用真实值补入，并记录来源 */
  fill(path: string, value: unknown, source: string): boolean {
    if (value === undefined || value === null || value === "") return false;
    if (Array.isArray(value) && value.length === 0) return false;
    if (this.has(path)) {
      // 已有值（来自现存 JSON-LD）也记录，但不覆盖
      this.filledFields.push(path);
      this.sourcedFrom.push({ field: path, source: "jsonld-existing", value: preview(value) });
      return false;
    }
    const parts = path.split(".");
    let cur = this.json as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i]!;
      if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
      cur = cur[k] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]!] = value;
    this.filledFields.push(path);
    this.sourcedFrom.push({ field: path, source, value: preview(value) });
    return true;
  }

  /** 填嵌套对象（带 @type 脚手架，仅当其名字段有真实值、且现存 JSON-LD 没有该对象时创建） */
  fillObject(path: string, type: string, fields: [string, unknown, string][]): void {
    const real = fields.filter(([, v]) => v !== undefined && v !== null && v !== "");
    if (real.length === 0) return;
    // 现存 JSON-LD 已有该对象 → 保留不覆盖（只补缺不覆盖原则）
    if (this.has(path)) return;
    const parent = path.split(".").slice(-1)[0]!;
    const obj: Record<string, unknown> = { "@type": type };
    for (const [k, v, source] of real) {
      obj[k] = v;
      this.filledFields.push(`${path}.${k}`);
      this.sourcedFrom.push({ field: `${path}.${k}`, source, value: preview(v) });
    }
    // 挂到父路径
    const parts = path.split(".");
    let cur = this.json as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i]!;
      if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
      cur = cur[k] as Record<string, unknown>;
    }
    cur[parent] = obj;
  }

  wrap(): Record<string, unknown> {
    return { "@context": SCHEMA_CONTEXT, ...this.json };
  }
}

function preview(v: unknown): string {
  if (typeof v === "string") return v.slice(0, 100);
  try {
    return JSON.stringify(v)!.slice(0, 100);
  } catch {
    return String(v);
  }
}

/* ------------------------------------------------------------------ */
/* 各类型构建                                                          */
/* ------------------------------------------------------------------ */

function seedNode(
  facts: PageFacts,
  matchTypes: RegExp
): Record<string, unknown> | undefined {
  return nodesOfType(facts.jsonLdNodes, matchTypes)[0]?.node;
}

function buildArticle(facts: PageFacts): Built {
  const b = new Builder(seedNode(facts, FIELD_CATALOG.article.matchTypes), "Article");
  const heading = facts.h1 ?? facts.title;
  b.fill("headline", heading, "visible:h1/title");
  b.fill("description", facts.description, "meta:description");
  b.fill("image", facts.ogImage, "meta:og:image");
  b.fill(
    "datePublished",
    facts.publishedDate ?? facts.visibleDates[0] ?? null,
    facts.publishedDate ? "meta:article:published_time" : "visible:date"
  );
  b.fill("dateModified", facts.modifiedDate, "meta:article:modified_time");
  b.fill("mainEntityOfPage", facts.url, "url");
  b.fillObject("author", "Person", [["name", facts.author, "meta:author"]]);
  b.fillObject("publisher", "Organization", [
    ["name", facts.ogSiteName, "meta:og:site_name"],
  ]);
  return finalize("article", b);
}

function buildProduct(facts: PageFacts): Built {
  const b = new Builder(seedNode(facts, FIELD_CATALOG.product.matchTypes), "Product");
  b.fill("name", facts.h1 ?? facts.title, "visible:h1/title");
  b.fill("description", facts.description, "meta:description");
  b.fill("image", facts.ogImage, "meta:og:image");
  // 价格必须同时观察到数值与币种才入草稿，否则留给人工
  const priced = facts.prices.find((p) => p.currency);
  if (priced) {
    b.fillObject("offers", "Offer", [
      ["price", priced.value, "visible:price"],
      ["priceCurrency", priced.currency, "visible:price"],
    ]);
  }
  // aggregateRating / sku / brand 只可能来自现存 JSON-LD，绝不做文本猜测
  return finalize("product", b);
}

function buildFaq(facts: PageFacts): Built {
  const b = new Builder(seedNode(facts, FIELD_CATALOG.faq.matchTypes), "FAQPage");
  const existing = nodesOfType(facts.jsonLdNodes, FIELD_CATALOG.faq.matchTypes)[0]
    ?.node as Record<string, unknown> | undefined;
  const hasExisting = Array.isArray(existing?.mainEntity) && existing!.mainEntity!.length > 0;

  if (!hasExisting && facts.qaPairs.length > 0) {
    const items = facts.qaPairs.map((q) => ({
      "@type": "Question",
      name: q.question,
      acceptedAnswer: { "@type": "Answer", text: q.answer },
    }));
    b.fill("mainEntity", items, "visible:qa-pairs");
  }
  return finalize("faq", b);
}

function buildHowTo(facts: PageFacts): Built {
  const b = new Builder(seedNode(facts, FIELD_CATALOG.howto.matchTypes), "HowTo");
  b.fill("name", facts.h1 ?? facts.title, "visible:h1/title");
  b.fill("description", facts.description, "meta:description");
  const existing = b.json["step"];
  const hasSteps = Array.isArray(existing) && existing.length > 0;
  if (!hasSteps && facts.steps.length > 0) {
    b.fill(
      "step",
      facts.steps.map((s) => ({ "@type": "HowToStep", text: s })),
      "visible:steps"
    );
  }
  return finalize("howto", b);
}

function buildLocalBusiness(facts: PageFacts): Built {
  const b = new Builder(
    seedNode(facts, FIELD_CATALOG["local-business"].matchTypes),
    "LocalBusiness"
  );
  b.fill("name", facts.ogSiteName ?? facts.title, "meta:og:site_name");
  b.fill("telephone", facts.tel[0], "visible:tel");
  b.fill("url", originOf(facts.url), "url");
  b.fill("image", facts.ogImage, "meta:og:image");
  b.fillObject("address", "PostalAddress", [
    ["streetAddress", facts.addressHints[0], "visible:address"],
  ]);
  return finalize("local-business", b);
}

function buildOrganization(facts: PageFacts): Built {
  const b = new Builder(
    seedNode(facts, FIELD_CATALOG.organization.matchTypes),
    "Organization"
  );
  b.fill("name", facts.ogSiteName ?? facts.title, "meta:og:site_name");
  b.fill("url", originOf(facts.url), "url");
  b.fill("logo", facts.ogImage, "meta:og:image");
  if (facts.socialLinks.length > 0) b.fill("sameAs", facts.socialLinks, "visible:social");
  const contactFields: [string, unknown, string][] = [];
  if (facts.tel[0]) contactFields.push(["telephone", facts.tel[0], "visible:tel"]);
  if (facts.mailto[0]) contactFields.push(["email", facts.mailto[0], "visible:mailto"]);
  b.fillObject("contactPoint", "ContactPoint", contactFields);
  b.fillObject("address", "PostalAddress", [
    ["streetAddress", facts.addressHints[0], "visible:address"],
  ]);
  return finalize("organization", b);
}

function buildWebsite(facts: PageFacts): Built {
  const b = new Builder(seedNode(facts, FIELD_CATALOG.website.matchTypes), "WebSite");
  b.fill("name", facts.ogSiteName ?? facts.title, "meta:og:site_name");
  b.fill("url", originOf(facts.url), "url");
  b.fill("description", facts.description, "meta:description");
  // potentialAction 需要真实搜索 URL 模板，无法可靠观测，留给人工
  return finalize("website", b);
}

/* ------------------------------------------------------------------ */
/* 收尾：人工补充清单                                                  */
/* ------------------------------------------------------------------ */

/** 标量路径是否在最终对象中有值 */
function scalarPresent(json: Record<string, unknown>, path: string): boolean {
  let cur: unknown = json;
  for (const p of path.split(".")) {
    if (cur === null || typeof cur !== "object") return false;
    cur = (cur as Record<string, unknown>)[p];
    if (Array.isArray(cur)) cur = cur[0];
  }
  return cur !== undefined && cur !== null && cur !== "";
}

/** 数组路径覆盖度：返回 total/filled */
function arrayCoverage(
  json: Record<string, unknown>,
  arrPath: string,
  subPath: string
): { total: number; filled: number } {
  let cur: unknown = json;
  const parts = arrPath.split(".");
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return { total: 0, filled: 0 };
    cur = (cur as Record<string, unknown>)[p];
    if (Array.isArray(cur)) cur = cur[0];
  }
  if (!Array.isArray(cur)) return { total: 0, filled: 0 };
  let filled = 0;
  for (const item of cur) {
    let v: unknown = item;
    for (const p of subPath.split(".")) {
      if (v === null || typeof v !== "object") {
        v = undefined;
        break;
      }
      v = (v as Record<string, unknown>)[p];
      if (Array.isArray(v)) v = v[0];
    }
    if (v !== undefined && v !== null && v !== "") filled++;
  }
  return { total: cur.length, filled };
}

function finalize(pageType: Exclude<PageType, "unknown">, b: Builder): Built {
  const json = b.wrap();
  const manualFields: ManualField[] = [];

  for (const spec of FIELD_CATALOG[pageType].fields) {
    const path = spec.path;
    const arrMatch = path.match(/^(.+?)\[\](?:\.(.+))?$/);
    if (arrMatch) {
      const [, arrPath, subPath] = arrMatch;
      // 数组本身缺失：只登记数组父字段，不重复登记子字段
      const parent = jsonPathValue(json, arrPath!);
      if (!Array.isArray(parent)) {
        // 父字段尚未登记才登记
        if (!manualFields.some((m) => m.path === arrPath)) {
          manualFields.push({
            path: arrPath!,
            label: arrPath!,
            level: spec.level,
            reason: reasonOf(arrPath!),
          });
        }
        continue;
      }
      if (subPath) {
        const cov = arrayCoverage(json, arrPath!, subPath);
        if (cov.filled < cov.total) {
          manualFields.push({
            path,
            label: path,
            level: spec.level,
            reason: `${reasonOf(path)}（${cov.total - cov.filled}/${cov.total} 项缺失）`,
          });
        }
      }
      continue;
    }

    if (!scalarPresent(json, path)) {
      manualFields.push({
        path,
        label: path,
        level: spec.level as FieldRequirementLevel,
        reason: reasonOf(path),
      });
    }
  }

  return {
    json,
    filledFields: Array.from(new Set(b.filledFields)),
    sourcedFrom: b.sourcedFrom,
    manualFields,
  };
}

/** 读数组父路径的原始值 */
function jsonPathValue(json: Record<string, unknown>, path: string): unknown {
  let cur: unknown = json;
  for (const p of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

const BUILDERS: Record<
  Exclude<PageType, "unknown">,
  (facts: PageFacts) => Built
> = {
  article: buildArticle,
  product: buildProduct,
  faq: buildFaq,
  howto: buildHowTo,
  "local-business": buildLocalBusiness,
  organization: buildOrganization,
  website: buildWebsite,
};

/**
 * 生成草稿。unknown 类型或除 @context/@type 外无任何真实字段时
 * jsonLd 为 null（不给空壳）。
 */
export function generateDraft(
  url: string,
  pageType: PageType,
  facts: PageFacts
): SchemaDraft {
  const empty: SchemaDraft = {
    url,
    pageType,
    schemaType: null,
    jsonLd: null,
    jsonLdString: null,
    filledFields: [],
    manualFields: [],
    sourcedFrom: [],
  };
  if (pageType === "unknown") return empty;

  const built = BUILDERS[pageType](facts);
  const contentKeys = Object.keys(built.json).filter(
    (k) => k !== "@context" && k !== "@type"
  );
  if (contentKeys.length === 0) {
    return {
      ...empty,
      schemaType: (built.json["@type"] as string) ?? null,
      manualFields: built.manualFields,
    };
  }

  return {
    url,
    pageType,
    schemaType: built.json["@type"] as string,
    jsonLd: built.json,
    jsonLdString: JSON.stringify(built.json, null, 2),
    filledFields: built.filledFields,
    manualFields: built.manualFields,
    sourcedFrom: built.sourcedFrom,
  };
}
