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
 *   没有配 API key 就明确返回 status: "unconfigured"，
 *   绝不用随机数据假装「你的品牌被 AI 提到了」。
 */

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

export type ProbeStatus = "mentioned" | "not_mentioned" | "unconfigured" | "error";

export interface VisibilityProbe {
  provider: ProviderId;
  providerName: string;
  vendor: string;
  status: ProbeStatus;
  /** 是否提及品牌 —— 仅在配置且有结果时才有意义 */
  mentioned: boolean;
  /** 提及时的上下文片段 */
  excerpt: string | null;
  /** 回复中引用到的域名 */
  citedDomains: string[];
  note?: string;
  elapsedMs: number;
}

export interface VisibilityReport {
  brand: string;
  prompt: string;
  probes: VisibilityProbe[];
  /** 命中率：仅在已配置的探针中统计 */
  visibilityScore: number;
  configuredCount: number;
  mentionedCount: number;
  /** 被多个模型共同引用的域名 —— 这是值得投放的“权威信源池” */
  topCitedDomains: { domain: string; count: number }[];
  generatedAt: string;
}

const PROMPT_TEMPLATE = (brand: string, topic: string) =>
  `请用中文回答：${topic}。如果你了解相关厂商或服务，请列出你知道的名字并简要说明。`;

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
  const base: VisibilityProbe = {
    provider: provider.id,
    providerName: provider.name,
    vendor: provider.vendor,
    status: "unconfigured",
    mentioned: false,
    excerpt: null,
    citedDomains: [],
    note: `未配置 ${provider.envKey}，跳过真实调用。GEOkit 不会用模拟数据冒充分析结果。`,
    elapsedMs: 0,
  };

  if (!apiKey) return { ...base, elapsedMs: Date.now() - started };

  try {
    const answer = await callProvider(provider, apiKey, PROMPT_TEMPLATE(brand, topic));
    const mentioned = answer.toLowerCase().includes(brand.toLowerCase());
    return {
      ...base,
      status: mentioned ? "mentioned" : "not_mentioned",
      mentioned,
      excerpt: answer.slice(0, 400),
      citedDomains: extractDomains(answer),
      note: mentioned
        ? undefined
        : "未提及该品牌。可考虑增加结构化数据、权威引用与可被摘取的结论段。",
      elapsedMs: Date.now() - started,
    };
  } catch (e) {
    return {
      ...base,
      status: "error",
      note: `调用失败：${e instanceof Error ? e.message : String(e)}`,
      elapsedMs: Date.now() - started,
    };
  }
}

async function callProvider(p: AiProvider, key: string, prompt: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    if (p.openAiCompatible) {
      const res = await fetch(p.baseUrl, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: p.apiModel,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return json.choices?.[0]?.message?.content ?? "";
    }

    if (p.id === "claude") {
      const res = await fetch(p.baseUrl, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: p.apiModel,
          max_tokens: 1024,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { content?: { text?: string }[] };
      return json.content?.[0]?.text ?? "";
    }

    if (p.id === "gemini") {
      const url = `${p.baseUrl}/${p.apiModel}:generateContent?key=${key}`;
      const res = await fetch(url, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      return json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    }

    throw new Error(`暂不支持的协议：${p.name}（将在后续版本接入）`);
  } finally {
    clearTimeout(timer);
  }
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

  const configured = probes.filter((p) => p.status !== "unconfigured");
  const mentioned = probes.filter((p) => p.mentioned);

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

  return {
    brand,
    prompt: PROMPT_TEMPLATE(brand, topic),
    probes,
    visibilityScore:
      configured.length === 0
        ? 0
        : Math.round((mentioned.length / configured.length) * 100),
    configuredCount: configured.length,
    mentionedCount: mentioned.length,
    topCitedDomains,
    generatedAt: new Date().toISOString(),
  };
}
