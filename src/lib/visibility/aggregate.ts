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
