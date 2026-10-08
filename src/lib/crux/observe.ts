/**
 * CrUX Observer（T11）—— 把 Web Vitals 观测结果落成 kind="performance" 的 Observation。
 *
 * 与其他 Observer 一致：只映射，不采集。
 * CrUX 通道不落 RawEvidence（API 响应可能较大，且含 key）：
 *   - evidenceRefs 留空，可追溯元数据放进 result / extractedEvidence：
 *     target、formFactor、collectionPeriod、各指标 p75 与 category；
 *   - API key 绝不进入 Observation；
 *   - 历史层只存「结论粒度」的评估结果，原始 histogram 不落库。
 */
import type { Store } from "../store";
import type { Observation, ObservationStatus } from "../evidence/types";
import { OBSERVATION_CONTRACT_VERSION, confidenceFor } from "../evidence/types";
import { assertValidObservation } from "../evidence/schema";
import type { CruxObservation } from "./types";
import { METRIC_LABELS } from "./types";

export const CRUX_OBSERVER_VERSION = "crux-observer@0.1.0";
export const CRUX_PARSER_VERSION = "crux-api@0.1.0";

const CRUX_SOURCE = "https://chromeuxreport.googleapis.com";

/** 小写四态 → S1 大写状态 */
function toObservationStatus(status: CruxObservation["status"]): ObservationStatus {
  switch (status) {
    case "ok":
      return "OBSERVED";
    case "blocked":
      return "BLOCKED";
    case "unavailable":
      return "UNOBSERVABLE";
    case "error":
      return "ERROR";
  }
}

export interface PerformanceObservationResult {
  target: string;
  scope: "url" | "origin";
  formFactor?: string;
  collectionPeriod?: { firstDate: string; lastDate: string };
  overallCategory?: "FAST" | "AVERAGE" | "SLOW" | "NONE";
  /** 各指标评估摘要 */
  metrics: {
    metric: string;
    label: string;
    p75: number;
    category: string;
    goodThreshold: number;
    niThreshold: number;
  }[];
}

function buildResult(obs: CruxObservation): PerformanceObservationResult {
  return {
    target: obs.target,
    scope: obs.scope,
    formFactor: obs.formFactor,
    collectionPeriod: obs.collectionPeriod,
    overallCategory: obs.overallCategory,
    metrics: (obs.metrics ?? []).map((m) => ({
      metric: m.metric,
      label: METRIC_LABELS[m.metric] ?? m.metric,
      p75: m.p75,
      category: m.category,
      goodThreshold: m.goodThreshold,
      niThreshold: m.niThreshold,
    })),
  };
}

/** 纯映射：CruxObservation → Observation（不落库、不做 IO） */
export function buildCruxObservation(obs: CruxObservation, now: Date = new Date()): Observation {
  const usable = obs.status === "ok";
  const status = toObservationStatus(obs.status);
  const result = buildResult(obs);

  const observation: Observation = {
    id: `crux:${obs.target}:${now.getTime()}`,
    contractVersion: OBSERVATION_CONTRACT_VERSION,
    type: "performance",
    subject: `crux:${obs.target}`,
    source: CRUX_SOURCE,
    observedAt: now.toISOString(),
    observerVersion: CRUX_OBSERVER_VERSION,
    parserVersion: CRUX_PARSER_VERSION,
    // CrUX 无 RawEvidence 落盘，可追溯信息在 result / extractedEvidence
    evidenceRefs: [],
    status,
    statusReason: obs.statusReason,
    result,
    extractedEvidence: [
      { signal: "crux.target", value: obs.target, source: CRUX_SOURCE },
      { signal: "crux.scope", value: obs.scope, source: CRUX_SOURCE },
      { signal: "crux.formFactor", value: obs.formFactor ?? "all", source: CRUX_SOURCE },
      { signal: "crux.overallCategory", value: obs.overallCategory ?? "NONE", source: CRUX_SOURCE },
      ...(obs.metrics ?? []).map((m) => ({
        signal: `crux.${m.metric}.p75`,
        value: m.p75,
        source: CRUX_SOURCE,
        note: `category=${m.category}`,
      })),
    ],
    confidence: confidenceFor(usable ? 1 : 0, 1),
    coverage: {
      expected: 1,
      observed: usable ? 1 : 0,
      ratio: usable ? 1 : 0,
      missing: usable ? undefined : [obs.target],
    },
    metadata: {
      extra: {
        scope: obs.scope,
        formFactor: obs.formFactor ?? "",
        httpStatus: obs.httpStatus ?? 0,
        collectionPeriod: obs.collectionPeriod
          ? `${obs.collectionPeriod.firstDate}~${obs.collectionPeriod.lastDate}`
          : "",
        note: "数据来自 Chrome UX Report API；API key 不入库",
      },
    },
    caveat:
      "CrUX 数据为 Chrome 真实用户采样（28 天滚动窗口），非实验室单次测量，应作趋势参考。",
  };

  assertValidObservation(observation);
  return observation;
}

/** 落库（受调用方的 GEOKIT_EVIDENCE 总闸控制） */
export async function recordCruxObservation(
  store: Store,
  obs: CruxObservation
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  try {
    const observation = buildCruxObservation(obs);
    const saved = await store.saveObservation(observation);
    return { ok: true, id: saved.id };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
