/**
 * Retention 策略（Phase 1 S2 —— **只设计，不实现清理**）。
 *
 * ─────────────────────────────────────────────────────────────
 * 要解决的成本问题
 * ─────────────────────────────────────────────────────────────
 * 实测：单份百度 SERP HTML 约 1.6MB，三引擎一轮 ≈ 2.7MB。
 * 若每天对若干关键词跑一轮，全量留存原始 HTML 会在几周内吃满磁盘。
 *
 * 但删掉又不行 —— 没有原文就无法重放，解析器出 bug 时历史结论无从修正。
 *
 * ─────────────────────────────────────────────────────────────
 * 取舍：分层保留
 * ─────────────────────────────────────────────────────────────
 *   metadata + contentHash  → 永久
 *   raw body blob           → 短期（按类别不同）
 *   observation             → 永久
 *
 * 也就是说：**过了保留期，你依然知道「那天抓过、内容 hash 是多少、
 * 得出了什么结论」，只是不能再把原文翻出来逐行看**。
 * 代价是重放能力随时间衰减 —— 这是显式接受的成本，不是疏忽。
 *
 * ─────────────────────────────────────────────────────────────
 * 默认值是配置，不是硬编码业务逻辑
 * ─────────────────────────────────────────────────────────────
 * 全部来自 DEFAULT_RETENTION_POLICY / 环境变量，实现不做任何删除动作。
 * `planRetention()` 只回答「按当前策略，哪些会被清掉」，不真的清。
 */
import type { Evidence, RawEvidenceKind } from "../evidence/types";

export type RetentionClass = "serpRaw" | "aiRaw" | "siteRaw";

export interface RetentionRule {
  /** null = 永久保留 */
  ttlDays: number | null;
  note: string;
}

export type RetentionPolicy = Record<RetentionClass, RetentionRule>;

/**
 * 默认策略。
 *
 * aiRaw 最长（90d）：AI 回答是短文本，体积小，且它是「模型说了什么」的
 * 唯一凭据 —— 争议发生时最需要回看。
 * serpRaw / siteRaw 30d：体积大，且搜索引擎页面本身变化频繁，
 * 超过一个月的原文对当下决策参考价值有限。
 */
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  serpRaw: { ttlDays: 30, note: "SERP HTML 体积大（单份 ~1.6MB），保留一个月足以覆盖重放需求" },
  aiRaw: { ttlDays: 90, note: "AI 回答体积小且是唯一凭据，保留三个月" },
  siteRaw: { ttlDays: 30, note: "页面 / robots / llms.txt 原文，与 SERP 同一量级" },
};

/** 证据种类 → 保留类别 */
const KIND_CLASS: Record<string, RetentionClass> = {
  serp_html: "serpRaw",
  llm_response: "aiRaw",
  page_html: "siteRaw",
  robots_txt: "siteRaw",
  llms_txt: "siteRaw",
  redirect_resolve: "siteRaw",
};

export function retentionClassOf(kind: RawEvidenceKind | string): RetentionClass {
  return KIND_CLASS[kind] ?? "siteRaw";
}

/** 环境变量覆盖。格式 `serpRaw=7,aiRaw=30,siteRaw=7`，单位天，`-` 表示永久 */
export function retentionPolicyFromEnv(raw?: string): RetentionPolicy {
  const policy: RetentionPolicy = { ...DEFAULT_RETENTION_POLICY };
  const src = raw ?? process.env.GEOKIT_RETENTION;
  if (!src) return policy;
  for (const part of src.split(",")) {
    const [k, v] = part.split("=").map((s) => s.trim());
    if (!k || !v) continue;
    if (!(k in policy)) continue;
    const cls = k as RetentionClass;
    policy[cls] = {
      ttlDays: v === "-" ? null : Number.isFinite(Number(v)) ? Number(v) : DEFAULT_RETENTION_POLICY[cls].ttlDays,
      note: `${policy[cls].note}（由 GEOKIT_RETENTION 覆盖为 ${v}）`,
    };
  }
  return policy;
}

export interface RetentionPlanItem {
  id: string;
  kind: string;
  subject: string;
  retentionClass: RetentionClass;
  observedAt: string;
  /** 到期时间；ttlDays=null 时为 null（永久） */
  expiresAt: string | null;
  /** 会被清理的 blob 路径；未留存 body 时为 null */
  bodyRef: string | null;
}

/**
 * 计算保留计划。**只算不改** —— 不做任何删除动作。
 *
 * 只针对 body blob：metadata 行与 observation 恒为永久，不进入计划。
 */
export function planRetention(
  evidence: readonly Evidence[],
  now: Date = new Date(),
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY
): RetentionPlanItem[] {
  const out: RetentionPlanItem[] = [];
  for (const ev of evidence) {
    const cls = retentionClassOf(ev.kind);
    const rule = policy[cls];
    if (rule.ttlDays === null) continue;

    const t = Date.parse(ev.observedAt);
    if (!Number.isFinite(t)) continue;
    const expiresAt = new Date(t + rule.ttlDays * 86_400_000).toISOString();
    if (Date.parse(expiresAt) > now.getTime()) continue;

    out.push({
      id: ev.id,
      kind: ev.kind,
      subject: ev.subject,
      retentionClass: cls,
      observedAt: ev.observedAt,
      expiresAt,
      bodyRef: ev.bodyRef,
    });
  }
  return out;
}
