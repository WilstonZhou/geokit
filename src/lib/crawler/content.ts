/**
 * 鲸析 GEOkit — 正文指纹（T4 疑似内容重复检测）
 *
 * 刻意只产出「shingle 短哈希」，不保留正文：
 *   - 体积小，可随 CrawlPage 落进 Observation；
 *   - 比较用 Jaccard，依据透明可解释；
 *   - 中文无空格分词 —— 采用字符级 token（英文按词、中文按单字）的 5-gram，
 *     这是中文近重复检测的常见轻量做法，零依赖。
 *
 * 结论永远是「疑似」：shingle 相似度高只说明正文大面积雷同，
 * 是否真的重复由人判断，措辞上不越界。
 */
import { createHash } from "node:crypto";
import { stripTags } from "../html";

/** shingle 的 token 窗口大小（英文 5 词 / 中文 5 字） */
export const SHINGLE_SIZE = 5;
/** 每页最多保留的 shingle 数（取正文前 N 个，控制落库体积） */
export const MAX_SHINGLES_PER_PAGE = 300;
/** 正文 token 少于该数不参与重复检测（短页面天然高相似，误报率高） */
export const MIN_TOKENS_FOR_DUP = 50;

/**
 * 正文 → token 序列。
 * 英文/数字整体为一个 token（小写），中文按单字切分，其余符号丢弃。
 */
export function tokenizeForShingle(htmlOrText: string): string[] {
  const text = stripTags(htmlOrText ?? "");
  const matches = text.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]/g);
  return matches ?? [];
}

function shingleHash(tokens: string[], start: number): string {
  const gram = tokens.slice(start, start + SHINGLE_SIZE).join("|");
  return createHash("sha1").update(gram, "utf8").digest("hex").slice(0, 12);
}

/**
 * 计算页面正文的 shingle 哈希列表。
 * token 数不足 MIN_TOKENS_FOR_DUP 时返回 null（不参与重复检测）。
 */
export function computeShingles(htmlOrText: string): string[] | null {
  const tokens = tokenizeForShingle(htmlOrText);
  if (tokens.length < MIN_TOKENS_FOR_DUP) return null;

  const count = Math.min(MAX_SHINGLES_PER_PAGE, tokens.length - SHINGLE_SIZE + 1);
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    const h = shingleHash(tokens, i);
    // 重复 gram 只保留一次 —— Jaccard 衡量的是「不同片段」的重合度
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(h);
  }
  return out.length > 0 ? out : null;
}

/**
 * 两组 shingle 的 Jaccard 相似度（0–1）。
 * 依据：|A∩B| / |A∪B|，供「疑似内容重复」结论直接引用。
 */
export function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let inter = 0;
  const union = new Set<string>(b);
  for (const x of a) {
    if (setB.has(x)) inter++;
    union.add(x);
  }
  return union.size === 0 ? 0 : inter / union.size;
}
