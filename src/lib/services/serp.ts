/**
 * SERP 业务服务层。
 *
 * 为什么要有这一层：
 *   在它出现之前，「选哪些引擎」和「怎么算平均位次」在 HTTP route 和
 *   MCP handler 里各写了一份。结果就是 Agent 通过 MCP 拿到的口径，
 *   和人在网页上看到的口径，没有任何机制保证一致 —— 今天一致只是巧合。
 *   将来 CI 是第三个通道，那时再抄一遍，三份实现就会各自漂移。
 *
 * 规则：**聚合逻辑只写在这里。** transport 层（HTTP / MCP / 将来的 CLI）
 * 只负责参数校验、鉴权、序列化，不做业务判断。
 */

import { fetchMultiEngine } from "../serp";
import type { SerpResponse } from "../serp";
import {
  CN_ENGINES,
  GLOBAL_ENGINES,
  ENGINE_LIST,
  type EngineId,
} from "../engines";

/** pages 上限，所有通道共用 */
export const MAX_PAGES = 3;

export interface SearchRankingsInput {
  keyword: string;
  targetDomain?: string;
  /** 显式指定引擎；优先级高于 group */
  engines?: EngineId[];
  group?: "cn" | "global" | "all";
  pages?: number;
}

export interface SerpSummary {
  okEngines: number;
  blockedEngines: number;
  /** 各引擎中该域名的平均自然位次；一次都没上榜为 null */
  averageRank: number | null;
  bestRank: number | null;
  totalItems: number;
}

export interface SearchRankingsResult {
  keyword: string;
  targetDomain: string | null;
  engineCount: number;
  summary: SerpSummary;
  results: SerpResponse[];
}

/**
 * 决定本次要查哪些引擎。
 *
 * 显式 engines 优先；非法 id 直接丢弃而非报错 —— 单次查询里混进一个
 * 未知引擎 id 不值得让整个请求失败。
 */
export function resolveEngineIds(
  group: "cn" | "global" | "all" = "cn",
  engines?: EngineId[]
): EngineId[] {
  if (Array.isArray(engines) && engines.length > 0) {
    return engines.filter((e) => ENGINE_LIST.some((x) => x.id === e));
  }
  if (group === "global") return GLOBAL_ENGINES;
  if (group === "all") return [...CN_ENGINES, ...GLOBAL_ENGINES];
  return CN_ENGINES;
}

/**
 * 跨引擎聚合。**纯函数** —— 同样的输入永远得到同样的输出，
 * 这也是它能被 MCP、HTTP、未来的 CI 同时安全复用的原因。
 *
 * 分母口径：averageRank / bestRank 只在「真的抓到且真的榜单有名」的引擎上算。
 * 被 block 的引擎不参与平均 —— 否则等于用「没抓到」去稀释真实位次。
 */
export function summarizeRankings(results: SerpResponse[]): SerpSummary {
  const ok = results.filter((r) => r.status === "ok");
  const ranked = ok.filter((r) => r.targetRank !== null);

  const averageRank = ranked.length
    ? Math.round(
        (ranked.reduce((s, r) => s + (r.targetRank ?? 0), 0) / ranked.length) * 10
      ) / 10
    : null;

  const bestRank = ranked.length
    ? Math.min(...ranked.map((r) => r.targetRank ?? Number.MAX_SAFE_INTEGER))
    : null;

  return {
    okEngines: ok.length,
    blockedEngines: results.length - ok.length,
    averageRank,
    bestRank,
    totalItems: results.reduce((s, r) => s + r.items.length, 0),
  };
}

/** 唯一的对外入口。HTTP / MCP 都必须走这里。 */
export async function searchRankings(
  input: SearchRankingsInput
): Promise<SearchRankingsResult> {
  const keyword = input.keyword.trim();
  if (!keyword) throw new Error("缺少 keyword");

  const ids = resolveEngineIds(input.group, input.engines);
  const pages = Math.max(1, Math.min(input.pages ?? 1, MAX_PAGES));

  const results = await fetchMultiEngine(ids, keyword, input.targetDomain, pages);

  return {
    keyword,
    targetDomain: input.targetDomain ?? null,
    engineCount: ids.length,
    summary: summarizeRankings(results),
    results,
  };
}
