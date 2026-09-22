/**
 * Phase 2 / S2-1 · Diagnosis 层契约测试（零新增依赖、全程离线）。
 *
 * 覆盖：
 *   1  离线夹具        tests/fixtures/audit/sample.html → diagnose()
 *   2  11 项 check     逐一映射到稳定 issueId
 *   3  severity       weight≥100→blocker / fail→major / warn→minor
 *   4  suggestedFix    只有 5 类可自动修，其余只出诊断
 *   5  幂等            patch 一次 == patch 两次；patch 后 applies=false
 *   6  不覆盖          已有 viewport / lang / canonical / og 时拒绝修改
 *   7  放弃而非猜      无 </head> 时不改
 *   8  不编造          og:image 不补；alt 只补空值
 *   9  确定性          同一 PageAudit 两次诊断完全相同
 *
 * 用法：npx tsx scripts/test-diagnosis.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { analyze, emptyAudit, type PageAudit } from "../src/lib/audit";
import {
  FIX_RULES,
  applyFix,
  applyFixes,
  autoFixable,
  buildFixContext,
  diagnoseAudit,
  severityOf,
} from "../src/lib/diagnosis";
import { mapCheck } from "../src/lib/diagnosis/rules";
import type { Diagnosis } from "../src/lib/diagnosis/types";

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
/* 夹具 —— 全部离线，禁止网络                                            */
/* ------------------------------------------------------------------ */

const FIXTURE = readFileSync(
  join(process.cwd(), "tests", "fixtures", "audit", "sample.html"),
  "utf8"
);

const URL = "https://whivi.com/guide";

/** 一个「什么都没有」的页面：用来一次性触发 11 项里能触发的那些 */
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

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  /* ---------- 1. 离线夹具 ---------- */
  section("1 离线夹具（tests/fixtures/audit/sample.html）");

  const fixtureAudit = page(FIXTURE);
  const fixtureDs = diagnoseAudit(fixtureAudit);
  check("夹具产生诊断", fixtureDs.length > 0, `${fixtureDs.length} 条`);
  check(
    "每条都有 targetUrl",
    fixtureDs.every((d) => d.targetUrl === URL),
    fixtureDs.map((d) => d.targetUrl).join(",")
  );
  check(
    "pass 的项不产生诊断（canonical/og 已齐备）",
    !ids(fixtureDs).some((i) => i.startsWith("canonical/") || i.startsWith("og/")),
    ids(fixtureDs).join(",")
  );
  eq("夹具缺 viewport ⇒ 一条 minor", byId(fixtureDs, "viewport/missing")?.severity, "minor");
  eq(
    "viewport 可自动修",
    byId(fixtureDs, "viewport/missing")?.suggestedFix,
    "viewport"
  );

  /* ---------- 2. 11 项 check → issueId ---------- */
  section("2 11 项 check → 稳定 issueId");

  eq("http(404)", mapCheck({ id: "http", level: "fail", value: "404" }), {
    issueId: "http/error",
  });
  eq("http(301)", mapCheck({ id: "http", level: "warn", value: "301" }), {
    issueId: "http/redirect",
  });
  eq("title 缺失", mapCheck({ id: "title", level: "fail", value: "" }), {
    issueId: "title/missing",
  });
  eq("title 长度", mapCheck({ id: "title", level: "warn", value: "短标题" }), {
    issueId: "title/length",
  });
  eq("desc 缺失", mapCheck({ id: "desc", level: "fail", value: "" }), {
    issueId: "desc/missing",
  });
  eq("desc 长度", mapCheck({ id: "desc", level: "warn", value: "太短" }), {
    issueId: "desc/length",
  });
  eq("canonical 缺失", mapCheck({ id: "canonical", level: "warn" }), {
    issueId: "canonical/missing",
    fixId: "canonical",
  });
  eq("robots noindex", mapCheck({ id: "robots", level: "fail", value: "noindex" }), {
    issueId: "robots/noindex",
  });
  eq("h1 结构", mapCheck({ id: "h1", level: "warn" }), { issueId: "h1/structure" });
  eq("alt 大面积缺失", mapCheck({ id: "alt", level: "fail", value: "30" }), {
    issueId: "alt/mostly-missing",
    fixId: "alt-empty",
  });
  eq("alt 部分缺失", mapCheck({ id: "alt", level: "warn", value: "1" }), {
    issueId: "alt/partly-missing",
    fixId: "alt-empty",
  });
  eq("viewport 缺失", mapCheck({ id: "viewport", level: "warn" }), {
    issueId: "viewport/missing",
    fixId: "viewport",
  });
  eq("lang 缺失", mapCheck({ id: "lang", level: "warn" }), {
    issueId: "lang/missing",
    fixId: "lang",
  });
  eq("jsonld 缺失", mapCheck({ id: "jsonld", level: "warn" }), {
    issueId: "jsonld/missing",
  });
  eq("og 不完整", mapCheck({ id: "og", level: "warn" }), {
    issueId: "og/incomplete",
    fixId: "og-skeleton",
  });
  eq("pass 不产诊断", mapCheck({ id: "title", level: "pass", value: "正常标题" }), null);
  eq(
    "未知 check 不猜（原样透传，不给自动修）",
    mapCheck({ id: "future-check", level: "warn" }),
    { issueId: "future-check/warn" }
  );

  // 端到端：裸页面能覆盖到多少
  const bareDs = diagnoseAudit(page(BARE));
  console.log(`  \x1b[90m裸页面诊断：${ids(bareDs).join(", ")}\x1b[0m`);
  check(
    "裸页面覆盖 8 类以上问题",
    new Set(bareDs.map((d) => d.checkId)).size >= 8,
    `${new Set(bareDs.map((d) => d.checkId)).size} 类`
  );

  /* ---------- 3. severity ---------- */
  section("3 severity");

  eq("weight=100 ⇒ blocker", severityOf({ level: "fail", weight: 100 }), "blocker");
  eq("fail ⇒ major", severityOf({ level: "fail", weight: 10 }), "major");
  eq("warn ⇒ minor", severityOf({ level: "warn", weight: 10 }), "minor");
  eq("pass 也走 minor 兜底（不会产生，但函数有定义）", severityOf({ level: "pass", weight: 5 }), "minor");

  const fetchDs = diagnoseAudit(emptyAudit(URL, "连接超时", 12));
  eq("抓取失败 ⇒ 唯一 blocker", fetchDs.length, 1);
  eq("抓取失败 issueId", fetchDs[0]?.issueId, "fetch/unreachable");
  eq("抓取失败 severity", fetchDs[0]?.severity, "blocker");
  eq("抓取失败无自动修", fetchDs[0]?.suggestedFix, undefined);
  check("抓取失败保留人工建议", typeof fetchDs[0]?.manualFix === "string");

  eq("title 过短 = minor（非缺失）", byId(bareDs, "title/length")?.severity, "minor");
  const bare404 = diagnoseAudit(page(BARE, 404));
  eq("http 404 = major", byId(bare404, "http/error")?.severity, "major");
  eq("http 302 = minor", byId(diagnoseAudit(page(BARE, 302)), "http/redirect")?.severity, "minor");

  /* ---------- 4. suggestedFix 闸门 ---------- */
  section("4 suggestedFix 闸门");

  eq("规则库只有 5 条", FIX_RULES.length, 5);
  eq(
    "规则库 fixId",
    FIX_RULES.map((r) => r.fixId).sort(),
    ["alt-empty", "canonical", "lang", "og-skeleton", "viewport"]
  );

  const fixable = autoFixable(bareDs);
  check(
    "可自动修的都有 fixId 且在规则库内",
    fixable.every((d) => FIX_RULES.some((r) => r.fixId === d.suggestedFix)),
    fixable.map((d) => d.suggestedFix).join(",")
  );
  check(
    "title / desc / jsonld / h1 / robots 一律不自动修",
    ["title", "desc", "jsonld", "h1", "robots", "http", "fetch"].every(
      (cid) => !fixable.some((d) => d.checkId === cid)
    ),
    fixable.map((d) => d.checkId).join(",")
  );
  check(
    "不可自动修的保留 manualFix（不丢 audit 已给的文案）",
    (byId(bareDs, "jsonld/missing")?.manualFix ?? "").length > 0
  );
  eq("可自动修的不写 manualFix", byId(bareDs, "viewport/missing")?.manualFix, undefined);

  /* ---------- 5. 幂等 ---------- */
  section("5 幂等：patch 一次 == patch 两次");

  const ctx = buildFixContext(page(BARE));
  const once = applyFixes(BARE, bareDs, ctx);
  const twice = applyFixes(once.html, bareDs, ctx);
  eq("第二次执行零改动", twice.attempts.filter((a) => a.changed).length, 0);
  eq("两次结果字节一致", twice.html, once.html);
  check(
    "每条规则 patch 后 applies=false",
    FIX_RULES.every((r) => !r.applies(once.html, ctx)),
    FIX_RULES.filter((r) => r.applies(once.html, ctx)).map((r) => r.fixId).join(",")
  );

  /* ---------- 6. 已有值不覆盖 ---------- */
  section("6 已有值不覆盖");

  const withViewport = `<html><head><meta name="viewport" content="width=device-width"></head><body></body></html>`;
  eq(
    "已有 viewport ⇒ 不改",
    applyFix(withViewport, "viewport", ctx).changed,
    false
  );
  eq(
    "已有 viewport 的 reason 可解释",
    applyFix(withViewport, "viewport", ctx).reason,
    "目标已存在或不适用（不覆盖）"
  );

  const withLang = `<html lang="en"><head></head><body></body></html>`;
  const langAttempt = applyFix(withLang, "lang", ctx);
  eq("已有 lang=en ⇒ 不改（判定权在站方）", langAttempt.changed, false);
  check("lang 未被改写", langAttempt.html.includes('lang="en"'));

  const withCanonical = `<html><head><link rel="canonical" href="https://other.example/p"></head><body></body></html>`;
  eq("已有 canonical ⇒ 不改", applyFix(withCanonical, "canonical", ctx).changed, false);

  const fullOg = `<html><head><meta property="og:title" content="a"><meta property="og:description" content="b"><meta property="og:url" content="https://x/y"></head><body></body></html>`;
  eq(
    "og 三项齐备 ⇒ 不改",
    applyFix(fullOg, "og-skeleton", { ...ctx, title: "t", description: "d" }).changed,
    false
  );

  const withAlt = `<html><head></head><body><img src="a.png" alt="示意图"></body></html>`;
  eq("已有 alt ⇒ 不改", applyFix(withAlt, "alt-empty", ctx).changed, false);

  /* ---------- 7. 放弃而非猜 ---------- */
  section("7 无法定位 ⇒ 放弃，不猜位置");

  const noHead = `<html><body><p>x</p></body></html>`;
  const noHeadAttempt = applyFix(noHead, "viewport", ctx);
  eq("无 </head> ⇒ 不改", noHeadAttempt.changed, false);
  check("放弃原因写清楚", (noHeadAttempt.reason ?? "").includes("插入点"), noHeadAttempt.reason);
  eq("未知 fixId ⇒ 不改且说明", applyFix(noHead, "nope", ctx).changed, false);

  /* ---------- 8. 不编造 ---------- */
  section("8 不编造：og:image 不补、alt 只补空值");

  const ogCtx = { ...ctx, title: "标题 \"引号\" 测试", description: "描述" };
  const ogPatched = applyFix(
    `<html><head></head><body></body></html>`,
    "og-skeleton",
    ogCtx
  );
  check("补了 og:title", ogPatched.html.includes('property="og:title"'));
  check("不补 og:image（地址无法推断）", !ogPatched.html.includes("og:image"), ogPatched.html);
  check("title 里的引号被转义", ogPatched.html.includes("&quot;"), ogPatched.html);

  const altPatched = applyFix(
    `<html><head></head><body><img src="a.png"><img src="b.png" alt="已有"></body></html>`,
    "alt-empty",
    ctx
  );
  eq("只给缺 alt 的图补", (altPatched.html.match(/alt=""/g) ?? []).length, 1);
  check("已有 alt 保持原值", altPatched.html.includes('alt="已有"'));

  /* ---------- 9. 确定性 ---------- */
  section("9 确定性（CI 会反复触发）");

  const a1 = diagnoseAudit(page(BARE));
  const a2 = diagnoseAudit(page(BARE));
  eq("同一 PageAudit 两次诊断一致", a1, a2);

  const withEvidence = diagnoseAudit(page(BARE), { evidenceId: "ev_test_001" });
  check(
    "带 evidenceId 时每条都能指回证据",
    withEvidence.every((d) => d.evidenceId === "ev_test_001")
  );
  eq(
    "未存证时 evidenceId 字段不出现（保持可见）",
    "evidenceId" in (a1[0] ?? {}),
    false
  );

  const fixtureAgain = diagnoseAudit(fixtureAudit);
  eq("夹具复跑一致", fixtureAgain, fixtureDs);

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
