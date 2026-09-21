/**
 * AI 可见性「真实验证」脚本（Phase 0 收尾用，零新增依赖）。
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么需要它
 * ─────────────────────────────────────────────────────────────
 * 离线 fixture 只能证明 UNOBSERVABLE 分支正确。其余四种状态里，
 * BLOCKED / ERROR 从来没被真实触发过 —— 而恰恰是这两条分支承载着
 * 「厂商拒绝了」和「我们搞砸了」的区分，混淆它们会误导所有决策。
 *
 * ─────────────────────────────────────────────────────────────
 * 怎么在没有真 key 时也能验证
 * ─────────────────────────────────────────────────────────────
 * 关键洞察：五种状态里有四种可以**确定性构造**，不需要碰运气。
 *
 *   UNOBSERVABLE  ← 不传 key                     （已知）
 *   BLOCKED       ← 真实 key 翻掉末位 → 401       （确定命中 BLOCKED_STATUSES）
 *   ERROR         ← 影子 provider 指向不可达端口  → status 0（确定）
 *   MENTIONED     ← 真实 key + 知名品牌           （需真 key）
 *   NOT_MENTIONED ← 真实 key + 生僻品牌           （需真 key）
 *
 * 因此即使一个 key 都没有，本脚本仍能覆盖 3/5 状态并给出结论。
 *
 * 用法：
 *   npx tsx scripts/verify-ai-visibility.ts
 *   npx tsx scripts/verify-ai-visibility.ts --brand=某某品牌 --topic=某个主题
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

import {
  PROVIDERS,
  PROVIDER_LIST,
  probeProvider,
  buildVisibilityReport,
  SAMPLING_PROFILE,
  AI_VISIBILITY_PARSER_VERSION,
  type AiProvider,
  type VisibilityProbe,
} from "../src/lib/visibility";

/* ------------------------------------------------------------------ */
/* 参数                                                               */
/* ------------------------------------------------------------------ */

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const BRAND = arg("brand", "鲸汇通");
const TOPIC = arg("topic", "跨境支付平台推荐");

/* ------------------------------------------------------------------ */
/* 证据落盘：临时目录跑完即删                                          */
/* ------------------------------------------------------------------ */

const EVIDENCE_DIR = mkdtempSync(join(tmpdir(), "geokit-ev-"));
// 必须在 import 之后、调用之前设置 —— store.ts 在调用时才读取
process.env.GEOKIT_EVIDENCE = "on";
process.env.GEOKIT_EVIDENCE_DIR = EVIDENCE_DIR;
process.env.GEOKIT_EVIDENCE_BODY = "on";

/* ------------------------------------------------------------------ */
/* 场景构造                                                            */
/* ------------------------------------------------------------------ */

/** 把 key 末位翻掉：保持格式合法、长度不变，但服务端必然返回 401 */
function corruptKey(key: string): string {
  if (key.length < 2) return "corrupted-key-for-verification";
  return key.slice(0, -1) + (key.slice(-1) === "x" ? "y" : "x");
}

/**
 * 影子 provider：结构完全合法，但端点指向本地一个必然被拒的端口。
 * 127.0.0.1:1 没有任何进程监听 → ECONNREFUSED → FetchResult.status === 0 → ERROR。
 */
const SHADOW_PROVIDER: AiProvider = {
  ...PROVIDERS.deepseek,
  name: "Shadow(不可达端点)",
  baseUrl: "http://127.0.0.1:1/v1/chat/completions",
};

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};

function mark(pass: boolean): string {
  return pass ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
}

function headline(t: string): void {
  console.log(`\n${C.bold}${C.cyan}── ${t} ─────────────────────────${C.reset}`);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log(`${C.bold}AI Visibility 真实验证${C.reset}`);
  console.log(`${C.dim}brand=${BRAND}  topic=${TOPIC}${C.reset}`);
  console.log(`${C.dim}证据临时目录=${EVIDENCE_DIR}${C.reset}`);

  const keys: Partial<Record<string, string>> = {};
  for (const p of PROVIDER_LIST) {
    const v = process.env[p.envKey];
    if (v) keys[p.id] = v;
  }
  const configured = Object.keys(keys);

  console.log(
    `\n已配置密钥 ${C.bold}${configured.length}/${PROVIDER_LIST.length}${C.reset}` +
      (configured.length ? ` → ${configured.join(", ")}` : `  ${C.yellow}(全空：只能覆盖 UNOBSERVABLE)${C.reset}`)
  );

  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const allProbes: VisibilityProbe[] = [];

  /* ── 场景 1：真实 key 正常调用 ─────────────────────────────── */
  headline("场景 1 · 真实 key 正常调用");
  if (configured.length === 0) {
    console.log(`  ${C.yellow}跳过${C.reset} — 未检测到任何模型密钥`);
  } else {
    console.log(
      `  ${C.dim}${"provider".padEnd(10)}${"status".padEnd(14)}${"mention".padEnd(9)}${"conf".padEnd(12)}${"model".padEnd(30)}${"raw".padEnd(8)}ev${C.reset}`
    );
    for (const p of PROVIDER_LIST) {
      const key = keys[p.id];
      if (!key) continue;
      const probe = await probeProvider(p, BRAND, TOPIC, key);
      allProbes.push(probe);
      console.log(
        `  ${p.name.padEnd(10)}${colorStatus(probe.status).padEnd(23)}${String(probe.mentioned).padEnd(9)}` +
          `${probe.confidence.padEnd(12)}${(probe.servedModel ?? probe.requestedModel).padEnd(30)}` +
          `${String(probe.rawResponse?.length ?? 0).padEnd(8)}${probe.evidenceId ? "yes" : "no"}`
      );
      if (probe.elapsedMs) process.stdout.write("");
    }
  }

  /* ── 场景 2：损坏 key → 应为 BLOCKED ───────────────────────── */
  headline("场景 2 · 损坏 key（确定性构造 BLOCKED）");
  const blockedResults: { name: string; status: string; note?: string }[] = [];
  if (configured.length === 0) {
    console.log(`  ${C.yellow}跳过${C.reset} — 需要至少一个真实 key 才能派生损坏版本`);
  } else {
    for (const p of PROVIDER_LIST) {
      const key = keys[p.id];
      if (!key) continue;
      const probe = await probeProvider(p, BRAND, TOPIC, corruptKey(key));
      allProbes.push(probe);
      blockedResults.push({ name: p.name, status: probe.status, note: probe.note });
      console.log(
        `  ${p.name.padEnd(10)}${colorStatus(probe.status).padEnd(23)}${C.dim}${probe.note ?? ""}${C.reset}`
      );
    }
    const ok = blockedResults.every((r) => r.status === "BLOCKED");
    checks.push({
      name: "BLOCKED 分支",
      pass: ok,
      detail: ok
        ? `${blockedResults.length} 个探针在无效 key 下全部返回 BLOCKED`
        : `期望 BLOCKED，实际：${
            blockedResults.filter((r) => r.status !== "BLOCKED").map((r) => `${r.name}=${r.status}`).join(", ") || "-"
          }`,
    });
  }

  /* ── 场景 3：不可达端点 → 应为 ERROR ───────────────────────── */
  headline("场景 3 · 不可达端点（确定性构造 ERROR）");
  const shadow = await probeProvider(SHADOW_PROVIDER, BRAND, TOPIC, "shadow-key-not-real");
  console.log(`  ${SHADOW_PROVIDER.name.padEnd(22)}${colorStatus(shadow.status).padEnd(23)}${C.dim}${shadow.note ?? ""}${C.reset}`);
  checks.push({
    name: "ERROR 分支",
    pass: shadow.status === "ERROR",
    detail: `期望 ERROR，实际 ${shadow.status}${shadow.note ? `（${shadow.note}）` : ""}`,
  });

  /* ── 场景 4：无 key → UNOBSERVABLE ─────────────────────────── */
  headline("场景 4 · 无 key（UNOBSERVABLE）");
  const noKey = await probeProvider(PROVIDERS.deepseek, BRAND, TOPIC);
  console.log(`  ${PROVIDERS.deepseek.name.padEnd(10)}${colorStatus(noKey.status).padEnd(23)}${C.dim}reason=${noKey.unobservableReason}${C.reset}`);
  checks.push({
    name: "UNOBSERVABLE 分支",
    pass: noKey.status === "UNOBSERVABLE" && noKey.unobservableReason === "missing_api_key",
    detail: `status=${noKey.status} reason=${noKey.unobservableReason}`,
  });

  /* ── 报告层：score / 计数 / sampling ───────────────────────── */
  headline("报告层 · score 与四个计数");

  // 把三条离线分支也纳入样本 —— 否则聚合口径只能在空集上空转，
  // 「failedCount=BLOCKED+ERROR」会退化成毫无意义的 0 === 0。
  allProbes.push(shadow, noKey);

  const report = buildVisibilityReport(BRAND, TOPIC, allProbes);
  const r: Record<string, unknown> = report as unknown as Record<string, unknown>;
  const observed = Number(r.observedCount ?? 0);
  const failed = Number(r.failedCount ?? 0);
  const unobservable = Number(r.unobservableCount ?? 0);
  const mentioned = Number(r.mentionedCount ?? 0);
  const score = Number(r.visibilityScore ?? -1);

  const expectScore = observed === 0 ? 0 : Math.round((mentioned / observed) * 1000) / 10;
  const scoreOk = Math.abs(score - expectScore) < 0.05;

  console.log(`  visibilityScore   ${C.bold}${score}${C.reset}   ${C.dim}(mentionedCount/observedCount = ${mentioned}/${observed})${C.reset}`);
  console.log(`  observedCount     ${observed}`);
  console.log(`  failedCount       ${failed}   ${C.dim}(BLOCKED+ERROR)${C.reset}`);
  console.log(`  unobservableCount ${unobservable}`);
  console.log(`  mentionedCount    ${mentioned}`);

  checks.push({ name: "score 分母=observedCount", pass: scoreOk, detail: `score=${score} 期望=${expectScore}` });
  checks.push({
    name: "分母为 0 不产生 NaN",
    pass: Number.isFinite(score),
    detail: Number.isFinite(score) ? "score 是有限数" : `score=${score}`,
  });
  checks.push({
    name: "failedCount=BLOCKED+ERROR",
    pass: failed === allProbes.filter((p) => p.status === "BLOCKED" || p.status === "ERROR").length,
    detail: `failedCount=${failed}`,
  });

  const paramsOk = allProbes
    .filter((p) => p.confidence !== "unavailable")
    .every((p) => p.requestParams.temperature === SAMPLING_PROFILE.temperature);
  checks.push({
    name: "sampling 统一（temperature）",
    pass: paramsOk,
    detail: `SAMPLING_PROFILE.temperature=${SAMPLING_PROFILE.temperature}, parserVersion=${AI_VISIBILITY_PARSER_VERSION}`,
  });

  /* ── provenance：原始响应 + 脱敏 ──────────────────────────── */
  headline("provenance · 原始响应留存与脱敏");
  const observedProbes = allProbes.filter((p) => p.status === "MENTIONED" || p.status === "NOT_MENTIONED");
  const rawOk = observedProbes.length === 0 || observedProbes.every((p) => (p.rawResponse?.length ?? 0) > 0);
  checks.push({
    name: "rawResponse 全文留存",
    pass: rawOk,
    detail: observedProbes.length
      ? `${observedProbes.length} 个已观测探针，rawResponse 长度 ${observedProbes.map((p) => p.rawResponse!.length).join("/")}`
      : "无已观测探针（无 key），未验证",
  });

  const evFiles = collectEvidence();
  checks.push({
    name: "Evidence 落盘",
    pass: evFiles.total > 0,
    detail: evFiles.total ? `${evFiles.files.length} 个文件，${evFiles.total} 条记录` : "未产生任何证据文件",
  });

  const leak = evFiles.leakOf(keys);
  checks.push({
    name: "密钥未泄漏进 Evidence",
    pass: leak === null,
    detail: leak ?? `已检查 ${evFiles.files.length} 个文件，未发现任何活密钥子串`,
  });

  /* ── 场景 5：纯函数聚合口径（离线、确定性） ────────────── */
  headline("场景 5 · 聚合口径（合成探针，无需网络）");
  {
    const mixed = [
      synthProbe("MENTIONED", true), synthProbe("MENTIONED", true),
      synthProbe("NOT_MENTIONED", false),
      synthProbe("BLOCKED", false), synthProbe("ERROR", false),
      synthProbe("UNOBSERVABLE", false), synthProbe("UNOBSERVABLE", false),
    ];
    const rp = buildVisibilityReport(BRAND, TOPIC, mixed) as unknown as Record<string, unknown>;
    console.log(
      `  7 探针 = 2 MENTIONED + 1 NOT_MENTIONED + 1 BLOCKED + 1 ERROR + 2 UNOBSERVABLE`
    );
    console.log(
      `  → score=${rp.visibilityScore} observed=${rp.observedCount} failed=${rp.failedCount}` +
        ` unobservable=${rp.unobservableCount} configured=${rp.configuredCount}`
    );

    const want = {
      visibilityScore: 67, // round(2 / 3 * 100)
      observedCount: 3,
      mentionedCount: 2,
      failedCount: 2,
      unobservableCount: 2,
      configuredCount: 5,
    };
    const bad = (Object.keys(want) as (keyof typeof want)[]).filter(
      (k) => Number(rp[k]) !== want[k]
    );
    checks.push({
      name: "聚合口径（混合样本）",
      pass: bad.length === 0,
      detail: bad.length ? `不符：${bad.map((k) => `${k}=${rp[k]}≠${want[k]}`).join(", ")}` : "六项计数与 score 全部符合预期",
    });

    // 边界：一个都没观测到时，分母为 0 必须给出 0 而不是 NaN
    const none = buildVisibilityReport(BRAND, TOPIC, [
      synthProbe("UNOBSERVABLE", false), synthProbe("BLOCKED", false),
    ]) as unknown as Record<string, unknown>;
    const noneOk = Number(rp.visibilityScore) >= 0 && Number(none.visibilityScore) === 0 && Number.isFinite(Number(none.visibilityScore));
    checks.push({
      name: "零观测样本不产生 NaN",
      pass: noneOk,
      detail: `全未观测时 score=${none.visibilityScore}`,
    });
  }

  /* ── 场景 6：本地 mock 端点（确定性覆盖剩余三态） ──────── */
  headline("场景 6 · 本地 mock 端点（确定性覆盖剩余三态）");
  {
    const server = await startMockServer(BRAND);
    const port = (server.address() as { port: number }).port;
    const mk = (label: string, path: string): AiProvider => ({
      ...PROVIDERS.deepseek,
      name: `Mock-${label}`,
      baseUrl: `http://127.0.0.1:${port}${path}`,
    });

    const [m, nm, b] = await Promise.all([
      probeProvider(mk("提及", "/mentioned"), BRAND, TOPIC, "mock-key"),
      probeProvider(mk("未提及", "/not-mentioned"), BRAND, TOPIC, "mock-key"),
      probeProvider(mk("拒绝", "/blocked"), BRAND, TOPIC, "mock-key"),
    ]);

    for (const p of [m, nm, b]) {
      console.log(
        `  ${p.providerName.padEnd(18)}${colorStatus(p.status).padEnd(23)}` +
          `${C.dim}raw=${p.rawResponse?.length ?? 0} conf=${p.confidence} served=${p.servedModel ?? "-"}${C.reset}`
      );
    }

    checks.push({ name: "MENTIONED 分支", pass: m.status === "MENTIONED", detail: `实际 ${m.status}` });
    checks.push({ name: "NOT_MENTIONED 分支", pass: nm.status === "NOT_MENTIONED", detail: `实际 ${nm.status}` });
    checks.push({ name: "BLOCKED 分支（mock 401）", pass: b.status === "BLOCKED", detail: `实际 ${b.status}` });

    const mockFull = MOCK_TEXT_MENTIONED(BRAND);
    const rawOk = m.rawResponse === mockFull;
    checks.push({
      name: "rawResponse 全文留存（未截断）",
      pass: rawOk,
      detail: rawOk
        ? `${mockFull.length} 字符与 mock 返回完全一致`
        : `期望 ${mockFull.length} 字符，实际 ${m.rawResponse?.length ?? 0}`,
    });
    checks.push({
      name: "citedDomains 提取",
      pass: m.citedDomains.length > 0,
      detail: m.citedDomains.length ? `提取到 ${m.citedDomains.join(", ")}` : "未提取到任何域名",
    });
    checks.push({
      name: "servedModel 回填",
      pass: Boolean(m.servedModel),
      detail: `servedModel=${m.servedModel ?? "null"}（应来自响应体而非请求值）`,
    });

    allProbes.push(m, nm, b);
    await new Promise<void>((r) => server.close(() => r()));
  }

  if (configured.length === 0) {
    checks.push({
      name: "真实厂商调用",
      pass: false,
      detail: "本机未配置任何模型密钥，真实网络路径未验证",
    });
  }

  /* ── 五态覆盖矩阵 ─────────────────────────────────────────── */
  headline("五态覆盖");
  const seen = new Set<string>([...allProbes.map((p) => p.status), noKey.status, shadow.status]);
  for (const s of ["MENTIONED", "NOT_MENTIONED", "BLOCKED", "ERROR", "UNOBSERVABLE"]) {
    const has = seen.has(s);
    console.log(`  ${has ? C.green + "已覆盖" : C.dim + "未覆盖"}${C.reset}  ${s}`);
  }

  /* ── 汇总 ─────────────────────────────────────────────────── */
  headline("结论");
  let failedChecks = 0;
  for (const c of checks) {
    if (!c.pass) failedChecks++;
    console.log(`  ${mark(c.pass)}  ${c.name.padEnd(26)}${C.dim}${c.detail}${C.reset}`);
  }
  console.log(
    `\n  五态覆盖 ${seen.size}/5 ｜ 检查项 ${checks.length - failedChecks}/${checks.length} 通过` +
      ` ｜ 证据 ${evFiles.total} 条\n`
  );

  // 清理临时证据目录
  try {
    rmSync(EVIDENCE_DIR, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响结论 */
  }

  if (failedChecks > 0) process.exitCode = 1;
}

function colorStatus(s: string): string {
  const map: Record<string, string> = {
    MENTIONED: C.green, NOT_MENTIONED: C.yellow,
    BLOCKED: C.yellow, ERROR: C.red, UNOBSERVABLE: C.dim,
  };
  return `${map[s] ?? ""}${s}${C.reset}`;
}

/**
 * 构造一个指定状态的探针，用于离线验证聚合口径。
 * 不发起任何网络请求 —— 纯粹用合成数据断言纯函数的行为。
 */
function synthProbe(status: VisibilityProbe["status"], mentioned: boolean): VisibilityProbe {
  const observed = status === "MENTIONED" || status === "NOT_MENTIONED";
  return {
    provider: "deepseek",
    providerName: `synth-${status}`,
    vendor: "合成",
    status,
    mentioned,
    excerpt: observed ? "合成片段" : null,
    rawResponse: observed ? "这是一段合成的回答，用于离线验证聚合口径。" : null,
    citedDomains: [],
    requestedModel: "synth-model",
    servedModel: observed ? "synth-model-001" : null,
    requestParams: { ...SAMPLING_PROFILE },
    promptVersion: "1.0.0",
    promptHash: "synthhash",
    parserVersion: AI_VISIBILITY_PARSER_VERSION,
    confidence: observed ? "medium" : "unavailable",
    evidenceId: null,
    elapsedMs: 0,
  };
}

/**
 * 本地 mock 端点。**五态里最难自然触发的三种，靠它做到 100% 确定性。**
 *
 * 用意不是替代真实调用，而是让「状态机本身」成为可回归的东西：
 * 无论外部厂商怎么变，这三条分支的正确性都能在 CI 里被验证。
 */
const MOCK_TEXT_MENTIONED = (brand: string) =>
  `在跨境电商收款场景中，${brand} 是一类值得关注的服务商，提供多币种结算与合规通道。` +
  `更多细节可参考 https://whivi.com/guide 上的说明。`;

const MOCK_TEXT_NOT_MENTIONED = () =>
  `该领域常见的服务商包括若干持牌支付机构，建议结合费率、到账时效与合规资质综合评估。`;

function startMockServer(brand: string): Promise<Server> {
  const server = createServer((req, res) => {
    const url = req.url ?? "";

    // 401 —— 确定命中 BLOCKED_STATUSES，与真实「key 失效」完全同构
    if (url.startsWith("/blocked")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid api key" } }));
      return;
    }

    const content = url.startsWith("/not-mentioned")
      ? MOCK_TEXT_NOT_MENTIONED()
      : MOCK_TEXT_MENTIONED(brand);

    res.writeHead(200, { "content-type": "application/json" });
    // 与 OpenAI 兼容格式一致：choices[0].message.content + model
    res.end(JSON.stringify({ choices: [{ message: { content } }], model: "mock-model-001" }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** 收集落盘证据，并检查是否有密钥泄漏 */
function collectEvidence() {
  let files: string[] = [];
  try {
    files = readdirSync(EVIDENCE_DIR, { recursive: true }) as unknown as string[];
  } catch {
    return { files: [], total: 0, leakOf: (): string | null => "无法读取证据目录" };
  }
  let total = 0;
  const blobs: string[] = [];
  for (const f of files) {
    const full = join(EVIDENCE_DIR, f);
    try {
      const txt = readFileSync(full, "utf8");
      blobs.push(txt);
      if (f.endsWith(".jsonl")) total += txt.split("\n").filter(Boolean).length;
    } catch {
      /* 目录项跳过 */
    }
  }
  const combined = blobs.join("\n");
  return {
    files,
    total,
    /** 检查是否有任何活密钥子串出现在证据里 —— 这是脱敏是否有效的硬证明 */
    leakOf(keys: Partial<Record<string, string>>): string | null {
      for (const [, v] of Object.entries(keys)) {
        if (!v || v.length < 8) continue;
        // 取密钥中段（去掉常见前缀），避免误判
        const probe = v.slice(Math.floor(v.length / 3), Math.floor(v.length / 3) + 16);
        if (combined.includes(probe)) return `证据中出现了密钥片段 ${probe.slice(0, 4)}…`;
      }
      return null;
    },
  };
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
