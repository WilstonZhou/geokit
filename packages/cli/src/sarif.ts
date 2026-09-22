/**
 * SARIF 2.1.0 输出（Phase 2 · S2-3）。
 *
 * ### 为什么 URI 是远端 URL 而不是仓库文件
 *
 * GitHub Code Scanning 是为「静态扫描源码」设计的：SARIF 的
 * `physicalLocation.region` 期望的是行号列号，GitHub 用它把结果标在 diff 的某一行上。
 *
 * 但 GEOkit 检查的是**运行中的远程页面**，不是仓库里的文件 ——
 * 我们没有行号，也没有办法在不改造 HTML parser 的前提下可靠地给出行号。
 *
 * 于是这里的选择是：
 *
 * ```text
 * artifactLocation.uri = targetUrl        ← 真实的审计对象
 * region               = 省略              ← 没有行号就不写，不编造
 * ```
 *
 * ★ **不为了让 GitHub 界面看起来像「代码扫描」就去改 HTML parser 追行号。**
 *   那会把一个只读符合法 SARIF 的问题，变成一个改动 parser 语义的大工程，
 *   换来的是把结果标在一个根本不在仓库里的文件上 —— 收益为零，风险不小。
 *
 * SARIF 规范允许 result 不带 region、也允许不带 location，
 * 所以「省略」是合法表达，不是降级方案。
 */
import type { Diagnosis, Severity } from "../../../src/lib/diagnosis/types";
import type { CheckReport } from "./check";
import type { GateReport } from "./gate";

export const SARIF_VERSION = "2.1.0" as const;

export const SARIF_SCHEMA =
  "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json" as const;

export const TOOL_NAME = "geokit" as const;

export const TOOL_INFORMATION_URI = "https://github.com/WilstonZhou/geokit" as const;

/** SARIF 四档 + GEOkit 用的子集 */
export type SarifLevel = "error" | "warning" | "note" | "none";

/**
 * 严重度 → SARIF level。
 *
 * blocker / major 都映射 error：GitHub 只会区分 error（红）/ warning（黄），
 * 三档压成两档是必要的信息损失，换来的是 PR 上能一眼看出「该拦」。
 * 细档仍留在 `properties.severity` 里，不丢事实。
 */
export function levelForSeverity(severity: Severity): SarifLevel {
  switch (severity) {
    case "blocker":
    case "major":
      return "error";
    case "minor":
      return "warning";
    default:
      return "warning";
  }
}

/** 一条待落成 SARIF result 的问题 */
export interface SarifIssue {
  ruleId: string;
  level: SarifLevel;
  /** result.message.text */
  message: string;
  /** 审计对象 URL；**缺省则整条 result 不带 location**（SARIF 允许） */
  uri?: string;
  /** 规则的简短说明；缺则用 ruleId */
  ruleDescription?: string;
  /** 规则的完整说明/help；缺则用 ruleDescription */
  ruleHelp?: string;
  /** 附加到 result.properties 的事实（不丢信息用） */
  properties?: Record<string, string>;
}

export interface SarifRun {
  tool: {
    driver: {
      name: string;
      version?: string;
      informationUri: string;
      rules: SarifRule[];
    };
  };
  results: SarifResult[];
}

export interface SarifRule {
  id: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  defaultConfiguration: { level: SarifLevel };
  help: { text: string };
}

export interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: SarifLevel;
  message: { text: string };
  properties?: Record<string, string>;
  locations?: {
    physicalLocation: {
      artifactLocation: { uri: string };
    };
  }[];
}

export interface SarifLog {
  version: "2.1.0";
  $schema: string;
  runs: SarifRun[];
}

/**
 * 组装 SARIF log —— 纯函数。
 *
 * 规则去重：同一 issueId 只产生一条 rule，多条 result 通过 ruleIndex 指向它。
 * 顺序稳定（按首次出现顺序），CI 反复触发产出的字节一致。
 */
export function buildSarif(issues: SarifIssue[], toolVersion?: string): SarifLog {
  const rules: SarifRule[] = [];
  const indexOfRule = new Map<string, number>();
  const results: SarifResult[] = [];

  for (const issue of issues) {
    let ruleIndex = indexOfRule.get(issue.ruleId);
    if (ruleIndex === undefined) {
      ruleIndex = rules.length;
      indexOfRule.set(issue.ruleId, ruleIndex);
      const short = issue.ruleDescription ?? issue.ruleId;
      const full = issue.ruleHelp ?? short;
      rules.push({
        id: issue.ruleId,
        shortDescription: { text: short },
        fullDescription: {
          text: `${full}（${issue.level === "error" ? "阻断级" : issue.level === "warning" ? "提示级" : "说明级"}）`,
        },
        defaultConfiguration: { level: issue.level },
        help: { text: full },
      });
    }

    results.push({
      ruleId: issue.ruleId,
      ruleIndex,
      level: issue.level,
      message: { text: issue.message },
      ...(issue.properties ? { properties: issue.properties } : {}),
      // ★ 没有 uri 就不带 locations —— 不伪造文件路径、不补 region
      ...(issue.uri
        ? {
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: issue.uri },
                },
              },
            ],
          }
        : {}),
    });
  }

  return {
    version: SARIF_VERSION,
    $schema: SARIF_SCHEMA,
    runs: [
      {
        tool: {
          driver: {
            name: TOOL_NAME,
            ...(toolVersion ? { version: toolVersion } : {}),
            informationUri: TOOL_INFORMATION_URI,
            rules,
          },
        },
        results,
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Diagnosis / Gate → SARIF                                            */
/* ------------------------------------------------------------------ */

/**
 * Diagnosis[] → SARIF。
 *
 * `targetUrl` 原样进 `artifactLocation.uri`：审计对象就是它，
 * 不改写成本地路径、不加前缀。
 */
export function sarifFromDiagnoses(
  diagnoses: Diagnosis[],
  opts: { toolVersion?: string } = {}
): SarifLog {
  const issues: SarifIssue[] = diagnoses.map((d) => ({
    ruleId: d.issueId,
    level: levelForSeverity(d.severity),
    message: d.manualFix ? `${d.detail}（建议：${d.manualFix}）` : d.detail,
    uri: d.targetUrl,
    ruleDescription: d.checkId,
    ruleHelp: d.manualFix ?? d.suggestedFix ?? d.detail,
    properties: { severity: d.severity, checkId: d.checkId },
  }));
  return buildSarif(issues, opts.toolVersion);
}

/** check 报告 → SARIF。URI 取最终地址（重定向后才是最真实的审计对象） */
export function sarifFromCheckReport(report: CheckReport): SarifLog {
  return sarifFromDiagnoses(report.diagnoses);
}

export const GATE_RULE_ID = "gate/regression" as const;

/**
 * gate 报告 → SARIF。
 *
 * 判定逻辑一行都没重写 —— 这里只把 S2-2 已经算出的 `reasons` 转成 result：
 *
 *   fail           → error（每条判定依据一条）
 *   pass 但没基线   → note（明说「未做退化判定」，不静默放行）
 *   pass 且已判定   → 零 result（没问题就不该出现在扫描结果里）
 *
 * `uri` 缺省时 result 不带 location：gate 比对的是两份快照，
 * 未必要知道 URL，而**编造一个 uri 是本项目最反对的那种行为**。
 */
export function sarifFromGateReport(report: GateReport, opts: { url?: string } = {}): SarifLog {
  const informative = report.reasons.filter(
    (r) => r !== "未触发任何门禁条件" && r !== "未触发门禁条件"
  );

  if (report.decision === "fail") {
    return buildSarif(
      informative.map((reason) => ({
        ruleId: GATE_RULE_ID,
        level: "error" as SarifLevel,
        message: reason,
        ...(opts.url ? { uri: opts.url } : {}),
        ruleDescription: "GEOkit 门禁：相对基线的退化判定",
        ruleHelp:
          "门禁拦的是「变差了」而不是「不够好」：相对基线下降超过阈值、新增 blocker/major、或 GEO 低于绝对下限。",
        properties: { decision: "fail", baselineFound: String(report.baseline.found) },
      }))
    );
  }

  const unresolved = informative.filter((r) => r.includes("未做退化判定"));
  if (unresolved.length === 0) return buildSarif([]);

  return buildSarif(
    unresolved.map((reason) => ({
      ruleId: GATE_RULE_ID,
      level: "note" as SarifLevel,
      message: reason,
      ...(opts.url ? { uri: opts.url } : {}),
      ruleDescription: "GEOkit 门禁：相对基线的退化判定",
      ruleHelp: "没有基线也不可比 ⇒ 未做判定。这不是通过。",
      properties: { decision: "pass", baselineFound: String(report.baseline.found) },
    }))
  );
}
