import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateMetric,
  analyzeCruxObservation,
  queryCrux,
  batchQueryCruxRaw,
  buildCruxObservation,
} from "../../src/lib/crux";
import { genPoorWebVitals } from "../../src/lib/opportunity/generators";
import type { CruxApiResponse } from "../../src/lib/crux";
import type { CruxRawObservation } from "../../src/lib/crux/client";

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

const MOCK_OK_RESPONSE: CruxApiResponse = {
  record: {
    key: { url: "https://example.com/page" },
    metrics: {
      largest_contentful_paint: {
        histogram: [
          { start: 0, end: 2500, density: 0.6 },
          { start: 2500, end: 4000, density: 0.3 },
          { start: 4000, density: 0.1 },
        ],
        percentiles: { p75: 2200 },
      },
      interaction_to_next_paint: {
        histogram: [
          { start: 0, end: 200, density: 0.5 },
          { start: 200, end: 500, density: 0.3 },
          { start: 500, density: 0.2 },
        ],
        percentiles: { p75: 350 },
      },
      cumulative_layout_shift: {
        histogram: [
          { start: 0, end: 0.1, density: 0.8 },
          { start: 0.1, end: 0.25, density: 0.15 },
          { start: 0.25, density: 0.05 },
        ],
        percentiles: { p75: "0.08" },
      },
    },
    collectionPeriod: {
      firstDate: { year: 2026, month: 9, day: 1 },
      lastDate: { year: 2026, month: 9, day: 28 },
    },
  },
};

const MOCK_NO_DATA_RESPONSE: CruxApiResponse = {
  error: {
    code: 404,
    message: "chrome ux report data not found",
    status: "NOT_FOUND",
  },
};

const MOCK_RATE_LIMIT_RESPONSE: CruxApiResponse = {
  error: {
    code: 429,
    message: "Resource exhausted",
    status: "RESOURCE_EXHAUSTED",
  },
};

/* ------------------------------------------------------------------ */
/* 指标评估                                                            */
/* ------------------------------------------------------------------ */

describe("evaluateMetric", () => {
  it("good 指标分类正确", () => {
    const result = evaluateMetric("largest_contentful_paint", {
      histogram: [
        { start: 0, end: 2500, density: 0.8 },
        { start: 2500, end: 4000, density: 0.2 },
      ],
      percentiles: { p75: 2000 },
    });
    assert.strictEqual(result.category, "good");
    assert.strictEqual(result.p75, 2000);
    assert.strictEqual(result.goodThreshold, 2500);
    assert.strictEqual(result.niThreshold, 4000);
  });

  it("needs-improvement 指标分类正确", () => {
    const result = evaluateMetric("interaction_to_next_paint", {
      histogram: [
        { start: 0, end: 200, density: 0.4 },
        { start: 200, end: 500, density: 0.5 },
        { start: 500, density: 0.1 },
      ],
      percentiles: { p75: 350 },
    });
    assert.strictEqual(result.category, "needs-improvement");
  });

  it("poor 指标分类正确", () => {
    const result = evaluateMetric("cumulative_layout_shift", {
      histogram: [
        { start: 0, end: 0.1, density: 0.3 },
        { start: 0.1, end: 0.25, density: 0.3 },
        { start: 0.25, density: 0.4 },
      ],
      percentiles: { p75: 0.3 },
    });
    assert.strictEqual(result.category, "poor");
    assert.strictEqual(result.p75, 0.3);
  });

  it("CLS p75 为字符串时正确解析", () => {
    const result = evaluateMetric("cumulative_layout_shift", {
      histogram: [{ start: 0, end: 0.1, density: 1 }],
      percentiles: { p75: "0.05" },
    });
    assert.strictEqual(result.p75, 0.05);
    assert.strictEqual(result.category, "good");
  });

  it("density 计算正确", () => {
    const result = evaluateMetric("largest_contentful_paint", {
      histogram: [
        { start: 0, end: 2500, density: 0.6 },
        { start: 2500, end: 4000, density: 0.3 },
        { start: 4000, density: 0.1 },
      ],
      percentiles: { p75: 2200 },
    });
    assert.strictEqual(result.goodDensity, 0.6);
    assert.strictEqual(result.niDensity, 0.3);
    assert.strictEqual(result.poorDensity, 0.1);
  });
});

/* ------------------------------------------------------------------ */
/* 观测分析                                                            */
/* ------------------------------------------------------------------ */

describe("analyzeCruxObservation", () => {
  it("ok 状态解析完整指标", () => {
    const raw: CruxRawObservation = {
      target: "https://example.com/page",
      scope: "url",
      formFactor: "DESKTOP",
      observedAt: "2026-10-09T00:00:00Z",
      status: "ok",
      record: MOCK_OK_RESPONSE.record,
    };
    const obs = analyzeCruxObservation(raw);
    assert.strictEqual(obs.status, "ok");
    assert.strictEqual(obs.metrics?.length, 3);
    assert.strictEqual(obs.overallCategory, "AVERAGE"); // INP 为 ni
    assert.ok(obs.collectionPeriod);
    assert.strictEqual(obs.collectionPeriod?.firstDate, "2026-09-01");
  });

  it("unavailable 状态无 metrics", () => {
    const raw: CruxRawObservation = {
      target: "https://example.com/page",
      scope: "url",
      observedAt: "2026-10-09T00:00:00Z",
      status: "unavailable",
      statusReason: "该 URL/源站无 CrUX 数据",
    };
    const obs = analyzeCruxObservation(raw);
    assert.strictEqual(obs.status, "unavailable");
    assert.strictEqual(obs.metrics, undefined);
    assert.strictEqual(obs.overallCategory, undefined);
  });

  it("任一指标为 poor 时整体为 SLOW", () => {
    const raw: CruxRawObservation = {
      target: "https://example.com/page",
      scope: "url",
      observedAt: "2026-10-09T00:00:00Z",
      status: "ok",
      record: {
        ...MOCK_OK_RESPONSE.record!,
        metrics: {
          ...MOCK_OK_RESPONSE.record!.metrics,
          interaction_to_next_paint: {
            histogram: [{ start: 500, density: 1 }],
            percentiles: { p75: 600 }, // poor
          },
        },
      },
    };
    const obs = analyzeCruxObservation(raw);
    assert.strictEqual(obs.overallCategory, "SLOW");
  });
});

/* ------------------------------------------------------------------ */
/* API 客户端                                                          */
/* ------------------------------------------------------------------ */

describe("queryCrux", () => {
  it("无 API key 返回 unavailable", async () => {
    const obs = await queryCrux({ url: "https://example.com" }, { apiKey: undefined });
    assert.strictEqual(obs.status, "unavailable");
    assert.ok(obs.statusReason?.includes("未配置"));
  });

  it("404 NOT_FOUND 映射为 unavailable", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify(MOCK_NO_DATA_RESPONSE), { status: 404 });
    const obs = await queryCrux(
      { url: "https://example.com" },
      { apiKey: "test-key", fetchFn: mockFetch as typeof fetch }
    );
    assert.strictEqual(obs.status, "unavailable");
    assert.ok(obs.statusReason?.includes("无 CrUX 数据"));
    assert.strictEqual(obs.httpStatus, 404);
  });

  it("429 RESOURCE_EXHAUSTED 映射为 blocked", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify(MOCK_RATE_LIMIT_RESPONSE), { status: 429 });
    const obs = await queryCrux(
      { url: "https://example.com" },
      { apiKey: "test-key", fetchFn: mockFetch as typeof fetch }
    );
    assert.strictEqual(obs.status, "blocked");
    assert.ok(obs.statusReason?.includes("速率限制"));
    assert.strictEqual(obs.httpStatus, 429);
  });

  it("403 凭证无效映射为 blocked", async () => {
    const mockFetch = async () =>
      new Response(
        JSON.stringify({ error: { code: 403, message: "invalid key", status: "PERMISSION_DENIED" } }),
        { status: 403 }
      );
    const obs = await queryCrux(
      { url: "https://example.com" },
      { apiKey: "test-key", fetchFn: mockFetch as typeof fetch }
    );
    assert.strictEqual(obs.status, "blocked");
    assert.ok(obs.statusReason?.includes("凭证无效"));
  });

  it("正常响应解析 record", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify(MOCK_OK_RESPONSE), { status: 200 });
    const obs = await queryCrux(
      { url: "https://example.com" },
      { apiKey: "test-key", fetchFn: mockFetch as typeof fetch }
    );
    assert.strictEqual(obs.status, "ok");
    assert.ok(obs.record);
    assert.strictEqual(obs.record?.metrics?.largest_contentful_paint?.percentiles?.p75, 2200);
  });

  it("网络错误映射为 error", async () => {
    const mockFetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const obs = await queryCrux(
      { url: "https://example.com" },
      { apiKey: "test-key", fetchFn: mockFetch as typeof fetch }
    );
    assert.strictEqual(obs.status, "error");
    assert.ok(obs.statusReason?.includes("ECONNREFUSED"));
  });
});

/* ------------------------------------------------------------------ */
/* 批量观测                                                            */
/* ------------------------------------------------------------------ */

describe("batchQueryCruxRaw", () => {
  it("批量串行执行，遇 429 截断", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      if (callCount === 2) {
        return new Response(JSON.stringify(MOCK_RATE_LIMIT_RESPONSE), { status: 429 });
      }
      return new Response(JSON.stringify(MOCK_OK_RESPONSE), { status: 200 });
    };

    const { rawObservations, truncated, truncatedReason } = await batchQueryCruxRaw(
      { urls: ["https://a.com/1", "https://a.com/2", "https://a.com/3"] },
      { apiKey: "test-key", fetchFn: mockFetch as typeof fetch, minIntervalMs: 0 }
    );

    assert.strictEqual(callCount, 2); // 第 2 个触发 429，第 3 个未执行
    assert.strictEqual(rawObservations.length, 2);
    assert.strictEqual(truncated, true);
    assert.ok(truncatedReason?.includes("截断"));
    assert.strictEqual(rawObservations[0].status, "ok");
    assert.strictEqual(rawObservations[1].status, "blocked");
  });

  it("urls 与 origins 混合输入", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify(MOCK_OK_RESPONSE), { status: 200 });

    const { rawObservations } = await batchQueryCruxRaw(
      { urls: ["https://a.com/1"], origins: ["https://b.com"] },
      { apiKey: "test-key", fetchFn: mockFetch as typeof fetch, minIntervalMs: 0 }
    );

    assert.strictEqual(rawObservations.length, 2);
    assert.strictEqual(rawObservations[0].scope, "url");
    assert.strictEqual(rawObservations[1].scope, "origin");
  });
});

/* ------------------------------------------------------------------ */
/* Observation 构建                                                    */
/* ------------------------------------------------------------------ */

describe("buildCruxObservation", () => {
  it("ok 状态构建完整 Observation", () => {
    const raw: CruxRawObservation = {
      target: "https://example.com/page",
      scope: "url",
      formFactor: "DESKTOP",
      observedAt: "2026-10-09T00:00:00Z",
      status: "ok",
      record: MOCK_OK_RESPONSE.record,
    };
    const cruxObs = analyzeCruxObservation(raw);
    const obs = buildCruxObservation(cruxObs);

    assert.strictEqual(obs.type, "performance");
    assert.strictEqual(obs.subject, "crux:https://example.com/page");
    assert.strictEqual(obs.status, "OBSERVED");
    assert.strictEqual(obs.confidence, "high");
    assert.ok(obs.extractedEvidence?.some((e) => e.signal === "crux.largest_contentful_paint.p75"));
    assert.ok(obs.caveat?.includes("28 天"));
  });

  it("unavailable 状态 statusReason 必填", () => {
    const raw: CruxRawObservation = {
      target: "https://example.com",
      scope: "url",
      observedAt: "2026-10-09T00:00:00Z",
      status: "unavailable",
      statusReason: "无数据",
    };
    const cruxObs = analyzeCruxObservation(raw);
    const obs = buildCruxObservation(cruxObs);

    assert.strictEqual(obs.status, "UNOBSERVABLE");
    assert.strictEqual(obs.statusReason, "无数据");
    assert.strictEqual(obs.confidence, "unavailable");
  });
});

/* ------------------------------------------------------------------ */
/* 机会生成                                                            */
/* ------------------------------------------------------------------ */

describe("genPoorWebVitals", () => {
  it("poor 指标触发 high 影响机会", () => {
    const raw: CruxRawObservation = {
      target: "https://example.com/slow",
      scope: "url",
      observedAt: "2026-10-09T00:00:00Z",
      status: "ok",
      record: {
        key: { url: "https://example.com/slow" },
        metrics: {
          largest_contentful_paint: {
            histogram: [{ start: 4000, density: 1 }],
            percentiles: { p75: 5000 }, // poor
          },
        },
        collectionPeriod: MOCK_OK_RESPONSE.record!.collectionPeriod,
      },
    };
    const obs = analyzeCruxObservation(raw);
    const opps = genPoorWebVitals([obs]);

    assert.strictEqual(opps.length, 1);
    assert.strictEqual(opps[0].type, "poor-web-vitals");
    assert.strictEqual(opps[0].impact, "high");
    assert.strictEqual(opps[0].target, "https://example.com/slow");
    assert.ok(opps[0].diagnosis.evidence.some((e) => e.signal === "crux.largest_contentful_paint.p75"));
    assert.ok(opps[0].recommendations.length > 0);
  });

  it("needs-improvement 指标触发 medium 影响机会", () => {
    const raw: CruxRawObservation = {
      target: "https://example.com/medium",
      scope: "url",
      observedAt: "2026-10-09T00:00:00Z",
      status: "ok",
      record: {
        key: { url: "https://example.com/medium" },
        metrics: {
          interaction_to_next_paint: {
            histogram: [{ start: 200, end: 500, density: 1 }],
            percentiles: { p75: 300 }, // ni
          },
        },
        collectionPeriod: MOCK_OK_RESPONSE.record!.collectionPeriod,
      },
    };
    const obs = analyzeCruxObservation(raw);
    const opps = genPoorWebVitals([obs]);

    assert.strictEqual(opps.length, 1);
    assert.strictEqual(opps[0].impact, "medium");
  });

  it("全 good 不生成机会", () => {
    const raw: CruxRawObservation = {
      target: "https://example.com/fast",
      scope: "url",
      observedAt: "2026-10-09T00:00:00Z",
      status: "ok",
      record: {
        key: { url: "https://example.com/fast" },
        metrics: {
          largest_contentful_paint: {
            histogram: [{ start: 0, end: 2500, density: 1 }],
            percentiles: { p75: 1500 },
          },
        },
        collectionPeriod: MOCK_OK_RESPONSE.record!.collectionPeriod,
      },
    };
    const obs = analyzeCruxObservation(raw);
    const opps = genPoorWebVitals([obs]);

    assert.strictEqual(opps.length, 0);
  });

  it("非 ok 状态不生成机会", () => {
    const obs = analyzeCruxObservation({
      target: "https://example.com",
      scope: "url",
      observedAt: "2026-10-09T00:00:00Z",
      status: "unavailable",
      statusReason: "无数据",
    });
    const opps = genPoorWebVitals([obs]);
    assert.strictEqual(opps.length, 0);
  });

  it("空输入返回空数组", () => {
    assert.strictEqual(genPoorWebVitals(undefined).length, 0);
    assert.strictEqual(genPoorWebVitals([]).length, 0);
  });
});
