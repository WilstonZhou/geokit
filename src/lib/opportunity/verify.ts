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
import { asEntityAudit, missingEntityCount } from "./signals";

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** 让 "https://www.Example.com/a" 与 "example.com" 可以互相比较 */
function normalizeDomainLike(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

function pagesIncludeUrl(result: Record<string, unknown>, target: string): boolean {
  const pages = Array.isArray(result.pages) ? result.pages : [];
  return pages.some((p) => {
    if (!p || typeof p !== "object") return false;
    const page = p as Record<string, unknown>;
    return page.url === target || page.finalUrl === target;
  });
}

/**
 * 从观测里按 signalKey 取值。
 *
 * signalKey 约定为 Observation.result 上的字段名（如 "geoScore"、"mentioned"），
 * 也支持点路径（"totals.avgCtr"）以及几个按业务语义解析的特殊信号：
 *   - ctr / position：GSC topRows 中按 query/page 匹配的行
 *   - citedDomains：AI 引用域名里是否出现目标域名
 *   - pageInCrawl：crawl Observation 的 pages 是否包含目标 URL
 */
function readSignal(
  obs: Observation | undefined,
  signalKey: string,
  target: string,
  issueId?: string,
  issueType?: string
): unknown {
  if (!obs || !obs.result || typeof obs.result !== "object") return undefined;
  const r = obs.result as Record<string, unknown>;
  const key = signalKey.startsWith("result.")
    ? signalKey.slice("result.".length)
    : signalKey;

  if (key === "missingEntityCount" || key === "hasEntity") {
    const audit = asEntityAudit(r);
    if (!audit) return undefined;
    const count = missingEntityCount(audit);
    // hasEntity 是旧机会的兼容信号（完整 = 缺失数为 0）
    return key === "hasEntity" ? count === 0 : count;
  }

  if (key === "issuePresent") {
    const issues = Array.isArray(r.issues) ? r.issues : [];
    // 优先按“类型 + 目标 URL”判断：issue.id 含受影响 URL 集合哈希，
    // 部分页面修好后 id 会变化，不能因此把“仍影响 target”误判为已解决。
    if (issueType) {
      return issues.some((i) => {
        if (i === null || typeof i !== "object") return false;
        const issue = i as Record<string, unknown>;
        if (issue.type !== issueType) return false;
        if (!Array.isArray(issue.affectedUrls)) return true;
        return issue.affectedUrls.includes(target);
      });
    }
    if (!issueId) return undefined;
    return issues.some(
      (i) =>
        i !== null &&
        typeof i === "object" &&
        (i as Record<string, unknown>).id === issueId
    );
  }

  if (key === "citedDomains") {
    const domains = Array.isArray(r.citedDomains) ? r.citedDomains : [];
    const wanted = normalizeDomainLike(target);
    return domains.some(
      (d) => typeof d === "string" && normalizeDomainLike(d) === wanted
    );
  }

  if (key === "pageInCrawl") {
    return pagesIncludeUrl(r, target);
  }

  if (key === "ctr" || key === "position") {
    const rows = Array.isArray(r.topRows) ? r.topRows : [];
    const row = rows.find((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      const keys = (candidate as Record<string, unknown>).keys;
      return (
        Array.isArray(keys) &&
        keys.some(
          (k) =>
            typeof k === "string" &&
            k.toLowerCase() === target.toLowerCase()
        )
      );
    });
    if (row && typeof row === "object") {
      const value = (row as Record<string, unknown>)[key];
      if (typeof value === "number") return value;
    }
    // 兼容调用方直接构造的 Observation（旧测试 / 手工复检数据）
    return getPath(r, key);
  }

  return getPath(r, key);
}

/**
 * 找出与该机会 target 相关的观测。
 *
 * 优先按 subject 双向包含匹配；对 GSC / crawl / citation 这类“target
 * 不在 subject 里但在 result 明细里”的观测，按 signalKey 做针对性匹配。
 */
function findRelated(
  observations: Observation[],
  target: string,
  signalKey: string,
  issueId?: string
): Observation[] {
  if (observations.length === 0) return [];
  const t = target.toLowerCase();
  const key = signalKey.startsWith("result.")
    ? signalKey.slice("result.".length)
    : signalKey;

  return observations.filter((o) => {
    const s = (o.subject ?? "").toLowerCase();
    if (s.includes(t) || t.includes(s)) return true;

    const r =
      o.result && typeof o.result === "object"
        ? (o.result as Record<string, unknown>)
        : undefined;
    if (!r) return false;

    if (key === "issuePresent") {
      if (!Array.isArray(r.issues) || !issueId) return false;
      // 目标页面可能已经不在当前爬取结果里（问题已修复），
      // 因此优先按站点 origin 匹配，而不是要求 target 出现在 pages 中。
      try {
        const origin = new URL(target).origin.toLowerCase();
        if (origin && s.includes(origin)) return true;
      } catch {
        /* target 可能不是 URL（用 issue.title），继续用 pages 匹配 */
      }
      const pages = Array.isArray(r.pages) ? r.pages : [];
      return pages.some((p) => {
        if (!p || typeof p !== "object") return false;
        const page = p as Record<string, unknown>;
        return page.url === target || page.finalUrl === target;
      });
    }
    if (key === "citedDomains") {
      // 引用类机会要跨模型槽位找所有带引用域的观测
      return Array.isArray(r.citedDomains);
    }
    if (key === "pageInCrawl") {
      return Array.isArray(r.pages);
    }
    if (key === "ctr" || key === "position") {
      const rows = Array.isArray(r.topRows) ? r.topRows : [];
      return rows.some((row) => {
        if (!row || typeof row !== "object") return false;
        const keys = (row as Record<string, unknown>).keys;
        return (
          Array.isArray(keys) &&
          keys.some(
            (k) =>
              typeof k === "string" && k.toLowerCase() === t
          )
        );
      });
    }
    return false;
  });
}

/** 把分类信号映射成可比较的数值（值越大越好） */
const CATEGORY_ORDER: Record<string, number> = {
  NONE: 0,
  SLOW: 1,
  AVERAGE: 2,
  FAST: 3,
};

function comparableNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const mapped = CATEGORY_ORDER[v.toUpperCase()];
    if (mapped !== undefined) return mapped;
  }
  return null;
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
  // 没有观测数据源的机会只能人工复检，明确返回 unknown，不伪造结论
  if (v.manual) return "unknown";

  const target = v.verificationTarget ?? op.target;
  const prevRel = findRelated(prevObs, target, v.signalKey, v.issueId);
  const currRel = findRelated(currObs, target, v.signalKey, v.issueId);
  const { prev: prevEnd } = pickEnds(prevRel);
  const { curr: currEnd } = pickEnds(currRel);
  if (!prevEnd || !currEnd) return "unknown";

  const prev = readSignal(prevEnd, v.signalKey, target, v.issueId, v.issueType);
  const curr = readSignal(currEnd, v.signalKey, target, v.issueId, v.issueType);

  switch (v.direction) {
    case "increase":
    case "decrease": {
      const prevNum = comparableNumber(prev);
      const currNum = comparableNumber(curr);
      if (prevNum === null || currNum === null) {
        // 非数值（且不是已知分类值）无法比较 → unknown
        return "unknown";
      }
      if (currNum === prevNum) return "unchanged";
      const improved =
        v.direction === "increase" ? currNum > prevNum : currNum < prevNum;
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
