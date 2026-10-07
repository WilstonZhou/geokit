import type { Observation, ObservationKind, ObservationStatus, ExtractedEvidence } from "../evidence/types";

export function createObservation<T>(
  kind: ObservationKind,
  target: string,
  data: T,
  status: ObservationStatus = "ok",
  statusReason?: string,
  extractedEvidence: ExtractedEvidence[] = []
): Observation<T> {
  return {
    id: crypto.randomUUID(),
    contractVersion: "0.2.0",
    type: kind,
    subject: target,
    target,
    source: "adapter",
    observedAt: new Date().toISOString(),
    observerVersion: "adapter@0.1.0",
    parserVersion: "adapter@0.1.0",
    evidenceRefs: [],
    status,
    statusReason,
    result: data,
    data,
    extractedEvidence,
    confidence: status === "ok" || status === "OBSERVED" ? "high" : "low",
    coverage: { expected: 1, observed: 1, ratio: 1 },
    metadata: {},
  };
}

export function adaptSerp(target: string, result: unknown, status: ObservationStatus = "ok", statusReason?: string) {
  return createObservation("serp", target, result, status, statusReason);
}

export function adaptAudit(target: string, result: unknown, status: ObservationStatus = "ok", statusReason?: string) {
  const extracted: ExtractedEvidence[] = [];
  const r = (typeof result === "object" && result !== null ? result : {}) as {
    jsonLdTypes?: unknown;
    geoScore?: unknown;
  };
  if (r.jsonLdTypes) {
    extracted.push({ signal: "jsonld.types", value: r.jsonLdTypes, source: "html" });
  }
  if (r.geoScore !== undefined) {
    extracted.push({ signal: "geo_score", value: r.geoScore, source: "audit" });
  }
  return createObservation("audit", target, result, status, statusReason, extracted);
}

export function adaptRobots(target: string, result: unknown, status: ObservationStatus = "ok", statusReason?: string) {
  return createObservation("robots", target, result, status, statusReason);
}

export function adaptLlmsTxt(target: string, result: unknown, status: ObservationStatus = "ok", statusReason?: string) {
  return createObservation("llms", target, result, status, statusReason);
}

