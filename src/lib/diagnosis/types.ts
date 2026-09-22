/**
 * Diagnosis —— 从「检查结论」到「可执行问题」的那一步（Phase 2 · S2-1）。
 *
 * 为什么需要这一层，而不是直接拿 PageAudit 的 checks[] 去用：
 *
 *   checks[] 是**给人看的**：`detail` 是中文句子，`fix` 是建议，
 *   `id` 只有 11 个且随 level 变化含义不同（http 的 warn 与 fail 是两件事）。
 *
 *   Diagnosis 是**给机器用的**：稳定 issueId、明确 severity、
 *   以及一个决定性字段 —— `suggestedFix`。
 *
 *   ★ `suggestedFix` 存在与否，就是 Auto Fix 的闸门。
 *     没有它的问题只能出诊断报告，不许进自动修复。
 *     这条边界必须在类型上就表达出来，而不是靠调用方自觉。
 */

/** 严重度。三档足够：再多就没人看得懂差别了 */
export type Severity = "blocker" | "major" | "minor";

/**
 * 一条诊断。
 *
 * 字段刻意保持最小 —— 只留 Phase 2 PLAN 定下的五个，外加两个
 * 「不记就会丢掉已有事实」的字段：
 *
 *   checkId   : 回溯到 analyze() 的那个 check。没有它，改一次 check
 *               文案就查不出这个 issue 是从哪来的。
 *   detail    : analyze() 已经算好的中文描述。再算一遍就是重复实现。
 *   manualFix : 不可自动修时的建议（来自 CheckResult.fix）。
 *               与 suggestedFix 互斥 —— 有自动解的，人就不用动手。
 */
export interface Diagnosis {
  /** 稳定 machine-readable id，如 `viewport/missing`。修规则靠它挂靠 */
  issueId: string;
  /** 来源 check id，用于回溯与去重 */
  checkId: string;
  /** 被诊断的对象 */
  targetUrl: string;
  severity: Severity;
  /** analyze() 已产出的中文描述，原样带过来 */
  detail: string;
  /** 指回 Evidence（存证开启时才有） */
  evidenceId?: string;
  /** ★ 可自动执行的修复规则 id。存在 = 允许进 Auto Fix */
  suggestedFix?: string;
  /** 不可自动修时的建议文本（来自 CheckResult.fix） */
  manualFix?: string;
}

/** 一次诊断的输入。刻意只要 audit 已经产出的东西，不新增判断维度 */
export interface DiagnoseInput {
  /** analyze() 的结果 —— 事实的唯一来源 */
  audit: {
    url: string;
    finalUrl?: string;
    checks: {
      id: string;
      label: string;
      level: "pass" | "warn" | "fail";
      detail: string;
      value?: string;
      fix?: string;
      weight: number;
    }[];
    /** 供 fix 规则读取的既有值（不覆盖原则要用） */
    title?: string | null;
    metaDescription?: string | null;
    canonical?: string | null;
    ogTags?: Record<string, string>;
    lang?: string | null;
    evidenceId?: string;
  };
  /** Evidence id 覆盖值（调用方已单独存证时使用） */
  evidenceId?: string;
}

/**
 * 一条修复规则（Phase 2 · S2-1）。
 *
 * ★ 准入标准只有一条：**这个 patch 的 diff 能不能提前预测**。
 *   能预测 → 进规则库；需要内容判断（写标题、改描述、选图）→ 一律不进。
 *
 * 因此这里只有五条：viewport / lang / canonical / og 骨架 / alt 空值。
 * 它们共同的特征是「补一个标准结构，值来自页面已有信息」，
 * 不产生任何需要人来拍板的内容。
 */
export interface FixRule {
  fixId: string;
  /** 该规则能解决哪些 issueId */
  issueIds: readonly string[];
  /** 一句话说明，进 PR 正文 */
  summary: string;
  /**
   * 是否还需要修。
   *
   * 幂等的核心：patch 执行完再问一次，必须返回 false。
   * 已存在目标值（哪怕是别的值）⇒ false —— 不覆盖是硬规矩。
   */
  applies(html: string, ctx: FixContext): boolean;
  /**
   * 生成修改后的 HTML。
   *
   * 返回 null = 不适用或无法安全定位（**绝不返回「猜一个位置塞进去」的结果**）。
   * 最小修改：只插入缺失的那一个标签/属性，不动其他任何字节。
   */
  patch(html: string, ctx: FixContext): string | null;
}

/** patch 时能用的上下文 —— 全部来自 audit 已算出的值，不重新解析语义 */
export interface FixContext {
  /** 页面最终 URL，canonical / og:url 用它 */
  url: string;
  title: string | null;
  description: string | null;
  canonical: string | null;
  lang: string | null;
  /** 已存在的 og 标签（`og:title` → 值），缺什么补什么 */
  ogTags: Record<string, string>;
}
