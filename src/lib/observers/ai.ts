/**
 * AI Observer —— Phase 1 S5。
 *
 * ─────────────────────────────────────────────────────────────
 * 它是「Observation adapter」，不是新的 LLM 调用层
 * ─────────────────────────────────────────────────────────────
 * 本文件**不发请求、不调模型、不解析 HTTP 响应**。它只做一件事：
 * 把 `llm_response` Evidence + 已算好的 `VisibilityProbe`，映射成符合
 * S1 契约的 `ai_mention` Observation。
 *
 * 与 S3 的差异：Site Observer 内部调用 `analyze()`（纯函数、无 IO）。
 * AI 这里连 `includes(brand)` 都不做 —— 判定在 `visibility.ts` 完成，
 * Observer 只消费结论。理由与 S4 同源：Observer 不直连采集层。
 *
 * ─────────────────────────────────────────────────────────────
 * 每个槽位一条，不做跨模型聚合
 * ─────────────────────────────────────────────────────────────
 * 「命中率」是**聚合结论**，口径随「配了哪些模型的 key」变化。
 * 存聚合值会让历史在凭证增减时断裂。因此：存单槽位事实，聚合在读取时算。
 *
 *   subject = ai-slot:<provider>:<requestedModel>   被观测对象
 *   source  = provider:<provider>                   观测来源
 *
 * ★ requestedModel 而非 servedModel —— 见 identity.aiSlotSubject。
 *   厂商改路由不该切断历史时间线；drift 只在 metadata 里记录。
 *
 * ─────────────────────────────────────────────────────────────
 * 六态直接映射，不做翻译
 * ─────────────────────────────────────────────────────────────
 * S1 契约里 `AiObservationStatus` 的六个取值**全部**是 `ObservationStatus`
 * 的成员（S4 的 rank 需要 SerpStatus→ObservationStatus 翻译，是因为
 * `no_results` 在契约里没有对应状态；AI 六态不存在这个问题）。
 *
 * 所以这里就是恒等映射 —— 少一层翻译就少一处口径漂移。
 *
 * ─────────────────────────────────────────────────────────────
 * replaces：S5 完全不碰
 * ─────────────────────────────────────────────────────────────
 *   S5 MUST NOT MODIFY replaces semantics.
 *
 * 不计算、不查询、不设置 `replaces`，不按关键词覆盖历史。
 * 只提供 observerVersion / parserVersion，剩下的由
 * `JsonlStore.saveObservation()` 按 S2 已冻结语义决定。
 *
 * ─────────────────────────────────────────────────────────────
 * 版本纪律（★ 改动必读）
 * ─────────────────────────────────────────────────────────────
 * `AI_MENTION_PARSER_VERSION` 取自 `visibility.ts` 的解析器版本常量。
 * 改动那里判定逻辑（尤其是第六态的拒绝/低信号识别）必须递增它，
 * 否则口径变化会被时间线误读成「模型的态度真的变了」。
 *
 * ⚠️ prompt 变更**不属于**版本三元组：它走 `metadata.promptVersion`。
 * 换言之改 prompt 不会触发 `replaces` 链 —— S6 Diff 必须自己比对它。
 */
import type { Store } from "../store";
import type { Evidence, Observation, ObservationStatus } from "../evidence/types";
import { OBSERVATION_CONTRACT_VERSION, isAiDeterminable } from "../evidence/types";
import { aiSlotSubject, providerSource } from "../evidence/identity";
/**
 * 类型来源。**刻意只做 type-only import** —— visibility.ts 会反向 import
 * 本文件的 `recordAiObservation`，若这里再取值 import，两个模块就形成运行期
 * 循环，而 Phase 0 的常量在循环里会拿到 undefined 而不是报错（TS→CJS 后的
 * 表现），属于最难排查的一类 bug。
 */
import type { VisibilityProbe } from "../visibility";

/** 本 Observer 的版本。改本文件的映射规则必须递增 */
export const AI_OBSERVER_VERSION = "ai-observer@0.1.0";

/**
 * 解析器版本 —— 必须与 `visibility.ts` 的 `AI_VISIBILITY_PARSER_VERSION`
 * 保持一致（`scripts/test-ai-observer.ts` 有断言防漂移）。
 *
 * 为什么不直接 re-export 那个常量：那会把 Observer 与采集层锁成运行期循环，
 * 循环里取常量在某些转译产物下是 undefined 而非报错 —— 宁可多一处常量，
 * 也不要一个静默失效的版本号。
 *
 * 改动那里的判定逻辑（尤其是第六态的拒绝/低信号识别）必须递增它，
 * 否则口径变化会被时间线误读成「模型的态度真的变了」。
 */
export const AI_MENTION_PARSER_VERSION = "ai-visibility@0.1.0";

/**
 * 单条 ai_mention 的结论值。
 *
 * ★ 刻意剥掉 `rawResponse` —— 原始回答全文属于 Evidence（blob 里），
 *   Observation 是结论层，再抄一份正文等于把磁盘开销翻倍，
 *   还会在未来造成「两份口径不一致时该信谁」的问题。
 *   留 `rawResponseChars` 让人知道素材有多大、有没有真的拿到。
 */
export type AiMentionResult = Omit<VisibilityProbe, "rawResponse"> & {
  rawResponseChars: number;
};

/* ------------------------------------------------------------------ */
/* 输入 / 输出                                                          */
/* ------------------------------------------------------------------ */

export interface AiObservationInput {
  /**
   * 本次调用落成的 `llm_response` Evidence —— 结论的唯一合法来源。
   *
   * 为 null 表示「连请求都没发生」（未配 key / 协议不支持）。
   * 此时一律不产 Observation：没有素材可指，产了就是凭空给了个结论。
   */
  evidence: Evidence | null;
  /** 已算好的单槽位探针结果。Observer 不重新判定是否提及 */
  probe: VisibilityProbe;
  /** 品牌词。仅作上下文，不参与 identity（S1 已把 AI 的 subject 定死为槽位） */
  brand: string;
  /** 提问主题。同上，仅作上下文 */
  topic: string;
}

export type ObserveAiResult =
  | { ok: true; observation: Observation<AiMentionResult> }
  | { ok: false; reason: string };

/* ------------------------------------------------------------------ */
/* 纯函数：Evidence + Probe → Observation                               */
/* ------------------------------------------------------------------ */

export function observeAi(input: AiObservationInput): ObserveAiResult {
  const { evidence, probe, brand, topic } = input;

  if (!evidence) {
    return {
      ok: false,
      reason: `没有 llm_response Evidence（${probe.provider}）—— 未发生请求就不产出 AI 结论`,
    };
  }

  // ★ 与 S3/S4 同构的硬门槛：拿到了响应却只留 hash → 将来无法重放，
  //   也就无法证明「模型当时到底说了什么」。
  //
  // status = 0（网络层失败/根本没响应）是唯一例外，与 S3 一致：
  //   那种情况下本来就没有正文可留，而「这次调用没能发生」本身
  //   就是一个必须留痕的事实（厂商拒绝 ≠ 我方没观测，反之亦然）。
  const httpStatus = evidence.status;
  if (httpStatus > 0 && !evidence.response.bodyRetained) {
    return {
      ok: false,
      reason: `Evidence ${evidence.id} 未留存响应体（hash-only），无法产出可重放的 ai_mention 结论`,
    };
  }

  const { rawResponse, ...probeRest } = probe;
  const result: AiMentionResult = {
    ...probeRest,
    rawResponseChars: rawResponse?.length ?? 0,
  };

  const determinable = isAiDeterminable(probe.status);
  const status: ObservationStatus = probe.status;

  const observation: Observation<AiMentionResult> = {
    // id 由 Store 分配 —— S5 不参与 id 生成，也不参与 replaces 判定
    id: "",
    contractVersion: OBSERVATION_CONTRACT_VERSION,
    type: "ai_mention",
    // ★ requestedModel —— 厂商换路由不断时间线；drift 记进 metadata
    subject: aiSlotSubject(probe.provider, probe.requestedModel),
    source: providerSource(probe.provider),
    observedAt: evidence.observedAt,
    // runId 不设：一次独立调用就是一条新历史，不去重
    observerVersion: AI_OBSERVER_VERSION,
    parserVersion: AI_MENTION_PARSER_VERSION,
    // AI 通道没有「解析策略」这种东西 —— 三家引擎的 mu / data-mdurl 属于
    // SERP 专属。不设 strategyVersion，避免与 levels 搅在一起。
    evidenceRefs: [evidence.id],
    status,
    result,
    /**
     * 置信度：**可判定的结论恒为 medium，永远不上 high**。
     *
     * 即便配齐九个模型的 key 也如此 —— 每个槽位仍是 N=1 的采样，
     * 厂商从不承诺逐字节一致。设计稿 §8.5 明确要求保持不变。
     *
     * 不可判定（INDETERMINATE / BLOCKED / ERROR / UNOBSERVABLE）时，
     * 「是否提及」这一结论并不存在 → `unavailable`。
     * 虚报 medium 比不报更糟：那等于把「没答」说成「答了没提」。
     */
    confidence: determinable ? "medium" : "unavailable",
    coverage: {
      expected: 1,
      observed: determinable ? 1 : 0,
      ratio: determinable ? 1 : 0,
      missing: determinable ? undefined : [probe.provider],
    },
    metadata: {
      requestedModel: probe.requestedModel,
      servedModel: probe.servedModel ?? undefined,
      // 厂商改过路由 —— 这是 S6 Diff 判断「两侧是否可比」的关键信号
      modelDrift: probe.servedModel && probe.servedModel !== probe.requestedModel ? true : undefined,
      // ★ prompt 版本单独记：改一次 prompt，历史数据的可比性就断了
      promptVersion: probe.promptVersion,
      sampling: { ...probe.requestParams },
      extra: {
        providerId: probe.provider,
        providerName: probe.providerName,
        brand,
        topic,
        promptHash: probe.promptHash,
        unobservableReason: probe.unobservableReason,
        elapsedMs: probe.elapsedMs,
        httpStatus,
        rawResponseChars: result.rawResponseChars,
      },
    },
    // 探针自己已写明保留意见（如「单次采样 N=1」），优先沿用
    caveat: probe.caveat ?? caveatFor(probe),
    // ★ 不设置 replaces、不查上一条、不按槽位覆盖 —— 全权交给 Store
  };

  return { ok: true, observation };
}

/* ------------------------------------------------------------------ */
/* caveat                                                               */
/* ------------------------------------------------------------------ */

/**
 * 探针没给 caveat 时的兜底说明。
 *
 * 措辞刻意区分两件事：
 *   INDETERMINATE 是「厂商没答」，BLOCKED 是「厂商不让我们看」，
 *   两者都不能被读成「厂商不知道这个品牌」。
 */
function caveatFor(p: VisibilityProbe): string | undefined {
  switch (p.status) {
    case "MENTIONED":
    case "NOT_MENTIONED":
      return "单次采样（N=1）且厂商不承诺确定性输出，应作为趋势样本而非结论使用。";
    case "INDETERMINATE":
      return "模型未给出可判定的回答（拒答或内容过短）—— 这是「没回答」，不是「没提到」，故不计入命中率分母。";
    case "BLOCKED":
      return `厂商拒绝请求：${p.note ?? "无附加信息"} —— 被拒绝不等于不知道该品牌`;
    case "ERROR":
      return `调用失败：${p.note ?? "无附加信息"} —— 这是我方故障，不代表模型侧的任何结论`;
    case "UNOBSERVABLE":
      return `无观测条件（${p.unobservableReason ?? "unknown"}）：${p.note ?? ""} —— 没有调用就没有结论`;
    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* 落库                                                                 */
/* ------------------------------------------------------------------ */

export async function recordAiObservation(
  store: Store,
  input: AiObservationInput
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const r = observeAi(input);
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
