/**
 * 鲸析 GEOkit — AI 抓取协议层（robots AI 策略 + llms.txt）
 *
 * 在 open-seo 的仓库里，"llms.txt" 这个词只出现在 docs/site-audit-pm-research.md
 * 这份产品研究文档里 —— 想法有了，代码是零。GEOkit 把它落成真正能动的功能：
 *   1. 检测 robots.txt 对主流 AI 爬虫的放行/封禁态度
 *   2. 检测并校验 llms.txt
 *   3. 按 llms.txt 规范生成一份可直接上线的草稿
 */

import { stripTags, getTitle, getMeta, getCanonical, findTags, absolutize, getDomain } from "./html";

export interface AiCrawler {
  /** robots.txt 里的 User-agent 值 */
  ua: string;
  name: string;
  vendor: string;
  purpose: "训练" | "检索引用" | "用户代理" | "搜索索引";
  cnRelevant: boolean;
}

/** 2026 年实际在抓取网页的 AI 爬虫清单 */
export const AI_CRAWLERS: AiCrawler[] = [
  { ua: "GPTBot", name: "GPTBot", vendor: "OpenAI", purpose: "训练", cnRelevant: false },
  { ua: "OAI-SearchBot", name: "OAI-SearchBot", vendor: "OpenAI", purpose: "检索引用", cnRelevant: false },
  { ua: "ChatGPT-User", name: "ChatGPT-User", vendor: "OpenAI", purpose: "用户代理", cnRelevant: false },
  { ua: "ClaudeBot", name: "ClaudeBot", vendor: "Anthropic", purpose: "训练", cnRelevant: false },
  { ua: "anthropic-ai", name: "anthropic-ai", vendor: "Anthropic", purpose: "训练", cnRelevant: false },
  { ua: "Claude-User", name: "Claude-User", vendor: "Anthropic", purpose: "用户代理", cnRelevant: false },
  { ua: "PerplexityBot", name: "PerplexityBot", vendor: "Perplexity", purpose: "检索引用", cnRelevant: false },
  { ua: "Google-Extended", name: "Google-Extended", vendor: "Google", purpose: "训练", cnRelevant: false },
  { ua: "Applebot-Extended", name: "Applebot-Extended", vendor: "Apple", purpose: "训练", cnRelevant: false },
  { ua: "CCBot", name: "CCBot", vendor: "Common Crawl", purpose: "训练", cnRelevant: false },
  { ua: "Bytespider", name: "Bytespider", vendor: "字节跳动", purpose: "训练", cnRelevant: true },
  { ua: "Baiduspider", name: "Baiduspider", vendor: "百度", purpose: "搜索索引", cnRelevant: true },
  { ua: "BaiduSpider-render", name: "BaiduSpider-render", vendor: "百度", purpose: "搜索索引", cnRelevant: true },
  { ua: "Sogou web spider", name: "Sogou web spider", vendor: "搜狗", purpose: "搜索索引", cnRelevant: true },
  { ua: "360Spider", name: "360Spider", vendor: "360", purpose: "搜索索引", cnRelevant: true },
  { ua: "Timpibot", name: "Timpibot", vendor: "Timpi", purpose: "搜索索引", cnRelevant: false },
  { ua: "Diffbot", name: "Diffbot", vendor: "Diffbot", purpose: "训练", cnRelevant: false },
  { ua: "YouBot", name: "YouBot", vendor: "You.com", purpose: "检索引用", cnRelevant: false },
  { ua: "meta-externalagent", name: "meta-externalagent", vendor: "Meta", purpose: "训练", cnRelevant: false },
  { ua: "cohere-ai", name: "cohere-ai", vendor: "Cohere", purpose: "训练", cnRelevant: false },
];

export type CrawlerPolicy = "allowed" | "blocked" | "unspecified";

export interface CrawlerPolicyResult {
  crawler: AiCrawler;
  policy: CrawlerPolicy;
  /** 命中的 robots.txt 规则片段 */
  matchedRule: string | null;
  implication: string;
}

export interface RobotsAnalysis {
  url: string;
  exists: boolean;
  raw: string | null;
  sitemaps: string[];
  policies: CrawlerPolicyResult[];
  /** 对 AI 可见性的综合判断 */
  aiOpennessScore: number;
  summary: string;
  recommendations: string[];
}

interface ParsedRobots {
  groups: { agents: string[]; rules: { path: string; allow: boolean }[] }[];
  sitemaps: string[];
}

function parseRobots(txt: string): ParsedRobots {
  const lines = txt.split(/\r?\n/);
  const groups: ParsedRobots["groups"] = [];
  const sitemaps: string[] = [];
  let current: ParsedRobots["groups"][number] | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === "user-agent") {
      if (!current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      } else if (current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (key === "allow" || key === "disallow") {
      if (!current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.rules.push({ path: value, allow: key === "allow" });
    } else if (key === "sitemap") {
      sitemaps.push(value);
    }
  }
  return { groups, sitemaps };
}

/** 判断某 UA 对 "/" 的最终策略。robots 规范：最长匹配优先，同长度 Allow 胜出 */
function policyForAgent(parsed: ParsedRobots, ua: string): { policy: CrawlerPolicy; rule: string | null } {
  const target = ua.toLowerCase();
  const applicable = parsed.groups.filter(
    (g) => g.agents.includes("*") || g.agents.some((a) => target === a || target.includes(a) || a.includes(target))
  );
  if (applicable.length === 0) return { policy: "unspecified", rule: null };

  // 精确组优先于通配组
  const exact = applicable.filter((g) => !g.agents.includes("*"));
  const pool = exact.length > 0 ? exact : applicable;

  let best: { path: string; allow: boolean } | null = null;
  let bestLen = -1;
  for (const g of pool) {
    for (const r of g.rules) {
      if (!r.path || !"/".startsWith(r.path === "" ? "/" : r.path)) continue;
      const len = r.path.length;
      if (len > bestLen || (len === bestLen && r.allow && best && !best.allow)) {
        best = r;
        bestLen = len;
      }
    }
  }
  if (!best) return { policy: "allowed", rule: null };
  return {
    policy: best.allow ? "allowed" : "blocked",
    rule: `${best.allow ? "Allow" : "Disallow"}: ${best.path}`,
  };
}

export async function analyzeRobots(inputUrl: string): Promise<RobotsAnalysis> {
  const base = inputUrl.startsWith("http") ? inputUrl : `https://${inputUrl}`;
  let origin = base;
  let robotsUrl = `${base}/robots.txt`;
  try {
    const u = new URL(base);
    origin = u.origin;
    robotsUrl = `${origin}/robots.txt`;
  } catch {
    return {
      url: robotsUrl, exists: false, raw: null, sitemaps: [], policies: [],
      aiOpennessScore: 0,
      summary: "URL 无法解析，请检查输入。",
      recommendations: [],
    };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  let txt: string | null = null;
  try {
    const res = await fetch(robotsUrl, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "GEOkitBot/0.1 (+https://geokit.dev/bot)" },
    });
    if (res.ok) txt = await res.text();
  } catch {
    // 抓取失败按「不存在」处理，但不谎称有
  } finally {
    clearTimeout(timer);
  }

  if (txt === null) {
    return {
      url: robotsUrl,
      exists: false,
      raw: null,
      sitemaps: [],
      policies: [],
      aiOpennessScore: 0,
      summary: "未找到 robots.txt（或无法抓取）。未显式拦截通常意味着默认放行，但也失去了向 AI 爬虫主动表达姿态的机会。",
      recommendations: [
        "创建 robots.txt 并显式 Allow 主流 AI 检索爬虫（GPTBot、ClaudeBot、PerplexityBot、Bytespider 等）。",
        "同时放置 llms.txt，向 AI 明确推荐你最希望被引用的内容。",
      ],
    };
  }

  const parsed = parseRobots(txt);
  const policies: CrawlerPolicyResult[] = AI_CRAWLERS.map((crawler) => {
    const { policy, rule } = policyForAgent(parsed, crawler.ua);
    return {
      crawler,
      policy,
      matchedRule: rule,
      implication: implicationText(crawler, policy),
    };
  });

  const aiOnly = policies.filter((p) => p.crawler.purpose !== "搜索索引");
  const allowed = aiOnly.filter((p) => p.policy === "allowed").length;
  const blocked = aiOnly.filter((p) => p.policy === "blocked").length;
  const score = aiOnly.length === 0 ? 0 : Math.round((allowed / aiOnly.length) * 100);

  const cnBlocked = policies.filter(
    (p) => p.crawler.cnRelevant && p.policy === "blocked"
  );

  const recommendations: string[] = [];
  if (blocked > 0) {
    recommendations.push(
      `你在 robots.txt 里封禁了 ${blocked} 个 AI 爬虫。若希望品牌出现在 AI 回答中，需要显式放行其中的「检索引用」类爬虫。`
    );
  }
  if (cnBlocked.length > 0) {
    recommendations.push(
      `被拦截的中文相关爬虫：${cnBlocked.map((p) => p.crawler.name).join("、")}。这会直接影响百度/字节系 AI 产品的内容来源。`
    );
  }
  if (parsed.sitemaps.length === 0) {
    recommendations.push("robots.txt 中未声明 Sitemap，建议补充以便爬虫发现最新内容。");
  }
  recommendations.push("生成 llms.txt 并置于站点根目录 —— 这是当前向 AI 表达「优先引用哪些内容」最直接的方式。");

  return {
    url: robotsUrl,
    exists: true,
    raw: txt,
    sitemaps: parsed.sitemaps,
    policies,
    aiOpennessScore: score,
    summary:
      `共检查 ${AI_CRAWLERS.length} 个已知 AI/搜索爬虫：放行 ${policies.filter((p) => p.policy === "allowed").length}、` +
      `封禁 ${blocked}、未指定 ${policies.filter((p) => p.policy === "unspecified").length}。AI 开放度为 ${score}。`,
    recommendations,
  };
}

function implicationText(c: AiCrawler, policy: CrawlerPolicy): string {
  if (policy === "blocked") {
    return c.purpose === "训练"
      ? `被封禁：${c.name} 无法读取内容，其模型不会学到你的信息`
      : `被封禁：${c.name} 无法实时检索你的页面，回答中不会出现你的来源`;
  }
  if (policy === "allowed") {
    return c.purpose === "训练"
      ? `已放行：${c.name} 可将你的内容纳入训练语料`
      : `已放行：${c.name} 可实时引用你的页面作为回答来源`;
  }
  return `未显式指定：${c.name} 通常按默认策略处理（多数实现视为放行）`;
}

/* ------------------------------------------------------------------ */
/* llms.txt                                                            */
/* ------------------------------------------------------------------ */

export interface LlmsTxtAnalysis {
  url: string;
  exists: boolean;
  bytes: number;
  lineCount: number;
  /** 规范要求的 H1 标题 */
  hasTitle: boolean;
  title: string | null;
  hasBlockquoteSummary: boolean;
  /** 解析出的分区数量（## 开头的区块） */
  sections: number;
  /** 链接总数 */
  linkCount: number;
  /** 校验发现的问题 */
  issues: { level: "pass" | "warn" | "fail"; label: string; detail: string }[];
  score: number;
  raw: string | null;
  recommendations: string[];
}

export async function analyzeLlmsTxt(inputUrl: string): Promise<LlmsTxtAnalysis> {
  let robotsBase = inputUrl.startsWith("http") ? inputUrl : `https://${inputUrl}`;
  let url = `${robotsBase}/llms.txt`;
  try {
    const u = new URL(robotsBase);
    url = `${u.origin}/llms.txt`;
  } catch {
    /* 保持原样 */
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  let txt: string | null = null;
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "GEOkitBot/0.1 (+https://geokit.dev/bot)" },
    });
    if (res.ok) txt = await res.text();
  } catch {
    /* ignore */
  } finally {
    clearTimeout(timer);
  }

  if (txt === null) return emptyLlmsTxt(url);
  return analyzeLlmsTxtContent(url, txt);
}

export function analyzeLlmsTxtContent(url: string, txt: string): LlmsTxtAnalysis {
  const lines = txt.split(/\r?\n/);
  const title = (txt.match(/^#\s+(.+)$/m)?.[1] ?? null)?.trim() ?? null;
  const hasBlockquoteSummary = /^>\s*\S/m.test(txt);
  const sections = (txt.match(/^##\s+/gm) ?? []).length;
  const linkCount = (txt.match(/^-\s*\[.+\]\(.+\)/gm) ?? []).length;

  const issues: LlmsTxtAnalysis["issues"] = [];
  const push = (level: "pass" | "warn" | "fail", label: string, detail: string) =>
    issues.push({ level, label, detail });

  push(
    title ? "pass" : "fail",
    "H1 标题",
    title ? `标题为「${title}」` : "llms.txt 规范要求第一行是 # 站点名，缺失会导致解析器跳过该文件"
  );
  push(
    hasBlockquoteSummary ? "pass" : "warn",
    "摘要块",
    hasBlockquoteSummary
      ? "存在 > 引用的站点摘要"
      : "缺少 > 开头的摘要描述，AI 无法快速理解站点定位"
  );
  push(
    sections >= 2 ? "pass" : sections === 1 ? "warn" : "fail",
    "内容分区",
    sections === 0
      ? "没有 ## 分区，全部内容堆在一起不利于 AI 定位"
      : `共 ${sections} 个 ## 分区`
  );
  push(
    linkCount >= 5 ? "pass" : linkCount > 0 ? "warn" : "fail",
    "推荐链接",
    linkCount === 0
      ? "没有任何 - [标题](URL) 形式的推荐链接"
      : `推荐了 ${linkCount} 个链接${linkCount < 5 ? "，建议至少覆盖 5-10 个核心页面" : ""}`
  );
  const bytes = Buffer.byteLength(txt, "utf8");
  push(
    bytes < 100_000 ? "pass" : "warn",
    "文件体积",
    bytes < 100_000
      ? `${(bytes / 1024).toFixed(1)} KB，在合理范围`
      : `${(bytes / 1024).toFixed(1)} KB 偏大，建议拆分到 llms-full.txt`
  );

  const score = Math.round(
    (issues.filter((i) => i.level === "pass").length * 2 +
      issues.filter((i) => i.level === "warn").length * 1) /
      (issues.length * 2) *
      100
  );

  const recommendations: string[] = [];
  if (!title) recommendations.push("首行补 `# 站点名称 —— 一句话定位`。");
  if (!hasBlockquoteSummary) recommendations.push("标题下方用 `>` 补一段 2-4 行的站点摘要，说明你是谁、服务谁。");
  if (sections < 2) recommendations.push("用 ## 划分「核心产品 / 文档 / 案例」等分区，让 AI 按需跳转。");
  if (linkCount < 5) recommendations.push("至少推荐 5-10 个最值得被引用的 URL，并附一句话说明。");
  if (recommendations.length === 0) recommendations.push("llms.txt 结构规范，保持内容与时俱新即可。");

  return {
    url, exists: true, bytes, lineCount: lines.length,
    hasTitle: !!title, title, hasBlockquoteSummary, sections, linkCount,
    issues, score, raw: txt, recommendations,
  };
}

function emptyLlmsTxt(url: string): LlmsTxtAnalysis {
  return {
    url, exists: false, bytes: 0, lineCount: 0,
    hasTitle: false, title: null, hasBlockquoteSummary: false,
    sections: 0, linkCount: 0,
    issues: [
      {
        level: "fail",
        label: "文件存在性",
        detail: "站点根目录未找到 llms.txt。这是 2025 年后新兴的 AI 内容声明标准，目前采用率仍低，先做等于先占位。",
      },
    ],
    score: 0,
    raw: null,
    recommendations: [
      "用 GEOkit 的「生成 llms.txt」功能，从站点导航与 sitemap 自动起草一份初稿。",
      "上线后回到本页复检，确认标题、摘要与推荐链接齐备。",
    ],
  };
}

/**
 * 从任意站点首页 + sitemap 起草 llms.txt。
 * 生成的是「可上线的初稿」，不是凭空编故事 —— 所有链接都来自站点真实解析结果。
 */
export async function generateLlmsTxtDraft(
  siteUrl: string,
  opts: { siteName?: string; description?: string; maxLinks?: number } = {}
): Promise<{ content: string; sources: string[]; warnings: string[] }> {
  const maxLinks = opts.maxLinks ?? 12;
  const warnings: string[] = [];
  const base = siteUrl.startsWith("http") ? siteUrl : `https://${siteUrl}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let html = "";
  try {
    const res = await fetch(base, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 GEOkitBot/0.1",
      },
    });
    html = await res.text();
  } catch (e) {
    return {
      content: `# ${opts.siteName ?? base}\n\n> 生成失败：无法抓取 ${base}（${
        e instanceof Error ? e.message : String(e)
      }）\n`,
      sources: [],
      warnings: ["首页抓取失败，请确认站点可公网访问后再试。"],
    };
  } finally {
    clearTimeout(timer);
  }

  const siteName = opts.siteName ?? getTitle(html) ?? getDomain(base);
  const description =
    opts.description ??
    getMeta(html, "description") ??
    `${siteName} 的官方站点`;

  const candidate = findTags(html, ["a"])
    .map((a) => a.attrs.href)
    .filter(Boolean) as string[];

  const host = getDomain(base);
  const seen = new Set<string>();
  const pages: { url: string; text: string }[] = [];

  for (const href of candidate) {
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) continue;
    const abs = absolutize(href, base);
    if (seen.has(abs)) continue;
    seen.add(abs);
    let sameSite = false;
    try {
      sameSite = getDomain(new URL(abs).hostname) === host;
    } catch {
      continue;
    }
    if (!sameSite) continue;
    const text = stripTags(
      html.slice(
        findTags(html, ["a"]).find((a) => a.attrs.href === href)?.contentStart ?? 0,
        findTags(html, ["a"]).find((a) => a.attrs.href === href)?.contentEnd ?? 0
      ) || href
    );
    pages.push({ url: abs, text: text.slice(0, 40) || new URL(abs).pathname });
    if (pages.length >= maxLinks * 3) break;
  }

  // 目录型页面优先
  const priority = (p: { url: string }) => {
    const path = new URL(p.url).pathname.toLowerCase();
    if (/^\/(docs|documentation|help|guide|blog|product|solution|case|about|faq)/.test(path)) return 0;
    if (path === "/" || path === "") return 1;
    return 2;
  };
  const top = pages.sort((a, b) => priority(a) - priority(b)).slice(0, maxLinks);

  if (top.length < 5) {
    warnings.push(
      `仅从首页解析到 ${top.length} 个站内链接。建议同时提交 sitemap，以获得更完整的链接来源。`
    );
  }

  const lines: string[] = [];
  lines.push(`# ${siteName}`);
  lines.push("");
  lines.push(`> ${description}`);
  lines.push("");
  lines.push(`本文件遵循 llms.txt 规范（https://llmstxt.org），由 GEOkit 自动生成，供 AI 系统了解本站结构。`);
  lines.push("");
  lines.push("## 核心页面");
  lines.push("");
  for (const p of top.slice(0, Math.ceil(top.length / 2))) {
    lines.push(`- [${p.text}](${p.url})`);
  }
  lines.push("");
  lines.push("## 更多资源");
  lines.push("");
  for (const p of top.slice(Math.ceil(top.length / 2))) {
    lines.push(`- [${p.text}](${p.url})`);
  }
  lines.push("");
  lines.push("## 联系方式");
  lines.push("");
  lines.push(`- 站点首页：${base}`);
  const canonicalHome = getCanonical(html);
  if (canonicalHome) lines.push(`- 规范地址：${canonicalHome}`);
  lines.push("");

  return {
    content: lines.join("\n"),
    sources: top.map((p) => p.url),
    warnings,
  };
}
