/**
 * Protocol Observer —— robots.txt / llms.txt 的观测落库（T1）。
 *
 * 与 observers/site.ts 同构：**不采集、不解析**，只把
 * `robots_txt` / `llms_txt` Evidence + 已算好的分析结果
 * 映射成符合 S1 契约的 Observation。
 *
 *   robots 分析 → kind "robots_policy"
 *   llms.txt 分析 → kind "llms_txt"
 *
 * （serp → rank、audit → geo_score、ai → ai_mention 在 Phase 1 已接线，
 *   这里补齐协议文件这两条通道，不另起第二套观测体系。）
 *
 * ★ 与 site.ts 的状态映射有一处刻意差异：
 *   404/410 对页面来说是「页面不存在」；对 robots.txt / llms.txt 来说，
 *   「文件不存在」本身就是一次有效的观测结论（exists:false），
 *   因此记 OBSERVED 而不是 UNOBSERVABLE —— 结果里已经如实表达。
 */
import type { Store } from "../store";
import type { Evidence, Observation, ObservationStatus } from "../evidence/types";
import { OBSERVATION_CONTRACT_VERSION, confidenceFor } from "../evidence/types";
import { assertValidObservation } from "../evidence/schema";
import type { RobotsAnalysis, LlmsTxtAnalysis } from "../llms";

export const PROTOCOL_OBSERVER_VERSION = "protocol-observer@0.1.0";
export const ROBOTS_PARSER_VERSION = "robots-analysis@1.0.0";
export const LLMS_PARSER_VERSION = "llms-analysis@1.0.0";

type ProtocolResult = { ok: true; id: string } | { ok: false; reason: string };

/**
 * HTTP 事实 → ObservationStatus。
 * 404/410 记 OBSERVED：「文件不存在」是真实结论，不是故障。
 */
function statusFor(ev: Evidence): { status: ObservationStatus; statusReason?: string } {
  const s = ev.status;
  if (s === 0) {
    return {
      status: "UNOBSERVABLE",
      statusReason: `未取得响应（${ev.error?.kind ?? "network"}）：${ev.error?.message ?? "目标不可达"}`,
    };
  }
  if (s === 401 || s === 403 || s === 429) {
    return { status: "BLOCKED", statusReason: `目标拒绝访问（HTTP ${s}）—— 被拦截不等于文件不存在` };
  }
  if (s >= 500) {
    return { status: "ERROR", statusReason: `服务端返回 HTTP ${s}，本次观测不可用` };
  }
  return { status: "OBSERVED" };
}

async function record(
  store: Store,
  evidence: Evidence,
  args: {
    type: "robots_policy" | "llms_txt";
    parserVersion: string;
    result: RobotsAnalysis | LlmsTxtAnalysis;
    extractedEvidence: { signal: string; value: unknown; source: string; note?: string }[];
  }
): Promise<ProtocolResult> {
  const { status, statusReason } = statusFor(evidence);
  const usable = status === "OBSERVED";

  const observation: Observation = {
    id: "",
    contractVersion: OBSERVATION_CONTRACT_VERSION,
    type: args.type,
    subject: evidence.subject,
    source: evidence.source,
    observedAt: evidence.observedAt,
    observerVersion: PROTOCOL_OBSERVER_VERSION,
    parserVersion: args.parserVersion,
    evidenceRefs: [evidence.id],
    status,
    statusReason,
    result: args.result,
    extractedEvidence: args.extractedEvidence,
    confidence: confidenceFor(usable ? 1 : 0, 1),
    coverage: { expected: 1, observed: usable ? 1 : 0, ratio: usable ? 1 : 0 },
    metadata: { extra: { httpStatus: evidence.status } },
  };

  try {
    // ★ schema 层强制校验：失败状态没有原因的结论不允许落库
    assertValidObservation(observation);
    const saved = await store.saveObservation(observation);
    return { ok: true, id: saved.id };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

/** robots.txt 分析 → robots_policy Observation */
export function recordRobotsObservation(
  store: Store,
  evidence: Evidence,
  analysis: RobotsAnalysis
): Promise<ProtocolResult> {
  const blockedCrawlers = analysis.policies
    .filter((p) => p.policy === "blocked")
    .map((p) => p.crawler.name);
  return record(store, evidence, {
    type: "robots_policy",
    parserVersion: ROBOTS_PARSER_VERSION,
    result: analysis,
    extractedEvidence: [
      { signal: "robots.aiOpennessScore", value: analysis.aiOpennessScore, source: "robots_txt" },
      { signal: "robots.blockedAiCrawlers", value: blockedCrawlers, source: "robots_txt" },
      { signal: "robots.sitemaps", value: analysis.sitemaps, source: "robots_txt" },
    ],
  });
}

/** llms.txt 分析 → llms_txt Observation */
export function recordLlmsTxtObservation(
  store: Store,
  evidence: Evidence,
  analysis: LlmsTxtAnalysis
): Promise<ProtocolResult> {
  return record(store, evidence, {
    type: "llms_txt",
    parserVersion: LLMS_PARSER_VERSION,
    result: analysis,
    extractedEvidence: [
      { signal: "llms.exists", value: analysis.exists, source: "llms_txt" },
      { signal: "llms.score", value: analysis.score, source: "llms_txt" },
      { signal: "llms.sections", value: analysis.sections, source: "llms_txt" },
    ],
  });
}
