import { NextResponse } from "next/server";

import { analyzeCompetitors } from "@/lib/competitor";
import type { CompetitorInput } from "@/lib/competitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/competitors
 *
 * 五维竞品对比。缺数据源的维度标 unavailable 不报错；
 * 抓取失败按 blocked 标注，不留空、不编造。
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
  const userDomain = typeof b.userDomain === "string" ? b.userDomain.trim() : "";
  const competitors = Array.isArray(b.competitors)
    ? (b.competitors as unknown[]).map(String).filter(Boolean).slice(0, 5)
    : [];

  if (!userDomain) {
    return NextResponse.json({ error: "缺少 userDomain" }, { status: 400 });
  }
  if (competitors.length === 0) {
    return NextResponse.json({ error: "至少需要 1 个竞品域名" }, { status: 400 });
  }

  try {
    const input: CompetitorInput = { userDomain, competitors };
    if (Array.isArray(b.queries)) input.queries = (b.queries as unknown[]).map(String);
    if (Array.isArray(b.serpResults)) input.serpResults = b.serpResults as CompetitorInput["serpResults"];
    if (Array.isArray(b.aiCitations)) input.aiCitations = b.aiCitations as CompetitorInput["aiCitations"];
    if (Array.isArray(b.userPageAudits)) input.userPageAudits = b.userPageAudits as CompetitorInput["userPageAudits"];
    if (Array.isArray(b.competitorPageAudits)) input.competitorPageAudits = b.competitorPageAudits as CompetitorInput["competitorPageAudits"];
    if (Array.isArray(b.competitorPageUrls)) input.competitorPageUrls = b.competitorPageUrls as CompetitorInput["competitorPageUrls"];
    if (b.userRobots && typeof b.userRobots === "object") input.userRobots = b.userRobots as CompetitorInput["userRobots"];
    if (b.userLlmsTxt && typeof b.userLlmsTxt === "object") input.userLlmsTxt = b.userLlmsTxt as CompetitorInput["userLlmsTxt"];
    if (Array.isArray(b.competitorRobots)) input.competitorRobots = b.competitorRobots as CompetitorInput["competitorRobots"];
    if (Array.isArray(b.competitorLlmsTxt)) input.competitorLlmsTxt = b.competitorLlmsTxt as CompetitorInput["competitorLlmsTxt"];
    if (typeof b.fetchProtocol === "boolean") input.fetchProtocol = b.fetchProtocol;
    if (b.userCrawl && typeof b.userCrawl === "object") input.userCrawl = b.userCrawl as CompetitorInput["userCrawl"];
    if (Array.isArray(b.competitorCrawls)) input.competitorCrawls = b.competitorCrawls as CompetitorInput["competitorCrawls"];

    const report = await analyzeCompetitors(input);
    return NextResponse.json(report);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
