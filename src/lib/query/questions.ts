/**
 * 鲸析 GEOkit — Query 相关问题提取（T7）
 *
 * 从 SERP 标题与 AI 答案中提取"相关问题"候选。
 *
 * 铁律：不得编造 —— 只能从实际观测到的文本中提取。
 * 每条候选必须标明来源（serp:engine:pos=N 或 ai:model:answer）。
 */

import type { RelatedQuestion } from "./types";
import type { SerpResponse } from "../serp";
import type { CitationRecord } from "../evidence/types";

/* ------------------------------------------------------------------ */
/* 问句识别                                                            */
/* ------------------------------------------------------------------ */

const QUESTION_PREFIXES = [
  "怎么", "如何", "为什么", "是什么", "什么是", "成因", "原理",
  "哪个", "哪款", "哪种", "哪里", "在哪",
  "多少", "多久", "多快", "多远",
];

const QUESTION_MARKS = ["?", "？"];

/** 判断一段文本是否像问句（前缀词或问号） */
function looksLikeQuestion(text: string): boolean {
  if (!text || text.trim().length === 0) return false;
  if (QUESTION_MARKS.some((m) => text.includes(m))) return true;
  return QUESTION_PREFIXES.some((p) => text.startsWith(p) || text.includes(p));
}

/** 把长文本按句末标点切成句子 */
function splitSentences(text: string): string[] {
  if (!text) return [];
  return text
    .split(/[。！!？?;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && s.length < 200);
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 从 SERP 标题 + AI 答案中提取相关问题候选。
 *
 * @param serpResults  多引擎 SERP 响应
 * @param aiCitations  T2 AI 引用记录（answerText 是 AI 答案原文）
 * @returns 去重后的 RelatedQuestion[] —— 同样的问题合并多个来源
 */
export function extractRelatedQuestions(
  serpResults?: SerpResponse[],
  aiCitations?: CitationRecord[]
): RelatedQuestion[] {
  /** question → sources[] 收集，便于合并同义问句 */
  const collected = new Map<string, string[]>();

  // 1. 从 SERP 标题提取（标题本身就短，不必再切句）
  if (serpResults && serpResults.length > 0) {
    for (const serp of serpResults) {
      for (const item of serp.items) {
        const title = item.title?.trim();
        if (!title || !looksLikeQuestion(title)) continue;
        const sources = collected.get(title) ?? [];
        const src = `serp:${serp.engine}:pos=${item.position}`;
        if (!sources.includes(src)) sources.push(src);
        collected.set(title, sources);
      }
    }
  }

  // 2. 从 AI 答案提取（按句切分后挑问句）
  if (aiCitations && aiCitations.length > 0) {
    for (const rec of aiCitations) {
      if (rec.citationsStatus !== "ok" && rec.citationsStatus !== "OBSERVED") continue;
      for (const sentence of splitSentences(rec.answerText)) {
        if (!looksLikeQuestion(sentence)) continue;
        const sources = collected.get(sentence) ?? [];
        const src = `ai:${rec.model}:answer`;
        if (!sources.includes(src)) sources.push(src);
        collected.set(sentence, sources);
      }
    }
  }

  // 3. 输出 —— 按来源数降序、再按问句长度升序
  return Array.from(collected.entries())
    .map(([question, sources]) => ({ question, sources }))
    .sort(
      (a, b) =>
        b.sources.length - a.sources.length ||
        a.question.length - b.question.length
    );
}
