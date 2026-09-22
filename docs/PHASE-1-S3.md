# Phase 1 / S3 — Site Observer

> 第一个真 Observer。验证「Evidence → Observation」这条链路是否真的成立。
>
> S3 是 **Observation adapter**，不是新的 SEO/GEO 算法。

分两个 commit 落地：

```text
8308cdb  Commit A  audit → Evidence Store wiring（page_html Evidence）
???????  Commit B  Evidence → Site Observer → Observation → Store
```

---

## 1. 职责边界

### S3 做什么

把 `page_html` Evidence 交给 `analyze()`，再把返回的 `PageAudit` 映射成符合 S1 契约的
Observation，并通过 S2 的 Store 落库。只产一种 kind：`geo_score`。

### S3 不做什么

| 不做 | 归属 |
|---|---|
| 采集（HTTP / 重试 / UA / 限速） | Fetcher |
| 定义字段与身份 | S1（已冻结） |
| 实现存储 | S2（已完成） |
| robots.txt / llms.txt 观测 | 排除（OPEN-8） |
| SERP 排名 | S4 |
| AI 提及 | S5 |
| Diff / 时间 API / SQLite / UI | S6 / S7 / S8 / 禁止项 |

### 边界判定

- 与 S1：**只消费契约，不改契约**
- 与 S2：**只调 `saveObservation()`**，不新增存储机制、不绕过 Store 自己写文件
- 与 S4–S8：本轮零触碰

---

## 2. 锁定的决策

```text
OPEN-1 → B   不新增 seo_score kind；seoScore 作为 result 内部数据
OPEN-2 → B   不新增 NOT_FOUND；404/410 = OBSERVED + result.httpStatus + caveat
OPEN-3 → A   audit 必须产生可重放的 page_html Evidence（body 必须留存）
OPEN-4 → A   Evidence 统一走 store.saveEvidence()，不扩 legacy appendRecord
OPEN-5 → C   subject = finalUrl；inputUrl 保留在 metadata
OPEN-6       不新增 run.ts / 全局 runId 体系；runId 不传即合法
OPEN-7 → B   无合法 Evidence → 只返回 PageAudit，不产 Observation
OPEN-8       robots.txt / llms.txt 不属于 S3

W-1  GEOKIT_EVIDENCE 保持默认 off；只有 Evidence 实际保存成功才产 Observation
W-2  不改 evidenceFromFetch() 签名，在 audit.ts 完成 subject/source/bodyRetained 注入
W-3  持久化失败不阻断 PageAudit 返回，但记录明确错误；不得伪造 Observation 成功
```

---

## 3. 数据流

```text
POST /api/audit {url}  /  MCP audit_page
        │
        ▼
auditUrl()                        audit.ts —— 唯一持有 FetchResult 处
  ├─ fetchWithPolicy(purpose:"audit")
  │     → FetchResult{ finalUrl, status, body, bodyHash, elapsedMs,
  │                    context.requestedAt, error }
  ├─ evidenceFromFetch(res, "page_html")    [Commit A]
  │     subject = siteSubject(finalUrl)
  │     source  = httpSource(finalUrl)
  │     bodyRetained = true（OPEN-3）
  ├─ store.saveEvidence(ev, { body })       [Commit A]
  │     → raw-*.jsonl（append-only）+ blobs/<id>.txt
  ├─ analyze(finalUrl, html, status, ms)    ★ UNCHANGED
  │     → PageAudit（SEO 91 / GEO 70 / 11 项）
  └─ observeSite({ evidence, body })        [Commit B]
        → Observation{ geo_score, contractVersion 0.2.0 }
        → store.saveObservation()  ← replaces 在此唯一决定

离线分支（route.ts 直接 analyze，无 FetchResult）
  → 不进入此链路，只返回 PageAudit（OPEN-7）
```

---

## 4. Identity 映射（重定向用例）

```text
inputUrl   = https://example.com
              ↓ 301
finalUrl   = https://www.example.com/

Evidence.subject            = site:https://www.example.com
Evidence.source             = http:https://www.example.com   ← origin 级
Evidence.metadata.inputUrl  = https://example.com
Evidence.response.finalUrl  = https://www.example.com/       ← 保留尾斜杠

Observation.subject = Evidence.subject   ← 直接复制，不重新推导
Observation.source  = Evidence.source
Observation.metadata.extra.inputUrl = https://example.com
```

Observation 的 subject/source **直接复制自 Evidence**，不重新推导 ——
二者对「实际被分析对象」的 identity 必然一致。

⚠️ `canonicalUrl()` 会去掉根路径尾斜杠，而 `response.finalUrl` 保留 ——
比对时不要拿两者做字符串相等判断。

---

## 5. 状态映射

| HTTP 事实 | ObservationStatus | caveat |
|---|---|---|
| 2xx + 有正文 | `OBSERVED` | — |
| 2xx + 空正文 | `PARTIAL` | 分数不可信 |
| 3xx | `OBSERVED` | 未跟随至最终目标 |
| **404 / 410** | `OBSERVED` | **目标不存在 —— 真实结论，不是我方故障** |
| 401 / 403 / 429 | `BLOCKED` | 被拦截 ≠ 页面不存在 |
| 5xx | `ERROR` | 本次观测不可用 |
| status=0（timeout/network/DNS） | `UNOBSERVABLE` | 没能观测 ≠ 观测到不合格 |
| status=0（too_large/invalid_url） | `ERROR` | 采集未完成 |

**关键区分**：404/410 是站点事实，记 OBSERVED；被拦截是被拒绝，记 BLOCKED；
压根没拿到响应才是 UNOBSERVABLE。三者混在一起会让时间线分不清
「页面没了」「我们被挡了」「我们没抓到」。

---

## 6. 硬门槛：hash-only 不产结论

```ts
if (httpStatus > 0 && !ev.response.bodyRetained) {
  return { ok: false, reason: "未留存响应体（hash-only），无法产出可重放的结论" };
}
```

`analyze(url, html, ...)` 的第二个参数就是 HTML 原文。只有 hash 没有正文，
跑不出任何一条 GEO 判断 —— 那种 Evidence 等于没存。
**不接受用「有 hash 但没内容」的记录冒充观测成功。**

同理，`status = 0`（无响应）时**不跑 `analyze()`**：
在空内容上跑 11 项检查会得出一个看似合理、实则无据的分数。走 `emptyAudit()`，分数一律 0。

---

## 7. `replaces` 保护

```text
S3 MUST NOT MODIFY replaces semantics.
```

- S3 不计算、不查询、不设置 `replaces`
- 不按 URL 覆盖历史 —— 无 `runId` 时恒走「追加新记录」分支
- `JsonlStore.saveObservation()` 在构造落库对象时**无条件覆盖** `replaces` 字段
  → S3 即便误传也会被改写，语义在结构上不可能被破坏

S3 对 `replaces` 只有**间接影响**：`parserVersion` 变化时 Store 自动建链。
这是既定语义的正当使用，不是修改。

---

## 8. 版本纪律（★ 改动必读）

```text
SITE_OBSERVER_VERSION = "site-observer@0.1.0"   改本文件的映射规则 → 递增
AUDIT_PARSER_VERSION  = "audit-checks@1.0.0"    改 analyze() 的 11 项检查或 result 结构 → 递增
```

`parserVersion` 定死后若改了算法却忘了递增，**口径变化会被时间线误读成
「站点真的变了」**。递增会触发 `replaces` 链 —— 这正是 `replaces` 存在的意义。

---

## 9. 不重复存储 Evidence body

```text
Evidence
 ├── id
 ├── kind: page_html
 ├── blobs/<id>.txt   ← 正文只在这里
 └── metadata

Observation
 ├── evidenceRefs: [Evidence.id]   ← 引用，不复制
 ├── result: PageAudit             ← 天然不含 raw html
 ├── status / confidence / coverage
 └── metadata.extra{ inputUrl, httpStatus, bodyHash }
```

Observation 顶层**不含** `body` / `html` / `response` / `headers` —— 测试已断言。
`bodyHash` 只放在 `metadata.extra` 供诊断，不进顶层。

---

## 10. Commit A — Evidence wiring

```text
8308cdb  feat: wire audit fetch into evidence store for page_html
Files:   src/lib/audit.ts（+约 70 行）
```

| 项 | 内容 |
|---|---|
| 目的 | 只解决「S3 有没有合法 Evidence 输入」，不产任何 Observation |
| 改动 | ① `evidenceEnabled()` 总闸判断；② fetch 后注入 finalUrl 版 identity；③ 强制 `bodyRetained`；④ `store.saveEvidence(ev,{body})`；⑤ `PageAudit` 增可选 `evidenceId?` |
| 未动 | 离线分支、robots / llms、SERP、AI mention、任何契约 |
| 风险 | 无 runId ⇒ 每次审计一份全量 HTML 落盘；retention 有策略无执行器 |

⚠️ **实施中发现的 S1 缺陷**：`evidenceFromFetch()` 注入的 `subject` 会被
`normalizeEvidence()` 的 legacy 分支覆盖回输入 URL。按 W-2 保守方案，
在 `audit.ts` 保存前补回了 finalUrl 版 identity。**未修改 S1 契约**，
但这说明 `normalizeEvidence` 对显式 identity 的处理存在隐患，建议 S7 前单独修。

---

## 11. Commit B — Site Observer

```text
Files:
  NEW       src/lib/observers/site.ts
  NEW       scripts/test-site-observer.ts
  NEW       docs/PHASE-1-S3.md
  MODIFIED  src/lib/audit.ts      （analyze 后约 8 行落库）
  MODIFIED  package.json          （test:site-observer 一行）
```

| 项 | 内容 |
|---|---|
| 目的 | 第一个真 Observer，验证 Evidence → Observation 链路 |
| `observeSite()` | 纯函数，输入 `{evidence, body, inputUrl}`，输出 `Observation \| {ok:false,reason}` |
| `recordSiteObservation()` | `observeSite()` + `store.saveObservation()`，失败返回原因不吞错 |
| 风险 | result 内嵌完整 PageAudit ⇒ 单条偏大；将来裁剪须递增 parserVersion |

### 测试（`scripts/test-site-observer.ts`，78 项）

```text
1 · 契约            contractVersion 0.2.0 / type=geo_score（断言不是 seo_score）/
                    版本三元组齐备 / evidenceRefs 非空且指向真实 Evidence
2 · Identity        finalUrl 版 subject/source；inputUrl 进 metadata；
                    Evidence 与 Observation identity 逐字相同
3 · HTTP            200→OBSERVED / 404→OBSERVED+caveat / 410 同 404 /
                    403→BLOCKED / 5xx→ERROR / status=0→UNOBSERVABLE / 空 body→PARTIAL
4 · Evidence        body 缺失（hash-only）→ 不产 Observation /
                    body 留存 → bodyRef 可读且内容一致
5 · 不重复存储      Observation 顶层无 body / html / response / headers
6 · 持久化          无 runId 再跑一次 → 新历史；Evidence 仍 immutable
7 · Store          同 run 同版本 → 保持原 id、链不增长、历史 1 条
8 · analyze() 口径  11 项检查 id 集合不变 / SEO 91 / GEO 70
```

---

## 12. Contract Protection

```text
S1 contract:         unchanged（src/lib/evidence/types.ts 未动）
S2 contract:         unchanged（src/lib/store/* 未动）
ObservationKind:     unchanged（无 seo_score）
ObservationStatus:   unchanged（无 NOT_FOUND）
replaces semantics:  unchanged
analyze():           unchanged（11 项 / 评分 / baseline / fixtures 全未动）
```

---

## 13. 已知限制（WARNING，非阻塞）

```text
W-1  默认 off：GEOKIT_EVIDENCE 默认关闭 ⇒ 默认配置下 S3 不产 Observation。
     与 OPEN-7「无 Evidence 则不产」同构，属预期行为。
W-4  Evidence 写路径不统一：legacy appendRecord（visibility.ts）与 JsonlStore
     双写同一目录；JsonlStore 惰性加载一次索引。S3 不受影响（同实例先写后读），
     S7 前必须收敛。
W-5  磁盘增长：无 runId ⇒ 不去重；retention 已定义 siteRaw 30 天但无执行器。
W-6  Store 不校验 evidenceRefs 外键：空引用静默通过，由 Observer 自证（测试已覆盖）。
W-7  parserVersion 纪律：见 §8。
```

---

## 14. 不在 S3 范围

```text
seo_score kind · NOT_FOUND status · robots.txt · llms.txt · SERP（S4）·
AI mention（S5）· diff（S6）· 时间/查询/latest API（S7）· SQLite（S8）·
UI · planner · auto-fix · 新 SEO 算法
```
