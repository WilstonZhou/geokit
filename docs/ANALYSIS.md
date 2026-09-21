# open-seo 深度解析报告

> 分析对象：https://github.com/every-app/open-seo
> 方法：仓库全量克隆后做源码级扫描（`depth=1`，1419 个文件 / 284,500 行）
> 结论中的所有数字均可复现，不含推测

---

## 一、它是什么

自称 **"Open source alternative to Semrush and Ahrefs"**，口号是 _"SEO tool for the people"_。

三条产品线：

| 形态 | 说明 |
| --- | --- |
| 自托管 | 两条路径：Docker（简单，适合试用）、Cloudflare（推荐，免费额度可用） |
| 托管版 | openseo.so，**$10/月**，托管版对每次 DataForSEO 请求加价 28% |
| MCP + Skills | 对外主打「给 AI Agent 用」而非「给人用」 |

作者 Ben Senescu（X: @bensenescu），许可证 MIT（2026）。

---

## 二、技术栈（源码核实）

```
前端        TanStack Start 1.168 + React 19 + Vite
           Tailwind v4 + daisyUI 5.5（组件库）
           @tanstack/react-router（类型安全路由）
           @tanstack/react-query + react-table + react-form
           recharts / lucide-react / sonner
后端        TanStack Start server functions
           Cloudflare Workers（主要目标）+ Docker 自托管
数据        Drizzle ORM，SQLite(D1) 与 PostgreSQL 双 schema
           Drizzle 迁移目录分 drizzle/ 与 drizzle-pg/
认证        better-auth 1.6 + @better-auth/api-key
           @modelcontextprotocol/sdk（OAuth provider）
          Workers OAuth Provider（Cloudflare）
AI          ai 6.0 + @ai-sdk/react + @openrouter/ai-sdk-provider
计费        autumn-js
监控        posthog-js / posthog-node
构建/部署   alchemy.run.ts（22876 行 —— 是的，基础设施定义就有两万多字）
```

**直接依赖 44 个**。这个数字后面会用到。

---

## 三、真实功能清单（按路由逐一核实）

| 路由 | 功能 |
| --- | --- |
| `_app/index` | 项目总览看板 |
| `_app/ai` | AI 对话入口 |
| `_app/billing` | 订阅计费 |
| `_app/settings/organization` | 组织设置 |
| `_app/team` | 团队协作 |
| `_project/p/$id/domain` | 域名概览 |
| `_project/p/$id/keywords` | 关键词研究 |
| `_project/p/$id/backlinks` | 外链分析 |
| `_project/p/$id/audit` | 站点审计 |
| `_project/p/$id/rank-tracking` | 排名追踪 |
| `_project/p/$id/search-performance` | GSC 搜索表现 |
| `_project/p/$id/brand-lookup` | AI 品牌查询 |
| `_project/p/$id/prompt-explorer` | Prompt 对比 |
| `_project/p/$id/reports` | 报告中心 |
| `_project/p/$id/saved` | 已保存关键词 |
| `_project/p/$id/sam` | 竞品 / 市场 SAM |
| `api/ga4/oauth` + `api/gsc/oauth` | GA4 / GSC OAuth 接入 |

**这不是玩具项目**。它有完整的 auth / team / billing / integration 层，产品完成度相当高。

---

## 四、数据从哪来

这是理解它商业模式的关键。

### 依赖 DataForSEO 的部分

几乎**所有**关键词、外链、AI 可见性数据。源码中出现的 DataForSEO 端点：

```
backlinks/summary/live                       15 次
serp/google/organic/live/advanced             4 次
ai_optimization/llm_mentions/top_pages/live   3 次
ai_optimization/llm_mentions/search/live      3 次
ai_optimization/llm_mentions/cross_aggregated_metrics/live
ai_optimization/llm_mentions/aggregated_metrics/live
serp/google/maps/live/advanced                1 次
serp/google/local_finder/live/advanced        1 次
business_data/google/reviews/task_post        2 次
business_data/google/my_business_info/live    2 次
serp/google/locations/                        1 次
```

自托管时用户自己出这份钱，托管版则在成本上加 28%。

### 自研的部分（值得肯定）

`src/server/lib/audit/` 是**真正的自研爬虫**，不是包装 API：

```
discovery.ts          URL 发现
page-analyzer.ts      页面分析
crawl-throttle.ts     限速
crawl-window.ts       抓取时间窗
multipage.ts          多页检测
multipage-checks.ts   跨页规则
lighthouse.ts         Lighthouse 集成
url-policy.ts         URL 策略
```

配套 `AuditService` + `auditReconciler` + `AuditRepository`，以及完整的工作流编排。
这部分做得相当扎实，是它最值钱的代码。

---

## 五、MCP 与 Agent Skills（它的头号卖点）

### MCP 工具（约 25 个）

```
create_project / list_projects / get_project_context
research_keywords / get_domain_keyword_suggestions
get_domain_overview / get_ranked_keywords
get_backlinks_overview / get_backlinks_profile
create_rank_tracker / add_rank_tracking_keywords / remove_rank_tracking_keywords
estimate_rank_tracker_cost / get_rank_tracker / run_rank_tracker
get_serp_results / search_serp_locations
local-seo-tools（1027 行，含 get_business_profile）
google-analytics-tools（670 行）
search-console-tools
report-tools / report-template-tools
save-keywords / list-saved-keywords / remove-saved-keywords
site-audit-tools / site-audit-cleanup-tools
dataforseo-research-tools（1113 行）
```

配套完整的 OAuth provider、API key 认证、output schema 契约测试、transport v2。
**这块它做得确实专业**，值得 GEOkit 直接对齐。

### Agent Skills（`.agents/skills/`）

```
keyword-research     keyword-clustering    link-prospecting
competitor-analysis  competitive-landscape local-seo
seo-audit            seo-coach             seo-project-setup
seo-report           setup-openseo         verify-local-mcp
```

还配了 `.claude-plugin/`、`.cursor-plugin/`、`.opencode/command/` 的 marketplace 文件，
以及一份 33,916 行的 `chatgpt-app-submission.json`（提交 ChatGPT App Store 用的）。

---

## 六、完成度评估：诚实地说

### 它做得好的

- **站点审计是真货**：自研爬虫 + 工作流编排 + 断点续跑，不是 API 包装壳
- **MCP 工程化到位**：认证、输出契约、测试一并齐全
- **AI Skills 有产品化思考**：不是把 prompt 丢进仓库，而是成体系的工作流
- **基础设施定义完整**：alchemy.run.ts 一行跑去 Cloudflare，自托管体验着想得挺细

### 它的结构性短板

#### 1. 中文市场：完全缺席

这是硬事实，不是观感：

| 关键词 | 在源码中出现的文件数 |
| --- | --- |
| `google` | 973 处引用 |
| `bing` | 7 处引用 |
| `baidu` | **0** |
| `sogou` | **0** |
| `toutiao` | **0** |
| `yandex` | **0** |

它的 SERP、排名追踪、本地 SEO、例句抓取，全部建立在 Google 的 `location_code` /
`language_code` 体系上。对中文站点而言，这套东西拿不到任何有效数据。

#### 2. AI 可见性：只认西方模型

`src/server/features/ai-search/` 里支持的模型：

```
chat_gpt     23 次
claude        3 次
gemini        1 次（gemini-2.5-pro）
perplexity    1 次
```

而且注释里写明「mirrors DataForSEO's llm_responses/models catalog」——
**模型清单是被它的上游数据商限定的**，不是自己选的。

DeepSeek、豆包、Kimi、通义、文心、元宝：一个都没有。
而中国用户实际在用正是这六个。

#### 3. 数据主权：一切都押在 DataForSEO 上

自托管承诺「不订阅、按用量付费」——但那个用量是从 DataForSEO 买的。
这意味着：

- GEO 相关的创新边界 = DataForSEO 的 API 边界
- 中文数据源不可能出现（DataForSEO 没有）
- 想加一个 DataForSEO 不支持的维度，只能自己另起数据管道

#### 4. llms.txt：有想法，没代码

全仓库搜索 `llms.txt`，唯一命中：

```
docs/site-audit-pm-research.md
```

一份 PM 产品研究文档。**没有任何实现**。

#### 5. GEO 评分：无

它的审计回答的是「Google 会不会收录我」。2026 年真正的问题是
「ChatGPT / DeepSeek 愿不愿意引用我」——这个维度它完全没有。

#### 6. UI 国际化：无

没有 i18n 层（搜到的 `locale` 都是表格页本地变量的同名误命中）。英文单语。

#### 7. 体量与门槛

44 个直接依赖 + 284,500 行 + Cloudflare/Alchemy 的强绑定。
README 里自己也承认：「自托管建议用 Cloudflare，Railway/Coolify/Dokploy 的支持未来几个月再加」。

想 fork 后二次开发，认知负担不小。

---

## 七、GEOkit 的差异化决策

基于以上**实测**而非臆测的空白，GEOkit 选取了四个战场：

| 差异项 | open-seo 的事实 | GEOkit 的做法 |
| --- | --- | --- |
| 中文引擎 | baidu/sogou 提及 **0 次** | 百度/搜狗/360/神马/头条自建采集 |
| 中文 AI 模型 | 完全不覆盖 | DeepSeek/豆包/Kimi/通义/文心/元宝 + 三大国际模型 |
| 数据依赖 | 核心数据全走付费 API | 核心能力零付费依赖，自建引擎 |
| GEO 评分 | 无 | 六维 AI 引用友好度 + 可执行建议 |
| llms.txt | 仅一份 PM 文档 | 检测 + 校验 + 自动生成 |
| 依赖数量 | 44 个 | 4 个 |

### 两个关键工程决策，值得单独说明

**① 中转链接的真实域名解析**

踩过的坑：早期版本把搜索引擎自身的跳转链接（`sogou.com/link?url=…`、
`so.com/link?m=…`）当成「搜索引擎自己的结果」直接过滤，**大量真实结果被误杀**。

对着真实返回页逐个核对后，得到三个引擎各自的解法：

- 百度 → 结果容器上的 `mu` 属性直接给出真实 URL
- 360 → 结果 `li` 上的 `data-mdurl` 属性
- 搜狗 → `citeLinkClass` 元素里的可见文本

搜狗的 cite 文本会被显示层截断（`https://global.lianlianpa…`），
所以加了一道域名合法性校验：非白名单后缀且长度异常的坚决丢弃，
宁可退回中转链接走重定向解析，也不给用户一个错误的域名。

这是 open-seo 不需要面对的问题 —— 它花钱买数据时，域名是干净的直接给它的。

**② 抓不到就是抓不到**

搜索引擎会拦截服务端直连。这是所有自托管 SEO 工具都躲不开的工程现实。
GEOkit 的选择：返回 `status: "blocked"` + 具体原因 + 解决方向，
**绝不用估算值、缓存旧数据或随机数冒充真实排名**。

这条原则写进了每一个接口，包括 AI 可见性 —— 没配 API key 就返回
`unconfigured`，而不是编一段「DeepSeek 说……」给你看。

宁可让你知道「这次没抓到」，也不要让你基于假数据做出错的投放决策。

---

## 八、结论

open-seo 是一个**值得尊敬的对手**：工程量大、自研爬虫真材实料、MCP 工具链完整、
AI Skills 有产品化思考。它的问题不在能力，而在**视野边界** ——
它的世界里只有 Google 和西方 AI 模型。

GEOkit 不打算在「全套 SEO 套件」这个战场上跟它比体量。
它选择在 open-seo **结构性缺席**的地方做到最好：

> 中文搜索引擎 + 中文 AI 可见性 + GEO 评分方法论

同时把整套代码保持在 Next.js 16 + 4 个依赖的规模 ——
让你 fork 之后能看懂、能改。

---

*本报告的数据可通过克隆仓库后运行 `grep` 验证。所有计数均指源码文件中的出现频次。*
