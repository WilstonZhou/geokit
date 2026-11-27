/**
 * 时间字符串工具。
 *
 * Observation.observedAt 在内部统一写成 UTC ISO；但外部注入/历史数据可能
 * 带时区偏移（2026-01-01T10:00:00+09:00）。字符串字典序在这种数据上
 * 不代表真实时间顺序，必须先按 Date.parse 比较 / 规范化。
 */

/** 可解析则转成 UTC ISO；不可解析原样返回 */
export function canonicalIso(value: string): string {
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : value;
}

/** 按真实时间比较；无法解析时退回字符串比较 */
export function cmpIso(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
  return a < b ? -1 : a > b ? 1 : 0;
}
