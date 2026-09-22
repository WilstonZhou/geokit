# Phase 1 —— 数据架构设计

> 状态：**设计稿，等待人工 review**
> 本轮只做分析与设计，**未修改任何业务代码、未实现存储、未新增 Observer**
> 基线：`phase0-frozen`（`98d1c17`）｜ 当前扫描对象：`main` @ `5e36e2b`

---

## 1. 当前架构与问题

### 1.1 扫描范围与事实

本节全部结论来自当前代码的重新扫描，**不沿用 Phase 0 文档的既有描述**。
凡与旧文档冲突处，已在 §1.3 明确指出。

| 对象 | 规模 | 现状 |
|---|---|---|
| `src/lib/*.ts` + `src/app/api/*/route.ts` | 4472 行 | 全部为**即时计算** |
| `src/lib/evidence/` | 418 行（3 文件） | 契约 + JSONL 追加写 |
| `src/lib/services/` | 191 行（2 文件） | serp / visibility 两个 service |
| `scripts/` | 879 行（4 文件） | fixture 抓取 / 回归 / MCP stdio / AI 验证 |
| 持久化 | — | **除 evidence 外零持久化**（已 grep 确认无 `writeFile` / sqlite / prisma） |

### 1.2 Phase 0 真正建成了什么

必须承认的地基，Phase 1 全部建立在它之上：

1. **Fetcher 统一**——9 处裸 `fetch` 收敛为 `fetchWithPolicy()` 唯一出口
2. **Evidence 契约**——`RawEvidence` 不可变，敏感头脱敏，失败也落证
3. **Service Layer**——HTTP 与 MCP 共用 `services/serp.ts`、`services/visibility.ts`
4. **AI 可复现性**——统一采样参数、`rawResponse` 全文留存、prompt 版本化、五态
5. **Regression**——三家引擎 fixture + baseline 锁定

### 1.3 ⚠️ 扫描中发现的、与旧描述不符的事实

**发现 1：`Evidence` 覆盖面只有 1/4，不是"已建成"**

全仓 `recordFetch` 的调用点只有一处：

```
src/lib/visibility.ts:346   ← 仅 AI 可见性通道
```

`serp.ts` / `audit.ts` / `llms.ts` 虽然都走统一 Fetcher，但**都没有存证**。
也就是说：SERP HTML、页面 HTML、robots.txt 这三类最重要的原始素材，
目前**抓取即丢弃**。没有它们，Search Observer 与 Site Observer 根本无从重放。

**发现 2：`Observation` 契约零使用**

`Observation` 接口在 `evidence/types.ts:131` 定义完整，但全仓没有任何构造点：

```
grep "Observation\b|sourceEvidenceIds" src/  →  除类型定义外零命中
```

`PageAudit`、`SerpResponse`、`VisibilityReport`、`RobotsAnalysis`、`LlmsTxtAnalysis`
全部是**直接返回的业务结构体**，没有经过 Observation 封装。
Phase 0 文档 §10 风险 #5 已承认这点，但它不是"低风险遗留"，而是 **Phase 1 的主工程量**。

**发现 3：Store 是单向黑洞**

`evidence/store.ts` 只有写，没有读：

```
appendRecord()      ✅
recordFetch()       ✅
hasEvidenceFiles()  ✅（只判断目录存在）
getEvidence()       ❌ 不存在
listEvidence()      ❌ 不存在
```

Evidence 写进去就取不出来。这不是"还没做查询需求"，是**能力缺失**——
连"某域名上次观测是什么时候"都答不上来。

**发现 4：`target` 字段语义分裂（★ 最关键，直接影响 Phase 1 索引设计）**

同一个 `Evidence.target` 字段，在不同通道里装的是**完全不同类别的东西**：

| 通道 | 代码位置 | `target` 实际值 | 语义 |
|---|---|---|---|
| SERP | `serp.ts:64` | `engine.id`（`baidu`） | **观测源** |
| AI | `visibility.ts:482` | `p.id`（`deepseek`） | **观测源** |
| audit | `audit.ts:105` | `normalized`（被审计 URL） | **被观测对象** |
| llms | `llms.ts:166/294/414` | `robotsUrl` / `url` / `base` | **被观测对象** |

`store.ts:77` 的兜底 `res.context.target ?? redactUrl(...)` 进一步模糊了它。

这在 Phase 0 不痛（只有 AI 通道写盘），但 Phase 1 一旦要按 `target` 建索引、
做 `listObservations(subject)` 查询，**"查 baidu"会同时命中"用百度查的"和"查百度的"**。
必须在写第一行查询代码之前解决。

**发现 5：body 存储成本被低估**

`tests/fixtures/serp/baidu.html` = **1.6 MB**，`so360` 545 KB，`sogou` 579 KB。
若 SERP 全量留存 body，单关键词三引擎一次观测 ≈ 2.7 MB。
Phase 0 默认 `hash-only` 是对的，但 Phase 1 要靠 Evidence 重放，
就必须正面回答"哪些 body 值得留、留多久"。

**发现 6：Phase 0 文档 §10 风险 #3 已过期**

文档写「`BLOCKED` / `ERROR` 两条分支**未经真实触发验证**」。
实际情况：该风险已在冻结前用真实 DeepSeek key 验证过（五态 5/5、18/18 通过，
见 `scripts/verify-ai-visibility.ts`）。文档描述与现状不符。

> **仅报告，不修改**：本轮按约定不扩大范围，建议在 Phase 1 开工时顺手订正该条目。

**发现 7（待确认，非确定缺陷）：`NOT_MENTIONED` 缺少响应有效性校验**

`buildObservedProbe`（`visibility.ts:465`）的判定是：

```ts
const mentioned = brand.length > 0 && text.toLowerCase().includes(brand.toLowerCase());
```

`parseAnswer` 已拦截 `no_response_body` 与 `unparsable_response`（走 UNOBSERVABLE），
但**模型返回拒答或无实质内容**（如"作为一个 AI，我无法推荐具体厂商"）时，
`text` 非空、可解析，于是被判为 `NOT_MENTIONED` 并**计入命中率分母**。

这不是已确认 bug——「没提到就是没提到」本身是自洽的定义——但它会让
"模型拒绝回答"与"模型真的不知道"在数字上无法区分。**列为决策项 D3。**

### 1.4 核心问题总结

| # | 问题 | 后果 | Phase 1 是否解决 |
|---|---|---|---|
| P1 | Evidence 覆盖面 1/4 | 无法重放 SERP / 页面观测 | ✅ |
| P2 | Observation 契约空转 | 结论无版本、无可比性 | ✅ |
| P3 | Store 无查询能力 | 答不出"上次是什么" | ✅ |
| P4 | `target` 语义分裂 | 索引错乱 | ✅ |
| P5 | 无时间维度 | 从"分析器"到"观测系统"的缺失环节 | ✅ |
| P6 | body 成本未设计 | 磁盘失控 | ✅ |
| P7 | 文档与现状不符 | 误导后续判断 | ⚠️ 仅报告 |

---

## 2. Evidence Contract

### 2.1 定义

> **Evidence 记录发生了什么，不解释为什么。**

判断标准很简单：**这条数据能不能被"复述"而不需要任何推理？**
能 → Evidence。需要计算/判断/评分才能得出 → Observation。

### 2.2 现行契约的问题

`RawEvidence`（`types.ts:45`）结构本身是健康的，但有三处需要演进：

1. `target` 语义分裂（发现 4）→ 拆为 `subject` + `source`
2. 缺少独立的 `source` 字段——SERP/AI 把观测源塞进了 `target`
3. 字段命名与用户约定的契约词汇不齐：`observedAt` / `method` / `status` /
   `provenance` / `contentHash` 需显式化

### 2.3 建议契约（v0.2.0）

```ts
export const EVIDENCE_CONTRACT_VERSION = "0.2.0";

/**
 * 被观测对象 —— "我们在观测谁"。这是查询的主索引维度。
 */
export interface EvidenceSubject {
  /** 主体类型，决定 subjectId 的取值规范 */
  type: "domain" | "url" | "brand_topic" | "keyword_engine";
  /** 规范化后的标识：domain=whivi.com / url=https://… / brand_topic=鲸汇通|跨境支付 */
  id: string;
  /** 人类可读原值，便于排查（不做索引） */
  display?: string;
}

/**
 * 观测源 —— "这个事实从哪来"。与 subject 严格分离。
 * ★ 解决 target 语义分裂的核心：二者永不混用。
 */
export interface EvidenceSource {
  /** 采集通道 */
  channel: "serp" | "page" | "robots" | "llms" | "ai" | "redirect";
  /** 源标识：baidu / so360 / deepseek / direct */
  id: string;
  /** 引擎或厂商的内部解析策略版本（见 §12） */
  strategyVersion?: string;
}

export interface RawEvidence {
  /** ── 标识 ───────────────────────────────────────── */
  id: string;                       // ev_<24hex>
  contractVersion: string;          // 0.2.0
  kind: RawEvidenceKind;            // serp_html | page_html | robots_txt | llms_txt | llm_response | redirect_resolve

  /** ── 三元定位：谁 / 从哪来 / 何时 ─────────────────── */
  subject: EvidenceSubject;
  source: EvidenceSource;
  /** 事实发生时间（采集完成时刻），时间索引与 diff 的基准 */
  observedAt: string;

  /** ── 请求事实 ───────────────────────────────────── */
  request: {
    method: string;                 // GET / POST
    url: string;                    // 已脱敏
    headers: Record<string, string>; // 已脱敏
    bodyByteLength: number;         // 只记长度，绝不落请求体原文
  };

  /** ── 响应事实 ───────────────────────────────────── */
  response: {
    status: number;                 // HTTP 状态码（事实，非结论）
    finalUrl: string;               // 重定向后的最终 URL，已脱敏
    headers: Record<string, string>;// 已脱敏
    contentHash: string;            // body 内容哈希，用于完整性校验与去重
    byteLength: number;
    bodyRetained: boolean;
    bodyRef: string | null;         // blob 相对路径；bodyRetained=false 时 null
  };

  /** ── 过程事实 ───────────────────────────────────── */
  timing: {
    requestedAt: string;
    elapsedMs: number;
    waitedMs: number;               // 因限速而等待的时间
    attempts: number;
  };

  /** ── provenance ─────────────────────────────────── */
  provenance: {
    purpose: FetchPurpose;
    /** 采集器版本，便于识别"采集方式变了" */
    fetcherVersion: string;
    note?: string;
    meta?: Record<string, string | number | boolean | undefined>;
  };

  /** 采集失败时依然落证 —— 「抓不到」本身就是要留存的事实 */
  error?: { kind: string; message: string };

  createdAt: string;
}
```

### 2.4 字段归属判定表

| 字段 | 属于 Evidence？ | 理由 |
|---|---|---|
| HTTP 状态码 | ✅ | 客观事实 |
| 响应头、body 哈希、字节数 | ✅ | 客观事实 |
| 请求 URL、方法、耗时 | ✅ | 客观事实 |
| ** SEO 分 / GEO 分 ** | ❌ | 计算结果 → Observation |
| ** SERP 排名 `targetRank` ** | ❌ | 解析结论 → Observation |
| ** `mentioned` 布尔 ** | ❌ | 判定结论 → Observation |
| ** `status: ok/blocked` ** | ❌ | 这是对 HTTP 状态**的解释** → Observation |
| ** `fix` / `recommendations` ** | ❌ | 建议 → 不属于观测系统，属于 Auto Fix（Phase 1 不做） |
| 未脱敏的 API Key / Cookie | ❌ | 安全红线 |
| 第三方页面正文 | ⚠️ 仅 blob | 落盘需脱敏 + retention 约束 |

> 注意 `status` 的判断：`httpStatus=429` 是**事实**（进 Evidence），
> 而"这是限流、应该降频"是**解释**（进 Observation 的 `BLOCKED`）。
> 这条界线是 Evidence 与 Observation 最容易混淆的地方。

### 2.5 不可变性

**Evidence 是 immutable 的，没有例外。**

- 存储层**不提供** `updateEvidence` / `deleteEvidence`
- 纠正方式只有一种：写入一条新 Evidence，并在 `provenance.note` 说明它取代了谁
- 数据库实现时，只授予 `INSERT` / `SELECT`，不授予 `UPDATE` / `DELETE`

### 2.6 body 存储

**结论：blob reference，不内联。**

| 方案 | 评价 |
|---|---|
| 内联在 JSONL/DB 行内 | ❌ 单条 1.6 MB，查询必然拖垮 |
| **blob 外置 + DB 存 ref** | ✅ 推荐 |
| 只存 hash | ⚠️ 可用于校验，但**无法重放** |

推荐布局：

```
.evidence/
  raw-2026-09-22.jsonl      # metadata，小（~1KB/条），长期保留
  blobs/
    ev_xxx.txt              # body，大，按 retention 清理
```

### 2.7 Secret 脱敏

现有 `redact.ts` 策略正确（默认遮蔽未知敏感项而非白名单），**保持不变**，补充两点：

1. `redactUrl` 的敏感参数清单应加 `sig` / `signature` 之外的 `x-goog-api-key`
   类厂商自定义键——目前靠 `NAME_HINTS` 正则兜底，够用但需回归覆盖
2. **blob 落盘前必须二次校验**：HTML 正文里可能含有页面内嵌的 token / sessionId。
   建议对 `page_html` / `serp_html` 类 blob 在落盘时跑一次 `assertNoSecret`

### 2.8 Retention（详见 §14）

Evidence **metadata 长期保留**；**body blob 分层保留**。
删除 blob 不影响 metadata 与 `contentHash`——仍能证明"当时抓到了这个哈希的内容"。

---

## 3. Observation Contract

### 3.1 定义

> **Observation 是 Observer 根据 Evidence 计算出的、带版本的可解释结果。**

与 Evidence 的边界一句话概括：
**Evidence 回答"抓到了什么"，Observation 回答"这意味着什么、有多可信"。**

### 3.2 现行契约的问题

`Observation`（`types.ts:131`）是好的起点，缺三样东西：

1. **无 `observerVersion`**——只有 `parserVersion`。但"打分规则改了"和
   "解析逻辑改了"是两种变化，diff 时需要区分
2. **无 `coverage`**——无法表达"9 个模型只观测到 3 个"，而这正是判断
   数字能不能信的关键
3. **`status` 是 AI 专用枚举**——Site / Search Observer 无法复用

### 3.3 建议契约

```ts
export const OBSERVATION_CONTRACT_VERSION = "0.2.0";

/**
 * 统一状态域。
 *
 * 为什么需要它：AI 有五态、SERP 有 ok/blocked/no_results/error，
 * 两套枚举无法统一比较 —— 而 diff 的第一件事就是比较状态。
 * 因此设一层通用状态，各 Observer 的领域状态放在 domainStatus 里。
 */
export type ObservationStatus =
  | "OBSERVED"      // 拿到了可信结论
  | "PARTIAL"       // 部分拿到（覆盖不完整，结论可用但需打折）
  | "NOT_FOUND"     // ★ 观测成功但目标不存在（SERP 未上榜 / 页面 404）—— 这是结论，不是失败
  | "BLOCKED"       // 被观测源拒绝（限流 / 鉴权 / 欠费）
  | "ERROR"         // 我方或网络故障
  | "UNOBSERVABLE"; // 无观测能力（未配 key / 协议不支持 / 无法解析）

export interface Observation<T = unknown> {
  /** ── 标识 ───────────────────────────────────────── */
  id: string;                      // obs_<24hex>
  contractVersion: string;
  type: ObservationType;           // rank | geo_score | seo_score | ai_mention | robots_policy | llms_txt

  /** ── 三元定位 ───────────────────────────────────── */
  subject: EvidenceSubject;        // 与 Evidence 同一类型，保证索引一致
  source: EvidenceSource;
  observedAt: string;

  /** ── 血缘 ───────────────────────────────────────── */
  evidenceRefs: string[];          // ★ 指回 RawEvidence.id
  /** 该结论所属批次。一次"跑一轮全站"产生多条 Observation，靠它聚合 */
  runId?: string;

  /** ── 版本（任一变化 → 与历史不可直接比较）───────────── */
  observerVersion: string;         // 评分/聚合规则版本，如 site-observer@1.0.0
  parserVersion: string;           // 解析逻辑版本，如 serp-parser@1.0.0
  /** AI 观测专用 */
  promptVersion?: string;

  /** ── 结论 ───────────────────────────────────────── */
  status: ObservationStatus;
  /** 领域原生状态（AI 五态 / SERP 四态），保留以便领域内精确判断 */
  domainStatus?: string;
  result: T;

  /** ── 可信度 ─────────────────────────────────────── */
  /** ★ 覆盖度：请求了多少、成功了多少。判断数字能不能信的第一依据 */
  coverage: { requested: number; succeeded: number; failed: number };
  confidence: Confidence;          // high | medium | low | unavailable
  caveat?: string;

  /** ── 时效 ───────────────────────────────────────── */
  /** 结论的有效期。SERP 排名尤其短 —— 不得宣称为永久事实 */
  validUntil?: string;

  metadata?: Record<string, string | number | boolean | undefined>;
}
```

### 3.4 明确归属：这些都是 Observation，不是 Evidence

| 业务概念 | 类型 | 备注 |
|---|---|---|
| SEO Score（11 项检查） | `seo_score` Observation | 由 `page_html` Evidence 算出 |
| GEO Score（六维） | `geo_score` Observation | 同上 |
| AI mention（是否提及） | `ai_mention` Observation | 由 `llm_response` Evidence 算出 |
| **SERP rank** | `rank` Observation | 由 `serp_html`（+ `redirect_resolve`）算出 |
| robots 策略 | `robots_policy` Observation | 由 `robots_txt` Evidence 算出 |
| llms.txt 评分 | `llms_txt` Observation | 由 `llms_txt` Evidence 算出 |

### 3.5 与 Evidence 的边界（一条可执行的检查规则）

**把 Observation 序列化后，如果里面能找到任何在 Evidence 里不存在的"新事实"，
说明有结论混进了 Evidence；反之，如果 Observation 里出现了原始 HTML 或响应头，
说明有事实泄漏进了 Observation。**

---

## 4. Store Interface

### 4.1 设计原则

**先接口，后实现。** 接口定稳了，换存储不影响任何上层代码。
这也是为什么 Phase 1 可以先用 JSONL 跑通、再换 SQLite。

### 4.2 接口定义

```ts
export interface EvidenceQuery {
  subject?: Partial<EvidenceSubject>;
  source?: Partial<EvidenceSource>;
  kind?: RawEvidenceKind | RawEvidenceKind[];
  from?: string;                 // ISO，闭区间
  to?: string;                   // ISO，开区间
  contentHash?: string;
  limit?: number;                // 默认 100，上限 1000
  offset?: number;
}

export interface ObservationQuery {
  subject?: Partial<EvidenceSubject>;
  source?: Partial<EvidenceSource>;
  type?: ObservationType | ObservationType[];
  status?: ObservationStatus | ObservationStatus[];
  from?: string;
  to?: string;
  parserVersion?: string;
  observerVersion?: string;
  runId?: string;
  /** 每个 (subject, type, source) 只取最新一条 */
  latestOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface EvidenceStore {
  /** 追加写。immutable —— 无 update、无 delete */
  saveEvidence(ev: RawEvidence, body?: string): Promise<void>;
  getEvidence(id: string): Promise<RawEvidence | null>;
  listEvidence(q: EvidenceQuery): Promise<RawEvidence[]>;
  /** 取回 body；blob 已被 retention 清理时返回 null */
  readEvidenceBody(id: string): Promise<string | null>;
}

export interface ObservationStore {
  saveObservation(o: Observation): Promise<void>;
  getObservation(id: string): Promise<Observation | null>;
  listObservations(q: ObservationQuery): Promise<Observation[]>;
  /** ★ diff 的主入口：取某 subject+type 最近两条可比较的观测 */
  latestPair(
    subject: EvidenceSubject,
    type: ObservationType,
    source?: EvidenceSource
  ): Promise<{ previous: Observation | null; current: Observation | null }>;
}

export interface GeoStore extends EvidenceStore, ObservationStore {
  /** 统计，用于 coverage 面板与 retention 决策 */
  stats(): Promise<{
    evidenceCount: number;
    observationCount: number;
    blobBytes: number;
    oldestObservedAt: string | null;
  }>;
}
```

### 4.3 关键设计问答

**① 查询维度是什么？**

四个：
- `subject`（谁）— 主维度
- `type`（观测什么）— 次维度
- `observedAt`（何时）— 时间范围
- `source`（从哪来）— 细分维度（哪个引擎 / 哪个模型）

**② target 如何索引？**

★ 必须先完成 `subject` / `source` 拆分（发现 4）才能建索引。
建议复合索引：

```
idx_obs_subject_type_time  (subject.type, subject.id, type, observedAt DESC)
idx_obs_source             (source.channel, source.id, observedAt DESC)
idx_obs_run                (runId)
```

**③ observation type 如何索引？**

`type` 是低基数枚举（6 个），单独建索引意义不大，
放在复合索引第二列即可。

**④ 时间范围如何查询？**

统一用 `observedAt`（ISO 8601，UTC）。
注意：**不要用 `createdAt` 做业务时间查询** —— `createdAt` 是落盘时刻，
在补写历史数据时会与事实发生时间脱节。

**⑤ Evidence 与 Observation 如何关联？**

单向：`Observation.evidenceRefs[]` → `RawEvidence.id`。
**不建反向外键**——一条 Evidence 可以被多个 Observer、多个版本复用。
需要反查时用 `evidenceRefs` 的 JSON 包含查询。

**⑥ 如何保证 Evidence immutable？**

三层：
1. 接口层不暴露 update / delete
2. 类型层：`RawEvidence` 字段建议 `readonly`
3. 存储层：SQLite 建 `BEFORE UPDATE` / `BEFORE DELETE` 触发器直接 `RAISE(ABORT)`

**⑦ 如何处理重复写入？**

见 §13 idempotency。核心区分：
- **Evidence 默认不去重**（不同时刻采集 = 不同事实），但提供 `dedupeKey` 供上层复用判断
- **Observation 必须幂等**（同证据 + 同版本 = 同结论，重复写跳过）

**⑧ 是否需要 idempotency key？**

需要。见 §13。

---

## 5. Diff Model

### 5.1 目标

> **不是 JSON diff，而是"这两个结论能不能比、变了什么、算不算变好/变坏"。**

最关键的一条约束（用户明确提出）：

> **不能把 `UNOBSERVABLE → NOT_MENTIONED` 当成 SEO/GEO 下降。**

从"没观测到"到"观测到了但没提及"，语义是**覆盖度提升**，
不是**表现变差**。把它算成下降，会让任何"补齐 API key"的动作
在报表上显示为一次暴跌——这是会直接误导决策的错误。

### 5.2 变化类型

```ts
export type DiffChangeKind =
  | "VALUE"           // 数值变化（score / rank）
  | "STATUS"          // 状态变化（含可观测性变化）
  | "ADDED"           // 集合新增（新出现的引用域名、新上榜的引擎）
  | "REMOVED"         // 集合移除
  | "COVERAGE"        // 覆盖度变化（观测到的源数量变了）
  | "VERSION"         // parser / observer / prompt 版本变化
  | "EVIDENCE";       // 底层证据覆盖变化

export type DiffDirection = "improved" | "degraded" | "neutral" | "unknown";

export interface DiffChange {
  kind: DiffChangeKind;
  /** 结果内的路径，如 "result.averageRank" */
  path: string;
  previous: unknown;
  current: unknown;
  direction: DiffDirection;
  /** 数值型变化附带 delta 与相对变化 */
  delta?: number;
  /** 方向无法判定时的说明（如状态从 BLOCKED → OBSERVED） */
  note?: string;
}

export interface ObservationDiff {
  subject: EvidenceSubject;
  type: ObservationType;
  previousObservedAt: string | null;
  currentObservedAt: string | null;

  /** ★ 可比性判定 —— 这是 diff 最重要的字段 */
  comparable: boolean;
  incomparableReason?:
    | "missing_previous"
    | "status_not_observed"     // 至少一侧不是 OBSERVED
    | "parser_version_changed"
    | "observer_version_changed"
    | "prompt_version_changed"
    | "subject_mismatch";

  changes: DiffChange[];

  summary: {
    improved: number;
    degraded: number;
    neutral: number;
    unknown: number;
  };
}
```

### 5.3 可比性判定（核心规则）

```ts
function isComparable(prev: Observation, cur: Observation): boolean {
  if (prev.subject.id !== cur.subject.id) return false;
  if (prev.type !== cur.type) return false;

  // 版本必须一致 —— 口径不同就不是同一件事
  if (prev.observerVersion !== cur.observerVersion) return false;
  if (prev.parserVersion !== cur.parserVersion) return false;
  if (prev.promptVersion !== cur.promptVersion) return false;

  // ★ 只有两侧都真正观测到了，才谈得上"变化"
  const ok = (s: ObservationStatus) => s === "OBSERVED" || s === "NOT_FOUND";
  return ok(prev.status) && ok(cur.status);
}
```

`NOT_FOUND` 纳入可比范围很重要：
「上次没上榜 → 这次第 8 名」是一次真实的排名变化，
而「上次没抓到 → 这次第 8 名」不是。

### 5.4 状态迁移语义表

这张表是 Diff 的灵魂，**必须显式定义，不能靠 if-else 堆**：

| previous → current | 可比？ | 语义 | 方向 |
|---|---|---|---|
| OBSERVED → OBSERVED | ✅ | 真实变化 | 按 result 判定 |
| OBSERVED → NOT_FOUND | ✅ | 从有到无（如掉出榜单） | degraded |
| NOT_FOUND → OBSERVED | ✅ | 从无到有（如进入榜单） | improved |
| **UNOBSERVABLE → OBSERVED** | ❌ | **覆盖度提升，不是提升表现** | `unknown` |
| **UNOBSERVABLE → NOT_FOUND** | ❌ | **同上：从没看到到看到了但没有** | `unknown` |
| OBSERVED → UNOBSERVABLE | ❌ | 观测能力丢失，**不得判定为下降** | `unknown` |
| BLOCKED → OBSERVED | ❌ | 之前被拒，现在看到了 | `unknown` |
| OBSERVED → BLOCKED | ❌ | 被限流，**不代表网站变差** | `unknown` |
| ERROR → OBSERVED | ❌ | 故障恢复 | `unknown` |
| 任一侧版本变化 | ❌ | 口径变了 | `unknown` |

**规则：凡 `comparable=false`，`summary` 一律只累计 `unknown`，
绝不写入 `improved` / `degraded`。**

### 5.5 数值变化的显著性

`score 91 → 90` 与 `rank 3 → 25` 都算变化，但重要性差两个量级。
建议：
- 内置 `T` 型阈值（score 类 ±5 分、rank 类 ±3 位），低于阈值标 `neutral`
- 阈值按 `type` 配置化，写进 Observer 定义，不写死在 diff 里

---

## 6. Site Observer

### 6.1 定位

把现有的 `audit.ts` 计算逻辑，包装成产出 Observation 的正式 Observer。

### 6.2 契约

| 项 | 定义 |
|---|---|
| **输入 Evidence** | `page_html`（主）、`robots_txt`、`llms_txt`（可选，提高覆盖度） |
| **输出 Observation** | `seo_score` / `geo_score` / `robots_policy` / `llms_txt` 四条 |
| **subject** | `{ type: "url", id: 规范化 URL }` |
| **source** | `{ channel: "page", id: "direct" }` |
| **observerVersion** | `site-observer@1.0.0` |
| **parserVersion** | `audit-checks@1.0.0`（11 项检查表版本） |

### 6.3 status 定义

| status | 触发条件 |
|---|---|
| `OBSERVED` | 页面抓取成功且检查表全部完成 |
| `PARTIAL` | 页面拿到但部分检查项无法评估（如无 JSON-LD、无图片） |
| `NOT_FOUND` | 页面 404 / 410 |
| `BLOCKED` | 403 / 429（站点拒绝） |
| `ERROR` | 网络故障 / 超时 |
| `UNOBSERVABLE` | 域名解析失败 |

### 6.4 confidence

沿用现有 `confidenceFor(okCount, totalCount)`（`types.ts:164`）：
`ratio === 1 → high`、≥0.5 → medium、>0 → low、0 → unavailable。

**但需调整一处**：现在 11 项检查的 `okCount` 语义是"通过数"，
而置信度应该衡量"**能评估的项数**"而非"通过的项数"。
一个全部检查都跑完但只过了 2 项的页面，`confidence` 应该是 `high`（结论可信：它确实很差），
而不是 `low`。**这条要写进实现细则。**

### 6.5 coverage

```ts
coverage = {
  requested: 检查项总数（当前 11）,
  succeeded: 成功评估的检查项数,
  failed: 无法评估的检查项数,
}
```

---

## 7. Search Observer

### 7.1 定位

把 `serp.ts` 的采集与位次解析，包装成产出 `rank` Observation 的 Observer。

### 7.2 契约

| 项 | 定义 |
|---|---|
| **输入 Evidence** | `serp_html`（每个引擎一条）+ `redirect_resolve`（中转链接解析） |
| **输出 Observation** | `rank`（**每个引擎一条**，不做跨引擎合并） |
| **subject** | `{ type: "keyword_engine", id: "<keyword>|<engineId>" }` |
| **source** | `{ channel: "serp", id: engineId, strategyVersion }` |
| **observerVersion** | `search-observer@1.0.0` |
| **parserVersion** | `serp-parser@1.0.0` |

> **为什么按引擎拆开存？** 跨引擎平均位次（`summary.averageRank`）是**聚合结论**，
> 它的口径会随"选了哪些引擎"变化。存聚合值会让历史在引擎增减时断裂。
> 因此：**存单引擎事实，聚合在读取时算**。聚合口径版本用 `observerVersion` 表达。

### 7.3 ★ 三家引擎特殊解析必须保留

这是硬约束。以下逻辑一条都不能丢，且必须能被 parserVersion 追溯：

| 引擎 | 解法 | 代码位置 |
|---|---|---|
| 百度 | 容器上的 `mu` 属性 | `serp.ts:169` |
| 360 | `data-mdurl` 属性（含 inner 正则兜底） | `serp.ts:173-175` |
| 搜狗 | `citeLinkClass` / `citeurl` 元素可见文本 | `serp.ts:182` |

建议：`source.strategyVersion` 记录每个引擎的解析策略版本，
形如 `baidu.mu@1`、`so360.data-mdurl@1`、`sogou.citeLinkClass@1`。
这样将来某家改版导致解析失效时，能精确定位是哪一家的哪一版策略出问题，
而不是笼统地"parser 升级了"。

### 7.4 status 定义

复用 `SerpStatus`，映射到统一域：

| SerpStatus | ObservationStatus | 说明 |
|---|---|---|
| `ok`（targetRank ≠ null） | `OBSERVED` | 抓到且上榜 |
| `ok`（targetRank = null） | `NOT_FOUND` | 抓到了但没上榜——**这是真实结论** |
| `no_results` | `NOT_FOUND` | 引擎无结果 |
| `blocked` | `BLOCKED` | 被限流/验证码 |
| `error` | `ERROR` | 抓取失败 |

### 7.5 confidence

| 场景 | confidence |
|---|---|
| 单引擎单次 | `medium`（SERP 波动大，N=1） |
| 同引擎 24h 内多次一致 | `medium`（仍非统计显著） |
| 多引擎一致 | `medium`～`high` |

**建议：Search Observation 的 confidence 上限设为 `medium`，除非明确做了多时点采样。**
理由与 AI 观测一致——单次采样不具备统计意义。

### 7.6 coverage

```ts
coverage = { requested: 引擎数, succeeded: status=ok 的引擎数, failed: 其余 }
```

### 7.7 ⚠️ 不得宣称为永久排名事实

SERP 排名是**瞬时快照**，受个性化、地域、时间、A/B 测试影响。
因此 Search Observation **必须**带 `validUntil`（建议默认 `observedAt + 24h`），
并在 UI / MCP 输出中显式展示时效性。

**Phase 1 禁止将 SERP observation 表述为"当前排名"这类永久事实。**

---

## 8. AI Observer

### 8.1 定位

把 `visibility.ts` 的探针结果，包装成 `ai_mention` Observation。
这是 Phase 0 完成度最高的部分，Phase 1 主要是**契约化 + 补缺口**。

### 8.2 五态是否足够？

逐一检查当前五态：

| 状态 | 触发条件 | 是否够用 |
|---|---|---|
| `MENTIONED` | 响应含品牌 | ✅ |
| `NOT_MENTIONED` | 响应不含品牌 | ⚠️ 见下 |
| `BLOCKED` | 401/402/403/429 | ✅ |
| `ERROR` | status=0 / 其他非 2xx | ✅ |
| `UNOBSERVABLE` | 无 key / 协议不支持 / 无响应体 / 不可解析 | ✅ |

**缺口：`NOT_MENTIONED` 承载了两种不同语义。**

1. 模型认真回答了，但确实没提到该品牌 → 真正的"未提及"
2. 模型返回了拒答或无关内容（"我无法推荐具体厂商"）→ **这不是"未提及"，是"没回答"**

二者在 `buildObservedProbe`（`visibility.ts:465`）里被合并为同一个状态，
并且**都计入命中率分母**。第 2 类会稀释真实命中率。

**建议新增第六态：`INDETERMINATE`**

```
拿到响应 → 可解析 → 但无法判定是否提及（拒答 / 内容过短 / 答非所问）
```

- 不计入 `observedCount`（分母）
- 不计入 `mentionedCount`（分子）
- 不标为 `BLOCKED`（厂商没拒绝我们）也不标 `ERROR`（调用是成功的）
- 单独计数 `indeterminateCount`

判定建议（**仅为设计建议，不修改现有口径**）：
响应长度低于阈值、或命中拒答模式（"无法"/"不能"/"抱歉"+长度短）时标 `INDETERMINATE`。
具体阈值与模式需要真实数据回归后确定——**列入决策项 D3**。

### 8.3 ★ `requestedModel` vs `servedModel`：观测对象究竟是谁？

**已验证的真实情况**：请求 `deepseek-chat`，服务端实际返回 `deepseek-flash`。
`servedModel` 字段正是为抓这件事而设计的，设计生效了。

**问题**：如果按 `servedModel` 索引观测对象，会怎样？

```
2026-09 观测：deepseek-chat → served deepseek-flash
2026-10 厂商改路由：deepseek-chat → served deepseek-v3
```

按 servedModel 索引 → 历史序列在 10 月断裂，无法比较。
按 requestedModel 索引 → 序列连续，但"实际执行者变了"这个事实必须被 diff 感知。

**设计建议（不改现有口径，只定观测对象表达）**：

```
观测对象 = 观测槽位（slot） = { provider: "deepseek", requestedModel: "deepseek-chat" }
```

即：
- `subject.id` = `deepseek|deepseek-chat`（用 **requestedModel**）
- `metadata.servedModel` = `deepseek-flash`（记录真相，不参与身份判定）
- `metadata.modelDrift` = `true`（当 served ≠ requested 时）
- Diff 时：若两侧 `servedModel` 不同 → `comparable` 仍为 `true`，
  但追加一条 `kind: "VERSION"` 的 change，注明"执行者发生漂移"

理由：**观测对象应该是"我们试图观测的那个位置"，而不是"厂商当时派了谁来"**。
厂商换路由不是我们变更了观测对象；但必须记录，因为它确实影响可比性。

**是否把 `apiModel` 改成 `deepseek-flash`？**
不改。保持 `deepseek-chat` 请求口径，靠 `servedModel` + `modelDrift` 表达真相。
（这也是用户要求"不要自行修改现有模型口径"的遵守。）

### 8.4 字段定义

| 字段 | 定义 | 现状 |
|---|---|---|
| `requestedModel` | 我们请求时指定的模型标识 | ✅ 已有 |
| `servedModel` | 服务端实际使用的模型（来自响应体） | ✅ 已有 |
| `promptVersion` | prompt 模板版本，改措辞必须 +1 | ✅ 已有（`1.0.0`） |
| `promptHash` | prompt 指纹，防同名版本下偷改 | ✅ 已有 |
| `parserVersion` | 从响应抽结论的解析器版本 | ✅ 已有（`ai-visibility@0.1.0`） |
| `rawResponse` | 原始回答**全文**，不裁剪 | ✅ 已有 |
| `observedAt` | 探针完成时刻 | ⚠️ 现有是 `elapsedMs` + `generatedAt`，需显式化 |

### 8.5 confidence

现有实现**恒为 `medium`**，且注释解释充分：

> 即使 temperature=0，也没有任何厂商承诺逐字节一致；
> 单次探测本质是 N=1 的采样，不具备统计意义。

**建议保持 `medium` 不变**，并在 Phase 1 明确：
- 只有当同一 slot 在**多个时点多次采样**后，才允许升级为 `high`
- 升级规则属于"观测策略"，是 Phase 0 明确遗留项，Phase 1 可设计但**建议不在本期实现**

### 8.6 coverage

```ts
coverage = {
  requested: PROVIDER_LIST.length,        // 9
  succeeded: observedCount,               // MENTIONED + NOT_MENTIONED (+ INDETERMINATE?)
  failed: failedCount + unobservableCount,
}
```

---

---

## 9. 存储方案比较：SQLite / JSONL / Postgres

> **本轮只评估，不实现。** 结论供决策 D2 拍板。

### 9.1 逐维度比较

| 维度 | SQLite | JSONL（现状） | PostgreSQL |
|---|---|---|---|
| **单机 / 单用户** | ✅ 最佳，零配置 | ✅ 可用 | ❌ 需常驻服务进程 |
| **历史 Observation 查询** | ✅ 索引 + SQL | ❌ 全量扫描，O(n) | ✅ 最强 |
| **Evidence blob** | ⚠️ 建议外置文件，DB 只存 ref | ✅ 天然外置 | ⚠️ 同上，大对象管理复杂 |
| **并发** | ✅ WAL：单写多读 | ❌ 并发追加会互相覆盖 | ✅ 完整事务 |
| **查询能力** | ✅ SQL（JOIN / 聚合 / 排序） | ❌ 只能顺序读 + 内存过滤 | ✅ SQL + 更强分析能力 |
| **backup** | ✅ 单文件 copy（WAL 需先 checkpoint） | ✅ 目录打包 | ⚠️ 需 pg_dump |
| **migration** | ⚠️ 需自建版本化迁移 | ✅ 无 schema，天然免迁移 | ✅ 成熟工具链 |
| **future CLI** | ✅ 天然契合（单文件随身） | ⚠️ 可用但查询弱 | ❌ CLI 还得连服务 |
| **future multi-tenant** | ⚠️ 可支撑但上限明显 | ❌ 不合适 | ✅ 行级安全、成熟 |
| **依赖成本** | ⚠️ 需新增 1 个依赖（见下） | ✅ 零依赖 | ❌ 部署负担重 |

### 9.2 关键权衡：SQLite 的依赖代价

GEOkit 目前的卖点之一是**直接依赖仅 4 个**（`next` / `react` / `react-dom` / `zod`）。
引入 SQLite 有三种路径：

| 路径 | 说明 | 风险 |
|---|---|---|
| **A. `better-sqlite3`** | 成熟、同步 API、性能好 | **native 模块**，需预编译二进制；Node 版本升级时可能要等轮子 |
| **B. `node:sqlite`**（内置） | Node 22.5+ 实验性（**需 `--experimental-sqlite` flag**），Node 24 起免 flag | 实验性 API 可能在小版本间变动；CI 需 Node 24 |
| **C. 纯 JS / WASM**（如 `sql.js`） | 无编译负担 | 性能与持久化体验较差，社区热度低 |

**当前 CI 用 Node 22** → 路径 B 需要 `--experimental-sqlite`，对 CLI 与 MCP stdio
都意味着要改启动方式，侵入性不小。

### 9.3 推荐方案

> **推荐：SQLite（路径 A `better-sqlite3`），但分两步落地。**

**第一步（Phase 1a）**：先用 **JSONL + 索引文件**实现 §4 的 `GeoStore` 接口。
- 零新增依赖，不破坏"依赖极简"卖点
- 目的是**验证接口形状**——查询维度、分页、latestPair 这些设计对不对，
  只有真跑起来才知道
- 这一步也顺带解决了"Store 是单向黑洞"（P3）

**第二步（Phase 1b）**：当 Observation 条数达到数千、或出现明显查询延迟时，
换 SQLite 实现**同一套接口**，上层零改动。

**理由**：
1. JSONL 无法支撑 `listObservations` 的多维度查询——这是 Phase 1 的核心需求，
   全量扫描在几千条后就会明显变慢
2. Postgres 严重过度：单机单用户场景下引入常驻服务，得不偿失
3. SQLite 单文件备份 + CLI 随身，最贴合 GEOkit 的定位
4. 先接口后实现，让存储选型成为**可逆决策**

> 若周老板更看重"依赖极简"而非查询性能，则路径 B（Node 24 + `node:sqlite`）
> 是次优选择——代价是 CI 与 CLI 都要升到 Node 24。

---

## 10. 数据生命周期

```
                        ┌─────────────────────────────────────┐
  采集请求 ───────────▶ │  Fetcher (fetchWithPolicy)          │
                        │  统一 timeout/UA/retry/限速         │
                        └──────────────────┬──────────────────┘
                                           │ FetchResult
                                           ▼
                        ┌─────────────────────────────────────┐
                        │  Evidence (immutable)               │
                        │  metadata → JSONL / DB  (长期)      │
                        │  body     → blobs/     (分层保留)   │
                        └──────────────────┬──────────────────┘
                                           │ evidenceRefs
                                           ▼
                        ┌─────────────────────────────────────┐
                        │  Observer (Site / Search / AI)      │
                        │  带 observerVersion + parserVersion │
                        └──────────────────┬──────────────────┘
                                           │
                                           ▼
                        ┌─────────────────────────────────────┐
                        │  Observation (版本化结论)            │
                        │  status / confidence / coverage     │
                        └──────────────────┬──────────────────┘
                                           │ latestPair
                                           ▼
                        ┌─────────────────────────────────────┐
                        │  Diff (可比性优先)                   │
                        └──────────────────┬──────────────────┘
                                           │
                                           ▼
                                    趋势 / 报表 / API
                                           │
                                           ▼
                        ┌─────────────────────────────────────┐
                        │  Retention (只清理 blob)             │
                        └─────────────────────────────────────┘
```

### 各阶段要点

| 阶段 | 关键约束 |
|---|---|
| 采集 → Evidence | **Fetcher 是唯一入口**，Evidence 不得自行采集 |
| Evidence → Observation | **Observer 只读 Evidence**，不得回头改它 |
| Observation → Diff | **先判可比性，再算变化** |
| 全程 | Evidence 只增不改；Observation 幂等写入 |

---

## 11. Provenance 设计

### 11.1 完整链路

```
FetchResult ──▶ RawEvidence ──▶ Observation ──▶ Diff
     │               │               │            │
  请求事实       不可变事实      带版本结论     可比性判定
```

每一环都能向上追溯：

| 起点 | 追溯方式 |
|---|---|
| Diff → Observation | `diff.previousObservedAt` / `currentObservedAt` + subject+type |
| Observation → Evidence | `observation.evidenceRefs[]` |
| Evidence → body | `evidence.response.bodyRef` + `contentHash` 校验 |
| Evidence → 采集上下文 | `evidence.provenance`（purpose / fetcherVersion / meta） |

### 11.2 完整性校验

`contentHash` 的作用：
1. **去重判断**——同一内容重复采集时识别（见 §13）
2. **防篡改**——blob 被误改时，重新计算哈希即可发现
3. **blob 已清理后仍可证明**——metadata 里留有哈希，能证明"当时确实是这个内容"

### 11.3 AI 观测的 provenance 特殊性

AI 观测的可复现性依赖**四要素**，缺一不可：

```
① promptVersion + promptHash   ← 问了什么
② requestParams（temperature）  ← 怎么问的
③ servedModel                   ← 谁回答的
④ rawResponse                   ← 回答了什么
```

这四项 Phase 0 已全部落地，**保持不变**。
Phase 1 只需把它们搬进 Observation 的 `metadata` 与版本字段。

---

## 12. Versioning 策略

### 12.1 四层版本

| 层 | 字段 | 示例 | 变化意味着 |
|---|---|---|---|
| 契约 | `contractVersion` | `0.2.0` | 数据结构变更，需迁移 |
| 解析器 | `parserVersion` | `serp-parser@1.0.0` | 从原始素材抽结论的逻辑变了 |
| 观测器 | `observerVersion` | `site-observer@1.0.0` | 评分/聚合规则变了 |
| Prompt | `promptVersion` | `1.0.0` | 问法变了（仅 AI） |

**任一层变化 → 新旧 Observation 不可直接比较**（§5.3）。
这是 diff 里 `incomparableReason` 的直接依据。

### 12.2 解析策略细分版本

建议 `source.strategyVersion` 记录**每个引擎的解析策略版本**：

```
baidu.mu@1
so360.data-mdurl@1
sogou.citeLinkClass@1
```

理由：三家引擎的 HTML 结构随时会变，且**互不同步**。
笼统的 `serp-parser@1.0.0` 无法表达"只有搜狗的策略升级了"。
细分后才能精确回答"哪家的解析在第几版开始失效"。

### 12.3 版本升级策略：并行共存，不覆盖

版本升级时：
- **不修改**历史 Observation
- 新版本产生**新的** Observation 记录
- 查询时默认返回"当前版本的最新一条"
- 需要跨版本比较时，由调用方显式指定版本

这样即使 parser 有 bug，也能回到旧版本重算——这正是
Evidence / Observation 分离的价值所在。

---

## 13. Idempotency 策略

### 13.1 Evidence：默认不去重，但提供 dedupeKey

**原则：不同时刻采集 = 不同事实，不应去重。**

但两种情况需要识别重复：
1. 同一批次内的重试（Fetcher retry 已处理，不会重复落证）
2. 短时间内对同一 URL 的重复观测（上层误触发）

建议：
```ts
dedupeKey = hash(kind | source.id | subject.id | request.url | contentHash | observedAtBucket)
// observedAtBucket = 分钟级时间桶
```

**存储层不去重**，只在 `metadata` 里附上 `dedupeKey`，
由上层决定"是复用还是新增"。

### 13.2 Observation：必须幂等

```ts
idempotencyKey = hash(
  subject.type | subject.id |
  source.channel | source.id |
  type |
  parserVersion | observerVersion | promptVersion |
  sorted(evidenceRefs).join(",")
)
```

**语义：同样的证据 + 同样的版本 = 同样的结论。**

行为：
- 写入时若 `idempotencyKey` 已存在 → **跳过**（不报错）
- 这保证：重跑历史、CLI 重复执行、CI 反复触发都安全

### 13.3 runId：批次聚合

一次"跑一轮全站观测"会产生几十条 Observation。
`runId` 把它们串起来，便于：
- 按批次查询（"这一轮观测了什么"）
- 整批作废（不推荐，但必要时可按 runId 定位）
- 跨批次 diff（取两个 runId 对比）

---

## 14. Retention 策略

### 14.1 分层保留

| 层 | 内容 | 单条大小 | 默认保留 | 理由 |
|---|---|---|---|---|
| **L0** | Evidence metadata | ~1 KB | **长期** | 极小，是追溯的骨架 |
| **L1** | Observation | ~1 KB | **长期** | 极小，是历史的主体 |
| **L2** | AI `rawResponse` blob | ~2 KB | **90 天** | 小且复现价值高 |
| **L3** | `page_html` / `robots_txt` blob | 50–500 KB | **30 天** | 中等 |
| **L4** | `serp_html` blob | **0.5–1.6 MB** | **默认不留存**（hash-only） | 过大 |

### 14.2 SERP HTML 的取舍（★ 重要）

按 §1.3 发现 5：单关键词三引擎 ≈ 2.7 MB。
若全量留存，100 个关键词 × 每周一次 = **每月约 1 GB**。

**建议默认 `hash-only`**，仅在以下情况开启留存：
- 调试解析失败时（临时开启）
- 需要为新引擎 fixture 抓样本时
- 用户显式设置 `GEOKIT_EVIDENCE_BODY=serp`

理由：**SERP 的解析结论（rank Observation）比原始 HTML 更有价值**，
而重放 SERP HTML 的主要用途是调试解析器——这个需求用 fixture 覆盖更经济。

### 14.3 删除规则

1. **只删 blob，不删 metadata**——保留 `contentHash` 证明它曾存在
2. 删除后 `readEvidenceBody()` 返回 `null`，调用方必须处理
3. **retention 窗口外无法重放**——这是显式取舍，应在文档中说清
4. 清理动作按 `kind` 分别配置阈值，不做"一刀切"

---

## 15. Phase 1 推荐实施顺序

> 原则：**先定接口，后换实现**；每步可独立验证、可回滚。

| 步骤 | 内容 | 产出 | 验收标准 |
|---|---|---|---|
| **S1** | 修正 `target` 语义分裂：拆 `subject` + `source`（Evidence + Observation 同步） | Contract v0.2.0 | 现有回归全绿；evidence 记录字段变更 |
| **S2** | 定义 `GeoStore` 接口，用 JSONL 补齐 `listEvidence` / `listObservations` / `latestPair` | Store 可读写 | 能查出"某 subject 最近 2 条观测" |
| **S3** | Site Observer：把 `audit.ts` 结论包成 `seo_score` / `geo_score` Observation | 首个真 Observer | 审计结果可入库、可按 URL 查历史 |
| **S4** | Search Observer：`rank` Observation，**保留三家特殊解析** + `strategyVersion` | rank 历史 | 百度 mu / 360 data-mdurl / 搜狗 citeLinkClass 回归全绿 |
| **S5** | AI Observer：把 `visibility.ts` 探针包成 `ai_mention` Observation | 五态契约化 | 五态 5/5 覆盖不退化 |
| **S6** | Diff 引擎 + 可比性判定 | `ObservationDiff` | `UNOBSERVABLE→NOT_MENTIONED` 判定为 `unknown` 而非下降 |
| **S7** | 最小时间维度 API（只读，`GET /api/observations`） | 历史查询入口 | 不改现有页面 |
| **S8** | 存储选型落地（SQLite），替换 JSONL 实现，**接口不变** | 可逆转实现 | 上层零改动，查询性能提升 |

**S1 必须先做**——它是 S2 索引、S3/S4/S5 subject 定义、S6 diff 的共同前提。

**S8 最后做**——接口稳定后再换实现，选型错误可回滚。

---

## 16. 明确的"不做事项"

### 用户指定禁止（严格遵守）

- ❌ Auto Fix
- ❌ GitHub PR automation
- ❌ Agent Planner
- ❌ 多租户
- ❌ 分布式 crawler
- ❌ PostgreSQL
- ❌ 大规模 UI 重构
- ❌ 新增大量 SEO feature
- ❌ 删除现有搜索引擎特殊解析
- ❌ 把 SERP observation 宣称为永久排名事实

### 本轮（设计阶段）额外自律

- ❌ 未修改任何业务代码
- ❌ 未实现 SQLite
- ❌ 未新增 Observer 实现
- ❌ 未改 MCP / API / UI
- ❌ 未提交功能代码
- ❌ 未修改现有 AI 模型口径（`apiModel` 保持 `deepseek-chat`）
- ❌ 未顺手订正 Phase 0 文档 §10 风险 #3（仅报告，见 §1.3 发现 6）

### 允许且仅允许的改动

- ✅ 新增 `docs/PHASE-1-DATA-ARCHITECTURE.md`（本文件）

---

## 17. 未决架构问题

以下为**尚未定论**的问题，均对应下方决策项：

1. `subject` / `source` 拆分是否采用（D1）
2. 存储选型与落地时机（D2）
3. AI 是否新增 `INDETERMINATE` 第六态（D3）
4. `servedModel` 漂移的表达方式（D4）
5. Evidence 是否去重（D5）
6. Observation 同 key 重复写入：跳过还是更新（D6）
7. Evidence body 默认策略（D7）
8. SERP Observation 的 `validUntil` 时长（D8）
9. 是否需要 `runId` 批次概念（D9）
10. parserVersion 是否按引擎细分（D10）

---

# Architecture Decision List

> 每项需人工拍板。**推荐项是我的建议，不是既定结论。**

---

### D1 — Evidence.target 是否拆分为 subject + source

**Decision:** 是否将现有 `RawEvidence.target` 拆成 `subject`（被观测对象）与 `source`（观测源）？

**Context:** 当前该字段语义分裂（§1.3 发现 4）：SERP/AI 通道存的是引擎/厂商 id（观测源），
audit/llms 通道存的是 URL（被观测对象）。Phase 0 只有 AI 通道写盘所以不痛，
但 Phase 1 一旦按它建索引，"查 baidu"会同时命中两类完全不同的记录。

**Options:**
- A. 拆分为 `subject` + `source`（推荐）
- B. 保留单字段 `target`，另加 `targetType` 区分
- C. 不动，查询时靠 `kind` 区分

**Recommendation:** **A**。B 会让每个查询点都要判断 `targetType`，
C 无法支撑 `listObservations(subject)` 这类核心查询。拆分后类型系统能直接保证不混用。

**Risk:** 中。属于 breaking change——已有 evidence 记录需迁移（目前存量为 0，
因为默认关闭且未在生产使用，实际迁移成本接近零）。

---

### D2 — 存储选型

**Decision:** Phase 1 用哪种存储实现 `GeoStore`？

**Context:** 需要支撑 `listObservations(subject, type, timeRange)` 多维度查询；
项目当前直接依赖仅 4 个；单机单用户；未来要支持 CLI。

**Options:**
- A. SQLite via `better-sqlite3`（推荐，Phase 1b）
- B. SQLite via `node:sqlite`（需 Node 24，否则要 flag）
- C. JSONL + 索引文件（推荐作为 Phase 1a 过渡）
- D. PostgreSQL

**Recommendation:** **先 C 后 A**。Phase 1a 用 C 验证接口形状（零依赖），
接口稳定后 Phase 1b 换 A。**排除 D**（单机场景引入常驻服务过重）。

**Risk:**
- A：新增 native 依赖，Node 升级时可能需等预编译二进制
- B：实验性 API 可能变动；需升 CI 到 Node 24
- C：数千条后查询退化，必须按计划替换

---

### D3 — AI 观测是否新增 INDETERMINATE 第六态

**Decision:** 是否引入第六态，区分"真的没提及"与"模型没回答"？

**Context:** `buildObservedProbe`（`visibility.ts:465`）用 `text.includes(brand)` 判定，
模型返回拒答或无关内容时会被判为 `NOT_MENTIONED` 并计入命中率分母。
（已确认：`no_response_body` / `unparsable_response` 已被拦截，此问题仅涉及"可解析但无实质内容"。）

**Options:**
- A. 新增 `INDETERMINATE`，不计入分母（推荐）
- B. 保持五态，接受当前语义
- C. 保持五态，但在 `metadata` 里标记 `lowSignal: true`

**Recommendation:** **A**（若认可这是个问题）。六态能精确表达，
且不影响现有五态的回归断言（只是新增分支）。
若倾向保守，**C** 是低侵入替代——先记录信号强度，积累真实数据后再决定要不要升格为状态。

**Risk:** 中。引入新状态会改变 `observedCount` 口径，进而影响 `visibilityScore`。
**这是继 Phase 0 分母变更之后的第二次口径变更**，需明确告知使用者。
且在拿到真实多样本数据前，拒答模式的判定阈值只能拍脑袋。

---

### D4 — servedModel 漂移的观测对象表达

**Decision:** 请求 `deepseek-chat` 却得到 `deepseek-flash` 时，观测对象算谁？

**Context:** 已验证真实存在。若按 `servedModel` 索引，厂商改路由会导致历史序列断裂。

**Options:**
- A. 观测对象 = `provider + requestedModel`（槽位），servedModel 记入 metadata（推荐）
- B. 观测对象 = `provider + servedModel`（实际执行者）
- C. 两者都存，查询时由调用方选择

**Recommendation:** **A**。观测对象应是"我们试图观测的位置"，厂商派谁来是执行细节。
同时设 `metadata.modelDrift = true`，diff 时追加一条 version change 提示。

**Risk:** 低。不改现有 `apiModel` 口径，只新增字段。
风险在于：若厂商长期漂移且从不声明，槽位语义会逐渐失真——需靠 `modelDrift` 计数监控。

---

### D5 — Evidence 是否需要去重

**Decision:** 同一内容在短时间内被重复采集，存储层是否去重？

**Context:** 不同时刻采集是不同事实（应保留）；但误触发的重复观测会浪费空间。

**Options:**
- A. 不去重，只提供 `dedupeKey` 供上层判断（推荐）
- B. 存储层按 dedupeKey 去重（同 key 写入跳过）
- C. 完全不管

**Recommendation:** **A**。Evidence 的不可变性要求"写入即事实"，
去重逻辑放存储层会污染这层语义。上层（Observer）知道自己要不要复用。

**Risk:** 低。代价是可能产生冗余记录，靠 retention 兜底。

---

### D6 — Observation 幂等冲突：跳过还是更新

**Decision:** 相同 `idempotencyKey` 的 Observation 再次写入时如何处理？

**Context:** 幂等是为了让重跑安全。但"跳过"会掩盖 legitimate 的更新需求。

**Options:**
- A. 跳过（推荐）
- B. 覆盖更新
- C. 跳过，但返回已有记录供调用方比对

**Recommendation:** **C** = A + 可观测性。同 key 意味着"同证据 + 同版本"，
结论必然相同，跳过是安全的；但返回已有记录能让调用方确认"确实没变"。

**Risk:** 低。若将来出现"同证据不同结论"的非确定性场景（如评分逻辑含随机数），
此假设会失效——届时需要重新审视幂等键的构成。

---

### D7 — Evidence body 默认策略

**Decision:** 各类 Evidence 的 body 默认是否留存？

**Context:** SERP HTML 单条 1.6 MB（§1.3 发现 5），全量留存不可持续；
但 hash-only 又无法重放。

**Options:**
- A. 分层：AI response 留存、page 30 天、SERP 默认 hash-only（推荐）
- B. 全部留存，靠 retention 清理
- C. 全部 hash-only

**Recommendation:** **A**。按"体积 × 重放价值"排序取舍。
SERP 的重放需求主要来自解析器调试，用 fixture 覆盖更经济。

**Risk:** 中。选 A 意味着**SERP 观测无法重放**——
若将来发现解析器有 bug，无法回溯修正历史结论，只能重新采集。
这是显式取舍，需要明确接受。

---

### D8 — SERP Observation 的有效期

**Decision:** `validUntil` 默认多长？

**Context:** SERP 排名受个性化/地域/时间/A-B 影响，是瞬时快照。
用户明确要求"不把 SERP observation 宣称为永久排名事实"。

**Options:**
- A. `observedAt + 24h`（推荐）
- B. `observedAt + 7d`
- C. 不设有效期，但在 UI 强提示"快照时间"

**Recommendation:** **A**。24h 与搜索引擎的更新节奏大致匹配。
超过有效期的 Observation 在 diff 时应标 `stale` 提示。

**Risk:** 低。有效期设太短会让"周级趋势"看起来全是过期数据；
需配合采样频率一起考虑（若一周才采一次，24h 有效期会让每一次 diff 都标 stale）。

---

### D9 — 是否需要 runId 批次概念

**Decision:** 是否引入 `runId` 串联一次批量观测产生的多条 Observation？

**Context:** 一轮全站观测产生几十条 Observation，需要按批次聚合/对比。

**Options:**
- A. 引入 `runId`（推荐）
- B. 不引入，靠时间窗口近似聚合
- C. 引入，但只在批量命令中使用

**Recommendation:** **A**。成本极低（一个字段），收益明确。
时间窗口近似在并发或补跑时会错乱。

**Risk:** 低。

---

### D10 — parserVersion 是否按引擎细分

**Decision:** 用一个统一的 `serp-parser@1.0.0`，还是按引擎细分到 `baidu.mu@1`？

**Context:** 三家引擎 HTML 结构互不同步地变化。统一版本无法表达
"只有搜狗策略升级了"。

**Options:**
- A. 双层：统一 `parserVersion` + `source.strategyVersion` 细分（推荐）
- B. 只用统一版本
- C. 只用细分版本

**Recommendation:** **A**。统一版本用于 diff 的粗粒度可比性判定，
细分版本用于定位"哪家的哪一版开始失效"。二者用途不同，都要。

**Risk:** 低。代价是版本号管理略复杂，需要约定升级规则。

