/**
 * 鲸析 GEOkit — 站点级问题聚合（T4）
 *
 * 全部是纯函数：输入 T3 的 CrawlResult，输出带 evidence 的问题列表。
 * 不做任何 IO，不调模型 —— 结论来自规则与页面事实，可复现、可追溯。
 *
 * 每个问题都必须回答三件事：
 *   1. 影响了哪些页面（affectedUrls）
 *   2. 凭什么这么说（evidence —— 具体的字段值 / 分组 / 相似度）
 *   3. 为什么影响 GEO/SEO、建议怎么改（whyItMatters / suggestedFix）
 *
 * 内容重复检测的结论永远是「疑似」：shingle 高相似只证明正文大面积雷同。
 */
import { createHash } from "node:crypto";
import { absolutize } from "../html";
import type { CrawlResult, CrawlPage } from "./types";
import { jaccardSimilarity } from "./content";

/* ------------------------------------------------------------------ */
/* 阈值常量 —— 规则透明可读，测试直接断言                                */
/* ------------------------------------------------------------------ */

export const ISSUE_SEVERITY = {
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
} as const;
export type IssueSeverity =
  (typeof ISSUE_SEVERITY)[keyof typeof ISSUE_SEVERITY];

/** 点击深度严格大于该值 → 深度过深（重要内容应在 3 次点击内，depth 3+ 即偏远） */
export const DEEP_PAGE_DEPTH = 2;
/** 入链数严格小于该值且非孤岛 → 内链过少（0 且在 sitemap 归为孤岛） */
export const LOW_INLINK_COUNT = 2;
/** 跳转链跳数严格大于该值 → 跳转链过长 */
export const LONG_REDIRECT_HOPS = 2;
/** GEO 总分 < 该值 → high */
export const LOW_GEO_SCORE_HIGH = 40;
/** GEO 总分 < 该值 → medium */
export const LOW_GEO_SCORE_MEDIUM = 60;
/** 单维度 score/max 低于该比率 → 该页弱维度 */
export const WEAK_DIMENSION_RATIO = 0.6;
/** 同一弱维度至少出现在这么多个页面上，才算「拖累整站的共性维度」 */
export const COMMON_WEAK_DIM_MIN_PAGES = 3;
/** 正文 shingle Jaccard ≥ 该值 → 疑似内容重复 */
export const DUPLICATE_CONTENT_JACCARD = 0.8;
/** 正文不少于该词数才检查结构化数据覆盖（极短页面不强制 Schema） */
export const SCHEMA_MIN_WORDS = 100;

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export const ISSUE_TYPES = [
  "duplicate-title",
  "duplicate-meta-description",
  "duplicate-h1",
  "missing-title",
  "missing-meta-description",
  "missing-h1",
  "missing-canonical",
  "canonical-anomaly",
  "orphan-page",
  "deep-page",
  "low-inlinks",
  "long-redirect-chain",
  "redirect-loop",
  "broken-internal-link",
  "missing-structured-data",
  "low-geo-score",
  "weak-geo-dimension",
  "duplicate-content",
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export interface IssueEvidence {
  /** 事实陈述（人可读），如「与 https://a.com/x 的 title 完全相同」 */
  fact: string;
  value?: string | number;
}

export interface SiteIssue {
  /** 稳定 id：类型 + 受影响 URL 集合的哈希，复检时同一问题 id 不变 */
  id: string;
  type: IssueType;
  severity: IssueSeverity;
  /** 一句话问题概述 */
  title: string;
  affectedUrls: string[];
  evidence: IssueEvidence[];
  whyItMatters: string;
  suggestedFix: string;
}

export interface GeoSummary {
  /** 分数段计数：critical(<40) / poor(40–59) / fair(60–79) / good(80+) */
  distribution: { critical: number; poor: number; fair: number; good: number };
  /** 最低分页面（升序，最多 10 个） */
  lowestScoring: { url: string; geoScore: number }[];
  /** 共性弱维度（出现页数降序） */
  commonWeakDimensions: { id: string; label: string; pages: number }[];
}

export interface SchemaCoverageEntry {
  type: string;
  pages: number;
  ratio: number;
}

export interface SiteAnalysis {
  issues: SiteIssue[];
  geoSummary: GeoSummary;
  schemaCoverage: SchemaCoverageEntry[];
}

/* ------------------------------------------------------------------ */
/* 公共入口                                                            */
/* ------------------------------------------------------------------ */

export function analyzeSiteIssues(result: CrawlResult): SiteAnalysis {
  const pages = result.pages;
  /** 可索引的 2xx 页面 —— 内容/标签类问题只对它们成立 */
  const indexable = pages.filter(
    (p) => !p.blocked && p.httpStatus >= 200 && p.httpStatus < 300 && !p.noindex
  );

  const issues: SiteIssue[] = [
    ...findDuplicates(indexable, "duplicate-title", (p) => p.title, "title", ISSUE_SEVERITY.MEDIUM),
    ...findDuplicates(indexable, "duplicate-meta-description", (p) => p.metaDescription, "meta description", ISSUE_SEVERITY.MEDIUM),
    ...findDuplicates(indexable, "duplicate-h1", (p) => p.h1, "H1", ISSUE_SEVERITY.MEDIUM),
    ...findMissing(indexable, "missing-title", "title", (p) => p.title, ISSUE_SEVERITY.HIGH),
    ...findMissing(indexable, "missing-meta-description", "meta description", (p) => p.metaDescription, ISSUE_SEVERITY.MEDIUM),
    ...findMissing(indexable, "missing-h1", "H1", (p) => p.h1, ISSUE_SEVERITY.MEDIUM),
    ...findMissingCanonical(indexable),
    ...findCanonicalAnomalies(result, indexable),
    ...findOrphans(result),
    ...findDeepPages(indexable),
    ...findLowInlinks(result, indexable),
    ...findRedirectIssues(pages),
    ...findBrokenInternalLinks(pages),
    ...findMissingSchema(indexable),
    ...findLowGeoScore(indexable),
    ...findWeakDimensions(indexable),
    ...findDuplicateContent(indexable),
  ];

  const geoSummary = buildGeoSummary(indexable);
  const schemaCoverage = buildSchemaCoverage(indexable);

  return {
    issues: sortIssues(issues),
    geoSummary,
    schemaCoverage,
  };
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function makeId(type: IssueType, urls: string[]): string {
  const h = createHash("sha1")
    .update(type + "|" + [...urls].sort().join(","), "utf8")
    .digest("hex")
    .slice(0, 8);
  return `${type}:${h}`;
}

function makeIssue(
  type: IssueType,
  severity: IssueSeverity,
  title: string,
  affectedUrls: string[],
  evidence: IssueEvidence[],
  whyItMatters: string,
  suggestedFix: string
): SiteIssue {
  return {
    id: makeId(type, affectedUrls),
    type,
    severity,
    title,
    affectedUrls,
    evidence,
    whyItMatters,
    suggestedFix,
  };
}

function sortIssues(issues: SiteIssue[]): SiteIssue[] {
  const rank: Record<IssueSeverity, number> = { high: 0, medium: 1, low: 2 };
  return [...issues].sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      b.affectedUrls.length - a.affectedUrls.length ||
      a.type.localeCompare(b.type)
  );
}

function isNonEmpty(v: string | null | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/* ------------------------------------------------------------------ */
/* 1. 重复 title / description / H1（具体 URL 分组）                    */
/* ------------------------------------------------------------------ */

function findDuplicates(
  pages: CrawlPage[],
  type: IssueType,
  pick: (p: CrawlPage) => string | null,
  fieldLabel: string,
  severity: IssueSeverity
): SiteIssue[] {
  const groups = new Map<string, CrawlPage[]>();
  for (const p of pages) {
    const v = pick(p);
    if (!isNonEmpty(v)) continue;
    const key = v.trim();
    const arr = groups.get(key);
    if (arr) arr.push(p);
    else groups.set(key, [p]);
  }

  const out: SiteIssue[] = [];
  for (const [value, arr] of groups) {
    if (arr.length < 2) continue;
    const urls = arr.map((p) => p.url);
    out.push(
      makeIssue(
        type,
        severity,
        `${arr.length} 个页面的 ${fieldLabel} 完全相同`,
        urls,
        [
          { fact: `重复的 ${fieldLabel}`, value },
          { fact: "重复页面数", value: arr.length },
        ],
        `重复的 ${fieldLabel} 会削弱页面区分度，AI 与搜索引擎难以判断每页针对的主题。`,
        `为每页撰写唯一、具体的 ${fieldLabel}，与其正文主题一一对应。`
      )
    );
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 2. 缺失 title / description / H1 / canonical                         */
/* ------------------------------------------------------------------ */

function findMissing(
  pages: CrawlPage[],
  type: IssueType,
  fieldLabel: string,
  pick: (p: CrawlPage) => string | null,
  severity: IssueSeverity
): SiteIssue[] {
  const urls = pages.filter((p) => !isNonEmpty(pick(p))).map((p) => p.url);
  if (urls.length === 0) return [];
  return [
    makeIssue(
      type,
      severity,
      `${urls.length} 个页面缺少 ${fieldLabel}`,
      urls,
      [
        { fact: `缺失字段`, value: fieldLabel },
        { fact: "受影响页面数", value: urls.length },
      ],
      `${fieldLabel} 是 AI 与搜索引擎理解页面主题的最基本信号，缺失会直接降低被引用概率。`,
      `为这些页面补齐非空、与正文一致的 ${fieldLabel}。`
    ),
  ];
}

function findMissingCanonical(pages: CrawlPage[]): SiteIssue[] {
  const urls = pages.filter((p) => !isNonEmpty(p.canonical)).map((p) => p.url);
  if (urls.length === 0) return [];
  return [
    makeIssue(
      "missing-canonical",
      ISSUE_SEVERITY.MEDIUM,
      `${urls.length} 个页面缺少 canonical`,
      urls,
      [
        { fact: "缺失字段", value: "link[rel=canonical]" },
        { fact: "受影响页面数", value: urls.length },
      ],
      "缺少 canonical 时，带参数的重复 URL 可能被当成不同页面，分散权重与引用。",
      "为每个可索引页面声明指向规范版本的 canonical。"
    ),
  ];
}

/* ------------------------------------------------------------------ */
/* 3. canonical 指向异常                                                */
/* ------------------------------------------------------------------ */

function findCanonicalAnomalies(result: CrawlResult, pages: CrawlPage[]): SiteIssue[] {
  const out: SiteIssue[] = [];
  let originHost: string;
  try {
    originHost = new URL(result.origin).hostname;
  } catch {
    return out;
  }
  // 已爬页面的状态/跳转索引：用「全部」页面（含 4xx），
  // 否则 canonical 指向的 4xx 目标因不可索引而查不到，异常就漏报了
  const byUrl = new Map(result.pages.map((p) => [p.url, p]));

  for (const p of pages) {
    if (!isNonEmpty(p.canonical)) continue;
    const canonAbs = absolutize(p.canonical, p.url);
    const evidence: IssueEvidence[] = [{ fact: "页面 canonical", value: canonAbs }];
    let reason: string | null = null;

    let canonHost: string;
    try {
      canonHost = new URL(canonAbs).hostname;
    } catch {
      reason = "canonical 不是合法 URL";
      evidence.push({ fact: "解析 canonical URL 失败" });
      returnAnomaly(out, p, evidence, reason);
      continue;
    }

    if (canonHost !== originHost) {
      reason = "canonical 指向其他域名";
      evidence.push({ fact: "canonical 域名", value: canonHost });
      evidence.push({ fact: "本站域名", value: originHost });
      returnAnomaly(out, p, evidence, reason, ISSUE_SEVERITY.HIGH);
      continue;
    }

    const target = byUrl.get(canonAbs);
    if (target && target.httpStatus >= 400) {
      reason = "canonical 指向 4xx/5xx 页面";
      evidence.push({ fact: "目标状态码", value: target.httpStatus });
      returnAnomaly(out, p, evidence, reason, ISSUE_SEVERITY.HIGH);
      continue;
    }
    if (target && target.redirectChain.length > 0 && target.finalUrl !== target.url) {
      reason = "canonical 指向会跳转的 URL";
      evidence.push({ fact: "目标最终 URL", value: target.finalUrl });
      returnAnomaly(out, p, evidence, reason, ISSUE_SEVERITY.MEDIUM);
    }
  }
  return out;
}

function returnAnomaly(
  out: SiteIssue[],
  p: CrawlPage,
  evidence: IssueEvidence[],
  reason: string,
  severity: IssueSeverity = ISSUE_SEVERITY.MEDIUM
): void {
  out.push(
    makeIssue(
      "canonical-anomaly",
      severity,
      `canonical 异常：${reason}`,
      [p.url],
      evidence,
      "异常 canonical 会向 AI 与搜索引擎传递错误的规范页信号，可能导致页面不被收录。",
      "将 canonical 指向本站内返回 200、无需跳转的最终规范 URL。"
    )
  );
}

/* ------------------------------------------------------------------ */
/* 4. 孤岛页 / 深度过深 / 内链过少                                       */
/* ------------------------------------------------------------------ */

function findOrphans(result: CrawlResult): SiteIssue[] {
  const urls = result.graph.nodes.filter((n) => n.orphan).map((n) => n.url);
  if (urls.length === 0) return [];
  return [
    makeIssue(
      "orphan-page",
      ISSUE_SEVERITY.MEDIUM,
      `${urls.length} 个孤岛页（sitemap 有但站内无内链指向）`,
      urls,
      [
        { fact: "判定依据", value: "in sitemap && inlinks === 0" },
        { fact: "孤岛页面数", value: urls.length },
      ],
      "孤岛页得不到内链权重传递，AI 与爬虫也很难顺着链接发现它们。",
      "从站内相关页面（导航、相关文章、列表页）加入指向这些页面的内链。"
    ),
  ];
}

function findDeepPages(pages: CrawlPage[]): SiteIssue[] {
  const urls = pages.filter((p) => p.clickDepth > DEEP_PAGE_DEPTH).map((p) => p.url);
  if (urls.length === 0) return [];
  return [
    makeIssue(
      "deep-page",
      ISSUE_SEVERITY.LOW,
      `${urls.length} 个页面点击深度 > ${DEEP_PAGE_DEPTH}`,
      urls,
      [
        { fact: "深度阈值", value: DEEP_PAGE_DEPTH },
        { fact: "受影响页面数", value: urls.length },
      ],
      "埋藏过深的页面获得的内链权重与发现概率都更低，AI 引用时也更难触达。",
      "把重要页面提升到距首页 3 次点击以内，或在高频页面增加入口。"
    ),
  ];
}

function findLowInlinks(result: CrawlResult, pages: CrawlPage[]): SiteIssue[] {
  const inlinkOf = new Map(result.graph.nodes.map((n) => [n.url, n.inlinks]));
  const orphanSet = new Set(result.graph.nodes.filter((n) => n.orphan).map((n) => n.url));
  const urls = pages
    .filter((p) => {
      const c = inlinkOf.get(p.url) ?? 0;
      return c < LOW_INLINK_COUNT && !orphanSet.has(p.url);
    })
    .map((p) => p.url);
  if (urls.length === 0) return [];
  return [
    makeIssue(
      "low-inlinks",
      ISSUE_SEVERITY.LOW,
      `${urls.length} 个页面内链过少（入链 < ${LOW_INLINK_COUNT}）`,
      urls,
      [
        { fact: "入链阈值", value: LOW_INLINK_COUNT },
        { fact: "受影响页面数", value: urls.length },
      ],
      "内链稀少意味着页面在站点结构中权重低、主题关联弱，不利于被 AI 检索到。",
      "在正文与相关推荐中自然地增加指向这些页面的上下文内链。"
    ),
  ];
}

/* ------------------------------------------------------------------ */
/* 5. 跳转链过长 / 跳转循环 / 坏链                                       */
/* ------------------------------------------------------------------ */

function findRedirectIssues(pages: CrawlPage[]): SiteIssue[] {
  const out: SiteIssue[] = [];

  // 跳转链过长
  const long = pages.filter((p) => p.redirectChain.length > LONG_REDIRECT_HOPS);
  for (const p of long) {
    out.push(
      makeIssue(
        "long-redirect-chain",
        ISSUE_SEVERITY.LOW,
        `跳转链过长（${p.redirectChain.length} 跳）`,
        [p.url],
        [
          { fact: "跳数", value: p.redirectChain.length },
          { fact: "跳转链", value: p.redirectChain.join(" → ") },
        ],
        "多跳转会稀释权重、拖慢抓取，也增加 AI 抓取超时的概率。",
        "让站内链接直接指向最终 URL，移除中间跳转。"
      )
    );
  }

  // 跳转循环：链中出现重复 URL，或最终跳回起点
  for (const p of pages) {
    const chain = [p.url, ...p.redirectChain];
    const seen = new Set<string>();
    let loop = false;
    for (const u of chain) {
      if (seen.has(u)) {
        loop = true;
        break;
      }
      seen.add(u);
    }
    if (!loop && p.redirectChain.length > 0) {
      const last = p.redirectChain[p.redirectChain.length - 1];
      if (last === p.url) loop = true;
    }
    if (loop) {
      out.push(
        makeIssue(
          "redirect-loop",
          ISSUE_SEVERITY.HIGH,
          "跳转循环：页面沿重定向回到自身",
          [p.url],
          [{ fact: "跳转链", value: chain.join(" → ") }],
          "跳转循环让爬虫和 AI 无法到达真实内容，页面等同于不可访问。",
          "打断循环，让重定向最终落在返回 200 的唯一 URL。"
        )
      );
    }
  }
  return out;
}

function findBrokenInternalLinks(pages: CrawlPage[]): SiteIssue[] {
  // url → httpStatus（已爬集合内可判定）
  const statusOf = new Map(pages.map((p) => [p.url, p.httpStatus]));
  const groups = new Map<string, string[]>(); // 坏目标 → 来源页列表

  for (const p of pages) {
    if (p.blocked || p.httpStatus < 200 || p.httpStatus >= 300) continue;
    for (const target of p.outLinks) {
      const st = statusOf.get(target);
      if (st !== undefined && st >= 400) {
        const arr = groups.get(target);
        if (arr) arr.push(p.url);
        else groups.set(target, [p.url]);
      }
    }
  }

  const out: SiteIssue[] = [];
  for (const [target, sources] of groups) {
    const status = statusOf.get(target);
    out.push(
      makeIssue(
        "broken-internal-link",
        ISSUE_SEVERITY.HIGH,
        `内链指向 ${status} 页面`,
        [...new Set(sources)],
        [
          { fact: "坏链目标", value: target },
          { fact: "目标状态码", value: status ?? 0 },
          { fact: "来源页面数", value: new Set(sources).size },
        ],
        "坏链损害抓取体验与站点可信度，AI 沿链接取证时会直接落空。",
        "修复或移除指向该 URL 的内链；若页面已删除，替换为相关的有效页面。"
      )
    );
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 6. 结构化数据覆盖率                                                  */
/* ------------------------------------------------------------------ */

function findMissingSchema(pages: CrawlPage[]): SiteIssue[] {
  const urls = pages
    .filter((p) => p.wordCount >= SCHEMA_MIN_WORDS && p.jsonLdTypes.length === 0)
    .map((p) => p.url);
  if (urls.length === 0) return [];
  return [
    makeIssue(
      "missing-structured-data",
      ISSUE_SEVERITY.LOW,
      `${urls.length} 个正文页面缺少 JSON-LD 结构化数据`,
      urls,
      [
        { fact: "正文字数阈值", value: SCHEMA_MIN_WORDS },
        { fact: "受影响页面数", value: urls.length },
      ],
      "结构化数据帮助 AI 明确实体类型（文章/产品/组织），缺失会降低内容被正确理解与引用的机会。",
      "按页面类型补充对应的 JSON-LD（如 Article / Product / Organization）。"
    ),
  ];
}

function buildSchemaCoverage(pages: CrawlPage[]): SchemaCoverageEntry[] {
  const total = pages.length;
  const counts = new Map<string, number>();
  for (const p of pages) {
    for (const t of new Set(p.jsonLdTypes)) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([type, n]) => ({ type, pages: n, ratio: total > 0 ? n / total : 0 }))
    .sort((a, b) => b.pages - a.pages);
}

/* ------------------------------------------------------------------ */
/* 7. GEO 低分页面 + 共性弱维度                                         */
/* ------------------------------------------------------------------ */

function findLowGeoScore(pages: CrawlPage[]): SiteIssue[] {
  const critical = pages.filter((p) => p.geoScore < LOW_GEO_SCORE_HIGH);
  const poor = pages.filter(
    (p) => p.geoScore >= LOW_GEO_SCORE_HIGH && p.geoScore < LOW_GEO_SCORE_MEDIUM
  );
  const out: SiteIssue[] = [];

  if (critical.length > 0) {
    out.push(
      makeIssue(
        "low-geo-score",
        ISSUE_SEVERITY.HIGH,
        `${critical.length} 个页面 GEO 评分 < ${LOW_GEO_SCORE_HIGH}`,
        critical.map((p) => p.url),
        [
          { fact: "高分阈值", value: LOW_GEO_SCORE_HIGH },
          ...critical
            .slice(0, 10)
            .map((p) => ({ fact: p.url, value: p.geoScore })),
        ],
        "GEO 低分意味着页面缺少 AI 引用所需的可引用性信号，几乎不会进入模型答案。",
        "对照六维明细逐项补齐：直接回答、实体信息、结构化排版、权威来源等。"
      )
    );
  }
  if (poor.length > 0) {
    out.push(
      makeIssue(
        "low-geo-score",
        ISSUE_SEVERITY.MEDIUM,
        `${poor.length} 个页面 GEO 评分在 ${LOW_GEO_SCORE_HIGH}–${LOW_GEO_SCORE_MEDIUM}`,
        poor.map((p) => p.url),
        [
          { fact: "分数区间", value: `${LOW_GEO_SCORE_HIGH}-${LOW_GEO_SCORE_MEDIUM}` },
          { fact: "受影响页面数", value: poor.length },
        ],
        "中等分数页面有基础内容，但可引用性信号不充分，是性价比最高的优化对象。",
        "优先补该页面最弱的 1–2 个维度，通常能快速跨过及格线。"
      )
    );
  }
  return out;
}

function collectWeakDimensions(pages: CrawlPage[]): Map<string, { label: string; urls: string[] }> {
  const dims = new Map<string, { label: string; urls: string[] }>();
  for (const p of pages) {
    for (const d of p.geoBreakdown ?? []) {
      if (d.max <= 0) continue;
      if (d.score / d.max < WEAK_DIMENSION_RATIO) {
        const entry = dims.get(d.id);
        if (entry) entry.urls.push(p.url);
        else dims.set(d.id, { label: d.label, urls: [p.url] });
      }
    }
  }
  return dims;
}

function findWeakDimensions(pages: CrawlPage[]): SiteIssue[] {
  const dims = collectWeakDimensions(pages);
  const out: SiteIssue[] = [];
  for (const [id, { label, urls }] of dims) {
    if (urls.length < COMMON_WEAK_DIM_MIN_PAGES) continue;
    out.push(
      makeIssue(
        "weak-geo-dimension",
        ISSUE_SEVERITY.MEDIUM,
        `共性弱维度：${label}（${urls.length} 页）`,
        urls,
        [
          { fact: "弱维度", value: label },
          { fact: "维度 id", value: id },
          { fact: "弱维度阈值（score/max）", value: WEAK_DIMENSION_RATIO },
          { fact: "受影响页面数", value: urls.length },
        ],
        `「${label}」在多页面集体偏弱，是拖累整站 GEO 表现的共性原因，单点修补收益最大。`,
        `以站点模板层面统一强化「${label}」，一次改动覆盖所有受影响页面。`
      )
    );
  }
  return out;
}

function buildGeoSummary(pages: CrawlPage[]): GeoSummary {
  const distribution = { critical: 0, poor: 0, fair: 0, good: 0 };
  for (const p of pages) {
    if (p.geoScore < LOW_GEO_SCORE_HIGH) distribution.critical++;
    else if (p.geoScore < LOW_GEO_SCORE_MEDIUM) distribution.poor++;
    else if (p.geoScore < 80) distribution.fair++;
    else distribution.good++;
  }
  const lowestScoring = [...pages]
    .sort((a, b) => a.geoScore - b.geoScore)
    .slice(0, 10)
    .map((p) => ({ url: p.url, geoScore: p.geoScore }));

  const dims = collectWeakDimensions(pages);
  const commonWeakDimensions = [...dims.entries()]
    .map(([id, v]) => ({ id, label: v.label, pages: v.urls.length }))
    .sort((a, b) => b.pages - a.pages);

  return { distribution, lowestScoring, commonWeakDimensions };
}

/* ------------------------------------------------------------------ */
/* 8. 疑似内容重复（shingle Jaccard，结论永远是「疑似」）                */
/* ------------------------------------------------------------------ */

function findDuplicateContent(pages: CrawlPage[]): SiteIssue[] {
  const candidates = pages.filter((p) => (p.contentShingles?.length ?? 0) > 0);
  // 并查集：把高相似页面聚成组，避免两两重复报问题
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    parent.set(find(b), find(a));
  };
  for (const p of candidates) parent.set(p.url, p.url);

  const pairEvidence = new Map<string, { other: string; score: number }[]>();
  const addEvidence = (url: string, other: string, score: number): void => {
    const arr = pairEvidence.get(url) ?? [];
    arr.push({ other, score });
    pairEvidence.set(url, arr);
  };

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      const score = jaccardSimilarity(a.contentShingles!, b.contentShingles!);
      if (score >= DUPLICATE_CONTENT_JACCARD) {
        union(a.url, b.url);
        addEvidence(a.url, b.url, score);
        addEvidence(b.url, a.url, score);
      }
    }
  }

  const groups = new Map<string, string[]>();
  for (const p of candidates) {
    if (!parent.has(p.url)) continue;
    const root = find(p.url);
    const arr = groups.get(root) ?? [];
    arr.push(p.url);
    groups.set(root, arr);
  }

  const out: SiteIssue[] = [];
  for (const urls of groups.values()) {
    if (urls.length < 2) continue;
    const ev: IssueEvidence[] = [
      { fact: "检测方法", value: "正文 5-gram shingle Jaccard 相似度" },
      { fact: "相似度阈值", value: DUPLICATE_CONTENT_JACCARD },
    ];
    for (const u of urls) {
      const pairs = (pairEvidence.get(u) ?? [])
        .filter((x) => urls.includes(x.other))
        .map((x) => `${x.other}（${(x.score * 100).toFixed(0)}%）`)
        .join("；");
      if (pairs) ev.push({ fact: u, value: `相似于 ${pairs}` });
    }
    out.push(
      makeIssue(
        "duplicate-content",
        ISSUE_SEVERITY.MEDIUM,
        `疑似内容重复：${urls.length} 个页面正文大面积雷同`,
        urls,
        ev,
        "高度雷同的页面会被判定为重复内容，彼此分流引用机会；AI 也无法区分该引用哪一个。",
        "合并为单一权威页面并做 canonical 指向，或为每页补充足够的差异化内容。"
      )
    );
  }
  return out;
}
