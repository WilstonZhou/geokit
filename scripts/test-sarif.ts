/**
 * Phase 2 / S2-3 · SARIF 2.1.0 输出契约测试（离线、禁网、零新增依赖）。
 *
 * 覆盖：
 *   1  schema 基本结构   version / $schema / runs / tool.driver / rules / results
 *   2  Diagnosis → SARIF 规则去重（ruleIndex 指回）、逐条 result 映射、严重度→level
 *   3  定位规则          artifactLocation.uri = targetUrl；★ 全文档无 region
 *   4  check 报告        URI 取最终地址
 *   5  gate 报告         fail→error / 无基线→note / 真 PASS→零 result；无 URL 则无 location
 *   6  CLI 集成          --format=sarif 不再报错；json / markdown 不受影响
 *
 * 用法：npx tsx scripts/test-sarif.ts
 */
import { readFileSync } from "node:fs";

import { buildCheckReport, checkHtml } from "../packages/cli/src/check";
import { evaluateGate, snapshotOf, type GateSnapshot } from "../packages/cli/src/gate";
import { OUTPUT_FORMATS, parseFormat, renderCheck, renderGate } from "../packages/cli/src/output";
import {
  SARIF_SCHEMA,
  SARIF_VERSION,
  TOOL_NAME,
  buildSarif,
  levelForSeverity,
  sarifFromCheckReport,
  sarifFromDiagnoses,
  sarifFromGateReport,
  type SarifLog,
} from "../packages/cli/src/sarif";
import { analyze } from "../src/lib/audit";

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
  check(name, ok, ok ? "" : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ------------------------------------------------------------------ */

const URL = "https://whivi.com/guide";
const FIXTURE = readFileSync("tests/fixtures/audit/sample.html", "utf8");

/** 一个什么都没有的页面 —— 产出多条不同 issueId 的诊断，用来观察规则去重 */
const BARE = `<!DOCTYPE html><html><head><title>hi</title></head><body><h1>hi</h1></body></html>`;

/** 深搜 SARIF 文档里是否出现某个 key —— 「无 region」必须这样验证 */
function hasKeyDeep(v: unknown, key: string): boolean {
  if (Array.isArray(v)) return v.some((x) => hasKeyDeep(x, key));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (key in o) return true;
    return Object.values(o).some((x) => hasKeyDeep(x, key));
  }
  return false;
}

function firstRun(log: SarifLog) {
  return log.runs[0]!;
}

async function main(): Promise<void> {
  /* ---------- 1. schema 骨架 ---------- */
  section("1 SARIF 骨架");

  const fixtureReport = buildCheckReport(analyze(URL, FIXTURE, 200, 0));
  const bareReport = checkHtml(BARE, URL);
  const fixtureSarif = sarifFromCheckReport(fixtureReport);

  eq("version 2.1.0", fixtureSarif.version, "2.1.0");
  eq("version 常量", SARIF_VERSION, "2.1.0");
  check("$schema 指向官方 schema", fixtureSarif.$schema === SARIF_SCHEMA, SARIF_SCHEMA);
  eq("只有一个 run", fixtureSarif.runs.length, 1);
  eq("tool.driver.name", firstRun(fixtureSarif).tool.driver.name, TOOL_NAME);
  check("informationUri 存在", typeof firstRun(fixtureSarif).tool.driver.informationUri === "string");
  check("rules 是数组", Array.isArray(firstRun(fixtureSarif).tool.driver.rules));
  check("results 是数组", Array.isArray(firstRun(fixtureSarif).results));

  const emptySarif = buildSarif([]);
  eq("空输入 ⇒ 零 result", firstRun(emptySarif).results.length, 0);
  eq("空输入 ⇒ 零 rule", firstRun(emptySarif).tool.driver.rules.length, 0);
  check("空 SARIF 仍有完整骨架", emptySarif.version === "2.1.0" && emptySarif.runs.length === 1);

  /* ---------- 2. Diagnosis → SARIF 映射 ---------- */
  section("2 Diagnosis → rules / results");

  eq("rules 数 = 去重后 issueId 数", firstRun(fixtureSarif).tool.driver.rules.length, new Set(fixtureReport.diagnoses.map((d) => d.issueId)).size);
  eq("results 数 = diagnoses 数", firstRun(fixtureSarif).results.length, fixtureReport.diagnoses.length);

  const ruleIds = firstRun(fixtureSarif).tool.driver.rules.map((r) => r.id);
  check(
    "每条 result 的 ruleId 都能在 rules 里找到",
    firstRun(fixtureSarif).results.every((r) => ruleIds.includes(r.ruleId))
  );
  check(
    "ruleIndex 指向正确的 rule",
    firstRun(fixtureSarif).results.every(
      (r) => firstRun(fixtureSarif).tool.driver.rules[r.ruleIndex]?.id === r.ruleId
    )
  );
  check(
    "rule 含 shortDescription / fullDescription / help / defaultConfiguration",
    firstRun(fixtureSarif).tool.driver.rules.every(
      (r) =>
        typeof r.shortDescription.text === "string" &&
        typeof r.fullDescription.text === "string" &&
        typeof r.help.text === "string" &&
        typeof r.defaultConfiguration.level === "string"
    )
  );

  const dupSarif = sarifFromDiagnoses([
    {
      issueId: "viewport/missing",
      checkId: "viewport",
      targetUrl: URL,
      severity: "major",
      detail: "缺少 viewport",
    },
    {
      issueId: "viewport/missing",
      checkId: "viewport",
      targetUrl: "https://whivi.com/other",
      severity: "major",
      detail: "另一个页面也缺 viewport",
    },
  ]);
  eq("同 issueId 只产一条 rule", firstRun(dupSarif).tool.driver.rules.length, 1);
  eq("但产两条 result", firstRun(dupSarif).results.length, 2);
  eq("两条 result 指向同一 rule", [...new Set(firstRun(dupSarif).results.map((r) => r.ruleIndex))], [0]);

  eq("blocker → error", levelForSeverity("blocker"), "error");
  eq("major → error", levelForSeverity("major"), "error");
  eq("minor → warning", levelForSeverity("minor"), "warning");
  check(
    "严重度留在 properties 里（压成两档不丢事实）",
    firstRun(fixtureSarif).results.every((r) => typeof r.properties?.severity === "string")
  );

  /* ---------- 3. 定位规则：URL，不是文件；无 region ---------- */
  section("3 定位：uri = targetUrl，无 region");

  eq(
    "★ artifactLocation.uri 就是 targetUrl",
    firstRun(fixtureSarif).results[0]?.locations?.[0]?.physicalLocation.artifactLocation.uri,
    fixtureReport.diagnoses[0]?.targetUrl
  );
  // Diagnosis.targetUrl 本就取自 audit.finalUrl（S2-1），
  // 所以重定向场景要从 audit 层构造，而不是事后改报告字段
  const redirectedAudit = { ...analyze(URL, FIXTURE, 200, 0), finalUrl: "https://whivi.com/guide/" };
  const redirectedSarif = sarifFromCheckReport(buildCheckReport(redirectedAudit));
  eq(
    "重定向 ⇒ SARIF 定位落在最终地址",
    firstRun(redirectedSarif).results[0]?.locations?.[0]?.physicalLocation.artifactLocation.uri,
    "https://whivi.com/guide/"
  );
  check(
    "★ 全文档不含 region（没有行号就不写）",
    !hasKeyDeep(fixtureSarif, "region"),
    JSON.stringify(firstRun(fixtureSarif).results[0]?.locations)
  );
  check("★ 全文档不含 contextRegion", !hasKeyDeep(fixtureSarif, "contextRegion"));
  check("★ 全文档不含 startLine", !hasKeyDeep(fixtureSarif, "startLine"));
  check(
    "location 里只有 uri，没有伪造的文件路径",
    firstRun(fixtureSarif).results.every(
      (r) => !r.locations?.[0]?.physicalLocation.artifactLocation.uri?.startsWith("/")
    )
  );

  const noUri = buildSarif([
    { ruleId: "x/y", level: "warning", message: "没有 URL 的问题" },
  ]);
  check("★ 没有 uri ⇒ result 不带 locations（SARIF 允许）", !("locations" in (firstRun(noUri).results[0] ?? {})));

  /* ---------- 4. gate → SARIF ---------- */
  section("4 gate → SARIF");

  function snap(partial: Partial<GateSnapshot> & { diagnoses?: { issueId: string; severity: string }[] }): GateSnapshot {
    const diagnoses = partial.diagnoses ?? [];
    return {
      seoScore: partial.seoScore ?? null,
      geoScore: partial.geoScore ?? null,
      counts: partial.counts ?? { blocker: 0, major: 0, minor: 0 },
      issueIds: diagnoses.map((d) => d.issueId),
      diagnoses,
    };
  }

  const good = snap({ seoScore: 90, geoScore: 70 });
  const dropped = snap({ seoScore: 90, geoScore: 50, diagnoses: [{ issueId: "viewport/missing", severity: "major" }] });

  const failGate = evaluateGate(dropped, good);
  eq("先确认 gate 自身判 fail", failGate.decision, "fail");
  const failSarif = sarifFromGateReport(failGate, { url: URL });
  check("fail ⇒ 至少一条 result", firstRun(failSarif).results.length >= 1);
  eq("fail ⇒ level error", [...new Set(firstRun(failSarif).results.map((r) => r.level))], ["error"]);
  eq("gate rule 只有一条", firstRun(failSarif).tool.driver.rules.length, 1);
  eq(
    "每条依据一条 result",
    firstRun(failSarif).results.length,
    failGate.reasons.filter((r) => r !== "未触发任何门禁条件" && r !== "未触发门禁条件").length
  );
  eq("给了 url 就落在 uri 上", firstRun(failSarif).results[0]?.locations?.[0]?.physicalLocation.artifactLocation.uri, URL);

  const passGate = evaluateGate(good, good);
  eq("先确认 gate 自身判 pass", passGate.decision, "pass");
  eq("真 PASS ⇒ 零 result（没问题就不该出现）", firstRun(sarifFromGateReport(passGate)).results.length, 0);

  const noBase = evaluateGate(good, null);
  const noBaseSarif = sarifFromGateReport(noBase);
  eq("★ 无基线 ⇒ 仍记一条 note（不是 PASS）", firstRun(noBaseSarif).results.length, 1);
  eq("无基线 ⇒ level note", firstRun(noBaseSarif).results[0]?.level, "note");
  check(
    "无基线文案保留「未做退化判定」",
    (firstRun(noBaseSarif).results[0]?.message.text ?? "").includes("未做退化判定"),
    firstRun(noBaseSarif).results[0]?.message.text ?? ""
  );
  check("无 url ⇒ 不带 locations（不编造）", !("locations" in (firstRun(noBaseSarif).results[0] ?? {})));
  eq("baselineFound=false 记录在 properties", firstRun(noBaseSarif).results[0]?.properties?.baselineFound, "false");

  /* ---------- 5. CLI 集成：json / markdown 不受影响 ---------- */
  section("5 CLI 集成");

  eq("sarif 进入 OutputFormat", parseFormat("sarif"), "sarif");
  eq("三种格式都在", OUTPUT_FORMATS, ["json", "markdown", "sarif"]);

  const viaCli = JSON.parse(renderCheck(bareReport, "sarif")) as SarifLog;
  eq("renderCheck(sarif) 产出 SARIF", viaCli.version, "2.1.0");
  eq("renderCheck(sarif) results 数与报告一致", firstRun(viaCli).results.length, bareReport.diagnoses.length);
  const gateSarifViaCli = JSON.parse(renderGate(failGate, "sarif", { url: URL })) as SarifLog;
  eq("renderGate(sarif) 产出 SARIF", gateSarifViaCli.version, "2.1.0");

  const jsonOut = renderCheck(bareReport, "json");
  eq("json 输出仍是原始报告", (JSON.parse(jsonOut) as typeof bareReport).url, URL);
  check("json 不是 SARIF", !(JSON.parse(jsonOut) as Record<string, unknown>).$schema);
  const mdOut = renderCheck(bareReport, "markdown");
  check("markdown 仍为人读摘要", mdOut.includes("# GEOkit 检查"), mdOut.split("\n")[0] ?? "");
  const gateMd = renderGate(failGate, "markdown");
  check("gate markdown 不变", gateMd.includes("# GEOkit 门禁"), gateMd.split("\n")[0] ?? "");

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
