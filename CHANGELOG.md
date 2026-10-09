# 更新日志 (Changelog)

所有对本项目的重要变更都会记录在此文件中。
版本格式遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

---

## [1.0.0] - 2026-10-09

### 🚀 企业级持续观测底座正式封版 (V1.0 Release Audit Passed)

本次发布标志着 GEOkit 从“一次性扫描工具”全面升级为“企业级持续观测引擎”，补齐四大核心底座能力并实现全仓质量收口：

#### 1. 🕷️ Crawler 算法闭环 (Crawler Correctness & Budget Protection)
- **Sitemap 孤岛页受控抓取**：标准 BFS 遍历后检测爬虫预算（`visited.size < maxPages`），自动按配额补齐同源且未被内链发现的 Sitemap 孤岛页，打标 `orphan: true`，消除孤岛页观测盲区。
- **网络异常不丢弃存证**：抓取失败（网络超时/连接重置）不再静默丢弃，而是统一构造 `httpStatus: 0, statusReason: "connection_failure", outLinks: []` 实体存证，确保站点图真实可信。

#### 2. ⚡ 性能观测双路引擎 (Performance Observation & Fallback)
- **页面类型智能抽样**：新增 `samplePagesForPerformance` 智能抽样编排，基于 `detectPageType` 启发式规则从全量页面中按权重选取 1 个 homepage、最多 2 个 article、最多 2 个 product/landing，将 API 调用控制在 5 页以内，避免地毯式轰炸。
- **CrUX + PSI 实验室双路兜底**：低流量或无 CrUX 现场数据的冷门页面自动平滑降级至 Google PageSpeed Insights (PSI) 获取 Lighthouse 实验室数据，指标不达标（如 LCP > 4000ms）自动触发 `poor-web-vitals` 机会。

#### 3. 🛡️ MCP 运行时免疫系统 (Contract Hardening)
- **25 工具全量 Zod 拦截**：在 `callTool` 入口前置构建覆盖 25 个标准工具及历史兼容别名的 Zod Schema 映射表，对输入参数进行严格的类型、必填及业务条件 refine 校验。
- **JSON-RPC 友好错误反馈**：捕获参数错误并输出清晰的中文参数路径及原因，以符合 MCP 标准的 JSON-RPC 格式（`isError: true`）回传客户端，彻底消除未捕获异常导致 Node 进程崩溃的风险。

#### 4. 🧪 工程化质量门禁 (Quality Gates & CI/CD)
- **测试规模覆盖与契约同步**：全仓测试套件扩充至 452 项用例（126 个 Test Suites 全部通过），同步更新滞后的 MCP 测试工具总数与命名断言。
- **代码整洁度与自动化阻断**：全量清理 TypeScript `@typescript-eslint/no-unused-vars` 警告，达成 `0 errors, 0 warnings`；CI 工作流在 Typecheck 之后强制植入 `npm run lint` 与 `npm test` 阻断门禁。
