/**
 * S8 / SqliteStore 契约测试（零新增依赖）。
 *
 * ★ 核心不是「SQLite 能存」，而是**换实现后行为不变**：
 *   同一批输入分别写进 JsonlStore 与 SqliteStore，所有查询必须给出一致结果。
 *
 * 覆盖：
 *   1  基础读写      Evidence / Observation 落库回读、blob 外置
 *   2  Evidence 语义  append-only · 重复写不覆盖 · dedupe 命中 · idempotencyKey
 *   3  Observation   同 run+同版本 → 替换保 id · 不同 run → 新历史 ·
 *                    版本演进 → replaces 链 · idempotencyKey
 *   4  查询          全维度过滤 / 排序 / limit / latestOnly
 *   5  ★ 奇偶一致    与 JsonlStore 逐项比对（换实现不改行为）
 *   6  持久化        重新打开实例后数据仍在
 *   7  驱动切换      GEOKIT_STORE_DRIVER=sqlite 才换实现，默认仍是 jsonl
 *   8  importFrom    jsonl → sqlite 全量搬迁，源库不减
 *
 * 用法：npx tsx scripts/test-sqlite-store.ts
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonlStore } from "../src/lib/store/jsonl";
import { SqliteStore, SQLITE_SCHEMA_VERSION } from "../src/lib/store/sqlite";
import { createStore } from "../src/lib/store";
import type { EvidenceQuery, ObservationQuery } from "../src/lib/store/types";
import type { Evidence, Observation } from "../src/lib/evidence/types";
import { OBSERVATION_CONTRACT_VERSION } from "../src/lib/evidence/types";

/* ------------------------------------------------------------------ */
/* 极简断言框架                                                         */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures: { group: string; name: string; detail: string }[] = [];
let group = "";

function section(name: string): void {
  group = name;
  console.log(`\n── ${name} ──`);
}

function check(name: string, pass: boolean, detail = ""): void {
  if (pass) {
    passed++;
    console.log(`  ✅ ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ""}`);
  } else {
    failures.push({ group, name, detail });
    console.log(`  ❌ ${name}  \x1b[31m${detail}\x1b[0m`);
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(
    name,
    ok,
    ok ? `${JSON.stringify(actual)}` : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`
  );
}

/**
 * 递归排序 key 后序列化 —— 两个实现写出的字段顺序可能不同，语义相同即可。
 *
 * ★ 刻意忽略值为 `undefined` 的键：JsonlStore 在**同一进程内**返回的是内存对象
 *   （`structuredClone` 保留了 `replaces: undefined` 这类键），而任何经过
 *   JSON 落盘再读回的实现都不会有这些键。二者语义完全等价，
 *   不能因为键的存在性差异就判定「换实现改变了行为」。
 */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/* ------------------------------------------------------------------ */
/* 夹具                                                                 */
/* ------------------------------------------------------------------ */

const TMP = mkdtempSync(join(tmpdir(), "geokit-sqlite-store-"));

function ev(
  partial: Omit<Partial<Evidence>, "response"> & {
    id: string;
    response?: Partial<Evidence["response"]>;
  }
): Evidence {
  const id = partial.id;
  const requestedAt = partial.observedAt ?? "2026-09-22T00:00:00.000Z";
  return {
    id,
    contractVersion: "0.2.0",
    kind: partial.kind ?? "page_html",
    target: partial.target ?? "site:https://example.com/",
    requestUrl: partial.requestUrl ?? "https://example.com/",
    request: { method: "GET", headers: {}, bodyByteLength: 0 },
    response: {
      httpStatus: 200,
      finalUrl: "https://example.com/",
      headers: {},
      bodyHash: `hash_${id}`,
      byteLength: 100,
      bodyRetained: false,
      bodyRef: null,
      ...(partial.response ?? {}),
    },
    timing: { requestedAt, elapsedMs: 10, waitedMs: 0, attempts: 1 },
    context: { purpose: "audit" },
    createdAt: requestedAt,
    subject: partial.subject ?? "site:https://example.com",
    source: partial.source ?? "http:https://example.com",
    observedAt: requestedAt,
    status: partial.status ?? 200,
    provenance: {
      method: "GET",
      requestUrl: "https://example.com/",
      finalUrl: "https://example.com/",
      httpStatus: 200,
      requestHeaders: {},
      responseHeaders: {},
      requestedAt,
      elapsedMs: 10,
      waitedMs: 0,
      attempts: 1,
      ...(partial.provenance ?? {}),
    },
    contentHash: partial.contentHash ?? `hash_${id}`,
    bodyRef: partial.bodyRef ?? null,
    metadata: partial.metadata ?? { purpose: "audit", extra: {} },
    runId: partial.runId,
  };
}

function obs(partial: Partial<Observation> & { id?: string }): Observation {
  return {
    id: partial.id ?? "",
    contractVersion: OBSERVATION_CONTRACT_VERSION,
    type: partial.type ?? "ai_mention",
    subject: partial.subject ?? "ai-slot:deepseek:deepseek-chat",
    source: partial.source ?? "provider:deepseek",
    observedAt: partial.observedAt ?? "2026-09-22T00:00:00.000Z",
    runId: partial.runId,
    observerVersion: partial.observerVersion ?? "ai-observer@0.1.0",
    parserVersion: partial.parserVersion ?? "ai-visibility@0.1.0",
    strategyVersion: partial.strategyVersion,
    evidenceRefs: partial.evidenceRefs ?? ["ev_1"],
    status: partial.status ?? "MENTIONED",
    result: partial.result ?? { mentioned: true },
    confidence: partial.confidence ?? "medium",
    coverage: partial.coverage ?? { expected: 1, observed: 1, ratio: 1 },
    metadata: partial.metadata ?? { extra: {} },
  };
}

/** 一批用于奇偶比对的输入 */
const EVIDENCE_FIXTURES: Evidence[] = [
  ev({ id: "ev_1", kind: "page_html", observedAt: "2026-09-20T01:00:00.000Z", runId: "run-a" }),
  ev({ id: "ev_2", kind: "serp_html", observedAt: "2026-09-21T01:00:00.000Z", runId: "run-a", source: "search-engine:baidu", subject: "search:site=https://example.com|q=x" }),
  ev({ id: "ev_3", kind: "llm_response", observedAt: "2026-09-22T01:00:00.000Z", source: "provider:deepseek", subject: "ai-slot:deepseek:deepseek-chat" }),
];

const OBSERVATION_FIXTURES: Observation[] = [
  obs({ id: "obs_1", observedAt: "2026-09-20T01:00:00.000Z", status: "UNOBSERVABLE" }),
  obs({ id: "obs_2", observedAt: "2026-09-21T01:00:00.000Z", status: "NOT_MENTIONED", runId: "run-a" }),
  obs({ id: "obs_3", observedAt: "2026-09-22T01:00:00.000Z", status: "MENTIONED", runId: "run-b" }),
  obs({ id: "obs_4", observedAt: "2026-09-22T02:00:00.000Z", status: "MENTIONED", type: "rank", subject: "search:site=https://example.com|q=x", source: "search-engine:baidu", strategyVersion: "baidu-mu@1" }),
];

const OBS_QUERIES: ObservationQuery[] = [
  {},
  { order: "asc" },
  { subject: "ai-slot:deepseek:deepseek-chat" },
  { source: "search-engine:baidu" },
  { type: "rank" },
  { status: "MENTIONED" },
  { runId: "run-a" },
  { from: "2026-09-21T00:00:00.000Z", to: "2026-09-22T01:30:00.000Z" },
  { limit: 2 },
  { latestOnly: true },
];

const EV_QUERIES: EvidenceQuery[] = [
  {},
  { order: "asc" },
  { kind: "serp_html" },
  { subject: "ai-slot:deepseek:deepseek-chat" },
  { source: "search-engine:baidu" },
  { runId: "run-a" },
  { bodyRetained: false },
  { limit: 1 },
];

async function main(): Promise<void> {
  /** 打开着的实例 —— Windows 上不 close 就删不掉 .db 文件 */
  const open: SqliteStore[] = [];

  const dir = join(TMP, "main");
  const store = new SqliteStore(dir);
  open.push(store);

  /* ---------- 1 · 基础读写 ---------- */
  section("1 · 基础读写");

  const s1 = await store.saveEvidence(
    ev({ id: "ev_1", runId: "run-a", response: { bodyRetained: true } }),
    { body: "<html>hi</html>" }
  );
  eq("Evidence 落库", s1.created, true);
  const back = await store.getEvidence("ev_1");
  eq("回读 id 一致", back?.id, "ev_1");
  check("blob 外置为文件（不进 DB）", back?.bodyRef !== null && existsSync(String(back?.bodyRef)));
  eq("blob 内容可读", readFileSync(String(back?.bodyRef), "utf8"), "<html>hi</html>");
  eq("listEvidence 命中", (await store.listEvidence()).length, 1);

  const o1 = await store.saveObservation(obs({ id: "obs_1" }));
  eq("Observation 落库", o1.created, true);
  eq("回读 Observation", (await store.getObservation("obs_1"))?.status, "MENTIONED");
  eq("schema 版本", store.schemaVersion, SQLITE_SCHEMA_VERSION);

  /* ---------- 2 · Evidence 语义 ---------- */
  section("2 · Evidence：append-only / 不覆盖");

  const dup = await store.saveEvidence(
    ev({ id: "ev_1", runId: "run-a", contentHash: "hash_ev_1", response: { bodyRetained: true } }),
    { body: "覆盖我" }
  );
  eq("同内容重复写 ⇒ 命中去重", dup.created, false);
  eq("去重返回已有 id", dup.duplicateOf, "ev_1");
  eq("原文未被覆盖", readFileSync(String((await store.getEvidence("ev_1"))?.bodyRef), "utf8"), "<html>hi</html>");

  const explicit = await store.saveEvidence(ev({ id: "ev_9" }), { idempotencyKey: "k1" });
  eq("显式幂等键 ⇒ 写入", explicit.created, true);
  const explicit2 = await store.saveEvidence(ev({ id: "ev_10" }), { idempotencyKey: "k1" });
  eq("显式幂等键重复 ⇒ 不写", explicit2.created, false);

  /* ---------- 3 · Observation 替换语义 ---------- */
  section("3 · Observation：replacement 与 replaces");

  const runStore = new SqliteStore(join(TMP, "runs"));
  open.push(runStore);
  const a1 = await runStore.saveObservation(obs({ id: "r1", runId: "run-x", observedAt: "2026-09-20T00:00:00.000Z" }));
  const a2 = await runStore.saveObservation(obs({ id: "r2", runId: "run-x", observedAt: "2026-09-20T05:00:00.000Z" }));
  eq("同 run + 同版本 ⇒ 替换（created=false）", a2.created, false);
  eq("替换保持原 id", a2.id, a1.id);
  eq("条数不变（是替换不是追加）", (await runStore.listObservations()).length, 1);
  eq("内容被刷新", (await runStore.getObservation(a2.id))?.observedAt, "2026-09-20T05:00:00.000Z");

  const b = await runStore.saveObservation(obs({ id: "r3", runId: "run-y", observedAt: "2026-09-21T00:00:00.000Z" }));
  eq("不同 run + 同版本 ⇒ 新历史", b.created, true);
  eq("不建 replaces 链（时间推进 ≠ 版本演进）", (await runStore.getObservation(b.id))?.replaces, undefined);

  const c = await runStore.saveObservation(
    obs({ id: "r4", runId: "run-z", parserVersion: "ai-visibility@0.2.0", observedAt: "2026-09-22T00:00:00.000Z" })
  );
  eq("版本演进 ⇒ 新记录", c.created, true);
  eq("replaces 指向被取代的那条", (await runStore.getObservation(c.id))?.replaces, b.id);

  const idem = await runStore.saveObservation(obs({ id: "r5" }), { idempotencyKey: "obs-k" });
  const idem2 = await runStore.saveObservation(obs({ id: "r6" }), { idempotencyKey: "obs-k" });
  eq("显式幂等键首次写入", idem.created, true);
  eq("显式幂等键重复 ⇒ duplicateOf", idem2.duplicateOf, idem.id);

  /* ---------- 4 · 查询 ---------- */
  section("4 · 查询维度");

  const qStore = new SqliteStore(join(TMP, "queries"));
  open.push(qStore);
  for (const e of EVIDENCE_FIXTURES) await qStore.saveEvidence(e);
  for (const o of OBSERVATION_FIXTURES) await qStore.saveObservation(o);

  eq("全量倒序", (await qStore.listObservations()).map((o) => o.id), ["obs_4", "obs_3", "obs_2", "obs_1"]);
  eq("order=asc", (await qStore.listObservations({ order: "asc" })).map((o) => o.id), ["obs_1", "obs_2", "obs_3", "obs_4"]);
  eq("type 过滤", (await qStore.listObservations({ type: "rank" })).length, 1);
  eq("status 过滤", (await qStore.listObservations({ status: "MENTIONED" })).length, 2);
  eq("runId 过滤", (await qStore.listObservations({ runId: "run-a" })).length, 1);
  eq("时间范围", (await qStore.listObservations({ from: "2026-09-21T00:00:00.000Z", to: "2026-09-21T23:00:00.000Z" })).map((o) => o.id), ["obs_2"]);
  eq("limit", (await qStore.listObservations({ limit: 2 })).length, 2);
  eq("latestOnly 按 identity 收敛", (await qStore.listObservations({ latestOnly: true })).length, 2);
  eq("subject 过滤（Observation）", (await qStore.findObservationsBySubject("search:site=https://example.com|q=x")).length, 1);
  eq("source 过滤（Observation）", (await qStore.findObservationsBySource("search-engine:baidu")).length, 1);
  eq("kind 过滤（Evidence）", (await qStore.listEvidence({ kind: "serp_html" })).length, 1);
  eq("run 过滤（Evidence）", (await qStore.listEvidence({ runId: "run-a" })).length, 2);
  eq("subject 过滤（Evidence）", (await qStore.findEvidenceBySubject("ai-slot:deepseek:deepseek-chat")).length, 1);
  eq("source 过滤（Evidence）", (await qStore.findEvidenceBySource("search-engine:baidu")).length, 1);
  eq("时间范围（Evidence）", (await qStore.findEvidenceByTimeRange("2026-09-20T00:00:00.000Z", "2026-09-20T23:00:00.000Z")).length, 1);

  /* ---------- 5 · ★ 与 JsonlStore 奇偶一致 ---------- */
  section("5 · 奇偶一致（换实现不改行为）");

  const jsonlDir = join(TMP, "parity-jsonl");
  const sqliteDir = join(TMP, "parity-sqlite");
  const jsonl = new JsonlStore(jsonlDir);
  const sqlite = new SqliteStore(sqliteDir);
  open.push(sqlite);

  for (const e of EVIDENCE_FIXTURES) {
    await jsonl.saveEvidence(e);
    await sqlite.saveEvidence(e);
  }
  for (const o of OBSERVATION_FIXTURES) {
    await jsonl.saveObservation(o);
    await sqlite.saveObservation(o);
  }

  let obsMismatch = 0;
  for (const q of OBS_QUERIES) {
    const a = await jsonl.listObservations(q);
    const b = await sqlite.listObservations(q);
    if (stable(a) !== stable(b)) {
      obsMismatch += 1;
      console.log(`    ↳ 不一致：${JSON.stringify(q)}\n      jsonl=${stable(a).slice(0, 220)}\n      sqlite=${stable(b).slice(0, 220)}`);
    }
  }
  check(`Observation 查询 ${OBS_QUERIES.length} 组全部一致`, obsMismatch === 0, `不一致 ${obsMismatch} 组`);

  let evMismatch = 0;
  for (const q of EV_QUERIES) {
    const a = await jsonl.listEvidence(q);
    const b = await sqlite.listEvidence(q);
    if (stable(a) !== stable(b)) {
      evMismatch += 1;
      console.log(`    ↳ 不一致：${JSON.stringify(q)}`);
    }
  }
  check(`Evidence 查询 ${EV_QUERIES.length} 组全部一致`, evMismatch === 0, `不一致 ${evMismatch} 组`);

  /* ---------- 6 · 持久化 ---------- */
  section("6 · 持久化（重启不丢）");

  const reopen = new SqliteStore(sqliteDir);
  eq("重新打开后 Observation 条数不变", (await reopen.listObservations()).length, OBSERVATION_FIXTURES.length);
  eq("重新打开后 Evidence 条数不变", (await reopen.listEvidence()).length, EVIDENCE_FIXTURES.length);
  reopen.close();

  /* ---------- 7 · 驱动切换 ---------- */
  section("7 · 驱动切换（默认不变）");

  eq("默认 ⇒ JsonlStore", createStore(join(TMP, "d1")).constructor.name, "JsonlStore");
  process.env.GEOKIT_STORE_DRIVER = "sqlite";
  const d2 = createStore(join(TMP, "d2"));
  eq("GEOKIT_STORE_DRIVER=sqlite ⇒ SqliteStore", d2.constructor.name, "SqliteStore");
  open.push(d2 as SqliteStore);
  process.env.GEOKIT_STORE_DRIVER = "postgres";
  eq("未知驱动回落 jsonl（不猜、不报错）", createStore(join(TMP, "d3")).constructor.name, "JsonlStore");
  delete process.env.GEOKIT_STORE_DRIVER;

  /* ---------- 8 · importFrom（可逆性） ---------- */
  section("8 · importFrom：带着历史换实现");

  const target = new SqliteStore(join(TMP, "migrated"));
  open.push(target);
  const moved = await target.importFrom(jsonl);
  eq("Observation 全部搬过来", moved.observations, OBSERVATION_FIXTURES.length);
  eq("Evidence 全部搬过来", moved.evidence, EVIDENCE_FIXTURES.length);
  eq("源库未被删除", (await jsonl.listObservations()).length, OBSERVATION_FIXTURES.length);
  eq(
    "搬迁后查询结果一致",
    stable(await target.listObservations({ order: "asc" })),
    stable(await jsonl.listObservations({ order: "asc" }))
  );
  const again = await target.importFrom(jsonl);
  eq("重复导入不产生重复（幂等）", again.observations, 0);

  for (const s of open) {
    try {
      s.close();
    } catch {
      /* 已关闭的实例重复关闭会抛，忽略即可 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });

  /* ---------- 汇总 ---------- */
  console.log(`\n${"─".repeat(52)}`);
  if (failures.length === 0) {
    console.log(`通过 ${passed} 项，失败 0 项`);
  } else {
    console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
    for (const f of failures) console.log(`  ❌ [${f.group}] ${f.name} — ${f.detail}`);
  }
  if (failures.length > 0) process.exit(1);
}

void main();
