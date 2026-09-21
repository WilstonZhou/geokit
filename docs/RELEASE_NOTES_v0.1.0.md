# 鲸析 GEOkit v0.1.0

> 面向中文市场与 AI 搜索时代的开源 SEO / GEO 作战系统

首个公开版本。**核心功能零付费 API 依赖** —— 装上就能跑。

```bash
npm install
npm run dev        # http://localhost:3210
```

---

## 为什么做这个

市面上成熟的 SEO 工具（包括开源方案 open-seo）几乎都有一个共同的结构性盲区：**Google 视角占绝对主导，中文搜索引擎缺席**。

这不是印象判断，是可复现的源码事实 —— 在 open-seo 的全量代码中：

| 关键词 | 出现次数 |
|---|---|
| `google` | 973 |
| `bing` | 7 |
| `baidu` | **0** |
| `sogou` | **0** |

连带的结果是：AI 可见性模型清单里没有 DeepSeek / 豆包 / Kimi / 通义 / 文心 / 元宝，`llms.txt` 只存在于 PM 文档里（代码为零），也没有针对「被 AI 引用」这件事的量化评分。

GEOkit 不去跟成熟工具比体量，而是把上述空白区做到能真正用起来。

---

## 四项核心能力

### 1. 多引擎 SERP 采集

自建采集，**7 个搜索引擎**：百度 / 搜狗 / 360 / 神马 / 头条 / Google / Bing。

自建最大的坑：除百度外，中文引擎普遍把结果包装成自家跳转链接（`sogou.com/link?url=`、`so.com/link?m=`），直接抓会得到一个全是搜索引擎自身域名的结果列表。逐一摸出的解法：

- 百度 → 容器上的 `mu` 属性
- 360 → `data-mdurl` 属性
- 搜狗 → `citeLinkClass` 展示文本

### 2. 页面审计 + 六维 GEO 评分

自研抓取与解析（HTTP 获取 + HTML 解析，无任何爬虫框架），**11 项技术检查** + 六维 GEO 评分：

可引用性 / 结构化程度 / 实体清晰度 / 可抓取性 / 事实密度 / 可读性时效

GEO 分回答的是传统 SEO 工具不回答的问题：**这段内容值不值得被 AI 引用。**

### 3. 中文 AI 可见性矩阵

**9 个模型的品牌提及探测**：DeepSeek / 豆包 / Kimi / 通义千问 / 文心一言 / 腾讯元宝 + ChatGPT / Claude / Gemini。

输出各模型的提及状态、引用域名与可见性得分 —— 顺带能看出「哪些域名被多个模型共同引用」，这比传统的「外链即权重」思路更贴近当下的投放现实。

### 4. AI 抓取协议层

robots.txt 里 **20 个已知 AI 爬虫**的策略检测（GPTBot / ClaudeBot / PerplexityBot / Bytespider / Google-Extended 等），加 llms.txt 的存在性校验与自动生成。

一句话看清：你的内容到底有没有对 AI 敞开。

---

## MCP Server

**8 个工具**，HTTP + stdio 双通道：

`list_engines` / `check_serp_ranking` / `audit_page` / `check_ai_visibility` / `analyze_robots` / `analyze_llms_txt` / `generate_llms_txt` / `compare_with_openseo`

让 Claude Code、WorkBuddy 这类 Agent 直接在对话里调用。CI 里有真实握手冒烟（`initialize` + `tools/list`），MCP 不会在无人察觉的情况下悄悄失效。

---

## 一条贯穿始终的原则

**抓不到就是抓不到。**

- 引擎被限流 → 返回 `blocked` + 具体原因 + 建议，不用估算值冒充真实排名
- 域名解析不出且重定向也救不回来 → 如实标注「中转未解析」，不抛脏数据
- 摘要里残存非人类可读的 JSON 碎片 → 宁可留空，也不展示
- AI 可见性未配置 API Key → 返回 `unconfigured`，不编造「某个模型说……」

这条原则让截图验收环节暴露出了两个 curl 完全看不出来的缺陷（均已修复），详见下方。

> **接口返回正确 ≠ 界面正确。** 截图是本项目的固定验收动作。

---

## 技术栈

Next.js 16 + React 19 + TypeScript + Tailwind v4。**直接依赖仅 4 个**：`next` / `react` / `react-dom` / `zod`。

HTML 解析、位次计算、robots 解析全部自研 —— 依赖少意味着供应链风险低，也意味着每个环节都能改到自己手里。

---

## 已知限制（诚实说明）

1. **中文搜索引擎有反爬阈值。** 短时高频请求会触发验证码（百度尤其明显）。当前版本未内置代理池与速率退避，生产环境高频使用需要自行扩展。
2. **AI 可见性需要自备 API Key。** 未配置时返回 `unconfigured`，不会给出虚假结果。
3. **单页审计是当前的默认粒度。** 尚未实现全站爬取与站级聚合报告。
4. **界面为中文。** 暂无 i18n 层。

---

## 变更记录

**`31fc528`** feat: 首个公开版本
**`266f7e6`** ci: GitHub Actions 验证流程（typecheck + build + MCP 握手冒烟）
**`5c519c3`** chore: 回填仓库元数据与 CI 徽章
**`55d4706`** fix: 摘要解析修复 + README 接入界面截图

其中 `55d4706` 修复了两个由截图验收暴露的真实缺陷：

1. **摘要展示未解码的转义序列** —— 中文引擎的数据嵌在页面 JSON 中，取出的是 `\u4ea4\u6613\u5e73\u53f0` 这类字面转义序列，渲染即乱码。新增 `unescapeUnicode()`，对 title 与 snippet 统一解码。
2. **摘要把内嵌 script 的 JSON 当正文** —— `stripTags()` 只去标签不去脚本，导致 `<script>` 内的结构化数据被当作正文，摘要变成 `"size":"md"},"abstract":"…` 的碎片。三层修法：剔除 script / style / noscript 整块 → 按描述块 class 关键词优先定位 → 兜底时宁可留空。

---

MIT License · [WilstonZhou/geokit](https://github.com/WilstonZhou/geokit)
