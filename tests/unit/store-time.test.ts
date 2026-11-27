import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonlStore } from "../../src/lib/store/jsonl";
import type { Observation } from "../../src/lib/evidence/types";

function obs(id: string, observedAt: string): Observation {
  return {
    id,
    contractVersion: "0.2.0",
    type: "geo_score",
    subject: "site:https://example.com",
    source: "http:https://example.com",
    observedAt,
    observerVersion: "site-observer@0.1.0",
    parserVersion: "audit@0.1.0",
    evidenceRefs: ["ev_1"],
    status: "OBSERVED",
    result: { geoScore: 50 },
    confidence: "high",
    coverage: { expected: 1, observed: 1, ratio: 1 },
    metadata: {},
  };
}

describe("Store 时间排序按真实时刻而不是字符串", () => {
  it("带时区偏移的 observedAt 与 Z 时间按时间线排序", async () => {
    const dir = mkdtempSync(join(tmpdir(), "geokit-store-time-"));
    try {
      const store = new JsonlStore(dir);
      // +09:00 的 10:00 = UTC 01:00；Z 的 02:00 更晚
      await store.saveObservation(obs("obs_a", "2026-01-01T10:00:00+09:00"));
      await store.saveObservation(obs("obs_b", "2026-01-01T02:00:00Z"));

      const desc = await store.listObservations({ order: "desc" });
      assert.deepEqual(
        desc.map((o) => o.id),
        ["obs_b", "obs_a"]
      );
      // 写入时统一规范化成 UTC ISO
      assert.equal(desc[0]!.observedAt, "2026-01-01T02:00:00.000Z");
      assert.equal(desc[1]!.observedAt, "2026-01-01T01:00:00.000Z");

      const filtered = await store.listObservations({
        from: "2026-01-01T01:30:00Z", // 介于 01:00 与 02:00 之间 → 只剩 obs_b
        order: "asc",
      });
      assert.deepEqual(
        filtered.map((o) => o.id),
        ["obs_b"]
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
