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
  topic: string,
  competitors: string[] = []
): Promise<VisibilityReport> {
  const b = brand.trim();
  const t = topic.trim();
  if (!b || !t) throw new Error("需要提供 brand 与 topic 两个参数");

  return runVisibilityMatrix(b, t, collectProviderKeys(), competitors);
}

/**
 * 本次观测使用的采样配置。
 * 对外暴露的目的是让调用方能说清「这个结论是在什么条件下产生的」——
 * 缺了它，分数就只是一个没有语境的数字。
 */
export function samplingProfile() {
  return { ...SAMPLING_PROFILE, parserVersion: AI_VISIBILITY_PARSER_VERSION };
}

/**
 * 多 query 批量探测。
 *
 * `probe` 可注入 —— 测试传假探测函数即可覆盖「有引用 / 无引用 / 拒答 /
 * 超时 / HTTP 错误」各分支，不必访问任何真实外网（T2 验收要求）。
 * 默认走 runVisibilityMatrix：真实探测，单个 query 失败不影响其他 query。
 */
export interface VisibilityBatchFailure {
  /** 原始 query（保持输入顺序定位） */
  topic: string;
  /** 在输入 topics 中的下标 */
  index: number;
  /** 失败原因（异常 message） */
  reason: string;
}

export interface VisibilityBatchResult {
  /** 成功的报告，按输入顺序 */
  reports: VisibilityReport[];
  /** 失败项：调用方可以区分“没请求”与“请求失败” */
  failures: VisibilityBatchFailure[];
  /** 空 query 被跳过的数量 */
  skipped: number;
}

export async function batchProbeVisibilityDetailed(
  brand: string,
  topics: string[],
  concurrency: number = 2,
  probe?: (brand: string, topic: string) => Promise<VisibilityReport>,
  competitors: string[] = []
): Promise<VisibilityBatchResult> {
  if (!brand.trim()) throw new Error("缺少 brand");
  // 与 probeVisibility 保持同一契约：空品牌抛错，不要静默返回 [] 假装成功

  const safeTopics = topics.slice(0, 100);
  const reports = new Array<VisibilityReport | undefined>(safeTopics.length);
  const failures: VisibilityBatchFailure[] = [];
  let skipped = 0;
  const doProbe =
    probe ??
    ((b: string, t: string) => runVisibilityMatrix(b, t, collectProviderKeys(), competitors));

  // 并发数必须是 1..5 的整数：Array(2.5) 会直接抛 RangeError
  const workerCount = Math.min(5, Math.max(1, Math.trunc(concurrency) || 2));

  const runTasks = async () => {
    let i = 0;
    const workers = Array(workerCount).fill(null).map(async () => {
      while (i < safeTopics.length) {
        const idx = i++;
        const t = safeTopics[idx];
        if (!t || !t.trim()) {
          skipped++;
          continue;
        }
        try {
          reports[idx] = await doProbe(brand, t);
        } catch (e) {
          failures.push({
            topic: t,
            index: idx,
            reason: e instanceof Error ? e.message : String(e),
          });
        }
      }
    });
    await Promise.all(workers);
  };

  await runTasks();
  return {
    reports: reports.filter((r): r is VisibilityReport => r !== undefined),
    failures: failures.sort((a, b) => a.index - b.index),
    skipped,
  };
}

/** 兼容旧调用方：只返回成功报告 */
export async function batchProbeVisibility(
  brand: string,
  topics: string[],
  concurrency: number = 2,
  probe?: (brand: string, topic: string) => Promise<VisibilityReport>,
  competitors: string[] = []
): Promise<VisibilityReport[]> {
  const result = await batchProbeVisibilityDetailed(
    brand,
    topics,
    concurrency,
    probe,
    competitors
  );
  return result.reports;
}
