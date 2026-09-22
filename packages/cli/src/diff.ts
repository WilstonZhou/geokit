/**
 * `geokit diff`（Phase 2 · S2-2）。
 *
 * 两种取数方式，覆盖两种环境：
 *
 *   1. Store  ：本地有观测历史时（`--subject --type`，可加 `--source`/`--to`）
 *   2. 文件   ：CI runner 上没有 Store，直接给两份 Observation JSON
 *               （`--prev` / `--curr`），由 S6 的 diffObservations 判定
 *
 * ★ 判定逻辑本身**一行都不在这里** —— 全部复用 S6 的 diff.ts。
 *   CLI 只负责取数和渲染。这样才不会出现「CLI 说退化、API 说不变」的两套口径。
 */
import { readFileSync } from "node:fs";

import { diffLatest, diffObservations, type ObservationDiff } from "../../../src/lib/diff";
import type { Observation } from "../../../src/lib/evidence/types";
import { createStore, storeRoot } from "../../../src/lib/store";

export interface DiffReport {
  source: string;
  diff: ObservationDiff;
  exitCode: number;
}

export interface DiffOptions {
  subject?: string;
  type?: string;
  source?: string;
  to?: string;
  /** 前一次观测的 json 文件 */
  prev?: string;
  /** 本次观测的 json 文件 */
  curr?: string;
  /** Store 根目录（默认走 storeRoot()，CI 可指向 artifact 解压出来的目录） */
  dir?: string;
}

export async function runDiff(opts: DiffOptions): Promise<DiffReport> {
  // ── 文件模式（CI 默认） ─────────────────────────────────
  if (opts.prev || opts.curr) {
    if (!opts.prev || !opts.curr) {
      throw new Error("文件模式需要同时提供 --prev 与 --curr");
    }
    const previous = readObservation(opts.prev);
    const current = readObservation(opts.curr);
    const diff = diffObservations(previous, current);
    return { source: `files:${opts.prev} → ${opts.curr}`, diff, exitCode: 0 };
  }

  // ── Store 模式 ─────────────────────────────────────────
  if (!opts.subject || !opts.type) {
    throw new Error("需要 --subject 与 --type（或改用 --prev/--curr 文件模式）");
  }
  const store = createStore(opts.dir ?? storeRoot());
  const diff = await diffLatest(store, {
    subject: opts.subject,
    type: opts.type,
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.to ? { to: opts.to } : {}),
  });

  // 一条观测都没有 —— 这不是「没变化」，是「没得比」，必须说清楚
  if (!diff.currentId) {
    return { source: "store", diff, exitCode: 1 };
  }
  return { source: "store", diff, exitCode: 0 };
}

function readObservation(path: string): Observation | null {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object") return null;
  return parsed as Observation;
}
