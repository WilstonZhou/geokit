import { NextResponse } from "next/server";
import { analyzeRobots, analyzeLlmsTxt, generateLlmsTxtDraft } from "@/lib/llms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET  /api/llms?site=https://example.com            → 分析 robots AI 策略 + llms.txt
 * POST /api/llms  { site, action: "generate", siteName?, description? }  → 生成 llms.txt 草稿
 * POST /api/llms  { content }                         → 离线校验 llms.txt 文本
 */
export async function GET(req: Request) {
  const site = new URL(req.url).searchParams.get("site");
  if (!site) {
    return NextResponse.json({ error: "缺少 site 参数" }, { status: 400 });
  }
  try {
    const [robots, llms] = await Promise.all([analyzeRobots(site), analyzeLlmsTxt(site)]);
    return NextResponse.json({ robots, llms });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }

  const { site, action, siteName, description, content } = (body ?? {}) as {
    site?: string;
    action?: "generate" | "validate";
    siteName?: string;
    description?: string;
    content?: string;
  };

  try {
    if (content) {
      const { analyzeLlmsTxtContent } = await import("@/lib/llms");
      return NextResponse.json(analyzeLlmsTxtContent("inline://llms.txt", content));
    }

    if (!site) {
      return NextResponse.json({ error: "缺少 site 参数" }, { status: 400 });
    }

    if (action === "generate") {
      const draft = await generateLlmsTxtDraft(site, { siteName, description });
      // 顺手校验生成的草稿，确保输出本身合规
      const { analyzeLlmsTxtContent } = await import("@/lib/llms");
      const check = analyzeLlmsTxtContent(`${site}/llms.txt`, draft.content);
      return NextResponse.json({ ...draft, check });
    }

    const [robots, llms] = await Promise.all([analyzeRobots(site), analyzeLlmsTxt(site)]);
    return NextResponse.json({ robots, llms });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
