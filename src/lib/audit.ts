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
import { recordSiteObservation } from "./observers/site";
import {
  computeGeo,
  type GeoVersion,
  type GeeBreakdown,
  type GeoResult,
  type ContentShape,
  type JsonLdInfo,
} from "./geo";

export type { GeoVersion, GeeBreakdown, GeoResult };

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
  /** 评估所使用的 GEO 模型版本（如 "1.0.0" 或 "2.0.0"） */
  geoVersion?: GeoVersion;
  /**
   * 评分规则细粒度版本（如 "1.0.0" / "2.0.0" / "2.1.0"）。
   *
   * 与 `geoVersion` 的区别见 `GeoResult.scoringVersion` 注释。
   * diff 引擎读取此字段识别评分口径变化，避免历史比对被规则换代污染。
   */
  scoringVersion?: string;
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

export interface AuditOptions {
  /** 指定 GEO 评分模型版本，默认 "1.0.0"（确保历史兼容性） */
  geoVersion?: GeoVersion;
}

const FETCH_TIMEOUT_MS = 15_000;

export async function auditUrl(inputUrl: string, opts?: AuditOptions): Promise<PageAudit> {
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

  // ── Commit B：Site Observer（page_html → geo_score）──
  //   只有 Evidence 真的落盘了才产结论（W-1）。失败只记日志，绝不阻断
  //   PageAudit 返回，也绝不把「没存上」说成「观测成功」（W-3）。
  if (rec) {
    const obs = await recordSiteObservation(rec.store, {
      evidence: rec.evidence,
      body: rec.body,
      inputUrl: normalized,
    });
    if (!obs.ok) console.error("[geokit] Site Observation 未生成：", obs.reason);
  }

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

/**
 * 「根本没拿到页面」时的审计结果。
 *
 * ★ 导出给 Site Observer 用 —— 没有响应体时不该去跑 11 项检查，那会算出
 *   一个看起来合理、实则毫无依据的分数。抓不到就是抓不到，分数一律 0。
 *   算法本身与 Phase 0 完全一致，导出不改任何行为。
 */
export function emptyAudit(
  url: string,
  error: string,
  ms: number,
  opts?: AuditOptions
): PageAudit {
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
    geoVersion: opts?.geoVersion ?? "1.0.0",
    // 空审计无内容可评分，scoringVersion 标记「若能评」所对应的规则版本，
    // 便于 diff 在历史比对时识别口径（与该 geoVersion 的当前规则对齐）。
    scoringVersion: (opts?.geoVersion ?? "1.0.0") === "2.0.0" ? "2.1.0" : "1.0.0",
    recommendations: ["先解决页面可访问性，无法抓取时其余评分无从谈起。"],
  };
}

export function analyze(
  url: string,
  html: string,
  httpStatus: number,
  elapsedMs: number,
  opts?: AuditOptions
): PageAudit {
  const geoVersion: GeoVersion = opts?.geoVersion ?? "1.0.0";
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
      if (new URL(abs).hostname === host) internalLinks++;
      else externalLinks++;
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
  const contentShape = analyzeContentShape(html, bodyText, headings, ld, allMeta);
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
  const geo = computeGeo(
    {
      html,
      checks,
      contentShape,
      jsonLdTypes,
      allMeta,
      wordCount,
      headings,
      lang,
      canonical,
      ld,
    },
    geoVersion
  );

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
    geoVersion: geo.version,
    scoringVersion: geo.scoringVersion,
    recommendations: geo.recommendations,
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
function analyzeContentShape(
  html: string,
  text: string,
  headings: { level: number; text: string }[] = [],
  ld?: JsonLdInfo,
  allMeta?: Record<string, string>
): ContentShape {
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

  // 外链引用：收集 href 用于权威来源判定
  const externalLinks = findTags(html, ["a"]).filter((a) => {
    const rel = a.attrs.rel ?? "";
    return /nofollow/.test(rel) || /^https?:\/\//i.test(a.attrs.href ?? "");
  });
  const externalCitations = externalLinks.length;

  const sentences = text.split(/[。！？.!?]+/).filter((s) => s.trim().length > 0);
  const avgSentenceLength = sentences.length
    ? Math.round(text.replace(/[。！？.!?]/g, "").length / sentences.length)
    : 0;

  // TL;DR：前 400 字里是否出现结论性表述
  const head = text.slice(0, 400);
  const hasTldr =
    /(总结|核心结论|要点|综上|一句话|tldr|key takeaway| TL;?DR)/i.test(head) ||
    (dataPoints > 0 && head.length > 80);

  // v2: 首屏直接回答
  const hasDirectAnswer =
    hasTldr ||
    /(定义|简言之|简单来说|核心是|答案是|什么是|指的是|：|:\s*|is\s+a|refers\s+to|means)/i.test(head);

  // v2: HTML5 语义地标标签
  const hasSemanticLandmarks = findTags(html, ["main", "article"]).length > 0;

  // v2: 标题层级是否连续无跳跃（无跳级如 H1->H3）
  let headingContinuity = true;
  if (headings.length > 0) {
    let prev = 0;
    for (const h of headings) {
      if (prev > 0 && h.level > prev + 1) {
        headingContinuity = false;
        break;
      }
      prev = h.level;
    }
  }

  // v2.1: FAQ/Q&A 结构 —— FAQPage JSON-LD 或 ≥2 个疑问句 heading + 紧跟答案块
  const questionHeadings = headings.filter((h) =>
    /[?？]$|^(什么是|如何|怎么|为什么|怎样|是不是|能否)/i.test(h.text.trim())
  );
  const hasFaqStructure =
    ld?.hasFaqPage === true ||
    (questionHeadings.length >= 2 && paragraphs >= questionHeadings.length);

  // v2.1: 结构化元素密度 —— (列表项 + 表格*3) / max(段落数, 1)
  const structuredElementDensity =
    (li + tables * 3) / Math.max(paragraphs, 1);

  // v2.1: 作者权威链接 —— 作者节点 sameAs 或 article:author + 作者主页 a 同时存在
  const metaAuthor = allMeta?.author || allMeta?.["article:author"];
  const hasAuthorHomepageLink = externalLinks.some((a) => {
    const href = a.attrs.href ?? "";
    return /author|about|profile|bio|people/i.test(href) || /\/about\//i.test(href);
  });
  const hasAuthorAuthority =
    ld?.hasAuthorSameAs === true ||
    (!!metaAuthor && hasAuthorHomepageLink);

  // v2.1: 权威来源 —— 外链含 .gov/.edu/.mil 或 ≥2 个不同权威域名
  const authorityDomains = new Set<string>();
  for (const a of externalLinks) {
    const href = a.attrs.href ?? "";
    const m = href.match(/^https?:\/\/([^/]+)/i);
    if (!m) continue;
    const domain = m[1].toLowerCase();
    if (/(?:^|\.)(gov|edu|mil|gouv|gob|go\.id|ac\.uk)\.?[a-z]*$/i.test(domain) || /\.(gov|edu|mil)$/i.test(domain)) {
      authorityDomains.add(domain);
    }
  }
  const hasAuthoritativeSources = authorityDomains.size >= 1;

  // v2.1: 更新时间一致性 —— modified >= published 且 modified 距今 ≤365 天
  const publishedStr =
    allMeta?.["article:published_time"] || allMeta?.["pubdate"] || allMeta?.["date"];
  const modifiedStr =
    allMeta?.["article:modified_time"] || allMeta?.["og:updated_time"];
  const publishedTime = publishedStr ? Date.parse(publishedStr) : NaN;
  const modifiedTime = modifiedStr ? Date.parse(modifiedStr) : NaN;
  let hasDateConsistency = false;
  if (Number.isFinite(publishedTime) && Number.isFinite(modifiedTime)) {
    const withinOneYear = Date.now() - modifiedTime <= 365 * 24 * 60 * 60 * 1000;
    hasDateConsistency = modifiedTime >= publishedTime && withinOneYear && modifiedTime <= Date.now();
  } else if (ld?.hasDateModified && Number.isFinite(modifiedTime)) {
    // 只有 modified 时：仅校验时效性
    hasDateConsistency = Date.now() - modifiedTime <= 365 * 24 * 60 * 60 * 1000 && modifiedTime <= Date.now();
  }

  return {
    paragraphs,
    lists: ul,
    listItems: li,
    tables,
    quotes: blockquote,
    codeBlocks: code,
    dataPoints,
    externalCitations,
    hasTldr,
    avgSentenceLength,
    hasDirectAnswer,
    hasSemanticLandmarks,
    headingContinuity,
    hasFaqStructure,
    structuredElementDensity,
    hasAuthorAuthority,
    hasAuthoritativeSources,
    hasDateConsistency,
  };
}

function extractJsonLdInfo(html: string): JsonLdInfo {
  const types = new Set<string>();
  let hasAuthor = false;
  let hasOrganization = false;
  let hasDatePublished = false;
  let hasDateModified = false;
  let hasSameAs = false;
  let hasFaqPage = false;
  let hasAuthorSameAs = false;

  for (const sc of findTags(html, ["script"])) {
    if (!/ld\+json/i.test(sc.attrs.type ?? "")) continue;
    const raw = html.slice(sc.contentStart, sc.contentEnd).trim();
    if (!raw) continue;

    // inAuthor 跟踪当前节点是否处于 author/creator 上下文 ——
    // 只把作者节点的 sameAs 计入 hasAuthorSameAs（区别于组织级 sameAs）。
    const walk = (node: unknown, depth = 0, inAuthor = false) => {
      if (depth > 8 || !node) return;
      if (Array.isArray(node)) {
        node.forEach((n) => walk(n, depth + 1, inAuthor));
        return;
      }
      if (typeof node !== "object") return;
      const o = node as Record<string, unknown>;

      const t = o["@type"];
      if (typeof t === "string") {
        types.add(t);
        if (t === "FAQPage") hasFaqPage = true;
      } else if (Array.isArray(t)) {
        (t as unknown[]).forEach((x) => {
          if (typeof x === "string") {
            types.add(x);
            if (x === "FAQPage") hasFaqPage = true;
          }
        });
      }

      if (o.author !== undefined || o.creator !== undefined) hasAuthor = true;
      if (o.publisher !== undefined) hasOrganization = true;
      if (o.datePublished !== undefined) hasDatePublished = true;
      if (o.dateModified !== undefined) hasDateModified = true;
      if (o.sameAs !== undefined || o.identifier !== undefined) {
        hasSameAs = true;
        if (inAuthor) hasAuthorSameAs = true;
      }

      for (const key of ["@graph", "author", "creator", "publisher", "mainEntity", "itemListElement"]) {
        if (o[key] !== undefined) {
          const childInAuthor = inAuthor || key === "author" || key === "creator";
          walk(o[key], depth + 1, childInAuthor);
        }
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
    hasSameAs,
    hasFaqPage,
    hasAuthorSameAs,
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
