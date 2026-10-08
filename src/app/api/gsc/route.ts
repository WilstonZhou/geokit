import { NextResponse } from "next/server";

import { analyzeSearchPerformance } from "@/lib/gsc";
import type { GscDimension } from "@/lib/gsc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const VALID_DIMS: ReadonlySet<string> = new Set([
  "query",
  "page",
  "date",
  "country",
  "device",
]);

/**
 * POST /api/gsc { siteUrl, startDate?, endDate?, dimensions?, crawledUrls? }
 *
 * 返回 Search Analytics 查询结果（含小写四态 status/statusReason）与机会分析。
 * 未配置凭证 / 无权限 / 限流都是 200 + 显式状态（由前端给出配置指引），不是 5xx。
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }

  const { siteUrl, startDate, endDate, dimensions, crawledUrls } =
    (body ?? {}) as {
      siteUrl?: string;
      startDate?: string;
      endDate?: string;
      dimensions?: unknown;
      crawledUrls?: unknown;
    };

  if (!siteUrl || !siteUrl.trim()) {
    return NextResponse.json(
      { error: "需要提供 siteUrl（Search Console 资源，如 sc-domain:example.com）" },
      { status: 400 }
    );
  }

  const dims = Array.isArray(dimensions)
    ? (dimensions.filter(
        (d): d is GscDimension => typeof d === "string" && VALID_DIMS.has(d)
      ) as GscDimension[])
    : undefined;

  // 缺省日期：最近 28 天（含今天，UTC）
  const iso = (d: Date): string => d.toISOString().slice(0, 10);
  const now = new Date();
  const finalStart =
    typeof startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(startDate)
      ? startDate
      : iso(new Date(now.getTime() - 27 * 86_400_000));
  const finalEnd =
    typeof endDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(endDate)
      ? endDate
      : iso(now);

  const urls = Array.isArray(crawledUrls)
    ? crawledUrls.filter((u): u is string => typeof u === "string")
    : undefined;

  try {
    const result = await analyzeSearchPerformance(
      {
        siteUrl: siteUrl.trim(),
        startDate: finalStart,
        endDate: finalEnd,
        ...(dims && dims.length > 0 ? { dimensions: Array.from(new Set(dims)) } : {}),
      },
      { crawledUrls: urls }
    );
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
