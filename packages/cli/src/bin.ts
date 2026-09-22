#!/usr/bin/env npx tsx
/**
 * `geokit` 命令入口（Phase 2 · S2-2）。
 *
 * 设计约束：**CI 不能依赖跑着的 Web 服务** —— 冷启动、确定性退出码、
 * 任意 runner 可执行。所以这里不 import 任何 Next 相关模块。
 *
 * 用法：
 *   geokit check <url> [--format=json|markdown] [--skip-protocol]
 *   geokit gate --base=<baseline.json> (--report=<check.json> | --url=<url>)
 *   geokit diff --subject=<s> --type=<t> [--source=] [--to=]
 *   geokit diff --prev=<a.json> --curr=<b.json>
 */
import { readFileSync, writeFileSync } from "node:fs";

import { checkHtml, checkUrl, type CheckReport } from "./check";
import { runDiff } from "./diff";
import { runGate, snapshotOf } from "./gate";
import { OUTPUT_FORMATS, parseFormat, renderCheck, renderDiff, renderGate, renderJson } from "./output";
import { sarifFromCheckReport } from "./sarif";

interface Args {
  command: string | null;
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let command: string | null = null;

  for (const a of argv) {
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const i = body.indexOf("=");
      if (i < 0) flags[body] = "true";
      else flags[body.slice(0, i)] = body.slice(i + 1);
    } else if (command === null) {
      command = a;
    } else {
      positional.push(a);
    }
  }
  return { command, positional, flags };
}

/**
 * 输出落点。
 *
 * CI 里必须能把 SARIF 单独写成文件（Code Scanning 要的是 `sarif_file: <path>`），
 * 所以给所有命令加 `--out=<path>`：给了就写文件，不给走 stdout。
 */
function emit(text: string, out: string | undefined): void {
  if (out) {
    writeFileSync(out, text);
    process.stderr.write(`已写入 ${out}\n`);
    return;
  }
  process.stdout.write(text);
}

/** 读一份 check 产物 json（SARIF 转换与 gate 都靠它，避免 CI 重复抓取） */
function readCheckReport(path: string): CheckReport {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (!Array.isArray(parsed.diagnoses)) {
    throw new Error(`不是 check 产物（缺少 diagnoses 数组）：${path}`);
  }
  return parsed as unknown as CheckReport;
}

/** check 产物里记录的 URL（给 gate 的 SARIF 当定位用；没有就不给） */
function urlOf(report: CheckReport): string {
  return report.finalUrl ?? report.url;
}

const USAGE = `geokit — 鲸析 GEOkit 命令行

  所有命令均支持 --format=${OUTPUT_FORMATS.join("|")} [--out=<path>]

  geokit check <url> [--html-file=<path>] [--status=200] [--skip-protocol]
      页面检查：audit + robots + llms.txt → Diagnosis
      退出码：有 blocker / major ⇒ 1，否则 0
      --html-file 走离线模式，不联网（测试与 fixture 复现用）

  geokit gate --base=<baseline.json> (--report=<check.json> | --url=<url>) [--format=json|markdown]
      门禁判定：相对基线下降 > 5 + 新增 blocker + GEO 绝对下限 40
      退出码：fail ⇒ 1，否则 0
      不跑 Search / AI Observer —— CI 里跑它们等于主动撞风控

  geokit sarif --report=<check.json> [--out=geokit.sarif]
      把已有 check 产物转成 SARIF 2.1.0 —— 离线转换，不重复抓取
      定位规则：artifactLocation.uri = targetUrl，无 region（没有行号就不写）

  geokit diff --subject=<s> --type=<t> [--source=] [--to=] [--dir=]
  geokit diff --prev=<a.json> --curr=<b.json>
      观测差异：判定逻辑全在 S6 diff 引擎，CLI 只取数与渲染
      文件模式给 CI 用（runner 上没有 Store）；Store 模式本地用
`;

async function main(): Promise<number> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  if (!command || command === "help" || command === "--help" || command === "-h" || flags.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const format = parseFormat(flags.format);

  switch (command) {
    case "check": {
      const url = positional[0];
      if (!url) {
        process.stderr.write("缺少 URL：geokit check <url>\n");
        return 2;
      }
      let report: CheckReport;
      if (flags["html-file"]) {
        // 离线模式：直接分析本地 HTML，不联网（测试与 fixture 复现用）
        const html = readFileSync(flags["html-file"], "utf8");
        report = checkHtml(html, url, Number(flags.status ?? 200));
      } else {
        report = await checkUrl(url, {
          skipProtocolChecks: flags["skip-protocol"] === "true",
        });
      }
      emit(renderCheck(report, format), flags.out);
      return report.exitCode;
    }

    case "gate": {
      let snapshot;
      let url: string | undefined;
      if (flags.report) {
        // 报告自带 URL —— SARIF 定位要用；没有就不写 location，不编造
        const rep = readCheckReport(flags.report);
        snapshot = snapshotOf(rep);
        url = urlOf(rep);
      } else if (flags.url) {
        // 现跑一次 check（联网）。CI 里更推荐先 check --format=json 存产物
        url = flags.url;
        snapshot = snapshotOf(await checkUrl(flags.url));
      } else {
        process.stderr.write("gate 需要 --report=<check.json> 或 --url=<url>\n");
        return 2;
      }

      const report = await runGate(snapshot, {
        base: flags.base,
        subject: flags.subject,
        type: flags.type,
        source: flags.source,
        to: flags.to,
        dir: flags.dir,
      });
      emit(renderGate(report, format, { url }), flags.out);
      return report.exitCode;
    }

    case "sarif": {
      if (!flags.report) {
        process.stderr.write("sarif 需要 --report=<check.json>（先用 geokit check --format=json 产出）\n");
        return 2;
      }
      // 离线转换：不联网、不重跑 check —— CI 里页面只抓一次
      emit(renderJson(sarifFromCheckReport(readCheckReport(flags.report))), flags.out);
      return 0;
    }

    case "diff": {
      const report = await runDiff({
        subject: flags.subject,
        type: flags.type,
        source: flags.source,
        to: flags.to,
        prev: flags.prev,
        curr: flags.curr,
        dir: flags.dir,
      });
      emit(renderDiff(report, format), flags.out);
      if (report.exitCode !== 0) {
        process.stderr.write("没有可比较的观测（Store 中无记录），退出码 1\n");
      }
      return report.exitCode;
    }

    default:
      process.stderr.write(`未知命令 "${command}"\n\n${USAGE}`);
      return 2;
  }
}

void main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`geokit 执行失败：${msg}\n`);
    process.exitCode = 2;
  }
);
