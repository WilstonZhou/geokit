import { NextResponse } from "next/server";

import { latestObservationDiff } from "@/lib/services/observations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/observations/diff —— 某条时间线最近两条观测的差异（Phase 1 S7）。
 *
 * 必填：
 *   subject   被观测对象
 *   type      rank | geo_score | ai_mention | robots_policy | llms_txt
 * 可选：
 *   source    观测来源（同一 subject 下有多来源时必须指定，否则会把
 *             不同引擎/不同厂商的结论放在一起比）
 *   to        只比较该时间点之前的观测
 *
 * 差异结论由 S6 的 diff 引擎给出：**先判可比性，再算变化**。
 * `comparable=false` 时 summary 的 improved / degraded 必定为 0 ——
 * 「上次没观测到、这次观测到了」不会被记成表现变化。
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const r = await latestObservationDiff(searchParams);
  if (!r.ok) {
    return NextResponse.json({ error: r.error }, { status: r.status });
  }
  return NextResponse.json(r.data);
}
