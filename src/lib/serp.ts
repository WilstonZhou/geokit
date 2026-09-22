/**
 * 鲸析 GEOkit — 多引擎 SERP 采集
 *
 * open-seo 的 SERP 数据 100% 走 DataForSEO 的付费 API，且只覆盖 Google / Bing。
 * GEOkit 这里做的是直接采集 + 解析：百度、搜狗、360、神马、头条、Google、Bing。
 *
 * 设计原则（很重要）：
 *   抓不到就是抓不到。失败时返回 status: "blocked" 并给出原因，
 *   绝不用编造的数据冒充真实排名 —— 这是 SEO 工具最容易骗人也最致命的地方。
 */

import { ENGINES, type EngineId, type SearchEngine } from "./engines";
import { findTags, stripTags, getDomain, decodeEntities, absolutize } from "./html";
import { fetchWithPolicy, type FetchResult } from "./fetcher";
import { evidenceFromFetch, evidenceEnabled } from "./evidence/store";
import { createStore, type Store } from "./store";
import { searchSubject, searchEngineSource } from "./evidence/identity";
import { recordSearchObservation } from "./observers/search";
import type { Evidence } from "./evidence/types";

export type SerpStatus = "ok" | "blocked" | "no_results" | "error";

export interface SerpResultItem {
  position: number;
  title: string;
  url: string;
  domain: string;
  snippet: string;
  /** 是否属于该搜索引擎自家站内结果（百度百科、贴吧等） */
  owned: boolean;
  /**
   * 链接是否为搜索引擎的跳转中转地址。
   * 百度以外的中文引擎普遍用这种包装（如 sogou.com/link?url=…、so.com/link?m=…），
   * 这会掩盖真实目标域名 —— 必须据实标注，不能假装 domain 就是结果站点。
   */
  redirectWrapper: boolean;
  /** 真实目标是否已解析出来 */
  resolved: boolean;
}

export interface SerpResponse {
  engine: EngineId;
  engineName: string;
  keyword: string;
  status: SerpStatus;
  /** 抓不到时的明确原因，UI 必须展示 */
  note?: string;
  items: SerpResultItem[];
  /** 目标域名在结果中的位置，1 起；未上榜为 null */
  targetRank: number | null;
  targetFound: boolean;
  fetchedAt: string;
  elapsedMs: number;
}

const FETCH_TIMEOUT_MS = 12_000;

/** 一次 SERP 采集的存证结果 */
interface SerpEvidenceRecord {
  id: string;
  evidence: Evidence;
  /** 复用同一实例，避免 JsonlStore 的惰性索引被重复构建 */
  store: Store;
  body: string;
}

interface SerpFetchOutcome {
  html: string;
  record: SerpEvidenceRecord | null;
}

/**
 * 采集失败时也要带上存证结果 —— 被限流本身就是需要留痕的事实，
 * 否则「这一小时一直被百度挡着」这种信息会永远丢失。
 */
class SerpFetchError extends Error {
  constructor(
    message: string,
    readonly record: SerpEvidenceRecord | null
  ) {
    super(message);
    this.name = "SerpFetchError";
  }
}

/**
 * 把一次 SERP 采集落成 `serp_html` Evidence —— S4 Search Observer 的输入。
 *
 * 只做事实留存，不产出任何结论。三条边界与 S3 一致：
 *   1. 总闸沿用 `GEOKIT_EVIDENCE`（默认 off），默认行为零变化
 *   2. identity 注入在本函数内完成，不改 `evidenceFromFetch()` 签名
 *   3. 失败捕获返回 null：存证是旁路，绝不因此让调用方拿不到排名结果
 */
async function recordSerpEvidence(
  res: FetchResult,
  engineId: EngineId,
  keyword: string,
  targetDomain?: string
): Promise<SerpEvidenceRecord | null> {
  if (!evidenceEnabled()) return null;

  try {
    // subject = 被观测对象（站点 + 关键词）；source = 观测来源（引擎）。
    // 引擎刻意不进 subject —— 它属于 source，混进去会让同一对象在不同
    // 引擎下的历史被拆成互不相干的两条时间线。
    const patched: FetchResult = {
      ...res,
      context: {
        ...res.context,
        subject: searchSubject(targetDomain, keyword),
        source: searchEngineSource(engineId),
      },
    };

    const ev = evidenceFromFetch(patched, "serp_html");

    // ★ 兜底修正（S1 已知缺陷，本轮不改动 S1 代码）：
    //   normalizeEvidence 会把缺 provenance 的记录判为旧契约，并用
    //   `target`（此处是引擎 id）重新推导，从而覆盖上面注入的 subject。
    //   这里补回 canonical 版本，与 S3 的处理保持一致。
    ev.subject = searchSubject(targetDomain, keyword);
    ev.source = searchEngineSource(engineId);
    ev.migratedFrom = undefined;

    // 与 S3 同构：拿到了响应就标记正文已留存，保证 Observer 可重放。
    // （设计稿 D7 建议 SERP 默认 hash-only，但那与「结论必须能指回可重放
    //   素材」直接冲突 —— hash-only 下 S4 永远产不出结论。这里改为留存正文，
    //   磁盘代价由 GEOKIT_EVIDENCE 总闸控制，默认关闭。）
    const body = res.body;
    if (res.status > 0 || body.length > 0) ev.response.bodyRetained = true;

    const store = createStore();
    const saved = await store.saveEvidence(ev, body ? { body } : undefined);
    return { id: saved.id, evidence: ev, store, body };
  } catch (e) {
    console.error(
      "[geokit] SERP Evidence 落盘失败，本次无存证：",
      e instanceof Error ? e.message : e
    );
    return null;
  }
}

async function fetchHtml(
  url: string,
  engine: SearchEngine,
  /**
   * 仅用于 provenance（Phase 1 subject 需要它）。不参与任何请求构造或解析，
   * 不传也不影响抓取与排名结果。
   */
  keyword = "",
  targetDomain?: string
): Promise<SerpFetchOutcome> {
  const r = await fetchWithPolicy({
    url,
    timeoutMs: FETCH_TIMEOUT_MS,
    followRedirect: true,
    headers: {
      "User-Agent": engine.userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    purpose: "serp",
    // @deprecated 保留给 Phase 0 读者：serp 通道的 target 是「来源」不是「被观测对象」
    target: engine.id,
    meta: { engineId: engine.id, keyword, ...(targetDomain ? { siteUrl: targetDomain } : {}) },
    // 启用 per-domain 限速（默认策略）。五个引擎域名互不相同，桶各自独立，
    // 单次并发请求不受影响；只有对同一引擎连续高频请求才会被节流。
  });

  // 与历史实现完全一致：非 2xx 抛错，由 fetchSerp 捕获后返回 blocked。
  // 唯一区别是抛错前先把这次采集存证 —— 挡我们的那一页也是有价值的证据。
  const record = await recordSerpEvidence(r, engine.id, keyword, targetDomain);
  if (!r.ok) {
    throw new SerpFetchError(
      r.error?.kind === "http_error" ? `HTTP ${r.status}` : (r.error?.message ?? "请求失败"),
      record
    );
  }
  return { html: r.body, record };
}

/** 单容器允许的最大内容长度，超过说明标签嵌套被错配 */
const MAX_CONTAINER_LEN = 25_000;
const REDIRECT_TIMEOUT_MS = 6_000;
/** 最多并发解析多少个跳转链接，避免把引擎请求拖崩 */
const REDIRECT_CONCURRENCY = 5;
/** 只有前 N 名值得花代价解析真实域名 */
const RESOLVE_TOP_N = 10;

/**
 * 按引擎提取结果条目。
 *
 * 关键取舍：除百度外，多数中文引擎的结果链接都是自家中转地址
 * （sogou.com/link?url=…、so.com/link?m=…）。早期版本把这些域名当成
 * 「搜索引擎自身」直接丢弃，导致大量真实结果被误杀。现在改为：先据实保留，
 * 再异步解析真实目标，并把无法实现的情况标记为 redirectWrapper，不假装知道答案。
 */
/**
 * Phase 0：导出以便离线回归。
 * 该函数本身未作任何修改 —— 导出目的是让三个筐子的特殊解析
 * 能被 fixture 直接喂进去做 regression，不依赖实时网络。
 */
export function extractItems(html: string, engine: SearchEngine, baseUrl: string): Partial<SerpResultItem>[] {
  const raw: Partial<SerpResultItem>[] = [];
  const containers = selectContainers(html, engine);

  for (const c of containers) {
    if (c.contentEnd - c.contentStart > MAX_CONTAINER_LEN) continue;
    const inner = html.slice(c.contentStart, c.contentEnd);

    // 结果标题一定在某个 heading 里，以此为锚点避免跨容器污染
    const heading = findTags(inner, ["h1", "h2", "h3", "h4"])[0];
    let primary: ReturnType<typeof findTags>[number] | undefined;
    let title = "";

    if (heading) {
      const headingInner = inner.slice(heading.contentStart, heading.contentEnd);
      primary = findTags(headingInner, ["a"]).find((a) => a.attrs.href);
      if (primary) title = stripTags(headingInner.slice(primary.contentStart, primary.contentEnd));
      if (!title) title = stripTags(headingInner);
    }
    if (!primary) {
      primary = findTags(inner, ["a"]).find(
        (a) => a.attrs.href && !a.attrs.href.startsWith("#") && !/^javascript:/i.test(a.attrs.href)
      );
      if (primary) title = stripTags(inner.slice(primary.contentStart, primary.contentEnd));
    }
    if (!primary?.attrs.href) continue;
    if (!title && primary.attrs.title) title = decodeEntities(primary.attrs.title);
    if (!title) continue;

    // 百度 mu / 360 data-mdurl / 搜狗 cite 文本 —— 能取到就用真实目标，
    // 取不到再退回中转链接，并据实标记 redirectWrapper
    const real = pickRealUrl(engine, inner, c);
    const url = real ?? primary.attrs.href;

    const absolute = absolutize(url, baseUrl);
    const domain = getDomain(absolute);
    const engineDomain = getDomain(engine.domain);

    const isWrapper = isRedirectWrapper(absolute, engineDomain, primary.attrs.href);
    if (domain === engineDomain && !isWrapper) continue;

    // 最后一道防线：连目标域名都说不清的结果没有分析价值，
    // 与其给用户一个 "." 这样的脏值，不如不收录。
    if (!looksLikeValidHost(domain)) continue;

    raw.push({
      title: unescapeUnicode(title).slice(0, 200),
      url: absolute,
      domain,
      snippet: buildSnippet(inner, absolute),
      owned: engine.ownedProperties.some((p) => domain.includes(p)),
      redirectWrapper: isWrapper,
      resolved: !isWrapper,
    });
  }
  return raw;
}

/**
 * 引擎专属：从结果容器里取出「真实目标 URL」。
 *
 * 只有百度会在容器上直接给出 mu；其余中文引擎各有各的做法，
 * 这些都是对着真实返回页挨个核对出来的，不是通用猜测：
 *   - 360    →  li 上的 data-mdurl
 *   - 搜狗   →  citeLinkClass 元素里的可见文本
 *   - Google/Bing → 本身就是直链，无需处理
 */
function pickRealUrl(
  engine: SearchEngine,
  inner: string,
  container: ReturnType<typeof findTags>[number]
): string | null {
  if (engine.id === "baidu") {
    return container.attrs.mu ? decodeURIComponentSafe(container.attrs.mu) : null;
  }

  if (engine.id === "so360") {
    if (container.attrs["data-mdurl"]) return decodeEntities(container.attrs["data-mdurl"]);
    // 属性可能落在子标签上；限制扫描范围，避免串到下一条结果
    const m = inner.slice(0, 4000).match(/data-mdurl="([^"]+)"/);
    if (m) return decodeEntities(m[1]);
    return null;
  }

  if (engine.id === "sogou") {
    const cites = findTags(inner, ["a"]).filter((a) =>
      /citeLinkClass|citeurl/i.test(a.attrs.class ?? "")
    );
    for (const c of cites) {
      const text = decodeEntities(stripTags(inner.slice(c.contentStart, c.contentEnd)));
      const found = text.match(/https?:\/\/([a-zA-Z0-9.-]+)/);
      // 搜狗的 cite 文本会被显示层截断（如 "https://global.lianlianpa…"），
      // 这种残缺域名不能拿来用，宁可退回中转链接也别给出错误的域名。
      if (found && looksLikeValidHost(found[1])) return found[0];
    }
    return null;
  }

  return null;
}

/** 常见后缀 + 长度兜底，用于剔除被截断的域名片段 */
const KNOWN_TLD = new Set([
  "com", "cn", "net", "org", "edu", "gov", "mil", "int", "biz", "info", "name",
  "top", "xyz", "vip", "club", "shop", "site", "online", "store", "app", "tech",
  "dev", "ai", "io", "co", "me", "tv", "cc", "pro", "ltd", "group", "wiki",
  "hk", "tw", "mo", "jp", "kr", "sg", "my", "th", "vn", "in", "au", "nz",
  "uk", "us", "ca", "de", "fr", "nl", "it", "es", "ru", "ua", "br", "mx",
]);

function looksLikeValidHost(host: string): boolean {
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return false;
  const last = parts[parts.length - 1].toLowerCase();
  if (KNOWN_TLD.has(last)) return true;
  // 非白名单后缀时，用长度排除明显被截断的碎片
  return last.length >= 2 && last.length <= 6 && /^[a-z]+$/.test(last);
}

/**
 * 判断是否为搜索引擎的跳转包装链接。
 * 只有在拿不到真实 URL 时才成立 —— 有 mu / data-mdurl / cite 就直接走明文。
 */
function isRedirectWrapper(absolute: string, engineDomain: string, rawHref: string): boolean {
  let path = "";
  try {
    path = new URL(absolute).pathname.toLowerCase();
  } catch {
    return false;
  }
  let isSelfHost = false;
  try {
    isSelfHost = getDomain(new URL(absolute).hostname) === engineDomain;
  } catch {
    return false;
  }
  if (!isSelfHost) return false;
  // /link?url=…、/link?m=…、/jump?… 都是典型的中转形态
  if (/(^\/link|^\/jump|^\/redirect|^\/transfer|^\/go\b)/.test(path)) return true;
  return /[?&](url|m|to|target|redirect|u)=/i.test(rawHref ?? "");
}

/**
 * 跟随重定向解析真实目标地址。
 * 中转包得再深，最终也会 302 到真实站点 —— 这是唯一可靠的方法。
 */
async function resolveFinalUrl(target: string, ua: string): Promise<string | null> {
  const r = await fetchWithPolicy({
    url: target,
    method: "GET",
    followRedirect: true,
    // 只在乎最终落到哪个域名，不读响应体 —— 沿用历史的省流量做法
    readBody: false,
    timeoutMs: REDIRECT_TIMEOUT_MS,
    headers: { "User-Agent": ua, Accept: "*/*" },
    purpose: "resolve-redirect",
    target,
  });
  if (!r.finalUrl) return null;
  return r.finalUrl || null;
}

/** 有限并发地批量解析 */
async function resolveAll(items: SerpResultItem[], ua: string): Promise<void> {
  const targets = items.filter((i) => i.redirectWrapper).slice(0, RESOLVE_TOP_N);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(REDIRECT_CONCURRENCY, targets.length) }, async () => {
    while (cursor < targets.length) {
      const idx = cursor++;
      const item = targets[idx];
      const final = await resolveFinalUrl(item.url, ua);
      if (final) {
        try {
          const d = getDomain(new URL(final).hostname);
          // 解析结果若仍是引擎自己，说明这条路走不通，如实保留未解析状态
          if (d !== getDomain(new URL(item.url).hostname)) {
            item.url = final;
            item.domain = d;
            item.resolved = true;
            item.redirectWrapper = false;
          }
        } catch {
          /* URL 解析失败保持原状 */
        }
      }
    }
  });
  await Promise.all(workers);
}

function selectContainers(html: string, engine: SearchEngine) {
  switch (engine.id) {
    case "baidu":
      return findTags(html, ["div"]).filter(
        (t) =>
          /\bresult\b|c-container/.test(t.attrs.class ?? "") &&
          (t.attrs.mu || /c-container/.test(t.attrs.class ?? ""))
      );
    case "sogou":
      return findTags(html, ["div"]).filter((t) =>
        /\bvrwrap\b|\brb\b/.test(t.attrs.class ?? "")
      );
    case "so360":
      return findTags(html, ["li", "div"]).filter((t) =>
        /\bres-list\b|\bres-list-from\b/.test(t.attrs.class ?? "")
      );
    case "shenma":
      return findTags(html, ["div", "li"]).filter((t) =>
        /\bresult-item\b|\bcu-item\b/.test(t.attrs.class ?? "")
      );
    case "toutiao":
      return findTags(html, ["div"]).filter((t) =>
        /\bresult-content\b/.test(t.attrs.class ?? "")
      );
    case "google":
      return findTags(html, ["div"]).filter((t) => {
        const cls = t.attrs.class ?? "";
        return cls.split(/\s+/).includes("g") || /\bMjjYud\b/.test(cls);
      });
    case "bing":
      return findTags(html, ["li"]).filter((t) =>
        /\bb_algo\b/.test(t.attrs.class ?? "")
      );
    default:
      return [];
  }
}

/**
 * 中文引擎常把结果塞在页面内嵌的 JSON 里，取出来的文本会是
 * `\u4ea4\u6613\u5e73\u53f0` 这种未解码的转义序列 —— 直接展示给用户就是一串乱码。
 * 这里统一还原成人类可读文本。
 */
function unescapeUnicode(s: string): string {
  if (!/\\u[0-9a-fA-F]{4}/.test(s)) return s;
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/\\\//g, "/")
    .replace(/\\[nrt]/g, " ");
}

function buildSnippet(inner: string, excludeUrl: string): string {
  // 中文引擎把大量结构化数据塞在内嵌 <script> 里。不去掉的话，
  // stripTags 会把脚本里的 JSON 当正文，摘要就变成 `"size":"md"},"abstract":"…`。
  const noScript = inner
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");

  // 各家给描述块的 class 不同（百度 c-abstract、搜狗 space-txt、360 res-desc），
  // 先用关键词捞一次，捞不到再退回整段文本。
  const descMatch = noScript.match(
    /<(span|div|p|td)[^>]*(?:class|id)="[^"]*(?:abstract|desc|summary|space-txt|content-right|text-layout)[^"]*"[^>]*>([\s\S]{20,800}?)<\/\1>/i
  );
  const source = descMatch ? descMatch[2] : noScript;

  const text = unescapeUnicode(stripTags(source))
    .replace(excludeUrl, "")
    .replace(/\s+/g, " ")
    .trim();

  // 兜底：如果仍残留 JSON 结构符号，说明这段文本不是给人看的，宁可留空
  const looksLikeJson = /"\s*:\s*"/.test(text) || /\}\s*,\s*\{/.test(text);

  return looksLikeJson ? "" : text.slice(0, 300);
}


function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 采集单个关键词在单个引擎上的结果 */
export async function fetchSerp(
  engineId: EngineId,
  keyword: string,
  targetDomain?: string,
  pages = 1,
  resolveUrls = true
): Promise<SerpResponse> {
  const engine = ENGINES[engineId];
  const started = Date.now();
  const base: SerpResponse = {
    engine: engineId,
    engineName: engine.name,
    keyword,
    status: "ok",
    items: [],
    targetRank: null,
    targetFound: false,
    fetchedAt: new Date().toISOString(),
    elapsedMs: 0,
  };

  const all: SerpResultItem[] = [];
  /** 本次采集落成的 serp_html Evidence（多页时按页序累积） */
  const evidences: Evidence[] = [];
  let store: Store | null = null;

  /**
   * 把结果落成 rank Observation（S4）。
   *
   * 只有 Evidence 真的落盘了才产结论；失败只记日志，绝不阻断 SerpResponse
   * 返回，也绝不把「没存上」说成「观测成功」。
   */
  const emitObservation = async (response: SerpResponse): Promise<void> => {
    if (!store || evidences.length === 0) return;
    const r = await recordSearchObservation(store, { evidences, response, targetDomain });
    if (!r.ok) console.error("[geokit] Search Observation 未生成：", r.reason);
  };

  for (let p = 0; p < pages; p++) {
    const url = engine.searchUrl(keyword, p * engine.resultsPerPage);
    let html = "";
    try {
      const got = await fetchHtml(url, engine, keyword, targetDomain);
      html = got.html;
      if (got.record) {
        evidences.push(got.record.evidence);
        store = got.record.store;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const rec = e instanceof SerpFetchError ? e.record : null;
      if (rec) {
        evidences.push(rec.evidence);
        store = rec.store;
      }
      base.elapsedMs = Date.now() - started;
      const blocked: SerpResponse = {
        ...base,
        status: "blocked",
        note: isAbort(msg)
          ? `采集超时（${FETCH_TIMEOUT_MS / 1000}s）。${engine.name}对直连采集有风控，生产环境建议走住宅代理或在服务端配置 "${engine.name.toUpperCase()}_PROXY"。`
          : `请求失败：${msg}。${engine.name}可能会拦截服务端直连请求，生产环境建议配置代理。`,
      };
      await emitObservation(blocked);
      return blocked;
    }

    const partials = extractItems(html, engine, engine.searchUrl("", 0));
    partials.forEach((item, i) => {
      all.push({
        position: p * engine.resultsPerPage + i + 1,
        title: item.title ?? "",
        url: item.url ?? "",
        domain: item.domain ?? "",
        snippet: item.snippet ?? "",
        owned: item.owned ?? false,
        redirectWrapper: item.redirectWrapper ?? false,
        resolved: item.resolved ?? true,
      });
    });
  }

  // 解析搜狗 / 360 这类中转链接背后的真实域名
  if (resolveUrls) {
    await resolveAll(all, engine.userAgent);
  }

  // 去重：同域名多次出现只保留最高位次（符合直觉的“域名排名”）
  const seen = new Set<string>();
  const deduped = all.filter((it) => {
    if (seen.has(it.domain)) return false;
    seen.add(it.domain);
    return true;
  });

  let targetRank: number | null = null;
  if (targetDomain) {
    const target = getDomain(targetDomain);
    const hit = deduped.find((it) => it.domain === target);
    if (hit) targetRank = hit.position;
  }

  base.elapsedMs = Date.now() - started;

  if (deduped.length === 0) {
    const noResults: SerpResponse = {
      ...base,
      status: "no_results",
      note: `未从 ${engine.name} 的返回页中解析出结果条目。该引擎的页面结构可能已改版，或返回的是验证页。GEOkit 宁可如实返回空，也不编造排名。`,
    };
    await emitObservation(noResults);
    return noResults;
  }

  const ok: SerpResponse = { ...base, items: deduped, targetRank, targetFound: targetRank !== null };
  await emitObservation(ok);
  return ok;
}

function isAbort(msg: string): boolean {
  return /abort/i.test(msg);
}

/** 一次跑多个引擎 */
export async function fetchMultiEngine(
  engineIds: EngineId[],
  keyword: string,
  targetDomain?: string,
  pages = 1,
  resolveUrls = true
): Promise<SerpResponse[]> {
  return Promise.all(
    engineIds.map((id) =>
      fetchSerp(id, keyword, targetDomain, pages, resolveUrls).catch((e): SerpResponse => ({
        engine: id,
        engineName: ENGINES[id].name,
        keyword,
        status: "error",
        note: e instanceof Error ? e.message : String(e),
        items: [],
        targetRank: null,
        targetFound: false,
        fetchedAt: new Date().toISOString(),
        elapsedMs: 0,
      }))
    )
  );
}
