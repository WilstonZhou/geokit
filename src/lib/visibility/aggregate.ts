import type { CitationRecord } from "../evidence/types";
import { getDomain } from "../html";

export interface CitationAggregation {
  domainRanking: { domain: string; count: number }[];
  competitorFrequency: { competitor: string; count: number }[];
  citationGap: { domain: string; count: number }[];
}

export function analyzeCitations(
  records: CitationRecord[],
  userDomain: string
): CitationAggregation {
  const domainCount = new Map<string, number>();
  const competitorCount = new Map<string, number>();

  for (const record of records) {
    if (record.citationsStatus !== "ok" && record.citationsStatus !== "OBSERVED") continue;
    
    // Aggregate domains cited in this record
    const uniqueDomainsInRecord = new Set<string>();
    for (const c of record.citations) {
      try {
        const hostname = new URL(c.url).hostname;
        const d = getDomain(hostname);
        uniqueDomainsInRecord.add(d);
      } catch {
        // Invalid URL
      }
    }

    for (const d of uniqueDomainsInRecord) {
      domainCount.set(d, (domainCount.get(d) ?? 0) + 1);
    }

    // Aggregate competitors
    for (const comp of record.competitorsMentioned ?? []) {
      competitorCount.set(comp, (competitorCount.get(comp) ?? 0) + 1);
    }
  }

  const domainRanking = Array.from(domainCount.entries())
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count);

  const competitorFrequency = Array.from(competitorCount.entries())
    .map(([competitor, count]) => ({ competitor, count }))
    .sort((a, b) => b.count - a.count);

  // Citation Gap: Domains cited by at least 2 models/queries, but not the user's domain
  const uDomain = getDomain(userDomain);
  const citationGap = domainRanking.filter(
    (r) => r.count >= 2 && r.domain !== uDomain
  );

  return { domainRanking, competitorFrequency, citationGap };
}

/* ------------------------------------------------------------------ */
/* 引用 diff：同一 query 集合前后两次观测（T2 #6）                        */
/* ------------------------------------------------------------------ */

export interface CitationDiffEntry {
  query: string;
  model: string;
  /** false = 存档里没有更早的同 (query, model) 记录，无从比较 */
  hasPrevious: boolean;
  /** 相对上一次：新增提及 / 失去提及 / 无变化；无前值时为 null */
  mention: "added" | "lost" | "unchanged" | null;
  /** 本次新增的引用 URL */
  citationsAdded: string[];
  /** 上次有、本次消失的引用 URL */
  citationsLost: string[];
  prevCitationsStatus?: string;
  citationsStatus: string;
}

/**
 * 比较前后两批引用记录。
 *
 * 匹配键是 (query, model)。「前值」取 observedAt **严格早于** 当前记录的
 * 最新一条 —— 这样当前运行刚写进存档的记录不会被误当成自己的前值。
 */
export function diffCitationRecords(
  prev: CitationRecord[],
  cur: CitationRecord[]
): CitationDiffEntry[] {
  return cur.map((c) => {
    const candidates = prev
      .filter(
        (p) =>
          p.query === c.query &&
          p.model === c.model &&
          Date.parse(p.observedAt) < Date.parse(c.observedAt)
      )
      .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));

    const p = candidates[0];
    if (!p) {
      return {
        query: c.query,
        model: c.model,
        hasPrevious: false,
        mention: null,
        citationsAdded: [],
        citationsLost: [],
        citationsStatus: c.citationsStatus,
      };
    }

    const prevUrls = new Set(p.citations.map((x) => x.url));
    const curUrls = new Set(c.citations.map((x) => x.url));

    const mention =
      p.mentioned === c.mentioned
        ? "unchanged"
        : c.mentioned
          ? "added"
          : "lost";

    return {
      query: c.query,
      model: c.model,
      hasPrevious: true,
      mention,
      citationsAdded: c.citations.filter((x) => !prevUrls.has(x.url)).map((x) => x.url),
      citationsLost: p.citations.filter((x) => !curUrls.has(x.url)).map((x) => x.url),
      prevCitationsStatus: p.citationsStatus,
      citationsStatus: c.citationsStatus,
    };
  });
}
