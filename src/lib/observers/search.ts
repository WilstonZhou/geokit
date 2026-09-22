/**
 * Search Observer —— Phase 1 S4。
 *
 * ─────────────────────────────────────────────────────────────
 * 它是「Observation adapter」，不是新的 SERP 解析器
 * ─────────────────────────────────────────────────────────────
 * 本文件**不抓页面、不解析 HTML、不请求搜索引擎**。它只做一件事：
 * 把 `serp_html` Evidence + 已算好的 `SerpResponse` 映射成符合 S1 契约的
 * rank Observation。
 *
 * 与 S3 Site Observer 的差异：**这里不调解析器**。
 * SERP 的位次解析依赖网络（中转链接要跟随重定向才能拿到真实域名），
 * 若塞进 Observer 就违反「Observer 不直连采集层」。解析在 `serp.ts` 完成，
 * Observer 只消费结果 —— 每一条结论仍通过 `evidenceRefs` 指回原始素材。
 *
 * ─────────────────────────────────────────────────────────────
 * 每个引擎一条，不做跨引擎合并
 * ─────────────────────────────────────────────────────────────
 * 跨引擎平均位次是**聚合结论**，口径随「选了哪些引擎」变化；存聚合值会让
 * 历史在引擎增减时断裂。因此：存单引擎事实，聚合在读取时算。
 *
 * subject 不含引擎（被观测的是「某站点在某词下的表现」），
 * source 是 `search-engine:<engineId>`（观测来源）——
 * 不同引擎天然是不同 identity，不需要把引擎塞进 subject。
 *
 * ─────────────────────────────────────────────────────────────
 * replaces：S4 完全不碰
 * ─────────────────────────────────────────────────────────────
 *   S4 MUST NOT MODIFY replaces semantics.
 *
 * 不计算、不查询、不设置 `replaces`，不按关键词覆盖历史。
 * 只提供 observerVersion / parserVersion / strategyVersion，
 * 剩下的由 `JsonlStore.saveObservation()` 按 S2 已冻结语义决定。
 *
 * ─────────────────────────────────────────────────────────────
 * 版本纪律（★ 改动必读）
 * ─────────────────────────────────────────────────────────────
 * `SERP_PARSER_VERSION` 定死后，改动 `serp.ts` 的解析逻辑（尤其是
 * 三家引擎的 mu / data-mdurl / citeLinkClass）必须递增它，否则
 * 口径变化会被时间线误读成「排名真的变了」。
 */
import type { Store } from "../store";
import type { Evidence, Observation, ObservationStatus } from "../evidence/types";
import { OBSERVATION_CONTRACT_VERSION } from "../evidence/types";
import { searchSubject, searchEngineSource, serpStrategyVersion } from "../evidence/identity";
import type { SerpResponse } from "../serp";

/** 本 Observer 的版本。改本文件的映射规则必须递增 */
export const SEARCH_OBSERVER_VERSION = "search-observer@0.1.0";

/**
 * 解析器版本 —— 对应 serp.ts 的位次解析口径。
 *
 * 记为正式版：它表达的是 Phase 0 已冻结并进入 regression baseline 的
 * 那套解析（含三家引擎特殊处理），不是尚在试运行的版本。
 */
export const SERP_PARSER_VERSION = "serp-parser@1.0.0";

/**
 * SERP 排名的有效时长。
 *
 * 排名是**瞬时快照**，受个性化、地域、时间、A/B 测试影响。
 * Phase 1 禁止把 rank 表述为「当前排名」这类永久事实 ——
 * 因此每条结论都带 validUntil，读取方必须能看到时效性。
 */
export const SERP_OBSERVATION_TTL_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* 输入 / 输出                                                          */
/* ------------------------------------------------------------------ */

export interface SearchObservationInput {
  /**
   * 本次采集落成的 `serp_html` Evidence（多页时为多条，按页序）。
   *
   * 必须非空且全部留存正文 —— 只有 hash 没有正文，将来无法重放，
   * 也就无法验证「当时到底解析出了什么」。
   */
  evidences: Evidence[];
  /** 已算好的单引擎结果。Observer 不重新解析 */
  response: SerpResponse;
  /** 目标域名。未指定时 subject 用 `site=*` 占位 */
  targetDomain?: string;
}

export type ObserveSearchResult =
  | { ok: true; observation: Observation<SerpResponse> }
  | { ok: false; reason: string };

/* ------------------------------------------------------------------ */
/* 纯函数：Evidence + SerpResponse → Observation                        */
/* ------------------------------------------------------------------ */

export function observeSearch(input: SearchObservationInput): ObserveSearchResult {
  const { evidences, response, targetDomain } = input;

  if (!evidences || evidences.length === 0) {
    return { ok: false, reason: "没有 serp_html Evidence —— 结论必须能指回原始素材" };
  }

  // ★ 与 S3 同构的硬门槛：hash-only 的 Evidence 撑不起结论。
  //   SERP HTML 体积大，但这恰恰是「抓到了什么」的唯一凭证。
  const notRetained = evidences.find((e) => !e.response.bodyRetained);
  if (notRetained) {
    return {
      ok: false,
      reason: `Evidence ${notRetained.id} 未留存响应体（hash-only），无法产出可重放的 rank 结论`,
    };
  }

  const first = evidences[0];
  const engineId = response.engine;
  const status = statusFor(response);
  const observedAt = first.observedAt;
  const validUntil = new Date(new Date(observedAt).getTime() + SERP_OBSERVATION_TTL_MS).toISOString();

  const observation: Observation<SerpResponse> = {
    // id 由 Store 分配 —— S4 不参与 id 生成，也不参与 replaces 判定
    id: "",
    contractVersion: OBSERVATION_CONTRACT_VERSION,
    type: "rank",
    subject: searchSubject(targetDomain, response.keyword),
    source: searchEngineSource(engineId),
    observedAt,
    // runId 不设：一次独立采集就是一条新历史，不去重
    observerVersion: SEARCH_OBSERVER_VERSION,
    parserVersion: SERP_PARSER_VERSION,
    // 三家引擎各有解析策略，记下来才能区分「哪家哪版策略出了问题」
    strategyVersion: serpStrategyVersion(engineId),
    evidenceRefs: evidences.map((e) => e.id),
    status,
    result: response,
    /**
     * 置信度上限是 medium —— 单引擎单次采样不具备统计意义。
     * 即便 coverage 满格也不给 high：SERP 波动大，N=1 不该被当成定论。
     */
    confidence: status === "OBSERVED" ? "medium" : "unavailable",
    coverage: {
      expected: 1,
      observed: response.status === "ok" ? 1 : 0,
      ratio: response.status === "ok" ? 1 : 0,
      missing: response.status === "ok" ? undefined : [engineId],
    },
    metadata: {
      extra: {
        engineId,
        keyword: response.keyword,
        targetDomain: targetDomain ?? undefined,
        // 时效性写在 metadata 而不是顶层 —— 契约没有 validUntil 字段，
        // 也禁止为了一个派生值去扩 S1 契约
        validUntil,
        itemCount: response.items.length,
      },
    },
    caveat: caveatFor(response, targetDomain),
    // ★ 不设置 replaces、不查上一条、不按关键词覆盖 —— 全权交给 Store
  };

  return { ok: true, observation };
}

/* ------------------------------------------------------------------ */
/* 状态映射                                                              */
/* ------------------------------------------------------------------ */

/**
 * SerpStatus → ObservationStatus。
 *
 * ★ 最关键的一条：`ok` 但 `targetRank = null`（抓到了榜单、目标没上榜）
 * 是**真实结论**，记 `OBSERVED` + caveat，**不是失败**。
 * 契约里没有 `NOT_FOUND`，也不为它新增 —— 与 S3 处理 404 的方式一致：
 * 「目标不存在」是站点的事实，不是我方的故障。
 *
 * 而 `no_results`（页面里一条都没解析出来）完全不同：那说明页面结构
 * 变了或返回的是验证页，**无从判断目标上没上榜**。记 UNOBSERVABLE，
 * 绝不能顺势说成「没上榜」—— 那就成了用解析失败冒充结论。
 */
function statusFor(r: SerpResponse): ObservationStatus {
  switch (r.status) {
    case "ok":
      return "OBSERVED";
    case "blocked":
      return "BLOCKED";
    case "error":
      return "ERROR";
    case "no_results":
      return "UNOBSERVABLE";
    default:
      return "ERROR";
  }
}

function caveatFor(r: SerpResponse, targetDomain?: string): string | undefined {
  switch (r.status) {
    case "ok":
      if (!targetDomain) return "未指定目标域名，本次只记录该关键词下的榜单快照";
      if (r.targetRank === null)
        return `已抓到榜单（${r.items.length} 条）但目标域名未上榜 —— 这是真实结论，不是采集失败`;
      return undefined;
    case "no_results":
      return "未能从返回页解析出结果条目：该引擎页面结构可能已改版，或返回的是验证页 —— 无法判定是否上榜，故记为「未观测到」而非「未上榜」";
    case "blocked":
      return `被引擎限流/拦截：${r.note ?? "无附加信息"} —— 本次无排名结论`;
    case "error":
      return `采集失败：${r.note ?? "无附加信息"}`;
    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* 落库                                                                 */
/* ------------------------------------------------------------------ */

export async function recordSearchObservation(
  store: Store,
  input: SearchObservationInput
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const r = observeSearch(input);
  if (!r.ok) return { ok: false, reason: r.reason };

  try {
    const saved = await store.saveObservation(r.observation);
    return { ok: true, id: saved.id };
  } catch (e) {
    return {
      ok: false,
      reason: `Observation 落盘失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
