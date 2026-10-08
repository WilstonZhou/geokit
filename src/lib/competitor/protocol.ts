/**
 * 鲸析 GEOkit — 竞品 AI 抓取协议对比（T8 维度 4）
 *
 * async：复用 analyzeRobots / analyzeLlmsTxt。
 * 若已有预收集的 RobotsAnalysis / LlmsTxtAnalysis 则直接复用；
 * 否则在 fetchProtocol=true 时现场抓取。
 */

import { analyzeRobots, analyzeLlmsTxt, type RobotsAnalysis, type LlmsTxtAnalysis } from "../llms";
import type {
  DimensionComparison,
  ProtocolComparison,
  CompetitorDimensionValue,
  CompetitorEvidence,
  CompetitorStatus,
} from "./types";

/** 从 RobotsAnalysis 提取被封禁的 AI 爬虫名 */
function getBlockedCrawlers(r: RobotsAnalysis): string[] {
  return r.policies
    .filter((p) => p.policy === "blocked")
    .map((p) => p.crawler.name);
}

/** 组装 ProtocolComparison 值 */
function buildValue(
  robots: RobotsAnalysis | undefined,
  llmsTxt: LlmsTxtAnalysis | undefined
): ProtocolComparison | null {
  if (!robots && !llmsTxt) return null;
  return {
    aiOpennessScore: robots?.aiOpennessScore ?? 0,
    hasLlmsTxt: llmsTxt?.exists ?? false,
    llmsTxtScore: llmsTxt?.score ?? 0,
    blockedCrawlers: robots ? getBlockedCrawlers(robots) : [],
  };
}

/** 组装 evidence */
function buildEvidence(
  domain: string,
  robots: RobotsAnalysis | undefined,
  llmsTxt: LlmsTxtAnalysis | undefined
): CompetitorEvidence[] {
  const ev: CompetitorEvidence[] = [];
  if (robots) {
    ev.push({ signal: "protocol.aiOpennessScore", source: `RobotsAnalysis (${domain})`, value: robots.aiOpennessScore });
    if (getBlockedCrawlers(robots).length > 0) {
      ev.push({ signal: "protocol.blockedCrawlers", source: `RobotsAnalysis (${domain})`, value: getBlockedCrawlers(robots).length });
    }
  }
  if (llmsTxt) {
    ev.push({ signal: "protocol.llmsTxtScore", source: `LlmsTxtAnalysis (${domain})`, value: llmsTxt.score });
    ev.push({ signal: "protocol.hasLlmsTxt", source: `LlmsTxtAnalysis (${domain})`, value: llmsTxt.exists ? "yes" : "no" });
  }
  return ev;
}

/** 确定单个主体的 status */
function determineStatus(
  robots: RobotsAnalysis | undefined,
  llmsTxt: LlmsTxtAnalysis | undefined
): CompetitorStatus {
  if (!robots && !llmsTxt) return "unavailable";
  return "available";
}

/** 协议维度 gap（AI 开放度越高越好） */
function determineProtocolGap(
  userScore: number | null,
  compScores: (number | null)[]
): "behind" | "ahead" | "parity" | "incomparable" {
  const validComps = compScores.filter((v): v is number => v !== null);
  if (userScore === null && validComps.length === 0) return "incomparable";
  if (userScore === null) return "behind";
  if (validComps.length === 0) return "ahead";
  if (validComps.some((c) => c > userScore)) return "behind";
  if (validComps.some((c) => c < userScore)) return "ahead";
  return "parity";
}

export async function compareAiCrawlProtocol(
  userDomain: string,
  competitors: string[],
  options: {
    userRobots?: RobotsAnalysis;
    userLlmsTxt?: LlmsTxtAnalysis;
    competitorRobots?: { domain: string; analysis: RobotsAnalysis }[];
    competitorLlmsTxt?: { domain: string; analysis: LlmsTxtAnalysis }[];
    fetchProtocol?: boolean;
  }
): Promise<DimensionComparison<ProtocolComparison>> {
  // 预收集 robots/llms.txt 按 domain 索引
  const preRobots = new Map<string, RobotsAnalysis>();
  for (const cr of options.competitorRobots ?? []) {
    preRobots.set(cr.domain, cr.analysis);
  }
  const preLlmsTxt = new Map<string, LlmsTxtAnalysis>();
  for (const cl of options.competitorLlmsTxt ?? []) {
    preLlmsTxt.set(cl.domain, cl.analysis);
  }

  // 用户 robots/llms.txt
  let userRobots = options.userRobots;
  let userLlmsTxt = options.userLlmsTxt;

  // 现场抓取用户协议数据
  if (options.fetchProtocol) {
    const userTasks: Promise<void>[] = [];
    if (!userRobots) {
      userTasks.push(analyzeRobots(userDomain).then((r) => { userRobots = r; }));
    }
    if (!userLlmsTxt) {
      userTasks.push(analyzeLlmsTxt(userDomain).then((l) => { userLlmsTxt = l; }));
    }
    await Promise.all(userTasks);

    // 现场抓取竞品协议数据（无预收集的）
    const toFetchRobots = competitors.filter((c) => !preRobots.has(c));
    const toFetchLlmsTxt = competitors.filter((c) => !preLlmsTxt.has(c));
    const [robotsResults, llmsTxtResults] = await Promise.all([
      Promise.all(toFetchRobots.map(async (c) => ({ domain: c, analysis: await analyzeRobots(c) }))),
      Promise.all(toFetchLlmsTxt.map(async (c) => ({ domain: c, analysis: await analyzeLlmsTxt(c) }))),
    ]);
    for (const r of robotsResults) preRobots.set(r.domain, r.analysis);
    for (const l of llmsTxtResults) preLlmsTxt.set(l.domain, l.analysis);
  }

  // 用户值
  const userValue = buildValue(userRobots, userLlmsTxt);
  const userStatus = determineStatus(userRobots, userLlmsTxt);
  const userEvidence = buildEvidence(userDomain, userRobots, userLlmsTxt);
  const userScore = userValue?.aiOpennessScore ?? null;

  // 竞品值
  const competitorValues: CompetitorDimensionValue<ProtocolComparison>[] = competitors.map((comp) => {
    const compRobots = preRobots.get(comp);
    const compLlmsTxt = preLlmsTxt.get(comp);
    const value = buildValue(compRobots, compLlmsTxt);
    if (!value) {
      return {
        domain: comp,
        value: null,
        status: "unavailable" as CompetitorStatus,
        evidence: [],
      };
    }
    return {
      domain: comp,
      value,
      status: determineStatus(compRobots, compLlmsTxt),
      evidence: buildEvidence(comp, compRobots, compLlmsTxt),
    };
  });

  const compScores = competitorValues.map((c) =>
    c.value && c.status === "available" ? c.value.aiOpennessScore : null
  );
  const gap = determineProtocolGap(userScore, compScores);

  let summary: string;
  if (gap === "incomparable") {
    summary = "用户与竞品均无协议层数据。";
  } else if (userStatus === "unavailable") {
    summary = "未提供用户协议层数据，无法对比。";
  } else if (gap === "behind") {
    const leaders = competitorValues
      .filter((c) => c.value && (userScore ?? 0) < c.value.aiOpennessScore)
      .map((c) => `${c.domain}(开放度${c.value!.aiOpennessScore})`);
    summary = `用户 AI 开放度 ${userScore}，落后：${leaders.join("、")}`;
  } else if (gap === "ahead") {
    summary = `用户 AI 开放度 ${userScore}，领先全部竞品。`;
  } else {
    summary = `用户 AI 开放度 ${userScore}，与竞品持平。`;
  }

  let gapDetail: string | undefined;
  if (gap === "behind") {
    const details: string[] = [];
    // 封禁的爬虫
    const userBlocked = userValue?.blockedCrawlers ?? [];
    if (userBlocked.length > 0) {
      details.push(`用户封禁了 ${userBlocked.length} 个 AI 爬虫（${userBlocked.slice(0, 3).join("、")}）`);
    }
    // llms.txt 缺失
    if (userValue && !userValue.hasLlmsTxt) {
      const compsWithLlms = competitorValues.filter((c) => c.value?.hasLlmsTxt);
      if (compsWithLlms.length > 0) {
        details.push(`用户无 llms.txt，${compsWithLlms.map((c) => c.domain).join("、")} 已部署`);
      }
    }
    if (details.length > 0) gapDetail = details.join("；");
  }

  return {
    dimension: "protocol",
    userValue,
    userStatus,
    userStatusReason: userStatus === "unavailable" ? "未提供用户协议层数据" : undefined,
    userEvidence,
    competitorValues,
    summary,
    gap,
    gapDetail,
  };
}
