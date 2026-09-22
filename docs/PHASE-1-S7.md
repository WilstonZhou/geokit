# Phase 1 / S7 —— 只读时间维度 API

```text
commit:    feat: implement phase 1 S7
父提交:    225a416（S6）
状态:      COMPLETE
契约:      S1/S2 未改 · replaces 未改 · analyze() 未改 · 现有页面未改
```

---

## 1. Scope

| 项 | 内容 |
|---|---|
| **做什么** | 把 S2 的 Store 与 S6 的 Diff 以**只读 HTTP**开放：`GET /api/observations` |
| **不做什么** | 新页面（roadmap 明写「不改现有页面」）· MCP 接线 · SQLite（S8）· 任何写入/采集 |

设计依据：`docs/PHASE-1-DATA-ARCHITECTURE.md` §15（S7 = 最小时间维度 API）、§4.2（查询接口）。

这是 Phase 1 里**第一次有生产路径读 Store** —— S3–S6 只产出，没有出口。

---

## 2. 端点

### 2.1 `GET /api/observations`

历史查询入口。参数全部可选：

| 参数 | 说明 |
|---|---|
| `subject` | 被观测对象（`site:…` / `search:…` / `ai-slot:…`） |
| `source` | 观测来源（`http:…` / `search-engine:…` / `provider:…`） |
| `type` | `rank` / `geo_score` / `ai_mention` / `robots_policy` / `llms_txt` |
| `status` | 八态之一 |
| `runId` | 批次 |
| `from` / `to` | 时间范围（ISO） |
| `order` | `asc` / `desc`（默认 `desc`） |
| `limit` | 1..500（默认 50） |
| `latest` | `1` → 每个 identity 只留最新一条 |

```jsonc
{
  "query": { "limit": 50, "order": "desc", "subject": "ai-slot:deepseek:deepseek-chat", "type": "ai_mention" },
  "count": 3,
  "items": [ /* Observation[] */ ],
  "hint": "…"   // 仅当 count === 0
}
```

`latest=1` 是**「当前状态」查询**，不是时间序列 —— 做趋势图不要开，
时间序列要的是每个时间点一条，不是每个 identity 一条。

### 2.2 `GET /api/observations/diff`

某条时间线最近两条观测的差异，直接复用 S6 的 diff 引擎。

```text
必填  subject, type
可选  source（同一 subject 下有多来源时必须指定，否则会把不同引擎/厂商混着比）
      to（只比较该时刻之前的观测 —— 「回到过去某个瞬间重算」）
```

返回 `{ query, diff }`，`diff` 即 S6 的 `ObservationDiff`。

---

## 3. 参数校验：非法参数必须 400，不能静默返回空

```text
type=seo_score     → 400  type 非法：seo_score（可选：rank / geo_score / …）
status=DROPPED     → 400  status 非法：DROPPED（可选：OBSERVED / …）
limit=0 | 501 | abc → 400  limit 必须是 1..500 的整数
order=up           → 400  order 只能是 asc 或 desc
from=昨天           → 400  from 不是可解析的时间
```

静默忽略非法参数是最坏的结果：调用方会拿着一份
「看起来查过了、其实是空的」的结果去做决策。**校验失败要说清哪个参数不对。**

---

## 4. 空结果必须说清为什么（★）

Observation 默认**不写入**（`GEOKIT_EVIDENCE` 总闸默认 `off`）。
所以「查不到」最常见的含义是**从来没有记过**，而不是「记过但没匹配上」。

```text
总闸关闭  → hint: 存证总闸当前关闭（GEOKIT_EVIDENCE=on 才会写入 Observation）
            —— 空结果是「还没记过」，不是查询失败
总闸开启  → hint: 没有匹配的 Observation：该时间线下还没有记录，或过滤条件过窄
```

返回一个空数组却不说明这一点，等于让人以为历史丢了。
抓不到就说是抓不到 —— 这条在读取侧同样适用。

---

## 5. 只读

- 不产出 Observation、不落 Evidence、**不触发任何采集**
- 想产生新数据走 `/api/audit`、`/api/serp`、`/api/visibility`，那三条才是采集入口
- 测试里有断言：连续读操作前后 Observation / Evidence 条数不变

---

## 6. 分层

```text
src/app/api/observations/route.ts        GET  只做序列化
src/app/api/observations/diff/route.ts   GET  只做序列化
src/lib/services/observations.ts         参数校验 + 取数 + 空结果 hint
        ↓
src/lib/store（S2）· src/lib/diff.ts（S6）
```

与 `services/serp`、`services/visibility` 同构：
**口径只写一处**。将来 MCP 也要读历史时，直接复用同一层，不会出现
HTTP 与 Agent 看到不同结果。

---

## 7. 文件

```text
NEW       src/lib/services/observations.ts        解析 + 取数 + 空结果说明
NEW       src/app/api/observations/route.ts        GET 历史
NEW       src/app/api/observations/diff/route.ts   GET 最近差异
NEW       scripts/test-observation-api.ts          49 项
NEW       docs/PHASE-1-S7.md
MODIFIED  package.json                            test:observation-api
```

**未改**：`src/lib/evidence/types.ts`（S1）· `src/lib/store/*`（S2）· `src/lib/diff.ts`（S6）·
三个 Observer · 任何现有页面 · `analyze()` · baseline。

---

## 8. 测试（49 项）

```text
1 · 参数校验   非法 type/status/limit/order/from/to 各 400 且错误信息带可选值；
               边界 limit=500 通过；空白裁剪；契约全集
2 · 历史查询   默认倒序 · order=asc · limit · count 语义 ·
               subject / source / status / type 过滤 · 时间范围 · latest=1
3 · 空结果     带 hint；★ 总闸关闭时点明「还没记过」；有结果时不给 hint
4 · diff 查询  缺 subject/type、非法 type、非法 to 各 400；
               最近两条 NOT_MENTIONED→MENTIONED ⇒ improved=1、degraded=0；
               ★ to 截断后 UNOBSERVABLE→NOT_MENTIONED ⇒ comparable=false、degraded=0；
               无历史 ⇒ missing_previous
5 · 只读性     读操作前后 Observation / Evidence 条数不变
```

---

## 9. Contract Protection

```text
S1 contract:          unchanged（types.ts 未动）
S2 contract:          unchanged（Store 接口未扩、jsonl.ts 未动）
S6 diff:              unchanged（只复用，未改判定规则）
replaces semantics:   unchanged
analyze():            unchanged
现有页面:             未改（roadmap 要求）
baseline:             unchanged
```

---

## 10. 已知限制

```text
W-1  MCP 未接线。roadmap 的 S7 只定义了 HTTP 端点，MCP 侧读历史留给后续阶段；
     逻辑已在 services 层，接线成本很低。
W-2  无 offset 分页 —— S2 的 ObservationQuery 没有 offset 字段，不为它扩冻结契约。
     深翻页请用 from/to 时间窗切分。
W-3  O(n) 全量扫描。JSONL 实现的固有限制，S8 换 SQLite 时上层零改动。
W-4  默认配置下这个 API 是空的（存证总闸 off）。这是刻意取舍，不是 bug ——
     打开 GEOKIT_EVIDENCE=on 后，跑一轮 /api/audit 或 /api/serp 即可看到历史。
W-5  不提供鉴权。本工具面向本地/单用户，与既有 /api/* 一致；
     若要公网部署需另加一层。
W-6  AI 的 subject 不含 brand / topic（S5 W-4）。多品牌共用一条 ai-slot 时间线，
     靠 metadata.extra.brand / topic 区分 —— 本 API 尚未提供按 metadata 过滤。
```
