/**
 * T5 Search Analytics 客户端集成 —— 假 HTTP + 假令牌，覆盖成功/分页/空数据/
 * 401/403/429/5xx/网络异常/未配置凭证，全程不触网、不读真实凭证。
 */
import { describe, test } from "node:test";
import * as assert from "node:assert";

import { querySearchAnalytics } from "../../src/lib/gsc/client";
import type { GscHttp, GscHttpResponse, TokenProvider } from "../../src/lib/gsc/auth";
import type { GscRow } from "../../src/lib/gsc/types";

const fakeProvider: TokenProvider = {
  getToken: async () => "fake-access-token",
  describe: () => "test",
};

interface Call {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

function makeHttp(
  handler: (url: string, body: Record<string, unknown>, call: Call) => {
    status: number;
    payload?: unknown;
    throwError?: string;
  }
): { http: GscHttp; calls: Call[] } {
  const calls: Call[] = [];
  const http: GscHttp = async (url, init) => {
    const call: Call = { url, init };
    calls.push(call);
    const parsedBody = JSON.parse(init.body) as Record<string, unknown>;
    const r = handler(url, parsedBody, call);
    if (r.throwError) throw new Error(r.throwError);
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      json: async () => r.payload,
    } as GscHttpResponse;
  };
  return { http, calls };
}

function gscRow(query: string, impressions: number): GscRow {
  return { keys: [query], clicks: 1, impressions, ctr: 0.01, position: 5 };
}

const baseParams = {
  siteUrl: "sc-domain:example.com",
  startDate: "2026-09-01",
  endDate: "2026-09-28",
};

describe("T5 querySearchAnalytics", () => {
  test("成功：带 Bearer、资源被 URL 编码、维度与行数如实返回", async () => {
    const { http, calls } = makeHttp(() => ({
      status: 200,
      payload: { rows: [gscRow("词A", 100), gscRow("词B", 50)] },
    }));
    const r = await querySearchAnalytics(
      { ...baseParams, dimensions: ["query"], rowLimit: 1000 },
      { http, tokenProvider: fakeProvider }
    );

    assert.equal(r.status, "ok");
    assert.equal(r.rowCount, 2);
    assert.equal(r.dimensions?.[0], "query");
    // sc-domain:example.com 的冒号必须编码
    assert.ok(calls[0].url.includes(encodeURIComponent("sc-domain:example.com")));
    assert.equal(calls[0].init.headers.Authorization, "Bearer fake-access-token");
    // 令牌不应出现在 URL
    assert.ok(!calls[0].url.includes("fake-access-token"));
  });

  test("分页：满页后继续拉下一页，startRow 递增", async () => {
    const { http, calls } = makeHttp((_url, body) => {
      if ((body.startRow as number) === 0) {
        return { status: 200, payload: { rows: [gscRow("a", 1), gscRow("b", 2)] } };
      }
      return { status: 200, payload: { rows: [gscRow("c", 3)] } }; // 不足一页 → 结束
    });
    const r = await querySearchAnalytics(
      { ...baseParams, rowLimit: 2 },
      { http, tokenProvider: fakeProvider }
    );
    assert.equal(r.status, "ok");
    assert.equal(r.rowCount, 3);
    assert.equal(calls.length, 2);
    assert.equal(JSON.parse(calls[1].init.body).startRow, 2);
  });

  test("空数据：API 返回无 rows → ok 且明示该区间无数据", async () => {
    const { http } = makeHttp(() => ({ status: 200, payload: {} }));
    const r = await querySearchAnalytics(baseParams, {
      http,
      tokenProvider: fakeProvider,
    });
    assert.equal(r.status, "ok");
    assert.equal(r.rows.length, 0);
    assert.ok(r.statusReason?.includes("没有数据"));
  });

  const errorCases: [number, "blocked" | "error", number][] = [
    [401, "blocked", 401],
    [403, "blocked", 403],
    [429, "blocked", 429],
    [500, "error", 500],
    [503, "error", 503],
  ];
  for (const [httpStatus, expected, code] of errorCases) {
    test(`HTTP ${httpStatus} → ${expected} 且带状态码与原因`, async () => {
      const { http } = makeHttp(() => ({ status: httpStatus, payload: {} }));
      const r = await querySearchAnalytics(baseParams, {
        http,
        tokenProvider: fakeProvider,
      });
      assert.equal(r.status, expected);
      assert.equal(r.httpStatus, code);
      assert.ok(r.statusReason && r.statusReason.length > 0);
    });
  }

  test("网络异常 → error，不抛出", async () => {
    const { http } = makeHttp(() => ({ status: 0, throwError: "network down" }));
    const r = await querySearchAnalytics(baseParams, {
      http,
      tokenProvider: fakeProvider,
    });
    assert.equal(r.status, "error");
    assert.ok(r.statusReason?.includes("网络失败"));
  });

  test("取令牌失败 → blocked", async () => {
    const { http } = makeHttp(() => ({ status: 200, payload: { rows: [] } }));
    const badProvider: TokenProvider = {
      getToken: async () => {
        throw new Error("HTTP 401");
      },
      describe: () => "test",
    };
    const r = await querySearchAnalytics(baseParams, {
      http,
      tokenProvider: badProvider,
    });
    assert.equal(r.status, "blocked");
    assert.ok(r.statusReason?.includes("访问令牌"));
  });

  test("非法日期 / 空 siteUrl → error 且不发请求", async () => {
    const { http, calls } = makeHttp(() => ({ status: 200, payload: {} }));
    const r1 = await querySearchAnalytics(
      { ...baseParams, startDate: "2026/09/01" },
      { http, tokenProvider: fakeProvider }
    );
    const r2 = await querySearchAnalytics(
      { ...baseParams, siteUrl: "  " },
      { http, tokenProvider: fakeProvider }
    );
    assert.equal(r1.status, "error");
    assert.equal(r2.status, "error");
    assert.equal(calls.length, 0);
  });

  test("未配置任何凭证 → unavailable 并说明配置方式（不触网）", async () => {
    const keys = [
      "GOOGLE_OAUTH_ACCESS_TOKEN",
      "GOOGLE_SERVICE_ACCOUNT_JSON",
      "GOOGLE_APPLICATION_CREDENTIALS",
    ];
    const saved = keys.map((k) => [k, process.env[k]] as const);
    for (const [k] of saved) delete process.env[k];
    try {
      const { http, calls } = makeHttp(() => ({ status: 200, payload: {} }));
      const r = await querySearchAnalytics(baseParams, { http });
      assert.equal(r.status, "unavailable");
      assert.ok(r.statusReason?.includes("GOOGLE_OAUTH_ACCESS_TOKEN"));
      assert.equal(calls.length, 0);
    } finally {
      for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
    }
  });
});
