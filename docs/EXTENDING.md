# 扩展指南

## 新增搜索引擎

1. 在 `src/lib/serp.ts` 的 `ENGINES` 数组中添加引擎配置
2. 实现对应的解析器函数（如 `parseBaiduSerp`）
3. 在 `fetchSerp` 中添加路由分支
4. 更新 `list_engines` 工具的描述
5. 在 `tests/unit/serp.test.ts` 中添加解析测试

## 新增 AI 模型

1. 在 `src/lib/visibility.ts` 的 `AI_MODELS` 数组中添加模型配置
2. 实现对应的 API 调用函数（如 `callDeepSeek`）
3. 在 `checkAiVisibility` 中添加分支
4. 在 `analyzeCitations` 中添加引用提取
5. 更新环境变量文档（`.env.example`）

## 新增机会类型

1. 在 `src/lib/opportunity/types.ts` 的 `OPPORTUNITY_TYPES` 中添加类型
2. 在 `src/lib/opportunity/generators.ts` 中实现生成器函数
3. 在 `src/lib/opportunity/engine.ts` 的 `generateOpportunities` 中注册
4. 在 `countByType` 中添加计数
5. 在 `tests/unit/opportunity.test.ts` 中添加测试

## 新增诊断规则

1. 在 `src/lib/diagnose/rules.ts` 中定义规则（issueId、severity、detect、suggest）
2. 在 `src/lib/diagnose/index.ts` 的 `RULES` 数组中注册
3. 在 `tests/unit/diagnose.test.ts` 中添加测试

## 新增修复规则

1. 在 `src/lib/fix/rules.ts` 中定义修复规则（fixId、apply、idempotent）
2. 在 `src/lib/fix/index.ts` 的 `FIX_RULES` 数组中注册
3. 在 `tests/unit/fix.test.ts` 中添加测试

## 新增 GEO 评分信号

1. 在 `src/lib/geo/types.ts` 的 `ContentShape` 中添加字段
2. 在 `src/lib/audit.ts` 的 `analyzeContentShape` 中提取信号
3. 在 `src/lib/geo/v2.ts` 中分配子权重（从既有子项让权）
4. 递增 `scoringVersion`（如 2.1.0 → 2.2.0）
5. 在 `tests/unit/geo.test.ts` 中添加正/反例测试

## 新增 MCP 工具

1. 在 `src/lib/mcp.ts` 的 `TOOLS` 数组中添加定义
2. 在 `callTool` 的 switch 中添加 handler
3. 在 `tests/integration/mcp.test.ts` 中更新工具计数断言
4. 更新 README 的 MCP 工具列表

## 新增页面路由

1. 在 `src/app/` 下创建 `page.tsx` 和 `api/.../route.ts`
2. 在 `src/app/page.tsx` 的 `CAPABILITIES` 中添加卡片
3. 在 `next.config.ts` 中确认路由配置（如需要）

## 新增存储驱动

1. 实现 `Store` 接口（`src/lib/store/types.ts`）
2. 在 `src/lib/store/index.ts` 的 `createStore` 中添加分支
3. 在 `tests/unit/store.test.ts` 中添加测试

## 新增观测类型

1. 在 `src/lib/evidence/types.ts` 的 `ObservationKind` 中添加类型
2. 在 `src/lib/mcp.ts` 的 `list_observations` 工具 enum 中添加
3. 在对应的 observer 模块中实现 `recordXxxObservation`
4. 更新文档（`docs/DATA_MODEL.md`）

## 测试规范

- **单元测试**：`tests/unit/*.test.ts`，使用 `node:test` + `assert/strict`
- **集成测试**：`tests/integration/*.test.ts`，测试 MCP 工具调用
- **测试运行**：`npm test`（全部）、`npm run test:unit`、`npm run test:integration`
- **四门禁**：typecheck / lint / test / build 必须全部通过才能提交
