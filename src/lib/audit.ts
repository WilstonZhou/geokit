/**
 * 鲸析 GEOkit — 页面审计 + GEO（生成式引擎优化）评分
 *
 * 这是 GEOkit 与 open-seo 的方法论分水岭：
 *   open-seo 的审计只回答「Google 会不会收录我」，
 *   GEOkit 额外回答「AI 愿不愿意引用我」——2026 年这才是真问题。
 *
 * GEO 评分六维度，每一维都由真实的可观测信号计算，不是拍脑袋打分。
 */

import {
  findTags, stripTags, getTitle, getMeta, getAllMeta,
  getCanonical, getHeading, absolutize,
} from "./html";
import { fetchWithPolicy, type FetchResult } from "./fetcher";
import { evidenceEnabled, evidenceFromFetch } from "./evidence/store";
import { httpSource, siteSubject } from "./evidence/identity";
import type { Evidence } from "./evidence/types";
import { createStore, type Store } from "./store";

export interface CheckResult {
  id: string;
  label: string;
  /** pass / warn / fail —— 中间态很重要，SEO 很少非黑即白 */
  level: "pass" | "warn" | "fail";
  detail: string;
  value?: string;
  /** 具体到怎么改，不写正确的废话 */
  fix?: string;
  weight: number;
}

export interface GeeBreakdown {
  id: string;
  label: string;
  score: number;
  max: number;
  comment: string;
}

export interface PageAudit {
  url: string;
  finalUrl: string;
  httpStatus: number;
  elapsedMs: number;
  title: string | null;
  titleLength: number;
  metaDescription: string | null;
  metaDescriptionLength: number;
  canonical: string | null;
  robotsMeta: string | null;
  hreflang: string[];
  headings: { level: number; text: string }[];
  jsonLdTypes: string[];
  ogTags: Record<string, string>;
  twitterTags: Record<string, string>;
  wordCount: number;
  imageCount: number;
  imagesWithoutAlt: number;
  internalLinks: number;
  externalLinks: number;
  hasViewport: boolean;
  lang: string | null;
  /** 各项检查，供 UI 逐条渲染 */
  checks: CheckResult[];
  /** 传统的 Google 视角技术分 */
  seoScore: number;
  /** GEO：AI 引用友好度 */
  geoScore: number;
  geoBreakdown: GeeBreakdown[];
  recommendations: string[];
  /**
   * 本次审计对应的 `page_html` Evidence id（Phase 1 S3）。
   *
   * 仅在存证总闸开启、且 Evidence 确实落盘后出现；默认配置下为 undefined。
   * 加它是为了让 HTTP / MCP 的调用方能顺着 id 回到原始素材 ——
   * 结论能追溯到证据，是这个工具唯一的信用来源。
   */
  evidenceId?: string;
}

/** 结构化 OCR：这些是 LLM 最爱 cite 的内容形态 */
interface ContentShape {
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
}

const FETCH_TIMEOUT_MS = 15_000;

export async function auditUrl(inputUrl: string): Promise<PageAudit> {
  const started = Date.now();
  const normalized = normalizeUrl(inputUrl);

  let html = "";
  let httpStatus = 0;

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

  // 采集耗时在此定格 —— 存证是旁路，不该把写盘时间算进页面响应耗时
  const elapsedMs = Date.now() - started;
  const finalUrl = grabbed.finalUrl || normalized;

  // ── Commit A：把这次采集落成 page_html Evidence（S3 的合法输入）──
  const rec = await recordAuditEvidence(grabbed, normalized, finalUrl);

  // 原实现仅在 fetch 抛异常时走 emptyAudit —— 网络层失败才属此类，
  // HTTP 非 2xx（如 404 页面）原本也会被继续 analyze，此处保持一致。
  if (grabbed.body === "" && !grabbed.ok && grabbed.error && grabbed.error.kind !== "http_error") {
    const empty = emptyAudit(normalized, grabbed.error.message, elapsedMs);
    if (rec) empty.evidenceId = rec.id;
    return empty;
  }

  httpStatus = grabbed.status;
  html = grabbed.body;

  const audit = analyze(finalUrl, html, httpStatus, elapsedMs);
  if (rec) audit.evidenceId = rec.id;
  return audit;
}

/** 一次 audit 采集的存证结果 */
interface AuditEvidenceRecord {
  /** Store 落库后返回的 id（与 evidence.id 一致，除非命中去重） */
  id: string;
  evidence: Evidence;
  /** 复用同一实例，避免 JsonlStore 的惰性索引被重复构建 */
  store: Store;
  /** 实际留存到磁盘的 body 原文；未留存时为空串 */
  body: string;
}

/**
 * 把一次 audit 采集落成 `page_html` Evidence —— S3 Site Observer 的输入。
 *
 * 只做**事实留存**，不产出任何结论（结论是 Commit B 的 Site Observer 的事）。
 *
 * ─────────────────────────────────────────────────────────────
 * 三条边界
 * ─────────────────────────────────────────────────────────────
 *   1. 总闸沿用 `GEOKIT_EVIDENCE`（默认 off）—— 默认行为零变化（W-1）
 *   2. identity 与 body 留存的注入都在本函数内完成，不改
 *      `evidenceFromFetch()` 签名（W-2）
 *   3. 失败一律捕获并返回 null：存证是旁路，绝不因此让调用方拿不到
 *      PageAudit（W-3），但也绝不假装存证成功
 */
async function recordAuditEvidence(
  res: FetchResult,
  inputUrl: string,
  finalUrl: string
): Promise<AuditEvidenceRecord | null> {
  if (!evidenceEnabled()) return null;

  try {
    // subject / source 一律取 finalUrl：观测的是最终被分析的页面。
    // 输入 URL 只作为上下文留在 metadata.extra.inputUrl —— 重定向场景下
    // 二者可能不同源，混成一个 identity 会让时间线接不上。
    const patched: FetchResult = {
      ...res,
      context: {
        ...res.context,
        subject: siteSubject(finalUrl),
        source: httpSource(finalUrl),
        meta: { ...(res.context.meta ?? {}), inputUrl },
      },
    };

    const ev = evidenceFromFetch(patched, "page_html");

    // ★ 兜底修正（S1 已知缺陷，本轮不改动 S1 代码）：
    //   evidenceFromFetch 把 identity 交给 normalizeEvidence，而后者在记录
    //   缺少 provenance 时判定为「旧契约」，改用 `target`（输入 URL）重新推导，
    //   于是上面注入的 subject 被静默覆盖。这里补回 finalUrl 版本。
    ev.subject = siteSubject(finalUrl);
    ev.source = httpSource(finalUrl);
    // 同一个判定也会给新记录打上 migratedFrom —— 一条刚生成的证据不该
    // 自称是迁移产物，那会让存量统计失真。
    ev.migratedFrom = undefined;

    // OPEN-3：audit 通道的 Evidence 必须可重放。只有 hash 没有正文，
    // Observer 无从算出任何结论 —— 那种 Evidence 等于没存。
    //
    // 判据是「拿到了响应」而不是「正文非空」：200 但空 body 也是一种真实
    // 的观测结果，它必须能被 Observer 判成 PARTIAL，而不是被当成没存正文
    // 直接拒收。响应体为空时没有 blob 可写，bodyRef 保持 null。
    const body = res.body;
    if (res.status > 0 || body.length > 0) ev.response.bodyRetained = true;

    const store = createStore();
    const saved = await store.saveEvidence(ev, body ? { body } : undefined);
    return { id: saved.id, evidence: ev, store, body };
  } catch (e) {
    console.error(
      "[geokit] audit Evidence 落盘失败，本次审计无存证：",
      e instanceof Error ? e.message : e
    );
    return null;
  }
}

function normalizeUrl(u: string): string {
  const t = u.trim();
  if (/^https?:\/\//i.test(t)) return t;
  return `https://${t}`;
}

function emptyAudit(url: string, error: string, ms: number): PageAudit {
  return {
    url,
    finalUrl: url,
    httpStatus: 0,
    elapsedMs: ms,
    title: null,
    titleLength: 0,
    metaDescription: null,
    metaDescriptionLength: 0,
    canonical: null,
    robotsMeta: null,
    hreflang: [],
    headings: [],
    jsonLdTypes: [],
    ogTags: {},
    twitterTags: {},
    wordCount: 0,
    imageCount: 0,
    imagesWithoutAlt: 0,
    internalLinks: 0,
    externalLinks: 0,
    hasViewport: false,
    lang: null,
    checks: [
      {
        id: "fetch",
        label: "页面抓取",
        level: "fail",
        detail: `无法抓取该页面：${error}`,
        fix: "确认 URL 可公网访问、未被 robots 或 WAF 拦截。生产环境建议为 GEOkit 配置出口代理。",
        weight: 100,
      },
    ],
    seoScore: 0,
    geoScore: 0,
    geoBreakdown: [],
    recommendations: ["先解决页面可访问性，无法抓取时其余评分无从谈起。"],
  };
}

export function analyze(url: string, html: string, httpStatus: number, elapsedMs: number): PageAudit {
  const allMeta = getAllMeta(html);
  const title = getTitle(html);
  const desc = getMeta(html, "description");
  const canonical = getCanonical(html);
  const robotsMeta = getMeta(html, "robots");

  const headings: { level: number; text: string }[] = [];
  for (let lvl = 1; lvl <= 6; lvl++) {
    for (const h of getHeading(html, lvl)) {
      if (h) headings.push({ level: lvl, text: h });
    }
  }

  const ld = extractJsonLdInfo(html);
  const jsonLdTypes = ld.types;
  const ogTags: Record<string, string> = {};
  const twitterTags: Record<string, string> = {};
  for (const [k, v] of Object.entries(allMeta)) {
    if (k.startsWith("og:")) ogTags[k.slice(3)] = v;
    if (k.startsWith("twitter:")) twitterTags[k.slice(8)] = v;
  }

  const links = findTags(html, ["a"]).map((a) => a.attrs.href).filter(Boolean) as string[];
  const host = safeHost(url);
  let internalLinks = 0;
  let externalLinks = 0;
  const seenLinks = new Set<string>();
  for (const href of links) {
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) continue;
    const abs = absolutize(href, url);
    if (seenLinks.has(abs)) continue;
    seenLinks.add(abs);
    try {
      new URL(abs).hostname === host ? internalLinks++ : externalLinks++;
    } catch {
      internalLinks++;
    }
  }

  const imgs = findTags(html, ["img"]);
  const imagesWithoutAlt = imgs.filter((i) => {
    const alt = i.attrs.alt;
    return alt === undefined || alt.trim() === "";
  }).length;

  const bodyText = extractBodyText(html);
  const contentShape = analyzeContentShape(html, bodyText);
  const wordCount = countWords(bodyText);

  const hreflang = findTags(html, ["link"])
    .filter((l) => l.attrs.rel?.toLowerCase() === "alternate" && l.attrs.hreflang)
    .map((l) => l.attrs.hreflang as string);

  const htmlTag = findTags(html, ["html"])[0];
  const lang = htmlTag?.attrs.lang ?? null;
  const hasViewport = !!getMeta(html, "viewport");

  const checks: CheckResult[] = [
    {
      id: "http",
      label: "HTTP 状态",
      level: httpStatus === 200 ? "pass" : httpStatus >= 300 && httpStatus < 400 ? "warn" : "fail",
      detail: `返回 ${httpStatus}`,
      value: String(httpStatus),
      fix: httpStatus >= 400 ? "修复该 URL 的可访问性，检查是否有误配的重写规则。" : undefined,
      weight: 10,
    },
    {
      id: "title",
      label: "标题标签",
      level: !title ? "fail" : title.length < 10 || title.length > 60 ? "warn" : "pass",
      detail: !title
        ? "缺少 <title>"
        : `当前 ${title.length} 字（中文15-30 / 英文50-60 为佳）`,
      value: title ?? "",
      fix: !title
        ? "补一个能同时承载主关键词与品牌词的标题。"
        : "把核心词前置，控制长度，避免堆砌。",
      weight: 10,
    },
    {
      id: "desc",
      label: "Meta Description",
      level: !desc ? "fail" : desc.length < 50 || desc.length > 160 ? "warn" : "pass",
      detail: !desc ? "缺少 description" : `当前 ${desc.length} 字（建议 70-120 中文字）`,
      value: desc ?? "",
      fix: "写一段能被 AI 摘要直接摘走的概括：包含结论 + 关键数据 + 行动指引。",
      weight: 8,
    },
    {
      id: "canonical",
      label: "Canonical",
      level: canonical ? "pass" : "warn",
      detail: canonical ? canonical : "未声明 canonical，重复内容风险",
      value: canonical ?? "",
      fix: canonical ? undefined : "为每个页面声明绝对地址的 canonical。",
      weight: 6,
    },
    {
      id: "robots",
      label: "Robots Meta",
      level: robotsMeta && /noindex/i.test(robotsMeta)
        ? "fail"
        : robotsMeta
          ? "pass"
          : "pass",
      detail: robotsMeta ? robotsMeta : "未显式声明（默认 index,follow）",
      value: robotsMeta ?? "",
      fix: robotsMeta && /noindex/i.test(robotsMeta)
        ? "该页面的 noindex 会让它彻底失去 AI 可见性，确认是否误配。"
        : undefined,
      weight: 8,
    },
    {
      id: "h1",
      label: "H1 结构",
      level: headings.filter((h) => h.level === 1).length === 1 ? "pass" : "warn",
      detail: `共 ${headings.filter((h) => h.level === 1).length} 个 H1，${headings.length} 个标题总览`,
      value: headings.find((h) => h.level === 1)?.text ?? "",
      fix: "保持唯一 H1，与 title 语义呼应但不必逐字相同。",
      weight: 7,
    },
    {
      id: "alt",
      label: "图片 Alt",
      level: imagesWithoutAlt === 0 ? "pass" : imgs.length > 0 && imagesWithoutAlt / imgs.length > 0.3 ? "fail" : "warn",
      detail: `${imgs.length} 张图片，${imagesWithoutAlt} 张缺 alt（${imgs.length ? Math.round((imagesWithoutAlt / imgs.length) * 100) : 0}%）`,
      value: String(imagesWithoutAlt),
      fix: "给信息型图片补描述性 alt；纯装饰图用 alt=\"\"。",
      weight: 4,
    },
    {
      id: "viewport",
      label: "移动端适配",
      level: hasViewport ? "pass" : "warn",
      detail: hasViewport ? "已声明 viewport" : "缺少 viewport meta",
      value: getMeta(html, "viewport") ?? "",
      fix: "补充 <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">。",
      weight: 5,
    },
    {
      id: "lang",
      label: "语言声明",
      level: lang ? "pass" : "warn",
      detail: lang ? `lang="${lang}"` : "未声明 lang，多语言场景解析会出错",
      value: lang ?? "",
      fix: "在 <html> 上声明 lang=\"zh-CN\"。",
      weight: 4,
    },
    {
      id: "jsonld",
      label: "结构化数据",
      level: jsonLdTypes.length > 0 ? "pass" : "warn",
      detail: jsonLdTypes.length
        ? `检测到 ${jsonLdTypes.join(" / ")}`
        : "未检测到 JSON-LD，AI 难以确认实体身份",
      value: jsonLdTypes.join(", "),
      fix: "至少补 Organization + WebSite + Article/BreadcrumbList 三类 schema。",
      weight: 8,
    },
    {
      id: "og",
      label: "社交卡片 OG",
      level: ogTags.title && ogTags.image ? "pass" : "warn",
      detail: ogTags.title && ogTags.image
        ? "og:title / og:image 齐备"
        : "OG 标签不完整，分享时无预览图",
      value: Object.keys(ogTags).join(", "),
      fix: "补齐 og:title、og:description、og:image、og:url（周老板的 lakala.hk 正是卡在这里）。",
      weight: 5,
    },
  ];

  const seoScore = scoreFromChecks(checks);
  const geo = computeGeo({
    html, checks, contentShape, jsonLdTypes, allMeta,
    wordCount, headings, lang, canonical, ld,
  });

  const recommendations = buildRecommendations(checks, geo);

  return {
    url,
    finalUrl: url,
    httpStatus,
    elapsedMs,
    title,
    titleLength: title?.length ?? 0,
    metaDescription: desc,
    metaDescriptionLength: desc?.length ?? 0,
    canonical,
    robotsMeta,
    hreflang,
    headings,
    jsonLdTypes,
    ogTags,
    twitterTags,
    wordCount,
    imageCount: imgs.length,
    imagesWithoutAlt,
    internalLinks,
    externalLinks,
    hasViewport,
    lang,
    checks,
    seoScore,
    geoScore: geo.total,
    geoBreakdown: geo.breakdown,
    recommendations,
  };
}

function scoreFromChecks(checks: CheckResult[]): number {
  const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
  const earned = checks.reduce((s, c) => {
    const r = c.level === "pass" ? 1 : c.level === "warn" ? 0.5 : 0;
    return s + r * c.weight;
  }, 0);
  return Math.round((earned / totalWeight) * 100);
}

function extractBodyText(html: string): string {
  const body = findTags(html, ["body"])[0];
  const scope = body ? html.slice(body.contentStart, body.contentEnd) : html;
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

/** 分析内容形态 —— GEO 评分的核心输入 */
function analyzeContentShape(html: string, text: string): ContentShape {
  const ul = findTags(html, ["ul", "ol"]).length;
  const li = findTags(html, ["li"]).length;
  const tables = findTags(html, ["table"]).length;
  const blockquote = findTags(html, ["blockquote"]).length;
  const code = findTags(html, ["pre", "code"]).length;
  const paragraphs = findTags(html, ["p"]).length;

  // 数据点：百分比、金额、年份、带单位的数字 —— LLM 引用时的“硬通货”
  const dataPoints =
    (text.match(/\d+(\.\d+)?\s*(%|％|亿元|万元|亿美元|%|万|亿|kg|ms|px)/g) ?? []).length +
    (text.match(/20\d{2}\s*年/g) ?? []).length;

  const externalCitations = findTags(html, ["a"])
    .filter((a) => {
      const rel = a.attrs.rel ?? "";
      return /nofollow/.test(rel) || /^https?:\/\//i.test(a.attrs.href ?? "");
    }).length;

  const sentences = text.split(/[。！？.!?]+/).filter((s) => s.trim().length > 0);
  const avgSentenceLength = sentences.length
    ? Math.round(text.replace(/[。！？.!?]/g, "").length / sentences.length)
    : 0;

  // TL;DR：前 400 字里是否出现结论性表述
  const head = text.slice(0, 400);
  const hasTldr =
    /(总结|核心结论|要点|综上|一句话|tldr|key takeaway| TL;?DR)/i.test(head) ||
    (dataPoints > 0 && head.length > 80);

  return {
    paragraphs, lists: ul, listItems: li, tables, quotes: blockquote,
    codeBlocks: code, dataPoints, externalCitations, hasTldr, avgSentenceLength,
  };
}

interface GeoInput {
  html: string;
  checks: CheckResult[];
  contentShape: ContentShape;
  jsonLdTypes: string[];
  allMeta: Record<string, string>;
  wordCount: number;
  headings: { level: number; text: string }[];
  lang: string | null;
  canonical: string | null;
  ld: JsonLdInfo;
}

/**
 * GEO 评分 —— 「AI 愿意引用你吗」
 * 六个维度，权重合计 100。
 */
function computeGeo(input: GeoInput): { total: number; breakdown: GeeBreakdown[] } {
  const { contentShape: s, jsonLdTypes, allMeta, wordCount, checks } = input;

  // 1. 可引用性 Quotability (25)
  let quotability = 0;
  if (s.hasTldr) quotability += 8;
  if (s.lists > 0) quotability += Math.min(6, s.lists * 2);
  if (s.listItems >= 5) quotability += 3;
  if (s.tables > 0) quotability += Math.min(5, s.tables * 3);
  if (s.dataPoints >= 3) quotability += 5;
  else if (s.dataPoints > 0) quotability += 2;
  if (s.quotes > 0) quotability += 2;
  quotability = Math.min(25, quotability);

  // 2. 结构化 Structuredness (20)
  let structuredness = 0;
  if (jsonLdTypes.length >= 3) structuredness += 8;
  else if (jsonLdTypes.length > 0) structuredness += 4;
  const hCounts = [1, 2, 3].map((l) => input.headings.filter((h) => h.level === l).length);
  if (hCounts[0] >= 1) structuredness += 4;
  if (hCounts[1] >= 3) structuredness += 4;
  else if (hCounts[1] > 0) structuredness += 2;
  if (s.paragraphs >= 5) structuredness += 2;
  if (input.canonical) structuredness += 2;
  structuredness = Math.min(20, structuredness);

  // 3. 实体清晰度 Entity Clarity (15)
  //    署名与日期既可能写在 meta 里，也可能写进 JSON-LD —— 两处都认。
  let entity = 0;
  if (jsonLdTypes.some((t) => /Organization|Corporation|LocalBusiness/i.test(t)) ||
      input.ld.hasOrganization) entity += 4;
  if (jsonLdTypes.some((t) => /Article|BlogPosting|NewsArticle|Product/i.test(t))) entity += 4;
  if (allMeta.author || input.ld.hasAuthor) entity += 3;
  if (allMeta["article:published_time"] || allMeta.date || allMeta.pubdate ||
      input.ld.hasDatePublished) entity += 2;
  if (input.ld.hasAuthor || jsonLdTypes.some((t) => /Person/i.test(t))) entity += 2;
  entity = Math.min(15, entity);

  // 4. 可抓取性 Crawlability (15)
  const crawl = checks.find((c) => c.id === "robots");
  let crawlability = 6;
  if (crawl?.level === "fail") crawlability = 0;
  if (input.lang) crawlability += 3;
  if (input.canonical) crawlability += 2;
  if (checks.find((c) => c.id === "http")?.level === "pass") crawlability += 2;
  if (wordCount > 0) crawlability += 2;
  crawlability = Math.min(15, crawlability);

  // 5. 事实密度 Fact Density (15)
  //    分母设 300 字下限，避免超短正文算出虚高的「每千字数据点」。
  const density = s.dataPoints / (Math.max(wordCount, 300) / 1000);
  let factDensity = 0;
  if (wordCount >= 1200) factDensity += 4;
  else if (wordCount >= 600) factDensity += 2;
  if (density >= 3) factDensity += 6;
  else if (density >= 1.5) factDensity += 4;
  else if (density > 0) factDensity += 2;
  if (s.externalCitations >= 3) factDensity += 5;
  else if (s.externalCitations > 0) factDensity += 2;
  // 正文过薄时，密度再高也不给它高分 —— 没什么可摘的
  if (wordCount < 300) factDensity = Math.min(factDensity, 3);
  factDensity = Math.min(15, factDensity);

  // 6. 可读性 / 时效性 Readability & Freshness (10)
  let readability = 0;
  if (s.avgSentenceLength > 0 && s.avgSentenceLength <= 45) readability += 4;
  else if (s.avgSentenceLength <= 70) readability += 2;
  if (allMeta["article:modified_time"] || allMeta["og:updated_time"] || input.ld.hasDateModified)
    readability += 3;
  if (allMeta["article:published_time"] || input.ld.hasDatePublished) readability += 3;
  readability = Math.min(10, readability);

  const breakdown: GeeBreakdown[] = [
    {
      id: "quotability", label: "可引用性", score: quotability, max: 25,
      comment: s.hasTldr
        ? `有结论前置，检测到 ${s.dataPoints} 个数据点、${s.lists} 个列表${s.tables ? `、${s.tables} 张表格` : ""}`
        : "缺少 TL;DR 式的结论前置，AI 难以抽取可引用的片段",
    },
    {
      id: "structuredness", label: "结构化", score: structuredness, max: 20,
      comment: jsonLdTypes.length
        ? `检测到 ${jsonLdTypes.length} 类 schema`
        : "无 JSON-LD，AI 无法确认页面实体类型",
    },
    {
      id: "entity", label: "实体清晰度", score: entity, max: 15,
      comment: entity >= 10 ? "作者/组织/时间标注较完整" : "缺少作者或组织署名，影响了权威性判断",
    },
    {
      id: "crawlability", label: "可抓取性", score: crawlability, max: 15,
      comment: crawl?.level === "fail" ? "noindex 会让 AI 完全看不到这个页面" : "抓取通道正常",
    },
    {
      id: "density", label: "事实密度", score: factDensity, max: 15,
      comment: `每千字 ${density.toFixed(1)} 个数据点，外链引用 ${s.externalCitations} 处`,
    },
    {
      id: "readability", label: "可读性/时效", score: readability, max: 10,
      comment: `平均句长 ${s.avgSentenceLength} 字${allMeta["article:modified_time"] ? "，有更新时间标记" : "，未标注更新时间"}`,
    },
  ];

  const total = breakdown.reduce((acc, b) => acc + b.score, 0);
  return { total, breakdown };
}

function buildRecommendations(checks: CheckResult[], geo: { total: number; breakdown: GeeBreakdown[] }): string[] {
  const recs: string[] = [];
  for (const b of geo.breakdown) {
    const ratio = b.score / b.max;
    if (ratio >= 0.75) continue;
    switch (b.id) {
      case "quotability":
        recs.push("在正文开头加一段 3-5 行的「核心结论」，并把关键数据做成项目符号或表格 —— 这是 AI 摘要最常搬运的部分。");
        break;
      case "structuredness":
        recs.push("补 JSON-LD：Organization + Article + BreadcrumbList 三件套，并保证 H2 层级不少于 3 个。");
        break;
      case "entity":
        recs.push("标注 author / published_time / modified_time，让 AI 知道「谁在什么时候说的」—— 无名无日期的内容引用率显著更低。");
        break;
      case "crawlability":
        recs.push("检查 robots.txt 与 meta robots；同时在站点根目录放 llms.txt 向 AI 爬虫显式开放优质内容。");
        break;
      case "density":
        recs.push("增加具体数据（金额、比例、时间点）并引用权威外链，把观点变成可验证的事实。");
        break;
      case "readability":
        recs.push("拆分超过 45 字的长句；补充 article:modified_time 表达内容仍在维护。");
        break;
    }
  }
  if (recs.length === 0) recs.push("GEO 各项表现良好，保持定期复核即可。");
  return recs;
}

interface JsonLdInfo {
  types: string[];
  /** 是否用 author /creator 标了署名（很多站点写在 JSON-LD 而非 meta 里） */
  hasAuthor: boolean;
  hasOrganization: boolean;
  hasDatePublished: boolean;
  hasDateModified: boolean;
}

function extractJsonLdInfo(html: string): JsonLdInfo {
  const types = new Set<string>();
  let hasAuthor = false;
  let hasOrganization = false;
  let hasDatePublished = false;
  let hasDateModified = false;

  for (const sc of findTags(html, ["script"])) {
    if (!/ld\+json/i.test(sc.attrs.type ?? "")) continue;
    const raw = html.slice(sc.contentStart, sc.contentEnd).trim();
    if (!raw) continue;

    const walk = (node: unknown, depth = 0) => {
      if (depth > 8 || !node) return;
      if (Array.isArray(node)) {
        node.forEach((n) => walk(n, depth + 1));
        return;
      }
      if (typeof node !== "object") return;
      const o = node as Record<string, unknown>;

      const t = o["@type"];
      if (typeof t === "string") types.add(t);
      else if (Array.isArray(t)) {
        (t as unknown[]).forEach((x) => {
          if (typeof x === "string") types.add(x);
        });
      }

      if (o.author !== undefined || o.creator !== undefined) hasAuthor = true;
      if (o.publisher !== undefined) hasOrganization = true;
      if (o.datePublished !== undefined) hasDatePublished = true;
      if (o.dateModified !== undefined) hasDateModified = true;

      for (const key of ["@graph", "author", "creator", "publisher", "mainEntity", "itemListElement"]) {
        if (o[key] !== undefined) walk(o[key], depth + 1);
      }
    };

    try {
      walk(JSON.parse(raw));
    } catch {
      // JSON-LD 语法错误，Types 会缺失但不影响其余维度
    }
  }

  return {
    types: Array.from(types),
    hasAuthor,
    hasOrganization,
    hasDatePublished,
    hasDateModified,
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
