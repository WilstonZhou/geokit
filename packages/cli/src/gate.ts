/**
 * `geokit gate`（Phase 2 · S2-2）。
 *
 * 判定哲学（roadmap §十三）：**「变差了」比「不够好」更值得拦。**
 *
 *   ❌ GEO < 70 → fail
 *      一个 62 分的老页面和一个从 75 掉到 62 的页面，严重性完全不同，
 *      绝对阈值却给它们同样的判定 —— 结果是把「还没优化」当成「退化」，
 *      开发者很快就会学会忽略这个门禁。
 *
 *   ✅ 相对基线下降 > 阈值 → fail
 *      + 新增 blocker → fail
 *      + 绝对下限兜底（GEO < 40，无条件 fail）
 *
 * ### 基线从哪来
 *
 * CI 的 runner 每次都是全新的，Store 目录是空的 —— 所以
 * **基线文件（`--base=<baseline.json>`）是 CI 的默认方案**：
 * 上一次 `geokit check --format=json` 的产物直接当基线，用 artifact 传下去。
 *
 * 本地有 Store 历史时可以用 `--subject/--type` 走 S6 的 diffLatest，
 * 但**绝不依赖它** —— 没历史时必须明说「未判定」，而不是静默放行。
 */
import { readFileSync } from "node:fs";

import { diffLatest } from "../../../src/lib/diff";
import { createStore, storeRoot } from "../../../src/lib/store";
import type { SeverityCounts } from "./check";

/** 默认阈值。取值来自 roadmap §十三 的配置示例 */
export const DEFAULT_GATE = {
  /** 分数相对下降超过这么多就拦 */
  maxDrop: 5,
  /** GEO 绝对下限：低于它无条件 fail（这条不看基线） */
  geoMin: 40,
  maxNewBlocker: 0,
  maxNewMajor: 2,
} as const;

export type GateThresholds = typeof DEFAULT_GATE;

export interface GateDeltas {
  seoScore: number | null;
  geoScore: number | null;
  newBlocker: number;
  newMajor: number;
}

export interface GateReport {
  decision: "pass" | "fail";
  exitCode: number;
  baseline: { source: string; found: boolean };
  deltas?: GateDeltas;
  reasons: string[];
}

/** 一份可比较的快照 —— 就是 check 报告里那部分稳定的字段 */
export interface GateSnapshot {
  seoScore: number | null;
  geoScore: number | null;
  counts: SeverityCounts;
  issueIds: string[];
  /** 保留每条的严重度：同一 issueId 在不同页面可能落在不同档 */
  diagnoses: { issueId: string; severity: string }[];
}

export function snapshotOf(report: {
  seoScore?: number | null;
  geoScore?: number | null;
  counts?: SeverityCounts;
  diagnoses?: { issueId: string; severity?: string }[];
}): GateSnapshot {
  const diagnoses = (report.diagnoses ?? []).map((d) => ({
    issueId: d.issueId,
    severity: d.severity ?? "minor",
  }));
  return {
    seoScore: report.seoScore ?? null,
    geoScore: report.geoScore ?? null,
    counts: report.counts ?? { blocker: 0, major: 0, minor: 0 },
    issueIds: diagnoses.map((d) => d.issueId),
    diagnoses,
  };
}

/** 比较两个快照 —— 纯函数，CI 反复触发结果一致 */
export function evaluateGate(
  current: GateSnapshot,
  base: GateSnapshot | null,
  thresholds: GateThresholds = DEFAULT_GATE
): GateReport {
  const reasons: string[] = [];

  // 绝对下限：不看基线，自己就是一条线
  if (current.geoScore !== null && current.geoScore < thresholds.geoMin) {
    reasons.push(`GEO ${current.geoScore} 低于绝对下限 ${thresholds.geoMin}`);
  }

  if (!base) {
    return {
      decision: reasons.length > 0 ? "fail" : "pass",
      exitCode: reasons.length > 0 ? 1 : 0,
      baseline: { source: "none", found: false },
      reasons:
        reasons.length > 0
          ? reasons
          : ["未提供基线（--base）且本地无 Store 历史 ⇒ 未做退化判定，不静默放行"],
    };
  }

  const baseIds = new Set(base.issueIds);
  const newIssues = current.issueIds.filter((i) => !baseIds.has(i));
  const newBlocker = countSeverity(current, newIssues, "blocker");
  const newMajor = countSeverity(current, newIssues, "major");

  const seoDelta = deltaOf(current.seoScore, base.seoScore);
  const geoDelta = deltaOf(current.geoScore, base.geoScore);

  if (newBlocker > thresholds.maxNewBlocker) {
    reasons.push(`新增 ${newBlocker} 个 blocker（上限 ${thresholds.maxNewBlocker}）`);
  }
  if (newMajor > thresholds.maxNewMajor) {
    reasons.push(`新增 ${newMajor} 个 major（上限 ${thresholds.maxNewMajor}）`);
  }
  if (geoDelta !== null && geoDelta < 0 && Math.abs(geoDelta) > thresholds.maxDrop) {
    reasons.push(`GEO 下降 ${Math.abs(geoDelta)} 分（阈值 ${thresholds.maxDrop}）`);
  }
  if (seoDelta !== null && seoDelta < 0 && Math.abs(seoDelta) > thresholds.maxDrop) {
    reasons.push(`SEO 下降 ${Math.abs(seoDelta)} 分（阈值 ${thresholds.maxDrop}）`);
  }

  const fail = reasons.length > 0;
  return {
    decision: fail ? "fail" : "pass",
    exitCode: fail ? 1 : 0,
    baseline: { source: "file", found: true },
    deltas: { seoScore: seoDelta, geoScore: geoDelta, newBlocker, newMajor },
    reasons: fail ? reasons : ["未触发任何门禁条件"],
  };
}

function countSeverity(cur: GateSnapshot, issueIds: string[], sev: keyof SeverityCounts): number {
  const set = new Set(issueIds);
  let n = 0;
  for (const d of cur.diagnoses) if (set.has(d.issueId) && d.severity === sev) n += 1;
  return n;
}

function deltaOf(cur: number | null, base: number | null): number | null {
  if (cur === null || base === null) return null;
  return cur - base;
}

/* ------------------------------------------------------------------ */
/* 取数：基线文件 / Store                                               */
/* ------------------------------------------------------------------ */

export interface GateOptions {
  /** 基线文件路径（CI 默认方案） */
  base?: string;
  /** 本次结果文件路径；不给则配合 url 现跑 */
  report?: string;
  /** 无 base 时尝试从 Store 取：这两个参数齐备才走 Store */
  subject?: string;
  type?: string;
  source?: string;
  to?: string;
  /** Store 根目录 */
  dir?: string;
}

export async function runGate(
  currentSnapshot: GateSnapshot,
  opts: GateOptions,
  thresholds: GateThresholds = DEFAULT_GATE
): Promise<GateReport> {
  if (opts.base) {
    const raw = readFileSync(opts.base, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const base = snapshotOf(asSnapshotInput(parsed));
    const r = evaluateGate(currentSnapshot, base, thresholds);
    return { ...r, baseline: { source: `file:${opts.base}`, found: true } };
  }

  // 无基线文件 ⇒ 尝试 Store 历史（本地可用，CI 通常为空）
  if (opts.subject && opts.type) {
    const store = createStore(opts.dir ?? storeRoot());
    const diff = await diffLatest(store, {
      subject: opts.subject,
      type: opts.type,
      ...(opts.source ? { source: opts.source } : {}),
      ...(opts.to ? { to: opts.to } : {}),
    });
    if (!diff.currentId) {
      return {
        decision: "pass",
        exitCode: 0,
        baseline: { source: "store", found: false },
        reasons: ["Store 中无该 identity 的观测 ⇒ 未做退化判定，不静默放行"],
      };
    }

    const reasons: string[] = [];
    if (diff.comparable) {
      if (diff.summary.degraded > 0) {
        reasons.push(`最近一次观测有 ${diff.summary.degraded} 项退化`);
      }
    } else {
      reasons.push(
        `最近两条观测不可比（${diff.incomparableReason ?? "未说明"}）⇒ 不做方向判定`
      );
    }
    const fail = diff.comparable && diff.summary.degraded > 0;
    return {
      decision: fail ? "fail" : "pass",
      exitCode: fail ? 1 : 0,
      baseline: { source: "store", found: true },
      reasons: fail ? reasons : [...reasons, "未触发门禁条件"],
    };
  }

  return evaluateGate(currentSnapshot, null, thresholds);
}

/** 从 check 报告 json 里取出快照（容忍 diagnoses 缺失） */
function asSnapshotInput(parsed: unknown): {
  seoScore?: number | null;
  geoScore?: number | null;
  counts?: SeverityCounts;
  diagnoses?: { issueId: string; severity?: string }[];
} {
  if (!parsed || typeof parsed !== "object") return {};
  const o = parsed as Record<string, unknown>;
  return {
    seoScore: typeof o.seoScore === "number" ? o.seoScore : null,
    geoScore: typeof o.geoScore === "number" ? o.geoScore : null,
    counts: o.counts as SeverityCounts | undefined,
    diagnoses: Array.isArray(o.diagnoses)
      ? (o.diagnoses as { issueId: string; severity?: string }[])
      : undefined,
  };
}

/** 读一个 check 报告文件 → 快照 */
export function snapshotFromFile(path: string): GateSnapshot {
  return snapshotOf(asSnapshotInput(JSON.parse(readFileSync(path, "utf8")) as unknown));
}
