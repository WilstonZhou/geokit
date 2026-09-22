/**
 * Phase 2 / S2-2 · CLI 契约测试（零新增依赖、全程离线、禁止网络）。
 *
 * 覆盖：
 *   1  check        fixture / 裸页面 / 抓取失败 → issueId + severity + 退出码
 *   2  协议层诊断    robots 屏蔽 AI 爬虫 → major；llms.txt 缺失 → minor；均无自动修
 *   3  输出格式      json / markdown；sarif 未实现必须明确报错（不静默退化）
 *   4  gate         相对下降 > 阈值 fail、新增 blocker fail、绝对下限 fail、
 *                   分数缺失不判定、无基线明说「未判定」
 *   5  gate 文件模式  --base=<check 产物 json>
 *   6  diff 文件模式  UNOBSERVABLE→NOT_MENTIONED = unknown 不是下降（S6 验收，CLI 不打折）
 *   7  diff Store 模式 有历史取最近两条；无历史 exitCode 1 且不静默说「没变化」
 *
 * 用法：npx tsx scripts/test-cli.ts
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MUST_ALLOW_CRAWLERS,
  buildCheckReport,
  checkFailure,
  checkHtml,
  diagnoseProtocol,
  exitCodeFor,
} from "../packages/cli/src/check";
import { DEFAULT_GATE, evaluateGate, runGate, snapshotFromFile, snapshotOf, type GateSnapshot } from "../packages/cli/src/gate";
import { runDiff } from "../packages/cli/src/diff";
import { OUTPUT_FORMATS, parseFormat, renderCheck, renderDiff, renderGate } from "../packages/cli/src/output";
import { analyze } from "../src/lib/audit";
import { AI_CRAWLERS, type AiCrawler } from "../src/lib/llms";
import { createStore } from "../src/lib/store";
import type { Observation } from "../src/lib/evidence/types";

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

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
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

const URL = "https://whivi.com/guide";
const FIXTURE = readFileSync(join(process.cwd(), "tests", "fixtures", "audit", "sample.html"), "utf8");
const BARE = `<!DOCTYPE html><html><head><title>短</title></head><body>
<h1>一</h1><h1>二</h1><img src="a.png"><img src="b.png"><img src="c.png"></body></html>`;

const TMP = mkdtempSync(join(tmpdir(), "geokit-cli-"));

function obs(o: {
  id: string;
  observedAt: string;
  status: Observation["status"];
  subject?: string;
  type?: Observation["type"];
}): Observation {
  return {
    id: o.id,
    contractVersion: "0.2.0",
    type: o.type ?? "ai_mention",
    subject: o.subject ?? "ai-slot:openai:gpt-4o",
    source: "provider:openai",
    observedAt: o.observedAt,
    observerVersion: "observer@1",
    parserVersion: "parser@1",
    evidenceRefs: [],
    status: o.status,
    result: {},
    confidence: o.status === "MENTIONED" || o.status === "NOT_MENTIONED" ? "medium" : "unavailable",
    coverage: { expected: 1, observed: 1, ratio: 1 },
    metadata: {},
  };
}

function crawlerByUa(ua: string): AiCrawler {
  const found = AI_CRAWLERS.find((c) => c.ua === ua);
  if (!found) throw new Error(`夹具缺少爬虫定义：${ua}`);
  return found;
}

function snap(partial: Partial<GateSnapshot>): GateSnapshot {
  return snapshotOf({
    seoScore: 90,
    geoScore: 70,
    diagnoses: [{ issueId: "viewport/missing", severity: "minor" }],
    ...partial,
  });
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  /* ---------- 1. check ---------- */
  section("1 check：退出码与 issueId");

  const fixtureReport = checkHtml(FIXTURE, URL);
  eq("fixture 只有 minor ⇒ 退出码 0", fixtureReport.exitCode, 0);
  eq("fixture blocker", fixtureReport.counts.blocker, 0);
  eq("fixture major", fixtureReport.counts.major, 0);
  check("fixture 至少 1 条 minor", fixtureReport.counts.minor >= 1, `${fixtureReport.counts.minor}`);
  check(
    "fixture 含 viewport/missing",
    fixtureReport.diagnoses.some((d) => d.issueId === "viewport/missing"),
    fixtureReport.diagnoses.map((d) => d.issueId).join(",")
  );
  eq("targetUrl 透传", fixtureReport.diagnoses[0]?.targetUrl, URL);
  eq("HTTP 状态透传", fixtureReport.httpStatus, 200);

  const bareReport = checkHtml(BARE, URL);
  eq("裸页面有 major ⇒ 退出码 1", bareReport.exitCode, 1);
  check("裸页面含 desc/missing", bareReport.diagnoses.some((d) => d.issueId === "desc/missing"));
  check(
    "裸页面含 alt/mostly-missing",
    bareReport.diagnoses.some((d) => d.issueId === "alt/mostly-missing")
  );

  const failed = checkFailure(URL, "连接超时");
  eq("抓取失败 ⇒ blocker 1", failed.counts.blocker, 1);
  eq("抓取失败 ⇒ 退出码 1", failed.exitCode, 1);
  eq("抓取失败 issueId", failed.diagnoses[0]?.issueId, "fetch/unreachable");
  eq("抓取失败无 suggextedFix", failed.diagnoses[0]?.suggestedFix, undefined);

  eq("counts→退出码：只有 minor = 0", exitCodeFor({ blocker: 0, major: 0, minor: 5 }), 0);
  eq("counts→退出码：有 major = 1", exitCodeFor({ blocker: 0, major: 1, minor: 0 }), 1);

  const determinism = checkHtml(BARE, URL);
  determinism.fetchedAt = bareReport.fetchedAt;
  eq("同输入两次一致（CI 会反复触发）", determinism, bareReport);

  /* ---------- 2. 协议层诊断 ---------- */
  section("2 协议层：robots / llms.txt");

  const blocked = {
    url: "https://whivi.com/robots.txt",
    exists: true,
    raw: "x",
    sitemaps: [],
    policies: [
      { crawler: crawlerByUa(MUST_ALLOW_CRAWLERS[0]), policy: "blocked" as const, matchedRule: "Disallow: /", implication: "" },
    ],
    aiOpennessScore: 40,
    summary: "屏蔽了 GPTBot",
    recommendations: [],
  };
  const robotsDs = diagnoseProtocol(blocked, undefined, URL);
  eq("AI 爬虫被封 ⇒ major", robotsDs[0]?.severity, "major");
  eq("AI 爬虫被封 issueId", robotsDs[0]?.issueId, "robots/ai-blocked");
  eq("AI 爬虫被封无自动修", robotsDs[0]?.suggestedFix, undefined);
  check("AI 爬虫被封有人工建议", (robotsDs[0]?.manualFix ?? "").includes("GPTBot"));

  const noRobots = { ...blocked, exists: false, policies: [] };
  eq("robots 缺失 ⇒ minor", diagnoseProtocol(noRobots, undefined, URL)[0]?.issueId, "robots/missing");
  eq("robots 全放行 ⇒ 无诊断", diagnoseProtocol({ ...blocked, policies: [] }, undefined, URL).length, 0);

  const noLlms = {
    url: "https://whivi.com/llms.txt",
    exists: false,
    bytes: 0,
    lineCount: 0,
    hasTitle: false,
    title: null,
    hasBlockquoteSummary: false,
    sections: 0,
    linkCount: 0,
    issues: [],
    score: 0,
    raw: null,
    recommendations: [],
  };
  eq("llms.txt 缺失 ⇒ minor", diagnoseProtocol(undefined, noLlms, URL)[0]?.issueId, "llms/missing");
  eq(
    "llms.txt 存在但不合格 ⇒ llms/invalid",
    diagnoseProtocol(undefined, { ...noLlms, exists: true, issues: [{ level: "fail", label: "无 H1", detail: "" }] }, URL)[0]?.issueId,
    "llms/invalid"
  );
  eq(
    "llms.txt 合格 ⇒ 无诊断",
    diagnoseProtocol(undefined, { ...noLlms, exists: true, issues: [{ level: "pass", label: "ok", detail: "" }] }, URL).length,
    0
  );

  const withProtocol = buildCheckReport(analyze(URL, FIXTURE, 200, 0), { robots: blocked });
  check("报告带 robots 段落", withProtocol.robots !== undefined);
  eq("协议问题计入 counts", withProtocol.counts.major >= 1, true);

  /* ---------- 3. 输出格式 ---------- */
  section("3 输出格式");

  eq("默认 markdown", parseFormat(undefined), "markdown");
  eq("json", parseFormat("JSON"), "json");
  eq("sarif 已是正式格式（S2-3）", parseFormat("sarif"), "sarif");
  eq("格式清单含三种", OUTPUT_FORMATS, ["json", "markdown", "sarif"]);
  let bogusErr = "";
  try {
    parseFormat("yaml");
  } catch (e) {
    bogusErr = e instanceof Error ? e.message : String(e);
  }
  check("未知格式报错", bogusErr.includes("未知输出格式"), bogusErr);

  check(
    "json 渲染可解析",
    typeof JSON.parse(renderCheck(fixtureReport, "json")) === "object"
  );
  const md = renderCheck(bareReport, "markdown");
  check("markdown 含退出码", md.includes("退出码：1"), md.split("\n")[6] ?? "");
  check("markdown 含表格", md.includes("| 严重度 | issueId |"), "");
  const gateMd = renderGate(evaluateGate(snap({}), null), "markdown");
  check("gate markdown 含判定", gateMd.includes("PASS") || gateMd.includes("FAIL"), "");

  /* ---------- 4. gate 判定 ---------- */
  section("4 gate：相对下降优先于绝对阈值");

  const dropped = evaluateGate(snap({ geoScore: 60 }), snap({ geoScore: 70 }));
  eq("GEO 降 10 ⇒ fail", dropped.decision, "fail");
  eq("fail ⇒ 退出码 1", dropped.exitCode, 1);
  check("理由写明下降幅度", dropped.reasons[0]?.includes("10"), dropped.reasons.join("|"));

  eq("GEO 降 3（≤ 阈值 5）⇒ pass", evaluateGate(snap({ geoScore: 67 }), snap({ geoScore: 70 })).decision, "pass");
  eq("GEO 提升 ⇒ pass", evaluateGate(snap({ geoScore: 80 }), snap({ geoScore: 70 })).decision, "pass");

  const newBlocker = evaluateGate(
    snap({ diagnoses: [{ issueId: "fetch/unreachable", severity: "blocker" }] }),
    snap({ diagnoses: [] })
  );
  eq("新增 blocker ⇒ fail", newBlocker.decision, "fail");
  eq("新增 blocker 计数", newBlocker.deltas?.newBlocker, 1);

  const belowFloor = evaluateGate(snap({ geoScore: 30 }), snap({ geoScore: 35 }));
  eq("低于绝对下限 ⇒ fail（哪怕没下降）", belowFloor.decision, "fail");
  check("理由写明绝对下限", belowFloor.reasons.some((r) => r.includes("绝对下限")), belowFloor.reasons.join("|"));

  const noScore = evaluateGate(snap({ seoScore: null, geoScore: null }), snap({}));
  eq("分数缺失不判定降级 ⇒ pass", noScore.decision, "pass");
  eq("分数缺失 delta 为 null", noScore.deltas?.geoScore, null);

  const noBase = evaluateGate(snap({}), null);
  eq("无基线 ⇒ 不静默放行也不 fail", noBase.decision, "pass");
  check("无基线明说未判定", noBase.reasons[0]?.includes("未做退化判定"), noBase.reasons.join("|"));
  eq("无基线 found=false", noBase.baseline.found, false);

  eq("默认阈值可核对", [DEFAULT_GATE.maxDrop, DEFAULT_GATE.geoMin, DEFAULT_GATE.maxNewMajor], [5, 40, 2]);

  /* ---------- 5. gate 文件模式（CI 默认方案） ---------- */
  section("5 gate：--base=<baseline.json>");

  const basePath = join(TMP, "baseline.json");
  writeFileSync(basePath, JSON.stringify(checkHtml(FIXTURE, URL)), "utf8");
  const snapshotNow = snapshotFromFile(basePath);
  eq("从 check 产物读快照", snapshotNow.geoScore, fixtureReport.geoScore);

  const fileMode = await runGate(snapshotNow, { base: basePath });
  check("基线来源写进报告", fileMode.baseline.source.startsWith("file:"), fileMode.baseline.source);
  eq("与自身比 ⇒ pass", fileMode.decision, "pass");

  const degraded = await runGate(snap({ geoScore: 20, diagnoses: [] }), { base: basePath });
  eq("产物基线 + 大幅退化 ⇒ fail", degraded.decision, "fail");
  eq("fail 退出码", degraded.exitCode, 1);

  /* ---------- 6. diff 文件模式 ---------- */
  section("6 diff：文件模式（CI 无 Store）");

  const prevPath = join(TMP, "prev.json");
  const currPath = join(TMP, "curr.json");
  writeFileSync(prevPath, JSON.stringify(obs({ id: "o1", observedAt: "2026-09-20T00:00:00.000Z", status: "UNOBSERVABLE" })));
  writeFileSync(currPath, JSON.stringify(obs({ id: "o2", observedAt: "2026-09-21T00:00:00.000Z", status: "NOT_MENTIONED" })));

  const fileDiff = await runDiff({ prev: prevPath, curr: currPath });
  eq("★ UNOBSERVABLE→NOT_MENTIONED 不可比", fileDiff.diff.comparable, false);
  eq("★ 不计为退化", fileDiff.diff.summary.degraded, 0);
  eq("记为不可判定", fileDiff.diff.summary.unknown > 0, true);
  check("diff 退出码 0", fileDiff.exitCode === 0);
  const diffMd = renderDiff(fileDiff, "markdown");
  check("diff markdown 含可比性说明", diffMd.includes("可比：否"), "");

  writeFileSync(prevPath, JSON.stringify(obs({ id: "o3", observedAt: "2026-09-20T00:00:00.000Z", status: "NOT_MENTIONED" })));
  writeFileSync(currPath, JSON.stringify(obs({ id: "o4", observedAt: "2026-09-21T00:00:00.000Z", status: "MENTIONED" })));
  const improved = await runDiff({ prev: prevPath, curr: currPath });
  eq("NOT_MENTIONED→MENTIONED 可比", improved.diff.comparable, true);
  eq("记为改善", improved.diff.summary.improved > 0, true);

  let missingErr = "";
  try {
    await runDiff({ prev: prevPath });
  } catch (e) {
    missingErr = e instanceof Error ? e.message : String(e);
  }
  check("只给 --prev 明确报错", missingErr.includes("--curr"), missingErr);

  /* ---------- 7. diff Store 模式 ---------- */
  section("7 diff：Store 模式（本地有历史）");

  const storeDir = join(TMP, "store");
  const store = createStore(storeDir);
  const subject = "search:site=https://whivi.com|q=跨境支付";
  await store.saveObservation(obs({ id: "s1", observedAt: "2026-09-20T00:00:00.000Z", status: "UNOBSERVABLE", subject, type: "rank" }));
  await store.saveObservation(obs({ id: "s2", observedAt: "2026-09-21T00:00:00.000Z", status: "NOT_MENTIONED", subject, type: "rank" }));

  const storeDiff = await runDiff({ subject, type: "rank", dir: storeDir });
  eq("Store 取到两条", [storeDiff.diff.previousId !== null, storeDiff.diff.currentId !== null], [true, true]);
  eq("Store 模式同样不判退化", storeDiff.diff.summary.degraded, 0);
  check("Store 目录可配（CI 用 --dir 指向 artifact 解压目录）", storeDiff.source === "store");
  console.log("  \x1b[90m注：runDiff 用 createStore() 默认根，环境变量未注入时读默认目录\x1b[0m");

  const emptyStoreDiff = await runDiff({ subject: "absent:subject", type: "rank", dir: storeDir });
  eq("无观测 ⇒ 退出码 1（不是「没变化」）", emptyStoreDiff.exitCode, 1);

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
