/**
 * 鲸析 GEOkit — Opportunity Engine 验证闭环（T6）
 *
 * 每个机会在生成时就附带了 `verification`：它告诉调用方，
 * "下次复检时应该看到什么信号变化"。本模块基于两次观测的对比，
 * 判断机会是否已被解决（resolved / unchanged / worsened / unknown）。
 *
 * 不调任何大模型：判定全部基于规则。
 */

import type {
  Opportunity,
  OpportunityResolution,
  Verification,
} from "./types";
import type { Observation } from "../evidence/types";

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/**
 * 从观测里按 signalKey 取值。
 *
 * signalKey 约定为 Observation.result 上的字段名（如 "geoScore"、"mentioned"），
 * 也支持点路径 "result.geoScore"（兼容 MCP 工具直接传 Observation 的写法）。
 */
function readSignal(obs: Observation | undefined, signalKey: string): unknown {
  if (!obs || !obs.result || typeof obs.result !== "object") return undefined;
  const r = obs.result as Record<string, unknown>;
  // 去掉可选的 "result." 前缀
  const key = signalKey.startsWith("result.")
    ? signalKey.slice("result.".length)
    : signalKey;
  return r[key];
}

/**
 * 找出与该机会 target 相关的观测。
 *
 * 匹配规则：observation.subject 包含 opportunity.target（双向包含，宽松匹配）。
 * 这样 URL / 域名 / query 都能命中对应观测。
 */
function findRelated(
  observations: Observation[],
  target: string
): Observation[] {
  if (observations.length === 0) return [];
  const t = target.toLowerCase();
  return observations.filter((o) => {
    const s = (o.subject ?? "").toLowerCase();
    return s.includes(t) || t.includes(s);
  });
}

/** 按时间排序，取最旧与最新各一条 */
function pickEnds(observations: Observation[]): {
  prev?: Observation;
  curr?: Observation;
} {
  if (observations.length === 0) return {};
  const sorted = [...observations].sort(
    (a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)
  );
  return { prev: sorted[0], curr: sorted[sorted.length - 1] };
}

function isTruthy(v: unknown): boolean {
  return v === true || v === "true" || (typeof v === "number" && v > 0);
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 基于两次观测判断机会是否已被解决。
 *
 * @param op           被验证的机会
 * @param prevObs      上一次相关观测列表（按 subject 匹配 target）
 * @param currObs      本次相关观测列表
 * @returns resolved / unchanged / worsened / unknown
 *
 * 判定规则：
 *   - 找不到 prev 或 curr → unknown
 *   - 按 verification.direction 比对 prev/curr 在 signalKey 上的取值：
 *     - increase  curr > prev → resolved；curr == prev → unchanged；curr < prev → worsened
 *     - decrease  curr < prev → resolved；curr == prev → unchanged；curr > prev → worsened
 *     - appear    !prev && curr → resolved；!prev && !curr → unchanged；prev && !curr → worsened
 *     - disappear prev && !curr → resolved；prev && curr → unchanged；!prev && curr → worsened
 */
export function verifyOpportunity(
  op: Opportunity,
  prevObs: Observation[],
  currObs: Observation[]
): OpportunityResolution {
  const v: Verification = op.verification;
  const prevRel = findRelated(prevObs, op.target);
  const currRel = findRelated(currObs, op.target);
  const { prev: prevEnd } = pickEnds(prevRel);
  const { curr: currEnd } = pickEnds(currRel);
  if (!prevEnd || !currEnd) return "unknown";

  const prev = readSignal(prevEnd, v.signalKey);
  const curr = readSignal(currEnd, v.signalKey);

  switch (v.direction) {
    case "increase":
    case "decrease": {
      if (typeof prev !== "number" || typeof curr !== "number") {
        // 非数值无法比较 → unknown
        return "unknown";
      }
      if (curr === prev) return "unchanged";
      const improved =
        v.direction === "increase" ? curr > prev : curr < prev;
      return improved ? "resolved" : "worsened";
    }
    case "appear": {
      const before = isTruthy(prev);
      const after = isTruthy(curr);
      if (!before && after) return "resolved";
      if (before && after) return "unchanged";
      if (before && !after) return "worsened";
      return "unchanged"; // 之前没有、之后也没有 —— 没变
    }
    case "disappear": {
      const before = isTruthy(prev);
      const after = isTruthy(curr);
      if (before && !after) return "resolved";
      if (before && after) return "unchanged";
      if (!before && after) return "worsened";
      return "unchanged"; // 之前没有、之后也没有 —— 没变
    }
    default:
      return "unknown";
  }
}

/**
 * 批量验证 —— 便于 UI/MCP 一次性对一组机会判定状态。
 */
export function verifyOpportunities(
  opportunities: Opportunity[],
  prevObs: Observation[],
  currObs: Observation[]
): Array<{ opportunity: Opportunity; resolution: OpportunityResolution }> {
  return opportunities.map((op) => ({
    opportunity: op,
    resolution: verifyOpportunity(op, prevObs, currObs),
  }));
}
