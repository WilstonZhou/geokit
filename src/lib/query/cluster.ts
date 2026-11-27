/**
 * 鲸析 GEOkit — Query 聚类（T7）
 *
 * 基于共享 SERP 结果 URL 的重合度对一批 query 聚类。
 *
 * 两个 query 的 SERP URL 集合 Jaccard ≥ 阈值（默认 0.3）或共享 ≥ minSharedUrls 条 URL
 * 时归为同一簇。簇内任意两 query 的平均 Jaccard 写入 overlapScore。
 *
 * 纯函数 + 确定性算法：固定输入 → 固定输出，便于测试。
 */

import { createHash } from "node:crypto";
import type { QueryCluster, QueryClusterInput, ClusterOptions } from "./types";
import type { SerpResponse } from "../serp";

/* ------------------------------------------------------------------ */
/* 默认参数                                                            */
/* ------------------------------------------------------------------ */

export const DEFAULT_CLUSTER_OPTIONS: Required<ClusterOptions> = {
  jaccardThreshold: 0.3,
  minSharedUrls: 2,
};

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/** 取一个 query 的所有 SERP URL 集合（跨多引擎） */
function collectUrls(serpResults: SerpResponse[]): Set<string> {
  const urls = new Set<string>();
  for (const serp of serpResults) {
    for (const item of serp.items) {
      if (item.url) urls.add(item.url);
    }
  }
  return urls;
}

/** Jaccard 相似度：|A∩B| / |A∪B| */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 共享 URL 数 */
function sharedCount(a: Set<string>, b: Set<string>): string[] {
  const out: string[] = [];
  for (const x of a) if (b.has(x)) out.push(x);
  return out;
}

function makeClusterId(queries: string[]): string {
  const h = createHash("sha1")
    .update([...queries].sort().join("\n"), "utf8")
    .digest("hex")
    .slice(0, 8);
  return `cluster:${h}`;
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 对一批 query 聚类。
 *
 * 算法：
 *   1. 计算每对 query 的 Jaccard 与 sharedUrls
 *   2. 满足阈值条件的两个 query 用并查集合并
 *   3. 输出每个连通分量为一个 QueryCluster
 *   4. overlapScore = 簇内所有配对的平均 Jaccard
 *
 * @param inputs   每个 query 各自的 SERP 结果
 * @param options  阈值参数
 * @returns QueryCluster[] —— 单元素簇（无相似 query）不输出
 */
export function clusterQueries(
  inputs: QueryClusterInput[],
  options?: ClusterOptions
): QueryCluster[] {
  const opts = { ...DEFAULT_CLUSTER_OPTIONS, ...options };
  const n = inputs.length;
  if (n < 2) return [];

  // 预计算每个 query 的 URL 集合
  const urlSets = inputs.map((i) => collectUrls(i.serpResults));

  // 并查集
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a: number, b: number) {
    parent[find(a)] = find(b);
  }

  // 先并查集分组，再在最终簇内重算配对指标。
  //
  // 不能边 union 边按当时的 root 记账：后续 union 会改变 root，
  // 先前存下的配对值就永远读不到了（overlapScore 会只统计最后一对）。
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const jVal = jaccard(urlSets[i], urlSets[j]);
      const shared = sharedCount(urlSets[i], urlSets[j]);
      const hit =
        jVal >= opts.jaccardThreshold || shared.length >= opts.minSharedUrls;
      if (hit) union(i, j);
    }
  }

  // 按 root 分组
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const arr = groups.get(root) ?? [];
    arr.push(i);
    groups.set(root, arr);
  }

  const out: QueryCluster[] = [];
  for (const [, idxList] of groups) {
    if (idxList.length < 2) continue; // 单元素簇不输出
    const queries = idxList.map((i) => inputs[i].query);

    // 簇内任意两 query 的平均 Jaccard（与注释承诺一致）
    let pairSum = 0;
    let pairCount = 0;
    const sharedSet = new Set<string>();
    for (let a = 0; a < idxList.length; a++) {
      for (let b = a + 1; b < idxList.length; b++) {
        pairSum += jaccard(urlSets[idxList[a]!]!, urlSets[idxList[b]!]!);
        pairCount++;
        for (const u of sharedCount(urlSets[idxList[a]!]!, urlSets[idxList[b]!]!)) {
          sharedSet.add(u);
        }
      }
    }
    const overlapScore = pairCount === 0 ? 0 : pairSum / pairCount;
    const sharedUrls = Array.from(sharedSet).slice(0, 20);
    out.push({
      id: makeClusterId(queries),
      queries,
      overlapScore: Number(overlapScore.toFixed(3)),
      sharedUrls,
    });
  }

  // 稳定输出：按 queries 数降序，再按 overlapScore 降序
  return out.sort(
    (a, b) =>
      b.queries.length - a.queries.length ||
      b.overlapScore - a.overlapScore
  );
}
