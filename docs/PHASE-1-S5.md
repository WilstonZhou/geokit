# Phase 1 / S5 — AI Observer

> 把 `visibility.ts` 的探针结果，包装成 `ai_mention` Observation。
>
> S5 是 **Observation adapter + 补上第六态**，不是新的 LLM 调用层 ——
> `callProvider` / `parseAnswer` / 九个厂商协议一行未动。

---

## 1. 职责边界

### S5 做什么

把 `llm_response` Evidence + 已算好的 `VisibilityProbe`，映射成符合 S1 契约的
`ai_mention` Observation，并通过 S2 的 Store 落库。**每个槽位一条，不做跨模型聚合。**

外加把 S1 定义但没有生产者的第六态 `INDETERMINATE` 真正落地（`D3` 决策 A）。

### S5 不做什么

| 不做 | 归属 |
|---|---|
| 调模型 / 发 HTTP / 解析供应商响应 | `visibility.ts`（采集层，未改动协议代码） |
| 判断有没有提到品牌 | `buildObservedProbe`（S5 只补了低信号前置判定） |
| 跨模型聚合（命中率 / visibilityScore） | `buildVisibilityReport`，读取时算 |
| 多样本采样升级 confidence 为 high | 设计稿 §8.5 明确留待后续（观测策略） |
| 定义字段与身份 | S1（已冻结） |
| 实现存储 | S2（已完成） |
| Diff / 时间 API / SQLite / UI | S6 / S7 / S8 / 禁止项 |

### 与 S3 / S4 的一处结构性差异

三者都是「消费已算好的结论」，差异只在**距离网络有多远**：

```text
S3  site   Observer 内部调用 analyze()（纯函数）—— 结论可离线重放
S4  search 解析依赖网络（中转链接要跟随重定向），故在外面算好再喂进来
S5  ai     同样依赖网络，且多一层：判定需要先拿到 LLM 回答
```

所以 S5 与 S4 一样：**Observer 不碰请求，只消费 probe**。

---

## 2. 观测对象 = 槽位（`ai-slot`），不是「某品牌在某模型里」

```text
subject = ai-slot:deepseek:deepseek-chat     ← requestedModel
source  = provider:deepseek
```

`requestedModel` 而非 `servedModel`：厂商改路由不该切断历史时间线。
实测量：请求 `deepseek-chat`，服务端由 `deepseek-flash` 应答 ——
`servedModel` 记进 `metadata`，并置 `modelDrift = true`，供 S6 Diff 判断可比性。

> ⚠️ S1 冻结的 AI canonical space 就是槽位，**不含 brand / topic**。
> 因此不同品牌在同一模型上的观测共用一个 subject 时间线，
> 品牌与主题放在 `metadata.extra`（这是 S1 的既有取舍，S5 不改契约去绕开它）。

---

## 3. 契约落点

| 项 | 值 |
|---|---|
| 输入 Evidence | `llm_response` |
| 输出 Observation | `ai_mention` |
| subject | `ai-slot:<provider>:<requestedModel>` |
| source | `provider:<provider>` |
| observerVersion | `ai-observer@0.1.0` |
| parserVersion | `ai-visibility@0.1.0`（与 `visibility.ts` 同源，测试有防漂移断言） |
| strategyVersion | **不设** —— AI 通道没有「三家引擎那种链接提取策略」 |
| runId | 不设（一次独立调用 = 一条新历史） |

---

## 4. 六态直接映射，不做翻译

六态全部是 `ObservationStatus` 的成员，因此是**恒等映射**：

| AiObservationStatus | ObservationStatus | confidence |
|---|---|---|
| `MENTIONED` | `MENTIONED` | `medium` |
| `NOT_MENTIONED` | `NOT_MENTIONED` | `medium` |
| `INDETERMINATE` | `INDETERMINATE` | `unavailable` |
| `BLOCKED` | `BLOCKED` | `unavailable` |
| `ERROR` | `ERROR` | `unavailable` |
| `UNOBSERVABLE` | `UNOBSERVABLE` | `unavailable` |

对比 S4：那边需要把 `no_results` 翻成 `UNOBSERVABLE`（契约里没有 `NOT_FOUND`），
AI 这边不存在这个缺口 —— **少一层翻译就少一处口径漂移**。

### 4.1 ★ INDETERMINATE：第六态落地

判定抽成纯函数 `judgeAnswerSignal()`，三条规则：

```text
empty       回答（trim 后）为空
too_short   少于 AI_LOW_SIGNAL_MIN_CHARS（12）个字符
refusal     命中拒答模式
```

**拒答模式的每一条都必须含「无法给出」语义**，不得只看开场白：

```text
✅ 我无法推荐 / 无法提供 / 不能给出 …
✅ 抱歉，我无法… / 对不起，我不能…
✅ I'm sorry, but I can't recommend …
❌ 作为一个AI助手，我认为…   ← 这是开场白不是拒答，判成拒答会误杀
```

**最强的理由**：拒答句里经常带着品牌名 ——

> 「抱歉，我无法推荐具体的跨境支付厂商，**鲸汇通** 是否适合需要另行评估。」

旧实现的 `includes(brand)` 会把它判成 **MENTIONED**；
不含则判成 **NOT_MENTIONED**。两种都是把「厂商不肯说」记成了别的意思。
第六态下它一律是 `INDETERMINATE`，`mentioned` 恒为 `false`，
**不计入命中率分母**（`'拆分出新状态'`≠`'改变命中率'`）。

阈值刻意取小（12）且不追求精确：错杀一条真实回答的代价，
远高于放过一条敷衍回答 —— 后者还能靠更多样本修正，前者直接丢数据。

---

## 5. 硬门槛：指不回素材就不产结论

```ts
if (!evidence) return { ok: false, ... };
if (httpStatus > 0 && !evidence.response.bodyRetained) return { ok: false, ... };
```

与 S3 / S4 完全同构，连例外都一样：
**`status = 0`（网络层失败、根本没响应）仍产 Observation** ——
那种情况本来就没有正文可留，而「这次调用没能发生」本身必须留痕。

由此得到一条明确结论：

```text
未配 API key  →  没有请求  →  没有 Evidence  →  不产 Observation
```

这不是漏做。AI 通道最常见的默认态就是零凭证，若给它产「UNOBSERVABLE」结论，
等于用一条没有出处的数据冒充观测。**没有调用就没有结论。**

---

## 6. confidence 上限是 medium

可判定结论（`MENTIONED` / `NOT_MENTIONED`）**恒为 `medium`，永远不上 `high`**：
每个槽位仍是 N=1 的采样，厂商从不承诺逐字节一致（设计稿 §8.5）。

不可判定的四种（含 INDETERMINATE）一律 `unavailable`：
「是否提及」这个结论此时**并不存在**。虚报 medium 比不报更糟 ——
那等于把「没答」说成「答了没提」。

---

## 7. 存储纪律：正文只存在 Evidence 里

```text
Observation.result 不含 rawResponse，只留 rawResponseChars
```

理由同 S4 的「result 不含原始 HTML」：原始回答全文已经在 Evidence 的 blob 里，
Observation 再抄一份等于磁盘翻倍，还会在将来造成「两份不一致时该信谁」。

---

## 8. AI 通道接进 Store（含一处并发坑）

原本 `visibility.ts` 走 Phase 0 的 `recordFetch()`（legacy `appendRecord`）。
换 Store 不是洁癖，是必然：**Observation 必须能指回 Store 里的 Evidence，
而 legacy 那份压根不进同一个索引。**

### 🔧 并发坑：`observations.jsonl` 是全量重写式追加

九个探针若各自 `createStore()`，各自的实例只认识自己写的那几条，
 flush 时整个文件被覆盖 —— **一次矩阵跑完只剩最后一个槽位的结论**。

因此 `runVisibilityMatrix()` 建一个 Store 实例，通过 `ProbeContext` 传下去：

```ts
const store = evidenceEnabled() ? createStore() : undefined;
PROVIDER_LIST.map((p) => probeProvider(p, brand, topic, keys[p.id], store ? { store } : undefined));
```

单次调用（不传 ctx）时内部自建 —— 那种场景没有并发。

### storeRoot 的次级兜底

`storeRoot()` 补了 `GEOKIT_EVIDENCE_DIR` 兜底（排在 `GEOKIT_STORE_DIR` 之后）。
它是 Phase 0 就存在的变量名，`verify-ai-visibility.ts` 用它把素材隔离到临时目录；
少这一层，AI 通道改走 Store 后就会写回项目根。

---

## 9. `replaces` 保护

```text
S5 MUST NOT MODIFY replaces semantics.
```

- S5 不计算、不查询、不设置 `replaces`
- `JsonlStore.saveObservation()` 构造落库对象时**无条件覆盖** `replaces`
- 无 `runId` ⇒ 每次调用都是新历史，且不建链

⚠️ **`promptVersion` 不在版本三元组内**：改 prompt 不会产生 `replaces` 链。
它由 `metadata.promptVersion` 表达，**S6 Diff 必须自己比对它**才能判定可比性。

---

## 10. 文件

```text
NEW       src/lib/observers/ai.ts       observeAi() 纯映射 + recordAiObservation()
NEW       scripts/test-ai-observer.ts   65 项契约测试
NEW       docs/PHASE-1-S5.md
MODIFIED  src/lib/visibility.ts         第六态判定 + Evidence 接 Store + 落 Observation
MODIFIED  src/lib/store/index.ts        storeRoot 增加 GEOKIT_EVIDENCE_DIR 兜底
MODIFIED  package.json                  test:ai-observer
```

**未改**：`src/lib/evidence/types.ts`（S1 契约）、`src/lib/store/jsonl.ts`（S2）、
九个厂商的协议代码（`callProvider` / `parseAnswer`）、聚合口径、`analyze()`、baseline。

---

## 11. 测试（65 项）

```text
1 · 契约      contractVersion 0.2.0 / type=ai_mention / 版本三元组 /
              parserVersion 与 visibility 同源 / evidenceRefs 真实 /
              observedAt 取自 Evidence / 不设 replaces / runId / strategyVersion
2 · Identity  subject 用 requestedModel（不是 servedModel）/ modelDrift 记 metadata /
              servedModel 变化不影响 subject / promptVersion / sampling 快照
3 · 六态      六态恒等映射；INDETERMINATE 与 BLOCKED 的 caveat 措辞
4 · 硬门槛    无 Evidence 不产 / hash-only 不产 / status=0 例外与 S3 一致
5 · 可信度    可判定恒 medium 且永不为 high；其余 unavailable；coverage 分子分母
6 · 存储      result 不含 rawResponse 全文（只留 chars）/ 顶层无 body / extra 三件套
7 · Store     落库回读 / 无 runId 两次调用 → 两条历史且不建链 / Evidence 条数守恒
8 · 第六态    mock 端点端到端：拒答 / 过短 / 空 → INDETERMINATE，
              ★ 拒答文本含品牌也 mentioned=false；
              正常回答含品牌 → MENTIONED、不含 → NOT_MENTIONED（五态不退化）
9 · 低信号    纯函数 7 例（含「开场白提 AI 不算拒答」这条防误杀断言）
```

五态本身的不退化由 `scripts/verify-ai-visibility.ts` 兜底（仍 5/5，17/18，
唯一 FAIL 是「真实厂商调用」—— 本机零凭证，预期内）。

---

## 12. Contract Protection

```text
S1 contract:         unchanged（types.ts 未动）
S2 contract:         unchanged（jsonl.ts 未动；storeRoot 只加了一层 env 兜底）
ObservationKind:     unchanged（ai_mention 本就存在）
ObservationStatus:   unchanged（六态本是它的成员）
replaces semantics:  unchanged
visibility 协议代码:  unchanged
analyze():           unchanged
baseline:            unchanged
```

---

## 13. 已知限制

```text
W-1  默认 off：GEOKIT_EVIDENCE 默认关闭 ⇒ 默认配置下 S5 不产 Observation。
     与 S3 / S4 同构。
W-2  零凭证无 Observations：未配 key 时不发请求 ⇒ 没有 Evidence ⇒ 没有结论。
     这是刻意取舍（见 §5），但它意味着默认环境里 AI 时间线是空的。
W-3  prompt 变更不建 replaces 链：promptVersion 只在 metadata 里，S6 Diff 需自行比对。
W-4  AI 的 subject 不含 brand / topic（S1 冻结的 canonical space 就是槽位）。
     多品牌共用一条时间线，靠 metadata.extra.brand / topic 区分 —— S7 查询需注意。
W-5  低信号判定阈值是拍脑袋的：12 字符 + 拒答模式都是在没有真实多样本数据
     下的保守取值。拿到真实样本后应回归校准，并递增 parserVersion。
W-6  S1 已知缺陷（S3 已记录）：evidenceFromFetch 注入的 identity 会被 legacy
     normalize 覆盖。visibility.ts 与 audit.ts / serp.ts 一样做了兜底修正。
     建议 S7 前统一修。
W-7  Evidence 写路径现在是统一的了（AI 通道已迁出 legacy appendRecord），
     但 `evidence/store.ts` 的 recordFetch / appendRecord 仍在 —— 目前零调用点。
     建议 S7 前决定是否删除。
```
