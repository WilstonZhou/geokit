import { NextResponse } from "next/server";

import { crawlSite, analyzeSiteIssues } from "@/lib/crawler";
import type { CrawlConfig } from "@/lib/crawler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/crawl  { site, config? }
 *
 * 爬取一个站点：BFS 同域页面，每页产出 PageAudit 子集 + 入链/出链信息，
 * 构建站点图后返回。受 maxPages / maxDepth / totalBudgetMs 限制时返回
 * 已爬到的部分结果，并标 truncated=true。
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }

  const { site, config } = (body ?? {}) as {
    site?: string;
    config?: Partial<CrawlConfig>;
  };
  if (!site || !site.trim()) {
    return NextResponse.json(
      { error: "需要提供 site（站点 URL 或域名）" },
      { status: 400 }
    );
  }

  try {
    const result = await crawlSite(site, { config });
    // T4：站点级问题聚合（纯函数，服务端算好再下发）
    const analysis = analyzeSiteIssues(result);
    // contentShingles 是内部正文指纹，不随响应下发；其余页面字段照常
    const pages = result.pages.map((p) => {
      const { contentShingles: _cs, ...rest } = p;
      return rest;
    });
    return NextResponse.json({
      ...result,
      pages,
      issues: analysis.issues,
      geoSummary: analysis.geoSummary,
      schemaCoverage: analysis.schemaCoverage,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
