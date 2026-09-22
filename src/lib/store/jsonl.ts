/**
 * JsonlStore —— Store 的第一个实现（Phase 1 S2）。
 *
 * ─────────────────────────────────────────────────────────────
 * 它存在的唯一目的
 * ─────────────────────────────────────────────────────────────
 * **验证 Contract 与查询语义**，不是当生产数据库用。
 *
 * 追加写 JSONL + 全量扫描：查询是 O(n)，几万条以上会明显变慢。
 * Phase 1b 换 SQLite 时，只要 `Store` 接口不变，调用方一行不用改 ——
 * 这正是「先定接口」的意义。选型错误可回滚。
 *
 * ─────────────────────────────────────────────────────────────
 * 目录布局（与 Phase 0 兼容）
 * ─────────────────────────────────────────────────────────────
 *   <root>/
 *     raw-YYYY-MM-DD.jsonl    Evidence（Phase 0 同名同格式，旧文件可直接读）
 *     blobs/<id>.txt          body 原文
 *     observations.jsonl      Observation
 *
 * ─────────────────────────────────────────────────────────────
 * 持久化语义（★ 契约，换 SQLite / 做 Diff 时不得重新解释）
 * ─────────────────────────────────────────────────────────────
 * 两套语义，**不共用一条规则**：
 *
 *   Evidence
 *     immutable / append-only
 *     duplicate write 不覆盖原 Evidence
 *     → `raw-*.jsonl` 只追加、从不重写
 *
 *   Observation
 *     Evidence 的派生 materialized result
 *     → `observations.jsonl` 是**物化投影**，允许整体重写；
 *       重写不改变历史语义，只发生在下面两种情况：
 *         同 runId + 同版本   → materialized replacement（保持原 id）
 *         不同 runId / 不同版本 → 追加新记录，历史完整保留
 *
 * 不要从 Observation 的 replacement 反推「文件可覆盖、历史可改」，
 * 也不要拿 Evidence 的 append-only 去要求 Observation 不可重写 ——
 * 二者管的是不同性质的东西：事实 vs 结论。
 *
 * ─────────────────────────────────────────────────────────────
 * Evidence 幂等策略（重要）
 * ─────────────────────────────────────────────────────────────
 * 去重作用域 = **runId**。
 *
 *   有 runId   → 同一批次内「同 subject/source/内容」只存一条，重复写返回已有 id
 *   无 runId   → 不去重，每次都追加
 *
 * 为什么无 runId 就不去重：没有 runId 时无法区分「同一次观测的重试」和
 * 「新的一次观测」。若强行按内容去重，今天和明天抓到同一份 SERP HTML
 * 会被合并成一条 —— 时间维度直接没了。宁可多存，不可错合。
 *
 * 逃逸口：调用方可显式传 idempotencyKey 强制去重。
 *
 * ─────────────────────────────────────────────────────────────
 * Observation materialized replacement（★ 契约）
 * ─────────────────────────────────────────────────────────────
 *   同 runId + 同版本（observer/parser/strategy）
 *     → materialized replacement：**保持原 id**
 *       同一批次里同一个观测被重算，逻辑上就是同一条记录
 *       被替换掉的是这条记录的中间态，不是一条独立历史 —— 所以不算删除
 *   不同 runId 或不同版本
 *     → 追加新记录，历史完整保留
 *       新记录带 `replaces` 指向被它取代的那条，便于将来做口径迁移
 *
 * 与 Evidence 无关：这一过程只读 Evidence 的 id，不写、不删任何 Evidence。
 *
 * ─────────────────────────────────────────────────────────────
 * replaces 语义边界（★ 契约）
 * ─────────────────────────────────────────────────────────────
 *   同 identity + 同三元组 + 同 run
 *     → idempotent replacement，**不产生新的 replaces 关系**
 *       （沿用原记录的 replaces，链不增长）
 *   observerVersion / parserVersion / strategyVersion 任一变化
 *     → 新 Observation，`replaces` 指向被它取代的那条
 *   不同 run + 同版本
 *     → 新历史记录，但**不建 replaces**（那是时间推进，不是版本演进）
 *
 *   replaces 表示「版本演进」，不表示普通 retry，也不表示重复写入。
 *
 * 已知限制：单进程。跨进程并发写不做协调（JSONL 本就不是为此设计的）。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { Evidence, Observation } from "../evidence/types";
import { normalizeEvidence } from "../evidence/normalize";
import { keyOf } from "./hash";
import type {
  EvidenceQuery,
  ListOptions,
  ObservationQuery,
  SaveEvidenceOptions,
  SaveObservationOptions,
  SaveResult,
  Store,
} from "./types";

const EVIDENCE_PREFIX = "raw-";
const EVIDENCE_SUFFIX = ".jsonl";
const OBSERVATIONS_FILE = "observations.jsonl";

function clone<T>(v: T): T {
  return structuredClone(v);
}

function dayOf(iso: string): string {
  const t = Date.parse(iso);
  return (Number.isFinite(t) ? new Date(t) : new Date()).toISOString().slice(0, 10);
}

function cmpIso(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class JsonlStore implements Store {
  private readonly root: string;

  private evidenceLoaded = false;
  private evidence: Evidence[] = [];

  private observationsLoaded = false;
  private observations: Observation[] = [];

  constructor(root: string) {
    this.root = root;
  }

  get dir(): string {
    return this.root;
  }

  /* ---------------------------------------------------------------- */
  /* 加载                                                               */
  /* ---------------------------------------------------------------- */

  private ensureEvidence(): void {
    if (this.evidenceLoaded) return;
    this.evidence = [];
    if (existsSync(/* turbopackIgnore: true */ this.root)) {
      const files = readdirSync(/* turbopackIgnore: true */ this.root)
        .filter((f) => f.startsWith(EVIDENCE_PREFIX) && f.endsWith(EVIDENCE_SUFFIX))
        .sort();
      for (const f of files) {
        const raw = readFileSync(/* turbopackIgnore: true */ join(this.root, f), "utf8");
        for (const line of raw.split("\n")) {
          const s = line.trim();
          if (!s) continue;
          try {
            this.evidence.push(normalizeEvidence(JSON.parse(s)));
          } catch {
            // 坏行跳过而不是让整个 store 不可用 —— 一条坏数据不该毁掉全部历史
          }
        }
      }
    }
    this.evidenceLoaded = true;
  }

  private ensureObservations(): void {
    if (this.observationsLoaded) return;
    this.observations = [];
    const file = join(this.root, OBSERVATIONS_FILE);
    if (existsSync(/* turbopackIgnore: true */ file)) {
      const raw = readFileSync(/* turbopackIgnore: true */ file, "utf8");
      for (const line of raw.split("\n")) {
        const s = line.trim();
        if (!s) continue;
        try {
          this.observations.push(JSON.parse(s) as Observation);
        } catch {
          /* 同上 */
        }
      }
    }
    this.observationsLoaded = true;
  }

  private ensureDir(): void {
    mkdirSync(/* turbopackIgnore: true */ this.root, { recursive: true });
  }

  /* ---------------------------------------------------------------- */
  /* Evidence                                                          */
  /* ---------------------------------------------------------------- */

  private dedupeKeyOf(ev: Evidence, explicit?: string): string | undefined {
    if (explicit) return keyOf("explicit", explicit);
    if (!ev.runId) return undefined;
    return keyOf(ev.kind, ev.subject, ev.source, ev.provenance.requestUrl, ev.contentHash, ev.runId);
  }

  async saveEvidence(ev: Evidence, opts?: SaveEvidenceOptions): Promise<SaveResult> {
    this.ensureDir();
    this.ensureEvidence();

    const dedupeKey = this.dedupeKeyOf(ev, opts?.idempotencyKey);
    if (dedupeKey) {
      const hit = this.evidence.find((e) => e.dedupeKey === dedupeKey);
      if (hit) return { id: hit.id, created: false, duplicateOf: hit.id };
    }

    const record = clone(ev);
    record.dedupeKey = dedupeKey;

    if (opts?.body && record.response.bodyRetained) {
      const blobDir = join(this.root, "blobs");
      mkdirSync(/* turbopackIgnore: true */ blobDir, { recursive: true });
      const blobPath = join(blobDir, `${record.id}.txt`);
      writeFileSync(/* turbopackIgnore: true */ blobPath, opts.body, "utf8");
      record.bodyRef = blobPath;
      record.response.bodyRef = blobPath;
    }

    this.evidence.push(record);
    const file = join(this.root, `${EVIDENCE_PREFIX}${dayOf(record.observedAt)}${EVIDENCE_SUFFIX}`);
    appendFileSync(/* turbopackIgnore: true */ file, JSON.stringify(record) + "\n", "utf8");
    return { id: record.id, created: true };
  }

  async getEvidence(id: string): Promise<Evidence | null> {
    this.ensureEvidence();
    const hit = this.evidence.find((e) => e.id === id);
    return hit ? clone(hit) : null;
  }

  async listEvidence(q: EvidenceQuery = {}): Promise<Evidence[]> {
    this.ensureEvidence();
    let out = this.evidence.filter((e) => {
      if (q.subject && e.subject !== q.subject) return false;
      if (q.source && e.source !== q.source) return false;
      if (q.kind && e.kind !== q.kind) return false;
      if (q.runId && e.runId !== q.runId) return false;
      if (q.bodyRetained !== undefined && e.response.bodyRetained !== q.bodyRetained) return false;
      if (q.from && cmpIso(e.observedAt, q.from) < 0) return false;
      if (q.to && cmpIso(e.observedAt, q.to) > 0) return false;
      return true;
    });
    out = sortBy(out, q.order ?? "desc", (e) => e.observedAt);
    return applyLimit(out, q.limit).map(clone);
  }

  async findEvidenceBySubject(subject: string, opts: ListOptions = {}): Promise<Evidence[]> {
    return this.listEvidence({ ...opts, subject });
  }

  async findEvidenceBySource(source: string, opts: ListOptions = {}): Promise<Evidence[]> {
    return this.listEvidence({ ...opts, source });
  }

  async findEvidenceByRun(runId: string, opts: ListOptions = {}): Promise<Evidence[]> {
    return this.listEvidence({ ...opts, runId });
  }

  async findEvidenceByTimeRange(from: string, to: string, opts: ListOptions = {}): Promise<Evidence[]> {
    return this.listEvidence({ ...opts, from, to });
  }

  /* ---------------------------------------------------------------- */
  /* Observation                                                       */
  /* ---------------------------------------------------------------- */

  async saveObservation(obs: Observation, opts?: SaveObservationOptions): Promise<SaveResult> {
    this.ensureDir();
    this.ensureObservations();

    const identityKey = keyOf(obs.type, obs.subject, obs.source);
    const versionKey = keyOf(obs.observerVersion, obs.parserVersion, obs.strategyVersion ?? "-");
    const replacementKey = obs.runId ? keyOf(identityKey, versionKey, obs.runId) : undefined;

    const prevSameSlot = replacementKey
      ? this.observations.findIndex((o) => this.replacementKeyOf(o) === replacementKey)
      : -1;

    if (prevSameSlot >= 0) {
      // 同 run + 同版本重算 → materialized replacement，保留 id。
      // 它是同一条观测的中间态被刷新，不是一条新历史，也绝不触碰 Evidence。
      //
      // replaces 沿用原值：幂等重算**不产生新的 replaces 关系**，链不增长。
      const prev = this.observations[prevSameSlot]!;
      const next: Observation = {
        ...clone(obs),
        id: prev.id,
        identityKey,
        versionKey,
        replaces: prev.replaces,
      };
      this.observations[prevSameSlot] = next;
      this.flushObservations();
      return { id: next.id, created: false, replaced: prev.id };
    }

    // 显式幂等键：存在同键记录则不重复写。键存进 metadata.extra 才能被重新读出
    if (opts?.idempotencyKey) {
      const hit = this.observations.find(
        (o) => o.metadata?.extra?.idempotencyKey === opts.idempotencyKey
      );
      if (hit) return { id: hit.id, created: false, duplicateOf: hit.id };
    }

    // ★ replaces 只表示「版本演进」：仅当上一条是用**不同版本三元组**算出来的，
    //   本条才算取代了它。
    //
    //   不同 run + 同版本 = 新一次观测（时间推进），不是版本演进 —— **不建链**。
    //   否则 replaces 会退化成「最新指针」，把时间维度和版本维度混在一起，
    //   S6 Diff 就没法用它做口径迁移判定。
    const prevLatest = this.latestByIdentity(identityKey);
    const prevVersion = prevLatest
      ? prevLatest.versionKey ??
        keyOf(prevLatest.observerVersion, prevLatest.parserVersion, prevLatest.strategyVersion ?? "-")
      : undefined;
    const versionEvolved = Boolean(prevLatest) && prevVersion !== versionKey;
    const id = obs.id || `obs_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const next: Observation = {
      ...clone(obs),
      id,
      identityKey,
      versionKey,
      metadata: opts?.idempotencyKey
        ? { ...obs.metadata, extra: { ...obs.metadata?.extra, idempotencyKey: opts.idempotencyKey } }
        : obs.metadata,
      replaces: versionEvolved ? prevLatest!.id : undefined,
    };

    this.observations.push(next);
    appendFileSync(
      /* turbopackIgnore: true */ join(this.root, OBSERVATIONS_FILE),
      JSON.stringify(next) + "\n",
      "utf8"
    );
    return { id: next.id, created: true };
  }

  private replacementKeyOf(o: Observation): string | undefined {
    if (!o.runId) return undefined;
    const ik = o.identityKey ?? keyOf(o.type, o.subject, o.source);
    const vk = o.versionKey ?? keyOf(o.observerVersion, o.parserVersion, o.strategyVersion ?? "-");
    return keyOf(ik, vk, o.runId);
  }

  private latestByIdentity(identityKey: string): Observation | null {
    let best: Observation | null = null;
    for (const o of this.observations) {
      if ((o.identityKey ?? keyOf(o.type, o.subject, o.source)) !== identityKey) continue;
      if (!best || cmpIso(o.observedAt, best.observedAt) >= 0) best = o;
    }
    return best;
  }

  /** 整体重写 observations 文件。先写临时文件再 rename，避免中断留下半截文件 */
  private flushObservations(): void {
    const file = join(this.root, OBSERVATIONS_FILE);
    const tmp = `${file}.tmp`;
    writeFileSync(
      /* turbopackIgnore: true */ tmp,
      this.observations.map((o) => JSON.stringify(o)).join("\n") + "\n",
      "utf8"
    );
    renameSync(/* turbopackIgnore: true */ tmp, file);
  }

  async getObservation(id: string): Promise<Observation | null> {
    this.ensureObservations();
    const hit = this.observations.find((o) => o.id === id);
    return hit ? clone(hit) : null;
  }

  async listObservations(q: ObservationQuery = {}): Promise<Observation[]> {
    this.ensureObservations();
    let out = this.observations.filter((o) => {
      if (q.type && o.type !== q.type) return false;
      if (q.subject && o.subject !== q.subject) return false;
      if (q.source && o.source !== q.source) return false;
      if (q.runId && o.runId !== q.runId) return false;
      if (q.status && o.status !== q.status) return false;
      if (q.from && cmpIso(o.observedAt, q.from) < 0) return false;
      if (q.to && cmpIso(o.observedAt, q.to) > 0) return false;
      return true;
    });

    out = sortBy(out, q.order ?? "desc", (o) => o.observedAt);

    if (q.latestOnly) {
      const seen = new Map<string, Observation>();
      // out 已排序，先出现的即最新 —— 保留先出现的
      for (const o of out) {
        const k = o.identityKey ?? keyOf(o.type, o.subject, o.source);
        if (!seen.has(k)) seen.set(k, o);
      }
      out = Array.from(seen.values());
    }

    return applyLimit(out, q.limit).map(clone);
  }

  async findObservationsBySubject(
    subject: string,
    opts: Omit<ObservationQuery, "subject"> = {}
  ): Promise<Observation[]> {
    return this.listObservations({ ...opts, subject });
  }

  async findObservationsBySource(
    source: string,
    opts: Omit<ObservationQuery, "source"> = {}
  ): Promise<Observation[]> {
    return this.listObservations({ ...opts, source });
  }

  async findObservationsByRun(
    runId: string,
    opts: Omit<ObservationQuery, "runId"> = {}
  ): Promise<Observation[]> {
    return this.listObservations({ ...opts, runId });
  }

  async findObservationsByTimeRange(
    from: string,
    to: string,
    opts: Omit<ObservationQuery, "from" | "to"> = {}
  ): Promise<Observation[]> {
    return this.listObservations({ ...opts, from, to });
  }
}

function sortBy<T>(arr: T[], order: "asc" | "desc", key: (v: T) => string): T[] {
  const out = [...arr].sort((a, b) => cmpIso(key(a), key(b)));
  return order === "desc" ? out.reverse() : out;
}

function applyLimit<T>(arr: T[], limit?: number): T[] {
  return limit && limit > 0 ? arr.slice(0, limit) : arr;
}
