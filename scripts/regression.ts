/**
 * Phase 0 回归基线脚本（零新增依赖，用 tsx 直接跑）。
 *
 * 职责：把「改造前」的行为固化成可比对的输出。
 * 覆盖：三个搜索引擎特殊解析、页面审计、robots/llms、AI 可见性接口形态。
 *
 * 用法：
 *   npx tsx scripts/regression.ts baseline   # 生成/刷新基线
 *   npx tsx scripts/regression.ts check      # 与基线比对
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { extractItems } from "../src/lib/serp";
import { ENGINES, type EngineId } from "../src/lib/engines";
import { analyze } from "../src/lib/audit";

const BASE_DIR = join(process.cwd(), "tests", "baseline");
const FIX_DIR = join(process.cwd(), "tests", "fixtures", "serp");

interface EngineSnapshot {
  engineId: string;
  count: number;
  resolvedCount: number;
  wrapperCount: number;
  domains: string[];
  firstTitles: string[];
  /** 只取 domain 的字符集特征，避免正文噪声导致假 diff */
  malformedDomains: string[];
}

function snapEngine(id: EngineId, keyword: string): EngineSnapshot | { engineId: string; error: string } {
  const htmlPath = join(FIX_DIR, `${id}.html`);
  if (!existsSync(htmlPath)) return { engineId: id, error: "fixture 缺失" };

  const html = readFileSync(htmlPath, "utf8");
  const engine = ENGINES[id];
  const items = extractItems(html, engine, engine.searchUrl("", 0));

  const validHost = /^([a-z0-9-]+\.)+[a-z]{2,}$/i;
  return {
    engineId: id,
    count: items.length,
    resolvedCount: items.filter((i) => i.resolved).length,
    wrapperCount: items.filter((i) => i.redirectWrapper).length,
    domains: items.map((i) => i.domain ?? ""),
    firstTitles: items.slice(0, 5).map((i) => (i.title ?? "").slice(0, 40)),
    malformedDomains: items.filter((i) => !validHost.test(i.domain ?? "")).map((i) => i.domain ?? ""),
  };
}

/** 离线审计：喂固定 HTML，验证 GEO/SEO 评分口径不变 */
function snapAudit() {
  const html = readFileSync(join(process.cwd(), "tests", "fixtures", "audit", "sample.html"), "utf8");
  const a = analyze("https://whivi.com/guide", html, 200, 120);
  return {
    seoScore: a.seoScore,
    geoScore: a.geoScore,
    checkCount: a.checks.length,
    checkIds: a.checks.map((c) => c.id),
    checkLevels: a.checks.map((c) => `${c.id}:${c.level}`),
    geoBreakdown: a.geoBreakdown.map((b) => `${b.label}=${b.score}/${b.max}`),
    jsonLdTypes: a.jsonLdTypes,
    titleLength: a.titleLength,
    wordCount: a.wordCount,
  };
}

function buildBaseline() {
  const out = {
    generatedAt: new Date().toISOString(),
    serp: {
      baidu: snapEngine("baidu", "跨境支付"),
      so360: snapEngine("so360", "跨境支付"),
      sogou: snapEngine("sogou", "跨境支付"),
    },
    audit: snapAudit(),
  };
  mkdirSync(BASE_DIR, { recursive: true });
  writeFileSync(join(BASE_DIR, "baseline.json"), JSON.stringify(out, null, 2), "utf8");
  console.log("✅ baseline 已写入 tests/baseline/baseline.json");

  for (const [k, v] of Object.entries(out.serp)) {
    const s = v as { count: number; malformedDomains: string[]; error?: string };
    if (s.error) {
      console.log(`   ${k.padEnd(6)} ⚠️ ${s.error}`);
    } else {
      console.log(
        `   ${k.padEnd(6)} ${String(s.count).padStart(3)} 条  畸形域名 ${s.malformedDomains.length}`
      );
    }
  }
  console.log(`   audit   SEO ${out.audit.seoScore} / GEO ${out.audit.geoScore} / ${out.audit.checkCount} 项检查`);
}

function diffArrays(name: string, a: string[], b: string[]): string[] {
  const out: string[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) out.push(`   ${name}[${i}]  基线=${JSON.stringify(a[i])}  当前=${JSON.stringify(b[i])}`);
  }
  return out;
}

function checkBaseline() {
  const p = join(BASE_DIR, "baseline.json");
  if (!existsSync(p)) {
    console.error("❌ 未找到 baseline，请先运行 baseline 子命令");
    process.exit(1);
  }
  const base = JSON.parse(readFileSync(p, "utf8"));

  const problems: string[] = [];
  const notes: string[] = [];

  for (const id of ["baidu", "so360", "sogou"] as EngineId[]) {
    const cur = snapEngine(id, "跨境支付") as EngineSnapshot;
    const pre = base.serp[id] as EngineSnapshot;
    if (!pre) continue;

    if (pre.count !== cur.count) {
      problems.push(`   [${id}] 条目数 ${pre.count} → ${cur.count}`);
    }
    if (pre.resolvedCount !== cur.resolvedCount) {
      problems.push(`   [${id}] 已解析域名 ${pre.resolvedCount} → ${cur.resolvedCount}`);
    }
    if (pre.wrapperCount !== cur.wrapperCount) {
      problems.push(`   [${id}] 中转链接 ${pre.wrapperCount} → ${cur.wrapperCount}`);
    }
    if (pre.malformedDomains.length !== cur.malformedDomains.length) {
      problems.push(`   [${id}] 畸形域名 ${pre.malformedDomains.length} → ${cur.malformedDomains.length}`);
    }
    problems.push(...diffArrays(`[${id}] 域名序列`, pre.domains, cur.domains));
    notes.push(
      `   ${id.padEnd(6)} ${String(cur.count).padStart(3)} 条  解析 ${cur.resolvedCount}  中转 ${cur.wrapperCount}  畸形 ${cur.malformedDomains.length}`
    );
  }

  const curAudit = snapAudit();
  const preAudit = base.audit;
  if (preAudit.seoScore !== curAudit.seoScore) problems.push(`   [audit] SEO 分 ${preAudit.seoScore} → ${curAudit.seoScore}`);
  if (preAudit.geoScore !== curAudit.geoScore) problems.push(`   [audit] GEO 分 ${preAudit.geoScore} → ${curAudit.geoScore}`);
  if (preAudit.checkCount !== curAudit.checkCount) problems.push(`   [audit] 检查项 ${preAudit.checkCount} → ${curAudit.checkCount}`);
  problems.push(...diffArrays("[audit] 检查项 id/level", preAudit.checkLevels, curAudit.checkLevels));
  problems.push(...diffArrays("[audit] GEO 六维", preAudit.geoBreakdown, curAudit.geoBreakdown));
  notes.push(`   audit   SEO ${curAudit.seoScore} / GEO ${curAudit.geoScore} / ${curAudit.checkCount} 项`);

  console.log("=== 当前行为 ===");
  notes.forEach((n) => console.log(n));

  if (problems.length === 0) {
    console.log("\n✅ 回归通过：与 baseline 行为完全一致");
    return;
  }
  console.log(`\n❌ 检测到 ${problems.length} 处行为变化：`);
  problems.slice(0, 40).forEach((p) => console.log(p));
  if (problems.length > 40) console.log(`   …另有 ${problems.length - 40} 处`);
  process.exitCode = 1;
}

const cmd = process.argv[2] ?? "check";
if (cmd === "baseline") buildBaseline();
else checkBaseline();
