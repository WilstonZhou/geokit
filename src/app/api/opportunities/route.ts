import { NextResponse } from "next/server";

import { generateOpportunities, countByType } from "@/lib/opportunity";
import type { OpportunityInput } from "@/lib/opportunity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/opportunities { siteAnalysis?, citationAggregation?, userDomain?,
 *   robotsAnalysis?, llmsTxtAnalysis?, gscOpportunities?, pageAudits? }
 *
 * 任意字段缺失即跳过对应机会类型，绝不报错。
 * 不调用任何大模型，建议来自规则与模板。
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "请求体必须是 JSON 对象" },
      { status: 400 }
    );
  }

  const input = body as OpportunityInput;
  // 仅保留引擎认识的字段，过滤掉未知键
  const safeInput: OpportunityInput = {};
  if (input.siteAnalysis) safeInput.siteAnalysis = input.siteAnalysis;
  if (input.citationAggregation) safeInput.citationAggregation = input.citationAggregation;
  if (typeof input.userDomain === "string" && input.userDomain.trim()) {
    safeInput.userDomain = input.userDomain.trim();
  }
  if (input.robotsAnalysis) safeInput.robotsAnalysis = input.robotsAnalysis;
  if (input.llmsTxtAnalysis) safeInput.llmsTxtAnalysis = input.llmsTxtAnalysis;
  if (Array.isArray(input.gscOpportunities)) {
    safeInput.gscOpportunities = input.gscOpportunities;
  }
  if (Array.isArray(input.pageAudits)) {
    safeInput.pageAudits = input.pageAudits;
  }

  try {
    const opportunities = generateOpportunities(safeInput);
    const counts = countByType(opportunities);
    return NextResponse.json({
      total: opportunities.length,
      counts,
      opportunities,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
