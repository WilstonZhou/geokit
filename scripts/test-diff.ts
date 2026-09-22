/**
 * S6 / Diff 引擎契约测试（零新增依赖）。
 *
 * 覆盖：
 *   1  可比性 gate      版本三元组 / promptVersion / subject 一致性
 *   2  ★ 核心验收       UNOBSERVABLE→NOT_MENTIONED = unknown，不是下降
 *   3  状态方向          NOT_MENTIONED→MENTIONED improved 等
 *   4  数值阈值          score ±5 / rank ±3 / 非数值 unknown
 *   5  targetRank 语义   null 进出榜单（设计稿里缺失 NOT_FOUND 的等价表达）
 *   6  集合差异          ADDED / REMOVED
 *   7  元信息差异        COVERAGE / VERSION / EVIDENCE
 *   8  边界              missing_previous
 *   9  Store 取数        latestPair 不做可比性过滤 + diffLatest 端到端
 *
 * 用法：npx tsx scripts/test-diff.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonlStore } from "../src/lib/store/jsonl";
import type { Observation, ObservationStatus } from "../src/lib/evidence/types";
import {
  COMPARABLE_STATUSES,
  DIFF_ENGINE_VERSION,
  RANK_MIN_DELTA,
  SCORE_MIN_DELTA,
  diffLatest,
  diffObservations,
  latestPair,
} from "../src/lib/diff";

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

let seq = 0;

function base(o: {
  type?: Observation["type"];
  subject?: string;
  source?: string;
  status: ObservationStatus;
  observedAt: string;
  result?: unknown;
  observerVersion?: string;
  parserVersion?: string;
  strategyVersion?: string;
  evidenceRefs?: string[];
  coverageInput?: { expected: number; observed: number };
  promptVersion?: string;
  metadata?: Observation["metadata"];
}): Observation {
  seq += 1;
  const expected = o.coverageInput?.expected ?? 1;
  const observed = o.coverageInput?.observed ?? 1;
  return {
    id: `obs_test_${String(seq).padStart(3, "0")}`,
    contractVersion: "0.2.0",
    type: o.type ?? "ai_mention",
    subject: o.subject ?? "ai-slot:deepseek:deepseek-chat",
    source: o.source ?? "provider:deepseek",
    observedAt: o.observedAt,
    observerVersion: o.observerVersion ?? "obs@1",
    parserVersion: o.parserVersion ?? "parser@1",
    strategyVersion: o.strategyVersion,
    evidenceRefs: o.evidenceRefs ?? ["ev_1"],
    status: o.status,
    result: o.result ?? { mentioned: o.status === "MENTIONED" },
    confidence: "medium",
    coverage: {
      expected,
      observed,
      ratio: expected === 0 ? 0 : observed / expected,
    },
    metadata:
      o.metadata ??
      (o.promptVersion ? { promptVersion: o.promptVersion } : { extra: {} }),
  };
}

/** 不可比时的不变量：improved / degraded 必须为 0 */
function assertNoDirectionLabel(name: string, d: ReturnType<typeof diffObservations>): void {
  check(
    name,
    d.summary.improved === 0 && d.summary.degraded === 0,
    `improved=${d.summary.improved} degraded=${d.summary.degraded}`
  );
  const allUnknown = d.changes.every((c) => c.direction === "unknown");
  check(`${name}（每条 change 均为 unknown）`, allUnknown, JSON.stringify(d.changes.map((c) => c.direction)));
}

const T0 = "2026-09-20T02:00:00.000Z";
const T1 = "2026-09-21T02:00:00.000Z";

async function main(): Promise<void> {
  /* ---------- 1 · 可比性 gate ---------- */
  section("1 · 可比性 gate");

  const goodPrev = base({ status: "MENTIONED", observedAt: T0 });
  const goodCur = base({ status: "NOT_MENTIONED", observedAt: T1 });
  eq("两侧同口径且可判定 ⇒ comparable", diffObservations(goodPrev, goodCur).comparable, true);

  const observerChanged = diffObservations(goodPrev, { ...goodCur, observerVersion: "obs@2" });
  eq("observerVersion 变化 ⇒ comparable=false", observerChanged.comparable, false);
  eq("observerVersion 变化 ⇒ reason", observerChanged.incomparableReason, "observer_version_changed");
  assertNoDirectionLabel("observerVersion 变化不得判定方向", observerChanged);

  const parserChanged = diffObservations(goodPrev, { ...goodCur, parserVersion: "parser@2" });
  eq("parserVersion 变化 ⇒ reason", parserChanged.incomparableReason, "parser_version_changed");
  assertNoDirectionLabel("parserVersion 变化不得判定方向", parserChanged);

  const promptChanged = diffObservations(
    { ...goodPrev, metadata: { promptVersion: "1.0.0" } },
    { ...goodCur, metadata: { promptVersion: "1.1.0" } }
  );
  eq("promptVersion 变化 ⇒ reason", promptChanged.incomparableReason, "prompt_version_changed");
  check(
    "promptVersion 变化 ⇒ 产出 VERSION change",
    promptChanged.changes.some((c) => c.kind === "VERSION" && c.path === "metadata.promptVersion"),
    JSON.stringify(promptChanged.changes.map((c) => `${c.kind}:${c.path}`))
  );

  const subjectChanged = diffObservations(goodPrev, { ...goodCur, subject: "ai-slot:openai:gpt-4o" });
  eq("subject 不一致 ⇒ reason", subjectChanged.incomparableReason, "subject_mismatch");

  const typeChanged = diffObservations(goodPrev, { ...goodCur, type: "rank" });
  eq("type 不一致 ⇒ reason", typeChanged.incomparableReason, "subject_mismatch");

  eq("可判定状态集合", Array.from(COMPARABLE_STATUSES), ["OBSERVED", "MENTIONED", "NOT_MENTIONED"]);

  /* ---------- 2 · ★ 核心验收：不可观测 ⇒ 不是下降 ---------- */
  section("2 · 核心验收：UNOBSERVABLE→NOT_MENTIONED ≠ 下降");

  const transitions: Array<[ObservationStatus, ObservationStatus, string]> = [
    ["UNOBSERVABLE", "NOT_MENTIONED", "★ 用户明确点名的一条"],
    ["UNOBSERVABLE", "MENTIONED", "首次被看到 ≠ 新增提及"],
    ["UNOBSERVABLE", "OBSERVED", "覆盖度提升"],
    ["OBSERVED", "UNOBSERVABLE", "观测丢失 ≠ 表现下降"],
    ["MENTIONED", "UNOBSERVABLE", "观测丢失"],
    ["NOT_MENTIONED", "UNOBSERVABLE", "观测丢失"],
    ["BLOCKED", "OBSERVED", "此前被拒"],
    ["OBSERVED", "BLOCKED", "被限流 ≠ 网站变差"],
    ["ERROR", "OBSERVED", "故障恢复"],
    ["OBSERVED", "ERROR", "我方故障"],
    ["INDETERMINATE", "NOT_MENTIONED", "没回答 ≠ 回答了没提"],
    ["INDETERMINATE", "MENTIONED", "没回答 → 提及"],
    ["MENTIONED", "INDETERMINATE", "掉进未判定"],
    ["NOT_MENTIONED", "INDETERMINATE", "掉进未判定"],
    ["PARTIAL", "OBSERVED", "PARTIAL 的分数 Observer 自己说不可信"],
    ["OBSERVED", "PARTIAL", "同上"],
    ["BLOCKED", "ERROR", "两侧都不可判定"],
  ];

  for (const [ps, cs, why] of transitions) {
    const d = diffObservations(
      base({ status: ps, observedAt: T0 }),
      base({ status: cs, observedAt: T1 })
    );
    check(
      `${ps} → ${cs} ⇒ comparable=false（${why}）`,
      d.comparable === false && d.incomparableReason === "status_not_observed",
      `comparable=${d.comparable} reason=${d.incomparableReason}`
    );
    assertNoDirectionLabel(`  └ ${ps}→${cs} 不判方向`, d);
  }

  const headline = diffObservations(
    base({ status: "UNOBSERVABLE", observedAt: T0 }),
    base({ status: "NOT_MENTIONED", observedAt: T1 })
  );
  eq("头条用例 summary", headline.summary, { improved: 0, degraded: 0, neutral: 0, unknown: 1 });
  check(
    "头条用例的 note 点明「覆盖度提升」",
    (headline.note ?? "").includes("覆盖度提升") || (headline.changes[0]?.note ?? "").includes("覆盖度提升"),
    headline.changes[0]?.note ?? ""
  );

  /* ---------- 3 · 可比状态下的方向 ---------- */
  section("3 · 可比状态下的方向");

  const up = diffObservations(
    base({ status: "NOT_MENTIONED", observedAt: T0 }),
    base({ status: "MENTIONED", observedAt: T1 })
  );
  eq("NOT_MENTIONED → MENTIONED ⇒ improved", up.summary.improved, 1);
  eq("improved 来自 STATUS change", up.changes[0]?.kind, "STATUS");

  const down = diffObservations(
    base({ status: "MENTIONED", observedAt: T0 }),
    base({ status: "NOT_MENTIONED", observedAt: T1 })
  );
  eq("MENTIONED → NOT_MENTIONED ⇒ degraded", down.summary.degraded, 1);

  const same = diffObservations(
    base({ status: "MENTIONED", observedAt: T0 }),
    base({ status: "MENTIONED", observedAt: T1 })
  );
  check("同状态不产 STATUS change", !same.changes.some((c) => c.kind === "STATUS"));
  eq("无变化 summary", same.summary, { improved: 0, degraded: 0, neutral: 0, unknown: 0 });

  /* ---------- 4 · 数值阈值 ---------- */
  section("4 · 数值阈值");

  const siteBase = (o: { seoScore: number; geoScore?: number; t: string }) =>
    base({
      type: "geo_score",
      subject: "site:https://example.com/",
      source: "http:https://example.com",
      status: "OBSERVED",
      observedAt: o.t,
      result: { url: "https://example.com/", finalUrl: "https://example.com/", seoScore: o.seoScore, geoScore: o.geoScore ?? 70 },
    });

  const s1 = diffObservations(siteBase({ seoScore: 91, t: T0 }), siteBase({ seoScore: 95, t: T1 }));
  eq(`+4 分 < 阈值 ${SCORE_MIN_DELTA} ⇒ neutral`, s1.changes[0]?.direction, "neutral");
  eq("neutral 计入 summary.neutral", s1.summary.neutral, 1);

  const s2 = diffObservations(siteBase({ seoScore: 91, t: T0 }), siteBase({ seoScore: 97, t: T1 }));
  eq("+6 分 ⇒ improved", s2.changes[0]?.direction, "improved");
  eq("delta 真实", s2.changes[0]?.delta, 6);

  const s3 = diffObservations(siteBase({ seoScore: 91, t: T0 }), siteBase({ seoScore: 80, t: T1 }));
  eq("-11 分 ⇒ degraded（分数越大越好）", s3.changes[0]?.direction, "degraded");

  const s4 = diffObservations(siteBase({ seoScore: 91, geoScore: 70, t: T0 }), siteBase({ seoScore: 91, geoScore: 80, t: T1 }));
  check("geoScore 独立参与比较", s4.changes.some((c) => c.path === "result.geoScore" && c.direction === "improved"), JSON.stringify(s4.changes.map((c) => `${c.path}:${c.direction}`)));

  const s5 = diffObservations(
    siteBase({ seoScore: 91, t: T0 }),
    { ...siteBase({ seoScore: 91, t: T1 }), result: { seoScore: "n/a", geoScore: 70 } }
  );
  eq("取值非数值 ⇒ unknown", s5.changes.find((c) => c.path === "result.seoScore")?.direction, "unknown");
  eq("unknown 计入 summary.unknown", s5.summary.unknown, 1);

  /* ---------- 5 · targetRank 的 null 语义 ---------- */
  section("5 · targetRank：进/出榜单");

  const ranked = (o: { targetRank: number | null; t: string; items?: { domain: string }[] }) =>
    base({
      type: "rank",
      subject: "search:site=example.com|q=跨境支付",
      source: "search-engine:baidu",
      status: "OBSERVED",
      observedAt: o.t,
      result: {
        keyword: "跨境支付",
        engine: "baidu",
        items: o.items ?? [{ domain: "example.com" }],
        targetRank: o.targetRank,
        targetFound: o.targetRank !== null,
      },
    });

  const enter = diffObservations(ranked({ targetRank: null, t: T0 }), ranked({ targetRank: 8, t: T1 }));
  eq("null → 8 ⇒ improved（进入榜单）", enter.changes.find((c) => c.path === "result.targetRank")?.direction, "improved");
  eq("两侧均为 OBSERVED 故仍可比", enter.comparable, true);

  const drop = diffObservations(ranked({ targetRank: 8, t: T0 }), ranked({ targetRank: null, t: T1 }));
  eq("8 → null ⇒ degraded（掉出榜单）", drop.changes.find((c) => c.path === "result.targetRank")?.direction, "degraded");

  const bothOut = diffObservations(ranked({ targetRank: null, t: T0 }), ranked({ targetRank: null, t: T1 }));
  check("null → null 不产 targetRank change", !bothOut.changes.some((c) => c.path === "result.targetRank"));

  const noise = diffObservations(ranked({ targetRank: 3, t: T0 }), ranked({ targetRank: 4, t: T1 }));
  eq(`3 → 4（<${RANK_MIN_DELTA}）⇒ neutral`, noise.changes.find((c) => c.path === "result.targetRank")?.direction, "neutral");

  const worse = diffObservations(ranked({ targetRank: 3, t: T0 }), ranked({ targetRank: 7, t: T1 }));
  eq("3 → 7 ⇒ degraded（排名越小越好）", worse.changes.find((c) => c.path === "result.targetRank")?.direction, "degraded");

  const better = diffObservations(ranked({ targetRank: 25, t: T0 }), ranked({ targetRank: 3, t: T1 }));
  eq("25 → 3 ⇒ improved", better.changes.find((c) => c.path === "result.targetRank")?.direction, "improved");

  /* ---------- 6 · 集合差异 ---------- */
  section("6 · 集合 ADDED / REMOVED");

  const setDiff = diffObservations(
    ranked({ targetRank: 3, t: T0, items: [{ domain: "a.com" }, { domain: "b.com" }] }),
    ranked({ targetRank: 3, t: T1, items: [{ domain: "a.com" }, { domain: "c.com" }] })
  );
  const added = setDiff.changes.find((c) => c.kind === "ADDED");
  const removed = setDiff.changes.find((c) => c.kind === "REMOVED");
  eq("ADDED 内容", added?.current, ["c.com"]);
  eq("REMOVED 内容", removed?.previous, ["b.com"]);
  check("集合变化一律 neutral（不替 targetRank 下结论）", added?.direction === "neutral" && removed?.direction === "neutral");

  const citedDiff = diffObservations(
    base({ status: "MENTIONED", observedAt: T0, result: { citedDomains: ["a.com"] } }),
    base({ status: "MENTIONED", observedAt: T1, result: { citedDomains: ["a.com", "b.com"] } })
  );
  eq("ai_mention 的 citedDomains 也参与比较", citedDiff.changes.find((c) => c.kind === "ADDED")?.current, ["b.com"]);

  /* ---------- 7 · COVERAGE / VERSION / EVIDENCE ---------- */
  section("7 · COVERAGE / VERSION / EVIDENCE");

  const covDiff = diffObservations(
    base({ status: "MENTIONED", observedAt: T0, coverageInput: { expected: 9, observed: 1 } }),
    base({ status: "MENTIONED", observedAt: T1, coverageInput: { expected: 9, observed: 9 } })
  );
  const cov = covDiff.changes.find((c) => c.kind === "COVERAGE");
  check("覆盖度变化被记录", Boolean(cov));
  eq("覆盖度变化不得判定为 improved", cov?.direction, "unknown");

  const stratDiff = diffObservations(
    base({ status: "OBSERVED", observedAt: T0, type: "rank", strategyVersion: "baidu-mu@1" }),
    base({ status: "OBSERVED", observedAt: T1, type: "rank", strategyVersion: "baidu-mu@2" })
  );
  eq("strategyVersion 变化 ⇒ 仍可比（D10）", stratDiff.comparable, true);
  check(
    "strategyVersion 变化 ⇒ 产出 VERSION change",
    stratDiff.changes.some((c) => c.kind === "VERSION" && c.path === "strategyVersion"),
    JSON.stringify(stratDiff.changes.map((c) => `${c.kind}:${c.path}`))
  );

  const evDiff = diffObservations(
    base({ status: "MENTIONED", observedAt: T0, evidenceRefs: ["ev_1"] }),
    base({ status: "MENTIONED", observedAt: T1, evidenceRefs: ["ev_2"] })
  );
  eq("evidenceRefs 变化 ⇒ EVIDENCE change", evDiff.changes.find((c) => c.kind === "EVIDENCE")?.direction, "neutral");

  /* ---------- 8 · 边界 ---------- */
  section("8 · 边界");

  const noPrev = diffObservations(null, base({ status: "MENTIONED", observedAt: T1 }));
  eq("首次观测 ⇒ missing_previous", noPrev.incomparableReason, "missing_previous");
  assertNoDirectionLabel("首次观测不是变化", noPrev);

  const empty = diffObservations(null, null);
  eq("两条都没有 ⇒ subject 为空且不可比", empty.comparable, false);
  eq("空 diff 的 subject", empty.subject, "");

  const noCur = diffObservations(base({ status: "MENTIONED", observedAt: T0 }), null);
  eq("只有 previous ⇒ 不可比", noCur.comparable, false);
  eq("只有 previous ⇒ currentId 为 null", noCur.currentId, null);

  eq("diff 带引擎版本", DIFF_ENGINE_VERSION, "diff-engine@0.1.0");

  /* ---------- 9 · Store 取数 ---------- */
  section("9 · Store 取数与端到端");

  const TMP = mkdtempSync(join(tmpdir(), "geokit-diff-"));
  const store = new JsonlStore(TMP);

  const Q = {
    subject: "ai-slot:deepseek:deepseek-chat",
    type: "ai_mention",
    source: "provider:deepseek",
  };

  const pairEmpty = await latestPair(store, Q);
  check("空库 ⇒ 两条都 null", pairEmpty.previous === null && pairEmpty.current === null);

  await store.saveObservation(
    base({ status: "UNOBSERVABLE", observedAt: "2026-09-19T02:00:00.000Z" })
  );
  const one = await latestPair(store, Q);
  check("只有一条 ⇒ previous 为 null", one.previous === null && one.current !== null);

  await store.saveObservation(base({ status: "OBSERVED", observedAt: "2026-09-20T02:00:00.000Z", type: "rank" }));
  const sameType = await latestPair(store, { subject: Q.subject, type: "ai_mention" });
  eq("按 type 隔离（rank 不混入）", sameType.current?.type, "ai_mention");

  await store.saveObservation(base({ status: "NOT_MENTIONED", observedAt: "2026-09-21T02:00:00.000Z" }));
  const pair = await latestPair(store, Q);
  eq("取最后两条（升序）", [pair.previous?.status, pair.current?.status], ["UNOBSERVABLE", "NOT_MENTIONED"]);
  check(
    "★ latestPair 不做可比性过滤 —— UNOBSERVABLE 仍被取出",
    pair.previous?.status === "UNOBSERVABLE",
    String(pair.previous?.status)
  );

  const e2e = await diffLatest(store, Q);
  eq("diffLatest ⇒ comparable=false", e2e.comparable, false);
  eq("diffLatest ⇒ reason", e2e.incomparableReason, "status_not_observed");
  assertNoDirectionLabel("★ 端到端：UNOBSERVABLE→NOT_MENTIONED 不判方向", e2e);
  eq("端到端 subject 透传", e2e.subject, Q.subject);
  eq("端到端带 id 便于回溯", [e2e.previousId !== null, e2e.currentId !== null], [true, true]);

  const bySource = await latestPair(store, { ...Q, source: "provider:openai" });
  check("source 过滤生效", bySource.current === null);

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
