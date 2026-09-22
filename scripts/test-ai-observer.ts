/**
 * S5 / AI Observer 契约测试（零新增依赖，沿用 test-search-observer.ts 的路子）。
 *
 * 覆盖：
 *   1  Contract      contractVersion / type=ai_mention / 版本三元组 / evidenceRefs 真实
 *   2  Identity      subject = ai-slot:<provider>:<requestedModel>（★ requestedModel）
 *                    source = provider:<id>；servedModel 漂移只进 metadata
 *   3  Six states    六态恒等映射（含第六态 INDETERMINATE）
 *   4  Hard gate     无 Evidence 不产结论；hash-only 不产结论；status=0 例外（同 S3）
 *   5  Confidence    可判定恒为 medium（永不上 high）；其余 unavailable
 *   6  Storage       result 不含原始回答全文，只留 rawResponseChars
 *   7  Store         落库回读 / 无 runId 两次 → 两条历史不建链 / Evidence immutable
 *   8  INDETERMINATE 拒答产出第六态：即便文本含品牌也 mentioned=false
 *   9  No regression 正常回答含品牌 → MENTIONED；不含 → NOT_MENTIONED（五态不退化）
 *
 * 用法：npx tsx scripts/test-ai-observer.ts
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Evidence, Observation, ObservationStatus } from "../src/lib/evidence/types";
import { OBSERVATION_CONTRACT_VERSION } from "../src/lib/evidence/types";
import { evidenceFromFetch } from "../src/lib/evidence/store";
import { aiSlotSubject, providerSource } from "../src/lib/evidence/identity";
import type { FetchResult } from "../src/lib/fetcher";
import { JsonlStore } from "../src/lib/store/jsonl";
import type { Store } from "../src/lib/store";
import {
  AI_VISIBILITY_PARSER_VERSION,
  PROVIDERS,
  SAMPLING_PROFILE,
  judgeAnswerSignal,
  probeProvider,
  type AiProvider,
  type VisibilityProbe,
} from "../src/lib/visibility";
import {
  AI_MENTION_PARSER_VERSION,
  AI_OBSERVER_VERSION,
  observeAi,
  recordAiObservation,
  type AiMentionResult,
} from "../src/lib/observers/ai";

/* ------------------------------------------------------------------ */
/* 临时存证目录 —— 必须在 import 之后、调用之前设置                        */
/* ------------------------------------------------------------------ */

const TMP = mkdtempSync(join(tmpdir(), "geokit-ai-observer-"));
process.env.GEOKIT_EVIDENCE = "on";
process.env.GEOKIT_EVIDENCE_DIR = TMP;
process.env.GEOKIT_STORE_DIR = TMP;

const store: Store = new JsonlStore(TMP);

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

const REQUESTED_AT = "2026-09-22T04:00:00.000Z";
const BRAND = "鲸汇通";
const TOPIC = "跨境支付平台推荐";

/** 造一条 canonical 的 llm_response Evidence（走与生产相同的 evidenceFromFetch） */
function makeEvidence(opts?: {
  status?: number;
  body?: string;
  retain?: boolean;
  providerId?: string;
  requestedModel?: string;
}): Evidence {
  const o = opts ?? {};
  const status = o.status ?? 200;
  const providerId = o.providerId ?? "deepseek";
  const requestedModel = o.requestedModel ?? "deepseek-chat";
  const body =
    o.body ??
    JSON.stringify({ choices: [{ message: { content: "一段正常的回答内容，足够长。" } }], model: "deepseek-flash" });
  const url = `https://api.${providerId}.com/chat/completions`;

  const res = {
    ok: status >= 200 && status < 300,
    status,
    finalUrl: url,
    headers: {},
    body,
    byteLength: Buffer.byteLength(body),
    bodyHash: `hash-${providerId}`,
    elapsedMs: 320,
    attempts: [],
    waitedMs: 0,
    request: { url, method: "POST", headers: {} },
    context: {
      purpose: "ai-visibility",
      target: providerId,
      subject: aiSlotSubject(providerId, requestedModel),
      source: providerSource(providerId),
      meta: { providerId, requestedModel },
      requestedAt: REQUESTED_AT,
    },
  } as unknown as FetchResult;

  const ev = evidenceFromFetch(res, "llm_response");
  // 与生产同构的兜底修正（S1 已知缺陷）
  ev.subject = aiSlotSubject(providerId, requestedModel);
  ev.source = providerSource(providerId);
  ev.migratedFrom = undefined;
  ev.response.bodyRetained = o.retain ?? true;
  return ev;
}

const BASE_PROBE: VisibilityProbe = {
  provider: "deepseek",
  providerName: "DeepSeek",
  vendor: "深度求索",
  status: "MENTIONED",
  mentioned: true,
  excerpt: "在跨境收款场景中，鲸汇通…",
  rawResponse: "在跨境收款场景中，鲸汇通是一类值得关注的服务商，提供多币种结算与合规通道。",
  citedDomains: ["whivi.com"],
  requestedModel: "deepseek-chat",
  servedModel: "deepseek-flash",
  requestParams: { ...SAMPLING_PROFILE },
  promptVersion: "1.0.0",
  promptHash: "abc123",
  parserVersion: AI_VISIBILITY_PARSER_VERSION,
  confidence: "medium",
  evidenceId: null,
  elapsedMs: 320,
};

function makeProbe(status: ObservationStatus, over: Partial<VisibilityProbe> = {}): VisibilityProbe {
  const determinable = status === "MENTIONED" || status === "NOT_MENTIONED";
  return {
    ...BASE_PROBE,
    status: status as VisibilityProbe["status"],
    mentioned: determinable && status === "MENTIONED",
    confidence: determinable ? "medium" : "unavailable",
    excerpt: determinable ? BASE_PROBE.excerpt : null,
    rawResponse: determinable ? BASE_PROBE.rawResponse : null,
    ...over,
  };
}

function mustObserve(evidence: Evidence | null, probe: VisibilityProbe): Observation<AiMentionResult> {
  const r = observeAi({ evidence, probe, brand: BRAND, topic: TOPIC });
  if (!r.ok) throw new Error(`本应产出 Observation，实际被拒：${r.reason}`);
  return r.observation;
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const ev = makeEvidence();
  const probe = makeProbe("MENTIONED", { evidenceId: ev.id });

  /* ---------- 1 · 契约 ---------- */
  section("1 · 契约");
  const obs1 = mustObserve(ev, probe);
  eq("contractVersion = 0.2.0", obs1.contractVersion, OBSERVATION_CONTRACT_VERSION);
  eq("type = ai_mention", obs1.type, "ai_mention");
  eq("observerVersion", obs1.observerVersion, AI_OBSERVER_VERSION);
  eq("parserVersion", obs1.parserVersion, AI_MENTION_PARSER_VERSION);
  eq("parserVersion 与 visibility 常量同源", AI_MENTION_PARSER_VERSION, AI_VISIBILITY_PARSER_VERSION);
  eq("evidenceRefs 指向真实 Evidence", obs1.evidenceRefs, [ev.id]);
  eq("observedAt 取自 Evidence", obs1.observedAt, REQUESTED_AT);
  check("不设置 replaces", obs1.replaces === undefined, String(obs1.replaces));
  check("不设置 runId", obs1.runId === undefined, String(obs1.runId));
  check("不设置 strategyVersion（AI 通道无解析策略）", obs1.strategyVersion === undefined, String(obs1.strategyVersion));

  /* ---------- 2 · Identity ---------- */
  section("2 · Identity");
  eq("subject = ai-slot:deepseek:deepseek-chat", obs1.subject, aiSlotSubject("deepseek", "deepseek-chat"));
  eq("source = provider:deepseek", obs1.source, providerSource("deepseek"));
  check("★ subject 用 requestedModel 而非 servedModel", !obs1.subject.includes("flash"), obs1.subject);
  eq("modelDrift 记录 served≠requested", obs1.metadata.modelDrift, true);
  eq("servedModel 作为真相留在 metadata", obs1.metadata.servedModel, "deepseek-flash");
  eq("promptVersion 进 metadata", obs1.metadata.promptVersion, "1.0.0");
  eq("sampling 快照", obs1.metadata.sampling?.temperature, SAMPLING_PROFILE.temperature);

  const sameSlot = mustObserve(makeEvidence({ requestedModel: "deepseek-chat" }), makeProbe("MENTIONED"));
  eq("servedModel 变化不影响 subject", sameSlot.subject, obs1.subject);

  /* ---------- 3 · 六态映射 ---------- */
  section("3 · 六态映射");
  eq("MENTIONED", mustObserve(ev, makeProbe("MENTIONED")).status, "MENTIONED" as ObservationStatus);
  eq("NOT_MENTIONED", mustObserve(ev, makeProbe("NOT_MENTIONED")).status, "NOT_MENTIONED" as ObservationStatus);
  eq("INDETERMINATE（第六态）", mustObserve(ev, makeProbe("INDETERMINATE", { unobservableReason: undefined })).status, "INDETERMINATE" as ObservationStatus);
  eq("BLOCKED", mustObserve(ev, makeProbe("BLOCKED", { note: "HTTP 429" })).status, "BLOCKED" as ObservationStatus);
  eq("ERROR", mustObserve(ev, makeProbe("ERROR", { note: "timeout" })).status, "ERROR" as ObservationStatus);
  eq("UNOBSERVABLE", mustObserve(ev, makeProbe("UNOBSERVABLE", { unobservableReason: "no_response_body" })).status, "UNOBSERVABLE" as ObservationStatus);

  const ind = mustObserve(ev, makeProbe("INDETERMINATE", { unobservableReason: undefined }));
  check("INDETERMINATE 的 caveat 写明「没回答」不是「没提到」", (ind.caveat ?? "").includes("没回答"), ind.caveat ?? "");
  const blocked = mustObserve(ev, makeProbe("BLOCKED", { note: "HTTP 429" }));
  check("BLOCKED caveat 写明不等于不知道品牌", (blocked.caveat ?? "").includes("不等于"), blocked.caveat ?? "");

  /* ---------- 4 · 硬门槛 ---------- */
  section("4 · 硬门槛");
  const noEv = observeAi({ evidence: null, probe, brand: BRAND, topic: TOPIC });
  check("无 Evidence → 不产结论", !noEv.ok, noEv.ok ? "产出了" : noEv.reason);

  const hashOnly = observeAi({
    evidence: makeEvidence({ retain: false }),
    probe,
    brand: BRAND,
    topic: TOPIC,
  });
  check("HTTP 200 但 hash-only → 不产结论", !hashOnly.ok, hashOnly.ok ? "产出了" : hashOnly.reason);

  const noResponse = observeAi({
    evidence: makeEvidence({ status: 0, body: "", retain: false }),
    probe: makeProbe("ERROR", { note: "connect ECONNREFUSED" }),
    brand: BRAND,
    topic: TOPIC,
  });
  check(
    "status=0（网络失败）仍产出 Observation —— 与 S3 一致",
    noResponse.ok && noResponse.observation.status === "ERROR",
    noResponse.ok ? noResponse.observation.status : noResponse.reason
  );

  /* ---------- 5 · 置信度 ---------- */
  section("5 · 置信度");
  eq("MENTIONED → medium", mustObserve(ev, makeProbe("MENTIONED")).confidence, "medium");
  eq("NOT_MENTIONED → medium", mustObserve(ev, makeProbe("NOT_MENTIONED")).confidence, "medium");
  check("★ 可判定结论永不为 high", mustObserve(ev, makeProbe("MENTIONED")).confidence !== "high", "medium");
  eq("INDETERMINATE → unavailable", ind.confidence, "unavailable");
  eq("BLOCKED → unavailable", blocked.confidence, "unavailable");
  eq("UNOBSERVABLE → unavailable", mustObserve(ev, makeProbe("UNOBSERVABLE")).confidence, "unavailable");

  eq("MENTIONED coverage = 1/1", mustObserve(ev, makeProbe("MENTIONED")).coverage.ratio, 1);
  const blockedCov = blocked.coverage;
  eq("BLOCKED coverage = 0/1 且 missing 指名", [blockedCov.observed, blockedCov.missing], [0, ["deepseek"]]);

  /* ---------- 6 · 存储纪律 ---------- */
  section("6 · 存储纪律");
  check("result 不含原始回答全文", !("rawResponse" in obs1.result), Object.keys(obs1.result).join(","));
  eq("result 只留 rawResponseChars", obs1.result.rawResponseChars, BASE_PROBE.rawResponse!.length);
  check("Observation 顶层无 response/body", !("body" in obs1) && !("response" in obs1), "无");
  eq("metadata.extra.brand", obs1.metadata.extra?.brand, BRAND);
  eq("metadata.extra.topic", obs1.metadata.extra?.topic, TOPIC);
  eq("metadata.extra 记录 httpStatus", obs1.metadata.extra?.httpStatus, 200);

  /* ---------- 7 · Store ---------- */
  section("7 · Store");
  const evForStore = makeEvidence();
  await store.saveEvidence(evForStore, { body: '{"choices":[]}' });
  const saved1 = await recordAiObservation(store, {
    evidence: evForStore,
    probe: makeProbe("MENTIONED", { evidenceId: evForStore.id }),
    brand: BRAND,
    topic: TOPIC,
  });
  check("落库成功并返回 id", saved1.ok, saved1.ok ? saved1.id : saved1.reason);
  if (saved1.ok) {
    const back = await store.getObservation(saved1.id);
    check("回读得到同一条", back?.type === "ai_mention" && back?.subject === obs1.subject, String(back?.id));
  }

  // 无 runId → 第二次采集是新的历史，且不与上一条建链
  const ev2 = makeEvidence({ body: '{"choices":[{"message":{"content":"第二次调用的回答内容，长度足够。"}}]}' });
  await store.saveEvidence(ev2, { body: ev2.response.bodyHash });
  const saved2 = await recordAiObservation(store, {
    evidence: ev2,
    probe: makeProbe("NOT_MENTIONED", { evidenceId: ev2.id }),
    brand: BRAND,
    topic: TOPIC,
  });
  if (saved1.ok && saved2.ok) {
    check("不同 run（无 runId）→ 新历史记录", saved1.id !== saved2.id, `${saved1.id} / ${saved2.id}`);
    const second = await store.getObservation(saved2.id);
    check("且不与上一条建 replaces 链", second?.replaces === undefined, String(second?.replaces));
  }

  const allObs = await store.listObservations({ type: "ai_mention" });
  check("Observation 全部落库", allObs.length >= 2, `${allObs.length} 条`);
  const evList = await store.listEvidence({ kind: "llm_response" });
  check("Evidence 未被改写（条数守恒）", evList.length >= 2, `${evList.length} 条`);

  /* ---------- 8 · 第六态产出（mock 端点，端到端） ---------- */
  section("8 · 第六态产出（mock 端点）");
  const server = await startMockServer(BRAND);
  const port = (server.address() as { port: number }).port;
  const mk = (path: string): AiProvider => ({
    ...PROVIDERS.deepseek,
    name: `Mock-${path}`,
    baseUrl: `http://127.0.0.1:${port}${path}`,
  });

  const refusalP = await probeProvider(mk("/refusal"), BRAND, TOPIC, "mock-key", { store });
  eq("拒答 → INDETERMINATE", refusalP.status, "INDETERMINATE" as VisibilityProbe["status"]);
  eq("拒答文本里含品牌也不算 mentioned", refusalP.mentioned, false);
  eq("拒答 confidence = unavailable", refusalP.confidence, "unavailable");
  check("拒答产出 Observation", Boolean(refusalP.observationId), String(refusalP.observationId));

  const shortP = await probeProvider(mk("/short"), BRAND, TOPIC, "mock-key", { store });
  eq("过短回答 → INDETERMINATE", shortP.status, "INDETERMINATE" as VisibilityProbe["status"]);

  const emptyP = await probeProvider(mk("/empty"), BRAND, TOPIC, "mock-key", { store });
  eq("空回答 → INDETERMINATE", emptyP.status, "INDETERMINATE" as VisibilityProbe["status"]);

  const mentionedP = await probeProvider(mk("/mentioned"), BRAND, TOPIC, "mock-key", { store });
  eq("正常回答含品牌 → MENTIONED（五态不退化）", mentionedP.status, "MENTIONED" as VisibilityProbe["status"]);
  const nmP = await probeProvider(mk("/not-mentioned"), BRAND, TOPIC, "mock-key", { store });
  eq("正常回答不含品牌 → NOT_MENTIONED（五态不退化）", nmP.status, "NOT_MENTIONED" as VisibilityProbe["status"]);
  check("五态仍可产出 Observation", Boolean(mentionedP.observationId && nmP.observationId), "yes");

  await new Promise<void>((r) => server.close(() => r()));

  /* ---------- 9 · 纯函数：低信号判定 ---------- */
  section("9 · 低信号判定（纯函数）");
  eq("空文本", judgeAnswerSignal("").lowSignal, true);
  eq("过短文本", judgeAnswerSignal("好的。").lowSignal, true);
  eq("拒答句", judgeAnswerSignal("抱歉，我无法推荐具体厂商，请咨询专业人士。").lowSignal, true);
  eq("英文拒答", judgeAnswerSignal("I'm sorry, but I can't recommend specific vendors.").lowSignal, true);
  eq("正常短回答（含实质内容）不算低信号", judgeAnswerSignal("推荐以下三家支付机构供你参考。").lowSignal, false);
  eq("开场白提 AI 不算拒答", judgeAnswerSignal("作为一个AI助手，我认为以下厂商值得关注：A、B、C。").lowSignal, false);
  eq("正常长回答", judgeAnswerSignal(BASE_PROBE.rawResponse!).lowSignal, false);

  /* ---------- 汇总 ---------- */
  console.log(`\n──────────────────────────────`);
  if (failures.length === 0) {
    console.log(`\n  ✅ S5 / AI Observer 全部通过：${passed} 项\n`);
  } else {
    console.log(`\n  ❌ ${failures.length} 项失败（通过 ${passed} 项）：`);
    for (const f of failures) console.log(`     [${f.group}] ${f.name} — ${f.detail}`);
    console.log("");
    process.exitCode = 1;
  }

  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响结论 */
  }
}

/* ------------------------------------------------------------------ */
/* mock LLM 端点                                                        */
/* ------------------------------------------------------------------ */

const MOCK_MENTIONED = (brand: string) =>
  `在跨境电商收款场景中，${brand} 是一类值得关注的服务商，提供多币种结算与合规通道。`;
const MOCK_NOT_MENTIONED =
  `该领域常见的服务商包括若干持牌支付机构，建议结合费率、到账时效与合规资质综合评估。`;
/** 拒答，但句中含有品牌名 —— 正是旧实现会误判成 MENTIONED 的那种情形 */
const MOCK_REFUSAL = (brand: string) => `抱歉，我无法推荐具体的跨境支付厂商，${brand} 是否适合需要另行评估。`;

function startMockServer(brand: string): Promise<Server> {
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const pick = (): string => {
      if (url.startsWith("/refusal")) return MOCK_REFUSAL(brand);
      if (url.startsWith("/short")) return "好的。";
      if (url.startsWith("/empty")) return "";
      if (url.startsWith("/not-mentioned")) return MOCK_NOT_MENTIONED;
      return MOCK_MENTIONED(brand);
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: pick() } }], model: "mock-model-001" }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
