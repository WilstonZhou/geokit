import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { analyze, emptyAudit, type PageAudit } from "../../src/lib/audit";
import {
  FIX_RULES,
  applyFix,
  applyFixes,
  autoFixable,
  buildFixContext,
  diagnoseAudit,
  severityOf,
} from "../../src/lib/diagnosis";
import { mapCheck } from "../../src/lib/diagnosis/rules";
import type { Diagnosis } from "../../src/lib/diagnosis/types";

const FIXTURE = readFileSync(
  join(process.cwd(), "tests", "fixtures", "audit", "sample.html"),
  "utf8"
);

const URL = "https://whivi.com/guide";

const BARE = `<!DOCTYPE html><html><head><title>短</title></head><body>
<h1>一</h1><h1>二</h1>
<img src="a.png"><img src="b.png"><img src="c.png">
<p>正文</p></body></html>`;

function page(html: string, status = 200): PageAudit {
  return analyze(URL, html, status, 0);
}

function ids(ds: Diagnosis[]): string[] {
  return ds.map((d) => d.issueId);
}

function byId(ds: Diagnosis[], issueId: string): Diagnosis | undefined {
  return ds.find((d) => d.issueId === issueId);
}

describe("Diagnosis Engine (Unit Tests)", () => {
  describe("1 离线夹具与基础映射", () => {
    const fixtureAudit = page(FIXTURE);
    const fixtureDs = diagnoseAudit(fixtureAudit);

    it("夹具产生诊断且每条都有 targetUrl", () => {
      assert.ok(fixtureDs.length > 0);
      assert.ok(fixtureDs.every((d) => d.targetUrl === URL));
    });

    it("pass 的项不产生诊断（canonical/og 已齐备）", () => {
      assert.ok(!ids(fixtureDs).some((i) => i.startsWith("canonical/") || i.startsWith("og/")));
    });

    it("夹具缺 viewport ⇒ 一条 minor 且可自动修", () => {
      assert.strictEqual(byId(fixtureDs, "viewport/missing")?.severity, "minor");
      assert.strictEqual(byId(fixtureDs, "viewport/missing")?.suggestedFix, "viewport");
    });
  });

  describe("2 11 项 check → 稳定 issueId", () => {
    it("各项 checkId 到 issueId 映射正确", () => {
      assert.deepStrictEqual(mapCheck({ id: "http", level: "fail", value: "404" }), { issueId: "http/error" });
      assert.deepStrictEqual(mapCheck({ id: "http", level: "warn", value: "301" }), { issueId: "http/redirect" });
      assert.deepStrictEqual(mapCheck({ id: "title", level: "fail", value: "" }), { issueId: "title/missing" });
      assert.deepStrictEqual(mapCheck({ id: "title", level: "warn", value: "短标题" }), { issueId: "title/length" });
      assert.deepStrictEqual(mapCheck({ id: "desc", level: "fail", value: "" }), { issueId: "desc/missing" });
      assert.deepStrictEqual(mapCheck({ id: "desc", level: "warn", value: "太短" }), { issueId: "desc/length" });
      assert.deepStrictEqual(mapCheck({ id: "canonical", level: "warn" }), { issueId: "canonical/missing", fixId: "canonical" });
      assert.deepStrictEqual(mapCheck({ id: "robots", level: "fail", value: "noindex" }), { issueId: "robots/noindex" });
      assert.deepStrictEqual(mapCheck({ id: "h1", level: "warn" }), { issueId: "h1/structure" });
      assert.deepStrictEqual(mapCheck({ id: "alt", level: "fail", value: "30" }), { issueId: "alt/mostly-missing", fixId: "alt-empty" });
      assert.deepStrictEqual(mapCheck({ id: "alt", level: "warn", value: "1" }), { issueId: "alt/partly-missing", fixId: "alt-empty" });
      assert.deepStrictEqual(mapCheck({ id: "viewport", level: "warn" }), { issueId: "viewport/missing", fixId: "viewport" });
      assert.deepStrictEqual(mapCheck({ id: "lang", level: "warn" }), { issueId: "lang/missing", fixId: "lang" });
      assert.deepStrictEqual(mapCheck({ id: "jsonld", level: "warn" }), { issueId: "jsonld/missing" });
      assert.deepStrictEqual(mapCheck({ id: "og", level: "warn" }), { issueId: "og/incomplete", fixId: "og-skeleton" });
      assert.strictEqual(mapCheck({ id: "title", level: "pass", value: "正常标题" }), null);
      assert.deepStrictEqual(mapCheck({ id: "future-check", level: "warn" }), { issueId: "future-check/warn" });
    });

    it("裸页面覆盖 8 类以上问题", () => {
      const bareDs = diagnoseAudit(page(BARE));
      assert.ok(new Set(bareDs.map((d) => d.checkId)).size >= 8);
    });
  });

  describe("3 severity 严重度判定", () => {
    it("weight 规则映射", () => {
      assert.strictEqual(severityOf({ level: "fail", weight: 100 }), "blocker");
      assert.strictEqual(severityOf({ level: "fail", weight: 10 }), "major");
      assert.strictEqual(severityOf({ level: "warn", weight: 10 }), "minor");
      assert.strictEqual(severityOf({ level: "pass", weight: 5 }), "minor");
    });

    it("抓取失败为唯一 blocker，且无自动修但有人工建议", () => {
      const fetchDs = diagnoseAudit(emptyAudit(URL, "连接超时", 12));
      assert.strictEqual(fetchDs.length, 1);
      assert.strictEqual(fetchDs[0]?.issueId, "fetch/unreachable");
      assert.strictEqual(fetchDs[0]?.severity, "blocker");
      assert.strictEqual(fetchDs[0]?.suggestedFix, undefined);
      assert.strictEqual(typeof fetchDs[0]?.manualFix, "string");
    });

    it("HTTP 404 为 major，302 为 minor", () => {
      const bare404 = diagnoseAudit(page(BARE, 404));
      assert.strictEqual(byId(bare404, "http/error")?.severity, "major");
      assert.strictEqual(byId(diagnoseAudit(page(BARE, 302)), "http/redirect")?.severity, "minor");
    });
  });

  describe("4 suggestedFix 闸门", () => {
    const bareDs = diagnoseAudit(page(BARE));

    it("规则库仅包含 5 条可预测规则", () => {
      assert.strictEqual(FIX_RULES.length, 5);
      assert.deepStrictEqual(
        FIX_RULES.map((r) => r.fixId).sort(),
        ["alt-empty", "canonical", "lang", "og-skeleton", "viewport"]
      );
    });

    it("可自动修的均在规则库内，内容决策类绝不进入自动修复", () => {
      const fixable = autoFixable(bareDs);
      assert.ok(fixable.every((d) => FIX_RULES.some((r) => r.fixId === d.suggestedFix)));
      assert.ok(
        ["title", "desc", "jsonld", "h1", "robots", "http", "fetch"].every(
          (cid) => !fixable.some((d) => d.checkId === cid)
        )
      );
      assert.ok((byId(bareDs, "jsonld/missing")?.manualFix ?? "").length > 0);
      assert.strictEqual(byId(bareDs, "viewport/missing")?.manualFix, undefined);
    });
  });

  describe("5 幂等性与 patch 验证", () => {
    const bareDs = diagnoseAudit(page(BARE));
    const ctx = buildFixContext(page(BARE));

    it("patch 一次 == patch 两次，第二次执行 changed=0", () => {
      const once = applyFixes(BARE, bareDs, ctx);
      const twice = applyFixes(once.html, bareDs, ctx);
      assert.strictEqual(twice.attempts.filter((a) => a.changed).length, 0);
      assert.strictEqual(twice.html, once.html);
      assert.ok(FIX_RULES.every((r) => !r.applies(once.html, ctx)));
    });
  });

  describe("6 已有值不覆盖原则", () => {
    const ctx = buildFixContext(page(BARE));

    it("已有 viewport / lang / canonical / og / alt 拒绝盲目覆盖", () => {
      const withViewport = `<html><head><meta name="viewport" content="width=device-width"></head><body></body></html>`;
      const vpRes = applyFix(withViewport, "viewport", ctx);
      assert.strictEqual(vpRes.changed, false);
      assert.strictEqual(vpRes.reason, "目标已存在或不适用（不覆盖）");

      const withLang = `<html lang="en"><head></head><body></body></html>`;
      const langRes = applyFix(withLang, "lang", ctx);
      assert.strictEqual(langRes.changed, false);
      assert.ok(langRes.html.includes('lang="en"'));

      const withCanonical = `<html><head><link rel="canonical" href="https://other.example/p"></head><body></body></html>`;
      assert.strictEqual(applyFix(withCanonical, "canonical", ctx).changed, false);

      const fullOg = `<html><head><meta property="og:title" content="a"><meta property="og:description" content="b"><meta property="og:url" content="https://x/y"></head><body></body></html>`;
      assert.strictEqual(applyFix(fullOg, "og-skeleton", { ...ctx, title: "t", description: "d" }).changed, false);

      const withAlt = `<html><head></head><body><img src="a.png" alt="示意图"></body></html>`;
      assert.strictEqual(applyFix(withAlt, "alt-empty", ctx).changed, false);
    });
  });

  describe("7 无法安全定位时放弃修改", () => {
    const ctx = buildFixContext(page(BARE));

    it("无 </head> 时不插入并说明原因", () => {
      const noHead = `<html><body><p>x</p></body></html>`;
      const noHeadRes = applyFix(noHead, "viewport", ctx);
      assert.strictEqual(noHeadRes.changed, false);
      assert.ok((noHeadRes.reason ?? "").includes("插入点"));
      assert.strictEqual(applyFix(noHead, "nope", ctx).changed, false);
    });
  });

  describe("8 不编造数据", () => {
    const ctx = buildFixContext(page(BARE));

    it("og:image 绝不臆造，引号安全转义", () => {
      const ogCtx = { ...ctx, title: '标题 "引号" 测试', description: "描述" };
      const ogPatched = applyFix(`<html><head></head><body></body></html>`, "og-skeleton", ogCtx);
      assert.ok(ogPatched.html.includes('property="og:title"'));
      assert.ok(!ogPatched.html.includes("og:image"));
      assert.ok(ogPatched.html.includes("&quot;"));
    });

    it("alt 只给缺 alt 的图片补充空值", () => {
      const altPatched = applyFix(
        `<html><head></head><body><img src="a.png"><img src="b.png" alt="已有"></body></html>`,
        "alt-empty",
        ctx
      );
      assert.strictEqual((altPatched.html.match(/alt=""/g) ?? []).length, 1);
      assert.ok(altPatched.html.includes('alt="已有"'));
    });
  });

  describe("9 确定性与存证指回", () => {
    it("同一 PageAudit 两次诊断完全相同", () => {
      const a1 = diagnoseAudit(page(BARE));
      const a2 = diagnoseAudit(page(BARE));
      assert.deepStrictEqual(a1, a2);
    });

    it("带 evidenceId 时每条都指回证据，未存证时不产生字段", () => {
      const a1 = diagnoseAudit(page(BARE));
      const withEvidence = diagnoseAudit(page(BARE), { evidenceId: "ev_test_001" });
      assert.ok(withEvidence.every((d) => d.evidenceId === "ev_test_001"));
      assert.strictEqual("evidenceId" in (a1[0] ?? {}), false);
    });
  });
});
