import { NextResponse } from "next/server";
import { runVisibilityMatrix, PROVIDER_LIST, type ProviderId } from "@/lib/visibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/visibility
 * { brand, topic }
 *
 * API key 从服务端环境变量读取，不经过前端，避免泄露：
 *   DEEPSEEK_API_KEY / DOUBAO_API_KEY / KIMI_API_KEY / QWEN_API_KEY
 *   WENXIN_API_KEY / YUANBAO_API_KEY / OPENAI_API_KEY
 *   ANTHROPIC_API_KEY / GEMINI_API_KEY
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }

  const { brand, topic } = (body ?? {}) as { brand?: string; topic?: string };
  if (!brand || !brand.trim() || !topic || !topic.trim()) {
    return NextResponse.json(
      { error: "需要提供 brand 与 topic 两个参数" },
      { status: 400 }
    );
  }

  const keys: Partial<Record<ProviderId, string>> = {};
  for (const p of PROVIDER_LIST) {
    const v = process.env[p.envKey];
    if (v) keys[p.id] = v;
  }

  try {
    const report = await runVisibilityMatrix(brand.trim(), topic.trim(), keys);
    return NextResponse.json(report);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

/** 返回当前已配置的模型清单，方便 UI 提示 */
export async function GET() {
  return NextResponse.json({
    providers: PROVIDER_LIST.map((p) => ({
      id: p.id,
      name: p.name,
      vendor: p.vendor,
      cnRelevance: p.cnRelevance,
      note: p.note,
      configured: Boolean(process.env[p.envKey]),
      envKey: p.envKey,
    })),
    /** open-seo 仅支持这 4 个英文模型 —— 对比用 */
    openSeoSupported: ["chatgpt", "claude", "gemini", "perplexity"],
  });
}
