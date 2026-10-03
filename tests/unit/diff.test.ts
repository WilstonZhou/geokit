import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { diffObservations, DIFF_ENGINE_VERSION } from "../../src/lib/diff";
import type { Observation } from "../../src/lib/evidence/types";

function sampleObs(overrides: Partial<Observation> = {}): Observation {
  return {
    contractVersion: "0.2.0",
    id: "obs_test",
    identityKey: "key_1",
    versionKey: "v_1",
    type: "ai_mention",
    subject: "ai-slot:deepseek:deepseek-chat",
    source: "provider:deepseek",
    status: "OBSERVED",
    observedAt: "2026-10-01T00:00:00Z",
    observerVersion: "ai-observer@0.1.0",
    parserVersion: "ai-visibility@0.1.0",
    confidence: "high",
    coverage: { expected: 1, observed: 1, ratio: 1 },
    evidenceRefs: ["ev_1"],
    result: { mentioned: true, score: 80, targetRank: 3 },
    metadata: {},
    ...overrides,
  };
}

describe("Diff Engine (Unit Tests)", () => {
  describe("1 可比性前置校验", () => {
    it("不同 type 或不同 subject 绝对不可比", () => {
      const a = sampleObs({ type: "ai_mention", subject: "subj_a" });
      const b = sampleObs({ type: "rank", subject: "subj_a" });
      const diffType = diffObservations(a, b);
      assert.strictEqual(diffType.comparable, false);
      assert.strictEqual(diffType.incomparableReason, "subject_mismatch");

      const c = sampleObs({ type: "ai_mention", subject: "subj_b" });
      const diffSubj = diffObservations(a, c);
      assert.strictEqual(diffSubj.comparable, false);
      assert.strictEqual(diffSubj.incomparableReason, "subject_mismatch");
    });

    it("UNOBSERVABLE → NOT_MENTIONED 属于覆盖度提升，不可比且不可记为退化", () => {
      const a = sampleObs({ status: "UNOBSERVABLE" });
      const b = sampleObs({ status: "NOT_MENTIONED" });
      const diff = diffObservations(a, b);
      assert.strictEqual(diff.comparable, false);
      assert.strictEqual(diff.incomparableReason, "status_not_observed");
      assert.strictEqual(diff.summary.degraded, 0);
      assert.strictEqual(diff.summary.improved, 0);
      assert.ok(diff.summary.unknown > 0);
    });
  });

  describe("2 状态方向判定", () => {
    it("NOT_MENTIONED → MENTIONED 判为 improved", () => {
      const a = sampleObs({ status: "NOT_MENTIONED", result: { mentioned: false } });
      const b = sampleObs({ status: "MENTIONED", result: { mentioned: true } });
      const diff = diffObservations(a, b);
      assert.strictEqual(diff.comparable, true);
      assert.strictEqual(diff.summary.improved, 1);
      assert.strictEqual(diff.summary.degraded, 0);
    });

    it("MENTIONED → NOT_MENTIONED 判为 degraded", () => {
      const a = sampleObs({ status: "MENTIONED", result: { mentioned: true } });
      const b = sampleObs({ status: "NOT_MENTIONED", result: { mentioned: false } });
      const diff = diffObservations(a, b);
      assert.strictEqual(diff.comparable, true);
      assert.strictEqual(diff.summary.degraded, 1);
      assert.strictEqual(diff.summary.improved, 0);
    });
  });

  describe("3 targetRank 排名进出榜单与位次浮动", () => {
    it("从未上榜 (null) 到上榜 (8) 判为 improved", () => {
      const a = sampleObs({ type: "rank", subject: "search:x", result: { targetRank: null } });
      const b = sampleObs({ type: "rank", subject: "search:x", result: { targetRank: 8 } });
      const diff = diffObservations(a, b);
      assert.strictEqual(diff.comparable, true);
      assert.strictEqual(diff.summary.improved, 1);
    });

    it("掉出榜单 (8 → null) 判为 degraded", () => {
      const a = sampleObs({ type: "rank", subject: "search:x", result: { targetRank: 8 } });
      const b = sampleObs({ type: "rank", subject: "search:x", result: { targetRank: null } });
      const diff = diffObservations(a, b);
      assert.strictEqual(diff.comparable, true);
      assert.strictEqual(diff.summary.degraded, 1);
    });

    it("位次下降 (3 → 7) 判为 degraded，位次上升 (25 → 3) 判为 improved", () => {
      const a = sampleObs({ type: "rank", subject: "search:x", result: { targetRank: 3 } });
      const b = sampleObs({ type: "rank", subject: "search:x", result: { targetRank: 7 } });
      const diffDown = diffObservations(a, b);
      assert.strictEqual(diffDown.summary.degraded, 1);

      const c = sampleObs({ type: "rank", subject: "search:x", result: { targetRank: 25 } });
      const diffUp = diffObservations(c, a);
      assert.strictEqual(diffUp.summary.improved, 1);
    });
  });

  describe("4 边界条件与引擎标识", () => {
    it("包含当前引擎版本号", () => {
      const a = sampleObs();
      const diff = diffObservations(a, a);
      assert.strictEqual(diff.diffEngineVersion, DIFF_ENGINE_VERSION);
    });

    it("首次观测或缺失前置结论", () => {
      const curr = sampleObs();
      const diff = diffObservations(null, curr);
      assert.strictEqual(diff.comparable, false);
      assert.strictEqual(diff.incomparableReason, "missing_previous");
      assert.strictEqual(diff.summary.improved, 0);
      assert.strictEqual(diff.summary.degraded, 0);
    });
  });
});
