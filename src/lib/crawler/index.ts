/**
 * 鲸析 GEOkit — 站点爬虫主编排（T3）
 *
 * 设计原则与 audit / visibility 通道一致：
 *   - Fetcher 负责采集，Evidence 负责留存，Observer 负责结论
 *   - 抓不到就说抓不到，不编造页面
 *   - 落库失败只记日志，绝不阻断 CrawlResult 返回
 *
 * BFS + worker pool 的并发模式参考 services/visibility.ts 的 batchProbeVisibility：
 * 同样是「数组下标 i++ + workers 抢任务」的最小实现，不引入第三方池库。
 */
import { fetchWithPolicy } from "../fetcher";
import { analyze, emptyAudit } from "../audit";
import { siteSubject, httpSource } from "../evidence/identity";
import { assertValidObservation } from "../evidence/schema";
import { evidenceEnabled } from "../evidence/store";
import { createStore } from "../store";
import { OBSERVATION_CONTRACT_VERSION, type Observation } from "../evidence/types";

import {
  DEFAULT_CRAWL_CONFIG,
  type CrawlConfig,
  type CrawlPage,
  type CrawlResult,
  type Fetcher,
} from "./types";
import { normalizeCrawlUrl, isStaticAsset, isSameDomain, extractLinks } from "./normalize";
import { allowedByRobots, crawlDelayFor, fetchAndParseRobots } from "./robots";
import { discoverSitemaps } from "./sitemap";
import { buildSiteGraph } from "./graph";
import { computeShingles } from "./content";

export { diffCrawlResults } from "./diff";
export { analyzeSiteIssues } from "./issues";
export { ISSUE_TYPES, ISSUE_SEVERITY, DUPLICATE_CONTENT_JACCARD } from "./issues";
export type {
  CrawlConfig,
  CrawlPage,
  CrawlResult,
  CrawlDiff,
  CrawlDiffEntry,
  Fetcher,
  GraphNode,
  GraphEdge,
  SiteGraph,
} from "./types";
export type {
  SiteIssue,
  IssueType,
  IssueSeverity,
  IssueEvidence,
  SiteAnalysis,
  GeoSummary,
  SchemaCoverageEntry,
} from "./issues";

const CRAWL_OBSERVER_VERSION = "crawl-observer@0.1.0";
const CRAWL_PARSER_VERSION = "crawler@0.1.0";

function normalizeOrigin(input: string): { origin: string; startUrl: string } {
  const s = (input ?? "").trim();
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    // 退化：把它当成域名直接拼
    return { origin: `https://${s}`, startUrl: `https://${s}/` };
  }
  return { origin: u.origin, startUrl: u.origin + "/" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function crawlSite(
  input: string,
  opts: { config?: Partial<CrawlConfig>; fetcher?: Fetcher } = {}
): Promise<CrawlResult> {
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const { origin, startUrl } = normalizeOrigin(input);

  const config: CrawlConfig = { ...DEFAULT_CRAWL_CONFIG, ...(opts.config ?? {}) };
  const fetcher: Fetcher = opts.fetcher ?? fetchWithPolicy;

  // 1. robots.txt
  const robotsRec = await fetchAndParseRobots(origin, fetcher, {
    timeoutMs: config.perPageTimeoutMs,
    ua: config.ua,
  });
  const robotsParsed = robotsRec.parsed;
  const robotsRaw = robotsRec.raw;
  const robotsSitemaps = robotsRec.sitemaps;
  const crawlDelay =
    robotsRaw !== null ? crawlDelayFor(robotsRaw, config.ua) : null;
  const minInterval = Math.max(
    config.minRequestIntervalMs,
    crawlDelay ? crawlDelay * 1000 : 0
  );

  // 2. sitemap 发现 —— 失败/为空都不阻断爬取
  let sitemapUrls: string[] = [];
  try {
    sitemapUrls = await discoverSitemaps(origin, robotsSitemaps, fetcher, {
      timeoutMs: config.perPageTimeoutMs,
      maxDepth: 3,
    });
  } catch {
    /* ignore */
  }

  // 3. BFS 队列 —— 起点为 origin URL
  type QueueItem = { url: string; depth: number };
  const seen = new Set<string>();
  const queue: QueueItem[] = [];
  const enqueue = (url: string, depth: number): void => {
    const n = normalizeCrawlUrl(url);
    if (!n) return;
    if (seen.has(n)) return;
    seen.add(n);
    queue.push({ url: n, depth });
  };
  enqueue(startUrl, 0);

  const pages: CrawlPage[] = [];
  let truncated = false;
  let truncateReason: string | undefined;

  const lastRequestPerHost = new Map<string, number>();

  async function processOne(item: QueueItem): Promise<void> {
    if (truncated) return;
    const { url, depth } = item;
    const urlPath = (() => {
      try {
        return new URL(url).pathname || "/";
      } catch {
        return "/";
      }
    })();

    // robots 检查
    if (robotsParsed) {
      const { allowed } = allowedByRobots(robotsParsed, urlPath, config.ua);
      if (!allowed) return;
    }

    // 域名检查
    if (!isSameDomain(url, origin, config.includeSubdomains)) return;

    // 静态资源检查
    if (isStaticAsset(url)) return;

    // 限额检查
    if (pages.length >= config.maxPages) {
      truncated = true;
      truncateReason = "达到最大页面数上限";
      return;
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed > config.totalBudgetMs) {
      truncated = true;
      truncateReason = "达到总耗时上限";
      return;
    }

    // 礼貌延迟：同 host 最小请求间隔
    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return url;
      }
    })();
    const last = lastRequestPerHost.get(host);
    if (last !== undefined) {
      const wait = minInterval - (Date.now() - last);
      if (wait > 0) await sleep(wait);
    }
    lastRequestPerHost.set(host, Date.now());

    // 抓取
    const reqStart = Date.now();
    let res;
    try {
      res = await fetcher({
        url,
        timeoutMs: config.perPageTimeoutMs,
        headers: { "User-Agent": config.ua },
        followRedirect: true,
        purpose: "crawl",
        target: url,
      });
    } catch (err) {
      // 网络异常不丢弃：记录失败页面
      pages.push({
        url,
        finalUrl: url,
        httpStatus: 0,
        redirectChain: [],
        title: null,
        metaDescription: null,
        h1: null,
        canonical: null,
        noindex: false,
        hreflang: [],
        jsonLdTypes: [],
        internalLinks: 0,
        externalLinks: 0,
        wordCount: 0,
        geoScore: 0,
        seoScore: 0,
        clickDepth: depth,
        outLinks: [],
        error: err instanceof Error ? err.message : "network_error",
        statusReason: "connection_failure",
      });
      return;
    }
    const elapsedMs = Date.now() - reqStart;

    const finalUrl = res.finalUrl || url;
    // 重定向链：attempts 不带 url，只能用 finalUrl 与请求 URL 的差异推断
    const redirectChain: string[] =
      finalUrl !== url ? [finalUrl] : [];

    // 4xx 5xx 处理（403 单独标 blocked）
    const status = res.status;
    const page: CrawlPage = {
      url,
      finalUrl,
      httpStatus: status,
      redirectChain,
      title: null,
      metaDescription: null,
      h1: null,
      canonical: null,
      noindex: false,
      hreflang: [],
      jsonLdTypes: [],
      internalLinks: 0,
      externalLinks: 0,
      wordCount: 0,
      geoScore: 0,
      seoScore: 0,
      clickDepth: depth,
      outLinks: [],
    };

    if (status === 403) {
      page.blocked = { reason: "HTTP 403 Forbidden" };
      pages.push(page);
      return;
    }

    // ok = 2xx；非 2xx 当数据记录但不跑 analyze
    const isOk = status >= 200 && status < 300;
    if (!isOk) {
      // 4xx/5xx：写入极简 page，标题/字段保持空
      pages.push(page);
      return;
    }

    // 2xx：跑 analyze
    const html = res.body ?? "";
    // 完全空体：复用 emptyAudit 的语义，不跑 11 项检查
    const audit =
      html === ""
        ? emptyAudit(finalUrl, res.error?.message ?? "空响应体", elapsedMs)
        : analyze(finalUrl, html, status, elapsedMs);

    page.title = audit.title;
    page.metaDescription = audit.metaDescription;
    page.h1 =
      audit.headings.find((h) => h.level === 1)?.text ?? null;
    page.canonical = audit.canonical;
    page.noindex = audit.robotsMeta
      ? /noindex/i.test(audit.robotsMeta)
      : false;
    page.hreflang = audit.hreflang;
    page.jsonLdTypes = audit.jsonLdTypes;
    page.internalLinks = audit.internalLinks;
    page.externalLinks = audit.externalLinks;
    page.wordCount = audit.wordCount;
    page.geoScore = audit.geoScore;
    page.seoScore = audit.seoScore;
    page.geoBreakdown = audit.geoBreakdown;

    // T4：正文 shingle 指纹（仅哈希，不存正文）。过短页面返回 null
    page.contentShingles = computeShingles(html) ?? undefined;

    // outLinks：从 html 提取，过滤到同域
    const allLinks = extractLinks(html, finalUrl);
    const internalLinkTargets: string[] = [];
    const outSeen = new Set<string>();
    for (const link of allLinks) {
      if (!isSameDomain(link, origin, config.includeSubdomains)) continue;
      if (isStaticAsset(link)) continue;
      const n = normalizeCrawlUrl(link);
      if (!n || n === url) continue;
      if (outSeen.has(n)) continue;
      outSeen.add(n);
      internalLinkTargets.push(n);
    }
    page.outLinks = internalLinkTargets;

    pages.push(page);

    // 入队：仅在深度允许时
    if (depth < config.maxDepth) {
      for (const target of internalLinkTargets) {
        enqueue(target, depth + 1);
      }
    }
  }

  // Worker pool —— 抢占式并发
  let queueCursor = 0;
  const runWorkers = async () => {
    const workerCount = Math.max(1, config.concurrency);
    const workers = Array.from({ length: workerCount }, async () => {
      while (queueCursor < queue.length) {
        const idx = queueCursor++;
        if (idx >= queue.length) break;
        const item = queue[idx];
        if (!item) continue;
        try {
          await processOne(item);
        } catch (e) {
          // 单页失败不阻断整批
          console.error(
            "[geokit] crawl page 失败：",
            item.url,
            e instanceof Error ? e.message : e
          );
        }
      }
    });
    await Promise.all(workers);
  };

  // 第一轮：基于起始页及其内链的 BFS 抓取
  await runWorkers();

  // 任务 2.1：Sitemap 候选池补充与 Budget 控制
  // 当标准 BFS 流程结束或触达 maxDepth 后，若仍有配额，从 sitemap URLs 中筛选同源且尚未访问的孤岛页补充抓取
  const elapsedFirst = Date.now() - startedAt;
  if (!truncated && pages.length < config.maxPages && elapsedFirst < config.totalBudgetMs) {
    const remainingBudget = config.maxPages - pages.length;
    const sitemapCandidates: string[] = [];
    for (const rawUrl of sitemapUrls) {
      const n = normalizeCrawlUrl(rawUrl);
      if (!n) continue;
      if (seen.has(n)) continue;
      if (!isSameDomain(n, origin, config.includeSubdomains)) continue;
      if (isStaticAsset(n)) continue;
      sitemapCandidates.push(n);
    }

    const toAdd = sitemapCandidates.slice(0, remainingBudget);
    for (const candUrl of toAdd) {
      // 赋予 maxDepth 深度标记，确保抓取孤岛页自身后不再无休止展开深层内链，守护 Crawler Budget
      enqueue(candUrl, config.maxDepth);
    }

    if (toAdd.length > 0) {
      await runWorkers();
    }
  }

  // 二次检查限额（避免最后一组 worker 刚超限未标 truncated）
  if (!truncated && pages.length >= config.maxPages) {
    truncated = true;
    truncateReason = "达到最大页面数上限";
  }
  const totalElapsed = Date.now() - startedAt;
  if (!truncated && totalElapsed > config.totalBudgetMs) {
    truncated = true;
    truncateReason = "达到总耗时上限";
  }

  // 4. 站点图
  const graph = buildSiteGraph(pages, sitemapUrls);

  const result: CrawlResult = {
    origin,
    pages,
    graph,
    truncated,
    reason: truncateReason,
    config,
    startedAt: startedAtIso,
    elapsedMs: totalElapsed,
  };

  // 5. 落 Observation —— 总闸关闭时直接跳过，失败只记日志
  await persistCrawlObservation(startUrl, result).catch((e) => {
    console.error(
      "[geokit] crawl Observation 落库失败：",
      e instanceof Error ? e.message : e
    );
  });

  return result;
}

/**
 * 把爬取结果落成 Observation(kind="crawl")。
 *
 * 与 audit 通道一样：总闸关闭则不落库；落库失败只记日志，不抛错。
 * 仍然走 assertValidObservation —— 数据不合法不该落库。
 */
async function persistCrawlObservation(
  startUrl: string,
  result: CrawlResult
): Promise<void> {
  if (!evidenceEnabled()) return;

  const subject = siteSubject(result.origin || startUrl);
  const source = httpSource(startUrl);

  const observation: Observation = {
    id: "",
    contractVersion: OBSERVATION_CONTRACT_VERSION,
    type: "crawl",
    subject,
    source,
    observedAt: result.startedAt,
    observerVersion: CRAWL_OBSERVER_VERSION,
    parserVersion: CRAWL_PARSER_VERSION,
    evidenceRefs: [],
    status: "OBSERVED",
    result: {
      pages: result.pages,
      graph: result.graph,
      truncated: result.truncated,
      reason: result.reason,
      config: result.config,
    },
    confidence: result.pages.length > 0 ? "high" : "low",
    coverage: {
      expected: result.config.maxPages,
      observed: result.pages.length,
      ratio:
        result.config.maxPages > 0
          ? Math.min(1, result.pages.length / result.config.maxPages)
          : 0,
      missing: result.truncated ? [result.reason ?? "truncated"] : [],
    },
    metadata: {
      extra: {
        origin: result.origin,
        elapsedMs: result.elapsedMs,
        truncated: result.truncated,
      },
    },
  };

  assertValidObservation(observation);

  const store = createStore();
  await store.saveObservation(observation);
}
