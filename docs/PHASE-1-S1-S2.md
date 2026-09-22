# Phase 1 · S1 + S2 —— Contract 与 Store

> 日期：2026-09-22 ｜ 基线：`phase0-frozen`（`98d1c17`）
> 范围：**只做 S1（Contract）+ S2（Store / JsonlStore）**。未进入 S3–S8。
> 状态：待人工 review，**未 commit**。

---

## 0. 本轮改了什么

| 类型 | 文件 | 说明 |
|---|---|---|
| 新增 | `src/lib/evidence/identity.ts` | canonical `subject` / `source` 唯一构造入口 + 引擎策略版本 |
| 新增 | `src/lib/evidence/normalize.ts` | 旧 Phase 0 记录 → canonical Evidence（读取时归一化） |
| 新增 | `src/lib/evidence/ai-status.ts` | 六态计数与命中率的**唯一口径定义处** |
| 新增 | `src/lib/store/types.ts` | Store 接口（先定接口，不定 schema） |
| 新增 | `src/lib/store/jsonl.ts` | JsonlStore 实现 |
| 新增 | `src/lib/store/retention.ts` | retention 策略（只设计，不清理） |
| 新增 | `src/lib/store/hash.ts` | 确定性 hash / key 构造 |
| 新增 | `src/lib/store/index.ts` | 装配入口（**尚未接入任何 route / MCP**） |
| 新增 | `scripts/test-store.ts` | 116 项契约测试，零新增依赖 |
| 修改 | `src/lib/evidence/types.ts` | +`Evidence` canonical 视图、Observation 升级、六态、Coverage |
| 修改 | `src/lib/evidence/store.ts` | `evidenceFromFetch` 产出 canonical 字段（旧字段全保留） |
| 修改 | `src/lib/fetcher/index.ts` | +`subject` / `source` / `runId`（可选，行为零变化） |
| 修改 | `src/lib/serp.ts` | `fetchHtml` 多传 keyword / targetDomain **仅进 meta**，不碰解析逻辑 |
| 修改 | `src/lib/visibility.ts` | AI 调用点显式传 slot 身份；报告新增 `statusCounts` |
| 修改 | `src/lib/mcp.ts` | 输出新增 `statusCounts`（旧字段全保留） |
| 修改 | `package.json` | +`npm run test:store` |

**没有**新增 Observer、没有 Diff、没有 SQLite、没有 UI、没有新 MCP 工具、没有 Auto Fix。

---

## 1. Contract 最终定义

### 1.1 Evidence

> Evidence 表达「**发生过什么**」。不解释为什么。

```ts
interface Evidence extends RawEvidence {   // 旧字段全保留
  id: string;
  contractVersion: string;      // 0.2.0
  kind: RawEvidenceKind;        // serp_html | page_html | robots_txt | llms_txt | llm_response | redirect_resolve
  subject: string;              // 被观测对象（canonical）
  source:  string;              // 观测来源（canonical）
  observedAt: string;           // = timing.requestedAt
  status: number;               // HTTP 状态码；0 = 无响应
  provenance: EvidenceProvenance;
  contentHash: string;          // body 不留存时，它是内容唯一指纹
  bodyRef: string | null;
  metadata: EvidenceMetadata;   // purpose / engine / strategyVersion / requestedModel / servedModel / extra
  runId?: string;
  dedupeKey?: string;           // 由 Store 写入
  migratedFrom?: string;        // 由旧契约归一化而来时记录来源版本
}
```

**绝不能放进 Evidence 的东西**（放进就等于把结论焊死成事实，失去重算能力）：

- SEO Score / GEO Score —— 是 Observation
- SERP rank / targetRank —— 是 Observation
- AI mention 判定 —— 是 Observation
- robots 策略解读、llms.txt 完备性判断 —— 是 Observation
- 任何「好不好」「第几」「有没有」的评价性结论

**immutable 语义**（仅适用于 Evidence，Observation 见 1.2）：

- Store 接口里**没有 update / delete**（测试已断言方法列表）
- 重复写入命中去重时不覆盖，返回已有 id
- 读取返回深拷贝，调用方改返回值不污染存储
- **Evidence 磁盘文件是 append-only JSONL**，只追加、从不重写

**body：blob reference，不是内联**。`bodyRef` 指向 `blobs/<id>.txt`；`bodyRetained=false` 时只留 `contentHash`。SERP HTML 单份约 1.6MB，内联会让 JSONL 迅速不可用。

**secret 脱敏**：沿用 Phase 0 的 `redact.ts`（`Authorization` → `[REDACTED]`，含 Gemini `?key=` 查询串防护）。请求体**只记长度不落原文**。

### 1.2 Observation

> Observation 表达「**Observer 根据 Evidence 得出的结论**」。带版本、带置信度、带覆盖度。

```ts
interface Observation<T = unknown> {
  id: string;
  contractVersion: string;      // 0.2.0
  type: ObservationKind;        // rank | geo_score | ai_mention | robots_policy | llms_txt
  kind?: ObservationKind;       // @deprecated 旧字段名，仅兼容
  subject: string;              // 与 Evidence.subject 同一 canonical 空间
  source: string;               // 与 Evidence.source 同一 canonical 空间
  observedAt: string;
  runId?: string;               // 「重算」与「新一次观测」的判定依据
  observerVersion: string;
  parserVersion: string;
  strategyVersion?: string;     // 如 baidu-mu@1
  evidenceRefs: string[];       // ★ 指回原始素材
  status: ObservationStatus;
  result: T;
  confidence: Confidence;       // high | medium | low | unavailable
  coverage: Coverage;           // { expected, observed, ratio, missing? }
  metadata: ObservationMetadata;// requestedModel / servedModel / modelDrift / promptVersion / sampling
  caveat?: string;
  replaces?: string;            // 版本升级时指向被取代的那条
  identityKey?: string;         // 由 Store 计算
  versionKey?: string;          // 由 Store 计算
}
```

**与 Evidence 的边界**：Evidence 是输入，Observation 是输出，箭头单向。
Observation **永远可以**在不重新采集的前提下重算 —— 只要 `evidenceRefs` 还在、`parserVersion` 明确。

**confidence ≠ coverage**，两者不可互相替代：九个模型只观测到一个时，那个结论本身可能很准（high），但覆盖度只有 1/9。

### 1.2.1 持久化语义（★ 契约，SQLite / Diff 阶段不得重新解释）

两套语义，**不共用一条规则**。此前文档里「磁盘文件 append-only JSONL」与「同 runId 同版本物理替换」并列出现，容易在 S6/S8 被误读成「替换 = 可覆盖历史」或「Evidence 也能改」，故在此写死：

```text
Evidence
  immutable
  append-only
  duplicate write 不覆盖原 Evidence

Observation
  是 Evidence 的派生 materialized result
  支持同 identity + 同版本的幂等重算
  同 run + 同版本      → 保持原 id 的 materialized replacement
  不同 run 或不同版本  → 新历史记录
```

落点：

- Evidence 的 append-only **不变**：`raw-*.jsonl` 只追加、从不重写。
- Observation 的 replacement **不是 update，也不删除历史**：它只发生在「同一 run + 同一版本」这一个格子内，那个格子里本来就只存在一条记录，被替换掉的是这条记录的中间态，不是一条独立历史。
- 跨 run 或跨版本一律**追加新记录**，原记录保留，`replaces` 指向被取代的那条 —— 时间序列完整。
- Observation 的替换**不触及 Evidence**：只读 Evidence 的 id，不写不删（测试已断言替换前后 Evidence 条数不变）。
- 不要用一方反推另一方：不能因为 Observation 可替换就说「文件可覆盖」；也不能拿 Evidence 的 append-only 要求 Observation 不可重写。二者管的是不同性质的东西 —— **事实 vs 结论**。

### 1.2.2 契约版本 = 0.2.0，不做 migration

`OBSERVATION_CONTRACT_VERSION = "0.2.0"`。0.2.0 涵盖 `subject` / `source` / `runId` / `observerVersion` / `parserVersion` / `strategyVersion` / `evidenceRefs` / `status` / `confidence` / `coverage` / `metadata` / `caveat` / `replaces` / `identityKey` / `versionKey`。

**不做 migration**：本仓库当前没有任何 Observation 生产记录（S1 之前 Observation 没有生产构造点），没有旧数据需要迁移。`0.1.0` 仅作为历史版本号保留在注释里，不提供读取侧归一化路径 —— 与 Evidence 侧的 `normalizeEvidence()` 不同，那是为已经落盘的 Phase 0 旧文件准备的。

### 1.2.3 replaces 语义边界

`replaces` 表示「**版本演进**」，不表示普通 retry，也不表示重复写入。

| 情况 | 是否新记录 | `replaces` |
|---|---|---|
| 同 identity + 同三元组 + 同 run | ❌ 幂等替换（id 不变） | 沿用原值，**不产生新的 replaces 关系** |
| `observerVersion` / `parserVersion` / `strategyVersion` 任一变化 | ✅ 新 Observation | 指向被它取代的那条 |
| 不同 run + 同版本 | ✅ 新历史记录 | **不建链** —— 那是时间推进，不是版本演进 |

第三条是本轮**唯一的行为修正**（`jsonl.ts` 新记录分支）：原实现对「同 identity 的上一条」无条件建链，等于把 `replaces` 降级成「最新指针」，会把时间维度和版本维度混在一起 —— S6 Diff 就没法用它做口径迁移判定。现在只有当上一条是**不同版本三元组**算出来的，本条才算取代它。

取代链只在版本演进时增长，因此「parser v1 → v2 → 再重算 v2」不会让链变成两条，v2 的 `replaces` 始终指向 v1。

### 1.3 AI 观测六态

```text
UNOBSERVABLE    无观测条件（未配 key）—— 需要配 key
BLOCKED         被厂商拒绝（401/403/429）—— 需要换策略
ERROR           我方故障（网络/超时/解析）—— 需要修代码
MENTIONED       提到了          ┐
NOT_MENTIONED   没提到          ┘ 可判定 → 进命中率分母
INDETERMINATE   拿到响应但无法判定（拒答/答非所问）—— ★ 不进分母
```

`INDETERMINATE` 是 S1 新增的第六态。它覆盖此前被 `includes(brand)` 误判为 `NOT_MENTIONED` 的情形 —— 那等于把「厂商不肯说」记账成「厂商不知道」。

**★ S1 只定义状态，不生产它**：现有 `buildObservedProbe` 仍只产出五态（禁止 AI Observer 重构）。第六态由 S5 落地。

### 1.4 AI slot：观测对象 = provider + requestedModel

```text
subject        = ai-slot:deepseek:deepseek-chat
requestedModel = deepseek-chat        ┐
servedModel    = deepseek-flash       ┘ 作为 provenance 保留，不做 identity
```

**为什么不用 servedModel 做 identity**：servedModel 是厂商的路由结果，任何一天都可能变（已实测：请求 `deepseek-chat` 实际由 `deepseek-flash` 应答）。若历史 identity 挂在 servedModel 上，厂商一次路由调整就会把时间线切成两段无从比较的数据。

`requestedModel` 表达的是「我们要求观测哪个槽位」，这才是稳定的观测对象。`modelDrift` 标记负责提示「厂商改过路由，跨期比较需留意」。

---

## 2. Migration / Compatibility 策略

**原则：Phase 0 已冻结，只做加法。**

| 面 | 策略 |
|---|---|
| 旧 `target` 字段 | **不删除**。新记录继续写，旧读者行为零变化。标记 `@deprecated` 并注明语义分裂原因 |
| 旧 Evidence 文件 | **不改写**。读取时由 `normalizeEvidence()` 归一化，磁盘字节不变（测试已断言） |
| 旧索引需求 | 归一化后 `subject` / `source` 必定齐全，可直接建索引 |
| 版本识别 | `contractVersion`：`0.1.0` = 旧，`0.2.0` = 新。归一化产物带 `migratedFrom` |
| Observation 版本 | 定为 `0.2.0`。**不做 migration** —— 当前无 Observation 生产记录（见 §1.2.2） |
| 旧 API / MCP | 字段只增不减。`observedCount` 保留，恒等于 `statusCounts.determinableCount` |
| SERP 解析 | 三家引擎 `mu` / `data-mdurl` / `citeLinkClass` **一条未动**；只多传了 provenance 用的 meta |
| SERP rank 算法 | 未改。regression 与 baseline 完全一致 |

**归一化推导表**（`deriveSubjectSource`）：

| purpose | 旧 target 的真实语义 | subject | source |
|---|---|---|---|
| `serp` | 来源 | `search:site=<url>|q=<keyword>` | `search-engine:baidu` |
| `ai-visibility` | 来源 | `ai-slot:<provider>:<model>` | `provider:deepseek` |
| `audit` / `robots` / `llms` / `resolve-redirect` | 被观测对象 | `site:<url>` | `http:<origin>` |

调用方显式传 `subject` / `source` 时以显式值为准；AI 与 SERP 通道已显式传，其余走推导。

---

## 3. Store Interface

先定接口、不定 schema。签名全为 `async` —— 将来换 SQLite / Postgres 时调用方一行不用改。

```ts
interface Store {
  // Evidence
  saveEvidence(ev, opts?): Promise<SaveResult>;
  getEvidence(id): Promise<Evidence | null>;
  listEvidence(q?: EvidenceQuery): Promise<Evidence[]>;
  findEvidenceBySubject(subject, opts?): Promise<Evidence[]>;
  findEvidenceBySource(source, opts?): Promise<Evidence[]>;
  findEvidenceByRun(runId, opts?): Promise<Evidence[]>;
  findEvidenceByTimeRange(from, to, opts?): Promise<Evidence[]>;

  // Observation
  saveObservation(obs, opts?): Promise<SaveResult>;
  getObservation(id): Promise<Observation | null>;
  listObservations(q?: ObservationQuery): Promise<Observation[]>;
  findObservationsBySubject(subject, opts?): Promise<Observation[]>;
  findObservationsBySource(source, opts?): Promise<Observation[]>;
  findObservationsByRun(runId, opts?): Promise<Observation[]>;
  findObservationsByTimeRange(from, to, opts?): Promise<Observation[]>;
}
```

**查询维度 = subject / source / runId / time**，四个正交维度。`ObservationQuery` 另有 `type`、`status`、`latestOnly`。

**关联方式**：Observation 通过 `evidenceRefs: string[]` 指向 Evidence id —— 单向引用，Evidence 不知道谁用了它。这样删掉一个 Observer 不影响 Evidence。

**SaveResult**：`{ id, created, duplicateOf?, replaced? }`。

---

## 4. JsonlStore

```
<root>/
  raw-YYYY-MM-DD.jsonl    Evidence（Phase 0 同名同格式，旧文件可直接读）—— append-only，从不重写
  blobs/<id>.txt          body 原文
  observations.jsonl      Observation —— 物化投影，允许整体重写（语义见 §1.2.1）
```

默认 root = `GEOKIT_STORE_DIR` ?? `.evidence`（**与 Phase 0 同一目录**，旧文件无需搬迁）。

**刻意不做索引文件**：全量扫描是 O(n)，几万条以上会变慢。这是可接受的 —— JSONL 的目的是验证语义，不是跑生产。Phase 1b 换 SQLite 时接口不变，调用方零改动。

**已知限制**：单进程。跨进程并发写不做协调。

---

## 5. Idempotency 策略

> 幂等的行为差异来自 §1.2.1 的持久化语义：Evidence 是 immutable + append-only，
> Observation 是 Evidence 的 materialized result。两节的表格是那套语义的具体表现，不是两套规则。

### Evidence

去重作用域 = **runId**。

| 情况 | 行为 |
|---|---|
| 有 runId，同 kind/subject/source/URL/contentHash | 只存一条，重复写返回已有 id（`created:false` + `duplicateOf`） |
| 无 runId | **不去重**，每次追加 |
| 显式 `idempotencyKey` | 强制去重（逃逸口） |

**为什么无 runId 就不去重**：没有 runId 时无法区分「同一次观测的重试」和「新的一次观测」。强行按内容去重，今天和明天抓到同一份 SERP HTML 会被合并成一条 —— **时间维度直接没了**。宁可多存，不可错合。

### Observation

| 情况 | 行为 |
|---|---|
| 同 runId + 同版本三元组 | **materialized replacement，保持原 id**（同批次重算同一个观测，就是同一条记录；被替换的是它的中间态，不是一条历史，因此不算删除） |
| 不同 runId 或不同版本 | 追加新记录，历史完整保留；**仅版本演进时**新记录 `replaces` 指向被取代的那条（边界见 §1.2.3） |
| 显式 `idempotencyKey` | 已存在则不重复写 |

替换走「写临时文件 + rename」，避免中断留下半截文件。**只重写 `observations.jsonl`，不碰任何 `raw-*.jsonl`。**

版本三元组 = `observerVersion` + `parserVersion` + `strategyVersion`。

---

## 6. Retention 设计

**分层保留** —— 解决「1.6MB/份 SERP HTML」的成本问题，同时不丢结论：

| 层 | 保留期 | 说明 |
|---|---|---|
| metadata + contentHash | **永久** | 永远知道「那天抓过、内容 hash 是多少、得出什么结论」 |
| raw body blob | 短期 | serpRaw 30d / aiRaw 90d / siteRaw 30d |
| observation | **永久** | 结论本身不删 |

过期后不能再把原文翻出来逐行看 —— 这是**显式接受的成本**，不是疏忽。

默认值来自 `DEFAULT_RETENTION_POLICY`，可由 `GEOKIT_RETENTION=serpRaw=7,aiRaw=-` 覆盖（`-` = 永久）。

`planRetention()` 只回答「按当前策略哪些会被清掉」，**不执行任何删除**。本阶段不实现清理系统。

---

## 7. 测试结果

### S1/S2 契约测试（新增 `scripts/test-store.ts`）

```
通过 116 项，失败 0 项
```

十项要求逐条对应：

| # | 要求 | 覆盖 |
|---|---|---|
| 1 | Evidence 保存/读取 | ✅ id / subject / contentHash 完整回读 |
| 2 | Observation 保存/读取 | ✅ result / versionKey 保留 |
| 3 | subject/source 不混淆 | ✅ 查 `search-engine:baidu` 只命中「用百度查的」，查 `site:百度` 只命中「查百度的」 |
| 4 | runId 查询 | ✅ Evidence 与 Observation 均可按 run 聚合 |
| 5 | 时间范围查询 | ✅ 含端点、排序方向、limit |
| 6 | idempotency | ✅ runId 去重 / 无 runId 不去重 / 显式键 / Observation 替换 |
| 7 | Evidence immutable | ✅ 无 update/delete 方法；重复写不覆盖；深拷贝 |
| — | 契约版本 | ✅ Observation `0.2.0`、Evidence `0.2.0`（常量 + 落库值双重断言） |
| — | 持久化语义拆分 | ✅ 同 run 同版本可反复重算且 id 不变；替换不改动 Evidence 条数；跨 run 追加新历史 |
| — | replaces 语义边界 | ✅ 同 run 同三元组重算三次链不增长；parserVersion v1→v2 新记录且 `replaces` 指向 v1；v2 重算后仍指向 v1；同版本跨 run 不建链；全程 Evidence 条数与内容不变 |
| 8 | 六态可合法表达 | ✅ 六态全部落库、按 status 筛回 |
| 9 | INDETERMINATE 不进分母 | ✅ 加一个 INDETERMINATE 后命中率恒为 50 不变；分母 0 → score 0 而非 NaN |
| 10 | 旧 Phase 0 Evidence 兼容 | ✅ 补出 subject/source/provenance/contentHash，`migratedFrom=0.1.0`，**磁盘文件字节未变** |

外加：canonical 规范化、`deriveSubjectSource` 推导表、retention 计划。

### 既有防线（确认无回归）

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | ✅ 0 error |
| `regression.ts check` | ✅ 与 baseline 一致：百度 21 / 360 4 / 搜狗 9，畸形 0；审计 SEO 91 / GEO 70 / 11 |
| MCP stdio 冒烟 | ✅ 8 工具齐全 |
| `check_ai_visibility`（无 key） | ✅ `attemptedCount=9, unobservableCount=9, score=0`（非 NaN），旧 `observedCount` 保留 |
| `verify-ai-visibility.ts` | 17/18（唯一 FAIL 是「真实厂商调用」，本机零凭证，预期内） |
| production build | 见下 |

---

## 8. 已知限制

1. **Store 尚未接入任何 route / MCP**。本轮只交付契约与实现，接线是 S7 的事。目前没有任何生产路径会写 Store。
2. **六态只定义、不生产**。现有 AI 观测仍只产出五态（禁止 AI Observer 重构）。`INDETERMINATE` 由 S5 落地。
3. **`observedCount` 仍是兼容字段**，语义固定为 `determinableCount`。新代码应一律读 `statusCounts`。
4. **JSONL 全量扫描 O(n)**，单进程、无并发协调。这是刻意的：它只用于验证语义。
5. **无 runId 的 Evidence 不去重**，可能累积内容相同的记录。换取的是时间维度不被错误合并。
6. **SERP `site=` 取自 `targetDomain`（裸域名）**，未指定时为 `site=*`。canonical 化会补 `https://`，与 audit 通道的 `site:` 对齐；但若用户传的是子域名，两个通道仍会形成不同 subject —— S3/S4 需统一口径。
7. **`verify-ai-visibility.ts` 仍按五态统计覆盖**（显示 5/5）。六态覆盖由 `test-store.ts` 保证。
8. **retention 只出计划不执行**，且没有调度。真正清理需要后续阶段。
9. **`Observation` 契约仍无生产构造点**。S1 定义了它，S3–S5 才会真正产出。
10. **旧 `target` 字段仍在写**，且 serp / ai 通道写的是「来源」语义。这是为兼容 Phase 0 读者刻意保留的，不要在新代码里读它。

---

## 9. 未完成的 S3–S8

| 阶段 | 内容 | 状态 |
|---|---|---|
| S3 | Site Observer（page_html → site 观测） | 未开始 |
| S4 | Search Observer（serp_html → rank 观测，含三家引擎策略） | 未开始 |
| S5 | AI Observer（llm_response → ai_mention 观测，**产出第六态**） | 未开始 |
| S6 | Diff 引擎（可比性判定优先于数值比较） | 未开始 |
| S7 | 只读时间维度 API（Store 接线） | 未开始 |
| S8 | 换 SQLite（接口不变，实现可换） | 未开始 |

本轮**不自行进入**下一步。
