/**
 * 归一化层 —— 把磁盘上的记录统一成 canonical `Evidence`。
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么需要它
 * ─────────────────────────────────────────────────────────────
 * Phase 0 已冻结，磁盘上可能已经存在 contractVersion=0.1.0 的 Evidence。
 * 它们没有 subject / source / provenance / contentHash / bodyRef / metadata。
 *
 * 要求是「不删除旧 Evidence 文件」。因此不重写存量，而是在**读取时**归一化：
 *
 *   磁盘 raw-*.jsonl  →  normalizeEvidence()  →  Evidence（字段必定齐全）
 *
 * 好处是迁移零成本、可逆，且旧文件保持字节级不变（它是证据，本就不该被改写）。
 *
 * ─────────────────────────────────────────────────────────────
 * 兼容性策略
 * ─────────────────────────────────────────────────────────────
 *   写入：新记录同时写 subject/source **和** 旧 target
 *         → 旧读者行为零变化，新读者拿到 canonical
 *   读取：缺失 canonical 字段 → 按 purpose + target + meta 推导
 *         → 推导结果带 `migratedFrom`，可统计存量勿误判为新数据
 */
import type { FetchPurpose } from "../fetcher";
import type { Evidence, EvidenceMetadata, EvidenceProvenance, RawEvidence } from "./types";
import { LEGACY_EVIDENCE_CONTRACT_VERSION } from "./types";
import {
  aiSlotSubject,
  httpSource,
  providerSource,
  searchEngineSource,
  searchSubject,
  serpStrategyVersion,
  siteSubject,
} from "./identity";

/**
 * 归一化输入：**字段一律可选**。
 *
 * 磁盘上的 JSON 不可信 —— 可能是 Phase 0 的旧记录，也可能被外部改过。
 * 用 Partial 强制本函数对每一个字段都做存在性处理。
 */
export type EvidenceLike = Partial<Evidence> & { id?: string; kind?: string };

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function record(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
    else if (typeof val === "number" || typeof val === "boolean") out[k] = String(val);
  }
  return out;
}

function extraOf(v: unknown): Record<string, string | number | boolean | undefined> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, string | number | boolean | undefined> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (
      typeof val === "string" ||
      typeof val === "number" ||
      typeof val === "boolean" ||
      val === undefined
    ) {
      out[k] = val;
    }
  }
  return out;
}

/**
 * 从采集上下文推导 subject / source。
 *
 * 这是 Phase 0 「一个 target 两种语义」的修复点：此处按 purpose 明确判定
 * target 到底是「被观测对象」还是「观测来源」。
 *
 *   serp      target = 引擎 id        → 它是 source
 *   其余      target = URL            → 它是 subject
 *   ai        target = provider id    → 它是 source；subject 来自 meta 的槽位
 */
export function deriveSubjectSource(ctx: {
  kind?: string;
  purpose?: FetchPurpose | string;
  target?: string;
  requestUrl?: string;
  finalUrl?: string;
  meta?: Record<string, unknown>;
}): { subject: string; source: string } {
  const meta = (ctx.meta ?? {}) as Record<string, unknown>;
  const target = ctx.target ?? "";
  const url = ctx.finalUrl || ctx.requestUrl || target;

  if (ctx.purpose === "serp") {
    const engineId = str(meta.engineId, target);
    const keyword = str(meta.keyword);
    const siteUrl = typeof meta.siteUrl === "string" ? meta.siteUrl : undefined;
    return {
      subject: searchSubject(siteUrl ?? null, keyword),
      source: searchEngineSource(engineId),
    };
  }

  if (ctx.purpose === "ai-visibility") {
    const providerId = str(meta.providerId, target);
    const requestedModel = str(meta.requestedModel, "unknown");
    return {
      subject: aiSlotSubject(providerId, requestedModel),
      source: providerSource(providerId),
    };
  }

  // audit / robots / llms / resolve-redirect：target 与 URL 都是被观测对象
  const siteUrl = target || url;
  return { subject: siteSubject(siteUrl), source: httpSource(url || siteUrl) };
}

/** 判定是否旧契约记录（缺 canonical 字段） */
export function isLegacyEvidence(ev: EvidenceLike): boolean {
  return !ev.subject || !ev.source || !ev.provenance;
}

/**
 * 归一化一条记录。
 *
 * 对已经是 canonical 的记录：原样补全后返回（不覆盖已有值）。
 * 对旧记录：从 request / response / timing / context 推导全部 canonical 字段。
 */
export function normalizeEvidence(raw: EvidenceLike): Evidence {
  const request = (raw.request ?? {}) as RawEvidence["request"];
  const response = (raw.response ?? {}) as RawEvidence["response"];
  const timing = (raw.timing ?? {}) as RawEvidence["timing"];
  const context = (raw.context ?? {}) as RawEvidence["context"];
  const error = raw.error as RawEvidence["error"];

  const purpose = (context?.purpose ?? "audit") as FetchPurpose;
  const engine = str(context?.engine) || undefined;

  const legacy = isLegacyEvidence(raw);
  const derived = legacy
    ? deriveSubjectSource({
        kind: raw.kind,
        purpose,
        target: raw.target,
        requestUrl: raw.requestUrl,
        finalUrl: response?.finalUrl,
        meta: context?.meta as Record<string, unknown> | undefined,
      })
    : { subject: str(raw.subject), source: str(raw.source) };

  const metaExtra = extraOf(context?.meta);

  const metadata: EvidenceMetadata = legacy
    ? {
        purpose,
        engine,
        strategyVersion:
          purpose === "serp" ? serpStrategyVersion(engine ?? str(context?.meta?.engineId)) : undefined,
        requestedModel:
          typeof metaExtra.requestedModel === "string" ? metaExtra.requestedModel : undefined,
        servedModel: typeof metaExtra.servedModel === "string" ? metaExtra.servedModel : undefined,
        extra: metaExtra,
      }
    : normalizeMetadata(raw.metadata as EvidenceMetadata | undefined, purpose, engine, metaExtra);

  const provenance: EvidenceProvenance = raw.provenance ?? {
    method: str(request?.method, "GET"),
    requestUrl: str(raw.requestUrl),
    finalUrl: str(response?.finalUrl),
    httpStatus: num(response?.httpStatus),
    requestHeaders: record(request?.headers),
    responseHeaders: record(response?.headers),
    requestedAt: str(timing?.requestedAt, str(raw.createdAt, new Date(0).toISOString())),
    elapsedMs: num(timing?.elapsedMs),
    waitedMs: num(timing?.waitedMs),
    attempts: num(timing?.attempts),
    error: error ? { kind: str(error.kind), message: str(error.message) } : undefined,
  };

  return {
    // ── 旧契约字段原样保留，旧读者行为零变化 ──
    id: str(raw.id),
    contractVersion: str(raw.contractVersion, LEGACY_EVIDENCE_CONTRACT_VERSION),
    kind: (raw.kind ?? "page_html") as RawEvidence["kind"],
    target: str(raw.target),
    requestUrl: str(raw.requestUrl),
    request: {
      method: str(request?.method, "GET"),
      headers: record(request?.headers),
      bodyByteLength: num(request?.bodyByteLength),
    },
    response: {
      httpStatus: num(response?.httpStatus),
      finalUrl: str(response?.finalUrl),
      headers: record(response?.headers),
      bodyHash: str(response?.bodyHash),
      byteLength: num(response?.byteLength),
      bodyRetained: Boolean(response?.bodyRetained),
      bodyRef: (response?.bodyRef ?? null) as string | null,
    },
    timing: {
      requestedAt: str(timing?.requestedAt),
      elapsedMs: num(timing?.elapsedMs),
      waitedMs: num(timing?.waitedMs),
      attempts: num(timing?.attempts),
    },
    context: {
      purpose,
      engine,
      note: context?.note,
      meta: metaExtra,
    },
    error: error ? { kind: str(error.kind), message: str(error.message) } : undefined,
    createdAt: str(raw.createdAt, new Date(0).toISOString()),

    // ── canonical 字段 ──
    subject: derived.subject,
    source: derived.source,
    observedAt: str(raw.observedAt, str(timing?.requestedAt, str(raw.createdAt))),
    status: num(response?.httpStatus),
    provenance,
    contentHash: str(raw.contentHash, str(response?.bodyHash)),
    bodyRef: raw.bodyRef !== undefined ? (raw.bodyRef as string | null) : ((response?.bodyRef ?? null) as string | null),
    metadata,
    runId: raw.runId,
    dedupeKey: raw.dedupeKey,
    migratedFrom: legacy ? str(raw.contractVersion, LEGACY_EVIDENCE_CONTRACT_VERSION) : raw.migratedFrom,
  };
}

function normalizeMetadata(
  m: EvidenceMetadata | undefined,
  purpose: FetchPurpose,
  engine: string | undefined,
  fallbackExtra: Record<string, string | number | boolean | undefined>
): EvidenceMetadata {
  return {
    purpose: m?.purpose ?? purpose,
    engine: m?.engine ?? engine,
    strategyVersion: m?.strategyVersion,
    requestedModel: m?.requestedModel,
    servedModel: m?.servedModel,
    extra: m?.extra ?? fallbackExtra,
  };
}
