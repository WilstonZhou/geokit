/**
 * S1 / S2 契约测试（零新增依赖，与 regression.ts 同一路子）。
 *
 * 覆盖设计评审里点名的十项：
 *   1  Evidence 保存/读取
 *   2  Observation 保存/读取
 *   3  subject/source 不混淆
 *   4  runId 查询
 *   5  时间范围查询
 *   6  idempotency
 *   7  Evidence immutable
 *   8  六态可合法表达
 *   9  INDETERMINATE 不进 visibilityScore 分母
 *   10 旧 Phase 0 Evidence 兼容读取
 *
 * 外加：canonical identity 规范化、retention 计划、Store 无 update/delete。
 *
 * 用法：npx tsx scripts/test-store.ts
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonlStore } from "../src/lib/store/jsonl";
import type { EvidenceQuery, ObservationQuery } from "../src/lib/store/types";
import { DEFAULT_RETENTION_POLICY, planRetention, retentionClassOf } from "../src/lib/store/retention";
import type { Evidence, Observation } from "../src/lib/evidence/types";
import { EVIDENCE_CONTRACT_VERSION, OBSERVATION_CONTRACT_VERSION } from "../src/lib/evidence/types";
import { deriveSubjectSource, normalizeEvidence } from "../src/lib/evidence/normalize";
import {
  aiSlotSubject,
  httpSource,
  parseSource,
  parseSubject,
  providerSource,
  searchEngineSource,
  searchSubject,
  serpStrategyVersion,
  siteSubject,
} from "../src/lib/evidence/identity";
import {
  AI_OBSERVATION_STATES,
  summarizeAiStatuses,
  visibilityScoreOf,
} from "../src/lib/evidence/ai-status";

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
  check(name, ok, ok ? `${JSON.stringify(actual)}` : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ------------------------------------------------------------------ */
/* 夹具构造                                                             */
/* ------------------------------------------------------------------ */

const TMP = mkdtempSync(join(tmpdir(), "geokit-store-test-"));
const store = new JsonlStore(TMP);

/**
 * 构造一条 **canonical**（非旧契约）Evidence。
 *
 * 必须带 provenance —— 归一化层把「缺 provenance」当作旧记录特征，
 * 会转而按 purpose 推导 subject/source，那会把夹具的 subject 盖掉。
 */
function ev(partial: Partial<Evidence> & { id: string }): Evidence {
  const url = partial.requestUrl ?? "https://www.baidu.com/s?wd=x";
  const at = partial.observedAt ?? "2026-09-22T00:00:00.000Z";
  return normalizeEvidence({
    id: partial.id,
    contractVersion: EVIDENCE_CONTRACT_VERSION,
    kind: partial.kind ?? "serp_html",
    subject: partial.subject,
    source: partial.source,
    observedAt: at,
    runId: partial.runId,
    // 旧字段照旧写入，用来验证「新记录对旧读者可见」
    target: partial.target ?? "legacy-target",
    requestUrl: url,
    request: { method: "GET", headers: {}, bodyByteLength: 0 },
    response: {
      httpStatus: partial.status ?? 200,
      finalUrl: url,
      headers: {},
      bodyHash: partial.contentHash ?? "hash-" + partial.id,
      byteLength: 1024,
      bodyRetained: partial.response?.bodyRetained ?? false,
      bodyRef: null,
    },
    timing: { requestedAt: at, elapsedMs: 10, waitedMs: 0, attempts: 1 },
    context: { purpose: partial.metadata?.purpose ?? "serp", meta: {} },
    createdAt: at,
    metadata: partial.metadata ?? { purpose: "serp", extra: {} },
    provenance: partial.provenance ?? {
      method: "GET",
      requestUrl: url,
      finalUrl: url,
      httpStatus: partial.status ?? 200,
      requestHeaders: {},
      responseHeaders: {},
      requestedAt: at,
      elapsedMs: 10,
      waitedMs: 0,
      attempts: 1,
    },
    contentHash: partial.contentHash,
    bodyRef: partial.bodyRef,
  });
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
    evidenceRefs: partial.evidenceRefs ?? [],
    status: partial.status ?? "MENTIONED",
    result: partial.result ?? { mentioned: true },
    confidence: partial.confidence ?? "medium",
    coverage: partial.coverage ?? { expected: 9, observed: 1, ratio: 1 / 9 },
    metadata: partial.metadata ?? {},
  };
}

/* ================================================================== */
async function main(): Promise<void> {
  /* ---------- 0. canonical identity ---------- */
  section("0 · canonical identity");

  eq("site subject 规范化（尾斜杠 + 大小写）", siteSubject("HTTPS://Example.com/path/"), "site:https://example.com/path");
  eq("site subject 接受裸域名", siteSubject("example.com"), "site:https://example.com");
  eq("search subject 含站点与词", searchSubject("example.com", "跨境支付  平台"), "search:site=https://example.com|q=跨境支付 平台");
  eq("search subject 无站点时用占位符", searchSubject(null, "x"), "search:site=*|q=x");
  eq("ai slot 用 requestedModel", aiSlotSubject("deepseek", "deepseek-chat"), "ai-slot:deepseek:deepseek-chat");

  eq("source: 搜索引擎", searchEngineSource("baidu"), "search-engine:baidu");
  eq("source: 厂商", providerSource("deepseek"), "provider:deepseek");
  eq("source: 站点 origin", httpSource("https://example.com/a/b?c=1"), "http:https://example.com");

  eq("parseSubject 可回读 search", parseSubject(searchSubject("example.com", "q"))?.query, "q");
  eq("parseSubject 可回读 ai-slot 模型", parseSubject(aiSlotSubject("p", "m"))?.requestedModel, "m");
  eq("parseSource 区分三类", parseSource("search-engine:baidu")?.kind, "search-engine");

  eq("三家引擎策略版本均存在", [
    serpStrategyVersion("baidu"),
    serpStrategyVersion("360"),
    serpStrategyVersion("sogou"),
  ].every(Boolean), true);

  // 兼容桥：旧记录只带 purpose + target + meta，必须能推导出正确的 identity
  const dSerp = deriveSubjectSource({ purpose: "serp", target: "baidu", meta: { engineId: "baidu", keyword: "跨境支付" } });
  eq("推导 serp：target 是来源，不是对象", dSerp.source, "search-engine:baidu");
  eq("推导 serp：subject 来自关键词", dSerp.subject, "search:site=*|q=跨境支付");

  const dAi = deriveSubjectSource({ purpose: "ai-visibility", target: "deepseek", meta: { providerId: "deepseek", requestedModel: "deepseek-chat" } });
  eq("推导 ai：subject 是槽位", dAi.subject, "ai-slot:deepseek:deepseek-chat");
  eq("推导 ai：source 是厂商", dAi.source, "provider:deepseek");

  const dSite = deriveSubjectSource({ purpose: "audit", target: "https://A.com/x/", meta: {} });
  eq("推导 audit：target 就是被观测对象", dSite.subject, "site:https://a.com/x");
  eq("推导 audit：source 是 origin", dSite.source, "http:https://a.com");

  /* ---------- 1. Evidence 保存/读取 ---------- */
  section("1 · Evidence 保存 / 读取");

  const e1 = ev({ id: "ev_1", subject: siteSubject("https://example.com"), source: httpSource("https://example.com"), kind: "page_html", observedAt: "2026-09-22T01:00:00.000Z" });
  const r1 = await store.saveEvidence(e1, { body: "<html>hello</html>" });
  eq("saveEvidence 返回 created", r1.created, true);

  const got = await store.getEvidence("ev_1");
  eq("getEvidence 命中同 id", got?.id, "ev_1");
  eq("getEvidence 保留 subject", got?.subject, "site:https://example.com");
  eq("getEvidence 保留 contentHash", got?.contentHash, "hash-ev_1");

  (() => {
    const a = got!;
    a.subject = "tampered";
    a.response.bodyHash = "tampered-hash";
  })();
  const after = await store.getEvidence("ev_1");
  check(
    "读取返回深拷贝（改返回值不污染存储）",
    after!.subject === "site:https://example.com" && after!.contentHash === "hash-ev_1",
    `subject=${after!.subject}`
  );

  /* ---------- 2. Observation 保存/读取 ---------- */
  section("2 · Observation 保存 / 读取");

  const o1 = obs({ subject: aiSlotSubject("deepseek", "deepseek-chat"), observedAt: "2026-09-22T01:00:00.000Z", runId: "run_A" });
  const ro1 = await store.saveObservation(o1);
  check("saveObservation 生成 id", Boolean(ro1.id), ro1.id);

  const gotObs = await store.getObservation(ro1.id);
  eq("getObservation 命中", gotObs?.subject, "ai-slot:deepseek:deepseek-chat");
  eq("getObservation 保留 result", gotObs?.result, { mentioned: true });
  eq("versionKey 由三版本合成", typeof gotObs?.versionKey, "string");

  // ★ 契约版本：Observation 自 S1 起定为 0.2.0；仓库内无 Observation 生产记录，
  //   因此不做 migration（Evidence 侧另有 0.1.0 旧记录的读取时归一化）
  eq("Observation contractVersion = 0.2.0", gotObs?.contractVersion, "0.2.0");
  eq("OBSERVATION_CONTRACT_VERSION 常量 = 0.2.0", OBSERVATION_CONTRACT_VERSION, "0.2.0");
  eq("Evidence contractVersion = 0.2.0", (await store.getEvidence("ev_1"))?.contractVersion, "0.2.0");

  /* ---------- 3. subject / source 不混淆 ---------- */
  section("3 · subject / source 不混淆");

  // 同一字符串既可能是 subject 也可能是 source —— 语义必须靠字段位置区分
  const searchSubjectStr = searchSubject("example.com", "跨境支付");
  await store.saveEvidence(ev({ id: "ev_search_baidu", subject: searchSubjectStr, source: searchEngineSource("baidu"), kind: "serp_html", observedAt: "2026-09-22T02:00:00.000Z", contentHash: "h-baidu" }));
  await store.saveEvidence(ev({ id: "ev_search_360", subject: searchSubjectStr, source: searchEngineSource("360"), kind: "serp_html", observedAt: "2026-09-22T02:00:00.000Z", contentHash: "h-360" }));
  await store.saveEvidence(ev({ id: "ev_site_baidu", subject: siteSubject("https://www.baidu.com"), source: httpSource("https://www.baidu.com"), kind: "page_html", observedAt: "2026-09-22T02:00:00.000Z", contentHash: "h-site" }));

  const byBaiduSource = await store.findEvidenceBySource("search-engine:baidu");
  eq("按 source=baidu 只命中「用百度查的」", byBaiduSource.map((e) => e.id), ["ev_search_baidu"]);

  const byBaiduSubject = await store.findEvidenceBySubject(siteSubject("https://www.baidu.com"));
  eq("按 subject=百度站点 只命中「查百度的」", byBaiduSubject.map((e) => e.id), ["ev_site_baidu"]);

  eq("同一 subject 可聚合多来源", (await store.findEvidenceBySubject(searchSubjectStr)).length, 2);

  check("source 与 subject 是不同字段，不会互相污染",
    byBaiduSource[0]!.subject === searchSubjectStr && byBaiduSubject[0]!.source === "http:https://www.baidu.com");

  /* ---------- 4. runId 查询 ---------- */
  section("4 · runId 查询");

  await store.saveEvidence(ev({ id: "ev_run1_a", subject: siteSubject("https://a.com"), source: httpSource("https://a.com"), runId: "run_1", observedAt: "2026-09-22T03:00:00.000Z", contentHash: "h1" }));
  await store.saveEvidence(ev({ id: "ev_run1_b", subject: siteSubject("https://b.com"), source: httpSource("https://b.com"), runId: "run_1", observedAt: "2026-09-22T03:00:00.000Z", contentHash: "h2" }));
  await store.saveEvidence(ev({ id: "ev_run2_a", subject: siteSubject("https://a.com"), source: httpSource("https://a.com"), runId: "run_2", observedAt: "2026-09-22T03:00:00.000Z", contentHash: "h3" }));

  eq("findEvidenceByRun(run_1)", (await store.findEvidenceByRun("run_1")).map((e) => e.id).sort(), ["ev_run1_a", "ev_run1_b"]);
  eq("findEvidenceByRun(run_2)", (await store.findEvidenceByRun("run_2")).map((e) => e.id), ["ev_run2_a"]);

  await store.saveObservation(obs({ subject: siteSubject("https://a.com"), source: httpSource("https://a.com"), type: "geo_score", runId: "run_1", observedAt: "2026-09-22T03:00:00.000Z" }));
  eq("findObservationsByRun(run_1)", (await store.findObservationsByRun("run_1")).length, 1);

  /* ---------- 5. 时间范围查询 ---------- */
  section("5 · 时间范围查询");

  eq("时间范围内（含端点）", (await store.findEvidenceByTimeRange("2026-09-22T02:00:00.000Z", "2026-09-22T03:00:00.000Z")).length >= 4, true);
  eq("时间范围外为空", (await store.findEvidenceByTimeRange("2020-01-01T00:00:00.000Z", "2020-12-31T00:00:00.000Z")).length, 0);

  const desc = await store.listEvidence({ order: "desc", limit: 2 });
  const asc = await store.listEvidence({ order: "asc", limit: 2 });
  check("排序方向生效", desc[0]!.observedAt >= asc[0]!.observedAt, `desc[0]=${desc[0]!.observedAt} asc[0]=${asc[0]!.observedAt}`);
  eq("limit 生效", desc.length, 2);

  /* ---------- 6. idempotency ---------- */
  section("6 · idempotency");

  const idem = ev({ id: "ev_idem", subject: siteSubject("https://c.com"), source: httpSource("https://c.com"), runId: "run_idem", observedAt: "2026-09-22T04:00:00.000Z", contentHash: "same-content" });
  const a1 = await store.saveEvidence(idem);
  const a2 = await store.saveEvidence({ ...idem, id: "ev_idem_2" });
  eq("同 runId 同内容 → 第二次不新建", a2.created, false);
  eq("第二次返回已有 id", a2.id, a1.id);
  eq("duplicateOf 指向已有记录", a2.duplicateOf, a1.id);
  eq("库中仍只有一条", (await store.findEvidenceByRun("run_idem")).length, 1);

  // 无 runId → 不去重（无法区分重算与新观测）
  const b1 = await store.saveEvidence(ev({ id: "ev_norun_1", subject: siteSubject("https://d.com"), source: httpSource("https://d.com"), observedAt: "2026-09-22T04:00:00.000Z", contentHash: "x" }));
  const b2 = await store.saveEvidence(ev({ id: "ev_norun_2", subject: siteSubject("https://d.com"), source: httpSource("https://d.com"), observedAt: "2026-09-22T05:00:00.000Z", contentHash: "x" }));
  check("无 runId 时不去重（保住时间维度）", b1.created && b2.created && b1.id !== b2.id, `${b1.id} / ${b2.id}`);

  // idempotencyKey 逃逸口
  const c1 = await store.saveEvidence(ev({ id: "ev_key_1", subject: siteSubject("https://e.com"), source: httpSource("https://e.com"), observedAt: "2026-09-22T04:00:00.000Z", contentHash: "y" }), { idempotencyKey: "force-same" });
  const c2 = await store.saveEvidence(ev({ id: "ev_key_2", subject: siteSubject("https://e.com"), source: httpSource("https://e.com"), observedAt: "2026-09-22T04:30:00.000Z", contentHash: "z" }), { idempotencyKey: "force-same" });
  eq("显式 idempotencyKey 强制去重", c2.id, c1.id);

  // Observation 替换语义
  const rep1 = await store.saveObservation(obs({ subject: siteSubject("https://f.com"), source: httpSource("https://f.com"), type: "rank", runId: "run_rep", observedAt: "2026-09-22T04:00:00.000Z", result: { rank: 5 } }));
  const rep2 = await store.saveObservation(obs({ subject: siteSubject("https://f.com"), source: httpSource("https://f.com"), type: "rank", runId: "run_rep", observedAt: "2026-09-22T04:00:00.000Z", result: { rank: 3 } }));
  eq("同 run 重算 → 替换且保留 id", rep2.id, rep1.id);
  eq("替换后读到新 result", (await store.getObservation(rep1.id))?.result, { rank: 3 });
  eq("替换不产生第二条", (await store.findObservationsByRun("run_rep")).length, 1);

  // ★ 持久化语义：Observation 是 Evidence 的 materialized result ——
  //   同 run + 同版本的重算只替换 Observation 自己，Evidence 侧始终 append-only
  const evCountBeforeReplace = (await store.listEvidence({})).length;
  const rep3 = await store.saveObservation(obs({ subject: siteSubject("https://f.com"), source: httpSource("https://f.com"), type: "rank", runId: "run_rep", observedAt: "2026-09-22T04:00:00.000Z", result: { rank: 1 } }));
  eq("同 run 同版本可反复重算（幂等，id 不变）", rep3.id, rep1.id);
  eq("重算读到最新 result", (await store.getObservation(rep1.id))?.result, { rank: 1 });
  eq("Observation 替换不改动 Evidence 条数", (await store.listEvidence({})).length, evCountBeforeReplace);
  eq("该 run 下仍只有一条 Observation", (await store.findObservationsByRun("run_rep")).length, 1);

  const newRun = await store.saveObservation(obs({ subject: siteSubject("https://f.com"), source: httpSource("https://f.com"), type: "rank", runId: "run_rep_2", observedAt: "2026-09-23T04:00:00.000Z", result: { rank: 2 } }));
  check("不同 run → 追加新记录（历史保留）", newRun.created && newRun.id !== rep1.id);
  eq("同 subject 累积两条历史", (await store.findObservationsBySubject(siteSubject("https://f.com"))).length, 2);
  eq("latestOnly 只留最新", (await store.listObservations({ subject: siteSubject("https://f.com"), latestOnly: true })).length, 1);

  /* ---------- 7. Evidence immutable ---------- */
  section("7 · Evidence 不可变");

  const proto = Object.getPrototypeOf(store);
  const methods = Object.getOwnPropertyNames(proto).filter((m) => m !== "constructor");
  check("Store 无 update / delete 方法", !methods.some((m) => /update|delete|remove|patch/i.test(m)), methods.join(","));

  const imm = await store.getEvidence("ev_1");
  const before = JSON.stringify(imm);
  const dup = await store.saveEvidence({ ...imm!, response: { ...imm!.response, bodyHash: "TAMPERED" } });
  eq("重复写入不改内容", dup.created || dup.id === "ev_1", true);
  eq("原记录字节未变", JSON.stringify(await store.getEvidence("ev_1")).includes("TAMPERED"), false);
  check("读取深拷贝已生效", before === JSON.stringify(await store.getEvidence("ev_1")));

  /* ---------- 8. 六态可合法表达 ---------- */
  section("8 · AI 观测六态");

  eq("六态齐备", AI_OBSERVATION_STATES.length, 6);
  const allSix = await Promise.all(
    AI_OBSERVATION_STATES.map((s, i) =>
      store.saveObservation(obs({ subject: aiSlotSubject("p" + i, "m"), source: providerSource("p" + i), status: s as never, runId: "run_states", observedAt: "2026-09-22T06:00:00.000Z" }))
    )
  );
  eq("六态均可落库", allSix.filter((r) => r.created).length, 6);
  const byStatus = await store.listObservations({ runId: "run_states" });
  eq("六态均可按 status 查回", byStatus.length, 6);
  eq("INDETERMINATE 可被单独筛出", (await store.listObservations({ runId: "run_states", status: "INDETERMINATE" })).length, 1);

  /* ---------- 9. INDETERMINATE 不进分母 ---------- */
  section("9 · INDETERMINATE 不进 visibilityScore 分母");

  const base = summarizeAiStatuses(["MENTIONED", "NOT_MENTIONED"]);
  eq("基线：2 可判定", base.determinableCount, 2);
  eq("基线：命中率 50", visibilityScoreOf(base), 50);

  const withInd = summarizeAiStatuses(["MENTIONED", "NOT_MENTIONED", "INDETERMINATE"]);
  eq("加一个 INDETERMINATE → determinable 仍为 2", withInd.determinableCount, 2);
  eq("命中率不变（未稀释）", visibilityScoreOf(withInd), 50);
  eq("INDETERMINATE 计入 successful（确实拿到响应）", withInd.successfulCount, 3);
  eq("INDETERMINATE 单独计数", withInd.indeterminateCount, 1);
  eq("attempted 含全部", withInd.attemptedCount, 3);

  const allInd = summarizeAiStatuses(["INDETERMINATE", "INDETERMINATE"]);
  eq("全是 INDETERMINATE → 分母 0", allInd.determinableCount, 0);
  eq("分母 0 时 score = 0 而非 NaN", visibilityScoreOf(allInd), 0);
  check("score 恒为有限数", Number.isFinite(visibilityScoreOf(allInd)));

  const mixed = summarizeAiStatuses(["MENTIONED", "BLOCKED", "ERROR", "UNOBSERVABLE", "NOT_MENTIONED"]);
  eq("五态混合：blocked 与 error 分开计", [mixed.blockedCount, mixed.errorCount, mixed.unobservableCount], [1, 1, 1]);
  eq("五态混合：命中率只由可判定者决定", visibilityScoreOf(mixed), 50);

  /* ---------- 10. 旧 Phase 0 Evidence 兼容 ---------- */
  section("10 · 旧 Phase 0 Evidence 兼容读取");

  const legacyDir = mkdtempSync(join(tmpdir(), "geokit-legacy-"));
  const legacyFile = join(legacyDir, "raw-2026-09-21.jsonl");
  const legacyRecord = {
    id: "ev_legacy_1",
    contractVersion: "0.1.0",
    kind: "llm_response",
    target: "deepseek",
    requestUrl: "https://api.deepseek.com/v1/chat/completions",
    request: { method: "POST", headers: { Authorization: "[REDACTED]" }, bodyByteLength: 0 },
    response: { httpStatus: 200, finalUrl: "https://api.deepseek.com/v1/chat/completions", headers: {}, bodyHash: "legacy-hash", byteLength: 1885, bodyRetained: false, bodyRef: null },
    timing: { requestedAt: "2026-09-21T10:00:00.000Z", elapsedMs: 6100, waitedMs: 0, attempts: 1 },
    context: { purpose: "ai-visibility", meta: { providerId: "deepseek", requestedModel: "deepseek-chat" } },
    createdAt: "2026-09-21T10:00:00.000Z",
  };
  writeFileSync(legacyFile, JSON.stringify(legacyRecord) + "\n", "utf8");

  const legacyStore = new JsonlStore(legacyDir);
  const migrated = await legacyStore.getEvidence("ev_legacy_1");
  check("旧记录可读", Boolean(migrated), migrated?.id ?? "null");
  eq("补出 subject（ai 槽位）", migrated?.subject, "ai-slot:deepseek:deepseek-chat");
  eq("补出 source（厂商）", migrated?.source, "provider:deepseek");
  eq("补出 contentHash", migrated?.contentHash, "legacy-hash");
  eq("补出 observedAt", migrated?.observedAt, "2026-09-21T10:00:00.000Z");
  eq("provenance.httpStatus 正确", migrated?.provenance.httpStatus, 200);
  eq("provenance.requestUrl 正确", migrated?.provenance.requestUrl, "https://api.deepseek.com/v1/chat/completions");
  eq("标记 migratedFrom", migrated?.migratedFrom, "0.1.0");
  eq("旧 target 字段保留（旧读者不受影响）", migrated?.target, "deepseek");
  eq("旧索引可用：按 subject 查回", (await legacyStore.findEvidenceBySubject("ai-slot:deepseek:deepseek-chat")).length, 1);

  // 磁盘上的旧文件必须字节级不变 —— 证据不该被迁移改写
  eq("旧文件未被改写", JSON.parse(readFileSync(legacyFile, "utf8").trim()).contractVersion, "0.1.0");

  /* ---------- 11. replaces 语义边界 ---------- */
  section("11 · replaces 语义边界");

  // replaces 只表示「版本演进」：
  //   同 identity + 同三元组 + 同 run → 幂等替换，不产生新的 replaces 关系
  //   版本三元组任一变化               → 新 Observation，replaces 指向被取代的那条
  //   不同 run + 同版本               → 新历史记录，但不建 replaces（时间推进 ≠ 版本演进）
  const rpSubject = siteSubject("https://replaces.com");
  const rpSource = httpSource("https://replaces.com");
  const evCountBeforeReplaces = (await store.listEvidence({})).length;
  const rpBase = { subject: rpSubject, source: rpSource, type: "rank" as const, runId: "run_replaces" };

  // ① 同 run + 同三元组：反复重算不形成 replaces 链
  const rp1 = await store.saveObservation(obs({ ...rpBase, parserVersion: "p@1", observedAt: "2026-09-24T01:00:00.000Z", result: { rank: 9 } }));
  eq("① 首条无 replaces", (await store.getObservation(rp1.id))?.replaces, undefined);

  const rp1b = await store.saveObservation(obs({ ...rpBase, parserVersion: "p@1", observedAt: "2026-09-24T01:00:00.000Z", result: { rank: 8 } }));
  eq("① 同 run 同三元组重算 → id 不变", rp1b.id, rp1.id);
  eq("① 重算不新建 replaces 关系", (await store.getObservation(rp1.id))?.replaces, undefined);
  eq("① 重算不新增历史", (await store.findObservationsBySubject(rpSubject)).length, 1);

  const rp1c = await store.saveObservation(obs({ ...rpBase, parserVersion: "p@1", observedAt: "2026-09-24T01:00:00.000Z", result: { rank: 7 } }));
  eq("① 再重算一次仍无 replaces（链不增长）", (await store.getObservation(rp1.id))?.replaces, undefined);
  eq("① 三次重算后历史仍为 1 条", (await store.findObservationsBySubject(rpSubject)).length, 1);

  // ② parserVersion v1 → v2：新 Observation + replaces 指向 v1
  const rp2 = await store.saveObservation(obs({ ...rpBase, parserVersion: "p@2", observedAt: "2026-09-24T02:00:00.000Z", result: { rank: 5 } }));
  check("② 版本变更 → 新 Observation（新 id）", rp2.created && rp2.id !== rp1.id, `${rp1.id} → ${rp2.id}`);
  eq("② v2.replaces 指向 v1", (await store.getObservation(rp2.id))?.replaces, rp1.id);
  eq("② 版本演进累积两条历史", (await store.findObservationsBySubject(rpSubject)).length, 2);

  // ③ v2 再重算（同 run 同版本）→ 仍幂等，replaces 保持不变，不追加链
  const rp2b = await store.saveObservation(obs({ ...rpBase, parserVersion: "p@2", observedAt: "2026-09-24T02:00:00.000Z", result: { rank: 3 } }));
  eq("③ v2 重算 id 不变", rp2b.id, rp2.id);
  eq("③ v2 重算后 replaces 仍指向 v1（不形成链）", (await store.getObservation(rp2.id))?.replaces, rp1.id);
  eq("③ v2 重算读到最新 result", (await store.getObservation(rp2.id))?.result, { rank: 3 });
  eq("③ 历史仍为两条", (await store.findObservationsBySubject(rpSubject)).length, 2);

  // ④ 不同 run + 同版本 → 新历史记录，但不因「时间更晚」就建 replaces
  const rp3 = await store.saveObservation(obs({ ...rpBase, runId: "run_replaces_2", parserVersion: "p@2", observedAt: "2026-09-25T02:00:00.000Z", result: { rank: 4 } }));
  check("④ 不同 run → 新记录", rp3.created && rp3.id !== rp2.id);
  eq("④ 同版本跨 run 不建 replaces（时间推进 ≠ 版本演进）", (await store.getObservation(rp3.id))?.replaces, undefined);
  eq("④ 累积三条历史", (await store.findObservationsBySubject(rpSubject)).length, 3);
  eq("④ latestOnly 仍只留最新一条", (await store.listObservations({ subject: rpSubject, latestOnly: true })).length, 1);

  // ⑤ 全程 Evidence 保持 immutable（append-only，条数只增不减、内容不变）
  eq("⑤ 全程 Evidence 条数不变", (await store.listEvidence({})).length, evCountBeforeReplaces);
  eq("⑤ Evidence 内容未被 Observation 操作改写", (await store.getEvidence("ev_1"))?.contentHash, "hash-ev_1");

  /* ---------- 12. retention（只设计不算删除） ---------- */
  section("12 · retention 计划");

  eq("serp_html → serpRaw", retentionClassOf("serp_html"), "serpRaw");
  eq("llm_response → aiRaw", retentionClassOf("llm_response"), "aiRaw");
  eq("page_html → siteRaw", retentionClassOf("page_html"), "siteRaw");
  eq("默认 serpRaw = 30 天", DEFAULT_RETENTION_POLICY.serpRaw.ttlDays, 30);
  eq("默认 aiRaw = 90 天", DEFAULT_RETENTION_POLICY.aiRaw.ttlDays, 90);
  eq("默认 siteRaw = 30 天", DEFAULT_RETENTION_POLICY.siteRaw.ttlDays, 30);

  const oldEv = ev({ id: "ev_old", subject: siteSubject("https://o.com"), source: httpSource("https://o.com"), kind: "serp_html", observedAt: "2020-01-01T00:00:00.000Z", bodyRef: "/tmp/blob.txt" });
  const freshEv = ev({ id: "ev_fresh", subject: siteSubject("https://o.com"), source: httpSource("https://o.com"), kind: "serp_html", observedAt: new Date().toISOString() });
  const plan = planRetention([oldEv, freshEv], new Date(), DEFAULT_RETENTION_POLICY);
  eq("过期条目进入清理计划", plan.map((p) => p.id), ["ev_old"]);
  eq("计划指向 blob（不是 metadata 行）", plan[0]?.bodyRef, "/tmp/blob.txt");
  check("计划不执行删除（文件仍在）", existsSync(legacyFile));

  /* ---------- 收尾 ---------- */
  console.log(`\n${"─".repeat(52)}`);
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log("\n失败明细：");
    for (const f of failures) console.log(`  ❌ [${f.group}] ${f.name} — ${f.detail}`);
  }

  rmSync(TMP, { recursive: true, force: true });
  rmSync(legacyDir, { recursive: true, force: true });
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => {
  console.error("测试脚本异常：", e);
  process.exitCode = 1;
});
