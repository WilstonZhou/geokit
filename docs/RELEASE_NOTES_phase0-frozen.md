# 鲸析 GEOkit · Phase 0 — Observable Foundation

> 冻结 tag：`phase0-frozen` ｜ 冻结点 commit：`98d1c17` ｜ 基线 commit：`5dfc848`

**这一版不新增任何 SEO 功能。**

它只做一件事：让采集到的数据第一次具备「可追溯 / 可重算 / 可被 Agent 信任」的性质。

在此之前，九个模型跑出来的可见性分数无法复现 —— 因为原始回答被丢掉了、
九个模型用的不是同一套采样参数、prompt 连版本号都没有。这样的数字可以给
人看，但不能给 Agent 用来做决策。

---

## 一条贯穿始终的边界

**Fetcher 采集 · Evidence 保存事实 · Observer 生产结论。**

三者不得互相吞并。具体落到契约上是：

- Evidence **没有**「给个 URL 帮我存一下」这种接口。唯一入口是
  `evidenceFromFetch(res, kind)` —— 入参必须是 Fetcher 的产物，
  从类型上就杜绝它自己跑去抓
- Evidence 里存的是**不可变事实**，写入后永不修改
- Observation 与 Evidence 分离，只带 `sourceEvidenceIds` + `parserVersion`。
  分离的意义是：将来换了解析器，能用同一批证据把历史重算一遍

---

## 六件事

| # | 事项 | 落点 |
|---|---|---|
| 1 | **Unified Fetcher** — 9 处裸 `fetch` 收敛为唯一出口 | `src/lib/fetcher/` |
| 2 | **RawEvidence 契约** — 不可变事实 + 敏感头脱敏 | `src/lib/evidence/` |
| 3 | **Observation 契约** — 结论与事实分离，可重放 | `src/lib/evidence/types.ts` |
| 4 | **AI Visibility 可复现性** — 五态 + 统一采样 | `src/lib/visibility.ts` |
| 5 | **Service Layer** — HTTP 与 MCP 共用同一份实现 | `src/lib/services/` |
| 6 | **Regression** — baseline 锁定 + 三家引擎 fixture | `scripts/regression.ts` |

### 1. Unified Fetcher

统一 timeout / AbortController / headers / UA / retry+指数退避 / per-domain
限速 / request context。`maxAttempts` 默认 **1**（不重试），历史行为零变化。

### 2. RawEvidence

request/response provenance 完整留存，敏感 header 脱敏（含 Gemini `?key=`
查询串防护），请求体只记长度不记原文。

一条容易被忽略的设计：**采集失败同样落证**。抓不到本身就是要留存的证据 ——
否则「这次没抓到」和「这次正常运行了但确实没有」在事后无法区分。

默认不落盘，`GEOKIT_EVIDENCE=on` 才启用。

### 3. Observation

带 `sourceEvidenceIds` / `observedAt` / `parserVersion` / `confidence` / `caveat`。

### 4. AI Visibility 可复现性

修了三个硬伤：

1. **temperature 此前只在 OpenAI 兼容路径设置** —— 九个模型跑的不是同一场实验
2. **原始回答被丢弃**，只留 400 字片段，事后无法复核判定
3. **prompt 无版本**，改了措辞后历史数据失去可比性

现在：统一 `temperature=0 / maxTokens=1024`（**不带 `top_p`** —— Anthropic
Messages API 在两者同时传时会报错），`rawResponse` 全文留存，prompt 版本化 + hash。

状态模型改 **五态**：

```
MENTIONED / NOT_MENTIONED / BLOCKED / ERROR / UNOBSERVABLE
```

不用布尔值的原因很直接：把「没提及」和「没观测到」混成同一个 `false`，
会污染下游所有判断。

### 5. Service Layer

此前「选哪些引擎」「平均位次怎么算」「key 从哪来」在 HTTP 和 MCP 两条通道
各写了一遍 —— 今天结果一致纯属巧合。现在共用同一份实现。

### 6. Regression

零新增依赖。三家引擎真实 HTML 固化为 fixture，先锁 baseline 再动代码。

---

## ⚠️ 语义变更（升级请注意）

**`visibilityScore` 分母从「配了 key 的探针数」改为「实际观测成功的探针数」。**

没观测到的样本不再稀释比率 —— 否则数字会比真实情况好看。
五个计数（`mentionedCount` / `observedCount` / `failedCount` /
`unobservableCount` / `configuredCount`）全部返回，旧口径可还原。

`averageRank` / `bestRank` 同理：被 block 的引擎不参与平均。

这是本阶段**唯一影响数值语义**的改动。

---

## 过程中修掉的真实缺陷

这些问题都不是自测用例设计出来的，是跑真实数据才暴露的。

### MCP stdio 会吃掉全部响应（两次修复，两个不同的坑）

**坑一**：`stdin.on("end", ...)` 直接 `process.exit(0)`。真实工具调用要几秒，
`end` 在 `await` 期间就触发，进程被立刻杀掉，**响应永远写不出来**。
CI 冒烟只调 `list_engines` 这类零耗时工具，所以这个缺陷一直没暴露 ——
恰恰是最需要真实调用的场景会踩到它。

**坑二**：修完坑一后退出时序仍有问题。stdout 在 pipe 模式下是**异步**的，
`write()` 返回不代表数据已交给对端，此时 `process.exit()` 会直接丢弃缓冲区里
没写完的部分。`check_ai_visibility` 单条响应可达几十 KB，客户端会收到半截 JSON。

现在退出必须同时满足三个条件：① stdin EOF ② 无在途请求 ③ 所有 write 的
flush 回调均已触发。

**对照实验**（同一批 61 条请求，含一条 6 秒的真实 AI 调用）：

```
旧实现   输出      0 字节   响应  0/61   ← 整批丢失，不只是慢的那条
新实现   输出 194586 字节   响应 61/61   零损坏行
```

194KB 远超 64KB 的 pipe 缓冲区，末条 `id=999`（那条真实慢调用）完整可解析。

### Turbopack 把整个项目 trace 进了服务端产物

`evidence/store.ts` 里动态路径的 `fs` 调用导致的，产物里混进了 `public/`
和全部源码。已在每个调用点加 `/* turbopackIgnore: true */`。

### `api/visibility/route.ts` 改一半留下断链

函数体已改调 service，但 import 还是旧符号，三个符号根本没导入。
这类错误 build 有时能混过去，**只有 `tsc --noEmit` 会报**。

---

## 验证结果

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | 0 error |
| `next build` | EXIT=0（7 静态页 + 5 API route） |
| 回归 vs baseline `5dfc848` | 一致：百度 21 / 360 4 / 搜狗 9，畸形 0；审计 SEO 91 / GEO 70 / 11 项 |
| AI 可见性五态 | **5/5 覆盖**，带真实 key 时 18/18 通过 |
| Provenance | `Authorization: [REDACTED]`，全量搜索密钥片段零命中 |
| MCP stdio | 8 工具齐全 |

### 五态怎么做到 100% 覆盖

关键设计：**五种状态里有四种可以确定性构造**，不必看厂商脸色。

| 状态 | 构造方式 |
|---|---|
| UNOBSERVABLE | 不传 key |
| BLOCKED | 真实 key 翻掉末位 → 401 ／ mock 返回 401 |
| ERROR | 影子 provider 指向 `127.0.0.1:1` → `status===0` |
| MENTIONED / NOT_MENTIONED | 本地 mock 端点控制回答里有没有品牌 |

因此即使一个 key 都没有，`scripts/verify-ai-visibility.ts` 仍能覆盖 5/5
并安全进 CI。真实厂商调用是唯一需要真 key 的检查项。

---

## 已验证与未验证（诚实说明）

- ✅ **已真实触发**：DeepSeek 真实调用（NOT_MENTIONED，rawResponse 1885 字符
  完整留存）、BLOCKED、ERROR、UNOBSERVABLE
- ⚠️ **未验证**：其余 8 个模型的协议分支 —— 本机无对应 key
- ⚠️ **遗留**：`Observation` 契约目前只有 AI 观测在用，rank / geo_score
  仍是直接返回结构体。全面迁移刻意留到后续，会扩大改动面
- ⚠️ **fixture 会过期**：回归只证明相对 2026-09-21 的快照没变，
  需定期重跑 `scripts/capture-fixtures.ts`

---

## Phase 0 刻意没做的事

PostgreSQL ／ 完整 SQLite schema ／ 大规模 UI 重构 ／ Agent Planner ／ Mission ／
Auto Fix ／ Git PR 自动化 ／ 多租户 ／ 分布式 Crawler ／ 新增 SEO 功能 ／
删除或简化搜索引擎特殊处理。

**未进入 Phase 1。**

---

## 变更记录

```
98d1c17  docs: 记录 Phase 0 冻结
42b51a4  fix(mcp-stdio): 退出前等待响应 flush，避免大响应被截断
e44a1bc  test(ai-visibility): 五态全覆盖验证 + 修复 stdio 提前退出
60f382a  docs: 回填 Phase 0 交付 commit hash
76b970c  refactor(phase0): 建立可观测地基 Observable Foundation
─────────────────────────────────────────────────
5dfc848  test: 建立 Phase 0 改造前 baseline（先锁行为，后动代码）
```

---

MIT License · [WilstonZhou/geokit](https://github.com/WilstonZhou/geokit)
