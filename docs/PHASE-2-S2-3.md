# Phase 2 · S2-3 —— SARIF 2.1.0 + CI 门禁

> 前置：S2-1（Diagnosis）、S2-2（CLI）。
> 本步只做三件事：**SARIF 输出、CI 跑起来、SARIF 进 Code Scanning**。
> 不包含 Auto Fix（S2-4）。

## 1. 这一步做了什么

```text
geokit check --format=json --out=report.json    页面只抓一次
      ↓
geokit sarif --report=report.json               离线转换（不重复抓取）
      ↓
geokit gate --base=<上次产物> --report=<本次>     S2-2 判定，语义一行没动
      ↓
github/codeql-action/upload-sarif                PR 上出现 Code Scanning 结果
```

`check` 与 `sarif` 分成两步，是因为 CI 里 **同一个目标不应该抓两次**。
SARIF 转换是纯离线（读 json → 写 SARIF），不影响任何判定。

## 2. SARIF 的定位规则（这条最重要）

GitHub Code Scanning 是为「静态扫描源码」设计的：`physicalLocation.region`
期望行号列号，GitHub 用它把结果标在 diff 的某一行上。

但 **GEOkit 检查的是运行中的远程页面，不是仓库里的文件**。于是：

```jsonc
"locations": [{
  "physicalLocation": {
    "artifactLocation": { "uri": "https://whivi.com/guide" }   // 真实审计对象
    // ← 没有 region
  }
}]
```

三条硬规矩：

1. **`artifactLocation.uri = targetUrl`**，不改写成本地路径、不加前缀、不伪造文件。
2. **没有行号就省略 `region`**。SARIF 规范允许 result 不带 region、也允许不带
   location，所以「省略」是合法表达，不是降级。
3. **不为让 GitHub 界面像「代码扫描」去改 HTML parser 追行号。**
   那会把一个「只读符合法 SARIF」的问题，变成改动 parser 语义的大工程，
   换来的是把结果标在一个根本不在仓库里的文件上 —— 收益为零，风险不小。

> `Diagnosis.targetUrl` 来自 `audit.finalUrl ?? audit.url`（S2-1 定下的），
> 所以重定向后的页面，SARIF 定位自动落在**最终地址**上。

### 没有 URL 时怎么办

gate 比对的是两份快照，未必知道 URL。此时 **result 不带 `locations`**，
而不是塞一个 `unknown` 或占位地址进去。

## 3. 严重度 → SARIF level

| GEOkit | SARIF level | 为什么 |
|---|---|---|
| blocker | `error` | 都要拦，GitHub 只认 error/warning 两档 |
| major   | `error` | 同上 |
| minor   | `warning` | 提示 |

三档压成两档是**必要的信息损失**（换来 PR 上一眼能看出「该拦」），
所以原始严重度保留在 `result.properties.severity` 里，不丢事实。

规则去重：同一 `issueId` 只产一条 rule，多条 result 用 `ruleIndex` 指回它。
顺序按首次出现顺序，保证 CI 反复触发产出的字节一致。

## 4. gate → SARIF

判定逻辑**一行都没重写**，只把 S2-2 已经算出的 `reasons` 转成 result：

| S2-2 的判定 | SARIF |
|---|---|
| `fail` | 每条依据一条 result，`level: error` |
| `pass` 但没基线 | 一条 `note` —— 明说「未做退化判定」，**不是通过** |
| 真 `pass` | 零 result（没有问题就不该出现在扫描结果里） |

★ 特别注意：**「无 baseline ≠ PASS」这条语义在这里必须保住。**
如果无基线时直接产出空 SARIF，CI 上就会显示「全绿」，
而实际上它根本没做任何判定 —— 这正是本项目最反对的静默放行。

## 5. CI

新加一个与 `verify` 并列的 `geokit` job，**没有改动现有 verify 的任何步骤**。

### 目标 URL 从哪来

```yaml
GEOKIT_TARGET_URL: ${{ vars.GEOKIT_TARGET_URL }}
```

- 来自 **repository / environment variable**，不硬编码生产地址；
- 缺失 ⇒ `::notice` 说明后**跳过整个 job**，不猜测、不伪造 URL；
- 在 GitHub 仓库 Settings → Secrets and variables → Actions → Variables 里配置。

### 基线怎么跨 run 传

CI runner 每次全新，Store 必空 —— 所以基线只能靠 artifact：

```yaml
- uses: actions/download-artifact@v4    # 拉取上次 geokit-baseline
  continue-on-error: true               # 首次运行没有 ⇒ 继续，由 gate 明说「未判定」
- run: npm run cli -- check ... --out=geokit-ci/report.json
  continue-on-error: true               # check 退出码 1 ≠ 流程失败，判定交给 gate
- run: npm run cli -- gate --base=geokit-baseline/report.json --report=geokit-ci/report.json
- uses: actions/upload-artifact@v4      # 本次报告 → 下次基线
```

⚠️ download 目录不能与本次输出目录相同，否则Baseline 会被本次产物覆盖。

### 权限

```yaml
permissions:
  contents: read
  security-events: write     # upload-sarif 必需
```

### 明确不做

- **不跑 Search / AI Observer** —— 付费、随机、易触发风控。
  放进每次 PR 的 CI，结果一定是开发者学会跳过这个检查（roadmap §十三）。
- 不跑 Web 服务、不需要 Postgres / SQLite 迁移（CLI 默认 jsonl）。

## 6. CLI 增量

| 变更 | 说明 |
|---|---|
| `--format=sarif` | `check` / `gate` 正式支持；S2-2 的「延迟报错」已移除 |
| `--out=<path>` | 所有命令通用：写文件而非 stdout（SARIF 必须是独立文件） |
| `geokit sarif --report=<json>` | 离线转换，避免 CI 重复抓取 |

故意不做的：`json` / `markdown` 输出一个字节都没改；
每个 render 函数对自己支持的格式**穷尽处理** —— 漏一个分支就会静默退化成
markdown，调用方以为拿到 SARIF，Code Scanning 里一片空白还查不出原因。

## 7. 测试

`npm run test:sarif` —— 52 项，全程离线禁网：

```text
1 SARIF 骨架        version / $schema / runs / tool.driver / rules / results / 空输入
2 映射              rules 去重 + ruleIndex 指回、result 数、严重度→level、properties 保留细档
3 定位              ★ uri = targetUrl、★ 全文档无 region / contextRegion / startLine
                   重定向落到最终地址、无 uri ⇒ 不带 locations
4 gate              fail→error / 真 PASS→零 result / ★ 无基线→note 且明说「未做退化判定」
5 CLI 集成          --format=sarif 不再报错、json 仍是原始报告、markdown 仍是摘要
```

`region` 的验证是**深搜整个 SARIF 文档**（`hasKeyDeep`）逐个 key 找，
而不是只看 result[0] —— 任何一处漏出 region 都会被抓住。

CLI 既有测试保持通过（68 → 69 项，唯一改动是「sarif 明确报错」
改成「sarif 已是正式格式」—— 这正是 S2-3 要做的事）。

## 8. 未做的事（留给 S2-4）

- Auto Fix / patch 生成 / PR 正文
- SARIF 的 `fixes` 字段（那是修复提案，属于 Auto Fix 语义，本步不碰）
- HTML parser 行号追踪（明确不做，见 §2）
