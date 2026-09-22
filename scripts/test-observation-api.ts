/**
 * S7 / 只读时间维度 API 契约测试（零新增依赖）。
 *
 * 覆盖：
 *   1  参数校验    非法 type / status / limit / order / from-to 必须 400 且说清原因
 *   2  历史查询    排序 · limit · latest · subject/source/type/status 过滤 · 时间范围
 *   3  空结果      ★ 必须带 hint，说清「还没记过」而不是「查不到」
 *   4  diff 查询   必填校验 · UNOBSERVABLE→NOT_MENTIONED 不判方向 · to 截断
 *   5  只读性      调用前后 Observation / Evidence 条数不变（不产数据、不触发采集）
 *
 * 用法：npx tsx scripts/test-observation-api.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonlStore } from "../src/lib/store/jsonl";
import type { Observation, ObservationStatus } from "../src/lib/evidence/types";
import {
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  OBSERVATION_KINDS,
  OBSERVATION_STATUSES,
  latestObservationDiff,
  listObservationHistory,
  parseDiffQuery,
  parseHistoryQuery,
} from "../src/lib/services/observations";

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

/* ------------------------------------------------------------------ */
/* 夹具                                                                 */
/* ------------------------------------------------------------------ */

const TMP = mkdtempSync(join(tmpdir(), "geokit-observations-api-"));
const store = new JsonlStore(TMP);

const SUBJECT = "ai-slot:deepseek:deepseek-chat";
const SOURCE = "provider:deepseek";

let seq = 0;

function obs(o: {
  status: ObservationStatus;
  observedAt: string;
  subject?: string;
  source?: string;
  type?: Observation["type"];
}): Observation {
  seq += 1;
  return {
    id: `obs_api_${String(seq).padStart(3, "0")}`,
    contractVersion: "0.2.0",
    type: o.type ?? "ai_mention",
    subject: o.subject ?? SUBJECT,
    source: o.source ?? SOURCE,
    observedAt: o.observedAt,
    observerVersion: "obs@1",
    parserVersion: "parser@1",
    evidenceRefs: [`ev_${seq}`],
    status: o.status,
    result: { mentioned: o.status === "MENTIONED" },
    confidence: "medium",
    coverage: { expected: 1, observed: 1, ratio: 1 },
    metadata: { extra: {} },
  };
}

const q = (s: string) => new URLSearchParams(s);

const T = {
  d1: "2026-09-19T02:00:00.000Z",
  d2: "2026-09-20T02:00:00.000Z",
  d3: "2026-09-21T02:00:00.000Z",
};

async function main(): Promise<void> {
  /* ---------- 1 · 参数校验 ---------- */
  section("1 · 参数校验");

  const badType = parseHistoryQuery(q("type=seo_score"));
  check("非法 type ⇒ 400", badType.ok === false);
  check(
    "错误信息列出可选值",
    badType.ok === false && badType.error.includes("type 非法") && badType.error.includes("geo_score"),
    badType.ok ? "" : badType.error
  );

  const badStatus = parseHistoryQuery(q("status=DROPPED"));
  check("非法 status ⇒ 400", badStatus.ok === false);

  for (const v of ["0", "-1", "501", "abc"]) {
    const r = parseHistoryQuery(q(`limit=${v}`));
    check(`limit=${v} ⇒ 400`, r.ok === false, r.ok ? "" : r.error);
  }
  check(
    `limit=${MAX_HISTORY_LIMIT} ⇒ 通过`,
    parseHistoryQuery(q(`limit=${MAX_HISTORY_LIMIT}`)).ok === true
  );

  check("order=up ⇒ 400", parseHistoryQuery(q("order=up")).ok === false);
  check("from 不是时间 ⇒ 400", parseHistoryQuery(q("from=昨天")).ok === false);
  check("to 不是时间 ⇒ 400", parseHistoryQuery(q("to=notadate")).ok === false);

  const empty = parseHistoryQuery(q(""));
  check("无参 ⇒ 通过", empty.ok === true);
  eq(
    "无参时 type/subject 均缺省",
    empty.ok ? [empty.data.type, empty.data.subject] : [],
    [undefined, undefined]
  );

  const latest = parseHistoryQuery(q("latest=1"));
  eq("latest=1 ⇒ latestOnly", latest.ok ? latest.data.latestOnly : null, true);
  const latestFalse = parseHistoryQuery(q("latest=false"));
  eq("latest=false ⇒ latestOnly=false", latestFalse.ok ? latestFalse.data.latestOnly : null, false);

  const trimmed = parseHistoryQuery(q("subject=%20%20ai-slot%3Ax%3Ay%20%20"));
  eq("参数两端空白被裁掉", trimmed.ok ? trimmed.data.subject : null, "ai-slot:x:y");

  eq("契约 type 全集", Array.from(OBSERVATION_KINDS), [
    "rank",
    "geo_score",
    "ai_mention",
    "robots_policy",
    "llms_txt",
  ]);
  eq("契约 status 全集长度", OBSERVATION_STATUSES.length, 8);

  /* ---------- 2 · 历史查询 ---------- */
  section("2 · 历史查询");

  await store.saveObservation(obs({ status: "UNOBSERVABLE", observedAt: T.d1 }));
  await store.saveObservation(obs({ status: "NOT_MENTIONED", observedAt: T.d2 }));
  await store.saveObservation(obs({ status: "MENTIONED", observedAt: T.d3 }));
  await store.saveObservation(
    obs({ status: "MENTIONED", observedAt: T.d3, subject: "ai-slot:openai:gpt-4o", source: "provider:openai" })
  );

  const all = await listObservationHistory(q(""), store);
  eq("默认按时间倒序", all.ok ? all.data.items.map((o) => o.status) : [], [
    "MENTIONED",
    "MENTIONED",
    "NOT_MENTIONED",
    "UNOBSERVABLE",
  ]);
  eq("默认 limit 回显", all.ok ? all.data.query.limit : null, DEFAULT_HISTORY_LIMIT);

  const asc = await listObservationHistory(q("order=asc"), store);
  eq("order=asc 生效", asc.ok ? asc.data.items[0]?.status : null, "UNOBSERVABLE");

  const limited = await listObservationHistory(q("order=asc&limit=2"), store);
  eq("limit 生效", limited.ok ? limited.data.items.length : null, 2);
  eq("count 是截断后的长度", limited.ok ? limited.data.count : null, 2);

  const bySubject = await listObservationHistory(q(`subject=${encodeURIComponent(SUBJECT)}`), store);
  eq("subject 过滤", bySubject.ok ? bySubject.data.count : null, 3);

  const bySource = await listObservationHistory(q(`source=${encodeURIComponent(SOURCE)}`), store);
  eq("source 过滤", bySource.ok ? bySource.data.count : null, 3);

  const byStatus = await listObservationHistory(q("status=MENTIONED"), store);
  eq("status 过滤", byStatus.ok ? byStatus.data.count : null, 2);

  const byType = await listObservationHistory(q("type=geo_score"), store);
  eq("type 过滤（无匹配）", byType.ok ? byType.data.count : null, 0);

  const range = await listObservationHistory(q(`from=${T.d2}&to=${T.d2}`), store);
  eq("时间范围过滤", range.ok ? range.data.count : null, 1);

  const latestOnly = await listObservationHistory(q("latest=1"), store);
  eq("latest=1 ⇒ 每个 identity 一条", latestOnly.ok ? latestOnly.data.count : null, 2);

  /* ---------- 3 · 空结果必须说清原因 ---------- */
  section("3 · 空结果的 hint");

  const none = await listObservationHistory(q("type=geo_score"), store);
  check("空结果带 hint", none.ok && typeof none.data.hint === "string" && none.data.hint.length > 0);
  check(
    "★ 总闸关闭时 hint 点明「还没记过」",
    none.ok ? (none.data.hint ?? "").includes("存证总闸") : false,
    none.ok ? none.data.hint ?? "" : ""
  );

  const nonEmpty = await listObservationHistory(q(""), store);
  check("有结果时不给 hint", nonEmpty.ok && nonEmpty.data.hint === undefined);

  /* ---------- 4 · diff 查询 ---------- */
  section("4 · diff 查询");

  check("缺 subject ⇒ 400", parseDiffQuery(q("type=ai_mention")).ok === false);
  check("缺 type ⇒ 400", parseDiffQuery(q("subject=ai-slot:x:y")).ok === false);
  check("非法 type ⇒ 400", parseDiffQuery(q("subject=ai-slot:x:y&type=rank2")).ok === false);
  check("to 不是时间 ⇒ 400", parseDiffQuery(q("subject=a&type=rank&to=x")).ok === false);

  const d = await latestObservationDiff(
    q(`subject=${encodeURIComponent(SUBJECT)}&type=ai_mention`),
    store
  );
  check("diff 查询成功", d.ok === true, d.ok ? "" : d.error);
  if (d.ok) {
    // 最近两条是 NOT_MENTIONED(d2) → MENTIONED(d3)，两侧都可判定 ⇒ 可比且 improved
    eq("最近两条可比", d.data.diff.comparable, true);
    eq("NOT_MENTIONED→MENTIONED ⇒ improved", d.data.diff.summary.improved, 1);
    eq("无 degraded", d.data.diff.summary.degraded, 0);
    check("diff 回显查询条件", d.data.query.subject === SUBJECT, JSON.stringify(d.data.query));
  }

  // to 截断：只看到第二天 ⇒ UNOBSERVABLE(d1) → NOT_MENTIONED(d2)
  const toD2 = await latestObservationDiff(
    q(`subject=${encodeURIComponent(SUBJECT)}&type=ai_mention&to=${T.d2}`),
    store
  );
  if (toD2.ok) {
    eq("to 截断后的 current", toD2.data.diff.currentObservedAt, T.d2);
    eq("to 截断后的 previous", toD2.data.diff.previousObservedAt, T.d1);
    eq("★ UNOBSERVABLE→NOT_MENTIONED 不判方向（degraded=0）", toD2.data.diff.summary.degraded, 0);
    eq("comparable=false", toD2.data.diff.comparable, false);
    eq("reason", toD2.data.diff.incomparableReason, "status_not_observed");
  }

  const noData = await latestObservationDiff(q("subject=site:nope&type=geo_score"), store);
  check("无历史时 diff 仍返回结构（missing_previous）", noData.ok && noData.data.diff.comparable === false && noData.data.diff.incomparableReason === "missing_previous");

  /* ---------- 5 · 只读性 ---------- */
  section("5 · 只读性");

  const before = (await store.listObservations()).length;
  const evBefore = (await store.listEvidence()).length;
  await listObservationHistory(q(""), store);
  await latestObservationDiff(q(`subject=${encodeURIComponent(SUBJECT)}&type=ai_mention`), store);
  eq("读操作不新增 Observation", (await store.listObservations()).length, before);
  eq("读操作不新增 Evidence", (await store.listEvidence()).length, evBefore);

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
