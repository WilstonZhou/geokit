/**
 * SqliteStore —— Store 的第二个实现（Phase 1 S8）。
 *
 * ─────────────────────────────────────────────────────────────
 * ★ 它替换的是实现，不是契约
 * ─────────────────────────────────────────────────────────────
 * 本文件**完整实现 `Store` 接口**，语义与 `JsonlStore` 逐条对齐：
 *
 *   Evidence       immutable / append-only / duplicate write 不覆盖
 *   Observation    同 run + 同版本     → materialized replacement（保持原 id）
 *                  不同 run 或不同版本 → 新历史记录
 *                  replaces **只**表示版本演进（S2 冻结语义，此处不重新解释）
 *
 * 查询维度、过滤规则、排序、latestOnly 的取舍全部沿用 JsonlStore 的行为 ——
 * 上层（S7 的 services / route、S6 的 diff）**一行都不用改**。
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么用 node:sqlite 而不是 better-sqlite3
 * ─────────────────────────────────────────────────────────────
 * 设计稿 §9.2 列了三条路径。本机实测（Node 22.22.2）：
 *
 *   A. better-sqlite3   native 模块，需预编译二进制 —— 与「直接依赖仅 4 个」
 *                       这个卖点冲突，且装包/升级都要等轮子
 *   B. node:sqlite      22.22 上**无需 `--experimental-sqlite` flag** 即可
 *                       `require('node:sqlite')`（仅一条 ExperimentalWarning）
 *   C. sql.js 等        WASM，性能与持久化体验最差
 *
 * 于是走 B：**零新增依赖**，同时拿到索引查询与 WAL 并发读。
 * 代价是 Node ≥ 22.5 —— 这条写进文档，不藏在实现里。
 *
 * ─────────────────────────────────────────────────────────────
 * blob 仍然外置文件
 * ─────────────────────────────────────────────────────────────
 * Evidence 正文（page_html / serp_html，单份可达 1.6MB）**不入库**，
 * 仍是 `blobs/<id>.txt`，库里只存 ref。理由见设计稿 §9.1：
 * 大对象进 DB 会让单文件备份变得笨重，而正文的读取模式是「整份取回」，
 * 用不上 SQL 的查询能力。
 *
 * ★ 与 JsonlStore **共用同一个 blob 目录** —— 因此两种驱动可以随时互换，
 *   正文不会跟着实现一起丢。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import type { Evidence, Observation } from "../evidence/types";
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

/** schema 版本。将来改表结构必须 +1 并写迁移，不得就地改列 */
export const SQLITE_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id              TEXT PRIMARY KEY,
  contract_version TEXT NOT NULL,
  kind            TEXT NOT NULL,
  subject         TEXT NOT NULL,
  source          TEXT NOT NULL,
  observed_at     TEXT NOT NULL,
  run_id          TEXT,
  dedupe_key      TEXT,
  body_retained   INTEGER NOT NULL DEFAULT 0,
  data            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_identity ON evidence(subject, source, kind);
CREATE INDEX IF NOT EXISTS idx_evidence_time     ON evidence(observed_at);
CREATE INDEX IF NOT EXISTS idx_evidence_run      ON evidence(run_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_dedupe
  ON evidence(dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS observations (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL,
  subject          TEXT NOT NULL,
  source           TEXT NOT NULL,
  observed_at      TEXT NOT NULL,
  run_id           TEXT,
  status           TEXT NOT NULL,
  observer_version TEXT NOT NULL,
  parser_version   TEXT NOT NULL,
  strategy_version TEXT,
  identity_key     TEXT NOT NULL,
  version_key      TEXT NOT NULL,
  replacement_key  TEXT,
  data             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_identity ON observations(subject, type, source);
CREATE INDEX IF NOT EXISTS idx_obs_time     ON observations(observed_at);
CREATE INDEX IF NOT EXISTS idx_obs_run      ON observations(run_id);
CREATE INDEX IF NOT EXISTS idx_obs_status   ON observations(status);
-- ★ 同 run + 同版本在库里只能有一条 —— materialized replacement 的唯一性
--   由 DB 兜底，而不是靠调用方记得先查一遍
CREATE UNIQUE INDEX IF NOT EXISTS idx_obs_replacement
  ON observations(replacement_key) WHERE replacement_key IS NOT NULL;
`;

function clone<T>(v: T): T {
  return structuredClone(v);
}

function rowidOrder(order: "asc" | "desc"): string {
  // ★ rowid 保留写入顺序，用于复刻 JsonlStore「同时间戳按写入先后」的排序
  return order === "desc" ? "observed_at DESC, rowid DESC" : "observed_at ASC, rowid ASC";
}

interface Clause {
  sql: string;
  params: (string | number)[];
}

export class SqliteStore implements Store {
  private readonly root: string;
  private readonly db: DatabaseSync;

  constructor(root: string) {
    this.root = root;
    mkdirSync(/* turbopackIgnore: true */ root, { recursive: true });
    this.db = new DatabaseSync(join(root, "geokit.db"));
    // WAL：单写多读。JSONL 时代「并发追加互相覆盖」的问题在这里被彻底解决
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(SCHEMA);
    this.db
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)")
      .run(String(SQLITE_SCHEMA_VERSION));
  }

  get dir(): string {
    return this.root;
  }

  get schemaVersion(): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : 0;
  }

  /** 关闭数据库。长驻进程退出前调用，避免 WAL 残留 */
  close(): void {
    this.db.close();
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
    const dedupeKey = this.dedupeKeyOf(ev, opts?.idempotencyKey);
    if (dedupeKey) {
      const hit = this.db
        .prepare("SELECT id FROM evidence WHERE dedupe_key = ?")
        .get(dedupeKey) as { id: string } | undefined;
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

    this.db
      .prepare(
        `INSERT INTO evidence
           (id, contract_version, kind, subject, source, observed_at, run_id, dedupe_key, body_retained, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.contractVersion,
        record.kind,
        record.subject,
        record.source,
        record.observedAt,
        record.runId ?? null,
        dedupeKey ?? null,
        record.response.bodyRetained ? 1 : 0,
        JSON.stringify(record)
      );

    return { id: record.id, created: true };
  }

  async getEvidence(id: string): Promise<Evidence | null> {
    const row = this.db.prepare("SELECT data FROM evidence WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Evidence) : null;
  }

  async listEvidence(q: EvidenceQuery = {}): Promise<Evidence[]> {
    const { sql: where, params } = this.evidenceWhere(q);
    const sql = `SELECT data FROM evidence ${where} ORDER BY ${rowidOrder(q.order ?? "desc")}`;
    const rows = this.db.prepare(sql).all(...params) as { data: string }[];
    const out = rows.map((r) => JSON.parse(r.data) as Evidence);
    return this.applyLimit(out, q.limit);
  }

  private evidenceWhere(q: EvidenceQuery): Clause {
    const w: string[] = ["1 = 1"];
    const p: (string | number)[] = [];
    if (q.subject) {
      w.push("subject = ?");
      p.push(q.subject);
    }
    if (q.source) {
      w.push("source = ?");
      p.push(q.source);
    }
    if (q.kind) {
      w.push("kind = ?");
      p.push(q.kind);
    }
    if (q.runId) {
      w.push("run_id = ?");
      p.push(q.runId);
    }
    if (q.bodyRetained !== undefined) {
      w.push("body_retained = ?");
      p.push(q.bodyRetained ? 1 : 0);
    }
    if (q.from) {
      w.push("observed_at >= ?");
      p.push(q.from);
    }
    if (q.to) {
      w.push("observed_at <= ?");
      p.push(q.to);
    }
    return { sql: `WHERE ${w.join(" AND ")}`, params: p };
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

  async findEvidenceByTimeRange(
    from: string,
    to: string,
    opts: ListOptions = {}
  ): Promise<Evidence[]> {
    return this.listEvidence({ ...opts, from, to });
  }

  /* ---------------------------------------------------------------- */
  /* Observation                                                       */
  /* ---------------------------------------------------------------- */

  async saveObservation(obs: Observation, opts?: SaveObservationOptions): Promise<SaveResult> {
    const identityKey = keyOf(obs.type, obs.subject, obs.source);
    const versionKey = keyOf(obs.observerVersion, obs.parserVersion, obs.strategyVersion ?? "-");
    const replacementKey = obs.runId ? keyOf(identityKey, versionKey, obs.runId) : undefined;

    if (replacementKey) {
      const hit = this.db
        .prepare("SELECT data FROM observations WHERE replacement_key = ?")
        .get(replacementKey) as { data: string } | undefined;
      if (hit) {
        // 同 run + 同版本重算 → materialized replacement，保留 id。
        // replaces 沿用原值：幂等重算不产生新的 replaces 关系，链不增长。
        const prev = JSON.parse(hit.data) as Observation;
        const next: Observation = { ...clone(obs), id: prev.id, identityKey, versionKey, replaces: prev.replaces };
        this.writeObservation(next, identityKey, versionKey, replacementKey);
        return { id: next.id, created: false, replaced: prev.id };
      }
    }

    if (opts?.idempotencyKey) {
      const rows = this.db.prepare("SELECT data FROM observations").all() as { data: string }[];
      const hit = rows
        .map((r) => JSON.parse(r.data) as Observation)
        .find((o) => o.metadata?.extra?.idempotencyKey === opts.idempotencyKey);
      if (hit) return { id: hit.id, created: false, duplicateOf: hit.id };
    }

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
      // ★ replaces 只表示版本演进 —— 不同 run + 同版本是时间推进，不建链
      replaces: versionEvolved ? prevLatest!.id : undefined,
    };

    this.writeObservation(next, identityKey, versionKey, replacementKey);
    return { id, created: true };
  }

  private writeObservation(
    o: Observation,
    identityKey: string,
    versionKey: string,
    replacementKey?: string
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO observations
           (id, type, subject, source, observed_at, run_id, status,
            observer_version, parser_version, strategy_version,
            identity_key, version_key, replacement_key, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        o.id,
        o.type,
        o.subject,
        o.source,
        o.observedAt,
        o.runId ?? null,
        o.status,
        o.observerVersion,
        o.parserVersion,
        o.strategyVersion ?? null,
        identityKey,
        versionKey,
        replacementKey ?? null,
        JSON.stringify(o)
      );
  }

  private latestByIdentity(identityKey: string): Observation | null {
    const row = this.db
      .prepare(
        `SELECT data FROM observations WHERE identity_key = ?
         ORDER BY observed_at DESC, rowid DESC LIMIT 1`
      )
      .get(identityKey) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Observation) : null;
  }

  async getObservation(id: string): Promise<Observation | null> {
    const row = this.db.prepare("SELECT data FROM observations WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Observation) : null;
  }

  async listObservations(q: ObservationQuery = {}): Promise<Observation[]> {
    const w: string[] = ["1 = 1"];
    const p: (string | number)[] = [];
    if (q.type) {
      w.push("type = ?");
      p.push(q.type);
    }
    if (q.subject) {
      w.push("subject = ?");
      p.push(q.subject);
    }
    if (q.source) {
      w.push("source = ?");
      p.push(q.source);
    }
    if (q.runId) {
      w.push("run_id = ?");
      p.push(q.runId);
    }
    if (q.status) {
      w.push("status = ?");
      p.push(q.status);
    }
    if (q.from) {
      w.push("observed_at >= ?");
      p.push(q.from);
    }
    if (q.to) {
      w.push("observed_at <= ?");
      p.push(q.to);
    }

    const rows = this.db
      .prepare(`SELECT data FROM observations WHERE ${w.join(" AND ")} ORDER BY ${rowidOrder(q.order ?? "desc")}`)
      .all(...p) as { data: string }[];
    let out = rows.map((r) => JSON.parse(r.data) as Observation);

    if (q.latestOnly) {
      const seen = new Map<string, Observation>();
      for (const o of out) {
        const k = o.identityKey ?? keyOf(o.type, o.subject, o.source);
        if (!seen.has(k)) seen.set(k, o);
      }
      out = Array.from(seen.values());
    }

    return this.applyLimit(out, q.limit);
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

  /* ---------------------------------------------------------------- */
  /* 迁移辅助（★ 可逆性的落点）                                        */
  /* ---------------------------------------------------------------- */

  /**
   * 从另一个 Store 全量导入。
   *
   * 「换实现」要真的是可逆决策，就必须能带着历史来回搬 ——
   * 否则一换驱动就等于清空历史，那不叫可逆转，那叫二选一。
   *
   * ★ 不删源库任何数据。导入是只读源、只写目标。
   */
  async importFrom(other: Store): Promise<{ evidence: number; observations: number }> {
    let evidence = 0;
    for (const ev of await other.listEvidence({ order: "asc" })) {
      // 已存在同 id 的记录 ⇒ 跳过。导入是幂等的：重复跑不会产生第二条，
      // 也**不会**用新内容覆盖旧记录（Evidence 只增不改）。
      if (await this.getEvidence(ev.id)) continue;
      let body: string | undefined;
      const ref = ev.bodyRef ?? ev.response.bodyRef;
      if (ev.response.bodyRetained && ref && existsSync(/* turbopackIgnore: true */ ref)) {
        try {
          body = readFileSync(/* turbopackIgnore: true */ ref, "utf8");
        } catch {
          body = undefined; // blob 已被清理 —— 只搬 metadata，不伪造正文
        }
      }
      const r = await this.saveEvidence(ev, body ? { body } : undefined);
      if (r.created) evidence += 1;
    }

    let observations = 0;
    for (const o of await other.listObservations({ order: "asc" })) {
      if (await this.getObservation(o.id)) continue; // 同上：幂等
      const r = await this.saveObservation(o);
      if (r.created) observations += 1;
    }

    return { evidence, observations };
  }

  /* ---------------------------------------------------------------- */

  private applyLimit<T>(arr: T[], limit?: number): T[] {
    return limit && limit > 0 ? arr.slice(0, limit) : arr;
  }
}
