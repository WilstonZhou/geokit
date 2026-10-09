/**
 * 诊断业务服务层 —— 集中管理页面体检、协议层诊断与自动修复。
 *
 * 供 CLI（geokit check）、MCP（diagnose_page / apply_fixes）与 HTTP API 共享，
 * 保证所有通道输出同一套稳定契约与退出码口径。
 */
import { analyze, auditUrl, emptyAudit, type PageAudit, type GeoVersion } from "../audit";
import { analyzeLlmsTxt, analyzeRobots, type LlmsTxtAnalysis, type RobotsAnalysis } from "../llms";
import {
  diagnoseAudit,
  diagnose,
  autoFixable,
  applyFixes,
  buildFixContext,
  type FixAttempt,
  type Diagnosis,
} from "../diagnosis";

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
  geoVersion?: GeoVersion;
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
  geoVersion?: GeoVersion;
}

/**
 * 抓取并检查一个 URL。
 *
 * 抓取失败不抛：走 emptyAudit ⇒ 产出 `fetch/unreachable` 的 blocker 诊断，
 * 由退出码表达。抓不到就是抓不到，不编造一个「还行」的分数。
 */
export async function checkUrl(url: string, opts: CheckOptions = {}): Promise<CheckReport> {
  const audit = await auditUrl(normalizeUrl(url), { geoVersion: opts.geoVersion });

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
    geoVersion: audit.geoVersion,
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
export function checkHtml(
  html: string,
  url: string,
  httpStatus = 200,
  opts?: { geoVersion?: GeoVersion }
): CheckReport {
  return buildCheckReport(analyze(url, html, httpStatus, 0, { geoVersion: opts?.geoVersion }));
}

/** 抓取失败时的报告 —— 唯一的 blocker 来源 */
export function checkFailure(
  url: string,
  error: string,
  opts?: { geoVersion?: GeoVersion }
): CheckReport {
  return buildCheckReport(emptyAudit(url, error, 0, { geoVersion: opts?.geoVersion }));
}

export function exitCodeFor(counts: SeverityCounts): number {
  return counts.blocker > 0 || counts.major > 0 ? 1 : 0;
}

/**
 * 协议层诊断（robots / llms.txt）。
 *
 * 这两类只出诊断、不带 suggestedFix。规则库只收「能自动修」的那五条。
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

/**
 * 对 HTML 执行自动安全修复。
 *
 * 流程：
 *   1. analyze(html) 得到审计结果
 *   2. diagnose(audit) 得到结构化问题
 *   3. 过滤出具有 suggestedFix 的诊断（若指定 fixIds 则进一步缩小范围）
 *   4. applyFixes() 安全、幂等修补 HTML
 */
export function autoFixHtml(
  html: string,
  opts: {
    url?: string;
    fixIds?: string[];
    geoVersion?: GeoVersion;
  } = {}
): {
  html: string;
  changed: boolean;
  attempts: FixAttempt[];
  diagnoses: Diagnosis[];
} {
  const url = opts.url ? normalizeUrl(opts.url) : "https://local.site";
  const audit = analyze(url, html, 200, 0, { geoVersion: opts.geoVersion });
  const diagnoses = diagnose({ audit });
  const ctx = buildFixContext(audit);

  let targetDiagnoses = autoFixable(diagnoses);
  if (opts.fixIds && opts.fixIds.length > 0) {
    const allowed = new Set(opts.fixIds);
    targetDiagnoses = targetDiagnoses.filter((d) => d.suggestedFix && allowed.has(d.suggestedFix));
  }

  const { html: patchedHtml, attempts } = applyFixes(html, targetDiagnoses, ctx);
  const changed = attempts.some((a) => a.changed);

  return {
    html: patchedHtml,
    changed,
    attempts,
    diagnoses,
  };
}

async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

function normalizeUrl(raw: string): string {
  return raw.startsWith("http") ? raw : `https://${raw}`;
}
