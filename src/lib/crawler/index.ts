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
import { analyzeSiteIssues } from "./issues";

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

/**
 * 硬上限：HTTP 入口与 MCP 都允许调用方传 config，不能让调用方用
 * `concurrency: 1e9` 或 `maxPages: Infinity` 打爆进程 / 打爆目标站。
 *
 * 这些值只约束外部输入；合法范围内的自定义仍然生效。
 */
export const CRAWL_LIMITS = {
  maxPages: { min: 1, max: 1_000 },
  maxDepth: { min: 0, max: 10 },
  concurrency: { min: 1, max: 8 },
  perPageTimeoutMs: { min: 1_000, max: 60_000 },
  totalBudgetMs: { min: 1_000, max: 600_000 },
  minRequestIntervalMs: { min: 0, max: 10_000 },
} as const;

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  if (typeof value !== "number" && typeof value !== "string") return fallback;
  const n = Number(value);
  if (Number.isNaN(n)) return fallback;
  // Infinity 可能是 JSON 里的 1e999：夹到对应方向的硬边界
  if (!Number.isFinite(n)) return n > 0 ? max : min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 把不可信的 Partial<CrawlConfig> 收敛成有界配置 */
export function normalizeCrawlConfig(
  input: Partial<CrawlConfig> | undefined
): CrawlConfig {
  const raw = { ...DEFAULT_CRAWL_CONFIG, ...(input ?? {}) };
  return {
    maxPages: clampInt(raw.maxPages, CRAWL_LIMITS.maxPages.min, CRAWL_LIMITS.maxPages.max, DEFAULT_CRAWL_CONFIG.maxPages),
    maxDepth: clampInt(raw.maxDepth, CRAWL_LIMITS.maxDepth.min, CRAWL_LIMITS.maxDepth.max, DEFAULT_CRAWL_CONFIG.maxDepth),
    concurrency: clampInt(raw.concurrency, CRAWL_LIMITS.concurrency.min, CRAWL_LIMITS.concurrency.max, DEFAULT_CRAWL_CONFIG.concurrency),
    perPageTimeoutMs: clampInt(raw.perPageTimeoutMs, CRAWL_LIMITS.perPageTimeoutMs.min, CRAWL_LIMITS.perPageTimeoutMs.max, DEFAULT_CRAWL_CONFIG.perPageTimeoutMs),
    totalBudgetMs: clampInt(raw.totalBudgetMs, CRAWL_LIMITS.totalBudgetMs.min, CRAWL_LIMITS.totalBudgetMs.max, DEFAULT_CRAWL_CONFIG.totalBudgetMs),
    includeSubdomains: raw.includeSubdomains === true,
    minRequestIntervalMs: clampInt(raw.minRequestIntervalMs, CRAWL_LIMITS.minRequestIntervalMs.min, CRAWL_LIMITS.minRequestIntervalMs.max, DEFAULT_CRAWL_CONFIG.minRequestIntervalMs),
    ua:
      typeof raw.ua === "string" && raw.ua.trim().length > 0
        ? raw.ua.slice(0, 512)
        : DEFAULT_CRAWL_CONFIG.ua,
  };
}

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

  const config: CrawlConfig = normalizeCrawlConfig(opts.config);
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
  let queueCursor = 0;
  const maxQueue = Math.max(config.maxPages * 50, 1_000);
  const enqueue = (url: string, depth: number): void => {
    const n = normalizeCrawlUrl(url);
    if (!n) return;
    if (seen.has(n)) return;
    // 队列里尚未处理的项有上限：畸形站点（一页几万个链接）不能无限占内存
    if (queue.length - queueCursor >= maxQueue) return;
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
        const u = new URL(url);
        // robots.txt 规则可以带 query（如 /search?q=），只传 pathname 会漏判
        return `${u.pathname || "/"}${u.search}`;
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
    // 优先使用 fetcher 记录的真实逐跳链；旧注入 fetcher 没这个字段时退回推断
    const redirectChain: string[] =
      res.redirectChain && res.redirectChain.length > 0
        ? res.redirectChain
        : finalUrl !== url
          ? [finalUrl]
          : [];

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

    // 重定向到站外：记录最终 URL，但不把外部页面当作本站内容分析。
    // 否则站点图/内容重复检测会把别的域名内容算进站点。
    if (!isSameDomain(finalUrl, origin, config.includeSubdomains)) {
      page.statusReason = "off_domain_redirect";
      pages.push(page);
      return;
    }

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
      if (internalLinkTargets.length >= 5_000) break;
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

  // 按 BFS 波次并发：每一波取当前队列里最多 concurrency 个 URL。
  //
  // 不能沿用「N 个 worker 各自 while(queueCursor < queue.length)」的写法：
  // 起始队列只有 1 个 URL，其余 worker 会在 root 还没抓完时立刻退出，
  // 实际并发退化为 1（见 tests/unit/crawler-concurrency.test.ts）。
  const runWorkers = async () => {
    while (queueCursor < queue.length && !truncated) {
      const batch = queue.slice(
        queueCursor,
        queueCursor + Math.max(1, config.concurrency)
      );
      queueCursor += batch.length;
      await Promise.all(
        batch.map(async (item) => {
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
        })
      );
    }
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

  // 并发波次里多个页面可能同时通过限额检查，最后统一裁掉超出部分
  if (pages.length > config.maxPages) {
    pages.length = config.maxPages;
    truncated = true;
    truncateReason = truncateReason ?? "达到最大页面数上限";
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
      // 带上站点问题聚合：opportunity 复检时按 issue.id 判断是否仍存在
      issues: analyzeSiteIssues(result).issues,
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
