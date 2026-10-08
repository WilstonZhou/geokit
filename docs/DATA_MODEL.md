# 数据模型说明

## 核心概念

GEOkit 的数据层遵循**两层分离**原则：

1. **Evidence（存证）**：原始请求/响应的不可变记录，append-only，永不改写
2. **Observation（观测）**：基于 Evidence 的结构化结论，带 observer/parser 版本与状态，可随时重算追溯

## 数据类型

### ObservationKind（观测类型）

| 类型 | 来源 | 说明 |
|------|------|------|
| `rank` | SERP 采集 | 多引擎关键词排名 |
| `geo_score` | 页面审计 | GEO 六维评分 |
| `ai_mention` | AI 可见性 | 品牌是否被 AI 提及 |
| `ai_citation` | AI 引用情报 | 引用来源、竞品、缺口 |
| `robots_policy` | 协议层 | robots.txt AI 策略 |
| `llms_txt` | 协议层 | llms.txt 校验结果 |
| `crawl` | 站点爬虫 | 站点图与页面摘要 |
| `serp` | SERP 采集 | 原始 SERP 响应 |
| `audit` | 页面审计 | 完整审计报告 |
| `gsc` | GSC | Search Analytics 聚合 |
| `performance` | CrUX | Web Vitals 真实用户数据 |

### Observation 状态机

```
OBSERVED → MENTIONED / NOT_MENTIONED
    ↓
BLOCKED / ERROR / UNOBSERVABLE
```

- **OBSERVED**：正常观测成功
- **MENTIONED**：AI 答案中提及品牌
- **NOT_MENTIONED**：AI 答案中未提及品牌
- **BLOCKED**：被目标方拦截（403/429/验证码）
- **ERROR**：我方调用失败（网络错误/超时）
- **UNOBSERVABLE**：无法观测（未配置 API key）

### statusReason 强制约束

当 `status ∈ {blocked, unavailable, error}` 时，`statusReason` **必填**。
缺 reason 的观测写入即被 schema 层拒绝。

## 存储实现

- **默认 JSONL**：写入 `.evidence/` 目录（已加入 `.gitignore`）
- **SQLite**：`GEOKIT_STORE_DRIVER=sqlite` 切换为 Node 内置 `node:sqlite`
- **零新增依赖**：接口抽象，可换驱动

## 环境变量

| 变量 | 说明 | 必需 |
|------|------|------|
| `GEOKIT_EVIDENCE` | 观测落库总闸（`on`/`off`） | 否 |
| `GEOKIT_STORE_DRIVER` | 存储驱动（`jsonl`/`sqlite`） | 否 |
| `GEOKIT_STORE_DIR` | 自定义存档目录 | 否 |
| `GEOKIT_EVIDENCE_BODY` | 留存响应体（`on`/`off`） | 否 |
| `GEOKIT_AI_TIMEOUT_MS` | AI 探测超时（默认 30000） | 否 |
| `GEOKIT_EVIDENCE_TIMEOUT_MS` | 观测落库超时（默认 30000） | 否 |
| `CRUX_API_KEY` | Chrome UX Report API key | 否 |
| `GOOGLE_OAUTH_ACCESS_TOKEN` | GSC OAuth token | 否 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | GSC 服务账号 JSON | 否 |
| `GOOGLE_APPLICATION_CREDENTIALS` | GSC 服务账号文件路径 | 否 |
| `DEEPSEEK_API_KEY` 等 9 个 | AI 模型 API key | 否 |
