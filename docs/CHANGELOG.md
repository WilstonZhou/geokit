# 变更日志

本文件是 GEOkit 的唯一正源记录。所有决策、实现与修复均应写回此处。

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
