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

  describe("5 extractedEvidence 证据对比（T1）", () => {
    const evidenceChanges = (a: Observation, b: Observation) =>
      diffObservations(a, b).changes.filter((c) => c.kind === "EVIDENCE");

    it("无变化：两侧证据完全一致时不产生 EVIDENCE 变更", () => {
      const a = sampleObs({
        extractedEvidence: [{ signal: "jsonld.types", value: ["Article"], source: "html" }],
      });
      const b = sampleObs({
        extractedEvidence: [{ signal: "jsonld.types", value: ["Article"], source: "html" }],
      });
      assert.strictEqual(evidenceChanges(a, b).length, 0);
    });

    it("新增：本次多出的信号记为 previous=null", () => {
      const a = sampleObs({ extractedEvidence: [] });
      const b = sampleObs({
        extractedEvidence: [{ signal: "geo_score", value: 80, source: "audit" }],
      });
      const changes = evidenceChanges(a, b);
      assert.strictEqual(changes.length, 1);
      assert.strictEqual(changes[0].path, "extractedEvidence.geo_score");
      assert.strictEqual(changes[0].previous, null);
      assert.strictEqual(changes[0].current, 80);
    });

    it("删除：前次有、本次无的信号记为 current=null", () => {
      const a = sampleObs({
        extractedEvidence: [{ signal: "robots.GPTBot", value: "blocked", source: "robots_txt" }],
      });
      const b = sampleObs({ extractedEvidence: [] });
      const changes = evidenceChanges(a, b);
      assert.strictEqual(changes.length, 1);
      assert.strictEqual(changes[0].path, "extractedEvidence.robots.GPTBot");
      assert.strictEqual(changes[0].previous, "blocked");
      assert.strictEqual(changes[0].current, null);
    });

    it("修改：同一信号取值变化时前后值都在", () => {
      const a = sampleObs({
        extractedEvidence: [{ signal: "llms.exists", value: false, source: "llms_txt" }],
      });
      const b = sampleObs({
        extractedEvidence: [{ signal: "llms.exists", value: true, source: "llms_txt" }],
      });
      const changes = evidenceChanges(a, b);
      assert.strictEqual(changes.length, 1);
      assert.strictEqual(changes[0].previous, false);
      assert.strictEqual(changes[0].current, true);
    });
  });

  describe("6 scoringVersion 软提示（T9）", () => {
    const geoObs = (overrides: Partial<Observation> = {}): Observation =>
      sampleObs({
        type: "geo_score",
        subject: "site:https://example.com",
        source: "audit",
        observerVersion: "site-observer@0.1.0",
        parserVersion: "audit-checks@1.0.0",
        status: "OBSERVED",
        result: { geoScore: 70, geoVersion: "2.0.0", scoringVersion: "2.0.0" },
        ...overrides,
      });

    it("scoringVersion 不同时保持 comparable 并附加 VERSION caveat", () => {
      const prev = geoObs({ result: { geoScore: 70, geoVersion: "2.0.0", scoringVersion: "2.0.0" } });
      const cur = geoObs({ result: { geoScore: 75, geoVersion: "2.0.0", scoringVersion: "2.1.0" } });
      const diff = diffObservations(prev, cur);
      assert.strictEqual(diff.comparable, true);
      const sv = diff.changes.find((c) => c.path === "result.scoringVersion");
      assert.ok(sv, "应产生 scoringVersion 的 VERSION 变更");
      assert.strictEqual(sv.kind, "VERSION");
      assert.strictEqual(sv.direction, "unknown");
      assert.match(sv.note!, /评分规则版本变化/);
      assert.strictEqual(sv.previous, "2.0.0");
      assert.strictEqual(sv.current, "2.1.0");
    });

    it("历史观测缺 scoringVersion 时按 geoVersion 推断初版规则", () => {
      // T9 之前落库的记录无 scoringVersion 字段，仅有 geoVersion
      const prev = geoObs({ result: { geoScore: 70, geoVersion: "2.0.0" } });
      const cur = geoObs({ result: { geoScore: 75, geoVersion: "2.0.0", scoringVersion: "2.1.0" } });
      const diff = diffObservations(prev, cur);
      assert.strictEqual(diff.comparable, true);
      const sv = diff.changes.find((c) => c.path === "result.scoringVersion");
      assert.ok(sv);
      assert.strictEqual(sv.previous, "2.0.0"); // 推断值
      assert.strictEqual(sv.current, "2.1.0");
    });

    it("scoringVersion 相同时不产生 VERSION 变更", () => {
      const prev = geoObs({ result: { geoScore: 70, geoVersion: "2.0.0", scoringVersion: "2.1.0" } });
      const cur = geoObs({ result: { geoScore: 75, geoVersion: "2.0.0", scoringVersion: "2.1.0" } });
      const diff = diffObservations(prev, cur);
      const sv = diff.changes.find((c) => c.path === "result.scoringVersion");
      assert.strictEqual(sv, undefined);
    });
  });
});
