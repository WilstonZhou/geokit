import { NextResponse } from "next/server";
import { searchRankings } from "@/lib/services/serp";
import { CN_ENGINES, GLOBAL_ENGINES, ENGINE_LIST, isCnEngine, type EngineId } from "@/lib/engines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/serp
 * { keyword, targetDomain?, engines?: EngineId[], group?: "cn" | "global" | "all", pages? }
 *
 * 本层只做参数校验与序列化 —— 聚合逻辑一律在 services/serp，
 * 保证 MCP 与 HTTP 给出完全一致的口径。
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }

  const { keyword, targetDomain, engines, group = "cn", pages = 1 } = (body ?? {}) as {
    keyword?: string;
    targetDomain?: string;
    engines?: EngineId[];
    group?: "cn" | "global" | "all";
    pages?: number;
  };

  if (!keyword || !keyword.trim()) {
    return NextResponse.json({ error: "缺少 keyword" }, { status: 400 });
  }

  try {
    return NextResponse.json(
      await searchRankings({ keyword, targetDomain, engines, group, pages })
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    engines: ENGINE_LIST.map((e) => ({
      id: e.id, name: e.name, domain: e.domain,
      market: e.market, shareCn: e.shareCn, cn: isCnEngine(e.id),
    })),
    groups: { cn: CN_ENGINES, global: GLOBAL_ENGINES },
  });
}
