/**
 * 鲸析 GEOkit — MCP Server（JSON-RPC 2.0 / Streamable HTTP）
 *
 * open-seo 把「最好的 MCP」当作头号卖点。GEOkit 的做法更直接：
 * 把中文引擎、中文 AI 模型、GEO 评分、llms.txt 全部开成 MCP tool，
 * 让 Claude Code / WorkBuddy / Cursor 这类 Agent 直接调用。
 *
 * 协议实现遵循 MCP 2025-06-18 的 tools 能力，不含不必要的 SDK 依赖。
 */

import { auditUrl } from "./audit";
import { fetchMultiEngine } from "./serp";
import { CN_ENGINES, GLOBAL_ENGINES, ENGINE_LIST, type EngineId } from "./engines";
import { runVisibilityMatrix, PROVIDER_LIST, type ProviderId } from "./visibility";
import { analyzeRobots, analyzeLlmsTxt, generateLlmsTxtDraft } from "./llms";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export const SERVER_INFO = {
  name: "geokit",
  version: "0.1.0",
  title: "鲸析 GEOkit",
  description:
    "面向中文市场与 AI 搜索时代的 SEO/GEO 工具集：百度/搜狗/360/神马/头条排名采集、页面审计、GEO 评分、中文 AI 可见性探测、llms.txt 生成。",
};

/* ------------------------------------------------------------------ */
/* Tool 定义                                                           */
/* ------------------------------------------------------------------ */

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const TOOLS: ToolDef[] = [
  {
    name: "list_engines",
    title: "列出支持的搜索引擎",
    description:
      "返回 GEOkit 支持的所有搜索引擎及其中国市场参考份额。覆盖百度、搜狗、360、神马、头条、Google、Bing —— 其中五个中文引擎是 DataForSEO 系工具（如 open-seo）完全不支持的。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "check_serp_ranking",
    title: "多引擎关键词排名查询",
    description:
      "在指定搜索引擎中查询某个关键词的自然结果，并返回目标域名的真实排名位置。抓不到时会明确返回 blocked 状态并说明原因，绝不用模拟数据冒充排名。",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "要查询的关键词" },
        engines: {
          type: "array",
          items: { type: "string" },
          description: "引擎 id 列表，如 ['baidu','sogou']。也可用 group 参数代替",
        },
        group: {
          type: "string",
          enum: ["cn", "global", "all"],
          description: "cn=五个中文引擎，global=Google+Bing，all=全部",
        },
        targetDomain: { type: "string", description: "你的域名，用于计算排名位置" },
        pages: { type: "number", description: "每个引擎抓几页，1-3，默认 1" },
      },
      required: ["keyword"],
    },
  },
  {
    name: "audit_page",
    title: "页面审计与 GEO 评分",
    description:
      "抓取并分析单个页面：元信息、标题结构、结构化数据、OG 卡片、图片 alt，并给出两个分数 —— seoScore（传统搜索视角）与 geoScore（AI 引用友好度，含六维拆解与可执行建议）。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "要审计的页面 URL" },
      },
      required: ["url"],
    },
  },
  {
    name: "check_ai_visibility",
    title: "中文 AI 可见性探测",
    description:
      "向 DeepSeek、豆包、Kimi、通义、文心、元宝、ChatGPT、Claude、Gemini 提问，检测指定品牌是否被提及。未配置对应 API key 的模型会返回 unconfigured 而不是假数据。",
    inputSchema: {
      type: "object",
      properties: {
        brand: { type: "string", description: "品牌名/公司名，用于检测是否被提及" },
        topic: { type: "string", description: "提问主题，如「跨境支付平台推荐」" },
      },
      required: ["brand", "topic"],
    },
  },
  {
    name: "analyze_robots",
    title: "分析 robots.txt 的 AI 策略",
    description:
      "检查站点 robots.txt 对 20 个已知 AI/搜索爬虫的放行态度（GPTBot、ClaudeBot、PerplexityBot、Bytespider、Baiduspider 等），输出 AI 开放度评分与整改建议。",
    inputSchema: {
      type: "object",
      properties: { site: { type: "string", description: "站点 URL 或域名" } },
      required: ["site"],
    },
  },
  {
    name: "analyze_llms_txt",
    title: "检测 llms.txt",
    description:
      "检查站点根目录是否存在 llms.txt，并按 llms.txt 规范校验标题、摘要、分区与推荐链接，给出打分与补强建议。",
    inputSchema: {
      type: "object",
      properties: { site: { type: "string", description: "站点 URL 或域名" } },
      required: ["site"],
    },
  },
  {
    name: "generate_llms_txt",
    title: "生成 llms.txt 草稿",
    description:
      "基于站点首页真实解析出的导航链接，起草一份可直接上线的 llms.txt。所有链接来自站点实际内容，不虚构 URL。",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string", description: "站点 URL 或域名" },
        siteName: { type: "string", description: "站点名，缺省时取页面 title" },
        description: { type: "string", description: "一句话定位，缺省时取 meta description" },
        maxLinks: { type: "number", description: "最多推荐多少链接，默认 12" },
      },
      required: ["site"],
    },
  },
  {
    name: "compare_with_openseo",
    title: "与 open-seo 的能力对比",
    description:
      "返回 GEOkit 与 open-seo 在搜索引擎覆盖、AI 模型覆盖、数据依赖、GEO 能力等维度的逐项对比说明。",
    inputSchema: { type: "object", properties: {} },
  },
];

/* ------------------------------------------------------------------ */
/* Tool 实现                                                           */
/* ------------------------------------------------------------------ */

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "list_engines":
      return {
        total: ENGINE_LIST.length,
        cn: CN_ENGINES,
        global: GLOBAL_ENGINES,
        engines: ENGINE_LIST.map((e) => ({
          id: e.id, name: e.name, domain: e.domain,
          market: e.market, estimatedShareCn: `${e.shareCn}%`,
        })),
        note: "百度/搜狗/360/神马/头条这五个中文引擎，open-seo 的代码里出现次数为 0。",
      };

    case "check_serp_ranking": {
      const keyword = String(args.keyword ?? "").trim();
      if (!keyword) throw new Error("缺少 keyword");
      const targetDomain = args.targetDomain ? String(args.targetDomain) : undefined;
      const list = Array.isArray(args.engines) ? (args.engines as EngineId[]) : undefined;
      const group = (args.group as string) ?? (list ? "custom" : "cn");
      let ids: EngineId[];
      if (list && list.length) ids = list.filter((e) => ENGINE_LIST.some((x) => x.id === e));
      else if (group === "global") ids = GLOBAL_ENGINES;
      else if (group === "all") ids = [...CN_ENGINES, ...GLOBAL_ENGINES];
      else ids = CN_ENGINES;

      const results = await fetchMultiEngine(ids, keyword, targetDomain, Number(args.pages) || 1);
      const ok = results.filter((r) => r.status === "ok");
      const ranked = ok.filter((r) => r.targetRank !== null);
      return {
        keyword,
        engineCount: ids.length,
        okEngines: ok.length,
        averageRank: ranked.length
          ? Math.round((ranked.reduce((s, r) => s + (r.targetRank ?? 0), 0) / ranked.length) * 10) / 10
          : null,
        note: "抓不到的引擎会返回 status=blocked 并说明原因，不使用模拟数据。",
        results: results.map((r) => ({
          engine: r.engineName,
          status: r.status,
          targetRank: r.targetRank,
          note: r.note,
          topResults: r.items.slice(0, 10).map((i) => ({
            pos: i.position, title: i.title, url: i.url, domain: i.domain,
          })),
        })),
      };
    }

    case "audit_page": {
      const url = String(args.url ?? "").trim();
      if (!url) throw new Error("缺少 url");
      const a = await auditUrl(url);
      return {
        url: a.url,
        httpStatus: a.httpStatus,
        seoScore: a.seoScore,
        geoScore: a.geoScore,
        geoBreakdown: a.geoBreakdown.map((b) => `${b.label}: ${b.score}/${b.max} — ${b.comment}`),
        title: a.title,
        description: a.metaDescription,
        canonical: a.canonical,
        jsonLdTypes: a.jsonLdTypes,
        wordCount: a.wordCount,
        failedChecks: a.checks.filter((c) => c.level !== "pass").map((c) => `${c.label}(${c.level}): ${c.detail}`),
        recommendations: a.recommendations,
      };
    }

    case "check_ai_visibility": {
      const brand = String(args.brand ?? "").trim();
      const topic = String(args.topic ?? "").trim();
      if (!brand || !topic) throw new Error("缺少 brand 或 topic");
      const keys: Partial<Record<ProviderId, string>> = {};
      for (const p of PROVIDER_LIST) {
        const v = process.env[p.envKey];
        if (v) keys[p.id] = v;
      }
      const r = await runVisibilityMatrix(brand, topic, keys);
      return {
        brand: r.brand,
        visibilityScore: r.visibilityScore,
        configuredCount: r.configuredCount,
        mentionedCount: r.mentionedCount,
        topCitedDomains: r.topCitedDomains,
        note: "open-seo 仅覆盖 ChatGPT/Claude/Gemini/Perplexity；GEOkit 额外覆盖 DeepSeek、豆包、Kimi、通义、文心、元宝。",
        probes: r.probes.map((p) => ({
          provider: p.providerName,
          vendor: p.vendor,
          status: p.status,
          mentioned: p.mentioned,
          excerpt: p.excerpt,
          note: p.note,
        })),
      };
    }

    case "analyze_robots": {
      const site = String(args.site ?? "").trim();
      if (!site) throw new Error("缺少 site");
      const r = await analyzeRobots(site);
      return {
        url: r.url,
        exists: r.exists,
        aiOpennessScore: r.aiOpennessScore,
        summary: r.summary,
        sitemaps: r.sitemaps,
        recommendations: r.recommendations,
        policies: r.policies.map((p) => ({
          crawler: p.crawler.name,
          vendor: p.crawler.vendor,
          purpose: p.crawler.purpose,
          policy: p.policy,
          implication: p.implication,
        })),
      };
    }

    case "analyze_llms_txt": {
      const site = String(args.site ?? "").trim();
      if (!site) throw new Error("缺少 site");
      const r = await analyzeLlmsTxt(site);
      return {
        url: r.url, exists: r.exists, score: r.score,
        hasTitle: r.hasTitle, title: r.title,
        sections: r.sections, linkCount: r.linkCount,
        issues: r.issues, recommendations: r.recommendations,
      };
    }

    case "generate_llms_txt": {
      const site = String(args.site ?? "").trim();
      if (!site) throw new Error("缺少 site");
      const draft = await generateLlmsTxtDraft(site, {
        siteName: args.siteName ? String(args.siteName) : undefined,
        description: args.description ? String(args.description) : undefined,
        maxLinks: args.maxLinks ? Number(args.maxLinks) : 12,
      });
      return {
        content: draft.content,
        sourceCount: draft.sources.length,
        sources: draft.sources,
        warnings: draft.warnings,
        hint: "把 content 保存为 /llms.txt 并部署到站点根目录即可。",
      };
    }

    case "compare_with_openseo":
      return {
        engines: {
          openSeo: ["Google（973 处引用）", "Bing（7 处引用）"],
          geokit: ["百度", "搜狗", "360", "神马", "头条", "Google", "Bing"],
          verdict: "open-seo 代码中百度提及 0 次、搜狗 0 次 —— 对中文市场不可用。",
        },
        aiVisibility: {
          openSeo: ["ChatGPT", "Claude", "Gemini", "Perplexity"],
          geokit: ["DeepSeek", "豆包", "Kimi", "通义", "文心", "元宝", "ChatGPT", "Claude", "Gemini"],
          verdict: "中文用户实际在用的六个 AI 助手，open-seo 一个都不覆盖。",
        },
        dataDependency: {
          openSeo: "几乎所有关键词/外链/AI 可见性数据都走 DataForSEO 付费 API",
          geokit: "核心能力零付费依赖，自研采集与评分引擎",
        },
        geoScoring: {
          openSeo: "无 GEO 评分 —— 只看传统搜索视角",
          geokit: "六维 GEO 评分（可引用性/结构化/实体清晰度/可抓取性/事实密度/可读性时效）",
        },
        llmsTxt: {
          openSeo: "仅出现在一份 PM 产品研究文档中，无代码实现",
          geokit: "完整的检测、校验与自动生成",
        },
      };

    default:
      throw new Error(`未知工具：${name}`);
  }
}

/* ------------------------------------------------------------------ */
/* JSON-RPC 处理                                                       */
/* ------------------------------------------------------------------ */

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

function okResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function errResult(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

/** 处理单条 JSON-RPC 消息。返回 null 表示这是通知（无需响应）。 */
export async function handleJsonRpc(msg: JsonRpcRequest) {
  const id = msg.id ?? null;
  const { method, params } = msg;

  switch (method) {
    case "initialize":
      return okResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "GEOkit 提供中文搜索引擎排名、页面审计与 GEO 评分、中文 AI 可见性探测、llms.txt 生成四类能力。" +
          "先调用 list_engines 了解可用引擎，再按需调用具体工具。",
      });

    case "notifications/initialized":
      return null;

    case "tools/list":
      return okResult(id, { tools: TOOLS });

    case "tools/call": {
      const name = String(params?.name ?? "");
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const data = await callTool(name, args);
        return okResult(id, {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          structuredContent: data as Record<string, unknown>,
          isError: false,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return okResult(id, {
          content: [{ type: "text", text: `工具执行失败：${message}` }],
          isError: true,
        });
      }
    }

    case "ping":
      return okResult(id, {});

    default:
      return errResult(id, -32601, `Method not found: ${method}`);
  }
}

/** 处理一行或多行 JSON-RPC（支持 batch） */
export async function handleJsonRpcBatch(raw: string): Promise<unknown | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return errResult(null, -32700, "Parse error");
  }

  if (Array.isArray(parsed)) {
    const out = [];
    for (const item of parsed) {
      const r = await handleJsonRpc(item as JsonRpcRequest);
      if (r) out.push(r);
    }
    return out.length ? out : null;
  }
  return handleJsonRpc(parsed as JsonRpcRequest);
}
