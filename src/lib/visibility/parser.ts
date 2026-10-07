import type { ObservationStatus, CitationRecord } from "../evidence/types";

const URL_REGEX = /(?:https?:\/\/|www\.)[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+(?:\/[^\s)\]>]*)?/g;
const MD_LINK_REGEX = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

export function extractCitations(
  rawResponse: string,
  query: string,
  model: string,
  mentioned: boolean,
  brand: string,
  competitors: string[] = []
): CitationRecord {
  const citations: { url: string; title?: string; position?: number }[] = [];
  const seenUrls = new Set<string>();

  let match;
  // Match Markdown links first
  while ((match = MD_LINK_REGEX.exec(rawResponse)) !== null) {
    const title = match[1];
    let url = match[2];
    if (url.endsWith(")")) url = url.slice(0, -1);
    if (!seenUrls.has(url)) {
      seenUrls.add(url);
      citations.push({ url, title, position: match.index });
    }
  }

  // Match raw URLs
  while ((match = URL_REGEX.exec(rawResponse)) !== null) {
    let url = match[0];
    if (url.startsWith("www.")) url = "https://" + url;
    if (url.endsWith(")")) url = url.slice(0, -1);
    if (url.endsWith("]")) url = url.slice(0, -1);
    if (url.endsWith(".")) url = url.slice(0, -1);
    // 中文回答里 URL 常被全角句号收尾,需剥离,否则会污染域名统计
    if (url.endsWith("。")) url = url.slice(0, -1);
    
    if (!seenUrls.has(url)) {
      seenUrls.add(url);
      citations.push({ url, position: match.index });
    }
  }

  const citationsStatus: ObservationStatus =
    citations.length > 0 ? "ok" : "unavailable";

  const competitorsMentioned = competitors.filter(
    (c) => rawResponse.toLowerCase().includes(c.toLowerCase())
  );

  let mentionContext: string | undefined;
  if (mentioned) {
    const idx = rawResponse.toLowerCase().indexOf(brand.toLowerCase());
    if (idx !== -1) {
      const start = Math.max(0, idx - 50);
      const end = Math.min(rawResponse.length, idx + brand.length + 50);
      mentionContext = rawResponse.slice(start, end).replace(/\n/g, " ");
    }
  }

  return {
    query,
    model,
    answerText: rawResponse,
    mentioned,
    mentionContext,
    citations,
    citationsStatus,
    competitorsMentioned,
    observedAt: new Date().toISOString(),
  };
}
