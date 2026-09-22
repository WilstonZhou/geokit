/**
 * `geokit check <url>`（Phase 2 · S2-2）。
 *
 * 流程：
 *   URL → auditUrl（复用 Fetcher + analyze）→ robots → llms.txt → Diagnosis → 输出
 *
 * ★ 三个「不」：
 *   不重新实现 audit（判断逻辑全在 src/lib/audit.ts）
 *   不跑 Search Observer（CI 里跑搜索 = 主动撞风控）
 *   不跑 AI Observer（成本与随机性都不适合门禁）
 *
 * CI 只跑「不需要外部搜索」的检查 —— 这是 roadmap §十三 的明令，
 * 不是省事：把付费、随机、易触发风控的操作放进每次 PR 都跑的 CI，
 * 结果一定是开发者学会跳过这个检查。
 */
import { analyze, auditUrl, emptyAudit, type PageAudit } from "../../../src/lib/audit";
import { analyzeLlmsTxt, analyzeRobots, type LlmsTxtAnalysis, type RobotsAnalysis } from "../../../src/lib/llms";
import { diagnoseAudit, type Diagnosis } from "../../../src/lib/diagnosis";

/** 自家站红线：这三个被封 = 内容进不了主流 AI 答案 */
export const MUST_ALLOW_CRAWLERS = ["GPTBot", "ClaudeBot", "PerplexityBot"] as const;

export interface SeverityCounts {
  blocker: number;
  major: number;
  minor: number;
}

export interface CheckReport {
  url: string;
  finalUrl: string | null;
  httpStatus: number;
  fetchedAt: string;
  seoScore: number;
  geoScore: number;
  counts: SeverityCounts;
  diagnoses: Diagnosis[];
  robots?: { url: string; exists: boolean; aiOpennessScore: number; summary: string };
  llms?: { url: string; exists: boolean; bytes: number; score: number; issueCount: number };
  /** 有 blocker / major ⇒ 1，否则 0 */
  exitCode: number;
}

export interface CheckOptions {
  /** 跳过 robots / llms.txt（离线或只要页面维度时用） */
  skipProtocolChecks?: boolean;
  fetchedAt?: string;
}

/**
 * 抓取并检查一个 URL。
 *
 * 抓取失败不抛：走 emptyAudit ⇒ 产出 `fetch/unreachable` 的 blocker 诊断，
 * 由退出码表达。**抓不到就是抓不到，不编造一个「还行」的分数。**
 */
export async function checkUrl(url: string, opts: CheckOptions = {}): Promise<CheckReport> {
  const audit = await auditUrl(normalizeUrl(url));

  let robots: RobotsAnalysis | undefined;
  let llms: LlmsTxtAnalysis | undefined;
  if (!opts.skipProtocolChecks) {
    // 协议层抓取失败不影响页面结论 —— 但它们自己必须被如实记录为「没查到」
    robots = await guard(() => analyzeRobots(url));
    llms = await guard(() => analyzeLlmsTxt(url));
  }

  return buildCheckReport(audit, { robots, llms, fetchedAt: opts.fetchedAt });
}

/**
 * 离线构建报告 —— 测试与「已有 HTML 的场景」都走这里。
 *
 * 与 checkUrl 的唯一区别是不抓取：同一份 audit 两次调用必须字节一致，
 * 否则 CI 反复触发就会得到不同结论。
 */
export function buildCheckReport(
  audit: PageAudit,
  extras: {
    robots?: RobotsAnalysis;
    llms?: LlmsTxtAnalysis;
    fetchedAt?: string;
  } = {}
): CheckReport {
  const diagnoses = [...diagnoseAudit(audit), ...diagnoseProtocol(extras.robots, extras.llms, audit.url)];

  const counts: SeverityCounts = { blocker: 0, major: 0, minor: 0 };
  for (const d of diagnoses) counts[d.severity] += 1;

  return {
    url: audit.url,
    finalUrl: audit.finalUrl ?? null,
    httpStatus: audit.httpStatus,
    fetchedAt: extras.fetchedAt ?? new Date().toISOString(),
    seoScore: audit.seoScore,
    geoScore: audit.geoScore,
    counts,
    diagnoses,
    ...(extras.robots
      ? {
          robots: {
            url: extras.robots.url,
            exists: extras.robots.exists,
            aiOpennessScore: extras.robots.aiOpennessScore,
            summary: extras.robots.summary,
          },
        }
      : {}),
    ...(extras.llms
      ? {
          llms: {
            url: extras.llms.url,
            exists: extras.llms.exists,
            bytes: extras.llms.bytes,
            score: extras.llms.score,
            issueCount: extras.llms.issues.filter((i) => i.level !== "pass").length,
          },
        }
      : {}),
    exitCode: exitCodeFor(counts),
  };
}

/** 从 HTML 直接检查（离线） */
export function checkHtml(html: string, url: string, httpStatus = 200): CheckReport {
  return buildCheckReport(analyze(url, html, httpStatus, 0));
}

/** 抓取失败时的报告 —— 唯一的 blocker 来源 */
export function checkFailure(url: string, error: string): CheckReport {
  return buildCheckReport(emptyAudit(url, error, 0));
}

export function exitCodeFor(counts: SeverityCounts): number {
  return counts.blocker > 0 || counts.major > 0 ? 1 : 0;
}

/**
 * 协议层诊断（robots / llms.txt）。
 *
 * ★ 这两类**不进 S2-1 的规则库** —— 它们没有对应的可预测 HTML patch
 *   （改 robots.txt 与 llms.txt 是站级决策，不是往页面里插标签），
 *   因此只出诊断、不带 suggestedFix。规则库只收「能自动修」的那五条。
 */
export function diagnoseProtocol(
  robots: RobotsAnalysis | undefined,
  llms: LlmsTxtAnalysis | undefined,
  url: string
): Diagnosis[] {
  const out: Diagnosis[] = [];

  if (robots) {
    const blocked = robots.policies
      .filter((p) => p.policy === "blocked" && (MUST_ALLOW_CRAWLERS as readonly string[]).includes(p.crawler.ua))
      .map((p) => p.crawler.ua);

    if (blocked.length > 0) {
      out.push({
        issueId: "robots/ai-blocked",
        checkId: "robots-ai",
        targetUrl: url,
        severity: "major",
        detail: `${blocked.join(" / ")} 被 robots.txt 屏蔽 —— 内容进不了这些 AI 的答案`,
        manualFix: `在 robots.txt 中放行 ${blocked.join("、")}（若非有意屏蔽）。`,
      });
    } else if (!robots.exists) {
      out.push({
        issueId: "robots/missing",
        checkId: "robots-ai",
        targetUrl: url,
        severity: "minor",
        detail: "站点根目录没有 robots.txt，AI 爬虫按默认策略抓取",
        manualFix: robots.url ? `补一份 robots.txt（${robots.url}）。` : undefined,
      });
    }
  }

  if (llms) {
    if (!llms.exists) {
      out.push({
        issueId: "llms/missing",
        checkId: "llms",
        targetUrl: url,
        severity: "minor",
        detail: "缺少 llms.txt，AI 无法快速获取站点的权威摘要",
        manualFix: "在站点根目录补 llms.txt（H1 + 摘要 + 分区链接）。",
      });
    } else {
      const fails = llms.issues.filter((i) => i.level === "fail");
      if (fails.length > 0) {
        out.push({
          issueId: "llms/invalid",
          checkId: "llms",
          targetUrl: url,
          severity: "minor",
          detail: `llms.txt 存在但有 ${fails.length} 项不合格：${fails.map((f) => f.label).join("、")}`,
          manualFix: "按 llms.txt 规范补齐标题与摘要区块。",
        });
      }
    }
  }

  return out;
}

async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    // 抓不到协议层文件：如实不报，绝不用「看起来没问题」冒充
    return undefined;
  }
}

function normalizeUrl(raw: string): string {
  return raw.startsWith("http") ? raw : `https://${raw}`;
}
