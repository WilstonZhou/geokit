import { NextResponse } from "next/server";
import { auditUrl, type GeoVersion } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/audit  { url, html?, geoVersion? }
 *
 * url 存在则真实抓取；若直接传 html，则离线分析（适合内网页面 / 抓好了再送进来）。
 * geoVersion 支持 "1.0.0" | "2.0.0"，默认 "1.0.0"。
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }

  const { url, html, geoVersion: rawGeoVer } = (body ?? {}) as {
    url?: string;
    html?: string;
    geoVersion?: string;
  };
  if (!url && !html) {
    return NextResponse.json(
      { error: "需要提供 url 或 html 其中之一" },
      { status: 400 }
    );
  }

  const geoVersion: GeoVersion = rawGeoVer === "2.0.0" ? "2.0.0" : "1.0.0";

  try {
    if (html) {
      const { analyze } = await import("@/lib/audit");
      const normalized = url && url.startsWith("http") ? url : `https://${url ?? "offline.local"}`;
      return NextResponse.json(analyze(normalized, html, 200, 0, { geoVersion }));
    }
    const result = await auditUrl(url as string, { geoVersion });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
