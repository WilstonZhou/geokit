/**
 * 鲸析 GEOkit — AI 可见性（GEO Visibility）探测矩阵
 *
 * open-seo 的 "AI Visibility" 只覆盖 ChatGPT / Claude / Gemini / Perplexity，
 * 而且走了 DataForSEO 的 llm_mentions 接口。
 *
 * 中文市场的现实是：用户问 DeepSeek、豆包、Kimi、通义、文心、元宝。
 * 这六个模型，open-seo 一个都不覆盖 —— 这就是 GEOkit 的核心战场。
 *
 * 设计原则同 serp.ts：
 *   没有配 API key 就明确返回 UNOBSERVABLE，
 *   绝不用随机数据假装「你的品牌被 AI 提到了」。
 *
 * ─────────────────────────────────────────────────────────────
 * Phase 0 修订：可复现性
 * ─────────────────────────────────────────────────────────────
 * 修订前存在三个硬伤，使 AI 观测无法作为事实使用：
 *   1. temperature 只在 OpenAI 兼容路径设为 0.2，Claude / Gemini 路径
 *      完全不设（即沿用各家服务端默认值）。同一 prompt 在九个模型上
 *      不是同一场实验，横向对比不成立。
 *   2. 原始回答直接丢弃，只存 400 字片段 —— 结论无法复核。
 *   3. prompt 没有版本，LLM 判决与「我们当时究竟问了什么」对不上。
 *
 * 修订后可复现性四件套全部落盘:
 *   requestedModel / servedModel / requestParams / promptVersion
 *   + promptHash / parserVersion / rawResponse / evidenceId
 */

import { createHash } from "node:crypto";

import { fetchWithPolicy, type FetchPurpose, type FetchResult } from "./fetcher";
import type { AiObservationStatus, Confidence } from "./evidence/types";
import { aiSlotSubject, providerSource } from "./evidence/identity";
import { summarizeAiStatuses, visibilityScoreOf, type AiStatusSummary } from "./evidence/ai-status";
import { recordFetch } from "./evidence/store";

const AI_TIMEOUT_MS = 30_000;

export type ProviderId =
  | "deepseek"
  | "doubao"
  | "kimi"
  | "qwen"
  | "wenxin"
  | "yuanbao"
  | "chatgpt"
  | "claude"
  | "gemini";

export interface AiProvider {
  id: ProviderId;
  name: string;
  vendor: string;
  apiModel: string;
  baseUrl: string;
  /** 是否 OpenAI 兼容协议（决定用哪套请求体） */
  openAiCompatible: boolean;
  envKey: string;
  /** 中国市占感知，用于 UI 排序与强调 */
  cnRelevance: "high" | "medium" | "low";
  note: string;
}

export const PROVIDERS: Record<ProviderId, AiProvider> = {
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    vendor: "深度求索",
    apiModel: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/chat/completions",
    openAiCompatible: true,
    envKey: "DEEPSEEK_API_KEY",
    cnRelevance: "high",
    note: "中文长推理能力强，技术类查询的高频入口",
  },
  doubao: {
    id: "doubao",
    name: "豆包",
    vendor: "字节跳动",
    apiModel: "doubao-pro-32k",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    openAiCompatible: true,
    envKey: "DOUBAO_API_KEY",
    cnRelevance: "high",
    note: "抖音生态默认助手，消费决策场景流量大",
  },
  kimi: {
    id: "kimi",
    name: "Kimi",
    vendor: "月之暗面",
    apiModel: "moonshot-v1-32k",
    baseUrl: "https://api.moonshot.cn/v1/chat/completions",
    openAiCompatible: true,
    envKey: "KIMI_API_KEY",
    cnRelevance: "high",
    note: "联网搜索能力强，常直接给出带链接的来源",
  },
  qwen: {
    id: "qwen",
    name: "通义千问",
    vendor: "阿里",
    apiModel: "qwen-plus",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    openAiCompatible: true,
    envKey: "QWEN_API_KEY",
    cnRelevance: "high",
    note: "阿里系（淘宝/钉钉/夸克）广泛接入",
  },
  wenxin: {
    id: "wenxin",
    name: "文心一言",
    vendor: "百度",
    apiModel: "ernie-4.0-8k",
    baseUrl: "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/ernie-4.0-8k",
    openAiCompatible: false,
    envKey: "WENXIN_API_KEY",
    cnRelevance: "high",
    note: "百度搜索「AI 概览」的首选供给方",
  },
  yuanbao: {
    id: "yuanbao",
    name: "腾讯元宝",
    vendor: "腾讯",
    apiModel: "hunyuan-turbo",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1/chat/completions",
    openAiCompatible: true,
    envKey: "YUANBAO_API_KEY",
    cnRelevance: "high",
    note: "微信/QQ 生态入口，社交分发能力强",
  },
  chatgpt: {
    id: "chatgpt",
    name: "ChatGPT",
    vendor: "OpenAI",
    apiModel: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1/chat/completions",
    openAiCompatible: true,
    envKey: "OPENAI_API_KEY",
    cnRelevance: "low",
    note: "出海业务必测，也是 open-seo 唯一覆盖的一类",
  },
  claude: {
    id: "claude",
    name: "Claude",
    vendor: "Anthropic",
    apiModel: "claude-sonnet-4-5",
    baseUrl: "https://api.anthropic.com/v1/messages",
    openAiCompatible: false,
    envKey: "ANTHROPIC_API_KEY",
    cnRelevance: "low",
    note: "专业场景被高频使用，B2B 决策影响大",
  },
  gemini: {
    id: "gemini",
    name: "Gemini",
    vendor: "Google",
    apiModel: "gemini-2.5-pro",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
    openAiCompatible: false,
    envKey: "GEMINI_API_KEY",
    cnRelevance: "low",
    note: "AI Overviews 供给方，影响 Google 自然结果点击",
  },
};

export const PROVIDER_LIST = Object.values(PROVIDERS);
export const CN_PROVIDERS: ProviderId[] = ["deepseek", "doubao", "kimi", "qwen", "wenxin", "yuanbao"];

/**
 * 五态 —— 与 evidence/types 的 AiObservationStatus 同构。
 *
 * 修订前只有 mentioned / not_mentioned / unconfigured / error 四态，
 * 造成两处混淆：
 *   · 「模型拒绝了我」(401/403/429) 和「网络挂了」(timeout) 都叫 error，
 *     但前者是配额/授权问题、后者是环境问题，处置方式完全不同。
 *   · unconfigured 单列，而它本质上就是「无法观测」的一种。
 *
 * 统一为五态后，每一个结论都能回答：观测到了吗？还是压根没观测？
 */
export type ProbeStatus = AiObservationStatus;

export type UnobservableReason =
  | "missing_api_key"
  | "unsupported_protocol"
  | "no_response_body"
  | "unparsable_response";

export interface VisibilityProbe {
  provider: ProviderId;
  providerName: string;
  vendor: string;

  /** 五态结论。**只有 MENTIONED / NOT_MENTIONED 才代表真的观测到了** */
  status: ProbeStatus;

  /** 是否提及品牌 —— 仅在 status 为 MENTIONED / NOT_MENTIONED 时有意义 */
  mentioned: boolean;

  /** 提及时的上下文片段（给 UI 展示用的截断版本） */
  excerpt: string | null;

  /** ★ 原始回答全文 —— 不做任何裁剪，用于事后复核与重放 */
  rawResponse: string | null;

  /** 回复中引用到的域名 */
  citedDomains: string[];

  note?: string;

  /** ── 可复现性元数据 ───────────────────────────────── */

  /** 请求时指定的模型标识 */
  requestedModel: string;
  /** 服务端实际使用的模型标识（常带版本号，可能与请求值不同） */
  servedModel: string | null;
  /** 实际发送出去的采样参数 —— 记录真相，而不是记录意图 */
  requestParams: Record<string, number | string | boolean>;
  /** 使用的 prompt 版本。文本一改就必须 +1 */
  promptVersion: string;
  /** prompt 指纹，防止同名版本下悄悄改了措辞 */
  promptHash: string;
  /** 从原始响应得出结论的解析器版本 */
  parserVersion: string;

  /** 置信度。AI 观测恒为 medium —— 见 buildObservedProbe 的注释 */
  confidence: Confidence;
  /** 必须说明的保留意见 */
  caveat?: string;

  /** 本次观测对应的原始素材 id；Evidence 未开启时为 null */
  evidenceId: string | null;

  /** 无法观测时的具体原因 */
  unobservableReason?: UnobservableReason;

  elapsedMs: number;
}

export interface VisibilityReport {
  brand: string;
  prompt: string;
  promptVersion: string;
  probes: VisibilityProbe[];
  /**
   * 命中率分母是**实际观测到的探针数**，不是配置了 key 的探针数。
   * BLOCKED / ERROR / UNOBSERVABLE 一律不计入 —— 没观测到的东西
   * 不能既不算分子也不算分母地「稀释」比率，那会让数字看起来比真实情况好。
   */
  visibilityScore: number;
  /** 实际完成观测的探针数（= MENTIONED + NOT_MENTIONED） */
  observedCount: number;
  /** 配置了 key 的探针数（含未能成功观测的） */
  configuredCount: number;
  mentionedCount: number;
  /** 因拒绝 / 故障而未能观测的探针数 */
  failedCount: number;
  /** 未配置 key 的探针数 */
  unobservableCount: number;
  /**
   * Phase 1 S1：六态精确计数。唯一口径定义处是 `evidence/ai-status.ts`。
   *
   * 加它的原因：`observedCount` 一个字段扛两种语义（拿到响应 / 可判定），
   * INDETERMINATE 出现后就分叉了。从此命中率分母只看
   * `statusCounts.determinableCount`，旧字段仅作兼容保留。
   */
  statusCounts: AiStatusSummary;
  /** 被多个模型共同引用的域名 —— 这是值得投放的“权威信源池” */
  topCitedDomains: { domain: string; count: number }[];
  parserVersion: string;
  requestParams: Record<string, number | string | boolean>;
  generatedAt: string;
}

/**
 * Prompt 版本。文本内容一旦改动必须 +1，
 * 否则「两个月前的观测」和「今天的观测」无从比较。
 */
export const PROMPT_TEMPLATE_VERSION = "1.0.0";

/** 从原始响应抽取结论的解析器版本 */
export const AI_VISIBILITY_PARSER_VERSION = "ai-visibility@0.1.0";

/**
 * 统一采样参数。
 *
 * 为什么是 temperature = 0：AI 可见性观测要的是「模型在当前知识下会不会
 * 提到这个品牌」，不是要它即兴发挥。多样性在这里是噪声。
 *
 * 为什么不带 top_p：Anthropic 的 Messages API 会在 temperature 与 top_p
 * 同时指定时直接报错。为了九个位点上真正统一，只发一个采样参数。
 */
export const SAMPLING_PROFILE = {
  temperature: 0,
  maxTokens: 1024,
} as const;

const PROMPT_TEMPLATE = (brand: string, topic: string) =>
  `请用中文回答：${topic}。如果你了解相关厂商或服务，请列出你知道的名字并简要说明。`;

function promptHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function buildPrompt(brand: string, topic: string): { text: string; version: string; hash: string } {
  const text = PROMPT_TEMPLATE(brand, topic);
  return { text, version: PROMPT_TEMPLATE_VERSION, hash: promptHash(text) };
}

/**
 * 单次探测。真实调用需要对应厂商的 API key。
 * 没有 key 时不猜测、不编造，如实返回 unconfigured。
 */
export async function probeProvider(
  provider: AiProvider,
  brand: string,
  topic: string,
  apiKey?: string
): Promise<VisibilityProbe> {
  const started = Date.now();
  const prompt = buildPrompt(brand, topic);

  const base: VisibilityProbe = {
    provider: provider.id,
    providerName: provider.name,
    vendor: provider.vendor,
    status: "UNOBSERVABLE",
    mentioned: false,
    excerpt: null,
    rawResponse: null,
    citedDomains: [],
    requestedModel: provider.apiModel,
    servedModel: null,
    requestParams: { ...SAMPLING_PROFILE },
    promptVersion: prompt.version,
    promptHash: prompt.hash,
    parserVersion: AI_VISIBILITY_PARSER_VERSION,
    confidence: "unavailable",
    evidenceId: null,
    elapsedMs: 0,
  };

  // ① 没有 key —— 明确「没能观测」，而不是「观测了但没提及」
  if (!apiKey) {
    return {
      ...base,
      unobservableReason: "missing_api_key",
      note: `未配置 ${provider.envKey}，跳过真实调用。GEOkit 不会用模拟数据冒充分析结果。`,
      elapsedMs: Date.now() - started,
    };
  }

  let res: FetchResult;
  let evidenceId: string | null = null;

  try {
    const { result, evidence } = await recordFetch(
      () => callProvider(provider, apiKey, prompt.text),
      "llm_response"
    );
    res = result;
    evidenceId = evidence?.id ?? null;
  } catch (e) {
    // 协议不支持 —— 不是调用失败，是我们还没有这个观测能力
    return {
      ...base,
      unobservableReason: "unsupported_protocol",
      note: e instanceof Error ? e.message : String(e),
      elapsedMs: Date.now() - started,
    };
  }

  const elapsedMs = Date.now() - started;

  // ② 网络 / 超时：Fetcher 没能拿到任何响应
  if (!res.ok && res.status === 0) {
    return {
      ...base,
      status: "ERROR",
      evidenceId,
      note: `请求失败（${res.error?.kind ?? "unknown"}）：${res.error?.message ?? "未知错误"}`,
      elapsedMs,
    };
  }

  // ③ 服务端明确拒绝：401/403 鉴权、402 欠费、429 限流
  //    这一类具备明确的处置方式，必须与「未知错误」区分
  if (!res.ok && BLOCKED_STATUSES.has(res.status)) {
    return {
      ...base,
      status: "BLOCKED",
      evidenceId,
      note: `模型厂商拒绝请求（HTTP ${res.status}）：${BLOCKED_STATUSES.get(res.status)}`,
      elapsedMs,
    };
  }

  // ④ 其他非 2xx
  if (!res.ok) {
    return {
      ...base,
      status: "ERROR",
      evidenceId,
      note: `调用失败：HTTP ${res.status}`,
      elapsedMs,
    };
  }

  const parsed = parseAnswer(provider, res);

  // ⑤ HTTP 200 但拿不到可解读的回答 —— 依旧是「没观测到」
  if (!parsed.ok) {
    return {
      ...base,
      status: "UNOBSERVABLE",
      evidenceId,
      unobservableReason: parsed.reason,
      servedModel: parsed.servedModel,
      note: parsed.reason === "unparsable_response"
        ? "模型返回的不是可解析的 JSON，无法判定是否提及。"
        : "模型未返回任何文本内容，无法判定是否提及。",
      elapsedMs,
    };
  }

  return buildObservedProbe({
    base,
    text: parsed.text,
    servedModel: parsed.servedModel,
    evidenceId,
    brand,
    elapsedMs,
  });
}

/** 各厂商明确「拒绝」的 HTTP 状态码及其处置含义 */
const BLOCKED_STATUSES = new Map<number, string>([
  [401, "API Key 无效或已过期"],
  [402, "账户余额不足"],
  [403, "无该模型访问权限"],
  [429, "触发限流，需降低采样频率"],
]);

/**
 * 构造已成功观测的探针。
 *
 * 关于 confidence 恒为 medium —— 这是刻意的：
 *   即使 temperature=0，也没有任何厂商承诺逐字节一致；
 *   单次探测本质是 N=1 的采样，不具备统计意义。
 * 若这里标 high，等于宣称「模型此刻没提到你 = 它永远不会提到你」，
 * 那正是本项目最反对的那种伪装。
 */
function buildObservedProbe(args: {
  base: VisibilityProbe;
  text: string;
  servedModel: string | null;
  evidenceId: string | null;
  brand: string;
  elapsedMs: number;
}): VisibilityProbe {
  const { base, text, servedModel, evidenceId, brand, elapsedMs } = args;
  const mentioned = brand.length > 0 && text.toLowerCase().includes(brand.toLowerCase());

  return {
    ...base,
    status: mentioned ? "MENTIONED" : "NOT_MENTIONED",
    mentioned,
    excerpt: text.slice(0, 400),
    rawResponse: text,
    citedDomains: extractDomains(text),
    servedModel,
    evidenceId,
    confidence: "medium",
    caveat: "单次采样（N=1）且厂商不承诺确定性输出，应作为趋势样本而非结论使用。",
    note: mentioned
      ? undefined
      : "未提及该品牌。可考虑增加结构化数据、权威引用与可被摘取的结论段。",
    elapsedMs,
  };
}

/**
 * 调用模型并**原样返回 FetchResult**。
 *
 * 判定 HTTP 状态码、决定是否重试、如何解释结果 —— 全部不在这一层，
 * 由 probeProvider 负责。callProvider 只回答「这次请求发生了什么」。
 */
async function callProvider(p: AiProvider, key: string, prompt: string): Promise<FetchResult> {
  const common = {
    method: "POST" as const,
    timeoutMs: AI_TIMEOUT_MS,
    purpose: "ai-visibility" as FetchPurpose,
    // @deprecated 保留给 Phase 0 读者：ai 通道的 target 是「来源」不是「被观测对象」
    target: p.id,
    // ★ 观测对象 = 槽位（provider + requestedModel），**不是** servedModel。
    // 详见 identity.aiSlotSubject：厂商改路由不该切断历史时间线。
    subject: aiSlotSubject(p.id, p.apiModel),
    source: providerSource(p.id),
    meta: { providerId: p.id, requestedModel: p.apiModel },
    // AI 厂商侧有各自的配额控制；本项目不做额外限速，也不重试 —— 重试
    // 会把一次配额消耗放大成 N 次，且你无法从结果里看出来。
    rateLimit: false as const,
    maxAttempts: 1,
  };

  if (p.openAiCompatible) {
    return fetchWithPolicy({
      ...common,
      url: p.baseUrl,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: p.apiModel,
        messages: [{ role: "user", content: prompt }],
        temperature: SAMPLING_PROFILE.temperature,
        max_tokens: SAMPLING_PROFILE.maxTokens,
      }),
    });
  }

  if (p.id === "claude") {
    return fetchWithPolicy({
      ...common,
      url: p.baseUrl,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      // 注意：Anthropic 在 temperature 与 top_p 同时出现时会报错，故只发前者
      body: JSON.stringify({
        model: p.apiModel,
        max_tokens: SAMPLING_PROFILE.maxTokens,
        temperature: SAMPLING_PROFILE.temperature,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  }

  if (p.id === "gemini") {
    // ⚠️ 历史实现把 key 拼在 URL 的 `?key=` 里。key 会进入 Evidence 的
    // requestUrl 字段，等于把凭据写进磁盘。改走 x-goog-api-key 头：
    // Gemini 官方支持，且请求头脱敏本就在契约覆盖范围内。
    return fetchWithPolicy({
      ...common,
      url: `${p.baseUrl}/${p.apiModel}:generateContent`,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: SAMPLING_PROFILE.temperature,
          maxOutputTokens: SAMPLING_PROFILE.maxTokens,
        },
      }),
    });
  }

  throw new Error(`暂不支持的协议：${p.name}（将在后续版本接入）`);
}

/**
 * 从原始响应抽取回答文本与实际模型版本。
 *
 * 不做任何业务判定 —— 「有没有提到品牌」是 probeProvider 的事。
 * 这里出了问题一律返回 ok:false 交由上层标 UNOBSERVABLE，
 * 而不是抛异常让上层笼统地记为 ERROR。
 */
function parseAnswer(
  p: AiProvider,
  res: FetchResult
): { ok: true; text: string; servedModel: string | null } | { ok: false; reason: UnobservableReason; servedModel: null } {
  if (!res.body) return { ok: false, reason: "no_response_body", servedModel: null };

  let json: unknown;
  try {
    json = JSON.parse(res.body);
  } catch {
    return { ok: false, reason: "unparsable_response", servedModel: null };
  }

  const obj = json as Record<string, unknown>;
  const textOf = (v: unknown): string => (typeof v === "string" ? v : "");
  const modelOf = (): string | null => {
    const m = obj.model ?? obj.modelVersion ?? obj.model_name;
    return typeof m === "string" ? m : null;
  };

  if (p.openAiCompatible) {
    const choices = obj.choices as { message?: { content?: unknown } }[] | undefined;
    return { ok: true, text: textOf(choices?.[0]?.message?.content), servedModel: modelOf() };
  }

  if (p.id === "claude") {
    const content = obj.content as { type?: string; text?: unknown }[] | undefined;
    const first = Array.isArray(content) ? content.find((c) => c?.type === "text") : undefined;
    return { ok: true, text: textOf(first?.text), servedModel: modelOf() };
  }

  if (p.id === "gemini") {
    const candidates = obj.candidates as
      | { content?: { parts?: { text?: unknown }[] } }[]
      | undefined;
    return {
      ok: true,
      text: textOf(candidates?.[0]?.content?.parts?.[0]?.text),
      servedModel: modelOf(),
    };
  }

  return { ok: false, reason: "unparsable_response", servedModel: null };
}

function extractDomains(text: string): string[] {
  const found = new Set<string>();
  const re = /https?:\/\/([a-zA-Z0-9.-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    found.add(m[1].replace(/^www\./, ""));
  }
  const bare = /\b([a-z0-9-]+\.(?:com|cn|net|org|com\.cn|io|dev|ai|so|hk))\b/gi;
  while ((m = bare.exec(text)) !== null) {
    found.add(m[1].toLowerCase());
  }
  return Array.from(found);
}

export async function runVisibilityMatrix(
  brand: string,
  topic: string,
  keys: Partial<Record<ProviderId, string>> = {}
): Promise<VisibilityReport> {
  const probes = await Promise.all(
    PROVIDER_LIST.map((p) => probeProvider(p, brand, topic, keys[p.id]))
  );
  return buildVisibilityReport(brand, topic, probes);
}

/**
 * 从探针聚合成报告。**纯函数** —— 只依赖入参，不做任何 IO。
 *
 * 把它从 runVisibilityMatrix 里拆出来不是为了好看：
 * 聚合口径（尤其是 visibilityScore 的分母）是整个 AI 观测里最容易出错、
 * 也最难被发现的一处。被焊死在 async 函数里时它无法被离线验证 ——
 * 想验证就必须真的去调九个模型。抽成纯函数后，给定一组构造好的探针，
 * 任何口径都能在毫秒级内断言。
 *
 * 与 services/serp.ts 的 summarizeRankings 保持同一契约。
 */
export function buildVisibilityReport(
  brand: string,
  topic: string,
  probes: VisibilityProbe[]
): VisibilityReport {
  // 只有**可判定**的探针才能进分母。
  // 把「配置过 key 但被限流了」也算进分母，会让命中率看起来比真实情况好；
  // 把 INDETERMINATE（模型拒答）也算进去，则会把「厂商不肯说」记成「厂商不知道」。
  const summary = summarizeAiStatuses(probes.map((p) => p.status));
  const mentioned = probes.filter((p) => p.status === "MENTIONED");
  const unobservable = probes.filter((p) => p.status === "UNOBSERVABLE");
  const configuredCount = probes.length - unobservable.length;

  const domainCount = new Map<string, number>();
  for (const p of probes) {
    for (const d of p.citedDomains) {
      domainCount.set(d, (domainCount.get(d) ?? 0) + 1);
    }
  }
  const topCitedDomains = Array.from(domainCount.entries())
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const prompt = buildPrompt(brand, topic);

  return {
    brand,
    prompt: prompt.text,
    promptVersion: prompt.version,
    probes,
    // 分母恒为 determinableCount —— 与 statusCounts 同源，不会再各自漂移
    visibilityScore: visibilityScoreOf(summary),
    /** @deprecated 兼容字段，恒等于 statusCounts.determinableCount */
    observedCount: summary.determinableCount,
    configuredCount,
    mentionedCount: mentioned.length,
    failedCount: summary.blockedCount + summary.errorCount,
    unobservableCount: unobservable.length,
    statusCounts: summary,
    topCitedDomains,
    parserVersion: AI_VISIBILITY_PARSER_VERSION,
    requestParams: { ...SAMPLING_PROFILE },
    generatedAt: new Date().toISOString(),
  };
}
