/**
 * 鲸析 GEOkit — Query 竞品识别（T7）
 *
 * 把 SERP 结果与 AI 引用 URL 里反复出现的域名聚合，输出 CompetitorAppearance[]。
 *
 * 用户自家域名（userDomain）会被排除 —— 它不是"竞品"。
 */

import type { CompetitorAppearance } from "./types";
import type { SerpResponse } from "../serp";
import type { CitationRecord } from "../evidence/types";
import { getDomain } from "../html";

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 识别竞品域名。
 *
 * @param serpResults  SERP 结果（含 position / domain）
 * @param aiCitations  AI 引用记录（citations.url 的域名）
 * @param userDomain   用户域名 —— 会被排除
 * @returns CompetitorAppearance[]，按 (serpCount + aiMentionCount) 降序
 */
export function identifyCompetitors(
  serpResults?: SerpResponse[],
  aiCitations?: CitationRecord[],
  userDomain?: string
): CompetitorAppearance[] {
  const userDom = userDomain ? getDomain(userDomain).toLowerCase() : null;

  /** domain → { serpCount, serpPositions: Set<number>, aiCount } */
  const map = new Map<string, { serpCount: number; serpPositions: Set<number>; aiCount: number }>();

  const ensure = (d: string) => {
    let e = map.get(d);
    if (!e) {
      e = { serpCount: 0, serpPositions: new Set(), aiCount: 0 };
      map.set(d, e);
    }
    return e;
  };

  // 1. SERP 来源
  if (serpResults && serpResults.length > 0) {
    for (const serp of serpResults) {
      // 同一 SERP 内同域名去重（避免一页多结果重复计数）
      const seenInThisSerp = new Set<string>();
      for (const item of serp.items) {
        const d = (item.domain || "").toLowerCase();
        if (!d || seenInThisSerp.has(d)) continue;
        seenInThisSerp.add(d);
        if (userDom && d === userDom) continue;
        const e = ensure(d);
        e.serpCount += 1;
        e.serpPositions.add(item.position);
      }
    }
  }

  // 2. AI 引用来源
  if (aiCitations && aiCitations.length > 0) {
    for (const rec of aiCitations) {
      if (rec.citationsStatus !== "ok" && rec.citationsStatus !== "OBSERVED") continue;
      // 同一记录内同域名去重
      const seenInThisRec = new Set<string>();
      for (const c of rec.citations) {
        try {
          const host = new URL(c.url).hostname;
          const d = getDomain(host).toLowerCase();
          if (!d || seenInThisRec.has(d)) continue;
          seenInThisRec.add(d);
          if (userDom && d === userDom) continue;
          const e = ensure(d);
          e.aiCount += 1;
        } catch {
          // 无效 URL —— 跳过
        }
      }
    }
  }

  // 3. 输出
  const out: CompetitorAppearance[] = [];
  for (const [domain, e] of map) {
    if (e.serpCount === 0 && e.aiCount === 0) continue;
    const source: CompetitorAppearance["source"] =
      e.serpCount > 0 && e.aiCount > 0 ? "both" : e.serpCount > 0 ? "serp" : "ai";
    out.push({
      domain,
      serpCount: e.serpCount,
      serpPositions: Array.from(e.serpPositions).sort((a, b) => a - b),
      aiMentionCount: e.aiCount,
      source,
    });
  }

  return out.sort(
    (a, b) =>
      b.serpCount + b.aiMentionCount - (a.serpCount + a.aiMentionCount) ||
      a.domain.localeCompare(b.domain)
  );
}
