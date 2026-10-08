/**
 * GSC 机会分析（T5）—— 全部纯函数，输入 GscRow[]，输出带证据的机会。
 *
 * 四类信号（阈值均为导出常量，规则透明、测试直接断言）：
 *   1. 高曝光低 CTR：有展示没人点 —— title/description 与搜索意图错配；
 *   2. 排名机会位：排 4–20 名且有曝光 —— 小幅提升就能进首屏/前列；
 *   3. 内容缺口：GSC 显示某 URL 有曝光，但站内爬取结果里没有该页；
 *   4. 周期 diff：两期 clicks/impressions/position 的升降与新增/消失。
 *
 * 位置（position）越小越好：positionDelta 为负 = 排名上升。
 */
import type {
  GscRow,
  GscOpportunity,
  OpportunityKind,
  PeriodDiff,
  PeriodDiffEntry,
} from "./types";

/** 高曝光门槛：低于该展示量不评判 CTR（样本太小，结论不稳） */
export const HIGH_IMPRESSION_MIN = 100;
/** 低 CTR 门槛（2%）：高于该曝光却低于此点进率 → 标题/摘要吸引力问题 */
export const LOW_CTR_THRESHOLD = 0.02;
/** 排名机会位区间（含端点，Google 位置从 1 开始） */
export const RANKING_POSITION_MIN = 4;
export const RANKING_POSITION_MAX = 20;
/** 进入排名机会判断所需的最小曝光 */
export const RANKING_IMPRESSION_MIN = 50;
/** diff：评估显著变化所需的最小曝光，过滤噪声 */
export const DIFF_MIN_IMPRESSIONS = 20;
/** diff：排名变化超过该名次数才算显著（position 数字变化的绝对值） */
export const DIFF_POSITION_STEP = 3;
/** diff：点击变化超过该绝对值才算显著 */
export const DIFF_CLICK_STEP = 10;

export interface OpportunityAnalysis {
  opportunities: GscOpportunity[];
  /** 各类机会计数，便于概览 */
  counts: Record<OpportunityKind, number>;
}

function rowKey(row: GscRow): string {
  return row.keys.join(" | ");
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

/* 1. 高曝光低 CTR --------------------------------------------------- */

export function findHighImpressionLowCtr(rows: GscRow[]): GscOpportunity[] {
  return rows
    .filter(
      (r) =>
        r.impressions >= HIGH_IMPRESSION_MIN && r.ctr < LOW_CTR_THRESHOLD
    )
    .map((r) => ({
      kind: "high-impression-low-ctr" as const,
      key: rowKey(r),
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: r.position,
      evidence: [
        `展示量 ${r.impressions} ≥ ${HIGH_IMPRESSION_MIN}`,
        `CTR ${pct(r.ctr)} < ${pct(LOW_CTR_THRESHOLD)}`,
        `平均排名 ${r.position.toFixed(1)}`,
      ],
      suggestion:
        "优化该词对应页面的 title 与 meta description，让其更贴合搜索意图并体现差异化卖点。",
    }));
}

/* 2. 排名机会位（4–20 名）------------------------------------------- */

export function findRankingOpportunities(rows: GscRow[]): GscOpportunity[] {
  return rows
    .filter(
      (r) =>
        r.position >= RANKING_POSITION_MIN &&
        r.position <= RANKING_POSITION_MAX &&
        r.impressions >= RANKING_IMPRESSION_MIN
    )
    .map((r) => ({
      kind: "ranking-opportunity" as const,
      key: rowKey(r),
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: r.position,
      evidence: [
        `平均排名 ${r.position.toFixed(1)} 落在机会位 ${RANKING_POSITION_MIN}–${RANKING_POSITION_MAX}`,
        `展示量 ${r.impressions} ≥ ${RANKING_IMPRESSION_MIN}`,
        `当前 CTR ${pct(r.ctr)}`,
      ],
      suggestion:
        "该词已接近首屏，针对它补强内容深度与内链，通常用较小代价即可进入前列。",
    }));
}

/* 3. 内容缺口（与爬取结果交叉）--------------------------------------- */

/** 归一化用于集合匹配：小写 host、去 hash、去尾部斜杠；非法 URL 原样返回 */
function normalizeForGap(raw: string): string {
  try {
    const u = new URL(raw);
    let path = u.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return `${u.protocol}//${u.host.toLowerCase()}${path}`;
  } catch {
    return raw.trim();
  }
}

/**
 * 找出「GSC 有曝光、但站内爬取集合里不存在」的页面。
 * 约定 rows 的 keys[0] 是 page URL（查询时 dimensions 含 "page"）。
 */
export function findContentGaps(
  rows: GscRow[],
  crawledUrls: string[]
): GscOpportunity[] {
  const crawled = new Set(crawledUrls.map(normalizeForGap));
  return rows
    .filter((r) => r.keys.length > 0 && r.impressions > 0)
    .filter((r) => !crawled.has(normalizeForGap(r.keys[0])))
    .map((r) => ({
      kind: "content-gap" as const,
      key: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: r.position,
      evidence: [
        "该 URL 在 GSC 有曝光，但不在本次站点爬取结果中",
        `展示量 ${r.impressions}、点击 ${r.clicks}、平均排名 ${r.position.toFixed(1)}`,
      ],
      suggestion:
        "确认该页是否应存在：已删除则做 301/恢复内容；被 robots/noindex 阻挡则放开；参数页则评估 canonical 或收录策略。",
    }));
}

/* 汇总入口 ---------------------------------------------------------- */

export function analyzeSearchOpportunities(
  rows: GscRow[],
  opts: { crawledUrls?: string[] } = {}
): OpportunityAnalysis {
  const opportunities = [
    ...findHighImpressionLowCtr(rows),
    ...findRankingOpportunities(rows),
    ...(opts.crawledUrls ? findContentGaps(rows, opts.crawledUrls) : []),
  ];
  const counts: Record<OpportunityKind, number> = {
    "high-impression-low-ctr": 0,
    "ranking-opportunity": 0,
    "content-gap": 0,
  };
  for (const o of opportunities) counts[o.kind]++;
  return { opportunities, counts };
}

/* 4. 周期 diff ------------------------------------------------------- */

function indexRows(rows: GscRow[]): Map<string, GscRow> {
  return new Map(rows.map((r) => [rowKey(r), r]));
}

/**
 * 对比两期数据。prev 上一期、cur 本期；匹配键为完整维度组合。
 * 位置下降（数字变大）且超阈值记为 declined，反之 improved。
 */
export function diffPeriods(prevRows: GscRow[], curRows: GscRow[]): PeriodDiff {
  const prev = indexRows(prevRows);
  const cur = indexRows(curRows);
  const improved: PeriodDiffEntry[] = [];
  const declined: PeriodDiffEntry[] = [];

  for (const [key, c] of cur) {
    const p = prev.get(key);
    if (!p) continue;
    const entry: PeriodDiffEntry = {
      key,
      clicksDelta: c.clicks - p.clicks,
      impressionsDelta: c.impressions - p.impressions,
      positionDelta: c.position - p.position,
      prev: { clicks: p.clicks, impressions: p.impressions, position: p.position },
      cur: { clicks: c.clicks, impressions: c.impressions, position: c.position },
    };

    // 样本太小不判显著
    if (c.impressions < DIFF_MIN_IMPRESSIONS && p.impressions < DIFF_MIN_IMPRESSIONS) {
      continue;
    }

    const rankUp = entry.positionDelta <= -DIFF_POSITION_STEP; // 数字变小=上升
    const rankDown = entry.positionDelta >= DIFF_POSITION_STEP;
    const clickUp = entry.clicksDelta >= DIFF_CLICK_STEP;
    const clickDown = entry.clicksDelta <= -DIFF_CLICK_STEP;

    if (rankUp || clickUp) {
      improved.push(entry);
    } else if (rankDown || clickDown) {
      declined.push(entry);
    }
  }

  const newKeys = [...cur.keys()].filter((k) => !prev.has(k));
  const lostKeys = [...prev.keys()].filter((k) => !cur.has(k));

  const byImpact = (a: PeriodDiffEntry, b: PeriodDiffEntry): number =>
    Math.abs(b.clicksDelta) - Math.abs(a.clicksDelta) ||
    Math.abs(b.impressionsDelta) - Math.abs(a.impressionsDelta);

  return {
    improved: improved.sort(byImpact),
    declined: declined.sort(byImpact),
    newKeys,
    lostKeys,
  };
}
