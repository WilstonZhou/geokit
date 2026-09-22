---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '4cf06090-50cc-45e4-beb1-ffb3a44efdda'
  PropagateID: '4cf06090-50cc-45e4-beb1-ffb3a44efdda'
  ReservedCode1: '05361384-df8f-4b75-9eb2-68dfaa762101'
  ReservedCode2: '05361384-df8f-4b75-9eb2-68dfaa762101'
---

# 变更日志

本文件是 GEOkit 的唯一正源记录。所有决策、实现与修复均应写回此处。

## [决策] — 2026-09-22 · 数据源强制原则（全局）

> 依据：《GeoKit 整体项目路线与实施规划》第 0 节「新增硬性原则」。

**项目所有数据源必须是自建检索（自写爬虫/解析器直接拿数据）或免费开源工具获取，
不引入任何付费数据源。**

已全量盘点仓库数据源，结论与豁免：

| 数据源 | 方式 | 合规 |
| --- | --- | --- |
| SERP 采集（7 引擎） | 自建爬虫 + 位次解析（`serp.ts`/`engines.ts`） | 合规 |
| 页面审计 / GEO 评分 | 自建抓取 + 本地分析（`audit.ts`） | 合规 |
| robots.txt / llms.txt | 自建协议层（`llms.ts`） | 合规 |
| HTTP 抓取 | Node 原生 `fetch`（`fetcher/`） | 合规 |
| 存储 | JSONL + `node:sqlite`（零新增依赖） | 合规 |
| CLI / CI 门禁 | 本地计算 + GitHub Actions 免费层 | 合规 |
| **AI 可见性探测（9 模型）** | **厂商官方 API（需用户自填 key）** | **唯一豁免** |

豁免理由（用户明确确认）：AI 可见性保留付费模型接口，用户使用时自行填入
`DEEPSEEK/DOUBAO/KIMI/QWEN/WENXIN/YUANBAO/OPENAI/ANTHROPIC/GEMINI_API_KEY`。
未配 key 时返回 `UNOBSERVABLE`（不伪造结果，见 Phase 0 冻结契约）。该豁免
不应再扩大范围；后续新增能力涉及外部数据一律先问「能否自建或免费开源」。

另：`.env.example` 中残留 `PERPLEXITY_API_KEY`，与 `visibility.ts` 的 `PROVIDERS`
（9 个）不一致 —— 该变量未被任何代码引用，属死配置，应清理。

---

## [Phase 0] — 2026-09-22 · Observable Foundation（已冻结）

> 交付说明：[`phase0-observable-foundation.md`](./phase0-observable-foundation.md)
> 基线 commit `5dfc848`（改造前行为快照）｜ 冻结 tag `phase0-frozen`

本阶段**不新增任何 SEO 功能**，只做一件事：让采集到的东西第一次具备
「可追溯 / 可重算 / 可被 Agent 信任」的性质。

职责铁律：**Fetcher 采集 / Evidence 保存事实 / Observer 生产结论**，三者不互相吞并。

### 六件事

1. **Unified Fetcher**（`src/lib/fetcher/`）— 9 处裸 `fetch` 收敛为唯一出口。
   统一 timeout / AbortController / headers / UA / retry+退避 / per-domain 限速 /
   request context。`maxAttempts` 默认 1，历史行为零变化。
2. **RawEvidence 契约**（`src/lib/evidence/types.ts`）— 不可变事实，写入后永不修改。
   request/response provenance 完整留存，敏感 header 脱敏（含 Gemini `?key=` 查询串）。
   **采集失败同样落证** —— 「抓不到」本身就是要留存的证据。默认不落盘。
3. **Observation 契约** — 结论与事实分离，带 `sourceEvidenceIds` / `parserVersion` /
   `confidence` / `caveat`。意义是将来能用新 parser 基于同一批证据重算历史。
4. **AI Visibility 可复现性**（`src/lib/visibility.ts` 重写）— 修复三个硬伤：
   temperature 此前只在 OpenAI 兼容路径设置（九个模型不是同一场实验）；
   原始回答被丢弃只留 400 字片段；prompt 无版本。
   现统一 `temperature=0 / maxTokens=1024`、留存 `rawResponse`、prompt 版本化 + hash。
   状态模型改**五态**：MENTIONED / NOT_MENTIONED / BLOCKED / ERROR / UNOBSERVABLE。
5. **Service Layer**（`src/lib/services/`）— HTTP 与 MCP 共用同一份实现。
   此前「选哪些引擎」「平均位次怎么算」「key 从哪来」在两条通道各写一遍。
6. **Regression**（`scripts/regression.ts`）— 零新增依赖；三家引擎 fixture 固化。

### 语义变更（需人工确认）

- **`visibilityScore` 分母从「配了 key 的探针数」改为「实际观测成功的探针数」**。
  没观测到的样本不再稀释比率，否则数字会比真实情况好看。
  五个计数全部返回，旧口径可还原。
- `averageRank` / `bestRank` 同理：被 block 的引擎不参与平均。
- 不带 `top_p`：Anthropic Messages API 在 temperature + top_p 同时传时报错。

### 过程中修复的真实缺陷

- **`scripts/mcp-stdio.ts` 会吃掉全部响应**（两次修复，两个不同的坑）
  - 坑一：`stdin.on("end", ...)` 直接 `process.exit(0)`。真实工具调用要几秒，
    end 在 await 期间触发并杀掉进程，**响应永远写不出来**。
    CI 冒烟只调 `list_engines` 这类零耗时工具，一直没暴露。改为在途计数。
  - 坑二：stdout 在 pipe 下是**异步**的，`write()` 返回 ≠ 已交给对端，
    `process.exit()` 会丢弃未 flush 的缓冲。`check_ai_visibility` 单条响应
    可达几十 KB，客户端会收到半截 JSON。退出改为必须等 flush 回调。
  - 对照实验（61 条请求，含一条 6 秒真实 AI 调用）：
    旧实现输出 **0 字节 / 响应 0/61**；新实现 **194586 字节 / 61/61，零损坏行**。
- **`evidence/store.ts` 让 Turbopack 把整个项目 trace 进服务端产物** ——
  动态路径的 fs 调用导致。已在每个调用点加 `/* turbopackIgnore: true */`。
- **`api/visibility/route.ts` 改一半留下断链** —— 函数体改调 service 但 import
  还是旧符号。build 有时能混过去，只有 `tsc --noEmit` 会报。

### 验证结果

- typecheck 0 error；`next build` EXIT=0（7 静态页 + 5 API route）
- 回归与 baseline 完全一致：百度 21 / 360 4 / 搜狗 9，畸形 0；审计 SEO 91 / GEO 70 / 11 项
- `scripts/verify-ai-visibility.ts`：五态 **5/5 覆盖**，带真实 key 时 18/18 通过。
  关键设计：五态中四种可**确定性构造**（mock 401 → BLOCKED、`127.0.0.1:1` → ERROR、
  mock 回答含/不含品牌 → MENTIONED/NOT_MENTIONED），因此无 key 环境仍能覆盖 5/5 并进 CI
- Provenance 硬验证：`Authorization: [REDACTED]`，全量搜索密钥片段零命中
- MCP stdio：8 工具齐全

### 冻结状态

- 未进入 Phase 1。**刻意未做**：PostgreSQL / 完整 SQLite schema / 大规模 UI 重构 /
  Agent Planner / Mission / Auto Fix / Git PR 自动化 / 多租户 / 分布式 Crawler /
  新增 SEO 功能 / 删除或简化搜索引擎特殊处理。
- 已知遗留：`Observation` 契约目前只有 AI 观测在用，rank / geo_score 仍是直接返回
  结构体；BLOCKED / ERROR 两态虽有真实触发，但其余 8 个模型的协议分支仍无 key 验证；
  fixture 会过期，需定期重跑 `capture-fixtures.ts`。

---

## [0.1.0] — 2026-09-21

### 初始版本

基于对 https://github.com/every-app/open-seo 的源码级深度分析构建。
分析结论见 [`ANALYSIS.md`](./ANALYSIS.md)。

### 新增

**核心引擎（`src/lib/`）**

- `engines.ts` — 7 个搜索引擎注册表。其中百度/搜狗/360/神马/头条五个中文引擎，
  在 open-seo 源码中的提及次数为 0。
- `html.ts` — 零依赖 HTML 解析（标签匹配支持同名嵌套、实体解码、域名提取）
- `serp.ts` — 多引擎采集与位次解析
- `audit.ts` — 页面审计 + GEO 六维评分
- `visibility.ts` — 9 个模型的中文 AI 可见性探测
- `llms.ts` — robots AI 策略检测 + llms.txt 校验与生成
- `mcp.ts` — MCP server（JSON-RPC 2.0，8 个工具）

**API 路由**

- `POST /api/audit` — 支持在线抓取与离线 HTML 两种模式
- `POST /api/serp` / `GET /api/serp` — 多引擎采集与引擎清单
- `POST /api/visibility` / `GET /api/visibility` — 可见性探测与密钥状态
- `GET/POST /api/llms` — 协议分析与生成
- `POST /api/mcp` — Streamable HTTP MCP 端点
- `scripts/mcp-stdio.ts` — stdio 传输入口

**页面**

- `/` 总览与实测对比
- `/serp` 多引擎排名
- `/audit` 页面审计与 GEO 评分
- `/visibility` AI 可见性矩阵
- `/llms` AI 抓取协议工作台
- `/mcp` MCP 接入说明

### 过程中修复的真实缺陷

这些问题都是跑真实数据才暴露出来的，不是自测用例：

1. **GEO 实体清晰度漏判 JSON-LD**
   初版只读 `<meta name="author">`，导致把作者信息写在 JSON-LD 里的站点被误判为
   「缺少署名」（实体清晰度 4/15）。改为 JSON-LD 深度遍历 + meta 双重识别，
   同一样本从 4/15 提升到 11/15，GEO 总分 63 → 70。

2. **短文本事实密度虚高**
   77 字的正文算出「每千字 39 个数据点」。改为分母加 300 字下限，
   并对 wordCount < 300 的页面做分数封顶。

3. **中转链接误杀（严重）**
   除百度外，中文引擎普遍把结果包装成自家中转链接
   （`sogou.com/link?url=…`、`so.com/link?m=…`）。初版把这类域名当作
   「搜索引擎自身结果」直接过滤，导致大量真实结果被丢弃。

4. **各引擎真实 URL 提取策略**
   对着真实返回页逐个核对后得出：
   - 百度 → 容器 `mu` 属性
   - 360 → `data-mdurl` 属性
   - 搜狗 → `citeLinkClass` 元素可见文本

5. **搜狗 cite 文本截断**
   显示层会截断域名（`https://global.lianlianpa…`）。加了后缀白名单 + 长度校验，
   截断片段坚决丢弃，宁可退回重定向也不给错误域名。

6. **非法域名兜底**
   域名解析出 `.` 这类垃圾值时，统一降级标记为「中转未解析」，不在 UI 上抛脏数据。

7. **摘要展示未解码的转义序列（截图时发现）**
   中文引擎把结果数据塞在页面内嵌 JSON 里，取出的文本是
   `\u4ea4\u6613\u5e73\u53f0` 这种字面转义序列，直接渲染给用户就是一串乱码。
   新增 `unescapeUnicode()`，对 title 与 snippet 统一还原成可读文本。

8. **摘要把内嵌 script 的 JSON 当正文（截图时发现，比 7 更严重）**
   修完 7 之后暴露出更深的层次：`stripTags()` 只去标签不去脚本，于是 `<script>`
   里的结构化数据被当成正文，摘要变成 `"size":"md"},"abstract":"…` 这样的碎片。
   修法三层：
   - 先剔除 `<script>` / `<style>` / `<noscript>` 整块内容
   - 按 `abstract` / `desc` / `summary` / `space-txt` / `content-right` 等
     各引擎惯用的 class 关键词优先定位描述块
   - 兜底：若文本仍残留 JSON 结构符号（`":"` 或 `},{`），判定为非人类可读内容，
     **宁可留空也不展示垃圾**

   > 这两条是「用真实截图验收」才逼出来的 —— 接口返回的 JSON 里转义字符不显眼，
   > 只有把它渲染成给人看的界面，问题才会浮出来。

### 实测结果

以「跨境支付」为关键词的中国五引擎采集（2026-09-21 实跑）：

| 引擎 | 条目 | 真实域名解析率 |
| --- | --- | --- |
| 百度 | 14 | 13/14（含 cips.com.cn、paypal.com、lianlianpay.com、airwallex.com、lakala.com） |
| 搜狗 | 9 | 8/9（含 zhihu.com、cifnews.com、csdn.net、eastmoney.com） |
| 360 | 4 | 4/4（含 iyiou.com、useepay.com、163.com） |
| 头条 | 1 | 1/1 |
| 神马 | 0 | 返回 `no_results` + 明确说明，不用假数据填充 |

### 已确立的工程原则

> **抓不到就是抓不到。**

搜索引擎会拦截服务端直连，这是躲不开的工程现实。GEOkit 统一返回
`status: "blocked"` + 原因 + 解决方向，绝不用估算值、缓存旧数据或随机数
冒充真实排名。这条原则覆盖所有接口，包括 AI 可见性 —— 没配 API key 就返回
`unconfigured`，不编造「某模型说……」。

### 技术选型说明

Next.js 16 / React 19 / Tailwind v4 / TypeScript，**直接依赖 4 个**。
HTML 解析、位次计算、robots 解析全部自研，不引 cheerio/jsdom。

选 Next.js 而非 open-seo 的 TanStack Start，是为了让整套东西在周老板现有的
技术栈里可以直接改、直接上线。

> AI生成