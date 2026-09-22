# Phase 1 / S8 —— 存储选型落地（SQLite）

```text
commit:    feat: implement phase 1 S8
父提交:    412a8dd（S7）
状态:      COMPLETE —— Phase 1 收官
契约:      S1/S2 未改 · replaces 未改 · analyze() 未改 · 上层零改动
```

---

## 1. Scope

| 项 | 内容 |
|---|---|
| **做什么** | 用 SQLite 实现**同一套 `Store` 接口**，默认仍是 JSONL，可显式切换 |
| **不做什么** | Phase 2 · 多租户 · Postgres · 删掉 JSONL · 改上层任何一行 |

设计依据：`docs/PHASE-1-DATA-ARCHITECTURE.md` §9（存储方案比较）、§15（S8 验收标准）。

验收标准：**接口不变 + 可逆转 + 上层零改动 + 查询性能提升**。

---

## 2. 选型：走 `node:sqlite`，不引第三方依赖

设计稿 §9.2 列了三条路径。本机实测（Node 22.22.2）：

| 路径 | 实测结论 |
|---|---|
| A. `better-sqlite3` | native 模块，需预编译二进制 —— 与「直接依赖仅 4 个」这个卖点冲突 |
| **B. `node:sqlite`** | **22.22 上无需 `--experimental-sqlite` flag** 即可加载（仅一条 ExperimentalWarning） |
| C. `sql.js` 等 | WASM，性能与持久化体验最差 |

于是走 B：**零新增依赖**，同时拿到索引查询与 WAL 并发读。
（设计稿当时判断 B 需要 flag —— 实测不需要，这是运行时事实，不是文档推测。）

代价写进文档：SQLite 驱动需要 **Node ≥ 22.5**；JSONL 驱动无此要求。

---

## 3. 数据表

```sql
evidence      id PK · contract_version · kind · subject · source · observed_at
              run_id · dedupe_key · body_retained · data(JSON)
              INDEX (subject, source, kind) / (observed_at) / (run_id)
              UNIQUE(dedupe_key) WHERE dedupe_key IS NOT NULL

observations  id PK · type · subject · source · observed_at · run_id · status
              observer_version · parser_version · strategy_version
              identity_key · version_key · replacement_key · data(JSON)
              INDEX (subject, type, source) / (observed_at) / (run_id) / (status)
              UNIQUE(replacement_key) WHERE replacement_key IS NOT NULL
```

- `journal_mode = WAL`：单写多读。JSONL 时代「并发追加互相覆盖」的问题在这里消失
- **blob 仍然外置**（`blobs/<id>.txt`），库里只存 ref —— 大对象不进 DB（§9.1）
- ★ blob 目录与 JsonlStore **共用**：换驱动不会把正文一起弄丢
- `schema_version` 记在 `meta` 表；将来改表结构必须 +1 并写迁移

两处 `UNIQUE` 把 S2 的语义**交给数据库兜底**，而不是靠调用方记得先查一遍：
Evidence 去重键唯一、Observation 的「同 run + 同版本」唯一（materialized replacement）。

---

## 4. 语义对齐（★ 换实现不改行为）

| 契约 | SqliteStore 的实现 |
|---|---|
| Evidence immutable / append-only | 只有 INSERT，没有 UPDATE / DELETE |
| 重复写不覆盖 | 命中 `dedupe_key` 直接返回已有 id |
| 同 run + 同版本 | `INSERT OR REPLACE` 保持原 id，`replaces` 沿用原值（链不增长） |
| 不同 run + 同版本 | 新记录，**不建 replaces**（时间推进 ≠ 版本演进） |
| 版本演进 | 新记录，`replaces` 指向被取代的那条 |
| 排序 | `ORDER BY observed_at, rowid` —— rowid 保留写入顺序，复刻 JSONL 的「同时间戳按写入先后」 |
| latestOnly | 排序后按 identityKey 取首条，与 JSONL 同规则 |

**奇偶一致性有测试兜底**：同一批输入分别写进两个实现，10 组 Observation 查询 +
8 组 Evidence 查询逐项比对，必须完全一致。

---

## 5. 驱动切换（可逆转）

```text
默认                              → JsonlStore（S3–S7 行为不变）
GEOKIT_STORE_DRIVER=sqlite        → SqliteStore
其它值                            → 回落 JsonlStore（不猜、不报错）
```

★ 默认仍是 JSONL —— 换实现不改变任何既有行为。存储选型因此是**可逆**的，
不是一次性赌博。

### importFrom：可逆性的落点

「换实现」要真是可逆决策，就必须能**带着历史来回搬**：

```ts
await sqlite.importFrom(jsonl);   // 全量搬迁，源库一条不删
```

- 只读源、只写目标，源库数据不变
- 同 id 已存在则跳过 ⇒ **重复导入幂等**
- Evidence 正文按 `bodyRef` 读文件搬迁；blob 已被清理则只搬 metadata，
  **不伪造正文**

---

## 6. 文件

```text
NEW       src/lib/store/sqlite.ts        SqliteStore（完整实现 Store 接口）
NEW       scripts/test-sqlite-store.ts   50 项（含奇偶一致性比对）
NEW       docs/PHASE-1-S8.md
MODIFIED  src/lib/store/index.ts         驱动切换 storeDriver() / createStore(root, driver)
MODIFIED  package.json                   test:sqlite-store
```

**未改**：`src/lib/store/types.ts`（S2 契约）· `src/lib/store/jsonl.ts` ·
`src/lib/evidence/types.ts`（S1）· `src/lib/diff.ts`（S6）· `src/lib/services/*`（S7）·
三个 Observer · `analyze()` · baseline。

---

## 7. 测试（50 项）

```text
1 · 基础读写     落库回读 · blob 外置为文件（不进 DB）· schema 版本
2 · Evidence     append-only · 重复写不覆盖（原文未被改）· 显式幂等键
3 · Observation  同 run+同版本 → 替换保 id 且条数不变 · 不同 run → 新历史不建链 ·
                 版本演进 → replaces 指向前一条 · 显式幂等键 → duplicateOf
4 · 查询         全维度过滤 / 排序 / limit / latestOnly / find*By*
5 · ★ 奇偶一致   与 JsonlStore 比对 10 组 Observation + 8 组 Evidence 查询
6 · 持久化       重新打开实例后条数不变
7 · 驱动切换     默认 jsonl · env=sqlite 才换 · 未知值回落 jsonl
8 · importFrom   全量搬迁 · 源库不减 · 搬迁后查询一致 · 重复导入幂等
```

---

## 8. Contract Protection

```text
S1 contract:          unchanged（types.ts 未动）
S2 contract:          unchanged（Store 接口未扩未改；jsonl.ts 未动）
S3–S7 行为:           unchanged（默认驱动仍是 jsonl）
replaces semantics:   unchanged（SqliteStore 复用同一套判定，不重新解释）
analyze():            unchanged
上层代码:             零改动（S7 services / route、S6 diff 均未动）
baseline:             unchanged
```

---

## 9. 已知限制

```text
W-1  node:sqlite 在 Node 22 上仍带 ExperimentalWarning（stderr 一行）。
     API 若在小版本间变动，需跟一次；这是零依赖换来的代价。
W-2  SQLite 驱动要求 Node ≥ 22.5。JSONL 驱动无此要求 —— 老 Node 上请用默认驱动。
W-3  两个驱动的底层文件不同（raw-*.jsonl vs geokit.db），切换后需 importFrom 搬迁；
     blob 目录是共用的，正文不会丢。
W-4  importFrom 是「全量搬迁」不是「增量同步」：源库后续新增的记录不会自动跟进。
W-5  性能收益未做基准测试。索引已建（identity / time / run / status），
     但从 O(n) 全量扫描变成索引查询，只有在数千条以上才体现得出来。
W-6  仍是单进程写。WAL 解决了并发追加覆盖，但多进程同时写仍需上层加锁。
```

---

## 10. Phase 1 收官

```text
S1  契约修正：subject / source 拆分          ✅
S2  Store 接口 + JsonlStore                  ✅
S3  Site Observer                            ✅
S4  Search Observer（三家引擎特殊解析保留）   ✅
S5  AI Observer + 第六态 INDETERMINATE       ✅
S6  Diff 引擎（可比性优先）                   ✅
S7  只读时间维度 API                          ✅
S8  SQLite 实现（接口不变、可逆转）           ✅
```

「先定接口、后换实现」这条原则走到了终点：
存储从 JSONL 换成 SQLite，**上层一行没改**，而换错的代价只是改回一个环境变量。
