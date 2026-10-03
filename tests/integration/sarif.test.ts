import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildCheckReport, checkHtml } from "../../packages/cli/src/check";
import { evaluateGate, type GateSnapshot } from "../../packages/cli/src/gate";
import { OUTPUT_FORMATS, parseFormat, renderCheck, renderGate } from "../../packages/cli/src/output";
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
} from "../../packages/cli/src/sarif";
import { analyze } from "../../src/lib/audit";

const URL = "https://whivi.com/guide";
const FIXTURE = readFileSync("tests/fixtures/audit/sample.html", "utf8");
const BARE = `<!DOCTYPE html><html><head><title>hi</title></head><body><h1>hi</h1></body></html>`;

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

describe("SARIF 2.1.0 Integration Tests", () => {
  const fixtureReport = buildCheckReport(analyze(URL, FIXTURE, 200, 0));
  const bareReport = checkHtml(BARE, URL);
  const fixtureSarif = sarifFromCheckReport(fixtureReport);

  describe("1 SARIF 骨架", () => {
    it("遵循 SARIF 2.1.0 规范，包含单 run、rules、results 与 driver 信息", () => {
      assert.strictEqual(fixtureSarif.version, "2.1.0");
      assert.strictEqual(SARIF_VERSION, "2.1.0");
      assert.strictEqual(fixtureSarif.$schema, SARIF_SCHEMA);
      assert.strictEqual(fixtureSarif.runs.length, 1);
      assert.strictEqual(firstRun(fixtureSarif).tool.driver.name, TOOL_NAME);
      assert.strictEqual(typeof firstRun(fixtureSarif).tool.driver.informationUri, "string");
      assert.ok(Array.isArray(firstRun(fixtureSarif).tool.driver.rules));
      assert.ok(Array.isArray(firstRun(fixtureSarif).results));

      const emptySarif = buildSarif([]);
      assert.strictEqual(firstRun(emptySarif).results.length, 0);
      assert.strictEqual(firstRun(emptySarif).tool.driver.rules.length, 0);
      assert.strictEqual(emptySarif.version, "2.1.0");
      assert.strictEqual(emptySarif.runs.length, 1);
    });
  });

  describe("2 Diagnosis → rules / results 映射", () => {
    it("rules 数量等于去重后 issueId 数，results 对应每条诊断", () => {
      assert.strictEqual(
        firstRun(fixtureSarif).tool.driver.rules.length,
        new Set(fixtureReport.diagnoses.map((d) => d.issueId)).size
      );
      assert.strictEqual(firstRun(fixtureSarif).results.length, fixtureReport.diagnoses.length);

      const ruleIds = firstRun(fixtureSarif).tool.driver.rules.map((r) => r.id);
      assert.ok(firstRun(fixtureSarif).results.every((r) => ruleIds.includes(r.ruleId)));
      assert.ok(
        firstRun(fixtureSarif).results.every(
          (r) => firstRun(fixtureSarif).tool.driver.rules[r.ruleIndex]?.id === r.ruleId
        )
      );
      assert.ok(
        firstRun(fixtureSarif).tool.driver.rules.every(
          (r) =>
            typeof r.shortDescription.text === "string" &&
            typeof r.fullDescription.text === "string" &&
            typeof r.help.text === "string" &&
            typeof r.defaultConfiguration.level === "string"
        )
      );
    });

    it("同 issueId 仅产一条 rule 但保留多条 result", () => {
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
      assert.strictEqual(firstRun(dupSarif).tool.driver.rules.length, 1);
      assert.strictEqual(firstRun(dupSarif).results.length, 2);
      assert.deepStrictEqual(
        [...new Set(firstRun(dupSarif).results.map((r) => r.ruleIndex))],
        [0]
      );
    });

    it("严重度映射：blocker/major → error, minor → warning", () => {
      assert.strictEqual(levelForSeverity("blocker"), "error");
      assert.strictEqual(levelForSeverity("major"), "error");
      assert.strictEqual(levelForSeverity("minor"), "warning");
      assert.ok(
        firstRun(fixtureSarif).results.every((r) => typeof r.properties?.severity === "string")
      );
    });
  });

  describe("3 定位规则：URL 真实地址，不编造行号 region", () => {
    it("artifactLocation.uri 正确对应 targetUrl，重定向落于最终地址", () => {
      assert.strictEqual(
        firstRun(fixtureSarif).results[0]?.locations?.[0]?.physicalLocation.artifactLocation.uri,
        fixtureReport.diagnoses[0]?.targetUrl
      );

      const redirectedAudit = { ...analyze(URL, FIXTURE, 200, 0), finalUrl: "https://whivi.com/guide/" };
      const redirectedSarif = sarifFromCheckReport(buildCheckReport(redirectedAudit));
      assert.strictEqual(
        firstRun(redirectedSarif).results[0]?.locations?.[0]?.physicalLocation.artifactLocation.uri,
        "https://whivi.com/guide/"
      );
    });

    it("全文档严禁伪造 region、startLine 或 contextRegion", () => {
      assert.strictEqual(hasKeyDeep(fixtureSarif, "region"), false);
      assert.strictEqual(hasKeyDeep(fixtureSarif, "contextRegion"), false);
      assert.strictEqual(hasKeyDeep(fixtureSarif, "startLine"), false);
      assert.ok(
        firstRun(fixtureSarif).results.every(
          (r) => !r.locations?.[0]?.physicalLocation.artifactLocation.uri?.startsWith("/")
        )
      );

      const noUri = buildSarif([{ ruleId: "x/y", level: "warning", message: "无 URL" }]);
      assert.strictEqual("locations" in (firstRun(noUri).results[0] ?? {}), false);
    });
  });

  describe("4 gate → SARIF 门禁产物", () => {
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

    it("门禁 fail 映射为 error level result", () => {
      const failGate = evaluateGate(dropped, good);
      assert.strictEqual(failGate.decision, "fail");
      const failSarif = sarifFromGateReport(failGate, { url: URL });
      assert.ok(firstRun(failSarif).results.length >= 1);
      assert.deepStrictEqual([...new Set(firstRun(failSarif).results.map((r) => r.level))], ["error"]);
      assert.strictEqual(firstRun(failSarif).tool.driver.rules.length, 1);
      assert.strictEqual(
        firstRun(failSarif).results[0]?.locations?.[0]?.physicalLocation.artifactLocation.uri,
        URL
      );
    });

    it("门禁 pass 产出零 result，无基线记为 note", () => {
      const passGate = evaluateGate(good, good);
      assert.strictEqual(passGate.decision, "pass");
      assert.strictEqual(firstRun(sarifFromGateReport(passGate)).results.length, 0);

      const noBase = evaluateGate(good, null);
      const noBaseSarif = sarifFromGateReport(noBase);
      assert.strictEqual(firstRun(noBaseSarif).results.length, 1);
      assert.strictEqual(firstRun(noBaseSarif).results[0]?.level, "note");
      assert.ok((firstRun(noBaseSarif).results[0]?.message.text ?? "").includes("未做退化判定"));
      assert.strictEqual("locations" in (firstRun(noBaseSarif).results[0] ?? {}), false);
      assert.strictEqual(firstRun(noBaseSarif).results[0]?.properties?.baselineFound, "false");
    });
  });

  describe("5 CLI 集成与格式输出", () => {
    it("支持 json / markdown / sarif 三种输出格式且互不干扰", () => {
      assert.strictEqual(parseFormat("sarif"), "sarif");
      assert.deepStrictEqual(OUTPUT_FORMATS, ["json", "markdown", "sarif"]);

      const viaCli = JSON.parse(renderCheck(bareReport, "sarif")) as SarifLog;
      assert.strictEqual(viaCli.version, "2.1.0");
      assert.strictEqual(firstRun(viaCli).results.length, bareReport.diagnoses.length);

      const jsonOut = renderCheck(bareReport, "json");
      assert.strictEqual((JSON.parse(jsonOut) as typeof bareReport).url, URL);
      assert.ok(!(JSON.parse(jsonOut) as Record<string, unknown>).$schema);

      const mdOut = renderCheck(bareReport, "markdown");
      assert.ok(mdOut.includes("# GEOkit 检查"));
    });
  });
});
