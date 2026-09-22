import { NextResponse } from "next/server";

import { listObservationHistory } from "@/lib/services/observations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/observations —— 只读的历史查询入口（Phase 1 S7）。
 *
 * 查询参数（全部可选）：
 *   subject    被观测对象（site:… / search:… / ai-slot:…）
 *   source     观测来源（http:… / search-engine:… / provider:…）
 *   type       rank | geo_score | ai_mention | robots_policy | llms_txt
 *   status     OBSERVED | PARTIAL | … | UNOBSERVABLE
 *   runId      批次
 *   from / to  时间范围（ISO）
 *   order      asc | desc（默认 desc）
 *   limit      1..500（默认 50）
 *   latest     1 → 每个 identity 只留最新一条（「当前状态」查询，不是趋势）
 *
 * 本层只做序列化 —— 参数校验与取数都在 services/observations，
 * 以保证将来 MCP 读历史时口径与 HTTP 完全一致。
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const r = await listObservationHistory(searchParams);
  if (!r.ok) {
    return NextResponse.json({ error: r.error }, { status: r.status });
  }
  return NextResponse.json(r.data);
}
