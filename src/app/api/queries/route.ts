import { NextResponse } from "next/server";

import { analyzeQuery, clusterQueries } from "@/lib/query";
import type { QueryAnalysisInput, QueryClusterInput, ClusterOptions } from "@/lib/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/queries
 *
 * 两种模式：
 *   1. body.action = "analyze"（默认）—— 对单 query 做完整分析
 *   2. body.action = "cluster"       —— 对一批 query 聚类
 *
 * 缺数据源时对应段落标 unavailable，不报错。
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
  }

  const b = body as { action?: string } & QueryAnalysisInput & {
    queries?: QueryClusterInput[];
  } & ClusterOptions;

  const action = b.action ?? "analyze";

  try {
    if (action === "cluster") {
      if (!Array.isArray(b.queries)) {
        return NextResponse.json(
          { error: "cluster 模式需要 queries 数组" },
          { status: 400 }
        );
      }
      const options: ClusterOptions = {};
      if (typeof b.jaccardThreshold === "number") options.jaccardThreshold = b.jaccardThreshold;
      if (typeof b.minSharedUrls === "number") options.minSharedUrls = b.minSharedUrls;
      const clusters = clusterQueries(b.queries, options);
      return NextResponse.json({
        total: clusters.length,
        queriesAnalyzed: b.queries.length,
        clusters,
      });
    }

    // analyze（默认）
    if (typeof b.query !== "string" || !b.query.trim()) {
      return NextResponse.json({ error: "analyze 模式需要 query 字符串" }, { status: 400 });
    }
    const input: QueryAnalysisInput = { query: b.query.trim() };
    if (Array.isArray(b.serpResults)) input.serpResults = b.serpResults;
    if (Array.isArray(b.aiCitations)) input.aiCitations = b.aiCitations;
    if (Array.isArray(b.gscOpportunities)) input.gscOpportunities = b.gscOpportunities;
    if (b.userCrawl && typeof b.userCrawl === "object") input.userCrawl = b.userCrawl;
    if (typeof b.userDomain === "string" && b.userDomain.trim()) {
      input.userDomain = b.userDomain.trim();
    }
    return NextResponse.json(analyzeQuery(input));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
