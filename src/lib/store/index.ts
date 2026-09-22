/**
 * Store 装配入口。
 *
 * S1/S2 阶段**尚未接入任何 route / MCP** —— 本文件只是把「怎么建一个 store」
 * 收在一处，避免将来四处散落 `new JsonlStore(...)`。
 * 真正接线是 S7（只读时间维度 API）的事。
 */
import { join } from "node:path";

import { JsonlStore } from "./jsonl";
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

export function createStore(root: string = storeRoot()): Store {
  return new JsonlStore(root);
}

export { JsonlStore };
export * from "./types";
export * from "./retention";
