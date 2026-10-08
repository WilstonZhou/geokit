/**
 * Store 装配入口。
 *
 * S1/S2 阶段**尚未接入任何 route / MCP** —— 本文件只是把「怎么建一个 store」
 * 收在一处，避免将来四处散落 `new JsonlStore(...)`。
 * 真正接线是 S7（只读时间维度 API）的事。
 *
 * ─────────────────────────────────────────────────────────────
 * 关于 SqliteStore 的静态导入（设计取舍）
 * ─────────────────────────────────────────────────────────────
 * `SqliteStore` 类本身被静态 import，但只有 `new SqliteStore(root)` 才会
 * 实际打开数据库 —— 默认 jsonl 用户不会触发任何 sqlite 操作。
 *
 * 唯一副作用是 `node:sqlite` 模块在进程启动时被解析加载到内存。
 * 由于 `package.json` 的 `engines.node` 已硬要求 `>=22.5.0`，node:sqlite
 * 在该版本及以上是内置可用模块（22.22+ 无需 --experimental-sqlite flag），
 * 不会引入任何外部依赖，也不会让 jsonl 用户崩溃。
 *
 * 之所以不做动态 `import()`：`createStore` 是同步 API，被 audit / serp /
 * llms / visibility / crawler / services 等 10+ 处同步调用，改 async 会
 * 引发大范围连锁修改。若未来要彻底解耦，可考虑 `createRequire` 或顶层
 * `await import()` 的方案，但当前阶段的最小改动原则下不做。
 */
import { join } from "node:path";

import { JsonlStore } from "./jsonl";
import { SqliteStore } from "./sqlite";
import type { Store } from "./types";

/**
 * 存储根目录。
 *
 * 默认 `.evidence`，与 Phase 0 的 Evidence 目录**故意是同一个**：
 * 这样已经存在的旧 Evidence 文件无需搬迁即可被读到。
 *
 * S5 补：`GEOKIT_EVIDENCE_DIR` 作为次级兜底。它是 Phase 0 就存在的变量名，
 * `scripts/verify-ai-visibility.ts` 等在用它把这次运行的素材隔离到临时目录；
 * 少这一层，AI 通道改走 Store 后就会把素材写回项目根。
 */
export function storeRoot(): string {
  return (
    process.env.GEOKIT_STORE_DIR ?? process.env.GEOKIT_EVIDENCE_DIR ?? join(process.cwd(), ".evidence")
  );
}

/**
 * 存储驱动（Phase 1 S8）。
 *
 * ★ 默认仍是 `jsonl` —— 换实现不改变任何既有行为，S3–S7 的代码与数据
 *   全部照旧。**实际使用** SQLite 必须显式设置 `GEOKIT_STORE_DRIVER=sqlite`。
 *   （SqliteStore 类本身被静态加载，但仅在该环境变量设置后才会被实例化、
 *    打开数据库 —— 见文件顶部关于静态导入的说明。）
 *
 * 这就是「先定接口、后换实现」的兑现：存储选型因此是**可逆**的，
 * 不是一次性赌博。
 */
export type StoreDriver = "jsonl" | "sqlite";

export function storeDriver(): StoreDriver {
  const v = (process.env.GEOKIT_STORE_DRIVER ?? "jsonl").toLowerCase();
  return v === "sqlite" ? "sqlite" : "jsonl";
}

export function createStore(
  root: string = storeRoot(),
  driver: StoreDriver = storeDriver()
): Store {
  return driver === "sqlite" ? new SqliteStore(root) : new JsonlStore(root);
}

export { JsonlStore, SqliteStore };
export * from "./types";
export * from "./retention";
