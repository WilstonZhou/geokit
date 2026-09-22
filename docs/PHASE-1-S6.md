# Phase 1 / S6 —— Diff 引擎与可比性判定

```text
commit:    feat: implement phase 1 S6
父提交:    b6828ff（S5）
状态:      COMPLETE
契约:      S1/S2 未改 · replaces 未改 · analyze() 未改
```

---

## 1. Scope

| 项 | 内容 |
|---|---|
| **做什么** | Diff 引擎 + 可比性判定，产出 `ObservationDiff` |
| **不做什么** | 时间维度的 HTTP API（S7）· SQLite（S8）· UI · 落到 route / MCP |

设计依据：`docs/PHASE-1-DATA-ARCHITECTURE.md` §5（Diff Model）、§12（Versioning）、§13。

验收标准只有一条，但它是本项目价值观的直接体现：

```text
UNOBSERVABLE → NOT_MENTIONED 必须判定为 unknown，而不是下降。
```

---

## 2. 为什么「可比性」必须在数值之前

diff 回答三件事，顺序固定：

```text
① 这两条能不能比      comparable
② 能比的话变了什么    changes
③ 算变好还是变坏      direction
```

跳过 ① 直接比数值，会把下面这些统统记成「站点表现上升/下降」：

| 真实情况 | 被误读成 |
|---|---|
| 补齐了一把 API key（UNOBSERVABLE → NOT_MENTIONED） | 表现暴跌 |
| 解析口径升级（parserVersion 变了） | 分数跳变 |
| 被百度限流（OBSERVED → BLOCKED） | 网站变差 |
| 换个问法（promptVersion 变了） | 模型态度变了 |

**规则**：凡 `comparable === false`，`summary` 里 `improved` / `degraded` **必定为 0**。
这不是约定，而是由构造方式保证 —— 不可比分支里每条 change 的 `direction` 都写死为 `unknown`。

---

## 3. 可比性判定

```ts
subject / type 不一致        → subject_mismatch
observerVersion 不一致       → observer_version_changed
parserVersion 不一致         → parser_version_changed
metadata.promptVersion 不一致 → prompt_version_changed
任一侧状态不可判定            → status_not_observed
否则                         → comparable
```

**检查顺序有意义**：先版本后状态。口径都变了的时候，「谁进步了」这个问题本身就不成立。

### 3.1 可判定状态集合

```ts
COMPARABLE_STATUSES = ["OBSERVED", "MENTIONED", "NOT_MENTIONED"]
```

设计稿写的是 `OBSERVED | NOT_FOUND`，但 **S1 契约里没有 `NOT_FOUND`**（也不能为它扩枚举）。
契约里的实际表达是：

```text
「上榜了但目标不在榜上」 = status OBSERVED + result.targetRank === null
```

所以设计稿里那条 `NOT_FOUND → OBSERVED = improved`（进入榜单），在 S6 由
**targetRank 的 `null → 数值`** 承载。语义完全等价，只是从状态层挪到了数值层（见 §5.2）。

### 3.2 PARTIAL 刻意不可比

Site Observer 自己对 PARTIAL 的 caveat 是「11 项检查是在空内容上跑的，分数不可信」。
既然 Observer 已经声明不可信，diff 就不能拿它去宣布站点进步或退步 ——
那等于替 Observer 撤回它自己的保留意见。

### 3.3 promptVersion 必须自己比

`promptVersion` **不在版本三元组里**，Store 不会为它建 `replaces` 链（S5 文档 W-3）。
这条历史ieron 只能由 diff 自己兜 —— 漏了它，改一次提问措辞就会在时间线上
表现为「模型的态度变了」。

---

## 4. 类型契约

```ts
type DiffChangeKind =
  | "VALUE" | "STATUS" | "ADDED" | "REMOVED"
  | "COVERAGE" | "VERSION" | "EVIDENCE";

type DiffDirection = "improved" | "degraded" | "neutral" | "unknown";

type IncomparableReason =
  | "missing_previous" | "status_not_observed"
  | "parser_version_changed" | "observer_version_changed"
  | "prompt_version_changed" | "subject_mismatch";

interface ObservationDiff {
  subject; type; source;
  previousId; currentId;          // 便于从 diff 回溯到 Observation
  previousObservedAt; currentObservedAt;
  comparable; incomparableReason?; note?;
  changes: DiffChange[];
  summary: { improved; degraded; neutral; unknown };
  diffEngineVersion;
}
```

`DiffChange.delta` 只在数值型变化时给出，且是 `current - previous`（不是绝对值）。

---

## 5. 方向判定

### 5.1 状态（可比时）

| 迁移 | 方向 |
|---|---|
| NOT_MENTIONED → MENTIONED | improved |
| MENTIONED → NOT_MENTIONED | degraded |
| 其余 | unknown |

### 5.2 targetRank 的 null 语义（★）

```text
null → 8      进入榜单        improved（不受阈值约束）
8 → null      掉出榜单        degraded
null → null   两侧都没上榜     无 change
3 → 4         波动 1 位        neutral（< ±3）
3 → 7         掉 4 位          degraded
25 → 3        升 22 位         improved
```

进出榜单是**质变**：第 9 名到第 11 名可以算噪声，但「在榜上」和「不在榜上」
不是同一个量级的事，因此**不套 ±3 阈值**。

### 5.3 数值阈值

阈值写在 diff 自己的表里（`METRICS`），不写进 Observer ——
「多少分算变化」是读取侧的判定，不是观测结论的一部分。

```ts
geo_score: result.seoScore  ±5（越大越好）
           result.geoScore  ±5（越大越好）
rank:      result.targetRank ±3（越小越好）
ai_mention: 无数值指标 —— 结论由状态承载
```

低于阈值一律 `neutral`；取值不是数值（结构变更）一律 `unknown`。

### 5.4 集合 / 元信息

| kind | 触发 | 方向 |
|---|---|---|
| ADDED / REMOVED | `rank` 的 `result.items[].domain`、`ai_mention` 的 `result.citedDomains` 增减 | neutral |
| COVERAGE | coverage 三分量任一变化 | **unknown** |
| VERSION | `strategyVersion` 变化 | unknown（但**可比性保留**） |
| EVIDENCE | `evidenceRefs` 变化 | neutral |

两处刻意的「不给方向」：

- **COVERAGE** —— 「这次多观测到两个模型」说的是**我们看得更全了**，
  不是表现变好。给它 improved 会把补凭证记成涨分。
- **ADDED/REMOVED** —— 榜单里出现新主体不等于目标变差；目标的进退由
  `targetRank` 单独负责，集合变化只做客观记录。

`strategyVersion` 变化**不断可比性**（设计稿 D10）：细分版本是用来定位
「哪家引擎的哪一版开始失效」的，不是口径判断依据。但它必须被看见，所以产出
一条 VERSION change。

---

## 6. Store 取数

```ts
latestPair(store, { subject, type, source?, to? })
diffLatest(store, query)   // = latestPair + diffObservations
```

### ★ latestPair 不做可比性过滤

这是刻意的。若在这里就把「上次没观测到」的那条跳过，
`UNOBSERVABLE → NOT_MENTIONED` 就永远不会出现在 diff 里 ——
而那恰恰是最需要被解释清楚的一类迁移。
**过滤是 diff 的事，取数是 store 的事**，两者不得互相替对方做决定。

实现：`listObservations({ order: "asc" })` 取最后两条。升序下稳定排序保留写入顺序，
因此同一时间戳的先后顺序是确定的（后写的在后）。

> `latestPair` 放在 `src/lib/diff.ts` 而不是扩 `Store` 接口 ——
> S2 的 `Store` 契约已冻结，不为新增读取能力动它。

---

## 7. 文件

```text
NEW       src/lib/diff.ts       diffObservations / assessComparability / latestPair / diffLatest
NEW       scripts/test-diff.ts  115 项契约测试
NEW       docs/PHASE-1-S6.md
MODIFIED  package.json          test:diff
```

**未改**：`src/lib/evidence/types.ts`（S1）· `src/lib/store/jsonl.ts`（S2）·
三个 Observer · `serp.ts` / `audit.ts` / `visibility.ts` · `analyze()` · baseline。

---

## 8. 测试（115 项）

```text
1 · 可比性 gate    observer/parser/prompt 版本 · subject/type 一致性 · 状态集合
2 · ★ 核心验收     17 组不可判定迁移（含 UNOBSERVABLE→NOT_MENTIONED）
                  每组断言 comparable=false 且 improved=degraded=0
3 · 状态方向       NOT_MENTIONED↔MENTIONED improved/degraded；同状态无 change
4 · 数值阈值       +4 neutral / +6 improved / -11 degraded / 非数值 unknown
5 · targetRank     null→8 improved · 8→null degraded · null→null 无 · 3→4 neutral · 3→7 degraded
6 · 集合           ADDED/REMOVED 内容正确且方向 neutral；citedDomains 同理
7 · 元信息         COVERAGE=unknown · VERSION 且仍可比 · EVIDENCE=neutral
8 · 边界           missing_previous / 双空 / 只有 previous
9 · Store          空库 · 单条 · type 隔离 · 取最后两条 ·
                   ★ latestPair 不过滤 UNOBSERVABLE · diffLatest 端到端 · source 过滤
```

---

## 9. Contract Protection

```text
S1 contract:          unchanged（types.ts 未动；未新增 ObservationStatus）
S2 contract:          unchanged（Store 接口未扩；latestPair 落在 diff 模块）
ObservationKind:      unchanged
ObservationStatus:    unchanged（NOT_FOUND 仍不存在，语义由 targetRank=null 承载）
replaces semantics:   unchanged（diff 只读历史，不写）
analyze():            unchanged
baseline:             unchanged
```

---

## 10. 已知限制

```text
W-1  S6 未接线到 HTTP / MCP —— 取数入口只有 src/lib/diff.ts。对外开放是 S7 的事。
W-2  只支持「最近两条」比较。跨批次（两个 runId）diff 尚未提供，需再加查询参数。
W-3  集合 diff 取的是全量集合。长期运行的榜单每次都会有几条增删noise，
     S7 若要做趋势图，需要先给它加一个「仅关注目标相关主体」的过滤器。
W-4  rank 的有效性（24h validUntil）记录在 metadata 里，diff **并未**据此标 stale ——
     设计稿 D8 提到这点，但引入 stale 需要 Sampling 频率的配套决策，留给 S7。
W-5  阈值（score ±5 / rank ±3）目前是拍脑袋定的。拿到真实时间序列后应回归校准。
```
