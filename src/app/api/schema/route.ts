import { NextResponse } from "next/server";

import { analyzeSchema, buildSchemaDraft, analyzeSchemaUrl } from "@/lib/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/schema
 *
 * Schema / 实体诊断 + JSON-LD 草稿。
 * 传 url 现场抓取，或传 html 离线分析（html 优先）。
 * 只诊断、给草稿，不修改站点；抓取失败如实返回错误，不伪造结论。
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

  const b = body as Record<string, unknown>;
  const url = typeof b.url === "string" ? b.url.trim() : "";
  const html = typeof b.html === "string" ? b.html : "";

  if (!url && !html.trim()) {
    return NextResponse.json({ error: "url 与 html 至少提供一个" }, { status: 400 });
  }

  try {
    // 离线：直接分析传入 HTML
    if (html.trim()) {
      const target = url || "inline://html";
      return NextResponse.json({
        diagnosis: analyzeSchema(target, html),
        draft: buildSchemaDraft(target, html),
      });
    }

    // 在线
    const r = await analyzeSchemaUrl(url);
    if (!r.ok || !r.diagnosis || !r.draft) {
      return NextResponse.json(
        {
          ok: false,
          url: r.finalUrl,
          httpStatus: r.httpStatus,
          error: r.error,
        },
        { status: 502 }
      );
    }
    return NextResponse.json({
      ok: true,
      url: r.finalUrl,
      httpStatus: r.httpStatus,
      diagnosis: r.diagnosis,
      draft: r.draft,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
