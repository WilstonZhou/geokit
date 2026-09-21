/**
 * AI 可见性业务服务层。
 *
 * 存在理由同 services/serp：
 *   「从环境变量收集 key」这一步原先在 HTTP route 与 MCP handler 各写一遍。
 *   这不是性能问题，是**口径漂移**问题 —— 哪天某侧加个白名单过滤，
 *   Agent 和人就会看到不同的结果。
 *
 * Phase 0 边界：本文件只做编排，不做新的观测策略 —— 多样本采样 / 重试倍数
 * 之类的采样方案属于 Search Observer / AI Observer，是 Phase 1 的事。
 */

import {
  PROVIDER_LIST,
  runVisibilityMatrix,
  SAMPLING_PROFILE,
  AI_VISIBILITY_PARSER_VERSION,
  type ProviderId,
  type VisibilityReport,
} from "../visibility";

/** 从服务端环境变量收集已配置的 key。前端永远拿不到这些值。 */
export function collectProviderKeys(): Partial<Record<ProviderId, string>> {
  const keys: Partial<Record<ProviderId, string>> = {};
  for (const p of PROVIDER_LIST) {
    const v = process.env[p.envKey];
    if (v) keys[p.id] = v;
  }
  return keys;
}

/** 当前配置了 key 的模型 id 列表（给 UI 提示用，不含 key 本身） */
export function configuredProviders(): {
  id: ProviderId;
  name: string;
  vendor: string;
  cnRelevance: "high" | "medium" | "low";
  note: string;
  configured: boolean;
  envKey: string;
}[] {
  return PROVIDER_LIST.map((p) => ({
    id: p.id,
    name: p.name,
    vendor: p.vendor,
    cnRelevance: p.cnRelevance,
    note: p.note,
    configured: Boolean(process.env[p.envKey]),
    envKey: p.envKey,
  }));
}

/** HTTP / MCP 共用的唯一入口 */
export async function probeVisibility(
  brand: string,
  topic: string
): Promise<VisibilityReport> {
  const b = brand.trim();
  const t = topic.trim();
  if (!b || !t) throw new Error("需要提供 brand 与 topic 两个参数");

  return runVisibilityMatrix(b, t, collectProviderKeys());
}

/**
 * 本次观测使用的采样配置。
 * 对外暴露的目的是让调用方能说清「这个结论是在什么条件下产生的」——
 * 缺了它，分数就只是一个没有语境的数字。
 */
export function samplingProfile() {
  return { ...SAMPLING_PROFILE, parserVersion: AI_VISIBILITY_PARSER_VERSION };
}
