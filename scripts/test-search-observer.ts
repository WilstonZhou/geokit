/**
 * S4 / Search Observer 契约测试（零新增依赖，沿用 test-site-observer.ts 的路子）。
 *
 * 覆盖：
 *   1  Contract      contractVersion / type=rank / 版本三元组 / evidenceRefs 真实
 *   2  Identity      subject = search:site=|q=；source = search-engine:<engine>；
 *                    ★ 引擎不进 subject，不同引擎靠 source 区分
 *   3  Status        ok 上榜 / ok 未上榜 / no_results / blocked / error
 *   4  Hard gate     无 Evidence 不产结论；hash-only 不产结论
 *   5  Confidence    上限 medium（单引擎单次不具统计意义）
 *   6  Storage       不重复存储 HTML；validUntil 时效
 *   7  Store         无 runId → 新历史；strategyVersion 变化 → replaces 链；
 *                    Evidence 仍 immutable
 *   8  Strategy      三家引擎解析策略版本
 *
 * 用法：npx tsx scripts/test-search-observer.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonlStore } from "../src/lib/store/jsonl";
import type { Evidence, Observation } from "../src/lib/evidence/types";
import { OBSERVATION_CONTRACT_VERSION } from "../src/lib/evidence/types";
import { evidenceFromFetch } from "../src/lib/evidence/store";
import {
  searchEngineSource,
  searchSubject,
  serpStrategyVersion,
  SERP_STRATEGY_VERSIONS,
} from "../src/lib/evidence/identity";
import type { FetchResult } from "../src/lib/fetcher";
import type { SerpResponse } from "../src/lib/serp";
import {
  SEARCH_OBSERVER_VERSION,
  SERP_OBSERVATION_TTL_MS,
  SERP_PARSER_VERSION,
  observeSearch,
  recordSearchObservation,
} from "../src/lib/observers/search";

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

const TMP = mkdtempSync(join(tmpdir(), "geokit-search-observer-"));
const store = new JsonlStore(TMP);

const REQUESTED_AT = "2026-09-22T02:00:00.000Z";

/** 造一条 canonical 的 serp_html Evidence（走与生产相同的 evidenceFromFetch） */
function makeEvidence(opts: {
  engineId: string;
  keyword: string;
  targetDomain?: string;
  status?: number;
  body?: string;
  retain?: boolean;
}): Evidence {
  const status = opts.status ?? 200;
  const body = opts.body ?? `<html><body>serp page for ${opts.keyword}</body></html>`;
  const url = `https://www.${opts.engineId}.com/s?wd=${encodeURIComponent(opts.keyword)}`;

  const res = {
    ok: status >= 200 && status < 300,
    status,
    finalUrl: url,
    headers: {},
    body,
    byteLength: Buffer.byteLength(body),
    bodyHash: `hash-${opts.engineId}`,
    elapsedMs: 12,
    attempts: [],
    waitedMs: 0,
    request: { url, method: "GET", headers: {} },
    context: {
      purpose: "serp",
      target: opts.engineId,
      subject: searchSubject(opts.targetDomain, opts.keyword),
      source: searchEngineSource(opts.engineId),
      meta: { engineId: opts.engineId, keyword: opts.keyword },
      requestedAt: REQUESTED_AT,
    },
  } as unknown as FetchResult;

  const ev = evidenceFromFetch(res, "serp_html");
  // 与生产同构的兜底修正（S1 已知缺陷）
  ev.subject = searchSubject(opts.targetDomain, opts.keyword);
  ev.source = searchEngineSource(opts.engineId);
  ev.migratedFrom = undefined;
  ev.response.bodyRetained = opts.retain ?? true;
  return ev;
}

function makeResponse(over: Partial<SerpResponse> & { engine: SerpResponse["engine"] }): SerpResponse {
  return {
    engineName: over.engine,
    keyword: "跨境支付",
    status: "ok",
    items: [],
    targetRank: null,
    targetFound: false,
    fetchedAt: REQUESTED_AT,
    elapsedMs: 12,
    ...over,
  } as SerpResponse;
}

/** 观测并强制取回 Observation */
function mustObserve(
  evidences: Evidence[],
  response: SerpResponse,
  targetDomain?: string
): Observation<SerpResponse> {
  const r = observeSearch({ evidences, response, targetDomain });
  if (!r.ok) throw new Error(`本应产出 Observation，实际被拒：${r.reason}`);
  return r.observation;
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const evBaidu = makeEvidence({ engineId: "baidu", keyword: "跨境支付", targetDomain: "example.com" });
  const ranked = makeResponse({
    engine: "baidu",
    items: [
      { position: 1, title: "A", url: "https://a.com", domain: "a.com", snippet: "", owned: false, redirectWrapper: false, resolved: true },
      { position: 2, title: "B", url: "https://example.com", domain: "example.com", snippet: "", owned: false, redirectWrapper: false, resolved: true },
    ],
    targetRank: 2,
    targetFound: true,
  });

  /* ---------- 1 · 契约 ---------- */
  section("1 · 契约");
  const obs1 = mustObserve([evBaidu], ranked, "example.com");
  eq("contractVersion = 0.2.0", obs1.contractVersion, OBSERVATION_CONTRACT_VERSION);
  eq("type = rank", obs1.type, "rank");
  eq("observerVersion", obs1.observerVersion, SEARCH_OBSERVER_VERSION);
  eq("parserVersion", obs1.parserVersion, SERP_PARSER_VERSION);
  eq("strategyVersion（百度 = baidu-mu@1）", obs1.strategyVersion, "baidu-mu@1");
  eq("evidenceRefs 指向真实 Evidence", obs1.evidenceRefs, [evBaidu.id]);
  eq("observedAt 取自 Evidence", obs1.observedAt, REQUESTED_AT);
  check("evidenceRefs 非空", obs1.evidenceRefs.length > 0, String(obs1.evidenceRefs.length));
  check("不设置 replaces", obs1.replaces === undefined, String(obs1.replaces));
  check("不设置 runId", obs1.runId === undefined, String(obs1.runId));

  /* ---------- 2 · Identity ---------- */
  section("2 · Identity");
  eq("subject = search:site=|q=", obs1.subject, searchSubject("example.com", "跨境支付"));
  eq("source = search-engine:baidu", obs1.source, searchEngineSource("baidu"));
  check("subject 不含引擎 id", !obs1.subject.includes("baidu"), obs1.subject);
  check("source 不含关键词", !obs1.source.includes("跨境支付"), obs1.source);

  const noDomain = mustObserve([evBaidu], ranked);
  check("未指定域名 → subject 用 site=* 占位", noDomain.subject.includes("site=*"), noDomain.subject);

  const evSogou = makeEvidence({ engineId: "sogou", keyword: "跨境支付", targetDomain: "example.com" });
  const obsSogou = mustObserve([evSogou], makeResponse({ engine: "sogou", targetRank: 5, targetFound: true }), "example.com");
  eq("不同引擎 subject 相同（同一被观测对象）", obsSogou.subject, obs1.subject);
  eq("不同引擎 source 不同（不同观测来源）", obsSogou.source, "search-engine:sogou");
  eq("搜狗 strategyVersion", obsSogou.strategyVersion, "sogou-citeLinkClass@1");

  /* ---------- 3 · 状态映射 ---------- */
  section("3 · 状态映射");
  eq("ok + 上榜 → OBSERVED", obs1.status, "OBSERVED");
  check("ok + 上榜 → 无 caveat", obs1.caveat === undefined, String(obs1.caveat));

  const notRanked = mustObserve(
    [evBaidu],
    makeResponse({ engine: "baidu", targetRank: null, targetFound: false }),
    "example.com"
  );
  eq("ok + 未上榜 → 仍是 OBSERVED（真实结论）", notRanked.status, "OBSERVED");
  check("未上榜带 caveat 说明", (notRanked.caveat ?? "").includes("未上榜"), notRanked.caveat ?? "");

  const noResults = mustObserve(
    [evBaidu],
    makeResponse({ engine: "baidu", status: "no_results", note: "未解析出条目" })
  );
  eq("no_results → UNOBSERVABLE（不是「未上榜」）", noResults.status, "UNOBSERVABLE");
  check("no_results caveat 说明无法判定", (noResults.caveat ?? "").includes("无法判定"), noResults.caveat ?? "");

  const blocked = mustObserve(
    [makeEvidence({ engineId: "baidu", keyword: "跨境支付", status: 403 })],
    makeResponse({ engine: "baidu", status: "blocked", note: "被限流" })
  );
  eq("blocked → BLOCKED", blocked.status, "BLOCKED");
  check("blocked caveat 含原因", (blocked.caveat ?? "").includes("限流"), blocked.caveat ?? "");

  const errored = mustObserve(
    [makeEvidence({ engineId: "baidu", keyword: "跨境支付", status: 500 })],
    makeResponse({ engine: "baidu", status: "error", note: "连接失败" })
  );
  eq("error → ERROR", errored.status, "ERROR");

  /* ---------- 4 · 硬门槛 ---------- */
  section("4 · 硬门槛");
  const noEv = observeSearch({ evidences: [], response: ranked, targetDomain: "example.com" });
  check("无 Evidence → 不产结论", !noEv.ok, noEv.ok ? "竟产出了" : (noEv as { reason: string }).reason);

  const hashOnly = observeSearch({
    evidences: [makeEvidence({ engineId: "baidu", keyword: "跨境支付", retain: false })],
    response: ranked,
    targetDomain: "example.com",
  });
  check("hash-only Evidence → 不产结论", !hashOnly.ok, hashOnly.ok ? "竟产出了" : (hashOnly as { reason: string }).reason);

  /* ---------- 5 · confidence / coverage ---------- */
  section("5 · confidence / coverage");
  eq("OBSERVED 时 confidence 上限 medium", obs1.confidence, "medium");
  eq("非 OBSERVED → unavailable", noResults.confidence, "unavailable");
  eq("coverage.expected = 1", obs1.coverage.expected, 1);
  eq("ok → coverage.observed = 1", obs1.coverage.observed, 1);
  eq("no_results → coverage.observed = 0", noResults.coverage.observed, 0);
  check("coverage 缺失项标出引擎", JSON.stringify(noResults.coverage.missing ?? []).includes("baidu"), JSON.stringify(noResults.coverage.missing));

  /* ---------- 6 · 不重复存储 + 时效 ---------- */
  section("6 · 不重复存储 + 时效");
  const topKeys = Object.keys(obs1 as unknown as Record<string, unknown>);
  check("顶层无 body", !topKeys.includes("body"), topKeys.join(","));
  check("顶层无 html", !topKeys.includes("html"), topKeys.join(","));
  check("顶层无 response/headers", !topKeys.includes("response") && !topKeys.includes("headers"), topKeys.join(","));
  const resultKeys = Object.keys(ranked as unknown as Record<string, unknown>);
  check("result 不含原始 HTML 字段", !resultKeys.some((k) => /html|body/i.test(k)), resultKeys.join(","));

  const vu = (obs1.metadata?.extra?.validUntil as string) ?? "";
  const expectedVu = new Date(new Date(REQUESTED_AT).getTime() + SERP_OBSERVATION_TTL_MS).toISOString();
  eq("validUntil = observedAt + 24h", vu, expectedVu);
  check("validUntil 写进 metadata 而非顶层", !topKeys.includes("validUntil"), topKeys.join(","));

  /* ---------- 7 · Store ---------- */
  section("7 · Store");
  const evA = makeEvidence({ engineId: "baidu", keyword: "跨境支付", targetDomain: "example.com" });
  const savedEv = await store.saveEvidence(evA, { body: "<html>serp</html>" });
  const respA = makeResponse({ engine: "baidu", targetRank: 3, targetFound: true });

  const rec1 = await recordSearchObservation(store, {
    evidences: [evA],
    response: respA,
    targetDomain: "example.com",
  });
  check("落库成功", rec1.ok, rec1.ok ? rec1.id : rec1.reason);
  const id1 = rec1.ok ? rec1.id : "";
  const got1 = await store.getObservation(id1);
  eq("回读命中", got1?.subject, searchSubject("example.com", "跨境支付"));
  eq("回读保留 result.targetRank", (got1?.result as SerpResponse | undefined)?.targetRank, 3);

  // 无 runId 再观测一次 → 新历史（时间推进）
  const rec2 = await recordSearchObservation(store, {
    evidences: [evA],
    response: makeResponse({ engine: "baidu", targetRank: 7, targetFound: true }),
    targetDomain: "example.com",
  });
  check("第二次采集 → 新记录（不是替换）", rec2.ok && rec2.id !== id1, rec2.ok ? rec2.id : rec2.reason);
  const id2 = rec2.ok ? rec2.id : "";
  eq("跨观测不建 replaces 链（时间推进 ≠ 版本演进）", (await store.getObservation(id2))?.replaces, undefined);
  eq("历史累计 2 条", (await store.listObservations()).length, 2);

  // strategyVersion 变化 → 版本演进，replaces 指向被取代的上一条
  const evolved = mustObserve([evA], respA, "example.com");
  const savedEvolved = await store.saveObservation({
    ...(evolved as Observation),
    strategyVersion: "baidu-mu@2",
  });
  const gotEvolved = await store.getObservation(savedEvolved.id);
  check("版本演进 → 新记录", savedEvolved.id !== id2, savedEvolved.id);
  eq("replaces 指向被取代的那条", gotEvolved?.replaces, id2);
  eq("历史累计 3 条", (await store.listObservations()).length, 3);

  // Evidence immutable
  const evAfter = await store.getEvidence(savedEv.id);
  eq("Evidence 仍只有 1 条", (await store.listEvidence()).length, 1);
  eq("Evidence contentHash 未变", evAfter?.contentHash, evA.contentHash);

  /* ---------- 8 · 三家引擎策略版本 ---------- */
  section("8 · 三家引擎解析策略版本");
  eq("百度", serpStrategyVersion("baidu"), SERP_STRATEGY_VERSIONS.baidu);
  eq("360", serpStrategyVersion("so360"), "so360-data-mdurl@1");
  eq("搜狗", serpStrategyVersion("sogou"), "sogou-citeLinkClass@1");
  check("未知引擎不编造策略版本", serpStrategyVersion("google") === undefined, String(serpStrategyVersion("google")));

  /* ---------- 汇总 ---------- */
  console.log(`\n${"─".repeat(52)}`);
  if (failures.length === 0) {
    console.log(`通过 ${passed} 项，失败 0 项`);
  } else {
    console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
    for (const f of failures) console.log(`  ❌ [${f.group}] ${f.name} — ${f.detail}`);
  }
  rmSync(TMP, { recursive: true, force: true });
  if (failures.length > 0) process.exit(1);
}

main();
