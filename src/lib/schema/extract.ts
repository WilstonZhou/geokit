/**
 * 鲸析 GEOkit — Schema 诊断的事实提取层（T10）。
 *
 * audit.ts 的 extractJsonLdInfo 只产出布尔标记；字段级诊断需要
 * 完整的 JSON-LD 节点与页面可见事实，故在此独立实现（不改动 audit）。
 *
 * 全部为纯函数、零依赖、不 fetch。
 */
import {
  findTags,
  stripTags,
  getTitle,
  getMeta,
  getAllMeta,
} from "../html";
import type { TypeSignal } from "./types";

/* ------------------------------------------------------------------ */
/* JSON-LD 节点                                                        */
/* ------------------------------------------------------------------ */

export interface JsonLdNode {
  /** 节点的全部 @type（Schema.org 允许数组形式） */
  types: string[];
  /** 原始节点对象 */
  node: Record<string, unknown>;
}

/** 收集所有带 @type 的 JSON-LD 节点（含 @graph / mainEntity / itemListElement / author 等嵌套） */
export function parseJsonLdNodes(html: string): JsonLdNode[] {
  const out: JsonLdNode[] = [];
  const seen = new WeakSet<object>();

  const addNode = (o: Record<string, unknown>) => {
    if (seen.has(o)) return;
    seen.add(o);
    const raw = o["@type"];
    let types: string[] = [];
    if (typeof raw === "string") types = [raw];
    else if (Array.isArray(raw)) types = raw.filter((x): x is string => typeof x === "string");
    if (types.length > 0) out.push({ types, node: o });
  };

  const walk = (v: unknown, depth = 0) => {
    if (depth > 10 || v === null || v === undefined) return;
    if (Array.isArray(v)) {
      v.forEach((x) => walk(x, depth + 1));
      return;
    }
    if (typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (o["@type"] !== undefined) addNode(o);
    // 常见容器与嵌套关系全部下钻
    for (const key of [
      "@graph",
      "mainEntity",
      "itemListElement",
      "author",
      "creator",
      "publisher",
      "provider",
      "item",
      "acceptedAnswer",
      "suggestedAnswer",
      "steps",
      "step",
      "offers",
      "brand",
      "address",
      "contactPoint",
    ]) {
      if (o[key] !== undefined) walk(o[key], depth + 1);
    }
  };

  for (const sc of findTags(html, ["script"])) {
    if (!/ld\+json/i.test(sc.attrs.type ?? "")) continue;
    const raw = html.slice(sc.contentStart, sc.contentEnd).trim();
    if (!raw) continue;
    try {
      walk(JSON.parse(raw));
    } catch {
      // 非法 JSON-LD：跳过（fields.ts 无法校验不存在的节点）
    }
  }
  return out;
}

/** 顶层 @type：每个 ld+json 脚本根对象的 @type，以及 @graph 直接成员的 @type */
export function parseRootTypes(html: string): string[] {
  const out: string[] = [];
  const pushType = (raw: unknown) => {
    if (typeof raw === "string") out.push(raw);
    else if (Array.isArray(raw))
      out.push(...raw.filter((x): x is string => typeof x === "string"));
  };
  for (const sc of findTags(html, ["script"])) {
    if (!/ld\+json/i.test(sc.attrs.type ?? "")) continue;
    const raw = html.slice(sc.contentStart, sc.contentEnd).trim();
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      const roots = Array.isArray(parsed) ? parsed : [parsed];
      for (const r of roots) {
        if (r && typeof r === "object") {
          const o = r as Record<string, unknown>;
          pushType(o["@type"]);
          if (Array.isArray(o["@graph"])) {
            for (const g of o["@graph"]) {
              if (g && typeof g === "object") pushType((g as Record<string, unknown>)["@type"]);
            }
          }
        }
      }
    } catch {
      // 非法 JSON 跳过
    }
  }
  return Array.from(new Set(out));
}

/** 按类型名（大小写不敏感）匹配节点 */
export function nodesOfType(nodes: JsonLdNode[], typeRe: RegExp): JsonLdNode[] {
  return nodes.filter((n) => n.types.some((t) => typeRe.test(t)));
}

/** 节点字符串字段（空串/空数组视为无） */
export function nodeStr(node: Record<string, unknown>, key: string): string | undefined {
  const v = node[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
}

/** 深取嵌套字段：如 author.name；找不到返回 undefined */
export function deepStr(root: unknown, ...path: string[]): string | undefined {
  let cur: unknown = root;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
    if (Array.isArray(cur)) cur = cur[0];
  }
  if (typeof cur === "string" && cur.trim()) return cur.trim();
  return undefined;
}

/* ------------------------------------------------------------------ */
/* 页面可见事实                                                        */
/* ------------------------------------------------------------------ */

export interface QAPair {
  question: string;
  answer: string;
}

export interface PriceFact {
  raw: string;
  value: string;
  currency?: string;
}

export interface PageFacts {
  url: string;
  title: string | null;
  description: string | null;
  h1: string | null;
  /** 文档顺序的标题 */
  headings: { level: number; text: string }[];
  allMeta: Record<string, string>;
  ogSiteName: string | null;
  ogImage: string | null;
  author: string | null;
  /** 原始日期字符串（meta） */
  publishedRaw: string | null;
  modifiedRaw: string | null;
  /** 规范化为 YYYY-MM-DD 的日期（解析失败为 null） */
  publishedDate: string | null;
  modifiedDate: string | null;
  wordCount: number;
  jsonLdNodes: JsonLdNode[];
  /** 顶层 @type（脚本根对象或 @graph 直接成员）—— 用于区分主类型与 publisher 等嵌套类型 */
  rootTypes: string[];
  mailto: string[];
  tel: string[];
  /** 正文中可见日期（YYYY-MM-DD） */
  visibleDates: string[];
  qaPairs: QAPair[];
  /** HowTo 步骤文本（ol/li 优先，其次"步骤 N"标题段） */
  steps: string[];
  prices: PriceFact[];
  hasBuyAction: boolean;
  /** sameAs 候选：权威/社交主页外链 */
  socialLinks: string[];
  addressHints: string[];
  hasSearchAction: boolean;
}

/** 提取正文纯文本（body 范围，去 script/style/注释） */
function bodyText(html: string): string {
  const bodyTag = findTags(html, ["body"])[0];
  const scope = bodyTag
    ? html.slice(bodyTag.contentStart, bodyTag.contentEnd)
    : html;
  return stripTags(
    scope
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
  );
}

function countWords(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const en = (text.match(/[a-zA-Z]+/g) ?? []).length;
  return cjk + en;
}

/** 各种日期写法 → YYYY-MM-DD；无法解析返回 null */
export function normalizeDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isFinite(t)) {
    return new Date(t).toISOString().slice(0, 10);
  }
  const m = raw.match(/(20\d{2})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
  if (m) {
    const [, y, mo, d] = m;
    return `${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  }
  return null;
}

const QUESTION_RE = /[?？]$|^(什么是|如何|怎么|怎样|为什么|是否|能否|多少|哪些|哪里|如何选择)/;
const STEP_HEAD_RE = /^(步骤\s*\d+|第[一二三四五六七八九十\d]+步|step\s*\d+)/i;
const STEP_NUM_RE = /^\d+[.、)]\s*\S/;

const SOCIAL_DOMAINS =
  /(?:^|\.)(linkedin\.com|facebook\.com|twitter\.com|x\.com|weibo\.com|github\.com|zhihu\.com|wikipedia\.org|instagram\.com|youtube\.com|douyin\.com|bilibili\.com)$/i;

const PRICE_RE =
  /(?:[¥￥$€£]\s?)(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s?(元|CNY|RMB|USD|EUR|GBP)/g;

function currencyOf(sym: string | undefined, word: string | undefined): string | undefined {
  if (sym === "¥" || sym === "￥" || word === "元" || word === "CNY" || word === "RMB") return "CNY";
  if (sym === "$" || word === "USD") return "USD";
  if (sym === "€" || word === "EUR") return "EUR";
  if (sym === "£" || word === "GBP") return "GBP";
  return undefined;
}

export function extractFacts(url: string, html: string): PageFacts {
  const allMeta = getAllMeta(html);
  const title = getTitle(html);
  const description = getMeta(html, "description");

  // 文档顺序标题（findTags 单次扫描保证顺序）
  const headings: { level: number; text: string }[] = [];
  for (const tag of findTags(html, ["h1", "h2", "h3", "h4", "h5", "h6"])) {
    const text = stripTags(html.slice(tag.contentStart, tag.contentEnd))
      .replace(/\s+/g, " ")
      .trim();
    if (text) headings.push({ level: Number(tag.name.slice(1)), text });
  }
  const h1 = headings.find((h) => h.level === 1)?.text ?? null;

  const publishedRaw =
    allMeta["article:published_time"] || allMeta["pubdate"] || allMeta["date"] || null;
  const modifiedRaw =
    allMeta["article:modified_time"] || allMeta["og:updated_time"] || null;
  const author =
    allMeta["author"] || allMeta["article:author"] || allMeta["og:article:author"] || null;

  const text = bodyText(html);
  const wordCount = countWords(text);

  const jsonLdNodes = parseJsonLdNodes(html);

  // 联系方式
  const mailto = new Set<string>();
  const tel = new Set<string>();
  const socialLinks = new Set<string>();
  const anchors = findTags(html, ["a"]);
  for (const a of anchors) {
    const href = a.attrs.href ?? "";
    const m = href.match(/^(mailto|tel):\s*([^?]+)/i);
    if (m) {
      const v = decodeURIComponent(m[2]!.trim());
      if (m[1].toLowerCase() === "mailto") mailto.add(v);
      else tel.add(v.replace(/[\s-]/g, ""));
    }
    if (/^https?:\/\//i.test(href)) {
      try {
        const host = new URL(href).hostname.toLowerCase();
        const relMe = /\bme\b/i.test(a.attrs.rel ?? "");
        if (SOCIAL_DOMAINS.test(host) || (relMe && !/^mailto|^tel/i.test(href))) {
          socialLinks.add(href);
        }
      } catch {
        // 忽略非法 URL
      }
    }
  }

  // 可见日期（正文）
  const visibleDates = Array.from(
    new Set(
      Array.from(text.matchAll(/(20\d{2})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/g)).map(
        (mm) => `${mm[1]}-${mm[2]!.padStart(2, "0")}-${mm[3]!.padStart(2, "0")}`
      )
    )
  );

  // Q&A：疑问句标题 + 到下个标题之间的首段
  const qaPairs = extractQaPairs(html, headings);

  // 步骤：ol/li 优先
  const steps = extractSteps(html, headings, text);

  // 价格
  const prices = extractPrices(html, text);

  // 购买动作
  const hasBuyAction =
    /加入购物车|立即购买|立即抢购|马上购买|去结算|buy\s*now|add\s*to\s*cart|checkout/i.test(
      text
    );

  // 地址线索
  const addressHints = Array.from(
    new Set(
      Array.from(text.matchAll(/(?:地址|Address)\s*[:：]\s*(.{4,80})/gi)).map((mm) =>
        mm[1]!.trim().split(/[\n。；;]/)[0]!.trim()
      )
    )
  ).filter(Boolean);

  // 站内搜索
  const hasSearchAction =
    findTags(html, ["form"]).some(
      (f) =>
        /search/i.test(f.attrs.action ?? "") ||
        /search/i.test(f.attrs.role ?? "") ||
        /\b(s|q|query|keyword)\b/i.test(f.attrs.name ?? "")
    ) || /\/(search|q)\b/i.test(html);

  return {
    url,
    title,
    description,
    h1,
    headings,
    allMeta,
    ogSiteName: allMeta["og:site_name"] || null,
    ogImage: allMeta["og:image"] || null,
    author,
    publishedRaw,
    modifiedRaw,
    publishedDate: normalizeDate(publishedRaw),
    modifiedDate: normalizeDate(modifiedRaw),
    wordCount,
    jsonLdNodes,
    rootTypes: parseRootTypes(html),
    mailto: Array.from(mailto),
    tel: Array.from(tel),
    visibleDates,
    qaPairs,
    steps,
    prices,
    hasBuyAction,
    socialLinks: Array.from(socialLinks),
    addressHints,
    hasSearchAction,
  };
}

/** 疑问句标题与紧随其后的正文段配对（到下一个标题为止） */
function extractQaPairs(
  html: string,
  headings: { level: number; text: string }[]
): QAPair[] {
  if (headings.length === 0) return [];
  const tags = findTags(html, ["h1", "h2", "h3", "h4", "h5", "h6"]);
  const qTags: { tag: (typeof tags)[number]; text: string }[] = [];
  for (const tag of tags) {
    const text = stripTags(html.slice(tag.contentStart, tag.contentEnd))
      .replace(/\s+/g, " ")
      .trim();
    if (text && QUESTION_RE.test(text)) qTags.push({ tag, text });
  }
  if (qTags.length < 2) return [];

  const pairs: QAPair[] = [];
  for (let i = 0; i < qTags.length; i++) {
    const start = qTags[i]!.tag.end;
    const end = i + 1 < qTags.length ? qTags[i + 1]!.tag.start : html.length;
    const between = stripTags(
      html
        .slice(start, end)
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    )
      .replace(/\s+/g, " ")
      .trim();
    const answer = between.slice(0, 500);
    if (answer.length >= 4) {
      pairs.push({ question: qTags[i]!.text, answer });
    }
  }
  return pairs;
}

/** HowTo 步骤：有序列表项优先；否则"步骤 N"标题后的首段 */
function extractSteps(
  html: string,
  headings: { level: number; text: string }[],
  text: string
): string[] {
  const ol = findTags(html, ["ol"]);
  if (ol.length > 0) {
    const items = findTags(html.slice(ol[0]!.start, ol[0]!.end), ["li"])
      .map((li) =>
        stripTags(html.slice(ol[0]!.start + li.contentStart, ol[0]!.start + li.contentEnd))
          .replace(/\s+/g, " ")
          .trim()
      )
      .filter((t) => t.length > 0);
    if (items.length >= 2) return items;
  }

  const stepHeads = headings.filter(
    (h) => STEP_HEAD_RE.test(h.text.trim()) || STEP_NUM_RE.test(h.text.trim())
  );
  if (stepHeads.length >= 2) return stepHeads.map((h) => h.text);

  // 正文里"1. xxx 2. xxx"行
  const lines = text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => STEP_NUM_RE.test(s));
  return lines.length >= 2 ? lines.slice(0, 12) : [];
}

/** 价格：可见文本货币模式 + itemprop="price"/"priceCurrency" */
function extractPrices(html: string, text: string): PriceFact[] {
  const out: PriceFact[] = [];
  const seen = new Set<string>();

  for (const tag of findTags(html, ["meta", "span", "div", "ins", "bdi"])) {
    const itemprop = tag.attrs.itemprop ?? "";
    if (/pricecurrency/i.test(itemprop)) continue;
    if (!/price/i.test(itemprop)) continue;
    const value = tag.attrs.content ?? stripTags(html.slice(tag.contentStart, tag.contentEnd)).trim();
    if (!value) continue;
    const cur =
      findTagAttr(html, tag.start, "priceCurrency") ||
      (/¥|￥|元/.test(value) ? "CNY" : /\$/.test(value) ? "USD" : undefined);
    const key = `${value}|${cur ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ raw: value, value: value.replace(/[^\d.,]/g, ""), currency: cur });
    }
  }

  for (const mm of text.matchAll(PRICE_RE)) {
    const value = mm[1] ?? mm[2];
    const sym = mm[0]?.match(/[¥￥$€£]/)?.[0];
    const cur = currencyOf(sym, mm[3]);
    const key = `${value}|${cur ?? ""}`;
    if (value && !seen.has(key)) {
      seen.add(key);
      out.push({ raw: mm[0], value: value.replace(/,/g, ""), currency: cur });
    }
  }
  return out;
}

/** 在某位置之前/附近寻找 itemprop 的 content（priceCurrency 等） */
function findTagAttr(html: string, nearStart: number, itempropRe: string): string | undefined {
  const window = html.slice(Math.max(0, nearStart - 2000), nearStart + 500);
  const m = window.match(
    new RegExp(`itemprop=["']${itempropRe}["'][^>]*content=["']([^"']+)["']`, "i")
  );
  return m?.[1];
}

/* ------------------------------------------------------------------ */
/* 共用的信号构造                                                      */
/* ------------------------------------------------------------------ */

export function sig(
  source: TypeSignal["source"],
  signal: string,
  value: string
): TypeSignal {
  return { source, signal, value };
}
