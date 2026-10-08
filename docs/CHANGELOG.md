---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '59d8d2b4-fdc7-45f9-8a52-a83a19992b08'
  PropagateID: '59d8d2b4-fdc7-45f9-8a52-a83a19992b08'
  ReservedCode1: '27bff339-e39a-4465-bc8d-e9e60b1fd285'
  ReservedCode2: '27bff339-e39a-4465-bc8d-e9e60b1fd285'
---

# 变更日志

本文件是 GEOkit 的唯一正源记录。所有决策、实现与修复均应写回此处。

## [Phase 2 T4] — 2026-10-08 · 站点级问题聚合（8 类规则 + 证据 + 疑似重复检测）

> 全部纯函数，输入 T3 的 CrawlResult，输出带 evidence 的问题列表。不调模型、不做 IO。

### 核心变更

1. **新增 `src/lib/crawler/issues.ts`**：`analyzeSiteIssues(result): SiteAnalysis` —— 8 类检查：① 重复 title/desc/H1（URL 分组）② 缺失 title/desc/H1/canonical ③ canonical 异常（跨域/指向 4xx/指向跳转页）④ 孤岛/深页/内链过少 ⑤ 跳转链过长/跳转循环/坏链 ⑥ JSON-LD 覆盖率 + 长文页缺 Schema ⑦ GEO 分数段分布/最低分页面/共性弱维度（同维度 ≥3 页偏弱）⑧ 疑似内容重复。
2. **每个问题**：稳定 `id`（type+URL 集合哈希，复检同问题 id 不变）、`severity`、`affectedUrls`、`evidence[]`（具体字段值/分组/相似度）、`whyItMatters`、`suggestedFix`。severity 阈值全部为顶部导出的可读常量并被测试断言。
3. **疑似内容重复**（`src/lib/crawler/content.ts`）：正文 5-gram shingle（英文按词、中文按单字）的 sha1 短哈希 + Jaccard 相似度，阈值 0.8；并查集聚组避免两两重复报告；只存哈希不存正文；<50 token 短页不参与；结论永远标注「疑似」并附百分比依据。`CrawlPage` 新增可选 `contentShingles` 与 `geoBreakdown`，采集时由 `crawlSite` 计算。
4. **判定边界**：内容/标签类问题只对「可索引 2xx 页面」（非 blocked、非 noindex）成立；canonical 4xx 检查的目标索引用全部页面（含 4xx），避免漏报。
5. **集成**：`crawl_site` MCP 输出新增 `issues` / `geoSummary` / `schemaCoverage`（仅新增字段，向后兼容）；`/api/crawl` 服务端计算后下发并剥离内部正文指纹；`/crawl` 页面新增问题区（严重度 chips + 类型下拉筛选，点击展开受影响 URL / 证据 / 影响 / 建议）。
6. **测试**：新增 `tests/unit/crawler-issues.test.ts` 31 项，每类问题均有命中与不命中两个方向，外加排序、id 稳定性、空结果用例。

### 验证

- `npm test`：227 项全量通过（+31）；`npm run typecheck`：0 error；`npm run lint`：0 error（8 既有 warning）；`npm run build`：成功。

### 已知限制

- 跳转链精度受 T3 采集限制：`FetchAttempt` 不含逐跳 URL，当前链最多记录最终 URL；多跳链/循环检查器已实现且有单测（合成输入），真实数据下检测精度随采集层升级而提升。
- 共性弱维度依赖各页 `geoBreakdown`，GEO 1.0.0/2.0.0 评分维度 id 不同，跨版本聚合时按维度 id 分别统计。

---

## [Phase 2 T3] — 2026-10-08 · 有上限的站点爬虫

> GEOkit 从单页审计升级为站点级审计的基础。有礼貌、有上限、可中断，零新增依赖。

### 核心变更

1. **爬虫核心**（`src/lib/crawler/`）：7 个模块拆分 —— `types`（接口+默认配置）、`normalize`（URL 规范化：去 fragment + 参数排序 + 尾斜杠 + 静态资源过滤）、`robots`（Disallowed 路径不爬 + Crawl-delay 遵守 + 任意路径 longest-match）、`sitemap`（零依赖正则解析 urlset/sitemapindex + 递归深度上限 3）、`graph`（站点图：节点+边+入链数+点击深度+孤岛标记）、`diff`（两次爬取 diff：新增/消失/状态变化）、`index`（`crawlSite` 编排器）。
2. **复用不另起一套**：`parseRobots` 从 `llms.ts` 导出（原内部函数）；每页解析复用 `audit.ts` 的 `analyze()` 纯函数（不调 `auditUrl` 避免重复 fetch + evidence 侧链）。
3. **礼貌爬取**：host-keyed 上次请求时间戳 map；delay = max(robots Crawl-delay × 1000, minRequestIntervalMs 默认 500ms)；并发上限 worker pool（同 `batchProbeVisibility` 模式）。
4. **可中断**：达到 maxPages / maxDepth / totalBudgetMs 任一上限时返回已爬结果 + `truncated: true` + 原因。
5. **不绕过反爬**：403/验证码 → `blocked: { reason }` 如实记录；4xx/5xx → 最小页面记录（不丢弃）；跳转链从 `finalUrl` 重建。
6. **Observation(kind="crawl") 落库**：`subject = siteSubject(origin)`，`source = httpSource(startUrl)`，落库前 `assertValidObservation` 校验，受 `GEOKIT_EVIDENCE` 总闸控制。
7. **可注入 fetcher**：`crawlSite(input, { fetcher? })` 默认 `fetchWithPolicy`，集成测试用内存假站点（`Record<string,string>` + 假 fetcher），不访问真实外网。
8. **API + MCP + 页面**：`POST /api/crawl`、MCP 工具 `crawl_site`（工具数 13→14）、`/crawl` 页面（列表 + 按状态码/孤岛筛选 + 统计卡）。
9. **FetchPurpose** 加 `"crawl"`（1 行 additive）。

### 验证

- `npm test`：196 项全量通过（+70 新断言）；`npm run typecheck`：0 error；`npm run lint`：0 error（8 既有 warning）；`npm run build`：成功，`/crawl` 与 `/api/crawl` 路由已注册。

### 已知限制

- 正则解析 sitemap 对畸形 XML 脆弱；递归深度上限 3 防失控。后续可换 `findTags` 风格解析。
- 复用 `analyze()` 不走 `auditUrl` 的 evidence 侧链：单页 `page_html` Evidence 不另存（v1 取舍，站点爬取是结论而非逐页证据链）。
- 单进程限速（host-keyed 时间戳 map）—— 多实例部署不适用；本地/CLI 工具足够。
- 无 JS 渲染（禁止无头浏览器）—— JS 渲染内容不爬取，README + UI 明示。

---

## [Phase 2 T2 补齐] — 2026-10-08 · 竞品链路全程透传 + 并发/超时可配置 + 五态测试补全

> 对照 T2 任务书逐条复核后发现的三个真实缺口，本轮补齐。

### 核心变更

1. **竞品列表由用户传入（T2 #1 补全）**：`competitors` 从 MCP 工具入参 → `probeVisibility` / `batchProbeVisibility` → `runVisibilityMatrix` → `probeProvider`（`ProbeContext.competitors`）→ `buildObservedProbe` → `extractCitations` 全程透传，探针落库前竞品提及就写入 CitationRecord。删除 `analyze_ai_citations` 里「拿到 rawResponse 后带竞品清单重新 extract」的兜底补丁（竞品本应在采集时记录，事后重提会让落库记录与输出记录口径不一致）。
2. **并发与超时可配置（T2 #2 补全）**：`analyze_ai_citations` 新增可选 `concurrency`（默认 2，clamp 1–5，替代硬编码 3）；单次 AI 调用超时支持 `GEOKIT_AI_TIMEOUT_MS` 环境变量覆盖（默认 30s）。
3. **`check_ai_visibility` 升级（向后兼容）**：新增可选 `competitors` 入参；probes 输出新增 `citation` 摘要（citationsStatus / citations / competitorsMentioned / mentionContext），旧字段一行未动。
4. **页面**：`/visibility` 增加可选竞品输入（逗号/空格分隔），随探测请求透传。
5. **测试**：`visibility-batch.test.ts` 新增「同一 query 内单模型 BLOCKED/ERROR/UNOBSERVABLE 不影响其他模型」用例，并断言失败态探针绝不产出引用记录 —— T2 验收的「有引用 / 无引用 / 模型拒答 / 超时 / HTTP 错误」五态至此全部有显式覆盖（126 项通过）。

### 验证

- `npm test`：126 项全量通过（+1）；`npm run typecheck`：0 error；`npm run lint`：0 error；`npm run build`：成功。

---

## [Phase 2 T1/T2] — 2026-10-07 · 观测模型扩展（schema 强校验 + 协议观测落库）与 AI 引用情报

> 目标：补齐 Phase 2 任务链 T1（Observation/Evidence/CitationRecord 数据模型 + 存档 + MCP 查询）与 T2（AI 引用情报）的验收缺口。核心原则不变：零新增依赖、「抓不到就说抓不到」在数据层强制执行、每条结论附 evidence。

### 核心变更

1. **zod 运行时校验模块（`src/lib/evidence/schema.ts`，新建）**：
   - `ObservationSchema` / `ExtractedEvidenceSchema` / `CitationRecordSchema`。
   - `superRefine` 强制：`status ∈ {blocked, unavailable, error, BLOCKED, ERROR, UNOBSERVABLE}` 时 `statusReason` 必填，缺失或全空白的观测写入即被拒绝（`assertValidObservation`），并提供 `validateObservation` 非抛出校验。
   - Observer 落库前统一过 schema 校验（ai.ts / protocol.ts）。
2. **协议观测落库（`src/lib/observers/protocol.ts`，新建）**：
   - robots.txt → `robots_policy`、llms.txt → `llms_txt` 两条通道接入 Phase 1 S1 契约（补齐 T1 适配缺口；替代中断会话遗留的违反架构的 `adapter.ts` 死代码，已删除）。
   - 状态映射：404/410 → `OBSERVED`（「文件不存在」是真实结论）；401/403/429 → `BLOCKED`；5xx → `ERROR`；无请求 → `UNOBSERVABLE`；失败状态均带 `statusReason`。
   - `llms.ts` 的 robots / llms 采集改走 `recordFetch`（总闸 `GEOKIT_EVIDENCE=on` 才写盘，关闭时行为零变化），分析结论落库失败只记日志不阻断。
3. **引用提取接线（T2 关键修复）**：
   - `visibility.ts` 的 `buildObservedProbe` 填充 `citation`（此前 `probe.citation` 从未被赋值，`ai_citation` 落库永不触发）；`extractCitations` 补全角句号剥离，防止中文回答 URL 污染域名统计。
   - `observers/ai.ts`：`ai_mention` 落库时同步落 `ai_citation` Observation；`citationsStatus` 为失败态时强制带 `statusReason`（「模型响应中未包含可提取的引用链接」）。
   - 引用 URL 仅提取自模型响应文本中真实存在的链接（Markdown 链接 + 裸 URL），模型不提供时 `citationsStatus = "unavailable"`，严禁编造。
4. **引用 diff 纯函数（`src/lib/visibility/aggregate.ts`）**：
   - `diffCitationRecords(prev, cur)`：按 (query, model) 匹配，输出新增/失去提及与引用 URL 增减。
   - 前值取 `observedAt` 严格早于当前记录的最新一条，防止本次运行刚写入存档的记录被误当前值。
5. **批量探测可注入（`src/lib/services/visibility.ts`）**：
   - `batchProbeVisibility` 增加第 4 个可注入 `probe` 参数（默认行为不变）；并发 workers 修正；单 query 失败隔离、空 query 跳过。
6. **MCP 扩展（`src/lib/mcp.ts`）**：
   - 新增 `analyze_ai_citations` 工具（第 13 个）：输入 queries/brand/domain/competitors，输出引用来源排行、竞品频次、引用缺口 + 每条结论 evidence + 与存档历史的 diff（`changes`；无存档时明示「无法对比」及开启条件）。
   - `list_observations` 保留 `query_history` 兼容别名（case fallthrough，不在 tools/list 重复列出）。
7. **`/visibility` 页面重写（`src/app/visibility/page.tsx`）**：
   - 多 query 批量输入（textarea 每行一个，最多 10 个）与进度显示。
   - query × model 矩阵表格：单元格展示提及状态 + 引用数徽标，`unavailable` / `blocked` 状态悬停显示原因，不留空白。
   - 探针明细展示引用来源列表、竞品提及、提及上下文；统计卡跨 query 聚合。
   - 修复既有 bug：`STATUS_TEXT` 缺 `INDETERMINATE` 键会在该状态下运行时崩溃。
8. **测试扩充（125 项全量通过，较此前 +31）**：
   - `tests/unit/observation-schema.test.ts`（新建）：statusReason 条件校验正反例、CitationRecord schema。
   - `tests/unit/visibility-batch.test.ts`（新建）：注入假 probe 覆盖多态产出、失败隔离、并发上限、空 query。
   - `tests/unit/diff.test.ts`：extractedEvidence 证据 diff 四情形（无变化/新增/删除/修改）。
   - `tests/unit/visibility.test.ts`：引用 diff（新增/失去提及、URL 增减、无前值不编造、本次运行记录不误当前值）。
   - `tests/integration/mcp.test.ts`：工具数 13、`analyze_ai_citations`、`query_history` 别名。
9. **类型修正（`src/lib/evidence/store.ts`）**：`recordFetch` 返回类型 `RawEvidence | null` → `Evidence | null`（如实声明实际返回值，向后兼容）。
10. **文档**：README 新增「观测与存档（Observation Store）」「AI 可见性与引用情报」章节（含各模型引用数据可得性说明），MCP 工具清单更新至 13 个，测试数与结构注释同步。

### 验证

- `npm test`：**125 项测试、47 个套件全量通过**（新增 schema 校验、批量探测注入、引用 diff 等用例）；
- `npm run typecheck`：0 error；
- `npm run lint`：0 error（8 个既有 warning，与本次改动无关）；
- `npm run build`：Turbopack 生产编译成功（`/visibility` 静态生成正常）；
- 存档目录 `.evidence/` 已在 `.gitignore`，默认总闸关闭不写盘。

---

## [重构 Phase R4] — 2026-10-03 · 全链路模型版本切换与消费端（UI/CLI/MCP/API）深度打通

> 目标：将 Phase R3 构建的 GEO 1.0.0 与 2.0.0 双版本模型，完整暴露给所有消费终端（CLI 命令行、MCP 智能体工具、HTTP API 与 Web 交互界面），形成“可随时切换、可比对验证、默认推荐 2.0.0 但严守 1.0.0 历史基线”的端到端能力闭环。

### 核心变更

1. **诊断服务层版本透明透传（`src/lib/services/diagnosis.ts`）**：
   - `CheckOptions`、`CheckReport` 统一扩充 `geoVersion?: GeoVersion`。
   - `checkUrl`、`checkHtml`、`checkFailure` 与 `autoFixHtml` 均支持透传 `geoVersion` 并在报告及修正前后保留版本标记。
2. **CLI 命令行参数支持 `--geo-version`（`packages/cli/src/bin.ts` & `output.ts`）**：
   - `geokit check <url> [--geo-version=1.0.0|2.0.0]`：指定版本评估页面。
   - `geokit gate ... [--geo-version=1.0.0|2.0.0]`：在 CI 门禁中支持按指定模型版本判定。
   - `renderCheck` Markdown 渲染支持在终端和 PR 评论中直观标注 `(v2.0.0)`。
3. **MCP Server 扩展（`src/lib/mcp.ts`）**：
   - `audit_page` 与 `diagnose_page` 工具 schema 增加可选 `geo_version: "1.0.0" | "2.0.0"` 参数，让 Claude/Cursor 等智能体自主决定采用哪套模型标准。
4. **API 与 Web 界面升级（`src/app/api/audit/route.ts` & `src/app/audit/page.tsx`）**：
   - POST `/api/audit` 支持 `geoVersion` 载荷。
   - Web 页面新增顶部**模型版本切换控制器**（GEO 2.0.0 推荐 vs GEO 1.0.0 经典基线），支持即时重跑比对，并在 GEO 评分卡片直观显示版本 Badge 与专属评估依据说明。
5. **分级集成测试扩充**：
   - `tests/integration/cli.test.ts`：补充 CLI `--geo-version` 与 Markdown 渲染测试。
   - `tests/integration/mcp.test.ts`：补充 `diagnose_page` 接受 `geo_version` 的 RPC 调用测试。

### 验证

- `npm test`：**88 项标准测试、40 个套件全量通过**（耗时 ~900ms，0 失败）；
- `npx tsx scripts/regression.ts check`：**基线回归完全一致**；
- `npm run typecheck`：0 error；
- `npm run build`：生产环境打包成功。

---

## [重构 Phase R3] — 2026-10-03 · 2026 AI Search / RAG Grounding 启发式标准与 GEO 2.0.0 升级

> 目标：将 GEO（生成式引擎优化）评分模型从 2024-2025 的朴素特征统计升级为 2026 年大模型检索（Google SGE/AI Overviews, ChatGPT Search, Perplexity）与 RAG 切块/引用启发式规范。同时采用严格版本门禁（Versioning Contract），保障既有 v1.0.0 与历史基线（baseline.json）100% 字节级一致。

### 核心变更

1. **GEO 评分模型版本化隔离（`src/lib/geo/`）**：
   - 抽象 `src/lib/geo/types.ts`：定义 `GeoVersion`（`"1.0.0"` | `"2.0.0"`）、`GeoInput`、`GeoResult` 与 `ContentShape`。
   - 实现 `src/lib/geo/v1.ts`：完全继承旧版评估逻辑，保持基线 70 分与 breakdown 六维输出毫无偏差。
   - 实现 `src/lib/geo/v2.ts`：2026 年 RAG 与大模型检索增强启发式体系（总分 100 分）：
     - **Quotability (25)**：首屏直接回答（Direct Answer，首屏 100-200 字高置信度回答）、高密度对比表格（HTML/Markdown 表格）、列表步骤。
     - **Structuredness (20)**：标题层级连续性（连续递进，H1->H3/H4 跳级惩罚以保护 RAG 递归分块树）、HTML5 语义地标（`<main>`/`<article>` 隔离侧边栏噪点）、深层 Schema.org 知识图谱。
     - **Entity Clarity (15)**：大模型知识库消歧关键属性 `sameAs` / `identifier` / 权威百科或社媒关联，作者与发布/修订时间戳双锚点。
     - **Crawlability (15)**：爬虫放行、显式 `lang` 属性（指导多语言 Embedding 向量空间分词路由）、传输健康。
     - **Fact Density (15)**：信息增益（Information Gain）、千字数据点密度、客观一手参考外链。
     - **Readability & Freshness (10)**：大模型注意力窗口句长适配（15-45 字符区间）、最新修订时间鲜活度。
   - 模块入口 `src/lib/geo/index.ts`：统一分发 `computeGeo(input, version = "1.0.0")`。
2. **审计引擎无缝集成（`src/lib/audit.ts`）**：
   - `analyze` 与 `auditUrl` 扩展可选 `opts?: { geoVersion?: GeoVersion }`，默认 `"1.0.0"`。
   - `PageAudit` 扩展 `geoVersion` 字段记录评估模型版本。
   - 内容形态提取器增强对 `hasDirectAnswer`、`hasSemanticLandmarks`、`headingContinuity` 与 JSON-LD `sameAs` 的提取。
3. **分级测试覆盖（`tests/unit/geo.test.ts`）**：
   - 覆盖 v1.0.0 基线回归（sample.html 70 分完全一致）。
   - 覆盖 v2.0.0 标题断层跳级惩罚、HTML5 语义地标加分、sameAs 知识库消歧加分以及 2026 年精准修复建议生成。

### 验证

- `npx tsx scripts/regression.ts check`：**完全一致通过（SEO 91 / GEO 70 / 11 项）**；
- `npm test`：**85 项测试全量通过**（新增 6 项 GEO 专项测试）；
- `npm run typecheck`：0 error；
- `npm run build`：Turbopack 生产编译成功。

---

## [重构 Phase R2] — 2026-10-03 · 原生 node:test 标准化与 Google-Grade 分级测试体系

> 目标：摆脱手写 ad-hoc 断言框架，全面拥抱 Node.js 20+ 原生 `node:test` + `node:assert/strict` 标准测试体系，保持零新增第三方依赖，建立 Small（单元测试）与 Medium（集成测试）分级架构。

### 核心变更

1. **测试架构分级规范化（Google SWE 标准）**：
   - 建立 `tests/unit/`（密封单元测试，纯内存、毫秒级、0 网络 IO）：
     - `html.test.ts`：标签匹配、同名嵌套、实体解码、域名提取、标题提取等 10 项测试。
     - `diagnosis.test.ts`：规则库映射、严重度计算、幂等修复、不覆盖原则等 17 组测试。
     - `diff.test.ts`：可比性前置校验、位次变化、状态演进、覆盖度不判退化等 9 组测试。
     - `evidence.test.ts`：规范化 URL、Subject/Source 构造、敏感 Header/URL 脱敏、状态聚合等 13 项测试。
     - `geo.test.ts`：GEO v1/v2 模型分发、基线一致性、RAG 分块断层惩罚、sameAs 消歧等 6 组测试。
   - 建立 `tests/integration/`（集成测试，本地文件与服务调用）：
     - `mcp.test.ts`：12 个 MCP 工具登记、离线诊断、修复幂等性、时序对比与异常处理等 6 项测试。
     - `cli.test.ts`：`check`、`gate`、`sarif`、`diff` 命令行离线构建与退出码判定等 15 组测试。
     - `sarif.test.ts`：SARIF 2.1.0 骨架、规则去重、位置映射、无 region 约束等 9 组测试。
2. **零新增外部依赖，统一原生 Test Runner**：
   - 在 `package.json` 中配置原生测试命令：
     - `npm test`：执行 `tests/**/*.test.ts`（全量标准测试）。
     - `npm run test:unit`：快速执行单元测试。
     - `npm run test:integration`：执行集成测试。
   - 兼容保留所有既有 `test:*` 脚本入口，保障已有 CI / 开发习惯零阻断。

### 验证

- `npm test`：**85 项标准测试、40 个测试套件全部通过**（0 失败，总耗时仅约 800ms）；
- `npm run typecheck`：0 error；
- 生产构建 `npm run build`：正常通过。

---

## [重构 Phase R1] — 2026-10-03 · 诊断服务下沉与 MCP 12 核心工具全能力打通

> 目标：打通各通道能力壁垒，将 Phase 1（Store/Diff）与 Phase 2（Diagnosis/Fix）完整赋能给 MCP Server 与各消费端。

### 核心变更

1. **下沉诊断服务层（`src/lib/services/diagnosis.ts`）**：
   - 收敛 `checkUrl`、`checkHtml`、`checkFailure`、`buildCheckReport` 与 `diagnoseProtocol`。
   - 新增 `autoFixHtml` 高级服务，打通「分析 → 诊断 → 过滤 suggestedFix → applyFixes」的完整自动修复闭环。
2. **重构 CLI 适配层（`packages/cli/src/check.ts`）**：
   - 移除包间私有实现，纯重导出 `src/lib/services/diagnosis.ts`，100% 保持既有 CLI、CI、SARIF 门禁契约与行为不变。
3. **MCP Server 扩展至 12 个核心工具（`src/lib/mcp.ts`）**：
   - 新增 `diagnose_page`：输出带 blocker/major/minor 计数、稳定 issueId 与 suggestedFix 的机器可读诊断。
   - 新增 `apply_fixes`：对 HTML 缺失的 canonical、viewport、lang、alt、og 骨架执行安全幂等自动修补。
   - 新增 `diff_observations`：对比两次观测，输出可比性与指标升降变化（支持 inline JSON 与 Store 历史时间线）。
   - 新增 `query_history`：翻查 Store 时序观测库，支持多维过滤与 latestOnly 当前状态收敛。
4. **自动化测试（`scripts/test-mcp.ts`）**：
   - 35 项测试全量覆盖：12 工具登记核对、离线诊断、修复幂等性（再次执行 changed=false）、Store 查询 hint 说明、diff 判定与异常容错。
5. **文档与 Web 页面动态联动**：
   - `/mcp` 页面由 `TOOLS.length` 动态渲染 12 个可用工具及其参数说明；`README.md` 更新徽标与工具清单。

### 验证

- `typecheck` 0 error；
- `npm run test:mcp`（35 项全过）；
- 现有测试（`test:cli` 69 项、`test:sarif` 52 项、`test:diagnosis` 63 项、`test:diff` 115 项、`test:store` 116 项、`test:sqlite-store` 50 项）全部 100% 通过；
- `npm run build` 生产构建成功（7 静态页 + 7 API 路由）。

---

**问题**：`package.json` 的 `lint` 脚本指向 `next lint`，但 Next.js 16 已移除该命令
（实测报错退出码 1）。项目此前无 ESLint 配置、CI 未跑 lint，缺陷一直未暴露。

**修复**：

- 新增 devDependencies：`eslint`、`eslint-config-next`、`@eslint/eslintrc`
  （仅开发依赖，运行时直接依赖仍为 4 个）
- 新增 `eslint.config.mjs`（flat config，走 `eslint-config-next/core-web-vitals`
  + `typescript` 子路径导出；`_` 前缀参数视为刻意预留位）
- `lint` 脚本改为 `eslint .`

**清零的 11 处问题**（1 error + 10 warning）：

| 位置 | 问题 | 处置 |
| --- | --- | --- |
| `llms.ts:278` | prefer-const（唯一 error） | `let` → `const` |
| `fetcher/index.ts` | 未使用函数 `hostOf` | 删除 |
| `diagnosis/index.ts` | 冗余导入 `FIX_RULES`/`FixRule` | 精简 import |
| `audit.ts:322` | 三元表达式作语句 | 改 if/else |
| `regression.ts` | `snapEngine` 冗余参数 `keyword` | 删参数及 3 处调用实参 |
| `test-sarif.ts:17` | 未使用导入 `snapshotOf` | 删除 |
| `test-store.ts` | 未使用类型导入 + `rp1c` 死赋值 | 删除 |
| `rate-limit.ts:33` | `_host` 刻意预留参数 | 规则层豁免（`^_` 前缀） |

**验证**：lint 0/0；typecheck 0 error；test:store 116、test:sarif 52、
test:diagnosis 63、test:cli 69 全过；regression 与 baseline 完全一致
（百度 21 / 360 4 / 搜狗 9，SEO 91 / GEO 70）；生产构建成功。

---

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