import { NextResponse } from "next/server";
import { auditUrl, type GeoVersion } from "@/lib/audit";
import { BodyTooLargeError, HTML_JSON_MAX_BYTES, readRequestJson } from "@/lib/api/body";

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
    body = await readRequestJson(req, HTML_JSON_MAX_BYTES);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof BodyTooLargeError ? e.message : "请求体必须是 JSON" },
      { status: e instanceof BodyTooLargeError ? 413 : 400 }
    );
  }

  const raw = (body ?? {}) as Record<string, unknown>;
  const url = typeof raw.url === "string" ? raw.url : undefined;
  const html = typeof raw.html === "string" ? raw.html : undefined;
  const rawGeoVer = raw.geoVersion;
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
