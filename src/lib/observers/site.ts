/**
 * Site Observer —— Phase 1 S3。
 *
 * ─────────────────────────────────────────────────────────────
 * 它是「Observation adapter」，不是新的 SEO/GEO 算法
 * ─────────────────────────────────────────────────────────────
 * 本文件**不解析 HTML、不发请求、不重试、不做采集**。它只做一件事：
 * 把 `page_html` Evidence 交给 `analyze()`，再把返回的 PageAudit
 * 映射成符合 S1 契约的 Observation。
 *
 *   MUST NOT: fetch / HTTP / DNS / retry —— 由输入签名本身杜绝
 *             （输入只有 evidence + body，没有 URL 可抓）
 *
 * `analyze()` 的算法一行未改，11 项检查、评分公式、baseline 全部照旧。
 * S3 改的只是「结论怎么被表达」。
 *
 * ─────────────────────────────────────────────────────────────
 * 只产一种 ObservationKind
 * ─────────────────────────────────────────────────────────────
 *   geo_score
 *
 * SEO 分数（seoScore）作为 `result` 的内部数据存在，**不新增 seo_score
 * kind** —— S1 契约已冻结，不该为了一个内部结果字段扩大枚举。
 *
 * ─────────────────────────────────────────────────────────────
 * replaces：S3 完全不碰
 * ─────────────────────────────────────────────────────────────
 *   S3 MUST NOT MODIFY replaces semantics.
 *
 * 本文件不计算、不查询、不设置 `replaces`，也不按 URL 覆盖历史。
 * 它只提供 observerVersion / parserVersion，剩下的由
 * `JsonlStore.saveObservation()` 按 S2 已冻结语义决定 ——
 * 即便误传，落库时也会被 Store 无条件覆盖。
 *
 * ─────────────────────────────────────────────────────────────
 * 版本纪律（★ 改动必读）
 * ─────────────────────────────────────────────────────────────
 * `AUDIT_PARSER_VERSION` 一旦定死，改动 analyze() 的 11 项检查或
 * result 结构都必须递增它。否则口径变化会被时间线误读成「站点真的变了」。
 */
import { analyze, emptyAudit, type PageAudit } from "../audit";
import type { Store } from "../store";
import type { Evidence, Observation, ObservationStatus } from "../evidence/types";
import { OBSERVATION_CONTRACT_VERSION, confidenceFor } from "../evidence/types";

/** 本 Observer 的版本。改本文件的映射规则必须递增 */
export const SITE_OBSERVER_VERSION = "site-observer@0.1.0";

/**
 * 解析器版本 —— 对应 audit.ts 的检查表与评分口径。
 *
 * 记为正式版：它表达的是 Phase 0 已冻结并进入 baseline 的那一套口径，
 * 不是尚在试运行的版本。
 */
export const AUDIT_PARSER_VERSION = "audit-checks@1.0.0";

/** analyze() 产出的检查项数。用于 confidence / coverage 的分母 */
export const SITE_CHECK_TOTAL = 11;

/* ------------------------------------------------------------------ */
/* 输入 / 输出                                                          */
/* ------------------------------------------------------------------ */

export interface SiteObservationInput {
  /** 已落盘的 `page_html` Evidence —— 结论的唯一合法来源 */
  evidence: Evidence;
  /**
   * Evidence 对应的响应体正文。
   *
   * 刻意与 evidence 分开传：Evidence 0.2.0 没有顶层 body 字段，
   * 正文只以 blob 存在（bodyRef 指向）。由调用方负责把它读出来交给
   * Observer —— Observer 自己不做文件 IO，也不做网络 IO。
   */
  body: string;
  /** 用户输入的 URL（重定向前）。仅作上下文，不参与 identity */
  inputUrl?: string;
}

/**
 * 观测结果。
 *
 * `ok:false` 不是失败告警，而是「**这次不该产 Observation**」：
 * 没有可重放的正文时，产一条结论等于用 hash 冒充观测成功。
 */
export type ObserveSiteResult =
  | { ok: true; observation: Observation<PageAudit> }
  | { ok: false; reason: string };

/* ------------------------------------------------------------------ */
/* 纯函数：Evidence → Observation                                       */
/* ------------------------------------------------------------------ */

export function observeSite(input: SiteObservationInput): ObserveSiteResult {
  const { evidence: ev, body, inputUrl } = input;
  const html = body ?? "";
  const httpStatus = ev.status;
  const finalUrl = ev.response.finalUrl || ev.requestUrl || ev.subject;
  const elapsedMs = ev.provenance?.elapsedMs ?? ev.timing?.elapsedMs ?? 0;

  // ★ 硬门槛：拿到了响应却没留存正文 → 无法重放，不产结论。
  //   hash 只能证明「内容没变」，不能支撑任何一条 GEO 判断。
  if (httpStatus > 0 && !ev.response.bodyRetained) {
    return {
      ok: false,
      reason: `Evidence ${ev.id} 未留存响应体（hash-only），无法产出可重放的 geo_score 结论`,
    };
  }

  // 没有响应（status = 0）时**不跑 analyze()**：
  // 在空内容上跑 11 项检查会得出一个看似合理、实则无据的分数。
  // 抓不到就是抓不到 —— 记 UNOBSERVABLE，分数一律 0。
  const audit: PageAudit =
    httpStatus === 0
      ? emptyAudit(finalUrl, ev.error?.message ?? "未取得响应", elapsedMs)
      : analyze(finalUrl, html, httpStatus, elapsedMs);

  const status = statusFor(ev, html);
  /**
   * 只有「观测成功且真的有内容」才算拿到了可用证据。
   *
   * 500 / 403 这类状态即便带回了错误页正文，也不构成可用的页面观测 ——
   * 若把它算成 11/11，等于告诉下游「这次看得挺全」，那是虚报。
   */
  const usable = status === "OBSERVED" && html.length > 0;

  const observation: Observation<PageAudit> = {
    // id 由 Store 分配 —— S3 不参与 id 生成，也不参与 replaces 判定
    id: "",
    contractVersion: OBSERVATION_CONTRACT_VERSION,
    type: "geo_score",
    subject: ev.subject,
    source: ev.source,
    observedAt: ev.observedAt,
    // runId 不设（OPEN-6）：一次独立 audit 就是一条新历史，不去重
    observerVersion: SITE_OBSERVER_VERSION,
    parserVersion: AUDIT_PARSER_VERSION,
    evidenceRefs: [ev.id],
    status,
    result: audit,
    // 置信度说的是「这个结论可不可信」，不是说页面好不好。
    // 没拿到可用证据时只能是 unavailable —— 虚报 high 比不报更糟。
    confidence: confidenceFor(usable ? SITE_CHECK_TOTAL : 0, SITE_CHECK_TOTAL),
    coverage: {
      expected: SITE_CHECK_TOTAL,
      observed: usable ? SITE_CHECK_TOTAL : 0,
      ratio: usable ? 1 : 0,
    },
    metadata: {
      extra: {
        inputUrl,
        httpStatus,
        bodyHash: ev.contentHash,
      },
    },
    caveat: caveatFor(status, ev, html.length > 0),
    // ★ 不设置 replaces、不查上一条、不按 URL 覆盖 —— 全权交给 Store
  };

  return { ok: true, observation };
}

/* ------------------------------------------------------------------ */
/* 状态映射                                                              */
/* ------------------------------------------------------------------ */

/**
 * HTTP 事实 → ObservationStatus。
 *
 * 刻意区分「目标不存在」与「我方没观测到」：
 *   404/410 是**真实结论**（页面确实不在），记 OBSERVED + caveat，
 *   不能算 ERROR —— 那会把站点的事实记账成我方的故障。
 *   401/403/429 是被拦截，也不等于页面不存在，记 BLOCKED。
 *   status = 0 是压根没拿到响应，那才是 UNOBSERVABLE。
 */
function statusFor(ev: Evidence, html: string): ObservationStatus {
  const s = ev.status;

  if (s === 0) {
    // 我方限制导致的「没能观测」记 ERROR；目标不可达记 UNOBSERVABLE
    const kind = ev.error?.kind;
    return kind === "too_large" || kind === "invalid_url" ? "ERROR" : "UNOBSERVABLE";
  }
  if (s === 401 || s === 403 || s === 429) return "BLOCKED";
  if (s >= 500) return "ERROR";
  if (s === 404 || s === 410) return "OBSERVED";
  if (s >= 200 && s < 400) return html.length > 0 ? "OBSERVED" : "PARTIAL";
  return "ERROR";
}

function caveatFor(status: ObservationStatus, ev: Evidence, hasBody: boolean): string | undefined {
  const s = ev.status;
  switch (status) {
    case "UNOBSERVABLE":
      return `未取得响应（${ev.error?.kind ?? "network"}）：${ev.error?.message ?? "目标不可达"} —— 这是「没能观测」，不是「观测到不合格」`;
    case "ERROR":
      return s === 0
        ? `采集未完成（${ev.error?.kind ?? "unknown"}）：${ev.error?.message ?? ""} —— 结论不可用`
        : `服务端返回 HTTP ${s}，本次观测不可用`;
    case "BLOCKED":
      return `目标拒绝访问（HTTP ${s}）—— 被拦截不等于页面不存在`;
    case "PARTIAL":
      return "响应体为空，11 项检查是在空内容上跑的，分数不可信";
    case "OBSERVED":
      if (!hasBody) return "响应体为空，结论仅基于 HTTP 状态";
      if (s === 404 || s === 410)
        return `目标不存在（HTTP ${s}）—— 这是真实结论，不是我方故障；页面内容分析基于错误页`;
      if (s >= 300 && s < 400) return `未跟随至最终目标（HTTP ${s}）`;
      return undefined;
    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* 落库                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 观测 + 落库的组合动作。
 *
 * 与 `observeSite()` 分开是为了让纯映射部分可以脱离存储单测。
 * 落库失败返回 `ok:false` 并带上原因 —— 由调用方决定怎么记日志，
 * 本函数不吞掉错误，也绝不假装成功。
 */
export async function recordSiteObservation(
  store: Store,
  input: SiteObservationInput
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const r = observeSite(input);
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
