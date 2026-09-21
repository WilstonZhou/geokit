import { NextResponse } from "next/server";
import { fetchMultiEngine } from "@/lib/serp";
import { CN_ENGINES, GLOBAL_ENGINES, ENGINE_LIST, isCnEngine, type EngineId } from "@/lib/engines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/serp
 * { keyword, targetDomain?, engines?: EngineId[], group?: "cn" | "global" | "all", pages? }
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

  let ids: EngineId[];
  if (Array.isArray(engines) && engines.length > 0) {
    ids = engines.filter((e) => ENGINE_LIST.some((x) => x.id === e));
  } else {
    ids = group === "cn" ? CN_ENGINES : group === "global" ? GLOBAL_ENGINES : [...CN_ENGINES, ...GLOBAL_ENGINES];
  }

  try {
    const results = await fetchMultiEngine(ids, keyword.trim(), targetDomain, Math.max(1, Math.min(pages, 3)));
    const ok = results.filter((r) => r.status === "ok");
    const ranked = ok.filter((r) => r.targetRank !== null);

    return NextResponse.json({
      keyword,
      targetDomain: targetDomain ?? null,
      engineCount: ids.length,
      summary: {
        okEngines: ok.length,
        blockedEngines: results.filter((r) => r.status !== "ok").length,
        /** 各引擎 Top10 中该域名的平均自然位次 */
        averageRank: ranked.length
          ? Math.round((ranked.reduce((s, r) => s + (r.targetRank ?? 0), 0) / ranked.length) * 10) / 10
          : null,
        bestRank: ranked.length ? Math.min(...ranked.map((r) => r.targetRank ?? 999)) : null,
        totalItems: results.reduce((s, r) => s + r.items.length, 0),
      },
      results,
    });
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
