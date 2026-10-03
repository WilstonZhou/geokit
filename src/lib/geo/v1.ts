import type { GeeBreakdown, GeoInput, GeoResult } from "./types";

/**
 * GEO 1.0.0 评分实现（基线与历史兼容）。
 *
 * 保持与 2024-2025 初始版本的精确一致性，确保基线回归测试无差异。
 */
export function computeGeoV1(input: GeoInput): GeoResult {
  const { contentShape: s, jsonLdTypes, allMeta, wordCount, checks } = input;

  // 1. 可引用性 Quotability (25)
  let quotability = 0;
  if (s.hasTldr) quotability += 8;
  if (s.lists > 0) quotability += Math.min(6, s.lists * 2);
  if (s.listItems >= 5) quotability += 3;
  if (s.tables > 0) quotability += Math.min(5, s.tables * 3);
  if (s.dataPoints >= 3) quotability += 5;
  else if (s.dataPoints > 0) quotability += 2;
  if (s.quotes > 0) quotability += 2;
  quotability = Math.min(25, quotability);

  // 2. 结构化 Structuredness (20)
  let structuredness = 0;
  if (jsonLdTypes.length >= 3) structuredness += 8;
  else if (jsonLdTypes.length > 0) structuredness += 4;
  const hCounts = [1, 2, 3].map((l) => input.headings.filter((h) => h.level === l).length);
  if (hCounts[0] >= 1) structuredness += 4;
  if (hCounts[1] >= 3) structuredness += 4;
  else if (hCounts[1] > 0) structuredness += 2;
  if (s.paragraphs >= 5) structuredness += 2;
  if (input.canonical) structuredness += 2;
  structuredness = Math.min(20, structuredness);

  // 3. 实体清晰度 Entity Clarity (15)
  let entity = 0;
  if (
    jsonLdTypes.some((t) => /Organization|Corporation|LocalBusiness/i.test(t)) ||
    input.ld.hasOrganization
  ) {
    entity += 4;
  }
  if (jsonLdTypes.some((t) => /Article|BlogPosting|NewsArticle|Product/i.test(t))) entity += 4;
  if (allMeta.author || input.ld.hasAuthor) entity += 3;
  if (
    allMeta["article:published_time"] ||
    allMeta.date ||
    allMeta.pubdate ||
    input.ld.hasDatePublished
  ) {
    entity += 2;
  }
  if (input.ld.hasAuthor || jsonLdTypes.some((t) => /Person/i.test(t))) entity += 2;
  entity = Math.min(15, entity);

  // 4. 可抓取性 Crawlability (15)
  const crawl = checks.find((c) => c.id === "robots");
  let crawlability = 6;
  if (crawl?.level === "fail") crawlability = 0;
  if (input.lang) crawlability += 3;
  if (input.canonical) crawlability += 2;
  if (checks.find((c) => c.id === "http")?.level === "pass") crawlability += 2;
  if (wordCount > 0) crawlability += 2;
  crawlability = Math.min(15, crawlability);

  // 5. 事实密度 Fact Density (15)
  const density = s.dataPoints / (Math.max(wordCount, 300) / 1000);
  let factDensity = 0;
  if (wordCount >= 1200) factDensity += 4;
  else if (wordCount >= 600) factDensity += 2;
  if (density >= 3) factDensity += 6;
  else if (density >= 1.5) factDensity += 4;
  else if (density > 0) factDensity += 2;
  if (s.externalCitations >= 3) factDensity += 5;
  else if (s.externalCitations > 0) factDensity += 2;
  if (wordCount < 300) factDensity = Math.min(factDensity, 3);
  factDensity = Math.min(15, factDensity);

  // 6. 可读性 / 时效性 Readability & Freshness (10)
  let readability = 0;
  if (s.avgSentenceLength > 0 && s.avgSentenceLength <= 45) readability += 4;
  else if (s.avgSentenceLength <= 70) readability += 2;
  if (
    allMeta["article:modified_time"] ||
    allMeta["og:updated_time"] ||
    input.ld.hasDateModified
  ) {
    readability += 3;
  }
  if (allMeta["article:published_time"] || input.ld.hasDatePublished) readability += 3;
  readability = Math.min(10, readability);

  const breakdown: GeeBreakdown[] = [
    {
      id: "quotability",
      label: "可引用性",
      score: quotability,
      max: 25,
      comment: s.hasTldr
        ? `有结论前置，检测到 ${s.dataPoints} 个数据点、${s.lists} 个列表${s.tables ? `、${s.tables} 张表格` : ""}`
        : "缺少 TL;DR 式的结论前置，AI 难以抽取可引用的片段",
    },
    {
      id: "structuredness",
      label: "结构化",
      score: structuredness,
      max: 20,
      comment: jsonLdTypes.length
        ? `检测到 ${jsonLdTypes.length} 类 schema`
        : "无 JSON-LD，AI 无法确认页面实体类型",
    },
    {
      id: "entity",
      label: "实体清晰度",
      score: entity,
      max: 15,
      comment: entity >= 10 ? "作者/组织/时间标注较完整" : "缺少作者或组织署名，影响了权威性判断",
    },
    {
      id: "crawlability",
      label: "可抓取性",
      score: crawlability,
      max: 15,
      comment: crawl?.level === "fail" ? "noindex 会让 AI 完全看不到这个页面" : "抓取通道正常",
    },
    {
      id: "density",
      label: "事实密度",
      score: factDensity,
      max: 15,
      comment: `每千字 ${density.toFixed(1)} 个数据点，外链引用 ${s.externalCitations} 处`,
    },
    {
      id: "readability",
      label: "可读性/时效",
      score: readability,
      max: 10,
      comment: `平均句长 ${s.avgSentenceLength} 字${allMeta["article:modified_time"] ? "，有更新时间标记" : "，未标注更新时间"}`,
    },
  ];

  const total = breakdown.reduce((acc, b) => acc + b.score, 0);

  const recommendations: string[] = [];
  for (const b of breakdown) {
    const ratio = b.score / b.max;
    if (ratio >= 0.75) continue;
    switch (b.id) {
      case "quotability":
        recommendations.push(
          "在正文开头加一段 3-5 行的「核心结论」，并把关键数据做成项目符号或表格 —— 这是 AI 摘要最常搬运的部分。"
        );
        break;
      case "structuredness":
        recommendations.push(
          "补 JSON-LD：Organization + Article + BreadcrumbList 三件套，并保证 H2 层级不少于 3 个。"
        );
        break;
      case "entity":
        recommendations.push(
          "标注 author / published_time / modified_time，让 AI 知道「谁在什么时候说的」—— 无名无日期的内容引用率显著更低。"
        );
        break;
      case "crawlability":
        recommendations.push(
          "检查 robots.txt 与 meta robots；同时在站点根目录放 llms.txt 向 AI 爬虫显式开放优质内容。"
        );
        break;
      case "density":
        recommendations.push(
          "增加具体数据（金额、比例、时间点）并引用权威外链，把观点变成可验证的事实。"
        );
        break;
      case "readability":
        recommendations.push(
          "拆分超过 45 字的长句；补充 article:modified_time 表达内容仍在维护。"
        );
        break;
    }
  }
  if (recommendations.length === 0) {
    recommendations.push("GEO 各项表现良好，保持定期复核即可。");
  }

  return {
    version: "1.0.0",
    total,
    breakdown,
    recommendations,
  };
}
