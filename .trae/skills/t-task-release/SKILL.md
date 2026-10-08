---
name: t-task-release
description: Ship a finished geokit Tn task - run four gates, check changelog, stage explicit files, conventional commit, push, verify. Use on 提交并推送 / 发布 Tn / commit-and-push. Do not use for writing or fixing code.
---

# Tn 任务发布流程（geokit）

把一个**已实现完成**的 Phase 2 Tn 任务安全地提交并推送到 `origin/main`。
触发前提：用户明确说「提交并推送 / 发布 Tn / commit and push」。实现任务本身不属于本技能。

环境是 **Windows PowerShell**，仓库约定见 docs/协作协议.md 与 docs/CHANGELOG.md。

## 0. 硬纪律

- 四门禁未全绿，绝不提交。
- 没有用户明确的提交指令，绝不自动 commit（实现完成后只汇报，等指令）。
- 只提交本次任务范围内的文件，不顺手修无关代码。
- 不 amend、不 force push、不 `git add -A`/`git add .`。
- 不创建未经要求的文档；README/CHANGELOG 更新属于本仓库既定流程，不算多余文档。

## 1. 识别变更边界

依次执行并阅读完整输出：

- `git status`（分支、modified、untracked）
- `git rev-parse --abbrev-ref HEAD`（必须是 main，除非用户另有说明）
- `git diff --stat`

判断：

- 所有 modified 文件是否都属于本次 Tn？若混入其他主题，**先询问用户**（只提交本任务 / 全部一起 / 拆多个 commit），不要自行决定。
- untracked 的 `.trae/`、`*.db`、临时 patch*.js/fix.js 等一律排除；发现临时脚本应提示用户删除，而不是提交。
- 核对文件数与 CHANGELOG「核心变更」清单一致。

## 2. 文档纪律

提交前确认（缺了就先补上，再请用户确认）：

- `docs/CHANGELOG.md` 顶部有 `## [Phase 2 Tn] — 日期 · 标题` 条目，包含：
  核心变更（新增/修改文件）、设计原则（如适用）、验证（四门禁结果与测试数）、
  已知限制/待办（建议）。
- 用户可感知行为变化时 README.md 已同步（badge、工具数、能力描述）。

## 3. 四门禁（顺序执行，全部通过）

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

判定标准：

- **typecheck**：`tsc --noEmit` 零输出零错误。
- **lint**：0 errors。历史遗留 warning 可接受，在汇报中注明 warning 数量。
- **test**：`pass N / fail 0`，记录 pass 总数与新增数。
- **build**：出现 `✓ Compiled successfully`、静态页生成完成、路由表正常输出。
  注意 PowerShell 可能吞掉退出码，以输出内容为准。

任一门禁失败：**立即停止**，把关键失败输出报给用户；只在用户要求修复后才改代码，修复后四门禁重跑（不能只跑挂的那一项就提交）。

## 4. 显式暂存

只暂存任务文件，逐个列出：

```powershell
git add src/lib/xxx.ts tests/unit/xxx.test.ts README.md docs/CHANGELOG.md
git status --short
```

暂存后二次确认：左侧 `M ` 列表 == 任务文件清单；`.trae/` 等保持 `??` 不被纳入。

## 5. 提交（PowerShell 安全写法）

- **禁止** heredoc（`<<EOF`）、`$(cat file)`、裸换行 —— PowerShell 不兼容。
- 用多个 `-m`：第一个是 subject，其余各成一段 body。

提交信息格式（subject 用英文，与 T6–T9 历史一致）：

```
feat(<scope>): T<n> <简短英文摘要>
```

示例：

```powershell
git commit -m "feat(geo): T9 content quality signals - 5 new signals integrated into six dimensions" -m "body：核心改动一（可选，简述要点）" -m "Tests: 366/366 pass (+14). typecheck/lint/build green. No new dependencies."
```

scope 按模块取（geo / competitor / query / opportunity / gsc / visibility / mcp 等）。

## 6. 推送

```powershell
git push origin main
```

github.com 的 SOCKS5 代理已在 git config 按域名限定，不要改代理配置。
push 失败时保留现场、报告错误原文，不要重试 `--force`。

## 7. 推送后核验并汇报

```powershell
git log --oneline -3
git status -sb
```

汇报必须包含：

- commit 短 hash 与完整 subject
- push 区间（如 `e4b9164..54890ae main -> main`）
- 文件数与 +/- 行数
- 剩余 untracked 项（确认是有意排除的）
- 四门禁结论与测试数

## 反模式

- 门禁没跑完或挂了照样 commit。
- `git add -A` 把 `.trae/`、`geokit.db`、临时脚本扫进来。
- PowerShell 里用 heredoc 拼 commit message 导致语法错误。
- 提交时夹带「顺手修」的无关改动。
- 上一个 commit 有错就 amend/force push —— 正确做法是新 commit。
- push 失败后盲目反复重试而不看原因。
