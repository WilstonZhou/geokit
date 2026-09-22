/**
 * Diff 引擎 —— Phase 1 S6。
 *
 * ─────────────────────────────────────────────────────────────
 * 它不是 JSON diff
 * ─────────────────────────────────────────────────────────────
 * 本模块回答的是三件事，按这个顺序：
 *
 *   ① 这两条结论能不能比（comparable）
 *   ② 能比的话变了什么（changes）
 *   ③ 这个变化算变好还是变坏（direction）
 *
 * 顺序不能颠倒。**先判可比性，再算变化** ——
 * 跳过第一步去比数值，会把「口径变了」「观测能力恢复了」
 * 一律记成「站点表现上升/下降」。
 *
 * ─────────────────────────────────────────────────────────────
 * ★ 本项目最重要的一条约束
 * ─────────────────────────────────────────────────────────────
 *   UNOBSERVABLE → NOT_MENTIONED 必须判定为 unknown，**不是下降**。
 *
 * 从「没观测到」到「观测到了但没有提及」，语义是**覆盖度提升**，
 * 不是表现变差。把它算成下降，会让「补齐了一把 API key」这种动作
 * 在报表上显示为一次暴跌 —— 这是会直接误导决策的错误。
 *
 * 推广成通则：**只要有一侧不是可判定结论，就一律 unknown**，
 * 绝不写 improved / degraded。
 *
 * ─────────────────────────────────────────────────────────────
 * 契约层保护
 * ─────────────────────────────────────────────────────────────
 *   S1 contract（types.ts）        未改，本模块只读取 Observation
 *   replaces 语义                   未参与 —— diff 只读历史，不改历史
 *   analyze() / Observer 代码       未触碰
 *
 * diff 是**读取侧的纯函数**：输入两条 Observation，输出一份判断。
 * 它不落盘、不回写、不因为「看着像退步」去修改任何历史记录。
 */
import type { Store } from "./store";
import type { Observation, ObservationKind, ObservationStatus } from "./evidence/types";

/** 本引擎的版本。改可比性规则或方向判定表必须递增 */
export const DIFF_ENGINE_VERSION = "diff-engine@0.1.0";

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export type DiffChangeKind =
  | "VALUE" // 数值变化（score / rank）
  | "STATUS" // 状态变化（含可观测性变化）
  | "ADDED" // 集合新增（新出现的引用域名、新上榜的结果）
  | "REMOVED" // 集合移除
  | "COVERAGE" // 覆盖度变化
  | "VERSION" // parser / observer / strategy 版本变化
  | "EVIDENCE"; // 底层证据变化

export type DiffDirection = "improved" | "degraded" | "neutral" | "unknown";

export interface DiffChange {
  kind: DiffChangeKind;
  /** 结果内的路径，如 "result.seoScore"；集合/整条级变化写 "result" 或 "status" */
  path: string;
  previous: unknown;
  current: unknown;
  direction: DiffDirection;
  /** 数值型变化附带的差值（current - previous） */
  delta?: number;
  /** 方向无法判定时的说明 */
  note?: string;
}

export type IncomparableReason =
  | "missing_previous"
  | "status_not_observed"
  | "parser_version_changed"
  | "observer_version_changed"
  | "prompt_version_changed"
  | "subject_mismatch";

export interface ObservationDiff {
  subject: string;
  type: ObservationKind;
  source: string;
  previousId: string | null;
  currentId: string | null;
  previousObservedAt: string | null;
  currentObservedAt: string | null;

  /** ★ 可比性判定 —— 这是 diff 最重要的字段 */
  comparable: boolean;
  incomparableReason?: IncomparableReason;
  /** 不可比时的完整说明（说清「为什么不能直接比」，而不是丢一个枚举了事） */
  note?: string;

  changes: DiffChange[];

  summary: {
    improved: number;
    degraded: number;
    neutral: number;
    unknown: number;
  };

  diffEngineVersion: string;
}

/* ------------------------------------------------------------------ */
/* 可比性                                                              */
/* ------------------------------------------------------------------ */

/**
 * 可判定状态 —— 只有落在这些状态上的结论才谈得上「变化」。
 *
 * 设计稿用的是 `OBSERVED | NOT_FOUND`，但 S1 契约里**没有 NOT_FOUND**
 * （也不能为它扩枚举）。契约的实际表达方式是：
 *
 *   「上榜了但目标不在榜上」= status OBSERVED + `result.targetRank === null`
 *
 * 所以设计稿里那条 `NOT_FOUND → OBSERVED = improved`（进入榜单）
 * 在 S6 由 **targetRank 的 null → 数值** 承载，语义完全等价，
 * 只是从状态层挪到了数值层。见 `diffTargetRank()`。
 *
 * ★ PARTIAL 刻意不在其中：Site Observer 自己就声明了
 *   「11 项检查是在空内容上跑的，分数不可信」。既然 Observer 说不可信，
 *   diff 就不能拿它去宣布站点进步或退步 —— 那是替它撤回自己的 caveat。
 */
export const COMPARABLE_STATUSES: readonly ObservationStatus[] = [
  "OBSERVED",
  "MENTIONED",
  "NOT_MENTIONED",
];

export function isComparableStatus(s: ObservationStatus): boolean {
  return COMPARABLE_STATUSES.includes(s);
}

/**
 * 可比性判定（纯）。
 *
 * 检查顺序**有意义**：先版本后状态。
 * 因为「口径都变了」比「这次没抓到」更根本 ——
 * 口径不同的两条记录，连「谁进步了」这个问题本身都不成立。
 */
export function assessComparability(
  prev: Observation,
  cur: Observation
): { comparable: true } | { comparable: false; reason: IncomparableReason; note: string } {
  if (prev.subject !== cur.subject || prev.type !== cur.type) {
    return {
      comparable: false,
      reason: "subject_mismatch",
      note: `被观测对象不一致（${prev.subject}/${prev.type} → ${cur.subject}/${cur.type}）—— 这不是同一个东西的两次观测`,
    };
  }
  if (prev.observerVersion !== cur.observerVersion) {
    return {
      comparable: false,
      reason: "observer_version_changed",
      note: `观测器版本变化（${prev.observerVersion} → ${cur.observerVersion}）—— 规则换了，分数涨跌不代表站点变化`,
    };
  }
  if (prev.parserVersion !== cur.parserVersion) {
    return {
      comparable: false,
      reason: "parser_version_changed",
      note: `解析器版本变化（${prev.parserVersion} → ${cur.parserVersion}）—— 口径换了，看起来像变化的往往只是算法换代`,
    };
  }
  // promptVersion 不在版本三元组里，Store 不会为它建 replaces 链
  // —— 所以**必须由 diff 自己比对**（S5 文档 W-3 明确要求）。
  if (prev.metadata?.promptVersion !== cur.metadata?.promptVersion) {
    return {
      comparable: false,
      reason: "prompt_version_changed",
      note: `提问版本变化（${prev.metadata?.promptVersion ?? "-"} → ${cur.metadata?.promptVersion ?? "-"}）—— 问法不同，回答没有可比性`,
    };
  }
  if (!isComparableStatus(prev.status) || !isComparableStatus(cur.status)) {
    return {
      comparable: false,
      reason: "status_not_observed",
      note: describeIncomparableStatus(prev.status, cur.status),
    };
  }
  return { comparable: true };
}

/**
 * 不可比时的迁移说明表。
 *
 * ★ 这张表是显式写死的，不用 if-else 堆 ——
 *   每条都回答「这不是一条关于站点/模型的结论，而是关于观测本身的结论」。
 */
const INCOMPARABLE_NOTES: Record<string, string> = {
  "UNOBSERVABLE->OBSERVED":
    "此前没能观测到，这次观测到了 —— 这是覆盖度提升，不是表现提升",
  "UNOBSERVABLE->NOT_MENTIONED":
    "此前没能观测到，这次观测到了但模型未提及 —— 从「没看到」到「看到了但没有」，仍然是覆盖度提升，不得计为下降",
  "UNOBSERVABLE->MENTIONED":
    "此前没能观测到，这次观测到了且提及 —— 无法判断是新增提及还是首次被看到",
  "OBSERVED->UNOBSERVABLE":
    "观测能力丢失（没抓到/没配 key）—— 这是我方观测退化，不代表被观测对象的表现下降",
  "MENTIONED->UNOBSERVABLE":
    "这次没能观测到 —— 观测丢失不等于模型不再提及",
  "NOT_MENTIONED->UNOBSERVABLE":
    "这次没能观测到 —— 观测丢失不等于态度变化",
  "BLOCKED->OBSERVED":
    "此前被拒绝访问，这次看到了 —— 恢复观测，不代表表现提升",
  "OBSERVED->BLOCKED":
    "被对方限流/拒绝 —— 这是我方被拦，不代表站点或模型变差",
  "ERROR->OBSERVED":
    "此前采集失败，这次成功 —— 故障恢复不是表现提升",
  "OBSERVED->ERROR":
    "这次采集失败 —— 我方故障不代表被观测对象变差",
  "INDETERMINATE->MENTIONED":
    "此前模型未给出可判定回答，这次提及了 —— 口径不同（未答 ≠ 未提及），不计为提升",
  "INDETERMINATE->NOT_MENTIONED":
    "此前模型未给出可判定回答，这次明确未提及 —— 「没回答」与「回答了没提」不可比",
  "MENTIONED->INDETERMINATE":
    "这次模型未给出可判定回答 —— 不得记为下降",
  "NOT_MENTIONED->INDETERMINATE":
    "这次模型未给出可判定回答 —— 不得记为提升",
};

function describeIncomparableStatus(prev: ObservationStatus, cur: ObservationStatus): string {
  const exact = INCOMPARABLE_NOTES[`${prev}->${cur}`];
  if (exact) return `状态迁移 ${prev} → ${cur}：${exact}`;
  if (prev === cur) {
    return `两侧状态同为 ${prev} —— 该状态不是可判定结论（没有答案可以比较）`;
  }
  return `状态迁移 ${prev} → ${cur}：至少一侧不是可判定结论，本次只记录观测状态变化，不判定方向`;
}

/* ------------------------------------------------------------------ */
/* 数值 / 集合 差异                                                    */
/* ------------------------------------------------------------------ */

interface MetricSpec {
  path: string;
  /** true = 越大越好（分数）；false = 越小越好（排名） */
  higherIsBetter: boolean;
  /** 显著性阈值：低于它只标 neutral，避免把噪声当趋势 */
  minDelta: number;
}

/**
 * 每种 Observation 参与比较的指标。
 *
 * ★ 阈值写在**这里**（diff 自己的表里），不写进 Observer ——
 *   「多少分算变化」是读取侧的判定，不是观测结论的一部分。
 *   但它按 type 分组， Observer 改 result 结构时这里必须同步更新。
 */
const METRICS: Partial<Record<ObservationKind, MetricSpec[]>> = {
  geo_score: [
    { path: "result.seoScore", higherIsBetter: true, minDelta: 5 },
    { path: "result.geoScore", higherIsBetter: true, minDelta: 5 },
  ],
  // rank 的 targetRank 单独处理（有 null 语义），不进这张表
  ai_mention: [],
};

/** 集合型字段：新增/移除要看得见 */
const COLLECTIONS: Partial<Record<ObservationKind, string>> = {
  rank: "result.items[].domain",
  ai_mention: "result.citedDomains",
};

function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function diffValue(spec: MetricSpec, prev: Observation, cur: Observation): DiffChange | null {
  const a = getPath(prev, spec.path);
  const b = getPath(cur, spec.path);
  if (a === b) return null;

  if (!isNum(a) || !isNum(b)) {
    return {
      kind: "VALUE",
      path: spec.path,
      previous: a ?? null,
      current: b ?? null,
      direction: "unknown",
      note: "取值不是数值（结构可能变更），无法判定方向",
    };
  }

  const delta = b - a;
  if (Math.abs(delta) < spec.minDelta) {
    return {
      kind: "VALUE",
      path: spec.path,
      previous: a,
      current: b,
      direction: "neutral",
      delta,
      note: `变化 ${delta} 未达显著性阈值 ±${spec.minDelta}`,
    };
  }

  const better = spec.higherIsBetter ? delta > 0 : delta < 0;
  return {
    kind: "VALUE",
    path: spec.path,
    previous: a,
    current: b,
    direction: better ? "improved" : "degraded",
    delta,
  };
}

/**
 * targetRank 的 null 语义。
 *
 * null = 抓到了榜单但目标没上榜 —— **这是真实结论**（Search Observer 已经
 * 把它记成 OBSERVED + caveat），对应设计稿里那个不存在的 NOT_FOUND。
 *
 *   null → 8   进入榜单        improved
 *   8 → null   掉出榜单        degraded
 *   null → null 两侧都没上榜  无变化
 *
 * 进出榜单是**质变**，不受 ±3 阈值约束 —— 第 9 名到第 11 名可以算波动，
 * 但「在榜上」和「不在榜上」不是同一个量级的事。
 */
function diffTargetRank(prev: Observation, cur: Observation): DiffChange | null {
  if (cur.type !== "rank") return null;
  const a = getPath(prev, "result.targetRank");
  const b = getPath(cur, "result.targetRank");

  if (a === null && b === null) return null;

  const path = "result.targetRank";
  if (a === null || a === undefined) {
    return {
      kind: "VALUE",
      path,
      previous: null,
      current: b ?? null,
      direction: isNum(b) ? "improved" : "unknown",
      note: "目标此前未上榜，本次进入榜单",
    };
  }
  if (b === null || b === undefined) {
    return {
      kind: "VALUE",
      path,
      previous: a,
      current: null,
      direction: isNum(a) ? "degraded" : "unknown",
      note: "目标掉出榜单",
    };
  }
  if (!isNum(a) || !isNum(b)) return null;
  if (a === b) return null;
  const delta = b - a;
  if (Math.abs(delta) < RANK_MIN_DELTA) {
    return {
      kind: "VALUE",
      path,
      previous: a,
      current: b,
      direction: "neutral",
      delta,
      note: `位次变化 ${delta} 未达显著性阈值 ±${RANK_MIN_DELTA}`,
    };
  }
  return {
    kind: "VALUE",
    path,
    previous: a,
    current: b,
    // 排名越小越好
    direction: delta < 0 ? "improved" : "degraded",
    delta,
  };
}

/** 排名类显著性阈值（位） */
export const RANK_MIN_DELTA = 3;

/** 分数类显著性阈值（分） */
export const SCORE_MIN_DELTA = 5;

function collectStrings(root: unknown, path: string): string[] {
  if (path.endsWith("[]." + path.split("[].")[1])) {
    const [base, field] = path.split("[].");
    const arr = getPath(root, base);
    if (!Array.isArray(arr)) return [];
    return Array.from(
      new Set(
        arr
          .map((it) => (it as Record<string, unknown>)?.[field!])
          .filter((v): v is string => typeof v === "string" && v.length > 0)
      )
    );
  }
  const v = getPath(root, path);
  if (!Array.isArray(v)) return [];
  return Array.from(new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0)));
}

function diffSet(prev: Observation, cur: Observation, path: string): DiffChange[] {
  const prevSet = new Set(collectStrings(prev, path));
  const curSet = new Set(collectStrings(cur, path));
  const added = Array.from(curSet).filter((x) => !prevSet.has(x)).sort();
  const removed = Array.from(prevSet).filter((x) => !curSet.has(x)).sort();

  const out: DiffChange[] = [];
  if (added.length > 0) {
    out.push({
      kind: "ADDED",
      path,
      previous: [],
      current: added,
      // 榜单里出现新主体不等于目标变差 —— 这是中性的客观变化
      direction: "neutral",
      note: `新增 ${added.length} 项`,
    });
  }
  if (removed.length > 0) {
    out.push({
      kind: "REMOVED",
      path,
      previous: removed,
      current: [],
      direction: "neutral",
      note: `减少 ${removed.length} 项`,
    });
  }
  return out;
}

/** 可比较状态下的状态迁移方向（AI 的 MENTIONED ↔ NOT_MENTIONED 是真实结论变化） */
function diffStatus(prev: Observation, cur: Observation): DiffChange | null {
  if (prev.status === cur.status) return null;

  const key = `${prev.status}->${cur.status}`;
  let direction: DiffDirection = "unknown";
  if (key === "NOT_MENTIONED->MENTIONED") direction = "improved";
  else if (key === "MENTIONED->NOT_MENTIONED") direction = "degraded";
  else direction = "unknown";

  return {
    kind: "STATUS",
    path: "status",
    previous: prev.status,
    current: cur.status,
    direction,
    note:
      direction === "unknown"
        ? "状态发生了非典型迁移，方向不可判定"
        : "提及状态发生真实变化（两侧都是可判定结论）",
  };
}

function diffCoverage(prev: Observation, cur: Observation): DiffChange | null {
  const a = prev.coverage;
  const b = cur.coverage;
  if (!a && !b) return null;
  if (
    a &&
    b &&
    a.expected === b.expected &&
    a.observed === b.observed &&
    a.ratio === b.ratio
  ) {
    return null;
  }
  return {
    kind: "COVERAGE",
    path: "coverage",
    previous: a ?? null,
    current: b ?? null,
    /**
     * ★ 覆盖度变化刻意不给方向。
     * 「这次多观测到两个模型」说的是**我们看得更全了**，
     * 不是「表现变好了」。给它 improved 会把补凭证记成涨分。
     */
    direction: "unknown",
    note: "覆盖度描述的是观测到的范围，不代表被观测对象的表现变化",
  };
}

function diffEvidenceRefs(prev: Observation, cur: Observation): DiffChange | null {
  const a = Array.from(new Set(prev.evidenceRefs ?? [])).sort();
  const b = Array.from(new Set(cur.evidenceRefs ?? [])).sort();
  if (a.length === b.length && a.every((x, i) => x === b[i])) return null;
  return {
    kind: "EVIDENCE",
    path: "evidenceRefs",
    previous: a,
    current: b,
    direction: "neutral",
    note: "结论所依据的原始素材发生了变化（重新采集/追加证据），结论本身仍可比",
  };
}

function diffStrategyVersion(prev: Observation, cur: Observation): DiffChange | null {
  if (prev.strategyVersion === cur.strategyVersion) return null;
  return {
    kind: "VERSION",
    path: "strategyVersion",
    previous: prev.strategyVersion ?? null,
    current: cur.strategyVersion ?? null,
    /**
     * ★ 策略版本变化**不断可比性** —— 它是定位「哪家引擎的哪一版开始失效」
     * 用的，不是口径判断依据（D10）。但它必须被看见。
     */
    direction: "unknown",
    note: "解析策略版本变化 —— 可比性保留，但若数值突变应优先怀疑策略本身",
  };
}

/* ------------------------------------------------------------------ */
/* 主入口（纯函数）                                                    */
/* ------------------------------------------------------------------ */

function summarize(changes: DiffChange[]): ObservationDiff["summary"] {
  const s = { improved: 0, degraded: 0, neutral: 0, unknown: 0 };
  for (const c of changes) s[c.direction] += 1;
  return s;
}

/**
 * 两条 Observation 的差异结论。
 *
 * ★ 外部 Check：`comparable === false` ⇒ `summary` 里
 *   improved / degraded **必定为 0**。这不是约定，是下面的构造方式保证的：
 *   不可比分支里每一条 change 的 direction 都写死为 "unknown"。
 */
export function diffObservations(
  previous: Observation | null,
  current: Observation | null
): ObservationDiff {
  const cur = current;
  const base = {
    diffEngineVersion: DIFF_ENGINE_VERSION,
    changes: [] as DiffChange[],
  };

  if (!cur) {
    return {
      ...base,
      subject: "",
      type: (previous?.type ?? "geo_score") as ObservationKind,
      source: "",
      previousId: previous?.id ?? null,
      currentId: null,
      previousObservedAt: previous?.observedAt ?? null,
      currentObservedAt: null,
      comparable: false,
      incomparableReason: "missing_previous",
      note: "没有基准观测（previous 缺失）—— 首次观测不构成“变化”",
      summary: { improved: 0, degraded: 0, neutral: 0, unknown: 0 },
    };
  }

  if (!previous) {
    return {
      ...base,
      subject: cur.subject,
      type: cur.type,
      source: cur.source,
      previousId: null,
      currentId: cur.id,
      previousObservedAt: null,
      currentObservedAt: cur.observedAt,
      comparable: false,
      incomparableReason: "missing_previous",
      note: "该 identity 只有一条观测，没有历史可比较",
      summary: { improved: 0, degraded: 0, neutral: 0, unknown: 0 },
    };
  }

  const verdict = assessComparability(previous, cur);

  if (!verdict.comparable) {
    const changes: DiffChange[] = [];
    if (previous.status !== cur.status) {
      changes.push({
        kind: "STATUS",
        path: "status",
        previous: previous.status,
        current: cur.status,
        // ★ 不可比 ⇒ 只有 unknown。哪怕看起来像「从没提到到提到了」也一样。
        direction: "unknown",
        note: verdict.note,
      });
    }
    if (
      verdict.reason === "observer_version_changed" ||
      verdict.reason === "parser_version_changed" ||
      verdict.reason === "prompt_version_changed"
    ) {
      changes.push({
        kind: "VERSION",
        path: versionPathOf(verdict.reason),
        previous: versionValueOf(previous, verdict.reason),
        current: versionValueOf(cur, verdict.reason),
        direction: "unknown",
        note: verdict.note,
      });
    }
    if (changes.length === 0) {
      changes.push({
        kind: "STATUS",
        path: "status",
        previous: previous.status,
        current: cur.status,
        direction: "unknown",
        note: verdict.note,
      });
    }

    return {
      ...base,
      subject: cur.subject,
      type: cur.type,
      source: cur.source,
      previousId: previous.id,
      currentId: cur.id,
      previousObservedAt: previous.observedAt,
      currentObservedAt: cur.observedAt,
      comparable: false,
      incomparableReason: verdict.reason,
      note: verdict.note,
      changes,
      summary: summarize(changes),
    };
  }

  const changes: DiffChange[] = [];

  const statusChange = diffStatus(previous, cur);
  if (statusChange) changes.push(statusChange);

  const metrics = METRICS[cur.type] ?? [];
  for (const spec of metrics) {
    const c = diffValue(spec, previous, cur);
    if (c) changes.push(c);
  }

  const rankChange = diffTargetRank(previous, cur);
  if (rankChange) changes.push(rankChange);

  const setPath = COLLECTIONS[cur.type];
  if (setPath) changes.push(...diffSet(previous, cur, setPath));

  const coverageChange = diffCoverage(previous, cur);
  if (coverageChange) changes.push(coverageChange);

  const versionChange = diffStrategyVersion(previous, cur);
  if (versionChange) changes.push(versionChange);

  const evidenceChange = diffEvidenceRefs(previous, cur);
  if (evidenceChange) changes.push(evidenceChange);

  return {
    ...base,
    subject: cur.subject,
    type: cur.type,
    source: cur.source,
    previousId: previous.id,
    currentId: cur.id,
    previousObservedAt: previous.observedAt,
    currentObservedAt: cur.observedAt,
    comparable: true,
    changes,
    summary: summarize(changes),
  };
}

function versionPathOf(reason: IncomparableReason): string {
  if (reason === "observer_version_changed") return "observerVersion";
  if (reason === "parser_version_changed") return "parserVersion";
  return "metadata.promptVersion";
}

function versionValueOf(o: Observation, reason: IncomparableReason): unknown {
  if (reason === "observer_version_changed") return o.observerVersion;
  if (reason === "parser_version_changed") return o.parserVersion;
  return o.metadata?.promptVersion ?? null;
}

/* ------------------------------------------------------------------ */
/* Store 侧的读取入口                                                  */
/* ------------------------------------------------------------------ */

export interface DiffQuery {
  subject: string;
  type: ObservationKind | string;
  /** 不传 = 不限来源（多引擎/多厂商会被混进来，通常应当指定） */
  source?: string;
  /** 只比较该时间点之前的观测。用于「回到过去某个瞬间重算」 */
  to?: string;
}

/**
 * 取某 identity 最近两条观测。
 *
 * ★ **不做可比性过滤** —— 这是刻意的。
 *   若在这里就把「上次没观测到」的那条跳过了，
 *   `UNOBSERVABLE → NOT_MENTIONED` 就永远不会出现在 diff 里，
 *   而那恰恰是最需要被解释清楚的一类迁移。
 *   过滤是 diff 的事，取数是 store 的事，两者不得互相替对方做决定。
 *
 * 排序：升序取最后两条。升序下稳定排序保留写入顺序，
 *      同一时间戳的先后顺序因此是确定的（后写的在后）。
 */
export async function latestPair(
  store: Store,
  q: DiffQuery
): Promise<{ previous: Observation | null; current: Observation | null }> {
  const all = await store.listObservations({
    subject: q.subject,
    type: q.type,
    source: q.source,
    to: q.to,
    order: "asc",
  });
  const n = all.length;
  if (n === 0) return { previous: null, current: null };
  if (n === 1) return { previous: null, current: all[0]! };
  return { previous: all[n - 2]!, current: all[n - 1]! };
}

/** 取数 + 比较的组合动作 */
export async function diffLatest(store: Store, q: DiffQuery): Promise<ObservationDiff> {
  const { previous, current } = await latestPair(store, q);
  return diffObservations(previous, current);
}
