# Phase 1 / S4 — Search Observer

> 把 SERP 采集与位次解析，包装成 `rank` Observation。
>
> S4 是 **Observation adapter**，不是新的 SERP 解析器 —— 三家引擎的特殊解析一条未动。

---

## 1. 职责边界

### S4 做什么

把 `serp_html` Evidence + 已算好的 `SerpResponse`，映射成符合 S1 契约的
`rank` Observation，并通过 S2 的 Store 落库。**每个引擎一条，不做跨引擎合并。**

### S4 不做什么

| 不做 | 归属 |
|---|---|
| 抓 SERP 页面 / 跟随中转重定向 | `serp.ts`（采集层） |
| 解析位次、三家特殊解析 | `serp.ts`（未改动） |
| 跨引擎聚合（averageRank / bestRank） | `services/serp.ts`，读取时算 |
| `redirect_resolve` Evidence | 未纳入（该通道 `readBody:false`，无正文可留存） |
| 定义字段与身份 | S1（已冻结） |
| 实现存储 | S2（已完成） |
| AI 提及 | S5 |
| Diff / 时间 API / SQLite / UI | S6 / S7 / S8 / 禁止项 |

### 与 S3 的一处结构性差异

S3 的 Observer **内部调用** `analyze()`（纯函数，不需要网络）。
S4 **不调解析器** —— SERP 位次解析依赖网络（中转链接要跟随重定向才能拿到
真实域名），塞进 Observer 就违反「Observer 不直连采集层」。
解析在 `serp.ts` 完成，Observer 只消费结果，每条结论仍通过
`evidenceRefs` 指回原始素材。

---

## 2. 为什么按引擎拆开存

跨引擎平均位次是**聚合结论**，它的口径随「选了哪些引擎」变化。
存聚合值会让历史在引擎增减时断裂。

因此：**存单引擎事实，聚合在读取时算**。

subject 不含引擎（被观测的是「某站点在某词下的表现」），
source 是 `search-engine:<engineId>`（观测来源）——
不同引擎天然是不同 identity，不需要把引擎塞进 subject。

---

## 3. 契约落点

| 项 | 值 |
|---|---|
| 输入 Evidence | `serp_html`（契约已有此 kind；多页时按页序累积成多条） |
| 输出 Observation | `rank` |
| subject | `search:site=<url>\|q=<keyword>`（未指定域名时 `site=*`） |
| source | `search-engine:<engineId>` |
| strategyVersion | `baidu-mu@1` / `so360-data-mdurl@1` / `sogou-citeLinkClass@1` |
| observerVersion | `search-observer@0.1.0` |
| parserVersion | `serp-parser@1.0.0`（Phase 0 已冻结的解析口径） |
| runId | 不设（一次独立采集 = 一条新历史） |

> 设计稿 §7.2 写的 subject 是 `keyword_engine` 形式、observerVersion 是
> `search-observer@1.0.0`。设计稿写于 S1 之前，**以 S1 冻结契约为准**：
> subject 走 canonical `search:` 空间；observer 版本对齐 S3 的 `0.1.0`
> （两者同为 Phase 1 首批试运行 Observer）。

---

## 4. 状态映射（★ 最容易搞错的一处）

| SerpStatus | ObservationStatus | 说明 |
|---|---|---|
| `ok` + 上榜 | `OBSERVED` | 抓到且上榜 |
| `ok` + **未上榜** | `OBSERVED` + caveat | **真实结论**，不是失败 |
| `no_results` | `UNOBSERVABLE` | 页面可能改版或是验证页，**无从判断是否上榜** |
| `blocked` | `BLOCKED` | 被限流 / 验证码 |
| `error` | `ERROR` | 采集失败 |

**关键区分**：设计稿 §7.4 把「未上榜」和「no_results」都定为 `NOT_FOUND`，
但 S1 冻结的 `ObservationStatus` **没有 `NOT_FOUND`**，且 S3 已明确不为它新增。
因此沿用 S3 处理 404 的方式：目标不在，是**对象的事实**，不是我方的故障。

而 `no_results` 完全不同 —— 一条结果都没解析出来，说明页面结构变了或
返回的是验证页。此时若记成「未上榜」，就是**用解析失败冒充结论**。
记 `UNOBSERVABLE`，caveat 写明原因。

---

## 5. 硬门槛：hash-only 不产结论

```ts
if (evidences.length === 0) return { ok: false, ... };
const notRetained = evidences.find((e) => !e.response.bodyRetained);
if (notRetained) return { ok: false, ... };
```

与 S3 完全同构：只有 hash 没有正文，将来无法重放，也就无法验证
「当时到底解析出了什么」。不接受用 hash 冒充观测成功。

### ⚠️ 与设计稿 D7 的偏离（有意）

设计稿 §14.2 建议 **SERP HTML 默认 hash-only**（100 词 × 每周 ≈ 1GB/月）。
但那与「结论必须能指回可重放素材」直接冲突 —— hash-only 下 S4 永远产不出结论。

**决定**：SERP 通道存证时留存正文，磁盘代价由 `GEOKIT_EVIDENCE` 总闸控制
（默认 off，默认行为零变化）。这与 S3 的处理方式一致。

---

## 6. confidence 上限是 medium

即便 coverage 满格也不给 `high`：SERP 波动大，单引擎单次采样（N=1）
不具备统计意义。设计稿 §7.5 同样要求上限 medium。

---

## 7. 时效性：validUntil

SERP 排名是**瞬时快照**，受个性化、地域、时间、A/B 测试影响。
Phase 1 禁止把 rank 表述为「当前排名」这类永久事实。

每条 rank Observation 带 `validUntil = observedAt + 24h`。
契约没有顶层 `validUntil` 字段，也不为它扩 S1 —— 写在
`metadata.extra.validUntil`。

---

## 8. 三家引擎解析策略

| 引擎 | 解法 | 策略版本 |
|---|---|---|
| 百度 | 容器上的 `mu` 属性 | `baidu-mu@1` |
| 360 | `data-mdurl`（含 inner 正则兜底） | `so360-data-mdurl@1` |
| 搜狗 | `citeLinkClass` / `citeurl` 可见文本 | `sogou-citeLinkClass@1` |

`source.strategyVersion` 记录每家的策略版本，将来某家改版导致解析失效时，
能精确定位是**哪一家的哪一版策略**出问题，而不是笼统说「parser 升级了」。

### 🔧 实施中修掉的一个真 bug

`SERP_STRATEGY_VERSIONS` 的 key 写成了 `"360"`，而引擎 id 是 **`so360`**
（`engines.ts:81`）—— `serpStrategyVersion("so360")` 恒为 `undefined`，
360 的解析口径**根本记录不进 provenance**。

修法：保留 `"360"` 兼容早期写法，新增 `"so360"` 指向同一策略。
两个 key 都留着 —— 少任何一个，最容易改版失效的那一家就无从追踪。

---

## 9. `replaces` 保护

```text
S4 MUST NOT MODIFY replaces semantics.
```

- S4 不计算、不查询、不设置 `replaces`
- 不按关键词覆盖历史 —— 无 `runId` 时恒走追加分支
- `JsonlStore.saveObservation()` 在构造落库对象时**无条件覆盖** `replaces`
  → S4 即便误传也会被改写

S4 对 `replaces` 只有间接影响：`parserVersion` / `strategyVersion` 变化时
Store 自动建链（如 `baidu-mu@1 → @2`）。这是既定语义的正当使用。

---

## 10. 文件

```text
NEW       src/lib/observers/search.ts       observeSearch() 纯映射 + recordSearchObservation()
NEW       scripts/test-search-observer.ts   56 项契约测试
NEW       docs/PHASE-1-S4.md
MODIFIED  src/lib/serp.ts                   采集后存证 + 落 Observation（解析逻辑零改动）
MODIFIED  src/lib/evidence/identity.ts      补 so360 策略版本 key（bug 修复）
MODIFIED  package.json                      test:search-observer
```

**未改**：`src/lib/evidence/types.ts`（S1 契约）、`src/lib/store/*`（S2）、
`src/lib/services/serp.ts`（聚合层）、三家引擎的解析代码、`analyze()`、baseline。

---

## 11. 测试（56 项）

```text
1 · 契约      contractVersion 0.2.0 / type=rank / 版本三元组 /
              evidenceRefs 指向真实 Evidence / observedAt 取自 Evidence
2 · Identity  subject 不含引擎 / source 不含关键词 /
              不同引擎 subject 相同而 source 不同 / 未指定域名 → site=*
3 · 状态      ok 上榜 → OBSERVED 无 caveat
              ok 未上榜 → OBSERVED + caveat（★ 不是失败）
              no_results → UNOBSERVABLE + caveat（★ 不是「未上榜」）
              blocked → BLOCKED / error → ERROR
4 · 硬门槛    无 Evidence → 不产结论 / hash-only → 不产结论
5 · 可信度    OBSERVED 时 confidence 上限 medium；非 OBSERVED → unavailable
6 · 存储      Observation 顶层无 body/html/response；result 不含原始 HTML；
              validUntil = observedAt + 24h 且写在 metadata
7 · Store     落库回读 / 无 runId 再采集 → 新历史且不建链 /
              strategyVersion 变化 → 新记录 + replaces 指向上一条 /
              Evidence 条数与 contentHash 不变（immutable）
8 · 策略版本  百度 / 360 / 搜狗 三家的策略版本；未知引擎不编造
```

三家引擎解析本身的回归由 `scripts/regression.ts` 覆盖（百度 21 / 360 4 / 搜狗 9，
畸形 0），不在本脚本重复。

---

## 12. Contract Protection

```text
S1 contract:         unchanged（types.ts 未动）
S2 contract:         unchanged（store/* 未动）
ObservationKind:     unchanged（rank 本就存在）
ObservationStatus:   unchanged（未新增 NOT_FOUND）
replaces semantics:  unchanged
analyze():           unchanged
三家引擎解析:          unchanged
baseline:            unchanged
```

---

## 13. 已知限制

```text
W-1  默认 off：GEOKIT_EVIDENCE 默认关闭 ⇒ 默认配置下 S4 不产 Observation。
     与 S3 同构，属预期行为。
W-2  磁盘：SERP HTML 体积大（单页可达 MB 级），开启存证后增长明显。
     retention 已定义策略但无执行器，S8 前不会自动清理。
W-3  redirect_resolve 未纳入 Evidence —— 该通道 readBody:false 无正文可留存。
     结果是「中转链接解析成了什么域名」这一步不可重放。
W-5  S1 已知缺陷（S3 已记录）：normalizeEvidence 会覆盖显式注入的 identity，
     serp.ts 与 audit.ts 各自做了兜底修正。建议 S7 前统一修。
```

---

## 14. 不在 S4 范围

```text
redirect_resolve Evidence · 跨引擎聚合存储 · AI mention（S5）·
diff（S6）· 时间/查询 API（S7）· SQLite（S8）· UI · planner · auto-fix ·
任何 SERP 解析逻辑改动
```
