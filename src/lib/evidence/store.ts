/**
 * Evidence 存储。
 *
 * 职责边界：**只负责事实留存与追溯，不负责采集。**
 * 它不认识 URL、不会发起任何网络请求。输入只能来自 FetchResult。
 *
 * Phase 0 存储策略：JSONL 追加写 + 可选 body blob 单独落盘。
 * 刻意不做 SQLite schema（那是 Phase 1 的事）—— 现在还没有真实查询需求，
 * 过早定型 schema 只会让表结构跟着 UI 长歪。
 *
 * body 默认只留 hash：
 *   - Phase 0 尚未建立 Observer，暂时用不到重放能力
 *   - 全量留存会让 fixtures 级别的调用迅速撑爆磁盘
 *   需要重放时把 GEOKIT_EVIDENCE_BODY 设为 on 即可，契约不变。
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FetchResult, FetchPurpose } from "../fetcher";
import type { Evidence, EvidenceMetadata, RawEvidence, RawEvidenceKind } from "./types";
import { EVIDENCE_CONTRACT_VERSION } from "./types";
import { redactUrl } from "./redact";
import { deriveSubjectSource, normalizeEvidence } from "./normalize";
import { serpStrategyVersion } from "./identity";

type BodyMode = "on" | "hash-only" | "off";

function bodyMode(): BodyMode {
  const v = (process.env.GEOKIT_EVIDENCE_BODY ?? "hash-only").toLowerCase();
  return v === "on" ? "on" : v === "off" ? "off" : "hash-only";
}

/**
 * 证据落盘目录。默认在项目根的 .evidence 下。
 *
 * 注意 `/* turbopackIgnore: true *\/` 不是装饰：这三个 fs 调用的路径是运行时
 * 决定的（取决于环境变量），Turbopack 无法静态判定，会把整个项目目录当作
 * 潜在依赖 trace 进服务端产物 —— 包括 public/ 和全部源码，产物体积暴增。
 * 加上忽略注释后，打包器不再追踪它们。
 */
function evidenceDir(): string {
  return process.env.GEOKIT_EVIDENCE_DIR ?? join(process.cwd(), ".evidence");
}

/**
 * 开关总闸。默认关闭 —— Phase 0 不主动污染磁盘，
 * 需要追溯时显式开启。设为 off 时 appendRecord 直接返回。
 */
export function evidenceEnabled(): boolean {
  return (process.env.GEOKIT_EVIDENCE ?? "off").toLowerCase() === "on";
}

function evidenceId(): string {
  return `ev_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/**
 * ★ 从 FetchResult 构造 Evidence —— 这是 Fetcher → Evidence 的唯一通道。
 *
 * 不存在「给个 URL 帮我存一下」这种接口，因为那会让 Evidence 越过
 * Fetcher 自己去采集。契约上必须杜绝这种可能。
 *
 * Phase 1 S1：返回值同时含 canonical 字段（subject/source/provenance/…）
 * 与 Phase 0 旧字段（target/request/response/…）。旧读者行为零变化。
 *
 * subject / source 优先取调用方显式传入的值；没有则由
 * `deriveSubjectSource()` 按 purpose 推导 —— 这样 serp / ai 通道即使
 * 不改调用点，也能拿到正确的（而非语义分裂的）identity。
 */
export function evidenceFromFetch(res: FetchResult, kind: RawEvidenceKind): Evidence {
  const mode = bodyMode();
  const retain = mode === "on" && res.body.length > 0;
  const id = evidenceId();
  let bodyRef: string | null = null;

  if (retain) {
    const blobDir = join(evidenceDir(), "blobs");
    bodyRef = join(blobDir, `${id}.txt`);
  }

  const purpose = res.context.purpose as FetchPurpose;
  const engine =
    typeof res.context.meta?.engineId === "string" ? res.context.meta.engineId : undefined;
  const meta = res.context.meta ?? {};

  const identity = res.context.subject && res.context.source
    ? { subject: res.context.subject, source: res.context.source }
    : deriveSubjectSource({
        kind,
        purpose,
        target: res.context.target,
        requestUrl: res.request.url,
        finalUrl: res.finalUrl,
        meta: meta as Record<string, unknown>,
      });

  const legacy: RawEvidence = {
    id,
    contractVersion: EVIDENCE_CONTRACT_VERSION,
    kind,
    target: res.context.target ?? redactUrl(res.finalUrl || res.request.url),
    requestUrl: redactUrl(res.request.url),
    request: {
      method: res.request.method,
      headers: res.request.headers,
      bodyByteLength: 0,
    },
    response: {
      httpStatus: res.status,
      finalUrl: redactUrl(res.finalUrl),
      headers: res.headers,
      bodyHash: res.bodyHash,
      byteLength: res.byteLength,
      bodyRetained: retain,
      bodyRef,
    },
    timing: {
      requestedAt: res.context.requestedAt,
      elapsedMs: res.elapsedMs,
      waitedMs: res.waitedMs,
      attempts: res.attempts.length,
    },
    context: {
      purpose,
      engine,
      meta,
    },
    error: res.error ? { kind: res.error.kind, message: res.error.message } : undefined,
    createdAt: new Date().toISOString(),
  };

  const metadata: EvidenceMetadata = {
    purpose,
    engine,
    strategyVersion: purpose === "serp" ? serpStrategyVersion(engine) : undefined,
    requestedModel: typeof meta.requestedModel === "string" ? meta.requestedModel : undefined,
    servedModel: typeof meta.servedModel === "string" ? meta.servedModel : undefined,
    extra: meta,
  };

  // 走归一化是为了让 canonical 字段的填充规则只有一处实现
  return normalizeEvidence({
    ...legacy,
    subject: identity.subject,
    source: identity.source,
    runId: res.context.runId,
    metadata,
  });
}

/** 追加写一条证据。不可变 —— 没有 update，没有 delete。 */
export function appendRecord(ev: RawEvidence, body?: string): void {
  if (!evidenceEnabled()) return;

  const dir = evidenceDir();
  mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true });

  if (body && ev.response.bodyRetained && ev.response.bodyRef) {
    mkdirSync(/* turbopackIgnore: true */ join(dir, "blobs"), { recursive: true });
    writeFileSync(/* turbopackIgnore: true */ ev.response.bodyRef, body, "utf8");
  }

  const file = join(dir, `raw-${new Date().toISOString().slice(0, 10)}.jsonl`);
  appendFileSync(/* turbopackIgnore: true */ file, JSON.stringify(ev) + "\n", "utf8");
}

/**
 * 采集 + 存证的组合动作。
 *
 * 注意这只是语法糖，不是新职责 —— Evidence 依旧没有发起任何请求，
 * 请求仍由 Fetcher 完成。
 */
export async function recordFetch<K extends RawEvidenceKind>(
  run: () => Promise<FetchResult>,
  kind: K
): Promise<{ result: FetchResult; evidence: RawEvidence | null }> {
  const result = await run();
  if (!evidenceEnabled()) return { result, evidence: null };
  const ev = evidenceFromFetch(result, kind);
  appendRecord(ev, result.body);
  return { result, evidence: ev };
}

export function hasEvidenceFiles(): boolean {
  return existsSync(/* turbopackIgnore: true */ evidenceDir());
}
