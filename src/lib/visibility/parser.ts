import type { ObservationStatus, CitationRecord } from "../evidence/types";

// URL 到空白、右括号、引号或中文标点为止；避免把“URL，这是后续说明”整段吞掉
const URL_REGEX =
  /(?:https?:\/\/|www\.)[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+(?:\/[^\s)\]}>"'，。；：！？、）】》]*)?/gi;
// Markdown 链接允许 URL 内出现一层成对括号（如 Wikipedia 的 Foo_(bar)）
const MD_LINK_REGEX =
  /\[([^\]]+)\]\((https?:\/\/(?:[^()\s]|\([^()\s]*\))+)\)/gi;

interface CitationCandidate {
  url: string;
  title?: string;
  offset: number;
}

function trimUrlPunctuation(url: string): string {
  return url.replace(/[.,;:!?，。；：！？、"'）】》]+$/, "");
}

export function extractCitations(
  rawResponse: string,
  query: string,
  model: string,
  mentioned: boolean,
  brand: string,
  competitors: string[] = []
): CitationRecord {
  const candidates: CitationCandidate[] = [];

  // Markdown 链接优先保留 title，最终仍按字符位置排序
  let match: RegExpExecArray | null;
  MD_LINK_REGEX.lastIndex = 0;
  while ((match = MD_LINK_REGEX.exec(rawResponse)) !== null) {
    candidates.push({
      url: trimUrlPunctuation(match[2]!),
      title: match[1],
      offset: match.index,
    });
  }

  URL_REGEX.lastIndex = 0;
  while ((match = URL_REGEX.exec(rawResponse)) !== null) {
    let url = trimUrlPunctuation(match[0]);
    if (url.startsWith("www.")) url = "https://" + url;
    candidates.push({ url, offset: match.index });
  }

  candidates.sort((a, b) => a.offset - b.offset);

  const citations: { url: string; title?: string; position?: number }[] = [];
  const seenUrls = new Set<string>();
  for (const c of candidates) {
    if (!c.url || seenUrls.has(c.url)) continue;
    seenUrls.add(c.url);
    // position 是“回答中的第几个引用”（1 起），不是字符偏移。
    // competitor/ai.ts 的 averageCitationPosition 依赖这个语义。
    citations.push({
      url: c.url,
      title: c.title,
      position: citations.length + 1,
    });
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
