# 能力完成度对照表（Phase 2 T0–T13）

> 规划项 vs 实际实现 vs 已知限制。不美化、不遗漏。

## T0: 工具集框架

| 规划项 | 状态 | 说明 | 限制 |
|--------|------|------|------|
| MCP Server（Streamable HTTP + stdio） | ✅ | 两种传输方式已支持 | — |
| 工具注册与路由 | ✅ | 25 个工具，统一的 ToolDef + callTool switch | — |
| 输入校验 | ✅ | 所有工具 args 经 typeof + 非空校验 | zod 仅用于 development deps，运行时未启用 zod schema 严格校验 |
| 错误处理 | ✅ | 统一抛 Error + isError 标记 | — |

## T1: 多引擎 SERP 采集

| 规划项 | 状态 | 说明 | 限制 |
|--------|------|------|------|
| 百度/搜狗/360/神马/头条自建采集 | ✅ | 自写解析器，直接拿数据 | 部分引擎会拦截服务端请求 → blocked |
| Google/Bing 采集 | ✅ | 自写解析器 | 同上有被拦截风险 |
| 位次解析 | ✅ | 真实排名位置（非估算） | 模拟数据绝不使用 |
| 摘要正文提取 | ✅ | 摘要为可直接阅读的正文 | — |
| 翻页采集 | ✅ | pages 参数 1-3 | 引擎可能限制翻页 |
| HTTP API /api/serp | ✅ | 与 MCP 同 service 实现 | — |
| Web UI /serp | ✅ | 交互式查询 | — |

## T2: AI 可见性与引用情报

| 规划项 | 状态 | 说明 | 限制 |
|--------|------|------|------|
| 9 个模型并发探测 | ✅ | DeepSeek/豆包/Kimi/通义/文心/元宝/ChatGPT/Claude/Gemini | 需用户自备 API key |
| 品牌提及检测 | ✅ | MENTIONED / NOT_MENTIONED | 不配置 key → UNOBSERVABLE |
| 引用来源提取 | ✅ | 答案文本中提取真实链接 | 无链接 → unavailable |
| 竞品标注 | ✅ | 传入 competitors 后在引用记录标注 | — |
| 竞品出现频次排行 | ✅ | analyze_ai_citations 输出 | — |
| 引用缺口分析 | ✅ | 被多模型引用但自家域名缺失 | — |
| 两次观测 diff | ✅ | 新增/失去提及与引用 | — |
| Web UI /visibility | ✅ | query × model 矩阵 | — |
| MCP check_ai_visibility | ✅ | 支持 competitors 参数 | — |
| MCP analyze_ai_citations | ✅ | 全量分析 | — |
| 并发限制 | ✅ | concurrency 默认 2，范围 1-5 | — |

## T3: 站点爬虫

| 规划项 | 状态 | 说明 | 限制 |
|--------|------|------|------|
| BFS 爬取 | ✅ | 同域页面 | — |
| robots.txt 遵守 | ✅ | Disallowed 路径不爬，遵守 Crawl-delay | — |
| 并发/间隔限制 | ✅ | 默认并发 2，间隔 500ms | — |
| 最大页面/深度/耗时限制 | ✅ | maxPages 100 / maxDepth 3 / 默认 2 分钟 | — |
| 跳转链记录 | ✅ | 每页记录跳转链 | FetchAttempt 不包含 URL，精确度有限 |
| 4xx/5xx 记录 | ✅ | 作为数据保留不丢弃 | — |
| 403 标注 blocked | ✅ | 不尝试绕过 | — |
| 站点图 | ✅ | 输出站点图 | — |
| 孤岛页标注 | ✅ | 标注低入链页面 | — |
| 每页 GEO 评分 | ✅ | 复用 audit.ts analyze() 纯函数 | — |
| Web UI /crawl | ✅ | 交互式爬取 | — |
| MCP crawl_site | ✅ | 支持全部参数 | — |

## T4: 站点问题诊断

| 规划项 | 状态 | 说明 | 限制 |
|--------|------|------|------|
| 重复标题/描述/H1 | ✅ | 站点级去重检测 | — |
| 缺失标题/描述/H1/canonical | ✅ | 逐页检测 | — |
| 孤立页/深层页/低入链 | ✅ | 基于爬取数据计算 | — |
| 跳转链/跳转循环 | ✅ | 检测与记录 | — |
| 损坏内链 | ✅ | 404/5xx 链接检测 | — |
| 缺失结构化数据 | ✅ | 检查 JSON-LD | — |
| 低 GEO 评分/弱维度 | ✅ | 阈值检测 | — |
| 重复内容（Jaccard） | ✅ | 基于指纹 | 指纹上限 300 shingle |
| T12 hreflang 问题接入 | ✅ | 7 类 hreflang 问题映射为 SiteIssue | — |
| diagnose_page MCP | ✅ | 全量诊断 | — |
| Web UI /diagnosis | ✅ | 交互诊断 | — |

## T5: GSC 搜索表现

| 规划项 | 状态 | 说明 | 限制 |
|--------|------|------|------|
| Search Analytics 查询 | ✅ | query/page/country/device 维度 | 需自备凭证 |
| 自动分页 | ✅ | 硬上限 25000 | — |
| OAuth 访问令牌 | ✅ | 环境变量注入 | — |
| 服务账号 + RS256 JWT | ✅ | 零依赖 node:crypto | — |
| 未配置优雅降级 | ✅ | unavailable + 配置说明 | — |
| 401/403/429 状态映射 | ✅ | blocked + 原因 | — |
| MCP get_search_performance | ✅ | 全参数支持 | — |
| MCP analyze_search_opportunities | ✅ | 三类机会 + 内容缺口 | 内容缺口需 crawledUrls |
| Observation 落库 | ✅ | gsc kind | — |

## T6: 机会引擎

| 规划项 | 状态 | 说明 | 限制 |
|--------|------|------|------|
| 8 种机会类型 | ✅ | 弱引用/引用缺口/AI 协议/站点问题/搜索机会/缺失实体/Schema 问题/性能差 | — |
| evidence 驱动 | ✅ | 无证据不输出 | — |
| impact/effort 排序 | ✅ | 高影响→低影响，低努力→高努力 | — |
| 同 target 合并 | ✅ | 去重 + 聚合建议 | — |
| 可验证 | ✅ | signalKey + direction | — |
| MCP list_opportunities | ✅ | 输入全可选 | — |
| MCP verify_opportunity | ✅ | resolved/unchanged/worsened/unknown | — |
| Web UI /opportunities | ✅ | 交互式机会列表 | — |

## T7: Query Intelligence

| 规划项 | 状态 | 说明 | 限制 |
|--------|------|------|------|
| 意图分类（5 类） | ✅ | 规则驱动 | 仅 5 类覆盖主要场景 |
| 相关问题提取 | ✅ | SERP + AI 答案切句 | 无可提取文本 → 空数组 |
| 竞品识别 | ✅ | SERP + AI 引用域名 | — |
| 内容缺口 | ✅ | 对照用户爬取 | 需爬取数据 |
| 聚类分析 | ✅ | Jaccard + 并查集 | — |
| MCP analyze_query | ✅ | 全可选字段 | — |
| MCP cluster_queries | ✅ | 参数可调 | — |
| Web UI /query | ✅ | 交互式分析 | — |

## T8: 竞品情报

| 规划项 | 状态 | 说明 | 限制 |
|--------|------|------|------|
| 五维对比 | ✅ | SERP/AI/GEO/Protocol/Schema | — |
| 失败处理 | ✅ | blocked/unavailable 标注 | — |
| 差距清单 | ✅ | 按 severity 排序 | — |
| 最多 5 竞品 | ✅ | 参数限制 | — |
| MCP compare_competitors | ✅ | 支持预收集数据 + 现场抓取 | — |
| Web UI /competitors | ✅ | 交互式对比 | — |

## T9: 内容质量信号增强

| 规划项 | 状态 | 说明 | 限制 |
|--------|------|------|------|
| 5 个新信号 | ✅ | FAQ/结构化密度/作者链接/gov.edu/更新一致性 | — |
| scoringVersion | ✅ | 2.1.0，历史 diff 兼容 | — |
| 子权重重分配 | ✅ | 各维 max 100 不变 | — |
| 竞品自动复用 | ✅ | competitor/geo.ts 自动获得 | — |
| diff 版本提示 | ✅ | comparable + caveat | — |

## T10: Schema / 实体诊断

| 规划项 | 状态 | 说明 | 限制 |
|--------|------|------|------|
| 7 类页面检测 | ✅ | 强/弱信号两级 | @graph publisher 不喧宾夺主 |
| 字段完整性检查 | ✅ | required/recommended 两级 | 仅 Schema.org 标准字段 |
| 一致性检查 | ✅ | headline↔H1 / datePublished↔页面日期 / author↔署名 | — |
| 实体清晰度 | ✅ | 作者/组织/sameAs/联系方式/发布时间 | — |
| 零编造草稿 | ✅ | JSON 只含真实值 + manualFields | 无币种→无 offers |
| MCP analyze_schema | ✅ | url/html 双参数 | — |
| MCP generate_schema_draft | ✅ | 零编造草稿 | — |
| Web UI /schema | ✅ | 类型判定/字段清单/一致性/草稿 | — |

## T11: Core Web Vitals / CrUX

| 规划项 | 状态 | 说明 | 限制 |
|--------|------|------|------|
| 5 项指标 | ✅ | LCP/INP/CLS/FCP/TTFB | — |
| p75 评估 | ✅ | good/ni/poor | — |
| 真实用户数据 | ✅ | 28 天滚动窗口 | — |
| 批量查询 | ✅ | 串行 + 间隔 | — |
| 429 截断 | ✅ | 遇限流自动截断 | — |
| 无 key 降级 | ✅ | unavailable | — |
| poor-web-vitals 机会 | ✅ | 进入 Opportunity Engine | — |
| MCP check_web_vitals | ✅ | urls[]/origins[]/formFactor | — |

## T12: 国际化 / hreflang

| 规划项 | 状态 | 说明 | 限制 |
|--------|------|------|------|
| 三种来源解析 | ✅ | HTML / HTTP header / sitemap | sitemap 用正则非 XML parser |
| 六类检查 | ✅ | 自引用/回链/代码/坏链/canonical/x-default | — |
| 语言声明疑似不一致 | ✅ | CJK 占比规则 | 仅中英覆盖 |
| 无多语言不误报 | ✅ | isMultilingual=false + 空 issues | — |
| 接入 T4 issues | ✅ | ISSUE_TYPES +7 | — |
| MCP check_hreflang | ✅ | pages[] + sitemapXml | — |

## T13: 收尾

| 规划项 | 状态 | 说明 | 限制 |
|--------|------|------|------|
| MCP 工具一致性检查 | ✅ | 描述/schema 统一，performance enum 补全 | — |
| README 全面更新 | ✅ | 能力表/环境变量/工具列表/闭环示例 | — |
| docs/ 数据模型说明 | ✅ | DATA_MODEL.md | — |
| docs/ 评分规则说明 | ✅ | GEO_SCORING.md | — |
| docs/ 扩展指南 | ✅ | EXTENDING.md | — |
| 质量门禁确认 | ✅ | typecheck/lint/test/build 全绿 | — |
| 依赖检查（4 个） | ✅ | next/react/react-dom/zod | — |
| 安全检查 | ✅ | 无密钥泄露/速率限制/输入校验 | — |
| 能力完成度对照表 | ✅ | 本文件 | — |
