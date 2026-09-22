/**
 * Canonical identity —— `subject` 与 `source` 的唯一构造入口。
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么必须有这个文件
 * ─────────────────────────────────────────────────────────────
 * Phase 0 的 `Evidence.target` 是一个**语义分裂**的字段：
 *
 *   serp.ts:64     target = "baidu"      ← 这是观测来源
 *   visibility:482 target = "deepseek"   ← 这是观测来源
 *   audit.ts:105   target = "https://…"  ← 这是被观测对象
 *   llms.ts:166    target = "https://…"  ← 这是被观测对象
 *
 * Phase 0 只有 AI 通道写盘，所以这个分裂没有造成实际伤害。但 Phase 1
 * 一旦按 target 建索引，「查 baidu」会同时命中「用百度查的」和「查百度的」
 * —— 两类完全不同的观测混在一根时间线上。
 *
 * 因此 D1 拍板：拆成两个字段，语义严格区分，且**只能通过本文件的函数构造**。
 * 不让各处自己拼字符串，是因为「拼法不一致」正是索引失效的头号原因。
 *
 *   subject = 被观察的对象（回答「观察的是谁」）
 *   source  = 产生观察的来源（回答「谁提供的」）
 *
 * ─────────────────────────────────────────────────────────────
 * 兼容性
 * ─────────────────────────────────────────────────────────────
 * 旧 `target` 字段**不删除**（Phase 0 已冻结）。新记录继续写入它，
 * 旧读者行为零变化；新读者一律走 subject / source。
 */

export type SubjectKind = "site" | "search" | "ai-slot";
export type SourceKind = "http" | "search-engine" | "provider";

/* ------------------------------------------------------------------ */
/* 规范化                                                               */
/* ------------------------------------------------------------------ */

/**
 * URL 规范化。目标是让「同一个站点」只有一种写法：
 * 去 hash、去凭据、host 小写、去默认端口、去非根路径的尾斜杠。
 *
 * 不改变查询串顺序 —— 那是语义的一部分，重排会改变所指。
 */
export function canonicalUrl(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    u.hash = "";
    u.username = "";
    u.password = "";
    const host = u.hostname.toLowerCase();
    const defaultPort = u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "";
    const hostPort = u.port && u.port !== defaultPort ? `${host}:${u.port}` : host;
    // 根路径的 `/` 也去掉：`https://a.com/` 与 `https://a.com` 必须收敛成同一个
    // subject，否则「站点身份」会因写法不同裂成两条时间线
    let path = u.pathname;
    if (path.endsWith("/")) path = path.slice(0, -1);
    return `${u.protocol}//${hostPort}${path}${u.search}`;
  } catch {
    return s;
  }
}

/** 取出 origin（`https://host:port`），用于 http 来源标识 */
export function originOf(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase();
    const defaultPort = u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "";
    const hostPort = u.port && u.port !== defaultPort ? `${host}:${u.port}` : host;
    return `${u.protocol}//${hostPort}`;
  } catch {
    return s;
  }
}

/** 关键词规范化：去首尾空白、折叠中间空白。大小写保留 —— 英文检索大小写是有语义的 */
export function canonicalQuery(q: string): string {
  return (q ?? "").trim().replace(/\s+/g, " ");
}

/**
 * 站点标识规范化。
 *
 * 各处拿到的「站点」形态不一：audit 通道给完整 URL，SERP 通道只给域名。
 * 若直接拼进 subject，`example.com` 与 `https://example.com/` 会变成两个
 * 不同的 subject —— 跨通道的时间线就接不起来了。这里统一补 scheme。
 */
export function normalizeSiteUrl(v: string): string {
  const s = (v ?? "").trim();
  if (!s || s === UNKNOWN_SITE) return s;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return canonicalUrl(s);
  return canonicalUrl(`https://${s}`);
}

/* ------------------------------------------------------------------ */
/* subject                                                             */
/* ------------------------------------------------------------------ */

/** 未知站点的占位符。刻意用 `*` 而不是空串：空串会让 `site=` 看起来像「已指定但为空」 */
export const UNKNOWN_SITE = "*";

/** 站点：`site:https://example.com` */
export function siteSubject(url: string): string {
  return `site:${normalizeSiteUrl(url) || UNKNOWN_SITE}`;
}

/**
 * 搜索表现：`search:site=<url>|q=<keyword>`
 *
 * 说明：被观测的对象是「某站点在某关键词下的表现」，所以 subject 同时含站点与词。
 * 未指定目标域名时用 `site=*` —— 此时观测的是「该关键词下的整体结果面」。
 */
export function searchSubject(siteUrl: string | null | undefined, query: string): string {
  const site = siteUrl ? normalizeSiteUrl(siteUrl) : "";
  return `search:site=${site || UNKNOWN_SITE}|q=${canonicalQuery(query)}`;
}

/**
 * AI 槽位：`ai-slot:<provider>:<requestedModel>`
 *
 * ★ 刻意使用 requestedModel 而非 servedModel。
 *
 * servedModel 是厂商的路由结果，可能在任何一天被改掉（已实测：请求
 * deepseek-chat 实际由 deepseek-flash 应答）。若历史 identity 挂在
 * servedModel 上，厂商一次路由调整就会把时间线切成两段无从比较的数据。
 *
 * requestedModel 表达的是「我们要求观测哪个槽位」，这才是稳定的观测对象。
 * servedModel 作为 provenance 保留（见 metadata.servedModel / modelDrift）。
 */
export function aiSlotSubject(providerId: string, requestedModel: string): string {
  return `ai-slot:${providerId || "unknown"}:${requestedModel || "unknown"}`;
}

/* ------------------------------------------------------------------ */
/* source                                                              */
/* ------------------------------------------------------------------ */

/** 直连站点：`http:https://example.com`（origin 级，不含路径） */
export function httpSource(url: string): string {
  return `http:${originOf(url) || UNKNOWN_SITE}`;
}

/** 搜索引擎：`search-engine:baidu` */
export function searchEngineSource(engineId: string): string {
  return `search-engine:${engineId || "unknown"}`;
}

/** 模型厂商：`provider:deepseek` */
export function providerSource(providerId: string): string {
  return `provider:${providerId || "unknown"}`;
}

/* ------------------------------------------------------------------ */
/* 解析                                                                 */
/* ------------------------------------------------------------------ */

export interface ParsedSubject {
  kind: SubjectKind;
  /** site / search 场景下的站点 URL；ai-slot 场景为空串 */
  url?: string;
  /** search 场景下的关键词 */
  query?: string;
  /** ai-slot 场景下的 provider */
  provider?: string;
  /** ai-slot 场景下**请求的**模型（非 served） */
  requestedModel?: string;
}

export interface ParsedSource {
  kind: SourceKind;
  id: string;
}

export function parseSubject(subject: string): ParsedSubject | null {
  const s = subject ?? "";
  if (s.startsWith("site:")) return { kind: "site", url: s.slice(5) };

  if (s.startsWith("search:")) {
    // 注意：已经 slice(7) 去掉了 `search:` 前缀，正则里不能再带它
    const m = /^site=([^|]*)\|q=(.*)$/.exec(s.slice(7));
    if (!m) return null;
    return { kind: "search", url: m[1], query: m[2] };
  }

  if (s.startsWith("ai-slot:")) {
    const rest = s.slice(8);
    const i = rest.indexOf(":");
    if (i < 0) return { kind: "ai-slot", provider: rest, requestedModel: undefined };
    return {
      kind: "ai-slot",
      provider: rest.slice(0, i),
      requestedModel: rest.slice(i + 1) || undefined,
    };
  }
  return null;
}

export function parseSource(source: string): ParsedSource | null {
  const s = source ?? "";
  if (s.startsWith("http:")) return { kind: "http", id: s.slice(5) };
  if (s.startsWith("search-engine:")) return { kind: "search-engine", id: s.slice(14) };
  if (s.startsWith("provider:")) return { kind: "provider", id: s.slice(9) };
  return null;
}

/* ------------------------------------------------------------------ */
/* 搜索引擎解析策略版本                                                  */
/* ------------------------------------------------------------------ */

/**
 * 三家中文引擎的链接提取策略。
 *
 * 它们不是「可选优化」，而是**唯一能拿到真实结果 URL 的路径**：
 *   百度   结果链接的真实地址藏在 `mu` 属性里
 *   360    藏在 `data-mdurl` 属性里
 *   搜狗   依赖 `citeLinkClass` 定位引用节点
 *
 * 任何一条被删除或简化，对应引擎的结果就会退化成中转站域名，
 * 排名结论随之失效。这里把策略版本纳入 provenance，是为了将来
 * 解析器调整后能区分「口径变化」与「真实变化」。
 *
 * ★ 改动对应解析逻辑时必须递增版本号。
 */
export const SERP_STRATEGY_VERSIONS: Record<string, string> = {
  baidu: "baidu-mu@1",
  // 360 的引擎 id 是 `so360`（见 engines.ts），早期记录里也存在 "360" 的写法。
  // 两个 key 都指向同一策略：少任何一个，360 的解析口径就无从追踪 ——
  // 而它恰恰是最容易因页面改版而失效的一家。
  "360": "so360-data-mdurl@1",
  so360: "so360-data-mdurl@1",
  sogou: "sogou-citeLinkClass@1",
};

export function serpStrategyVersion(engineId?: string): string | undefined {
  if (!engineId) return undefined;
  return SERP_STRATEGY_VERSIONS[engineId];
}
