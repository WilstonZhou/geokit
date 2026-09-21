/**
 * Per-domain 速率限制（令牌桶）。
 *
 * 为什么必须存在：中文搜索引擎对直连采集的风控阈值不高。之前全系统
 * 没有任何速率控制，短时间连续请求会被直接打到验证页 —— 这也是
 * /api/serp 反复出现 blocked 的根因。
 *
 * 为什么不放在全局：不同域共享一个桶会让 A 站的请求饿死 B 站。
 * 百度的配额不能给 example.com 用，反之亦然。
 *
 * Phase 0 说明：默认配额刻意设得宽裕，单次调用不会被拦。它的作用是
 * 在"快速连续请求同一域名"时才介入 —— 不改变单次调用的历史行为。
 */

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimitPolicy {
  /** 桶容量，也是突发上限 */
  capacity: number;
  /** 每秒补充的令牌数 */
  refillPerSec: number;
}

export const DEFAULT_POLICY: RateLimitPolicy = {
  capacity: 8,
  refillPerSec: 1,
};

/** 预留：按域名覆盖配额。Phase 0 未启用，等真实限流数据累积后再调。 */
export function policyFor(_host: string): RateLimitPolicy {
  return DEFAULT_POLICY;
}

const buckets = new Map<string, Bucket>();

/**
 * 尝试获取一个令牌。
 * @returns 0 表示立即可执行；否则返回需要等待的毫秒数。
 */
export function acquire(host: string, policy: RateLimitPolicy = DEFAULT_POLICY): number {
  const now = Date.now();
  const b = buckets.get(host) ?? { tokens: policy.capacity, updatedAt: now };

  const elapsedSec = (now - b.updatedAt) / 1000;
  const refilled = Math.min(policy.capacity, b.tokens + elapsedSec * policy.refillPerSec);

  if (refilled >= 1) {
    buckets.set(host, { tokens: refilled - 1, updatedAt: now });
    return 0;
  }

  buckets.set(host, { tokens: refilled, updatedAt: now });
  const need = 1 - refilled;
  return Math.ceil((need / policy.refillPerSec) * 1000);
}

export function resetAll(): void {
  buckets.clear();
}
