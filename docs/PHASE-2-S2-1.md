# Phase 2 · S2-1 —— Diagnosis 层

对应 `docs/ARCHITECTURE-ROADMAP.md` §十二（Auto Fix 怎么接 Git）、§十四（Phase 2 · 自动化）。

```text
S2-1 Diagnosis 层（本步） → S2-2 packages/cli → S2-3 SARIF + CI → S2-4 Auto Fix（dry-run）
```

| | |
|---|---|
| **做什么** | 把 `analyze()` 的 `CheckResult[]` 翻译成 machine-readable `Diagnosis[]`，并建立 5 条可预测 fix 规则 |
| **不做什么** | 不改 `analyze()`、不改 Phase 1 contract、不做 CLI、不做 SARIF、不做 git/PR、不联网 |

## 1. 为什么要有这一层

`checks[]` 是**给人看的**：`detail` 是中文句子，`fix` 是建议，`id` 只有 11 个且
同一个 id 在不同 level 下是两件事（http 的 warn 与 fail 完全不同）。

`Diagnosis` 是**给机器用的**：稳定 `issueId`、明确 `severity`，
以及一个决定性字段 —— `suggestedFix`。

> ★ **`suggestedFix` 存在与否，就是 Auto Fix 的闸门。**
> 没有它的问题只能出诊断报告，不许进自动修复。
> 这条边界必须在类型上就表达出来，而不是靠调用方自觉。

## 2. 契约

```ts
interface Diagnosis {
  issueId: string;        // 稳定 id，如 "viewport/missing"
  checkId: string;        // 回溯到 analyze() 的那个 check
  targetUrl: string;
  severity: "blocker" | "major" | "minor";
  detail: string;         // analyze() 已算好的中文描述，原样带过来
  evidenceId?: string;    // 指回 Evidence
  suggestedFix?: string;  // ★ 有它才允许自动修
  manualFix?: string;     // 不可自动修时的建议（来自 CheckResult.fix）
}
```

相对 Phase 2 PLAN 的五个字段，只多出三个「不记就会丢掉已有事实」的字段：
`checkId`（可回溯）、`detail`（已算好的描述，不重复计算）、`manualFix`（不可自动修的
建议文本）。`suggestedFix` 与 `manualFix` 互斥 —— 有自动解的，人就不用动手。

## 3. 11 项 check → issueId

只做映射，**不重新实现任何检查**。判断逻辑全部留在 `audit.ts`。

| check id | level | issueId | severity | 自动修 |
|---|---|---|---|---|
| `fetch` | fail (w=100) | `fetch/unreachable` | blocker | — |
| `http` | fail | `http/error` | major | — |
| `http` | warn (3xx) | `http/redirect` | minor | — |
| `title` | fail (空) | `title/missing` | major | — |
| `title` | warn | `title/length` | minor | — |
| `desc` | fail (空) | `desc/missing` | major | — |
| `desc` | warn | `desc/length` | minor | — |
| `canonical` | warn | `canonical/missing` | minor | ✅ `canonical` |
| `robots` | fail (noindex) | `robots/noindex` | major | — |
| `h1` | warn | `h1/structure` | minor | — |
| `alt` | fail | `alt/mostly-missing` | major | ✅ `alt-empty` |
| `alt` | warn | `alt/partly-missing` | minor | ✅ `alt-empty` |
| `viewport` | warn | `viewport/missing` | minor | ✅ `viewport` |
| `lang` | warn | `lang/missing` | minor | ✅ `lang` |
| `jsonld` | warn | `jsonld/missing` | minor | — |
| `og` | warn | `og/incomplete` | minor | ✅ `og-skeleton` |

`pass` 不产生诊断 —— 不是问题就别出声，否则真正要看的会被稀释。

**severity**：`weight ≥ 100 → blocker`（只有 fetch 那一档）/ `fail → major` / `warn → minor`。

## 4. 五条 fix 规则

准入标准只有一条：**这个 patch 的 diff 能不能提前预测**。
能预测 → 进库；需要内容判断（写标题、改描述、选图）→ 一律不进。

| fixId | 补什么 | 值从哪来 |
|---|---|---|
| `viewport` | `<meta name="viewport" content="width=device-width, initial-scale=1">` | 固定值 |
| `lang` | `<html lang="zh-CN">` | 缺失才有；已有（哪怕 `en`）不动 |
| `canonical` | `<link rel="canonical" href="…">` | `finalUrl` |
| `og-skeleton` | `og:title` / `og:description` / `og:url` | `title` / `metaDescription` / `finalUrl` |
| `alt-empty` | `alt=""` | 空值，只声明「这是装饰图」 |

三条硬规矩：

1. **已有值不覆盖** —— 已有 `lang="en"` 也判定权在站方，我们不动。
2. **无法定位就放弃** —— 找不到 `</head>` 返回 `null` 并给出理由，绝不猜位置塞进去。
3. **不编造** —— 刻意**不补 `og:image`**：图片地址必须指向真实存在的图，
   填占位图链接等于让分享卡片带一张假图，比不补更糟。
   `alt` 同理只补空值，描述性 alt 需要看懂图，那是人的活。

实现是最朴素的字符串插入 —— 不引入 HTML formatter，因为格式化会重写整个文件，
与「最小 diff」直接冲突。

## 5. 幂等

```text
applies(html) == false  ⇒  不改
patch(html) 之后再 applies  ⇒  必须为 false
applyFixes 跑第二遍  ⇒  changed 计数为 0，字节一致
```

CI 会反复触发，幂等不是优化，是前提。测试第 5 组专门盯这个。

## 6. 产出

```text
NEW  src/lib/diagnosis/types.ts   Diagnosis / FixRule / FixContext
NEW  src/lib/diagnosis/rules.ts   mapCheck / severityOf / FIX_RULES（5 条）
NEW  src/lib/diagnosis/index.ts   diagnose / diagnoseAudit / applyFix / applyFixes
NEW  scripts/test-diagnosis.ts    63 项（离线，禁网）
MOD  package.json                 test:diagnosis
```

## 7. 留给 S2-2 的接口

```text
diagnoseAudit(audit, { evidenceId? })  →  Diagnosis[]
buildFixContext(audit)                 →  FixContext
applyFixes(html, diagnoses, ctx)       →  { html, attempts }
autoFixable(diagnoses)                 →  只有带 suggestedFix 的那些
```

CLI 的 `check` 直接吃 `diagnoseAudit`；`gate` 按 `severity` 计数；
`fix` 的 dry-run 只走 `autoFixable`。三条都不需要再看 `checks[]` 的中文文案。
