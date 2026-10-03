import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
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
} from "../../packages/cli/src/check";
import { DEFAULT_GATE, evaluateGate, runGate, snapshotFromFile, snapshotOf, type GateSnapshot } from "../../packages/cli/src/gate";
import { runDiff } from "../../packages/cli/src/diff";
import { OUTPUT_FORMATS, parseFormat, renderCheck, renderDiff, renderGate } from "../../packages/cli/src/output";
import { analyze } from "../../src/lib/audit";
import { AI_CRAWLERS, type AiCrawler } from "../../src/lib/llms";
import { createStore } from "../../src/lib/store";
import type { Observation } from "../../src/lib/evidence/types";

const URL = "https://whivi.com/guide";
const FIXTURE = readFileSync(join(process.cwd(), "tests", "fixtures", "audit", "sample.html"), "utf8");
const BARE = `<!DOCTYPE html><html><head><title>短</title></head><body>
<h1>一</h1><h1>二</h1><img src="a.png"><img src="b.png"><img src="c.png"></body></html>`;

let TMP: string;

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

describe("CLI Integration Tests", () => {
  before(() => {
    TMP = mkdtempSync(join(tmpdir(), "geokit-cli-test-"));
  });

  after(() => {
    if (TMP) rmSync(TMP, { recursive: true, force: true });
  });

  describe("1 check 命令：退出码与 issueId 映射", () => {
    it("fixture 只有 minor 时退出码为 0", () => {
      const fixtureReport = checkHtml(FIXTURE, URL);
      assert.strictEqual(fixtureReport.exitCode, 0);
      assert.strictEqual(fixtureReport.counts.blocker, 0);
      assert.strictEqual(fixtureReport.counts.major, 0);
      assert.ok(fixtureReport.counts.minor >= 1);
      assert.ok(fixtureReport.diagnoses.some((d) => d.issueId === "viewport/missing"));
      assert.strictEqual(fixtureReport.diagnoses[0]?.targetUrl, URL);
      assert.strictEqual(fixtureReport.httpStatus, 200);
    });

    it("裸页面存在 major 时退出码为 1", () => {
      const bareReport = checkHtml(BARE, URL);
      assert.strictEqual(bareReport.exitCode, 1);
      assert.ok(bareReport.diagnoses.some((d) => d.issueId === "desc/missing"));
      assert.ok(bareReport.diagnoses.some((d) => d.issueId === "alt/mostly-missing"));
    });

    it("抓取失败产生 blocker 与退出码 1", () => {
      const failed = checkFailure(URL, "连接超时");
      assert.strictEqual(failed.counts.blocker, 1);
      assert.strictEqual(failed.exitCode, 1);
      assert.strictEqual(failed.diagnoses[0]?.issueId, "fetch/unreachable");
      assert.strictEqual(failed.diagnoses[0]?.suggestedFix, undefined);
    });

    it("counts 计算规则与确定性输出", () => {
      assert.strictEqual(exitCodeFor({ blocker: 0, major: 0, minor: 5 }), 0);
      assert.strictEqual(exitCodeFor({ blocker: 0, major: 1, minor: 0 }), 1);

      const bareReport = checkHtml(BARE, URL);
      const determinism = checkHtml(BARE, URL);
      determinism.fetchedAt = bareReport.fetchedAt;
      assert.deepStrictEqual(determinism, bareReport);
    });
  });

  describe("2 协议层诊断：robots / llms.txt", () => {
    it("robots.txt 屏蔽主流 AI 爬虫判定为 major，缺失为 minor", () => {
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
      assert.strictEqual(robotsDs[0]?.severity, "major");
      assert.strictEqual(robotsDs[0]?.issueId, "robots/ai-blocked");
      assert.strictEqual(robotsDs[0]?.suggestedFix, undefined);
      assert.ok((robotsDs[0]?.manualFix ?? "").includes("GPTBot"));

      const noRobots = { ...blocked, exists: false, policies: [] };
      assert.strictEqual(diagnoseProtocol(noRobots, undefined, URL)[0]?.issueId, "robots/missing");
      assert.strictEqual(diagnoseProtocol({ ...blocked, policies: [] }, undefined, URL).length, 0);
    });

    it("llms.txt 缺失或格式不合规时出具 minor 诊断", () => {
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
      assert.strictEqual(diagnoseProtocol(undefined, noLlms, URL)[0]?.issueId, "llms/missing");
      assert.strictEqual(
        diagnoseProtocol(undefined, { ...noLlms, exists: true, issues: [{ level: "fail", label: "无 H1", detail: "" }] }, URL)[0]?.issueId,
        "llms/invalid"
      );
      assert.strictEqual(
        diagnoseProtocol(undefined, { ...noLlms, exists: true, issues: [{ level: "pass", label: "ok", detail: "" }] }, URL).length,
        0
      );
    });
  });

  describe("3 输出格式解析与渲染", () => {
    it("正确解析格式参数并拒绝未知格式", () => {
      assert.strictEqual(parseFormat(undefined), "markdown");
      assert.strictEqual(parseFormat("JSON"), "json");
      assert.strictEqual(parseFormat("sarif"), "sarif");
      assert.deepStrictEqual(OUTPUT_FORMATS, ["json", "markdown", "sarif"]);
      assert.throws(() => parseFormat("yaml"), /未知输出格式/);
    });

    it("正确渲染 markdown 与 json 结构", () => {
      const bareReport = checkHtml(BARE, URL);
      const fixtureReport = checkHtml(FIXTURE, URL);
      assert.strictEqual(typeof JSON.parse(renderCheck(fixtureReport, "json")), "object");

      const md = renderCheck(bareReport, "markdown");
      assert.ok(md.includes("退出码：1"));
      assert.ok(md.includes("| 严重度 | issueId |"));

      const gateMd = renderGate(evaluateGate(snap({}), null), "markdown");
      assert.ok(gateMd.includes("PASS") || gateMd.includes("FAIL"));
    });
  });

  describe("4 gate 门禁判定：相对基线下降优先于绝对阈值", () => {
    it("GEO 相对下降 > 5 或新增 blocker 判为 fail", () => {
      const dropped = evaluateGate(snap({ geoScore: 60 }), snap({ geoScore: 70 }));
      assert.strictEqual(dropped.decision, "fail");
      assert.strictEqual(dropped.exitCode, 1);
      assert.ok(dropped.reasons[0]?.includes("10"));

      assert.strictEqual(evaluateGate(snap({ geoScore: 67 }), snap({ geoScore: 70 })).decision, "pass");
      assert.strictEqual(evaluateGate(snap({ geoScore: 80 }), snap({ geoScore: 70 })).decision, "pass");

      const newBlocker = evaluateGate(
        snap({ diagnoses: [{ issueId: "fetch/unreachable", severity: "blocker" }] }),
        snap({ diagnoses: [] })
      );
      assert.strictEqual(newBlocker.decision, "fail");
      assert.strictEqual(newBlocker.deltas?.newBlocker, 1);
    });

    it("低于绝对下限（GEO < 40）无条件 fail", () => {
      const belowFloor = evaluateGate(snap({ geoScore: 30 }), snap({ geoScore: 35 }));
      assert.strictEqual(belowFloor.decision, "fail");
      assert.ok(belowFloor.reasons.some((r) => r.includes("绝对下限")));
    });

    it("无基线时明示未判定，不静默放行也不 fail", () => {
      const noBase = evaluateGate(snap({}), null);
      assert.strictEqual(noBase.decision, "pass");
      assert.ok(noBase.reasons[0]?.includes("未做退化判定"));
      assert.strictEqual(noBase.baseline.found, false);
      assert.deepStrictEqual([DEFAULT_GATE.maxDrop, DEFAULT_GATE.geoMin, DEFAULT_GATE.maxNewMajor], [5, 40, 2]);
    });
  });

  describe("5 gate 文件模式（CI 运行）", () => {
    it("从 baseline.json 读取快照并判定", async () => {
      const basePath = join(TMP, "baseline.json");
      const fixtureReport = checkHtml(FIXTURE, URL);
      writeFileSync(basePath, JSON.stringify(fixtureReport), "utf8");
      const snapshotNow = snapshotFromFile(basePath);
      assert.strictEqual(snapshotNow.geoScore, fixtureReport.geoScore);

      const fileMode = await runGate(snapshotNow, { base: basePath });
      assert.ok(fileMode.baseline.source.startsWith("file:"));
      assert.strictEqual(fileMode.decision, "pass");

      const degraded = await runGate(snap({ geoScore: 20, diagnoses: [] }), { base: basePath });
      assert.strictEqual(degraded.decision, "fail");
      assert.strictEqual(degraded.exitCode, 1);
    });
  });

  describe("6 diff 文件模式", () => {
    it("UNOBSERVABLE → NOT_MENTIONED 属于覆盖度提升，不计为退化", async () => {
      const prevPath = join(TMP, "prev.json");
      const currPath = join(TMP, "curr.json");
      writeFileSync(prevPath, JSON.stringify(obs({ id: "o1", observedAt: "2026-09-20T00:00:00.000Z", status: "UNOBSERVABLE" })));
      writeFileSync(currPath, JSON.stringify(obs({ id: "o2", observedAt: "2026-09-21T00:00:00.000Z", status: "NOT_MENTIONED" })));

      const fileDiff = await runDiff({ prev: prevPath, curr: currPath });
      assert.strictEqual(fileDiff.diff.comparable, false);
      assert.strictEqual(fileDiff.diff.summary.degraded, 0);
      assert.ok(fileDiff.diff.summary.unknown > 0);
      assert.strictEqual(fileDiff.exitCode, 0);

      const diffMd = renderDiff(fileDiff, "markdown");
      assert.ok(diffMd.includes("可比：否"));
    });

    it("NOT_MENTIONED → MENTIONED 判为改善", async () => {
      const prevPath = join(TMP, "prev.json");
      const currPath = join(TMP, "curr.json");
      writeFileSync(prevPath, JSON.stringify(obs({ id: "o3", observedAt: "2026-09-20T00:00:00.000Z", status: "NOT_MENTIONED" })));
      writeFileSync(currPath, JSON.stringify(obs({ id: "o4", observedAt: "2026-09-21T00:00:00.000Z", status: "MENTIONED" })));
      const improved = await runDiff({ prev: prevPath, curr: currPath });
      assert.strictEqual(improved.diff.comparable, true);
      assert.ok(improved.diff.summary.improved > 0);

      await assert.rejects(async () => {
        await runDiff({ prev: prevPath });
      }, /--curr/);
    });
  });

  describe("7 diff Store 模式（本地数据库模式）", () => {
    it("从 Store 取最近两条记录进行对比", async () => {
      const storeDir = join(TMP, "store");
      const store = createStore(storeDir);
      const subject = "search:site=https://whivi.com|q=跨境支付";
      await store.saveObservation(obs({ id: "s1", observedAt: "2026-09-20T00:00:00.000Z", status: "UNOBSERVABLE", subject, type: "rank" }));
      await store.saveObservation(obs({ id: "s2", observedAt: "2026-09-21T00:00:00.000Z", status: "NOT_MENTIONED", subject, type: "rank" }));

      const storeDiff = await runDiff({ subject, type: "rank", dir: storeDir });
      assert.strictEqual(storeDiff.diff.previousId !== null, true);
      assert.strictEqual(storeDiff.diff.currentId !== null, true);
      assert.strictEqual(storeDiff.diff.summary.degraded, 0);
      assert.strictEqual(storeDiff.source, "store");

      const emptyStoreDiff = await runDiff({ subject: "absent:subject", type: "rank", dir: storeDir });
      assert.strictEqual(emptyStoreDiff.exitCode, 1);
    });
  });
});
