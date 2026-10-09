/**
 * 鲸析 GEOkit — MCP Server（JSON-RPC 2.0 / Streamable HTTP）
 *
 * open-seo 把「最好的 MCP」当作头号卖点。GEOkit 的做法更直接：
 * 把中文引擎、中文 AI 模型、GEO 评分、llms.txt 全部开成 MCP tool，
 * 让 Claude Code / WorkBuddy / Cursor 这类 Agent 直接调用。
 *
 * 协议实现遵循 MCP 2025-06-18 的 tools 能力，不含不必要的 SDK 依赖。
 */

import { z } from "zod";
import { auditUrl } from "./audit";
import { CN_ENGINES, GLOBAL_ENGINES, ENGINE_LIST, type EngineId } from "./engines";
import { analyzeRobots, analyzeLlmsTxt, generateLlmsTxtDraft } from "./llms";
import { crawlSite, analyzeSiteIssues } from "./crawler";
import { getSearchPerformance, analyzeSearchPerformance, type GscDimension } from "./gsc";
/**
 * Phase 0：工具实现不再直接调用采集层，一律走 services/*。
 *
 * 原因很实际：同一份 `check_serp_ranking`，人和 Agent 拿到的口径必须一致。
 * 在 service 层之前，「选哪些引擎」「平均位次怎么算」「key 从哪来」
 * 在 HTTP route 与 MCP handler 里各写了一份 —— 今天结果一致纯属巧合，
 * 一旦某侧修改，Agent 的决策依据就会静默漂移，而没有任何测试会发现。
 */
import { searchRankings } from "./services/serp";
import { probeVisibility, samplingProfile, batchProbeVisibility } from "./services/visibility";
import { analyzeCitations, diffCitationRecords } from "./visibility/aggregate";
import { checkUrl, checkHtml, autoFixHtml } from "./services/diagnosis";
import { listObservationHistory, latestObservationDiff } from "./services/observations";
import { diffObservations } from "./diff";
import type { Observation, CitationRecord } from "./evidence/types";
import {
  generateOpportunities,
  verifyOpportunity,
  countByType,
  type Opportunity,
  type OpportunityInput,
  type OpportunityResolution,
} from "./opportunity";
import {
  analyzeQuery,
  clusterQueries,
  type QueryAnalysisInput,
  type QueryClusterInput,
  type ClusterOptions,
} from "./query";
import {
  analyzeCompetitors,
  type CompetitorInput,
} from "./competitor";
import {
  analyzeSchema,
  analyzeSchemaUrl,
  buildSchemaDraft,
} from "./schema";
import { batchQueryCruxRaw, analyzeCruxBatch, recordCruxObservation } from "./crux";
import { analyzeHreflang, type PageInput } from "./hreflang";
import { createStore } from "./store";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export const SERVER_INFO = {
  name: "geokit",
  version: "0.1.0",
  title: "鲸析 GEOkit",
  description:
    "面向中文市场与 AI 搜索时代的 SEO/GEO 工具集：百度/搜狗/360/神马/头条排名采集、页面审计、GEO 评分、中文 AI 可见性探测、全量诊断与安全自动修复、时序比对与观测历史查询、llms.txt 生成。",
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
      "在指定搜索引擎中查询某个关键词的自然结果，并返回目标域名的真实排名位置。" +
      "抓不到时会明确返回 blocked 状态并说明原因，绝不用模拟数据冒充排名。" +
      "引擎选择、翻页上限与平均位次口径与 HTTP API /api/serp 完全一致（同一份 service 实现）。",
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
        geo_version: {
          type: "string",
          enum: ["1.0.0", "2.0.0"],
          description:
            "GEO 评估模型版本：1.0.0 为经典基线，2.0.0 采用 2026 AI Search / RAG Grounding 启发式标准。默认 1.0.0",
        },
      },
      required: ["url"],
    },
  },
  { name: "analyze_ai_citations",
      title: "AI 引用与竞品情报分析",
      description:
        "批量查询多个 Query，获取并聚合各大 AI 模型的引用来源排行、竞品提及频次、引用缺口。",
      inputSchema: {
        type: "object",
        properties: {
          queries: {
            type: "array",
            items: { type: "string" },
            description: "需要探测的查询词列表，例如 ['地热能是什么', '哪家地热公司最好']"
          },
          brand: { type: "string", description: "品牌词，用于识别提及" },
          domain: { type: "string", description: "用户站点域名，用于发现引用缺口" },
          competitors: {
            type: "array",
            items: { type: "string" },
            description: "需要监控的竞品品牌或域名列表"
          },
          concurrency: {
            type: "number",
            description: "并发上限（可选，默认 2，范围 1–5）。保守默认值避免对厂商造成压力"
          }
        },
        required: ["queries", "brand", "domain"]
      }
    },
    {
    name: "check_ai_visibility",
    title: "中文 AI 可见性探测",
    description:
      "向 DeepSeek、豆包、Kimi、通义、文心、元宝、ChatGPT、Claude、Gemini 提问，检测指定品牌是否被提及。" +
      "每个探针返回五种状态之一：MENTIONED / NOT_MENTIONED / BLOCKED / ERROR / UNOBSERVABLE —— " +
      "未配置 API key 的模型返回 UNOBSERVABLE，被拒绝或故障的返回 BLOCKED/ERROR，一律不用假数据填充。" +
      "visibilityScore 的分母只算真正观测成功的探针。",
    inputSchema: {
      type: "object",
      properties: {
        brand: { type: "string", description: "品牌名/公司名，用于检测是否被提及" },
        topic: { type: "string", description: "提问主题，如「跨境支付平台推荐」" },
        competitors: {
          type: "array",
          items: { type: "string" },
          description: "竞品品牌词列表（可选）。传入后每个探针的引用记录会标注答案中提及了哪些竞品",
        },
      },
      required: ["brand", "topic"],
    },
  },
  {
    name: "crawl_site",
    title: "站点爬取与站点图",
    description:
      "BFS 爬取指定站点的同域页面：每页产出审计摘要（title / h1 / canonical / geoScore / noindex 等）与站内出链，" +
      "构建站点图后标注孤岛页。受 maxPages / maxDepth / 总耗时上限限制时返回已爬到的部分结果并标 truncated=true。" +
      "403 页面如实记录为 blocked，4xx/5xx 当数据保留不丢弃。",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string", description: "站点 URL 或域名，如 https://example.com 或 example.com" },
        maxPages: { type: "number", description: "最大页面数（默认 100）" },
        maxDepth: { type: "number", description: "最大点击深度（默认 3，起点为 0）" },
        concurrency: { type: "number", description: "并发数（默认 2，建议保守值避免压目标站点）" },
      },
      required: ["site"],
    },
  },
  {
    name: "get_search_performance",
    title: "Google Search Console 搜索表现",
    description:
      "拉取 Search Console Search Analytics（query/page/country/device 维度的 clicks、impressions、ctr、position），自动分页。" +
      "需要自备凭证（GOOGLE_OAUTH_ACCESS_TOKEN 或 GOOGLE_SERVICE_ACCOUNT_JSON / GOOGLE_APPLICATION_CREDENTIALS）。" +
      "未配置返回 status=unavailable 并说明配置方式；401/403/429 分别返回 blocked 并写明原因，不编造任何数据。",
    inputSchema: {
      type: "object",
      properties: {
        siteUrl: { type: "string", description: "Search Console 资源，如 sc-domain:example.com 或 https://example.com/" },
        startDate: { type: "string", description: "起始日期 YYYY-MM-DD，缺省为 28 天前" },
        endDate: { type: "string", description: "结束日期 YYYY-MM-DD，缺省为今天" },
        dimensions: {
          type: "array",
          items: { type: "string", enum: ["query", "page", "date", "country", "device"] },
          description: "维度，缺省 [\"query\"]",
        },
        rowLimit: { type: "number", description: "每页行数（默认 1000，硬上限 25000）" },
      },
      required: ["siteUrl"],
    },
  },
  {
    name: "analyze_search_opportunities",
    title: "GSC 搜索机会分析",
    description:
      "基于 Search Analytics 识别三类机会：高曝光低 CTR、排名 4–20 位的机会词、内容缺口（需传 crawledUrls 交叉）。" +
      "每个机会带触发阈值证据与一句话建议。凭证要求与状态语义同 get_search_performance。",
    inputSchema: {
      type: "object",
      properties: {
        siteUrl: { type: "string", description: "Search Console 资源" },
        startDate: { type: "string", description: "YYYY-MM-DD，缺省 28 天前" },
        endDate: { type: "string", description: "YYYY-MM-DD，缺省今天" },
        dimensions: {
          type: "array",
          items: { type: "string", enum: ["query", "page", "date", "country", "device"] },
          description: "维度，缺省 [\"query\"]；做内容缺口建议含 \"page\"",
        },
        crawledUrls: {
          type: "array",
          items: { type: "string" },
          description: "可选：本站已爬取的 URL 列表，用于识别有曝光但站内缺失的页面",
        },
      },
      required: ["siteUrl"],
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
  {
    name: "diagnose_page",
    title: "页面全量诊断与体检",
    description:
      "对指定页面进行全量诊断（包含页面内容审计、robots.txt 爬虫策略、llms.txt 抓取协议）。" +
      "输出结构化的 blocker、major、minor 严重度计数，以及带稳定 issueId、严重度和 suggestedFix 修复建议的诊断条目。" +
      "支持传入 url 在线抓取，或传入 html 离线分析。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "要诊断的页面 URL（在线模式）" },
        html: { type: "string", description: "待诊断的 HTML 源码（离线模式，不发网络请求）" },
        skipProtocol: { type: "boolean", description: "是否跳过 robots / llms.txt 协议层检查，默认 false" },
        geo_version: {
          type: "string",
          enum: ["1.0.0", "2.0.0"],
          description:
            "GEO 评估模型版本：1.0.0 为经典基线，2.0.0 采用 2026 AI Search / RAG Grounding 启发式标准。默认 1.0.0",
        },
      },
    },
  },
  {
    name: "apply_fixes",
    title: "安全自动修复 HTML 缺陷",
    description:
      "基于诊断引擎对 HTML 源码执行安全、幂等的高置信度自动修补。" +
      "支持自动补齐缺失的 canonical 规范链接、viewport 移动端适配、lang 语言声明、alt 装饰图空属性、OG 社交分享骨架。" +
      "已有标签绝不覆盖，无法安全定位时绝不盲目修改。",
    inputSchema: {
      type: "object",
      properties: {
        html: { type: "string", description: "待修复的 HTML 源码字符串" },
        url: { type: "string", description: "页面所属 URL，用于填充 canonical 与 og:url" },
        fixIds: {
          type: "array",
          items: { type: "string" },
          description: "指定应用的修复规则 id 列表，如 ['canonical', 'viewport']。缺省时自动应用全部匹配项",
        },
      },
      required: ["html"],
    },
  },
  {
    name: "diff_observations",
    title: "观测时序对比与退化判定",
    description:
      "对比两次观测结论，判断是提升、退化、中性还是无法比较。" +
      "可基于 Store 历史时间线（提供 subject 和 type），或直接传入前后两份 Observation JSON 对象（prev 与 curr）。",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Target" },
          subject: { type: "string", description: "被观测对象标识（如 'site:https://example.com' 或 'ai-slot:deepseek:deepseek-chat'）" },
        type: { type: "string", description: "观测类型：'rank' | 'geo_score' | 'ai_mention' | 'robots_policy' | 'llms_txt'" },
        source: { type: "string", description: "观测来源（如 'search-engine:baidu' 或 'provider:deepseek'）" },
        to: { type: "string", description: "时间上限（ISO 格式字符串）" },
        prev: { type: "object", description: "前一次观测的 JSON 对象（文件/内联模式）" },
        curr: { type: "object", description: "本次观测的 JSON 对象（文件/内联模式）" },
      },
    },
  },
  {
    name: "list_observations",
    title: "查询历史观测记录",
    description:
      "查询数据仓库（Store）中留存的时序观测数据（Observation）。" +
      "支持按 subject、source、type、status、时间范围、runId 过滤，支持 latest 仅取最新一条模式。",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "被观测对象（如 'site:https://example.com'）" },
        source: { type: "string", description: "观测来源（如 'search-engine:baidu'）" },
        type: {
          type: "string",
          enum: ["rank", "geo_score", "ai_mention", "robots_policy", "llms_txt", "serp", "audit", "ai_citation", "crawl", "gsc", "robots", "llms", "performance"],
          description: "观测类型",
        },
        status: { type: "string", description: "观测状态（如 'OBSERVED', 'MENTIONED', 'BLOCKED'）" },
        runId: { type: "string", description: "批次 id" },
        from: { type: "string", description: "起始时间（ISO）" },
        to: { type: "string", description: "截止时间（ISO）" },
        order: { type: "string", enum: ["asc", "desc"], description: "排序，默认 desc" },
        limit: { type: "number", description: "返回条数限制（1..500，默认 50）" },
        latest: { type: "boolean", description: "是否每个 identity 只留最新一条（当前状态视图）" },
      },
    },
  },
  {
    name: "list_opportunities",
    title: "机会引擎：列出可执行的下一步建议",
    description:
      "把各 T（T2 引用聚合 / T4 站点问题 / T5 GSC / 协议层 / 页面审计）的发现统一翻译成 Opportunity 列表。" +
      "每个机会带 impact/effort、可追溯 evidence、清单式建议与复检信号；同 target 上多条建议自动合并。" +
      "输入字段全部可选 —— 缺哪段就跳过对应机会类型，绝不报错（例如无 GSC 数据时不会输出 search-opportunity）。" +
      "不调用任何大模型，建议全部来自规则与模板。",
    inputSchema: {
      type: "object",
      properties: {
        siteAnalysis: {
          type: "object",
          description: "T4 站点级问题聚合（analyzeSiteIssues 的返回值）",
        },
        citationAggregation: {
          type: "object",
          description: "T2 引用聚合（analyzeCitations 的返回值）",
        },
        userDomain: { type: "string", description: "用户域名，citation-gap 与 target 计算用" },
        robotsAnalysis: {
          type: "object",
          description: "robots.txt 的 AI 策略分析结果（analyzeRobots 的返回值）",
        },
        llmsTxtAnalysis: {
          type: "object",
          description: "llms.txt 校验结果（analyzeLlmsTxt 的返回值）",
        },
        gscOpportunities: {
          type: "array",
          description: "T5 GSC 机会（analyzeSearchOpportunities 返回的 opportunities 字段）",
        },
        pageAudits: {
          type: "array",
          description: "页面审计结果（auditUrl 的返回值列表），用于 missing-entity",
        },
      },
    },
  },
  {
    name: "verify_opportunity",
    title: "机会引擎：基于两次观测判断机会是否已解决",
    description:
      "对一个机会执行复检判定：基于 verification.signalKey 与 direction，比对前后两次相关观测。" +
      "返回 resolved / unchanged / worsened / unknown。找不到可比观测时返回 unknown，绝不编造判定。",
    inputSchema: {
      type: "object",
      properties: {
        opportunity: {
          type: "object",
          description: "待验证的机会（list_opportunities 返回的 Opportunity 之一）",
        },
        prevObservations: {
          type: "array",
          description: "上一次相关观测列表（按 subject 包含 opportunity.target 匹配）",
        },
        currObservations: {
          type: "array",
          description: "本次相关观测列表",
        },
      },
      required: ["opportunity", "prevObservations", "currObservations"],
    },
  },
  {
    name: "analyze_query",
    title: "Query Intelligence：单 query 完整分析",
    description:
      "对单个 query 汇总已有观测：意图分类（5 类，规则驱动）、相关问题（从 SERP 标题与 AI 答案提取，不编造）、" +
      "竞品识别（SERP 与 AI 引用域名去重）、内容缺口（对照 T3 用户站点爬取）、GSC 表现（可选）。" +
      "缺数据源时对应段落标 unavailable，不报错。不调用任何大模型，结论全部来自规则。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "查询文本" },
        serpResults: {
          type: "array",
          description: "多引擎 SERP 响应（fetchSerp 返回的 SerpResponse[]）",
        },
        aiCitations: {
          type: "array",
          description: "T2 AI 引用记录（CitationRecord[]）",
        },
        gscOpportunities: {
          type: "array",
          description: "T5 GSC 机会（可选）",
        },
        userCrawl: {
          type: "object",
          description: "T3 用户站点爬取结果，内容缺口分析用",
        },
        userDomain: { type: "string", description: "用户域名，用于排除自家结果" },
      },
      required: ["query"],
    },
  },
  {
    name: "cluster_queries",
    title: "Query Intelligence：基于共享 SERP URL 重合度聚类",
    description:
      "对一批 query，按 SERP 结果 URL 重合度聚类。两个 query 的 URL 集合 Jaccard ≥ 阈值（默认 0.3）" +
      "或共享 URL 数 ≥ minSharedUrls（默认 2）时归为同簇。纯函数 + 确定性算法，固定输入固定输出。",
    inputSchema: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          description: "待聚类的 query 列表，每项含 query 与 serpResults",
          items: {
            type: "object",
            properties: {
              query: { type: "string" },
              serpResults: { type: "array" },
            },
          },
        },
        jaccardThreshold: { type: "number", description: "Jaccard 阈值，默认 0.3" },
        minSharedUrls: { type: "number", description: "共享 URL 数下限，默认 2" },
      },
      required: ["queries"],
    },
  },
  {
    name: "compare_competitors",
    title: "竞品情报对比",
    description:
      "五维竞品对比：SERP 位次、AI 提及/引用、GEO 评分、AI 抓取协议、结构化数据。" +
      "抓取失败按 blocked 标注不留空；缺数据源的维度标 unavailable 不报错。" +
      "最多 5 个竞品。差距清单可直接转入 Opportunity Engine。",
    inputSchema: {
      type: "object",
      properties: {
        userDomain: { type: "string", description: "你的域名" },
        competitors: {
          type: "array",
          items: { type: "string" },
          description: "竞品域名列表（1-5 个）",
        },
        queries: {
          type: "array",
          items: { type: "string" },
          description: "query 列表（SERP/AI 维度用）",
        },
        serpResults: { type: "array", description: "预收集的 SERP 响应（可选）" },
        aiCitations: { type: "array", description: "预收集的 AI 引用记录（可选）" },
        userPageAudits: { type: "array", description: "用户页面审计结果（可选）" },
        competitorPageAudits: { type: "array", description: "竞品页面审计结果（可选）" },
        competitorPageUrls: { type: "array", description: "竞品关键页面 URL（可选，需 fetchProtocol=true）" },
        userRobots: { type: "object", description: "用户 robots 分析结果（可选）" },
        userLlmsTxt: { type: "object", description: "用户 llms.txt 分析结果（可选）" },
        competitorRobots: { type: "array", description: "竞品 robots 分析结果（可选）" },
        competitorLlmsTxt: { type: "array", description: "竞品 llms.txt 分析结果（可选）" },
        fetchProtocol: { type: "boolean", description: "是否允许现场抓取（geo/protocol 维度无预收集数据时）" },
        userCrawl: { type: "object", description: "用户站点爬取结果（可选，schema/geo 维度可用）" },
        competitorCrawls: { type: "array", description: "竞品站点爬取结果（可选）" },
      },
      required: ["userDomain", "competitors"],
    },
  },
  {
    name: "analyze_schema",
    title: "Schema 与实体诊断",
    description:
      "规则驱动检测页面类型（文章/产品/FAQ/HowTo/本地商家/组织/官网）并给出判定依据；按 Schema.org 检查必填/推荐字段的缺失与不完整；" +
      "校验 JSON-LD 与页面可见内容的一致性（headline↔H1、发布日期、作者署名）；检查作者/组织/sameAs/联系方式/发布与更新时间等实体标注。" +
      "只诊断、不修改站点。传 url 现场抓取，或直接传 html 离线分析。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "要诊断的页面 URL（未传 html 时必填）" },
        html: { type: "string", description: "页面 HTML 原文，离线分析时传入（优先级高于 url）" },
      },
    },
  },
  {
    name: "generate_schema_draft",
    title: "生成 JSON-LD 草稿",
    description:
      "按检测到的页面类型生成可复制的 JSON-LD 草稿：只填页面真实存在的信息（标题、日期、作者、价格+币种、问答对、步骤、联系方式等）；" +
      "拿不到的字段不进入 JSON 正文，在 manualFields 中逐条标注需人工补充；绝不编造作者、评分、价格。" +
      "页面已有的同类型 JSON-LD 原样保留、只补缺不覆盖。传 url 或 html。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "目标页面 URL（未传 html 时必填）" },
        html: { type: "string", description: "页面 HTML 原文，离线分析时传入（优先级高于 url）" },
      },
    },
  },
  {
    name: "check_web_vitals",
    title: "Web Vitals 性能观测",
    description:
      "通过 Chrome UX Report (CrUX) API 查询真实用户性能数据（LCP/INP/CLS/FCP/TTFB）。" +
      "需要配置 CRUX_API_KEY 环境变量；无 key / 未启用 API → unavailable，不返回估算值。" +
      "支持批量 urls[]（串行 + 间隔，遵守官方 150 QPM 限制，遇 429 截断）。" +
      "差指标（poor / needs-improvement）自动生成 poor-web-vitals 机会进入 Opportunity Engine。" +
      "数据为 28 天滚动窗口的真实用户采样，非实验室单次测量。",
    inputSchema: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" }, description: "页面 URL 列表（与 origins 二选一）" },
        origins: { type: "array", items: { type: "string" }, description: "源站 origin 列表（与 urls 二选一）" },
        formFactor: {
          type: "string",
          enum: ["DESKTOP", "PHONE", "TABLET"],
          description: "设备类型（可选，缺省聚合全部）",
        },
        concurrency: { type: "number", description: "并发上限（默认 2，遵守官方 150 QPM 限制）" },
        minIntervalMs: { type: "number", description: "同 host 最小请求间隔 ms（默认 500）" },
      },
    },
  },
  {
    name: "check_hreflang",
    title: "hreflang 国际化检查",
    description:
      "检查多语言站点的 hreflang 配置：三种来源（HTML link / HTTP header / sitemap）统一解析；" +
      "六类检查：缺少自引用、缺少回链、语言代码非法、指向 4xx/跳转/noindex、与 canonical 冲突、x-default 缺失；" +
      "语言声明与内容不一致检测（规则驱动，标注为「疑似」）。" +
      "站点无多语言配置时返回「不适用」，不产生误报。",
    inputSchema: {
      type: "object",
      properties: {
        pages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              url: { type: "string", description: "页面 URL" },
              html: { type: "string", description: "页面 HTML 原文" },
              headers: { type: "object", description: "HTTP 响应头" },
              canonical: { type: "string", description: "canonical URL" },
              noindex: { type: "boolean", description: "是否有 noindex" },
              httpStatus: { type: "number", description: "HTTP 状态码" },
              redirectChain: { type: "array", items: { type: "string" }, description: "跳转链" },
              htmlLang: { type: "string", description: "html lang 属性" },
              textContent: { type: "string", description: "正文文本（用于语言检测）" },
            },
            required: ["url"],
          },
          description: "页面数据列表（调用方准备，可从 crawl_site 结果构建）",
        },
        sitemapXml: { type: "string", description: "sitemap XML 原文（可选，第三种来源）" },
      },
      required: ["pages"],
    },
  },
];

/* ------------------------------------------------------------------ */
/* Tool 实现                                                           */
/* ------------------------------------------------------------------ */

const GSC_VALID_DIMS = new Set<GscDimension>([
  "query",
  "page",
  "date",
  "country",
  "device",
]);

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** GSC 日期默认最近 28 天（含今天） */
function resolveGscDates(
  start?: unknown,
  end?: unknown
): { startDate: string; endDate: string } {
  const today = new Date();
  const defaultEnd = isoDate(today);
  const defaultStart = isoDate(new Date(today.getTime() - 27 * 86_400_000));
  return {
    startDate: typeof start === "string" && start ? start : defaultStart,
    endDate: typeof end === "string" && end ? end : defaultEnd,
  };
}

/** 白名单过滤维度；空/非法回退 undefined（客户端用默认 ["query"]） */
function normalizeGscDims(v: unknown): GscDimension[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const dims = v.filter(
    (x): x is GscDimension => typeof x === "string" && GSC_VALID_DIMS.has(x as GscDimension)
  );
  return dims.length > 0 ? Array.from(new Set(dims)) : undefined;
}

function formatZodIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `参数 '${path}': ${issue.message}`;
    })
    .join("; ");
}

const listObservationsSchema = z.object({
  subject: z.string().optional(),
  target: z.string().optional(),
  source: z.string().optional(),
  type: z.string().optional(),
  status: z.string().optional(),
  runId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
  limit: z.union([z.number(), z.string()]).optional(),
  latest: z.union([z.boolean(), z.string(), z.number()]).optional(),
}).passthrough();

const schemaDraftOrAnalysisSchema = z.object({
  url: z.string().optional(),
  html: z.string().optional(),
}).passthrough().refine(
  (data) => Boolean((data.url && data.url.trim()) || (data.html && data.html.trim())),
  { message: "url 与 html 至少提供一个" }
);

const TOOL_SCHEMAS: Record<string, z.ZodTypeAny> = {
  list_engines: z.record(z.string(), z.unknown()).optional(),
  check_serp_ranking: z.object({
    keyword: z.string().trim().min(1, "缺少 keyword"),
    engines: z.array(z.string()).optional(),
    group: z.enum(["cn", "global", "all"]).optional(),
    targetDomain: z.string().optional(),
    pages: z.union([z.number(), z.string()]).optional(),
  }).passthrough(),
  audit_page: z.object({
    url: z.string().trim().min(1, "缺少 url"),
    geo_version: z.enum(["1.0.0", "2.0.0"]).optional(),
  }).passthrough(),
  analyze_ai_citations: z.object({
    queries: z.array(z.string()).min(1, "缺少 queries 列表"),
    brand: z.string().trim().min(1, "缺少 brand"),
    domain: z.string().trim().min(1, "缺少 domain"),
    competitors: z.array(z.string()).optional(),
    concurrency: z.union([z.number(), z.string()]).optional(),
  }).passthrough(),
  check_ai_visibility: z.object({
    brand: z.string().trim().min(1, "缺少 brand"),
    topic: z.string().trim().min(1, "缺少 topic"),
    competitors: z.array(z.string()).optional(),
  }).passthrough(),
  crawl_site: z.object({
    site: z.string().trim().min(1, "缺少 site"),
    maxPages: z.union([z.number(), z.string()]).optional(),
    maxDepth: z.union([z.number(), z.string()]).optional(),
    concurrency: z.union([z.number(), z.string()]).optional(),
  }).passthrough(),
  get_search_performance: z.object({
    siteUrl: z.string().trim().min(1, "缺少 siteUrl"),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    dimensions: z.array(z.string()).optional(),
    rowLimit: z.union([z.number(), z.string()]).optional(),
  }).passthrough(),
  analyze_search_opportunities: z.object({
    siteUrl: z.string().trim().min(1, "缺少 siteUrl"),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    dimensions: z.array(z.string()).optional(),
    crawledUrls: z.array(z.string()).optional(),
  }).passthrough(),
  analyze_robots: z.object({
    site: z.string().trim().min(1, "缺少 site"),
  }).passthrough(),
  analyze_llms_txt: z.object({
    site: z.string().trim().min(1, "缺少 site"),
  }).passthrough(),
  generate_llms_txt: z.object({
    site: z.string().trim().min(1, "缺少 site"),
    siteName: z.string().optional(),
    description: z.string().optional(),
    maxLinks: z.union([z.number(), z.string()]).optional(),
  }).passthrough(),
  compare_with_openseo: z.record(z.string(), z.unknown()).optional(),
  diagnose_page: z.object({
    url: z.string().optional(),
    html: z.string().optional(),
    skipProtocol: z.boolean().optional(),
    geo_version: z.enum(["1.0.0", "2.0.0"]).optional(),
  }).passthrough().refine(
    (data) => Boolean((data.url && data.url.trim()) || (data.html && data.html.trim())),
    { message: "diagnose_page 需要提供 url 或 html 其中之一" }
  ),
  apply_fixes: z.object({
    html: z.string({ error: "apply_fixes 缺少必需的 html 参数" }),
    url: z.string().optional(),
    fixIds: z.array(z.string()).optional(),
  }).passthrough(),
  diff_observations: z.object({
    target: z.string().optional(),
    subject: z.string().optional(),
    type: z.string().optional(),
    source: z.string().optional(),
    to: z.string().optional(),
    prev: z.record(z.string(), z.unknown()).optional(),
    curr: z.record(z.string(), z.unknown()).optional(),
  }).passthrough().refine(
    (data) => {
      if (data.prev || data.curr) {
        return Boolean(data.prev && data.curr);
      }
      return Boolean(data.subject && data.type);
    },
    { message: "diff_observations 需要提供 subject 与 type，或提供 prev 与 curr 对象" }
  ),
  list_observations: listObservationsSchema,
  query_history: listObservationsSchema,
  list_opportunities: z.object({
    siteAnalysis: z.record(z.string(), z.unknown()).optional(),
    citationAggregation: z.record(z.string(), z.unknown()).optional(),
    userDomain: z.string().optional(),
    robotsAnalysis: z.record(z.string(), z.unknown()).optional(),
    llmsTxtAnalysis: z.record(z.string(), z.unknown()).optional(),
    gscOpportunities: z.array(z.unknown()).optional(),
    pageAudits: z.array(z.unknown()).optional(),
  }).passthrough(),
  verify_opportunity: z.object({
    opportunity: z.record(z.string(), z.unknown()),
    prevObservations: z.array(z.unknown()),
    currObservations: z.array(z.unknown()),
  }).passthrough(),
  analyze_query: z.object({
    query: z.string().trim().min(1, "缺少 query"),
    serpResults: z.array(z.unknown()).optional(),
    aiCitations: z.array(z.unknown()).optional(),
    gscOpportunities: z.array(z.unknown()).optional(),
    userCrawl: z.record(z.string(), z.unknown()).optional(),
    userDomain: z.string().optional(),
  }).passthrough(),
  cluster_queries: z.object({
    queries: z.array(z.record(z.string(), z.unknown())).min(1, "queries 数组不能为空"),
    jaccardThreshold: z.union([z.number(), z.string()]).optional(),
    minSharedUrls: z.union([z.number(), z.string()]).optional(),
  }).passthrough(),
  compare_competitors: z.object({
    userDomain: z.string().trim().min(1, "缺少 userDomain"),
    competitors: z.array(z.string()).min(1, "至少需要 1 个竞品域名"),
    queries: z.array(z.string()).optional(),
    serpResults: z.array(z.unknown()).optional(),
    aiCitations: z.array(z.unknown()).optional(),
    userPageAudits: z.array(z.unknown()).optional(),
    competitorPageAudits: z.array(z.unknown()).optional(),
    competitorPageUrls: z.array(z.string()).optional(),
    userRobots: z.record(z.string(), z.unknown()).optional(),
    userLlmsTxt: z.record(z.string(), z.unknown()).optional(),
    competitorRobots: z.array(z.unknown()).optional(),
    competitorLlmsTxt: z.array(z.unknown()).optional(),
    fetchProtocol: z.boolean().optional(),
    userCrawl: z.record(z.string(), z.unknown()).optional(),
    competitorCrawls: z.array(z.unknown()).optional(),
  }).passthrough(),
  analyze_schema: schemaDraftOrAnalysisSchema,
  generate_schema_draft: schemaDraftOrAnalysisSchema,
  check_web_vitals: z.object({
    urls: z.array(z.string()).optional(),
    origins: z.array(z.string()).optional(),
    formFactor: z.enum(["DESKTOP", "PHONE", "TABLET"]).optional(),
    concurrency: z.union([z.number(), z.string()]).optional(),
    minIntervalMs: z.union([z.number(), z.string()]).optional(),
  }).passthrough().refine(
    (data) => Boolean((data.urls && data.urls.length > 0) || (data.origins && data.origins.length > 0)),
    { message: "urls 与 origins 至少提供一个" }
  ),
  check_hreflang: z.object({
    pages: z.array(
      z.object({
        url: z.string().min(1, "缺少 url"),
      }).passthrough()
    ).min(1, "pages 数组不能为空，且每个元素必须包含 url"),
    sitemapXml: z.string().optional(),
  }).passthrough(),
};

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const schema = TOOL_SCHEMAS[name];
  if (!schema) {
    throw new Error(`未知工具：${name}`);
  }

  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    throw new Error(`MCP 参数校验失败: ${formatZodIssues(parsed.error.issues)}`);
  }
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
      const group = (args.group as "cn" | "global" | "all") ?? "cn";

      // 选引擎、算平均位次、限制 pages 上限 —— 全部由 service 决定，
      // MCP 不再自己实现第二份口径。
      const r = await searchRankings({
        keyword,
        targetDomain,
        engines: list,
        group,
        pages: Number(args.pages) || 1,
      });

      return {
        keyword: r.keyword,
        targetDomain: r.targetDomain,
        engineCount: r.engineCount,
        // 以下两个字段为向后兼容保留，值与 summary 同源
        okEngines: r.summary.okEngines,
        averageRank: r.summary.averageRank,
        summary: r.summary,
        note: "抓不到的引擎会返回 status=blocked 并说明原因，不使用模拟数据。",
        results: r.results.map((item) => ({
          engine: item.engineName,
          status: item.status,
          targetRank: item.targetRank,
          note: item.note,
          topResults: item.items.slice(0, 10).map((i) => ({
            pos: i.position, title: i.title, url: i.url, domain: i.domain,
          })),
        })),
      };
    }

    case "audit_page": {
      const url = String(args.url ?? "").trim();
      if (!url) throw new Error("缺少 url");
      const geoVersion = args.geo_version === "2.0.0" ? "2.0.0" : "1.0.0";
      const a = await auditUrl(url, { geoVersion });
      return {
        url: a.url,
        httpStatus: a.httpStatus,
        seoScore: a.seoScore,
        geoScore: a.geoScore,
        geoVersion: a.geoVersion,
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

    
    case "analyze_ai_citations": {
      const queries = (args.queries as string[]) || [];
      const brand = String(args.brand);
      const domain = String(args.domain);
      const competitors = (args.competitors as string[]) || [];
      const concurrency = Math.max(1, Math.min(5, Number(args.concurrency) || 2));

      // T2：竞品清单全程在探测链路中透传，不再靠二次 extract 兜底
      const reports = await batchProbeVisibility(
        brand, queries, concurrency, undefined, competitors
      );

      // 汇总每个 (query, model) 的引用记录；模型响应里没有链接就是 unavailable,不编造
      const records: CitationRecord[] = [];
      for (const report of reports) {
        for (const probe of report.probes) {
          if (probe.citation) records.push(probe.citation);
        }
      }

      const aggregation = analyzeCitations(records, domain);

      // T2 #6：与上一次观测 diff。存档为空时不编造，明确说明不可比
      const history = await listObservationHistory(
        new URLSearchParams({ type: "ai_citation", limit: "300", order: "desc" })
      );
      let changes: ReturnType<typeof diffCitationRecords> | null = null;
      let diffNote: string | undefined;
      if (history.ok && history.data.items.length > 0) {
        const prevRecords = history.data.items
          .map((o) => o.result as CitationRecord)
          .filter((r) => r && typeof r === "object" && "query" in r && "model" in r);
        changes = diffCitationRecords(prevRecords, records);
      } else {
        diffNote =
          "存档中暂无更早的 ai_citation 观测，无法对比。开启 GEOKIT_EVIDENCE=on 并跑过至少两次后可用。";
      }

      return {
        totalQueries: queries.length,
        totalRecords: records.length,
        aggregation,
        changes,
        diffNote,
      };
    }

    case "check_ai_visibility": {
      const brand = String(args.brand ?? "").trim();
      const topic = String(args.topic ?? "").trim();
      const competitors = Array.isArray(args.competitors)
        ? (args.competitors as unknown[]).map(String)
        : [];
      if (!brand || !topic) throw new Error("缺少 brand 或 topic");
      // key 的收集同样下沉到 service —— MCP 侧不再有自己的一份环境变量逻辑
      const report = await probeVisibility(brand, topic, competitors);
      return {
        brand: report.brand,
        visibilityScore: report.visibilityScore,
        configuredCount: report.configuredCount,
        mentionedCount: report.mentionedCount,
        /** @deprecated 兼容字段，等于 statusCounts.determinableCount */
        observedCount: report.observedCount,
        failedCount: report.failedCount,
        unobservableCount: report.unobservableCount,
        /**
         * Phase 1 S1 六态精确计数。
         * attempted → successful → determinable 是三层漏斗：
         * 拿到响应 ≠ 能下结论。只看 observedCount 会把「模型拒答」误记成「没提及」。
         */
        statusCounts: report.statusCounts,
        topCitedDomains: report.topCitedDomains,
        /**
         * 可复现性上下文。没有它，Agent 拿到的分数无法判断可信边界：
         * 同一个 60 分，在「9 个模型全观测成功」和「3 个成功 6 个失败」
         * 两种情况下的含义完全不同。
         */
        sampling: {
          // report 上的这三个值是本次观测实际生效的值；samplingProfile() 是全局默认
          promptVersion: report.promptVersion,
          requestParams: report.requestParams,
          ...samplingProfile(),
        },
        note:
          "visibilityScore 的分母是**可判定**探针数（statusCounts.determinableCount = MENTIONED + NOT_MENTIONED）；" +
          "INDETERMINATE（模型拒答/答非所问）、BLOCKED、ERROR、UNOBSERVABLE 均不计入。" +
          "open-seo 仅覆盖 ChatGPT/Claude/Gemini/Perplexity；GEOkit 额外覆盖 DeepSeek、豆包、Kimi、通义、文心、元宝。",
        probes: report.probes.map((p) => ({
          provider: p.providerName,
          vendor: p.vendor,
          status: p.status,
          mentioned: p.mentioned,
          excerpt: p.excerpt,
          note: p.note,
          confidence: p.confidence,
          requestedModel: p.requestedModel,
          servedModel: p.servedModel,
          promptVersion: p.promptVersion,
          parserVersion: p.parserVersion,
          rawResponseChars: p.rawResponse?.length ?? 0,
          unobservableReason: p.unobservableReason ?? null,
          elapsedMs: p.elapsedMs,
          // T2：引用情报摘要（新增字段，向后兼容）。citationsStatus != "ok" 时没有编造任何 URL
          citation: p.citation
            ? {
                citationsStatus: p.citation.citationsStatus,
                citations: p.citation.citations,
                competitorsMentioned: p.citation.competitorsMentioned,
                mentionContext: p.citation.mentionContext ?? null,
              }
            : null,
        })),
      };
    }

    case "crawl_site": {
      const site = String(args.site ?? "").trim();
      if (!site) throw new Error("缺少 site");
      const config: { maxPages?: number; maxDepth?: number; concurrency?: number } = {};
      if (args.maxPages !== undefined) config.maxPages = Number(args.maxPages);
      if (args.maxDepth !== undefined) config.maxDepth = Number(args.maxDepth);
      if (args.concurrency !== undefined) config.concurrency = Number(args.concurrency);
      const result = await crawlSite(site, { config });
      // T4：站点级问题聚合（纯函数）。只新增字段，原有字段不动 —— 向后兼容
      const analysis = analyzeSiteIssues(result);
      return {
        origin: result.origin,
        pages: result.pages.map((p) => ({
          url: p.url,
          httpStatus: p.httpStatus,
          title: p.title,
          geoScore: p.geoScore,
          clickDepth: p.clickDepth,
          blocked: p.blocked,
        })),
        truncated: result.truncated,
        reason: result.reason,
        pageCount: result.pages.length,
        graph: {
          nodes: result.graph.nodes.length,
          edges: result.graph.edges.length,
        },
        issues: analysis.issues,
        geoSummary: analysis.geoSummary,
        schemaCoverage: analysis.schemaCoverage,
      };
    }

    case "get_search_performance": {
      const siteUrl = String(args.siteUrl ?? "").trim();
      if (!siteUrl) throw new Error("缺少 siteUrl");
      const { startDate, endDate } = resolveGscDates(args.startDate, args.endDate);
      const dimensions = normalizeGscDims(args.dimensions);
      const rowLimit =
        args.rowLimit !== undefined ? Number(args.rowLimit) : undefined;
      return await getSearchPerformance({
        siteUrl,
        startDate,
        endDate,
        ...(dimensions ? { dimensions } : {}),
        ...(rowLimit !== undefined && !Number.isNaN(rowLimit) ? { rowLimit } : {}),
      });
    }

    case "analyze_search_opportunities": {
      const siteUrl = String(args.siteUrl ?? "").trim();
      if (!siteUrl) throw new Error("缺少 siteUrl");
      const { startDate, endDate } = resolveGscDates(args.startDate, args.endDate);
      const dimensions = normalizeGscDims(args.dimensions);
      const crawledUrls = Array.isArray(args.crawledUrls)
        ? args.crawledUrls.filter((u): u is string => typeof u === "string")
        : undefined;
      return await analyzeSearchPerformance(
        {
          siteUrl,
          startDate,
          endDate,
          ...(dimensions ? { dimensions } : {}),
        },
        { crawledUrls }
      );
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

    case "diagnose_page": {
      const url = args.url ? String(args.url).trim() : undefined;
      const html = typeof args.html === "string" ? args.html : undefined;
      if (!url && !html) {
        throw new Error("diagnose_page 需要提供 url 或 html 其中之一");
      }
      const geoVersion = args.geo_version === "2.0.0" ? "2.0.0" : "1.0.0";

      if (html) {
        return checkHtml(html, url ?? "https://offline.local", 200, { geoVersion });
      }
      return await checkUrl(url!, {
        skipProtocolChecks: Boolean(args.skipProtocol),
        geoVersion,
      });
    }

    case "apply_fixes": {
      if (typeof args.html !== "string") {
        throw new Error("apply_fixes 缺少必需的 html 参数");
      }
      const url = args.url ? String(args.url).trim() : undefined;
      const fixIds = Array.isArray(args.fixIds) ? args.fixIds.map(String) : undefined;
      const res = autoFixHtml(args.html, { url, fixIds });
      return {
        changed: res.changed,
        attempts: res.attempts,
        diagnosesCount: res.diagnoses.length,
        fixedCount: res.attempts.filter((a) => a.changed).length,
        diagnoses: res.diagnoses.map((d) => ({
          issueId: d.issueId,
          severity: d.severity,
          detail: d.detail,
          suggestedFix: d.suggestedFix,
          manualFix: d.manualFix,
        })),
        html: res.html,
        summary: `共扫描 ${res.diagnoses.length} 项问题，尝试 ${res.attempts.length} 项规则，${res.changed ? "HTML 已更新" : "无须修改"}。`,
      };
    }

    case "diff_observations": {
      if (args.prev || args.curr) {
        if (!args.prev || !args.curr) {
          throw new Error("diff_observations 比较对象时需要同时提供 prev 与 curr");
        }
        const diff = diffObservations(args.prev as Observation, args.curr as Observation);
        return { source: "inline_objects", diff };
      }

      const subject = args.subject ? String(args.subject).trim() : undefined;
      const type = args.type ? String(args.type).trim() : undefined;
      if (!subject || !type) {
        throw new Error("diff_observations 需要提供 subject 与 type，或提供 prev 与 curr 对象");
      }

      const sp = new URLSearchParams();
      sp.set("subject", subject);
      sp.set("type", type);
      if (args.source) sp.set("source", String(args.source).trim());
      if (args.to) sp.set("to", String(args.to).trim());

      const r = await latestObservationDiff(sp);
      if (!r.ok) throw new Error(r.error);
      return r.data;
    }

    // query_history 为旧名别名,保持向后兼容(不在 tools/list 里重复列出)
    case "query_history":
    case "list_observations": {
      const sp = new URLSearchParams();
      if (args.subject) sp.set("subject", String(args.subject).trim());
      if (args.target) sp.set("target", String(args.target).trim());
      if (args.source) sp.set("source", String(args.source).trim());
      if (args.type) sp.set("type", String(args.type).trim());
      if (args.status) sp.set("status", String(args.status).trim());
      if (args.runId) sp.set("runId", String(args.runId).trim());
      if (args.from) sp.set("from", String(args.from).trim());
      if (args.to) sp.set("to", String(args.to).trim());
      if (args.order) sp.set("order", String(args.order).trim());
      if (args.limit !== undefined) sp.set("limit", String(args.limit));
      if (args.latest !== undefined) sp.set("latest", args.latest ? "1" : "0");

      const r = await listObservationHistory(sp);
      if (!r.ok) throw new Error(r.error);
      return r.data;
    }

    case "list_opportunities": {
      // 把 MCP 入参里的可选字段透传给引擎；缺哪段引擎会跳过对应机会类型
      const input: OpportunityInput = {};
      if (args.siteAnalysis && typeof args.siteAnalysis === "object") {
        input.siteAnalysis = args.siteAnalysis as OpportunityInput["siteAnalysis"];
      }
      if (args.citationAggregation && typeof args.citationAggregation === "object") {
        input.citationAggregation = args.citationAggregation as OpportunityInput["citationAggregation"];
      }
      if (typeof args.userDomain === "string" && args.userDomain.trim()) {
        input.userDomain = String(args.userDomain).trim();
      }
      if (args.robotsAnalysis && typeof args.robotsAnalysis === "object") {
        input.robotsAnalysis = args.robotsAnalysis as OpportunityInput["robotsAnalysis"];
      }
      if (args.llmsTxtAnalysis && typeof args.llmsTxtAnalysis === "object") {
        input.llmsTxtAnalysis = args.llmsTxtAnalysis as OpportunityInput["llmsTxtAnalysis"];
      }
      if (Array.isArray(args.gscOpportunities)) {
        input.gscOpportunities = args.gscOpportunities as OpportunityInput["gscOpportunities"];
      }
      if (Array.isArray(args.pageAudits)) {
        input.pageAudits = args.pageAudits as OpportunityInput["pageAudits"];
      }

      const opportunities = generateOpportunities(input);
      const counts = countByType(opportunities);
      return {
        total: opportunities.length,
        counts,
        opportunities,
        note:
          "每个机会的 diagnosis.evidence 必须可追溯；缺哪段输入就跳过对应类型，绝不报错。" +
          "建议来自规则与模板，不调用任何大模型。",
      };
    }

    case "verify_opportunity": {
      if (!args.opportunity || typeof args.opportunity !== "object") {
        throw new Error("verify_opportunity 需要 opportunity 对象");
      }
      if (!Array.isArray(args.prevObservations) || !Array.isArray(args.currObservations)) {
        throw new Error("verify_opportunity 需要 prevObservations 与 currObservations 数组");
      }
      const op = args.opportunity as Opportunity;
      const prev = args.prevObservations as Observation[];
      const curr = args.currObservations as Observation[];
      const resolution: OpportunityResolution = verifyOpportunity(op, prev, curr);
      return {
        opportunityId: op.id,
        target: op.target,
        type: op.type,
        verification: op.verification,
        resolution,
        note:
          resolution === "unknown"
            ? "未找到可比的前后观测，无法判定。"
            : `复检结论：${resolution}`,
      };
    }

    case "analyze_query": {
      if (typeof args.query !== "string" || !args.query.trim()) {
        throw new Error("analyze_query 需要 query 字符串");
      }
      const input: QueryAnalysisInput = { query: String(args.query).trim() };
      if (Array.isArray(args.serpResults)) {
        input.serpResults = args.serpResults as QueryAnalysisInput["serpResults"];
      }
      if (Array.isArray(args.aiCitations)) {
        input.aiCitations = args.aiCitations as QueryAnalysisInput["aiCitations"];
      }
      if (Array.isArray(args.gscOpportunities)) {
        input.gscOpportunities = args.gscOpportunities as QueryAnalysisInput["gscOpportunities"];
      }
      if (args.userCrawl && typeof args.userCrawl === "object") {
        input.userCrawl = args.userCrawl as QueryAnalysisInput["userCrawl"];
      }
      if (typeof args.userDomain === "string" && args.userDomain.trim()) {
        input.userDomain = String(args.userDomain).trim();
      }
      return analyzeQuery(input);
    }

    case "cluster_queries": {
      if (!Array.isArray(args.queries)) {
        throw new Error("cluster_queries 需要 queries 数组");
      }
      const queries: QueryClusterInput[] = args.queries
        .filter((q: unknown): q is QueryClusterInput =>
          !!q && typeof q === "object" && typeof (q as QueryClusterInput).query === "string"
        )
        .map((q: QueryClusterInput) => ({
          query: String(q.query),
          serpResults: Array.isArray(q.serpResults) ? q.serpResults : [],
        }));
      const options: ClusterOptions = {};
      if (typeof args.jaccardThreshold === "number") {
        options.jaccardThreshold = Number(args.jaccardThreshold);
      }
      if (typeof args.minSharedUrls === "number") {
        options.minSharedUrls = Number(args.minSharedUrls);
      }
      const clusters = clusterQueries(queries, options);
      return {
        total: clusters.length,
        queriesAnalyzed: queries.length,
        clusters,
        note:
          clusters.length === 0
            ? "无符合条件的簇（共享 URL 不足或 Jaccard < 阈值）。"
            : `共 ${clusters.length} 个簇，最大簇含 ${Math.max(...clusters.map((c) => c.queries.length))} 个 query。`,
      };
    }

    case "compare_competitors": {
      const userDomain = String(args.userDomain ?? "").trim();
      const competitors = Array.isArray(args.competitors)
        ? (args.competitors as unknown[]).map(String).filter(Boolean).slice(0, 5)
        : [];
      if (!userDomain) throw new Error("缺少 userDomain");
      if (competitors.length === 0) throw new Error("至少需要 1 个竞品域名");

      const input: CompetitorInput = { userDomain, competitors };
      if (Array.isArray(args.queries)) input.queries = (args.queries as unknown[]).map(String);
      if (Array.isArray(args.serpResults)) input.serpResults = args.serpResults as CompetitorInput["serpResults"];
      if (Array.isArray(args.aiCitations)) input.aiCitations = args.aiCitations as CompetitorInput["aiCitations"];
      if (Array.isArray(args.userPageAudits)) input.userPageAudits = args.userPageAudits as CompetitorInput["userPageAudits"];
      if (Array.isArray(args.competitorPageAudits)) input.competitorPageAudits = args.competitorPageAudits as CompetitorInput["competitorPageAudits"];
      if (Array.isArray(args.competitorPageUrls)) input.competitorPageUrls = args.competitorPageUrls as CompetitorInput["competitorPageUrls"];
      if (args.userRobots && typeof args.userRobots === "object") input.userRobots = args.userRobots as CompetitorInput["userRobots"];
      if (args.userLlmsTxt && typeof args.userLlmsTxt === "object") input.userLlmsTxt = args.userLlmsTxt as CompetitorInput["userLlmsTxt"];
      if (Array.isArray(args.competitorRobots)) input.competitorRobots = args.competitorRobots as CompetitorInput["competitorRobots"];
      if (Array.isArray(args.competitorLlmsTxt)) input.competitorLlmsTxt = args.competitorLlmsTxt as CompetitorInput["competitorLlmsTxt"];
      if (typeof args.fetchProtocol === "boolean") input.fetchProtocol = args.fetchProtocol;
      if (args.userCrawl && typeof args.userCrawl === "object") input.userCrawl = args.userCrawl as CompetitorInput["userCrawl"];
      if (Array.isArray(args.competitorCrawls)) input.competitorCrawls = args.competitorCrawls as CompetitorInput["competitorCrawls"];

      const report = await analyzeCompetitors(input);
      return {
        userDomain: report.userDomain,
        competitors: report.competitors,
        dimensions: report.dimensions.map((d) => ({
          dimension: d.dimension,
          summary: d.summary,
          gap: d.gap,
          gapDetail: d.gapDetail,
          userValue: d.userValue,
          userStatus: d.userStatus,
          competitorValues: d.competitorValues.map((cv) => ({
            domain: cv.domain,
            value: cv.value,
            status: cv.status,
            statusReason: cv.statusReason,
          })),
        })),
        gaps: report.gaps,
        sourceAvailability: report.sourceAvailability,
        note:
          "五维对比：SERP 位次 / AI 提及 / GEO 评分 / AI 抓取协议 / 结构化数据。" +
          "抓取失败按 blocked 标注，缺数据源的维度标 unavailable，不留空、不编造。",
      };
    }

    case "analyze_schema":
    case "generate_schema_draft": {
      const inlineHtml = typeof args.html === "string" && args.html.trim() ? args.html : null;
      const rawUrl = String(args.url ?? "").trim();
      if (!inlineHtml && !rawUrl) throw new Error("url 与 html 至少提供一个");

      // 离线：直接分析传入 HTML
      if (inlineHtml) {
        const url = rawUrl || "inline://html";
        if (name === "analyze_schema") return analyzeSchema(url, inlineHtml);
        return buildSchemaDraft(url, inlineHtml);
      }

      // 在线：抓取后分析
      const r = await analyzeSchemaUrl(rawUrl);
      if (!r.ok) {
        return {
          ok: false,
          url: r.finalUrl,
          httpStatus: r.httpStatus,
          error: r.error,
        };
      }
      return name === "analyze_schema" ? r.diagnosis : r.draft;
    }

    case "check_web_vitals": {
      const urls = Array.isArray(args.urls) ? args.urls.filter((u): u is string => typeof u === "string") : [];
      const origins = Array.isArray(args.origins) ? args.origins.filter((o): o is string => typeof o === "string") : [];
      const formFactor = args.formFactor === "DESKTOP" || args.formFactor === "PHONE" || args.formFactor === "TABLET"
        ? args.formFactor
        : undefined;

      if (urls.length === 0 && origins.length === 0) {
        throw new Error("urls 与 origins 至少提供一个");
      }

      const input = {
        urls: urls.length > 0 ? urls : undefined,
        origins: origins.length > 0 ? origins : undefined,
        formFactor,
        concurrency: typeof args.concurrency === "number" ? args.concurrency : undefined,
        minIntervalMs: typeof args.minIntervalMs === "number" ? args.minIntervalMs : undefined,
      } as const;

      // 采集
      const { rawObservations, truncated, truncatedReason } = await batchQueryCruxRaw(input);

      // 分析
      const observations = analyzeCruxBatch(rawObservations);

      // 落库（受 GEOKIT_EVIDENCE 总闸控制）
      if (process.env.GEOKIT_EVIDENCE === "on") {
        const store = createStore();
        for (const obs of observations) {
          await recordCruxObservation(store, obs);
        }
      }

      const ok = observations.filter((o) => o.status === "ok").length;
      const unavailable = observations.filter((o) => o.status === "unavailable").length;
      const blocked = observations.filter((o) => o.status === "blocked").length;
      const error = observations.filter((o) => o.status === "error").length;

      return {
        total: observations.length,
        ok,
        unavailable,
        blocked,
        error,
        truncated,
        truncatedReason,
        observations,
        note:
          "CrUX 数据为 Chrome 真实用户采样（28 天滚动窗口）；" +
          "无数据时返回 unavailable，不返回估算值；" +
          "差指标已生成 poor-web-vitals 机会（调用 list_opportunities 查看）。",
      };
    }

    case "check_hreflang": {
      const pagesRaw = Array.isArray(args.pages) ? args.pages : [];
      const pages: PageInput[] = pagesRaw
        .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
        .map((p) => ({
          url: String(p.url ?? ""),
          html: typeof p.html === "string" ? p.html : undefined,
          headers: typeof p.headers === "object" && p.headers !== null ? (p.headers as Record<string, string>) : undefined,
          canonical: typeof p.canonical === "string" ? p.canonical : undefined,
          noindex: typeof p.noindex === "boolean" ? p.noindex : undefined,
          httpStatus: typeof p.httpStatus === "number" ? p.httpStatus : undefined,
          redirectChain: Array.isArray(p.redirectChain) ? p.redirectChain.filter((u): u is string => typeof u === "string") : undefined,
          htmlLang: typeof p.htmlLang === "string" ? p.htmlLang : undefined,
          textContent: typeof p.textContent === "string" ? p.textContent : undefined,
        }))
        .filter((p) => p.url.length > 0);

      if (pages.length === 0) {
        throw new Error("pages 数组不能为空，且每个元素必须包含 url");
      }

      const sitemapXml = typeof args.sitemapXml === "string" ? args.sitemapXml : undefined;

      const result = analyzeHreflang(pages, sitemapXml);

      return {
        isMultilingual: result.isMultilingual,
        issueCount: result.issues.length,
        issues: result.issues,
        pageCount: pages.length,
        pageEntriesCount: result.pageEntries.size,
        note: result.isMultilingual
          ? `检测到 ${result.issues.length} 个 hreflang 问题，已接入 T4 issues 结构`
          : "站点无多语言配置，返回「不适用」，不产生误报",
      };
    }

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

