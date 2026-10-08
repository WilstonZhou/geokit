/**
 * 鲸析 GEOkit — 爬虫 robots.txt 策略层（T3）
 *
 * 与 llms.ts `policyForAgent` 的差异：本模块面向任意 urlPath，
 * 而 llms.ts 的版本只回答「/」根路径的策略（用于 AI 爬虫总览）。
 *
 * 规范遵循 RFC 9309（robots.txt）：
 *   - 最长路径前缀匹配优先
 *   - 同长度时 Allow 胜出 Disallow
 *   - 未命中任何规则 = 默认允许
 */
import { parseRobots, type ParsedRobots } from "../llms";
import type { Fetcher } from "./types";

/**
 * 判断给定 UA 对 urlPath 的最终策略。
 *
 * 返回 `{ allowed, rule }`：rule 为命中的规则原文（如 "Disallow: /private"），
 * 没有命中任何规则时 allowed=true、rule=null。
 *
 * 路径匹配采用前缀匹配：rule.path 为空字符串或 "/" 视为匹配所有路径；
 * 否则 urlPath 必须以 rule.path 开头才算命中。
 */
export function allowedByRobots(
  parsed: ParsedRobots,
  urlPath: string,
  ua: string
): { allowed: boolean; rule: string | null } {
  const target = ua.toLowerCase();
  const path = urlPath || "/";

  const applicable = parsed.groups.filter(
    (g) =>
      g.agents.includes("*") ||
      g.agents.some(
        (a) => target === a || target.includes(a) || a.includes(target)
      )
  );
  if (applicable.length === 0) return { allowed: true, rule: null };

  // 精确组优先于通配组
  const exact = applicable.filter((g) => !g.agents.includes("*"));
  const pool = exact.length > 0 ? exact : applicable;

  let best: { path: string; allow: boolean } | null = null;
  let bestLen = -1;
  for (const g of pool) {
    for (const r of g.rules) {
      // 空路径视为 no-op（"Disallow:" 等于 "不屏蔽任何东西"），
      // 与 llms.ts policyForAgent 的行为一致
      const rulePath = r.path;
      if (!rulePath) continue;
      const matches = rulePath === "/" || path.startsWith(rulePath);
      if (!matches) continue;
      const len = rulePath.length;
      if (len > bestLen || (len === bestLen && r.allow && best && !best.allow)) {
        best = r;
        bestLen = len;
      }
    }
  }
  if (!best) return { allowed: true, rule: null };
  return {
    allowed: best.allow,
    rule: `${best.allow ? "Allow" : "Disallow"}: ${best.path}`,
  };
}

/**
 * 从原始 robots.txt 文本中提取指定 UA 的 Crawl-delay 值。
 *
 * 现有 `parseRobots` 不抽取 Crawl-delay（只处理 User-agent/Allow/Disallow/Sitemap），
 * 这里用单独的正则扫描兜底：找到匹配 UA 的 group，提取首个 Crawl-delay 数字。
 * 没有声明时返回 null。
 *
 * 规范：Crawl-delay 是 group 内字段，对该组的所有 UA 生效。
 * 这里的「匹配 group」逻辑与 allowedByRobots 一致 —— 精确组优先于通配组。
 */
export function crawlDelayFor(rawRobots: string, ua: string): number | null {
  if (!rawRobots) return null;
  const target = ua.toLowerCase();
  const lines = rawRobots.split(/\r?\n/);

  // 第一遍：把 group 切出来，每个 group 记录 agents 与第一个 Crawl-delay
  interface Group {
    agents: string[];
    delay: number | null;
  }
  const groups: Group[] = [];
  let current: Group | null = null;
  let anyHasDelay = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === "user-agent") {
      if (!current) {
        current = { agents: [], delay: null };
        groups.push(current);
      } else if (current.delay !== null || current.agents.length === 0) {
        // 遇到 Crawl-delay 或换组条件 —— 起新组
        // （parseRobots 用 rules.length 触发换组；这里用 delay 字段触发）
        current = { agents: [], delay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (key === "crawl-delay") {
      if (!current) {
        current = { agents: [], delay: null };
        groups.push(current);
      }
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) {
        current.delay = n;
        anyHasDelay = true;
      }
    }
    // 其它字段（Allow/Disallow/Sitemap）忽略 —— 不影响 group 划分判定
  }

  if (!anyHasDelay) return null;

  // 第二遍：找到匹配 UA 的 group —— 精确组优先
  const applicable = groups.filter(
    (g) =>
      g.agents.includes("*") ||
      g.agents.some(
        (a) => target === a || target.includes(a) || a.includes(target)
      )
  );
  if (applicable.length === 0) return null;
  const exact = applicable.filter((g) => !g.agents.includes("*"));
  const pool = exact.length > 0 ? exact : applicable;
  for (const g of pool) {
    if (g.delay !== null) return g.delay;
  }
  return null;
}

/**
 * 抓取并解析 {origin}/robots.txt。
 *
 * 404 或网络错误一律返回 { parsed: null, raw: null, sitemaps: [] } ——
 * 「没有 robots.txt」按规范等于「全允许」，调用方据此跳过策略检查。
 */
export async function fetchAndParseRobots(
  origin: string,
  fetcher: Fetcher,
  opts: { timeoutMs?: number; ua?: string } = {}
): Promise<{ parsed: ParsedRobots | null; raw: string | null; sitemaps: string[] }> {
  const robotsUrl = `${origin.replace(/\/$/, "")}/robots.txt`;
  const ua = opts.ua ?? "GEOkitBot/0.1";
  try {
    const res = await fetcher({
      url: robotsUrl,
      timeoutMs: opts.timeoutMs ?? 10_000,
      headers: { "User-Agent": ua },
      followRedirect: true,
      purpose: "robots",
      target: robotsUrl,
    });
    if (res.status === 404 || !res.ok || res.body === "") {
      return { parsed: null, raw: null, sitemaps: [] };
    }
    const parsed = parseRobots(res.body);
    return { parsed, raw: res.body, sitemaps: parsed.sitemaps };
  } catch {
    return { parsed: null, raw: null, sitemaps: [] };
  }
}
