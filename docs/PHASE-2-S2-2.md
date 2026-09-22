# Phase 2 · S2-2 —— CLI

对应 `docs/ARCHITECTURE-ROADMAP.md` §十三（最终 SEO CI 怎么接）。

```text
S2-1 Diagnosis 层 → S2-2 packages/cli（本步） → S2-3 SARIF + CI → S2-4 Auto Fix（dry-run）
```

| | |
|---|---|
| **做什么** | 独立于 Web 的命令行入口：`check` / `gate` / `diff` |
| **不做什么** | 不做 SARIF、不做 GitHub Action、不做 Auto Fix、不改 MCP、不联网升级 analyzer |

## 1. 形态

```text
packages/cli/
├── package.json   独立包（不是 npm workspace，不动 Next 构建链）
└── src/
    ├── bin.ts     参数解析 + 分发 + 退出码
    ├── check.ts   URL → audit + robots + llms.txt → Diagnosis
    ├── gate.ts    门禁判定（基线优先）
    ├── diff.ts    观测差异（文件模式 / Store 模式）
    └── output.ts  json / markdown 渲染
```

```bash
geokit check <url> [--html-file=<path>] [--format=json|markdown] [--skip-protocol]
geokit gate --base=<baseline.json> (--report=<check.json> | --url=<url>)
geokit diff --subject=<s> --type=<t> [--dir=]
geokit diff --prev=<a.json> --curr=<b.json>
```

根仓库加了 `"cli": "tsx packages/cli/src/bin.ts"`。

**三条铁律：**

1. **CI 不能依赖跑着的 Web 服务** —— CLI 不 import 任何 Next 模块，冷启动、确定性退出码。
2. **不重复实现判定** —— audit 在 `lib/audit.ts`，diff 在 `lib/diff.ts`，
   CLI 只做取数与渲染。否则「CLI 说退化、API 说不变」，两条真相等于没有真相。
3. **CI 里不跑 Search / AI Observer** —— 付费、随机、易触发风控。
   只跑不需要外部搜索的检查：页面审计、robots、llms.txt、GEO 评分。

## 2. check

```text
URL → auditUrl（复用 Fetcher + analyze）→ robots → llms.txt → Diagnosis → 输出 → 退出码
```

- 复用 `auditUrl`（Phase 0 的 Fetcher，带重试退避限速）、`analyzeRobots`、`analyzeLlmsTxt`、
  `diagnoseAudit`。**一行判断逻辑都没有重写。**
- 抓取失败不抛异常：走 `emptyAudit` ⇒ 产出 `fetch/unreachable`（blocker），
  由退出码表达。**抓不到就是抓不到，不编造一个「还行」的分数。**
- 退出码：有 blocker / major ⇒ 1，否则 0。
- `--html-file` 是离线模式，不联网 —— fixture 复现与测试专用。

### 协议层诊断

robots / llms.txt 的问题在 CLI 层落成 Diagnosis，但**不进 S2-1 的 fix 规则库**：

| issueId | 触发 | severity | 自动修 |
|---|---|---|---|
| `robots/ai-blocked` | GPTBot / ClaudeBot / PerplexityBot 任一个被封 | major | — |
| `robots/missing` | 无 robots.txt | minor | — |
| `llms/missing` | 无 llms.txt | minor | — |
| `llms/invalid` | 有但存在 fail 级校验项 | minor | — |

不给自动修的理由很直接：改 robots.txt 与 llms.txt 是**站级决策**，
不是往页面里插一个标签那么可逆。规则库只收「diff 可预测」的那五条。

## 3. gate —— 「变差了」比「不够好」更值得拦

```text
❌ GEO < 70 → fail
   一个 62 分的老页面和一个从 75 掉到 62 的页面，严重性完全不同，
   绝对阈值却给它们同样的判定 —— 结果是把「还没优化」当成「退化」。

✅ 相对基线下降 > 5 → fail
   + 新增 blocker > 0          → fail
   + 新增 major > 2            → fail
   + GEO < 40（绝对下限兜底）  → fail
```

默认阈值：`maxDrop=5 / geoMin=40 / maxNewBlocker=0 / maxNewMajor=2`（`DEFAULT_GATE`）。

### 基线从哪来 —— 这是本步最重要的决定

**CI 的 runner 每次都是全新的，Store 目录一定是空的。**
所以 `--base=<baseline.json>` 是 CI 的默认方案：
上一次 `geokit check --format=json` 的产物直接当基线，用 artifact 传下去。

本地有 Store 历史时可用 `--subject/--type` 走 S6 的 `diffLatest`，
但**绝不依赖它**：

| 情形 | 行为 |
|---|---|
| 有基线文件 | 按上面的规则判定 |
| 无基线、Store 有历史 | 用 diff 的 degraded 计数判定；不可比则只说明、不判方向 |
| 两者都没有 | 明确写「未做退化判定，不静默放行」，退出码 0 |

「无基线」不是「通过」—— 这两个必须在报告里分开写，否则等于给自己开了后门。

分数缺失时（如抓取失败）返回 `null` delta，**不判定也不兜底**。

## 4. diff

判定全部由 S6 `diff.ts` 承担，CLI 两种取数方式：

| 模式 | 用途 | 参数 |
|---|---|---|
| 文件 | CI runner 上没有 Store | `--prev` + `--curr` 两份 Observation JSON |
| Store | 本地有观测历史 | `--subject` + `--type`（`--source`/`--to`/`--dir` 可选） |

★ `UNOBSERVABLE → NOT_MENTIONED` 仍判 **unknown 而不是下降** —— CLI 不打折，
这条是 S6 的核心验收，任何一条通道都不许绕过。

一条观测都没有时输出「没有可取到的观测，不是『没有变化』」并退出 1 —— 这两者在 CI 里含义天差地别。

## 5. 输出

| 格式 | 状态 |
|---|---|
| `json` | ✅ 机器读，直接当 gate 基线 |
| `markdown` | ✅ 默认，PR 评论与终端 |
| `sarif` | ⏳ S2-3。**现在传 `--format=sarif` 会明确报错**，不静默退化成别的格式 |

静默退化是最坏的错：调用方以为拿到 SARIF，实际拿到 Markdown，
然后在 Code Scanning 里看到一片空白还查不出为什么。

## 6. 留给 S2-3 / S2-4 的接口

```text
S2-3  output.ts 增加 format="sarif" → 渲染 CheckReport.diagnoses
S2-4  applyFixes(html, autoFixable(report.diagnoses), buildFixContext(audit)) → patch
```

两条都不需要再碰 `checks[]` 的中文文案。

## 7. 产出

```text
NEW  packages/cli/package.json          独立包入口
NEW  packages/cli/src/{bin,check,gate,diff,output}.ts
NEW  scripts/test-cli.ts                68 项（离线，禁网）
MOD  package.json                       test:cli / cli
```
