# GEOkit 架构盘点与演进路线

> 评估对象：`WilstonZhou/geokit` v0.1.0（5,111 行 / 24 个源文件）
> 评估日期：2026-09-21
> 本文回答十三个架构问题，并给出分阶段落地顺序。

---

## 总判定

**GEOkit 现在是一个「无状态的即时分析器」，而你描述的那个东西是「带时间维度的观测系统」。**

这不是功能多少的问题，是**缺少一个维度**：时间。

现在的每一次调用都是一次孤立快照 —— 请求进来，抓一把，算个分，返回，然后什么都不留。所以系统无法回答：

- 排名是涨了还是跌了？（没有历史）
- 这个结论依据是什么？（没有原始素材）
- 相对上次是变好还是变差？（没有基线）
- AI 真的没提及我，还是我没检测到？（没有留存）

这四个问题分别是 **Search Observer / Evidence / CI 门禁 / AI Observer** 要解决的。它们不是四个独立功能，**是同一个缺失维度的四个投影**。

所以演进的主线只有一条：**先把 Observable（可观测事实）沉淀下来，其余能力都是从它长出来的。**

---

## 一、现在有什么

| 层 | 模块 | 行数 | 职责 | 状态 |
|---|---|---|---|---|
| 引擎 | `lib/engines.ts` | 179 | 7 个搜索引擎的定义与 UA 策略 | 干净 |
| 引擎 | `lib/serp.ts` | 493 | SERP 采集 + 中转链接解析 + 位次计算 | 实战验证过 |
| 引擎 | `lib/audit.ts` | 665 | 页面抓取 + 11 项检查 + 六维 GEO 评分 | 核心资产 |
| 引擎 | `lib/visibility.ts` | 343 | 9 个 AI 模型的品牌提及探测 | **有硬伤** |
| 引擎 | `lib/llms.ts` | 514 | robots 策略 + llms.txt 校验与生成 | 干净 |
| 引擎 | `lib/html.ts` | 205 | HTML 解析器（自研，零依赖） | 干净，可独立成库 |
| 传输 | `lib/mcp.ts` | 419 | MCP Server，8 个工具 | 需演进 |
| 传输 | `app/api/*/route.ts` | 306 | 4 个 HTTP 端点 | 薄，但藏了业务逻辑 |
| 传输 | `scripts/mcp-stdio.ts` | 50 | stdio 通道 | 够用 |
| UI | `app/*/page.tsx` | 1,326 | 5 个页面 | 够用 |
| UI | `components/ui.tsx` | 168 | 组件原语 | 够用 |

**关键缺失（全部为零）：**

```
持久化      ❌  无任何 localStorage / fs / db
缓存        ❌  唯一命中是 MCP 的 Cache-Control: no-store
认证/多租户  ❌
重试/退避    ❌  只有 AbortController 超时
速率控制     ❌  百度被限流的原因
幂等/去重    ❌  同样的问题问两次 = 两次全新调用
```

---

## 二、哪些可以直接复用

这一块比想象中乐观 —— **大部分计算逻辑是干净的，因为当初就写成了不依赖框架的纯函数。**

| 模块 | 复用方式 | 理由 |
|---|---|---|
| `lib/html.ts` | ✅ 直接用，建议抽成独立包 | 零依赖自研解析器，`analyze()` 接收 html 字符串而非 URL，**可测性极好** |
| `lib/audit.ts` 的 `analyze()` | ✅ 直接用 | 签名是 `(url, html, httpStatus, elapsedMs)` —— 抓取与计算已分离 |
| `computeGeo()` 六维评分 | ✅ 直接用，但要版本化 | 评分权重会调整，需要给结果打 version |
| `lib/engines.ts` | ✅ 直接用 | 引擎定义已经是数据驱动，加引擎只改这一处 |
| `lib/llms.ts` 的 robots 解析 | ✅ 直接用 | 20 个爬虫策略已覆盖 |
| 中转链接解法 | ✅ 这是**核心资产**，别丢 | 百度 `mu` / 360 `data-mdurl` / 搜狗 `citeLinkClass`，是拿真实返回页逐个试出来的 |
| MCP 的 stdio 通道 + CI 冒烟 | ✅ 直接用 | 已经能保证 MCP 不悄悄失效 |

**`analyze()` 那里要特别说一下。** 它的签名把「取数据」和「算结论」分开了：

```ts
export async function auditUrl(inputUrl: string): Promise<PageAudit>   // 含抓取
export function analyze(url, html, httpStatus, elapsedMs): PageAudit   // 纯计算
```

这是当前代码里最有价值的一个设计决策 —— 它意味着 Evidence 层可以直接插进来：**把 html 连同它的 provenance 一起存下，`analyze()` 就能在任何时候重放出一个完全相同的结论。**

其余模块（`serp.ts` / `visibility.ts`）没做到这一点，它们的抓取和解析是缠在一起的。这是后面要改的。

---

## 三、哪些需要重构

按优先级排，前三个都是**会持续产生成本**的。

### P0 · 九个分散的 fetch 点

```
src/lib/audit.ts:96      src/lib/llms.ts:161, 291, 411
src/lib/serp.ts:56, 239  src/lib/visibility.ts:232, 253, 274
```

每个模块各自写一遍 `AbortController` + `setTimeout` + header。后果是：

- 想加 UA 轮换 → 改 9 处
- 想加退避重试 → 改 9 处
- 想加 per-domain 限速（**解决百度限流的唯一有效手段**）→ 改 9 处
- 想给每个响应留痕做 Evidence → 改 9 处

**这是所有后续改造的前置条件。** Fetcher 抽象不立起来，后面每一步都在重复劳动。

### P0 · 业务逻辑散落在传输层

同一段「引擎分组解析」写了两遍：

```
src/app/api/serp/route.ts:36    ids = group === "cn" ? CN_ENGINES : ...
src/lib/mcp.ts:175              else if (group === "global") ids = GLOBAL_ENGINES;
```

更严重的是 **summary 聚合只存在于 HTTP route 里**（`okEngines` / `averageRank` / `bestRank` / `totalItems`）。MCP 的 `check_serp_ranking` 只返回原始 `results` 数组。

**后果：Agent 通过 MCP 拿到的能力，比人通过网页拿到的少。** 它得自己算平均位次、自己判断几成引擎被挡了 —— 而它算出来的口径还可能跟你网页上的不一致。

这条直接指向你的第五个问题，下面展开。

### P0 · LLM 调用不可复现（AI Observer 的生死线）

三个致命处：

1. **`temperature` 只在一处设了。** `visibility.ts:242` 给 OpenAI 兼容路径设了 `0.2`，但 **Claude 路径（:263）没有设 temperature**，用的是服务端默认（通常 1.0），Gemini 路径同样。这等于：同一个问题，七个模型里有两个在高随机模式下回答 —— **横向对比的根基不成立**。

2. **原始回答丢弃。** `callProvider()` 返回 `string`，HTTP response 本体扔了。于是「模型没提及我」和「我解析错了」无法区分 —— 这是最容易被质疑的地方，也是最难自证清白的地方。

3. **Prompt 无版本。** `PROMPT_TEMPLATE` 一旦修改，历史观测全部失去可比性。

一个宣称「抓不到就说抓不到」的系统，**自己的 AI 观测层却在用不可复现的方式产生结论**。这是必须先补上的。

### P1 · serp.ts 抓取与解析耦合

对比 `audit.ts` 的干净做法，`fetchSerp()` 是「边抓边解」的。要接 Crawler 必须拆成 `抓取 → RawSnapshot → 解析` 两段。

### P1 · check 缺少机器可读的稳定契约

`checks[]` 有 `id`（`"http"` / `"title"` / `"canonical"` …），这点很好，**但 `id` 目前只用于渲染，没有语义层级**。

Auto Fix 需要的是「这条 issue 对应哪一种修复规则」。现在的数据结构不足以自动路由。

---

## 四、哪些需要新增

| 模块 | 依赖 | 说明 |
|---|---|---|
| `lib/fetcher/` | — | 统一抓取层（P0 前置） |
| `lib/evidence/` | fetcher | **观测事实的唯一出口** |
| `lib/observers/search.ts` | fetcher, serp | Search Observer |
| `lib/observers/ai.ts` | fetcher, provider | AI Observer |
| `lib/observers/site.ts` | fetcher, audit | Site Observer |
| `lib/store/` | evidence | 存储接口 + 实现（见第六节） |
| `lib/diagnosis/` | evidence | check id → 可执行修复规则 |
| `packages/cli/` | observers | CI 入口，独立于 Web |

注意 `lib/store/` 排在 `lib/observers/` **之后** —— 不是笔误，见第六节。

---

## 五、哪些设计会阻碍未来的 Agent

这一节是十三个问题里最关键的，因为**错了的架构会随着代码量增长越来越难改**。

### 反模式 1：每次调用是一次「动作」而非一次「观测」

现在 MCP 工具的语义是「做一件事」：查一下、审计一下。返回完就结束了。

Agent 真正需要的语义是「**声明一次观测**」：

```
观测有 id，可被引用
观测有时间戳，可被比较
观测有 provenance，可被质疑
观测幂等：同一目标同一窗口请求两次，第二次返回第一次的结果
```

没有幂等，Agent 在循环里会反复触发真实抓取 —— **然后百度限流就成了它的错**。

### 反模式 2：能力在不同通道上不对等

见第三节 P0。HTTP 有 summary，MCP 没有。**Agent 成了二等公民。**

未来的 CI 会是第三个通道 —— 如果那时再违反一次，三份实现各自漂移，最后没人知道哪个口径是对的。

**修法只有一个：业务逻辑下沉到 service 层，三个通道都只是它的适配器。**

```
        ┌─ HTTP route ─┐
service ─├─ MCP tool   ─┤  三个通道共享同一份实现
        └─ CLI / CI   ─┘
```

### 反模式 3：返回的是数据，不是结论

给 Agent 一个 26 条的原始数组，它得自己判断「这个数据能不能信」。

应该直接给它：

```ts
{
  conclusion: "百度 Top10 中未找到该域名",
  confidence: "high",
  provenance: { fetchedAt, httpStatus, rawRef: "evidence://…" },
  caveat: "其余 2 个引擎被限流，样本不完整"
}
```

`confidence` 和 `caveat` 是 Agent 最需要的两个字段 —— **它们告诉你什么时候不该信这个结论。** 这恰恰是 GEOkit 主张的那条原则在架构层的落实：不仅对人诚实，也要对 Agent 诚实。

### 反模式 4：无身份、无作用域

现在任何人调任何接口都能查任何域名。一旦 CI 在多仓库跑、或者开放多用户，就必须有 scope。

**但现在不要做。** 见第六节关于过早优化的判断。

### 反模式 5：页面组件里藏业务判断

`app/serp/page.tsx:142` 有一句 `averageRank <= 10 ? "good" : "warn"`。这个「10 名算好」的阈值藏在 UI 里。

CI 要判定门禁时，得把同一个数字再抄一遍 —— 然后两处的阈值就会各自漂移。

**阈值属于配置，不属于渲染。**

---

## 六、数据库现在应该怎么引入

**我的判断：现在不要引入数据库。**

这个建议听起来和你的问题相反，理由如下。

### 为什么现在上 DB 是错的

数据库是**查询需求的解**。而现在还没有查询需求 —— 只有一个「查一下，看一眼」的场景。

过早引入会掉进一个具体的坑：**schema 会跟着 UI 长**。今天页面要展示六维评分，于是建一张 `audit_results` 表；明天要有趋势图，再改表加字段。schema 跟着渲染走，很快就会变成一堆 `xxx_result` 表堆积、彼此关系不清。

更隐蔽的成本：一旦有了 DB，就会有人开始写「分析功能」。**而在一个连 Observations 都还没定义清楚的系统上做分析，做出来的东西大概率没人用。**

### 正确的顺序

```
① 定义 Evidence 类型契约        ← 现在就做
② 定义 Store 接口（不实现）      ← 现在就做
③ 用 JSONL / 内存实现这个接口    ← 现在就做，成本几乎为零
④ 让它跑一段时间，积累真实读写场景 ← 1~2 周
⑤ 再根据真实的查询模式选型        ← 那时答案会自己出现
```

**接口先行，实现后置。** 第 ②③ 步今天就能完成，而且是后面所有工作的地基 —— 因为它们把「什么才是一次观测」这个问题逼着你先回答清楚。

### Store 接口的形状

```ts
interface EvidenceStore {
  append(e: RawEvidence): Promise<EvidenceId>;
  get(id: EvidenceId): Promise<RawEvidence | null>;
  query(q: EvidenceQuery): Promise<RawEvidence[]>;
  latest(target: string, kind: EvidenceKind): Promise<RawEvidence | null>;
}
```

四个方法就够起步了。注意 `append` 是**只追加**的 —— 观测系统不该有 update，历史事实不可变。

### 到时候选什么

我的建议是按 trigger 走，而不是按规模：

| 触发条件 | 选型 | 理由 |
|---|---|---|
| 只要能查历史 | **SQLite + Drizzle** | 零运维、单文件、`better-sqlite3` 同步 API 非常适合 CLI。**默认值，大概率停在这就够** |
| 需要多机 / 并发写 | Postgres | 换 Drizzle dialect，业务代码不动 |
| 需要时序聚合与降采样 | TimescaleDB / ClickHouse | 排名趋势是典型时序场景 |

**不要一开始上 Postgres。** 它的运维成本会让本地开发和 CI 都变复杂，而在单用户场景下给不了任何 SQLite 之外的东西。Drizzle 的价值正在于让这个迁移变成改一行配置。

一句话：**先把 Store 接口定死，数据库只是它的一个可替换实现。**

---

## 七、Crawler 应该怎么接

### 定位

**Crawler 不只是抓取器，它是 Evidence 的生产者。**

这是最容易做错的地方。如果把 Crawler 理解成「封装了重试的 fetch」，那就浪费了它最大的价值 —— 每次抓取都应该留下一份不可变的原始素材，让后续所有结论都能被回溯和复核。

### 分层

```
Fetcher（单次请求）
  ├─ 超时 / 重试 / 指数退避 + jitter
  ├─ UA 轮换
  ├─ 响应体 hash：是不是 304 / 是不是软 404 / 是不是验证码页
  └─ 输出 RawSnapshot（永远保留）

RateLimiter（per-domain token bucket）
  ├─ 每个域独立配额 —— 百度的额度不能给 example.com 用
  └─ 命中限流 → 返回 BLOCKED + retryAfter，**不算失败**

Crawler（页面集合）
  ├─ robots.txt 遵从
  ├─ sitemap 发现
  ├─ 并发控制 + 深度限制
  └─ 增量抓取：ETag / Last-Modified
```

### 替换现有 9 个 fetch 的顺序

```
① 立 Fetcher，先只替换 llms.ts（最简单的三处）
② 验证行为一致后，替换 audit.ts / serp.ts
③ visibility.ts 单独处理 —— 它走 Provider 抽象，不走 Fetcher（见第十节）
```

### 关于「不做分布式」

**我的主张：Phase 2 之前不要做分布式 Crawler。**

单进程 + SQLite 可以轻松覆盖到十万级 URL / 天。分布式带来的复杂度（任务队列、去重、故障恢复、一致性）在这个阶段换不来任何收益 —— 而且它是最容易让一个项目陷进去的坑。

真到需要时，`Fetcher` 这个接口本身就是天然的扩展点。

---

## 八、Evidence 层应该放在哪里

**放在横跨采集层之上、Observer 层之下的位置，作为一等公民 —— 不是某个模块的子目录。**

```
┌──────────────────────────────────────────┐
│  UI / MCP / CLI&CI                        │   消费方
├──────────────────────────────────────────┤
│  Observers  search / ai / site            │   编排：定时、对比、告警
├──────────────────────────────────────────┤
│  ★ Evidence Layer ★                       │   唯一真相出口
│    RawEvidence + Observation + provenance │
├──────────────────────────────────────────┤
│  Fetcher / Crawler / Provider             │   采集：只取原始素材
└──────────────────────────────────────────┘
```

### 为什么必须是水平切面而不是纵向 modules

如果 Evidence 挂在 Observer 下面，就会出现：Search Observer 有自己的存档格式，AI Observer 有自己的，两边对「一次观测」的定义不一样 —— **于是永远无法把「排名掉了」和「AI 不再引用我」这两件事放在同一条时间轴上对齐**。而这恰恰是 GEO 最有价值的洞察：**搜索表现和 AI 引用表现之间的相关性。**

### 两类数据，不要混

```ts
// ① RawEvidence —— 原始素材，不可变，永不删除
interface RawEvidence {
  id: string;
  kind: "serp_html" | "page_html" | "robots_txt" | "llms_txt" | "llm_response";
  target: string;          // URL 或查询标识
  fetchedAt: string;
  httpStatus: number | null;
  headersHash: string;     // 用于检测软变更
  bodyHash: string;
  blobRef: string;         // 大体积内容落盘，这里只存引用
  cost?: { tokens?: number; ms: number };
}

// ② Observation —— 派生的、带结论的、可重算的
interface Observation {
  id: string;
  kind: "rank" | "geo_score" | "ai_mention" | "robots_policy";
  target: string;
  observedAt: string;
  value: unknown;                 // rank=3 / score=75 / mentioned=true
  evidenceIds: string[];          // ← 关键：每条结论都要能指回素材
  analyzerVersion: string;        // ← 评分算法换代后可区分
  confidence: "high" | "medium" | "low" | "unavailable";
  caveat?: string;                // ← 样本不完整时必须说明
}
```

**`RawEvidence` 永不删，`Observation` 可以重算。** 这就是为什么把它们分开 —— 评分算法改进后，你重放 RawEvidence 就能得到新口径的历史，而不是永远带着旧版本的误差。

### 一条硬规矩

**Observers 不许直接调用 Fetcher，必须经过 Evidence 层。**

这条规矩保证了系统里的每一个结论都能回答「你怎么知道的」。它是整个架构可信度的来源 —— 也是这个项目对外主张的那条原则，在代码里的最终落点。

---

## 九、MCP 应该怎么演进

### 从「做一件事」到「声明一次观测」

现在：`check_serp_ranking(keyword)` → 返回一堆数据，结束。

演进：

```
阶段一 · 契约对齐
   工具输出补齐 confidence / provenance / caveat
   summary 聚合下沉到 service，MCP 与 HTTP 平等
   → 让 Agent 知道什么时候不该信这个结论

阶段二 · 观测语义
   observe_rank(keyword, domain) → { observationId, value, evidenceRef }
   get_observation(id)           → 拿历史某次观测
   diff_observations(a, b)       → 两次对比
   → 工具开始有「记忆」

阶段三 · 任务化
   watch_start(target, schedule) → 建立持续观测
   watch_list() / watch_stop()
   → Agent 能安排周期性工作，而不是每次被动提问
```

### 新增工具清单

| 方向 | 工具 |
|---|---|
| 历史 | `list_observations` / `get_observation` / `diff_observations` |
| 任务 | `watch_start` / `watch_list` / `watch_stop` |
| 诊断 | `diagnose_site` → 结构化 issue 列表（带 `fixId`） |
| 修复 | `suggest_fix(fixId)` / `apply_fix(fixId, dryRun)` |
| 门禁 | `check_gate(configPath)` → pass/fail + 明细 |

`apply_fix` 的 `dryRun` 参数我建议**默认为 true** —— Agent 调用时也该先看 diff 再决定落地。

### 保留

stdio 通道 + CI 里的真实握手冒烟。**这条已经避免了「MCP 悄悄失效而无人察觉」，别动它。**

---

## 十、Search Observer 怎么演进

### 三步走

```
采样 → 定时对关键词×引擎组合抓取，强制落到 Evidence
        同一组合在同一时间窗内幂等（防 Agent 刷爆配额）
        ↓
差分 → 位次 delta：absolute / previous / smoothed
        异常标注：新进榜 / 掉出榜 / 大幅波动 / 引擎失联
        ↓
视图 → 多引擎加权：百度权重应显著高于 Bing（中文市场现实）
        输出单一可解释指标，而不是七个孤立数字
```

### 两个容易被忽略的点

**① 把「未能观测」和「观测到没有」分开。**

这两件事在现在的代码里都归到不成功，但它们含义完全不同：

```
BLOCKED   → 被限流了，不知道排名         ≠ 排名差
NO_RANK   → 成功抓取，Top10 里确实没有   = 明确的坏消息
```

混为一谈会导致趋势图上出现假的「暴跌」。这延续的是项目一开始定的那条原则，但在时间序列语境下它更重要 —— 因为它污染的是**判断**而不是单次结果。

**② 采样频率要克制。**

中文搜索引擎的反爬阈值不高。建议：核心词每日一次，长尾词每周一次。
**稳定低采样 > 激进高采样后被封。** 这条优先级高于数据新鲜度。

---

## 十一、AI Observer 怎么演进

这是当前**问题最多、也最有机会**的一块。

### 先修补三个致命缺陷

见第三节 P0。重述一遍因为它们必须先做：

```
① temperature 必须全局统一为 0
   现在只有 OpenAI 兼容路径设了 0.2，Claude 路径完全没设。
   在高随机模式下做横向对比，对比结果没有意义。

② 完整留存 provider 原始响应
   「模型没提及」必须能和「我没解析出来」区分开。
   这是整个 AI Observer 能否被信任的前提。

③ Prompt 版本化
   promptVersion 字段进 Observation，否则改一次 prompt
   历史数据全部作废。
```

### 然后做方法论升级

**单次问询是不可靠的证据。**

一个模型今天提及你、明天没提及，可能只是采样噪声。要变成可观测指标，必须：

```
多轮采样   同一问题 N 次（N≥3），统计提及率而非单次布尔值
           temperature=0 时同一输入应稳定输出，不稳定本身就是信号

多视角提问 同一个意图用多种问法：
           「XX 推荐」「最好的 XX 有哪些」「XX 怎么选」
           → 单模型的覆盖度分布

引用溯源   AI 回答里提到了哪些域名 —— 这是最强的 GEO 信号
           比「有没有提及我」更 actionable

成本记账   每次观测的 token 消耗必须记录
           否则 AI Observer 会悄悄变成一个很贵的玩具
```

### 一个产品层面的判断

**「提及率」比「是否提及」重要得多，横向对比要谨慎。**

九个模型的训练语料、检索机制、时效性差异巨大。直接横向排名九个模型的分数，容易得出「百度文心对我最友好」这种其实是采样噪声的结论。

更有价值的对比是**同一模型的时间序列**——它回答的是「我做的优化有没有效」，而不是「哪个模型更喜欢我」。

---

## 十二、Auto Fix 怎么接 Git

### 链路

```
Evidence → Diagnosis → Fix Rule → Patch → 验证 → PR
```

### 四个关键设计

**① Diagnosis 必须产出稳定 machine-readable id**

现在的 `checks[].id`（`"missing-canonical"` 之类）已经是好的起点，但需要补上语义层级，让修复规则可以挂靠：

```ts
interface Diagnosis {
  issueId: string;        // "canonical/missing"
  targetUrl: string;
  severity: "blocker" | "major" | "minor";
  evidenceId: string;     // 指回 Evidence
  suggestedFix?: string;  // fixId，可自动执行才有
}
```

**只有 `suggestedFix` 存在的 issue 才允许进 Auto Fix。** 不能自动修的，就老实出诊断报告让人处理 —— 强行自动化拦不住的问题只会产生噪音 PR。

**② 每个 fix 必须可回退**

修改必须是**幂等的、幂次的、最小 diff** 的。典型例子：

```
✅ 注入缺失的 canonical <link>       scope 明确，可回退
❌ 「优化 title 让它更有吸引力」      LLM 自由发挥，diff 不可控
```

**判定标准很朴素：如果这个 patch 的 diff 我不能提前预测，它就不该自动提交。**

**③ Git 交互走标准流程，不碰主分支**

```
创建分支  geokit/fix/<issueId>-<shortHash>
提交      Conventional Commits + Evidence id 写进 body
推送      SSH Deploy Key 或 GitHub App，**不要用 PAT**
开 PR     正文自动生成：问题 / 证据链接 / 修复内容 / 复验结果
```

GitHub App 优于个人 PAT：权限更窄、可吊销、不关联个人身份。

**④ 复验闭环**

PR 描述里必须包含：**修复前 vs 修复后** 的对比 Evidence。

```
修复前  GEO 62  (evidence://a1b2)
修复后  GEO 74  (evidence://c3d4)   ← 新一次观测，不是预测值
```

这步不能省。它把 Auto Fix 从「我觉得这样更好」变成「**有证据证明它更好**」。

### 一条边界

**Auto Fix 默认 dry-run。** 即使在 CI 里跑，也先产出 patch 供 review。全自动合并只应对 `# files: 1 && lines: <10 && 有 Evidence 证明有效` 这类极其受限的情况开放，并且要显式开启。

---

## 十三、最终 SEO CI 怎么接

### 形态：独立 CLI 包

**CI 不能依赖跑着的 Web 服务。** 它需要冷启动、确定性退出码、可在任意 runner 执行。

```
packages/cli/
  geokit check <url>            # 单页检查
  geokit check --sitemap=…      # 全站（带并发与节流）
  geokit gate                   # 门禁判定
  geokit diff --base=<ref>      # 与基线对比
```

### 判定逻辑：基线对比优于绝对阈值

这是个容易被做错的点。

```
❌ GEO < 70 → fail
   含义不清：一个 62 分的老页面和一个从 75 掉到 62 的页面，
   严重性完全不同，但绝对阈值给它们同样的判定。

✅ GEO 相对基线下降 > 5 分 → fail
   + 新增 blocker 级 issue → fail
   + 绝对下限兜底（如 GEO < 40 无条件 fail）
```

**「变差了」比「不够好」更值得拦。** 前者是退化，后者可能只是一个还没优化的老页面。

### 配置文件

```yaml
# .geokit.yml
baseline: origin/main

gates:
  geo_score:
    min: 40
    max_drop: 5
  issues:
    blocker: 0
    major: { max_new: 2 }
  ai_crawlers:
    # 自家站的红线：AI 抓取被封 = 内容进不了 AI 答案
    must_allow: [GPTBot, ClaudeBot, PerplexityBot]

observers:
  search: { enabled: false }   # CI 默认关，避免触发搜索风控
  ai:     { enabled: false }   # 默认关，成本与随机性都不适合 CI

output:
  formats: [sarif, markdown]
```

**注意 `search` 和 `ai` 默认关闭。** 把付费、随机、易触发风控的操作放进每次 PR 都跑的 CI，是给自己找麻烦 —— 而且会让开发者很快学会跳过这个检查。

### 输出

| 格式 | 用途 |
|---|---|
| SARIF | GitHub Code Scanning 原生集成，问题直接标在 PR diff 上 |
| JUnit | CI 面板的测试用例视图 |
| Markdown | PR 评论 |

**SARIF 优先级最高** —— 它让问题出现在开发者正在看的地方（diff 行内），而不是让他去点开另一个链接。

### 一个现实提醒

CI 里做 SERP 采集一定会遇到搜索引擎风控（CI IP 是固定的、高频的）。
**我建议 CI 只跑「不需要外部搜索」的检查**：页面审计、robots 策略、llms.txt、GEO 评分。搜索相关的观测放定时任务里跑，不要放 PR 门禁。

这条取舍的依据前面已经说过一次：**稳定低采样 > 激进高采样**。CI 环境恰恰是最激进的采样场景。

---

## 十四、建议的落地顺序

原则：**每一步都要能独立交付价值，且不为下一步制造返工。**

```
Phase 0 · 地基（约 1 周）  ← 建议就从这里开始
  ├─ Fetcher 抽象：替换 9 个分散 fetch，加重试/退避/限速
  ├─ Evidence 类型契约定死（RawEvidence / Observation）
  ├─ Store 接口 + JSONL 实现（不为引入 DB）
  └─ 修 visibility 的 temperature / 原始响应留存

  ── 产出：同样的功能，但每次调用开始留痕

Phase 1 · Observer 化（约 2 周）
  ├─ service 层抽出，HTTP / MCP 双通道对齐
  ├─ 三个 Observer 成型（search / ai / site）
  ├─ 定时采样 + 差分 + Baseline 概念
  └─ SQLite + Drizzle（到这一步查询需求才真实存在）

  ── 产出：能回答「涨了还是跌了」

Phase 2 · 自动化（约 2 周）
  ├─ Diagnosis 层 + fix 规则库（只做可预测的补丁）
  ├─ packages/cli 独立包
  ├─ SARIF 输出 + GitHub Actions 官方 action
  └─ Auto Fix → PR（默认 dry-run）

  ── 产出：能回答「能不能自动修好」

Phase 3 · 规模化（按需）
  └─ 多租户 / Postgres / 分布式 Crawler
     ← 到了真有付费用户时再动
```

### 三条不要做的事

```
❌ 不要在 Phase 0 就上 Postgres
   没有查询需求时引入 DB，schema 会跟着 UI 长歪

❌ 不要在 Phase 1 之前做多租户
   单用户场景下的所有权限设计都是猜的，猜的基本都要返工

❌ 不要把 AI Observer 放进 CI 门禁
   随机性 + 成本 + 延迟，三项都不适合门禁场景
```

---

## 结语

GEOkit 现在的代码有两个东西特别值钱，演进时无论如何要保住：

**一是那些用真实返回页试出来的脏知识。** 百度 `mu`、360 `data-mdurl`、搜狗 `citeLinkClass` —— 这些不在任何文档里，是拿请求次数换来的。任何重构都不该把它们丢失在抽象的缝隙里。

**二是「抓不到就说抓不到」这条原则。** 它在架构层的对应物很清晰：`confidence` 字段、`caveat` 字段、`BLOCKED` 与 `NO_RANK` 的区分、以及 dry-run 默认开关。

**这两个加起来，才是别人抄不走的东西。**

而从「分析器」走到「观测系统」，本质只是一次维度增加 —— 但这一步会让上面所有的东西都活起来：

```
Evidece 层落地 → 结论可回溯
Store 落地     → 时间维度成立
Observer 落地  → 趋势可判定
CI 落地        → 退化被拦截
Auto Fix 落地  → 闭环合拢
```

五步之间没有绕路，每一步都是下一步的必要前提。这也是我建议**从 Fetcher 和 Evidence 契约开始，而不是从数据库开始**的原因 —— 顺序错了，后面每一步都要回头补地基。
