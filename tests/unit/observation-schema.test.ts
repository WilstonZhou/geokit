import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ObservationSchema,
  CitationRecordSchema,
  validateObservation,
  assertValidObservation,
  STATUSES_REQUIRING_REASON,
} from "../../src/lib/evidence/schema";

/** 合法 Observation 基模（status=OBSERVED，无需 statusReason） */
function validObs(overrides: Record<string, unknown> = {}) {
  return {
    id: "obs_1",
    contractVersion: "0.2.0",
    type: "geo_score",
    subject: "site:https://example.com",
    source: "http:https://example.com",
    observedAt: "2026-10-07T00:00:00Z",
    observerVersion: "site-observer@0.1.0",
    parserVersion: "audit-checks@1.0.0",
    evidenceRefs: ["ev_1"],
    status: "OBSERVED",
    result: { geoScore: 80 },
    confidence: "high",
    coverage: { expected: 11, observed: 11, ratio: 1 },
    metadata: {},
    ...overrides,
  };
}

describe("T1: Observation zod schema", () => {
  it("OBSERVED 无 statusReason 可通过", () => {
    assert.equal(validateObservation(validObs()).ok, true);
  });

  it("ok 无 statusReason 可通过", () => {
    assert.equal(validateObservation(validObs({ status: "ok" })).ok, true);
  });

  for (const s of STATUSES_REQUIRING_REASON) {
    it(`status=${s} 缺 statusReason 必须失败`, () => {
      const r = validateObservation(validObs({ status: s }));
      assert.equal(r.ok, false);
      if (!r.ok) assert.ok(r.error.includes("statusReason"));
    });

    it(`status=${s} 带 statusReason 可通过`, () => {
      const r = validateObservation(validObs({ status: s, statusReason: "HTTP 403" }));
      assert.equal(r.ok, true);
    });
  }

  it("statusReason 为空白字符串视同缺失", () => {
    const r = validateObservation(validObs({ status: "blocked", statusReason: "   " }));
    assert.equal(r.ok, false);
  });

  it("缺失必填字段（subject）报错", () => {
    const o = validObs();
    delete (o as Record<string, unknown>).subject;
    assert.equal(validateObservation(o).ok, false);
  });

  it("confidence 非法值报错", () => {
    assert.equal(validateObservation(validObs({ confidence: "very-high" })).ok, false);
  });

  it("extractedEvidence 结构随 Observation 一并通过", () => {
    const r = validateObservation(
      validObs({
        extractedEvidence: [
          { signal: "jsonld.types", value: ["Article"], source: "html" },
        ],
        data: { geoScore: 80 },
      })
    );
    assert.equal(r.ok, true);
  });

  it("assertValidObservation 对非法输入抛错", () => {
    assert.throws(() => assertValidObservation(validObs({ status: "error" })), /statusReason/);
  });

  it("ObservationSchema 可直接 safeParse", () => {
    assert.equal(ObservationSchema.safeParse(validObs()).success, true);
  });
});

describe("T1: CitationRecord zod schema", () => {
  it("合法记录可解析", () => {
    const r = CitationRecordSchema.safeParse({
      query: "q",
      model: "deepseek",
      answerText: "text",
      mentioned: true,
      mentionContext: "……brand……",
      citations: [{ url: "https://example.com", title: "Ex", position: 3 }],
      citationsStatus: "ok",
      competitorsMentioned: ["comp"],
      observedAt: "2026-10-07T00:00:00Z",
    });
    assert.equal(r.success, true);
  });

  it("mentioned 非布尔报错", () => {
    const r = CitationRecordSchema.safeParse({
      query: "q",
      model: "m",
      answerText: "",
      mentioned: "yes",
      citations: [],
      citationsStatus: "unavailable",
      competitorsMentioned: [],
      observedAt: "",
    });
    assert.equal(r.success, false);
  });
});
