/**
 * T5 GSC 机会分析 —— 纯函数，四类信号命中/不命中。
 */
import { describe, test } from "node:test";
import * as assert from "node:assert";

import {
  findHighImpressionLowCtr,
  findRankingOpportunities,
  findContentGaps,
  analyzeSearchOpportunities,
  diffPeriods,
  HIGH_IMPRESSION_MIN,
  LOW_CTR_THRESHOLD,
  RANKING_POSITION_MIN,
  RANKING_POSITION_MAX,
} from "../../src/lib/gsc/analyze";
import type { GscRow } from "../../src/lib/gsc/types";

function row(
  keys: string[],
  opts: Partial<Pick<GscRow, "clicks" | "impressions" | "ctr" | "position">> = {}
): GscRow {
  return {
    keys,
    clicks: opts.clicks ?? 0,
    impressions: opts.impressions ?? 0,
    ctr: opts.ctr ?? 0,
    position: opts.position ?? 10,
  };
}

describe("T5 高曝光低 CTR", () => {
  test("命中：高曝光且 CTR 低于阈值，证据带阈值与实际值", () => {
    const r = row(["便宜机票"], {
      impressions: 500,
      clicks: 5,
      ctr: 0.01,
      position: 8,
    });
    const out = findHighImpressionLowCtr([r]);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "high-impression-low-ctr");
    assert.equal(out[0].key, "便宜机票");
    assert.ok(out[0].evidence.some((e) => e.includes(String(500))));
    assert.ok(out[0].evidence.some((e) => e.includes("1.00%")));
  });

  test("不命中：曝光不足阈值不报（小样本不结论）", () => {
    const r = row(["小众词"], { impressions: HIGH_IMPRESSION_MIN - 1, ctr: 0.005 });
    assert.equal(findHighImpressionLowCtr([r]).length, 0);
  });

  test("不命中：高曝光但 CTR 达标不报", () => {
    const r = row(["正常词"], { impressions: 500, ctr: LOW_CTR_THRESHOLD + 0.03 });
    assert.equal(findHighImpressionLowCtr([r]).length, 0);
  });
});

describe("T5 排名机会位", () => {
  test(`命中：位置在 ${RANKING_POSITION_MIN}–${RANKING_POSITION_MAX} 且曝光足够`, () => {
    const r = row(["机会词"], { position: 11, impressions: 120 });
    const out = findRankingOpportunities([r]);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "ranking-opportunity");
  });

  test("不命中：已进前 3 不报", () => {
    assert.equal(
      findRankingOpportunities([row(["前列词"], { position: 2, impressions: 120 })]).length,
      0
    );
  });

  test("不命中：位置超过 20（太靠后）或曝光不足不报", () => {
    assert.equal(
      findRankingOpportunities([row(["靠后词"], { position: 25, impressions: 120 })]).length,
      0
    );
    assert.equal(
      findRankingOpportunities([row(["低曝光"], { position: 10, impressions: 10 })]).length,
      0
    );
  });
});

describe("T5 内容缺口", () => {
  test("命中：GSC 有曝光的 URL 不在爬取集合", () => {
    const rows = [row(["https://example.com/missing-page"], { impressions: 90, clicks: 3 })];
    const out = findContentGaps(rows, ["https://example.com/"]);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "content-gap");
  });

  test("不命中：URL 在爬取集合（容忍尾斜杠与 host 大小写，路径大小写保留）", () => {
    const rows = [row(["https://Example.com/Guide/"], { impressions: 90 })];
    const out = findContentGaps(rows, [
      "https://example.com/Guide", // 去尾斜杠 + 小写 host 后匹配；路径 Guide 大小写保持
    ]);
    assert.equal(out.length, 0);
  });

  test("不命中：零曝光行不产生缺口", () => {
    const rows = [row(["https://example.com/x"], { impressions: 0 })];
    assert.equal(findContentGaps(rows, []).length, 0);
  });
});

describe("T5 汇总分析", () => {
  test("analyzeSearchOpportunities 聚合三类并计数；无 crawledUrls 时不含缺口", () => {
    const rows = [
      row(["低CTR词"], { impressions: 500, ctr: 0.01, position: 30 }),
      row(["机会词"], { position: 10, impressions: 100, ctr: 0.05 }),
    ];
    const a = analyzeSearchOpportunities(rows);
    assert.equal(a.opportunities.length, 2);
    assert.equal(a.counts["high-impression-low-ctr"], 1);
    assert.equal(a.counts["ranking-opportunity"], 1);
    assert.equal(a.counts["content-gap"], 0);
  });
});

describe("T5 周期 diff", () => {
  test("排名显著上升（位置数字变小）进 improved", () => {
    const diff = diffPeriods(
      [row(["词A"], { clicks: 10, impressions: 100, position: 18 })],
      [row(["词A"], { clicks: 12, impressions: 110, position: 8 })]
    );
    assert.equal(diff.improved.length, 1);
    assert.equal(diff.improved[0].key, "词A");
    assert.equal(diff.declined.length, 0);
  });

  test("点击显著下滑进 declined", () => {
    const diff = diffPeriods(
      [row(["词B"], { clicks: 50, impressions: 400, position: 5 })],
      [row(["词B"], { clicks: 20, impressions: 380, position: 6 })]
    );
    assert.equal(diff.declined.length, 1);
    assert.ok(diff.declined[0].clicksDelta <= -10);
  });

  test("新增/消失的 key 分别计入 newKeys/lostKeys", () => {
    const diff = diffPeriods(
      [row(["旧词"])],
      [row(["旧词"], { impressions: 5 }), row(["新词"], { impressions: 5 })]
    );
    assert.deepEqual(diff.newKeys, ["新词"]);
    assert.deepEqual(diff.lostKeys, []);
  });

  test("两期曝光都很低时不判显著变化（降噪）", () => {
    const diff = diffPeriods(
      [row(["微词"], { clicks: 0, impressions: 2, position: 20 })],
      [row(["微词"], { clicks: 0, impressions: 3, position: 2 })]
    );
    assert.equal(diff.improved.length, 0);
    assert.equal(diff.declined.length, 0);
  });
});
