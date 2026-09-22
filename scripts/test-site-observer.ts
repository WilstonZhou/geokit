/**
 * S3 / Site Observer 契约测试（零新增依赖，沿用 test-store.ts 的路子）。
 *
 * 覆盖 S3 Final Implementation Gate §11 的测试方案：
 *   1  Observer Unit      Evidence → Observation 的纯映射
 *   2  Identity           inputUrl / finalUrl / subject / source
 *   3  HTTP               200 / 404 / 410 / 403 / 429 / 5xx / 网络失败 / 空 body
 *   4  Evidence           body 门槛、evidenceRefs 非空且真实存在
 *   5  Contract           contractVersion / type / 版本三元组 / 禁止重复存储 body
 *   6  Store              replaces 不由 S3 决定、版本演进建链、历史保留
 *   7  Regression         analyze() 口径不变（11 项 + SEO/GEO 分数）
 *
 * 用法：npx tsx scripts/test-site-observer.ts
 */
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonlStore } from "../src/lib/store/jsonl";
import type { Evidence, Observation } from "../src/lib/evidence/types";
import {
  EVIDENCE_CONTRACT_VERSION,
  OBSERVATION_CONTRACT_VERSION,
} from "../src/lib/evidence/types";
import { normalizeEvidence } from "../src/lib/evidence/normalize";
import { httpSource, siteSubject } from "../src/lib/evidence/identity";
import { analyze } from "../src/lib/audit";
import {
  AUDIT_PARSER_VERSION,
  SITE_CHECK_TOTAL,
  SITE_OBSERVER_VERSION,
  observeSite,
  recordSiteObservation,
} from "../src/lib/observers/site";

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

const TMP = mkdtempSync(join(tmpdir(), "geokit-site-observer-"));
const store = new JsonlStore(TMP);

const HTML = readFileSync(
  join(process.cwd(), "tests", "fixtures", "audit", "sample.html"),
  "utf8"
);

interface PageOpts {
  id: string;
  /** finalUrl —— identity 一律由它决定 */
  url: string;
  status?: number;
  bodyRetained?: boolean;
  error?: { kind: string; message: string };
  /** 用户输入 URL（重定向前） */
  inputUrl?: string;
  observedAt?: string;
}

/** 构造一条 canonical page_html Evidence（带 provenance，不会被判成旧记录） */
function pageEvidence(p: PageOpts): Evidence {
  const at = p.observedAt ?? "2026-09-22T00:00:00.000Z";
  const status = p.status ?? 200;
  const inputUrl = p.inputUrl ?? p.url;
  return normalizeEvidence({
    id: p.id,
    contractVersion: EVIDENCE_CONTRACT_VERSION,
    kind: "page_html",
    subject: siteSubject(p.url),
    source: httpSource(p.url),
    observedAt: at,
    target: inputUrl,
    requestUrl: inputUrl,
    request: { method: "GET", headers: {}, bodyByteLength: 0 },
    response: {
      httpStatus: status,
      finalUrl: p.url,
      headers: {},
      bodyHash: "hash-" + p.id,
      byteLength: Buffer.byteLength(HTML, "utf8"),
      bodyRetained: p.bodyRetained ?? true,
      bodyRef: null,
    },
    timing: { requestedAt: at, elapsedMs: 120, waitedMs: 0, attempts: 1 },
    context: { purpose: "audit", meta: { inputUrl } },
    error: p.error,
    createdAt: at,
    metadata: { purpose: "audit", extra: { inputUrl } },
    provenance: {
      method: "GET",
      requestUrl: inputUrl,
      finalUrl: p.url,
      httpStatus: status,
      requestHeaders: {},
      responseHeaders: {},
      requestedAt: at,
      elapsedMs: 120,
      waitedMs: 0,
      attempts: 1,
      error: p.error,
    },
  });
}

function keysOf(v: unknown): string[] {
  return Object.keys(v as Record<string, unknown>);
}

function hasKey(v: unknown, k: string): boolean {
  return k in (v as Record<string, unknown>);
}

/** 观测并强制取回 Observation；用于「这一档必须产结论」的用例 */
function mustObserve(ev: Evidence, body: string, inputUrl?: string): Observation<unknown> {
  const r = observeSite({ evidence: ev, body, inputUrl });
  if (!r.ok) throw new Error(`本应产出 Observation，实际被拒：${r.reason}`);
  return r.observation as Observation<unknown>;
}

async function main(): Promise<void> {
  /* ---------- 1 · Observer Unit：基本映射 ---------- */
  section("1 · 基本映射（fixture HTML）");

  const ev1 = pageEvidence({ id: "ev_1", url: "https://whivi.com/guide", inputUrl: "https://whivi.com/guide" });
  const obs1 = mustObserve(ev1, HTML, "https://whivi.com/guide");

  eq("type = geo_score（不是 seo_score）", obs1.type, "geo_score");
  eq("contractVersion = 0.2.0", obs1.contractVersion, OBSERVATION_CONTRACT_VERSION);
  eq("subject 复制自 Evidence", obs1.subject, ev1.subject);
  eq("source 复制自 Evidence", obs1.source, ev1.source);
  eq("observedAt 复制自 Evidence", obs1.observedAt, ev1.observedAt);
  eq("evidenceRefs 指向该 Evidence", obs1.evidenceRefs, ["ev_1"]);
  eq("observerVersion", obs1.observerVersion, SITE_OBSERVER_VERSION);
  eq("parserVersion", obs1.parserVersion, AUDIT_PARSER_VERSION);
  eq("runId 不设（OPEN-6）", obs1.runId, undefined);
  eq("status", obs1.status, "OBSERVED");
  eq("confidence", obs1.confidence, "high");
  eq("coverage", obs1.coverage, { expected: 11, observed: 11, ratio: 1 });

  const audit1 = obs1.result as ReturnType<typeof analyze>;
  eq("result.checks = 11 项", audit1.checks.length, SITE_CHECK_TOTAL);
  eq("result.seoScore 与 analyze 一致", audit1.seoScore, analyze("https://whivi.com/guide", HTML, 200, 120).seoScore);
  eq("result.geoScore 与 analyze 一致", audit1.geoScore, analyze("https://whivi.com/guide", HTML, 200, 120).geoScore);
  check("SEO 分数留在 result 内（不新增 seo_score kind）", typeof audit1.seoScore === "number");
  eq("metadata.extra.inputUrl 保留", obs1.metadata?.extra?.inputUrl, "https://whivi.com/guide");
  eq("caveat 在无异常时省略", obs1.caveat, undefined);

  /* ---------- 2 · 禁止重复存储 body ---------- */
  section("2 · 不重复存储 Evidence body");

  const resultKeys = keysOf(audit1);
  check("result 不含 html 字段", !resultKeys.includes("html"), resultKeys.join(","));
  check("result 不含 body 字段", !resultKeys.includes("body"), resultKeys.join(","));
  check("Observation 顶层不含 body", !hasKey(obs1, "body"));
  check("Observation 顶层不含 html", !hasKey(obs1, "html"));
  check("Observation 顶层不含 response", !hasKey(obs1, "response"));
  check("Observation 顶层不含 headers", !hasKey(obs1, "headers"));

  /* ---------- 3 · Identity：重定向 ---------- */
  section("3 · Identity（重定向 finalUrl）");

  const evR = pageEvidence({
    id: "ev_r",
    url: "https://www.example.com/",
    inputUrl: "https://example.com",
  });
  const obsR = mustObserve(evR, HTML, "https://example.com");
  eq("Evidence.subject = finalUrl 版", evR.subject, "site:https://www.example.com");
  eq("Evidence.source = origin 级", evR.source, "http:https://www.example.com");
  eq("Observation.subject 与 Evidence 逐字相同", obsR.subject, evR.subject);
  eq("Observation.source 与 Evidence 逐字相同", obsR.source, evR.source);
  check("subject 不是输入 URL", !obsR.subject.includes("://example.com\"") && obsR.subject === "site:https://www.example.com");
  eq("输入 URL 只在 metadata 里", obsR.metadata?.extra?.inputUrl, "https://example.com");

  /* ---------- 4 · HTTP 状态映射 ---------- */
  section("4 · HTTP 状态映射");

  const s200 = mustObserve(pageEvidence({ id: "ev_200", url: "https://a.com" }), HTML);
  eq("200 → OBSERVED", s200.status, "OBSERVED");

  const s404 = mustObserve(pageEvidence({ id: "ev_404", url: "https://a.com/404", status: 404 }), HTML);
  eq("404 → OBSERVED（不是 ERROR）", s404.status, "OBSERVED");
  check("404 caveat 说明目标不存在", (s404.caveat ?? "").includes("目标不存在"), s404.caveat ?? "");
  eq("404 的真实 HTTP 状态进 result", (s404.result as ReturnType<typeof analyze>).httpStatus, 404);

  const s410 = mustObserve(pageEvidence({ id: "ev_410", url: "https://a.com/x", status: 410 }), HTML);
  eq("410 → OBSERVED", s410.status, "OBSERVED");
  check("410 caveat 说明目标不存在", (s410.caveat ?? "").includes("目标不存在"));

  const s403 = mustObserve(pageEvidence({ id: "ev_403", url: "https://a.com", status: 403 }), HTML);
  eq("403 → BLOCKED", s403.status, "BLOCKED");
  const s429 = mustObserve(pageEvidence({ id: "ev_429", url: "https://a.com", status: 429 }), HTML);
  eq("429 → BLOCKED", s429.status, "BLOCKED");
  const s401 = mustObserve(pageEvidence({ id: "ev_401", url: "https://a.com", status: 401 }), HTML);
  eq("401 → BLOCKED", s401.status, "BLOCKED");

  const s500 = mustObserve(pageEvidence({ id: "ev_500", url: "https://a.com", status: 500 }), HTML);
  eq("5xx → ERROR", s500.status, "ERROR");
  eq("ERROR 时 confidence = unavailable", s500.confidence, "unavailable");

  const s301 = mustObserve(pageEvidence({ id: "ev_301", url: "https://a.com/old", status: 301 }), HTML);
  eq("301 → OBSERVED", s301.status, "OBSERVED");
  check("301 caveat 说明未跟随", (s301.caveat ?? "").includes("未跟随"));

  const net = mustObserve(
    pageEvidence({
      id: "ev_net",
      url: "https://a.com",
      status: 0,
      bodyRetained: false,
      error: { kind: "network", message: "fetch failed" },
    }),
    ""
  );
  eq("网络失败 → UNOBSERVABLE", net.status, "UNOBSERVABLE");
  eq("UNOBSERVABLE 时不跑 11 项检查", (net.result as ReturnType<typeof analyze>).checks.length, 1);
  eq("UNOBSERVABLE 时 seoScore = 0（不虚报）", (net.result as ReturnType<typeof analyze>).seoScore, 0);
  eq("UNOBSERVABLE 时 geoScore = 0（不虚报）", (net.result as ReturnType<typeof analyze>).geoScore, 0);
  eq("UNOBSERVABLE 时 coverage.observed = 0", net.coverage.observed, 0);
  eq("UNOBSERVABLE 时 confidence = unavailable", net.confidence, "unavailable");
  check("UNOBSERVABLE caveat 说明是「没能观测」", (net.caveat ?? "").includes("没能观测"), net.caveat ?? "");

  const tooLarge = mustObserve(
    pageEvidence({
      id: "ev_big",
      url: "https://a.com",
      status: 0,
      bodyRetained: false,
      error: { kind: "too_large", message: "响应体超过上限" },
    }),
    ""
  );
  eq("too_large → ERROR", tooLarge.status, "ERROR");
  const badUrl = mustObserve(
    pageEvidence({
      id: "ev_url",
      url: "https://a.com",
      status: 0,
      bodyRetained: false,
      error: { kind: "invalid_url", message: "URL 无法解析" },
    }),
    ""
  );
  eq("invalid_url → ERROR", badUrl.status, "ERROR");

  const empty200 = mustObserve(pageEvidence({ id: "ev_empty", url: "https://a.com", status: 200 }), "");
  eq("200 但空 body → PARTIAL", empty200.status, "PARTIAL");
  eq("PARTIAL 时 confidence = unavailable", empty200.confidence, "unavailable");
  eq("PARTIAL 时 coverage.observed = 0", empty200.coverage.observed, 0);

  /* ---------- 5 · Evidence 门槛：hash-only 不冒充 ---------- */
  section("5 · Evidence body 门槛");

  const hashOnly = pageEvidence({ id: "ev_hash", url: "https://a.com", status: 200, bodyRetained: false });
  const rHash = observeSite({ evidence: hashOnly, body: "" });
  check("hash-only（有响应无正文）→ 不产 Observation", rHash.ok === false);
  check(
    "拒绝原因明确指向未留存正文",
    rHash.ok === false && rHash.reason.includes("hash-only"),
    rHash.ok === false ? rHash.reason : ""
  );

  const hashOnlyWithBody = observeSite({ evidence: hashOnly, body: HTML });
  check("即使调用方手上有 HTML，bodyRetained=false 仍拒收", hashOnlyWithBody.ok === false);

  /* ---------- 6 · Contract：replaces 不由 S3 决定 ---------- */
  section("6 · replaces 语义保护");

  const obsNoReplace = mustObserve(pageEvidence({ id: "ev_rp", url: "https://a.com" }), HTML);
  check("S3 产出的 Observation 不带 replaces", obsNoReplace.replaces === undefined);

  const tampered: Observation = { ...(obsNoReplace as Observation), replaces: "obs_fake_chain" };
  const saved1 = await store.saveObservation(tampered);
  const read1 = await store.getObservation(saved1.id);
  eq("★ 即便 S3 误传 replaces，落库后仍由 Store 决定", read1?.replaces, undefined);

  /* ---------- 7 · Integration：落库与历史 ---------- */
  section("7 · 落库 / 历史 / Evidence immutable");

  const dir2 = mkdtempSync(join(tmpdir(), "geokit-site-obs2-"));
  const store2 = new JsonlStore(dir2);

  const evA = pageEvidence({ id: "ev_A", url: "https://b.com/p", observedAt: "2026-09-22T01:00:00.000Z" });
  await store2.saveEvidence(evA, { body: HTML });
  const rec1 = await recordSiteObservation(store2, { evidence: evA, body: HTML, inputUrl: "https://b.com/p" });
  check("落库成功", rec1.ok === true, rec1.ok ? rec1.id : rec1.reason);

  const got = rec1.ok ? await store2.getObservation(rec1.id) : null;
  eq("回读命中", got?.subject, "site:https://b.com/p");
  eq("evidenceRefs 只指向真实存在的 Evidence", (await store2.getEvidence("ev_A"))?.id, "ev_A");
  check(
    "evidenceRefs 无空引用",
    (got?.evidenceRefs ?? []).every(async (id) => (await store2.getEvidence(id)) !== null)
  );

  // 无 runId → 每次观测都是一条新历史（不是替换）
  const rec2 = await recordSiteObservation(store2, { evidence: evA, body: HTML, inputUrl: "https://b.com/p" });
  check("无 runId 再观测 → 新历史（id 不同）", rec2.ok && rec1.ok && rec2.id !== rec1.id);
  const all2 = await store2.listObservations({});
  eq("历史累计 2 条", all2.length, 2);

  // 版本演进 → 新记录 + replaces 指向前一版本
  const v2Obs = mustObserve(evA, HTML);
  const savedV2 = await store2.saveObservation({
    ...(v2Obs as Observation),
    parserVersion: "audit-checks@2.0.0",
  });
  const readV2 = await store2.getObservation(savedV2.id);
  eq("parserVersion 变化 → 新记录", savedV2.created, true);
  eq("replaces 指向前一版本", readV2?.replaces, rec2.ok ? rec2.id : "");
  eq("版本演进后历史 3 条", (await store2.listObservations({})).length, 3);

  // 同 runId 同版本重算 → 保持原 id，链不增长。
  // 用**独立 store**：上面已经给同一 identity 写过 v1/v2，沿用会让新记录
  // 命中「版本演进」而带上 replaces，测不到幂等重算本身。
  const dir3 = mkdtempSync(join(tmpdir(), "geokit-site-obs3-"));
  const store3 = new JsonlStore(dir3);
  const evC = pageEvidence({ id: "ev_C", url: "https://d.com/p" });
  const v1Obs = mustObserve(evC, HTML);
  const runId = "run_recompute";
  const savedR1 = await store3.saveObservation({ ...(v1Obs as Observation), runId });
  const savedR2 = await store3.saveObservation({ ...(v1Obs as Observation), runId });
  eq("同 run + 同版本 → 保持原 id", savedR2.id, savedR1.id);
  eq("同 run + 同版本 → 不产生 replaces 链", (await store3.getObservation(savedR2.id))?.replaces, undefined);
  eq("同 run + 同版本 → 历史只有 1 条", (await store3.listObservations({})).length, 1);
  rmSync(dir3, { recursive: true, force: true });

  // Evidence 全程 immutable
  const evList = await store2.listEvidence({});
  eq("Evidence 仍只有 1 条（Observation 的替换不触碰它）", evList.length, 1);
  eq("Evidence contentHash 未变", evList[0]?.contentHash, "hash-ev_A");

  // 离线模式：没有 Evidence 就没有 Observation
  const offline = await recordSiteObservation(store2, {
    evidence: pageEvidence({ id: "ev_off", url: "https://c.com", status: 200, bodyRetained: false }),
    body: "",
  });
  check("无合法 Evidence → 不产 Observation（OPEN-7 同构）", offline.ok === false);

  rmSync(dir2, { recursive: true, force: true });

  /* ---------- 8 · analyze() 口径未变 ---------- */
  section("8 · analyze() 口径保护");

  const base = analyze("https://whivi.com/guide", HTML, 200, 120);
  eq("11 项检查 id 集合不变", base.checks.map((c) => c.id), [
    "http", "title", "desc", "canonical", "robots", "h1",
    "alt", "viewport", "lang", "jsonld", "og",
  ]);
  eq("SEO 91（baseline）", base.seoScore, 91);
  eq("GEO 70（baseline）", base.geoScore, 70);

  /* ---------- 收尾 ---------- */
  console.log(`\n${"─".repeat(52)}`);
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log("\n失败明细：");
    for (const f of failures) console.log(`  ❌ [${f.group}] ${f.name} — ${f.detail}`);
  }

  rmSync(TMP, { recursive: true, force: true });
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => {
  console.error("测试脚本异常：", e);
  process.exitCode = 1;
});
