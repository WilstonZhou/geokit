/**
 * Observation / CitationRecord 的 zod 运行时校验（T1）。
 *
 * TypeScript 类型只在编译期生效；MCP / HTTP 边界进来的数据无法保证。
 * 本模块是「schema 层强制校验」的唯一实现处：
 *
 *   ★ status ∈ {blocked, unavailable, error, BLOCKED, ERROR, UNOBSERVABLE}
 *     时 statusReason 必填 —— 「抓不到就要说清为什么」，
 *     没有原因的失败状态等于把故障记账成结论。
 *
 * 校验规则刻意只收紧这一处，其余字段保持宽松：
 * Observation 的结构稳定性由 contractVersion / parserVersion 管理，
 * 这里不重复做版本仲裁。
 */
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* 子结构                                                              */
/* ------------------------------------------------------------------ */

export const ExtractedEvidenceSchema = z.object({
  signal: z.string().min(1),
  value: z.unknown(),
  source: z.string().min(1),
  note: z.string().optional(),
});

export type ExtractedEvidenceInput = z.infer<typeof ExtractedEvidenceSchema>;

export const CitationRecordSchema = z.object({
  query: z.string(),
  model: z.string(),
  answerText: z.string(),
  mentioned: z.boolean(),
  mentionContext: z.string().optional(),
  citations: z.array(
    z.object({
      url: z.string(),
      title: z.string().optional(),
      position: z.number().optional(),
    })
  ),
  citationsStatus: z.string(),
  competitorsMentioned: z.array(z.string()),
  observedAt: z.string(),
});

export type CitationRecordInput = z.infer<typeof CitationRecordSchema>;

/* ------------------------------------------------------------------ */
/* statusReason 条件必填                                               */
/* ------------------------------------------------------------------ */

/** 这些状态表示「没能完成观测」，必须携带原因 */
export const STATUSES_REQUIRING_REASON: readonly string[] = [
  "blocked",
  "unavailable",
  "error",
  "BLOCKED",
  "ERROR",
  "UNOBSERVABLE",
];

/** 大写六态 / 小写四态的全集，供校验与 UI 使用 */
export const OBSERVATION_STATUS_VALUES: readonly string[] = [
  "OBSERVED",
  "PARTIAL",
  "INDETERMINATE",
  "MENTIONED",
  "NOT_MENTIONED",
  "BLOCKED",
  "ERROR",
  "UNOBSERVABLE",
  "ok",
  "blocked",
  "unavailable",
  "error",
];

/* ------------------------------------------------------------------ */
/* Observation schema                                                  */
/* ------------------------------------------------------------------ */

export const ObservationSchema = z
  .object({
    id: z.string().min(1),
    contractVersion: z.string().min(1),
    type: z.string().min(1),
    kind: z.string().optional(),
    subject: z.string().min(1),
    target: z.string().optional(),
    source: z.string().min(1),
    observedAt: z.string().min(1),
    runId: z.string().optional(),
    observerVersion: z.string().min(1),
    parserVersion: z.string().min(1),
    strategyVersion: z.string().optional(),
    evidenceRefs: z.array(z.string()),
    status: z.string().min(1),
    statusReason: z.string().optional(),
    result: z.unknown(),
    data: z.unknown().optional(),
    extractedEvidence: z.array(ExtractedEvidenceSchema).optional(),
    confidence: z.enum(["high", "medium", "low", "unavailable"]),
    coverage: z.object({
      expected: z.number(),
      observed: z.number(),
      ratio: z.number(),
      missing: z.array(z.string()).optional(),
    }),
    metadata: z.record(z.string(), z.unknown()),
    caveat: z.string().optional(),
    replaces: z.string().optional(),
    identityKey: z.string().optional(),
    versionKey: z.string().optional(),
  })
  .superRefine((o, ctx) => {
    if (
      STATUSES_REQUIRING_REASON.includes(o.status) &&
      (!o.statusReason || o.statusReason.trim().length === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["statusReason"],
        message: `status=${o.status} 时 statusReason 必填 —— 抓不到就要说清为什么`,
      });
    }
  });

export type ObservationInput = z.input<typeof ObservationSchema>;

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

/** 校验一条 Observation。失败时返回可读的错误聚合（字段路径 + 原因） */
export function validateObservation(o: unknown): ValidationResult {
  const r = ObservationSchema.safeParse(o);
  if (r.success) return { ok: true };
  return {
    ok: false,
    error: r.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; "),
  };
}

/** 校验失败直接抛错 —— 用于「数据不合法就不该落库」的生产路径 */
export function assertValidObservation(o: unknown): void {
  const r = validateObservation(o);
  if (!r.ok) throw new Error(`Observation 校验失败：${r.error}`);
}
