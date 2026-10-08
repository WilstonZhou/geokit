import type { GeeBreakdown, GeoInput, GeoResult } from "./types";

/**
 * GEO 2.0.0 评分实现（2026 AI Search & RAG Grounding 启发式标准）。
 *
 * 核心升级点：
 * 1. 结构化消歧与 E-E-A-T 深度：评估 JSON-LD 的 sameAs / identifier 权威关联度。
 * 2. RAG Chunking（分块）友好度：评估 H1->H2->H3 层级连续性（跳级惩罚）与 HTML5 语义地标（<main>/<article>）。
 * 3. 首屏确定性直接回答（Direct Answer）：优先于泛泛的概述，直接满足大模型 Grounding 摘录需求。
 * 4. 密集比较表格与结构化对比：大模型生成搜索摘要/卡片时最优先搬运的高密度形态。
 *
 * ★ scoringVersion 2.1.0（T9 内容质量增强）：在保持六维 max 与总分 100 不变前提下，
 *   新增 5 个可观测信号（各维内部子权重重分配，不新增并行总分）：
 *   - 可引用性 +1.6 FAQ/Q&A 结构（hasFaqStructure）
 *   - 结构化 +2.5 结构化元素密度（structuredElementDensity）
 *   - 实体清晰度 +3.5 作者权威链接（hasAuthorAuthority）
 *   - 事实密度 +5.4 权威来源（hasAuthoritativeSources）
 *   - 可读性/时效 +6.3 更新时间一致性（hasDateConsistency）
 *   第 4 维（可抓取性）页面级信号已饱和，不新增。v1 基线冻结不动。
 */
export function computeGeoV2(input: GeoInput): GeoResult {
  const { contentShape: s, jsonLdTypes, allMeta, wordCount, checks, ld } = input;

  // 1. 可引用性 Quotability (25)
  //    聚焦大模型问答首选信源：首屏直接答案、对比表格、步骤列表、数据点与 FAQ 结构
  let quotability = 0;

  // 1.1 首屏高置信度直接回答 (7) —— v2.1: 8→7 为 1.6 FAQ 让权
  if (s.hasDirectAnswer || s.hasTldr) {
    quotability += 7;
  }

  // 1.2 结构化表格 (5) —— v2.1: 6→5 为 1.6 让权
  if (s.tables >= 2) {
    quotability += 5;
  } else if (s.tables === 1) {
    quotability += 3;
  }

  // 1.3 步骤或要点列表 (4) —— v2.1: 5→4 为 1.6 让权
  if (s.listItems >= 5) {
    quotability += 4;
  } else if (s.lists > 0 || s.listItems > 0) {
    quotability += 2;
  }

  // 1.4 量化硬数据点 (4)
  if (s.dataPoints >= 3) {
    quotability += 4;
  } else if (s.dataPoints > 0) {
    quotability += 2;
  }

  // 1.5 引用与引申 (2)
  if (s.quotes > 0 || s.codeBlocks > 0) {
    quotability += 2;
  }

  // 1.6 FAQ/Q&A 结构 (3) —— v2.1 新增：AI 问答搬运首选形态
  if (s.hasFaqStructure) {
    quotability += 3;
  }

  quotability = Math.min(25, quotability);

  // 2. 结构化与 RAG 分块 Structuredness (20)
  //    聚焦 RAG 切块引擎的上下文还原质量：标题严谨无断层、语义容器隔离噪点、Schema 丰富
  let structuredness = 0;

  // 2.1 标题层级连续性与骨架 (5) —— v2.1: 6→5 为 2.5 让权
  const hCounts = [1, 2, 3].map((l) => input.headings.filter((h) => h.level === l).length);
  const hasH1 = hCounts[0] >= 1;
  const hasSufficientH2 = hCounts[1] >= 2;
  const isContinuous = s.headingContinuity ?? true;

  if (hasH1 && hasSufficientH2 && isContinuous) {
    structuredness += 5;
  } else if (hasH1 && (hasSufficientH2 || isContinuous)) {
    structuredness += 3;
  } else if (input.headings.length > 0) {
    structuredness += 2;
  }

  // 2.2 HTML5 语义地标容器 (<main> / <article>) (4)
  if (s.hasSemanticLandmarks) {
    structuredness += 4;
  }

  // 2.3 深度 Schema.org 知识图谱 (6)
  if (jsonLdTypes.length >= 3) {
    structuredness += 6;
  } else if (jsonLdTypes.length > 0) {
    structuredness += 3;
  }

  // 2.4 内容分块基底与规范链接 (3) —— v2.1: 4→3 为 2.5 让权
  if (s.paragraphs >= 4) structuredness += 2;
  if (input.canonical) structuredness += 1;

  // 2.5 结构化元素密度 (2) —— v2.1 新增：列表/表格相对段落的占比
  const sed = s.structuredElementDensity ?? 0;
  if (sed >= 0.5) {
    structuredness += 2;
  } else if (sed > 0) {
    structuredness += 1;
  }

  structuredness = Math.min(20, structuredness);

  // 3. 实体清晰度与 E-E-A-T 消歧 Entity Clarity (15)
  //    聚焦大模型知识图谱消歧（Wikidata/sameAs）与创作责任归属
  let entity = 0;

  // 3.1 权威实体声明 (4)
  if (
    jsonLdTypes.some((t) => /Organization|Corporation|LocalBusiness/i.test(t)) ||
    ld.hasOrganization
  ) {
    entity += 4;
  }

  // 3.2 实体消歧属性 sameAs / 权威链接 (3) —— v2.1: 4→3 为 3.5 让权
  if (ld.hasSameAs) {
    entity += 3;
  } else if (allMeta.author || ld.hasAuthor) {
    entity += 2;
  }

  // 3.3 署名归属 (2) —— v2.1: 3→2 为 3.5 让权
  if (allMeta.author || ld.hasAuthor || jsonLdTypes.some((t) => /Person/i.test(t))) {
    entity += 2;
  }

  // 3.4 时效锚点 (4) —— 同时具备发布与修改更佳
  if (allMeta["article:published_time"] || allMeta.date || ld.hasDatePublished) {
    entity += 2;
  }
  if (allMeta["article:modified_time"] || allMeta["og:updated_time"] || ld.hasDateModified) {
    entity += 2;
  }

  // 3.5 作者权威链接 (2) —— v2.1 新增：作者 sameAs 或 article:author + 主页链接
  if (s.hasAuthorAuthority) {
    entity += 2;
  }

  entity = Math.min(15, entity);

  // 4. 可抓取性与 AI 协议 Crawlability (15)
  //    通道健康度与多语言嵌入空间声明
  const crawl = checks.find((c) => c.id === "robots");
  let crawlability = 6;
  if (crawl?.level === "fail") crawlability = 0;

  // 4.1 显式语言属性（多语言分词与 Embedding 路由关键） (3)
  if (input.lang) crawlability += 3;

  // 4.2 规范与传输状态 (4)
  if (input.canonical) crawlability += 2;
  if (checks.find((c) => c.id === "http")?.level === "pass") crawlability += 2;

  // 4.3 有效正文载荷 (2)
  if (wordCount > 100) crawlability += 2;

  crawlability = Math.min(15, crawlability);

  // 5. 事实密度与信息增益 Fact Density (15)
  //    衡量内容是否提供可验证的增量价值，而非泛泛空话
  const density = s.dataPoints / (Math.max(wordCount, 300) / 1000);
  let factDensity = 0;

  // 5.1 数据密度 (6)
  if (density >= 3) factDensity += 6;
  else if (density >= 1.5) factDensity += 4;
  else if (density > 0) factDensity += 2;

  // 5.2 正文体量深度 (4) —— v2.1: 5→4 为 5.4 让权
  if (wordCount >= 1500) factDensity += 4;
  else if (wordCount >= 800) factDensity += 2;
  else if (wordCount >= 400) factDensity += 1;

  // 5.3 外部参考引用 (3) —— v2.1: 4→3 为 5.4 让权（从数量转向质量）
  if (s.externalCitations >= 3) factDensity += 3;
  else if (s.externalCitations > 0) factDensity += 2;

  // 5.4 权威来源 (2) —— v2.1 新增：gov/edu/mil 等权威信源
  if (s.hasAuthoritativeSources) {
    factDensity += 2;
  }

  // 正文过薄防御
  if (wordCount < 300) factDensity = Math.min(factDensity, 3);
  factDensity = Math.min(15, factDensity);

  // 6. 语义分词适配度与维护活跃度 Readability & Freshness (10)
  let readability = 0;

  // 6.1 句子长度（大模型注意力与滑动窗口分块最优区间 15-45 字符/词） (4) —— v2.1: 5→4 为 6.3 让权
  if (s.avgSentenceLength >= 10 && s.avgSentenceLength <= 45) {
    readability += 4;
  } else if (s.avgSentenceLength <= 65) {
    readability += 2;
  }

  // 6.2 维护鲜活度 (4) —— v2.1: 5→4 为 6.3 让权
  if (allMeta["article:modified_time"] || allMeta["og:updated_time"] || ld.hasDateModified) {
    readability += 2;
  }
  if (allMeta["article:published_time"] || ld.hasDatePublished) {
    readability += 2;
  }

  // 6.3 更新时间一致性 (2) —— v2.1 新增：modified >= published 且距今 ≤1 年
  if (s.hasDateConsistency) {
    readability += 2;
  }

  readability = Math.min(10, readability);

  const breakdown: GeeBreakdown[] = [
    {
      id: "quotability",
      label: "可引用性",
      score: quotability,
      max: 25,
      comment: (s.hasDirectAnswer || s.hasTldr)
        ? `首屏具备直接答案/结论，含 ${s.dataPoints} 个量化数据点、${s.lists} 个列表${s.tables ? `、${s.tables} 张对比表格` : ""}${s.hasFaqStructure ? "、FAQ/Q&A 结构" : ""}`
        : "缺少首屏直接回答（Direct Answer）或 TL;DR 摘要，AI 难以提取首推引用块",
    },
    {
      id: "structuredness",
      label: "结构化/RAG",
      score: structuredness,
      max: 20,
      comment: isContinuous
        ? `标题层级严谨连续，${s.hasSemanticLandmarks ? "使用语义地标 (<main>/<article>)，" : ""}检测到 ${jsonLdTypes.length} 类 Schema，结构化元素密度 ${(s.structuredElementDensity ?? 0).toFixed(2)}`
        : "检测到标题层级断层跳跃，易破坏 RAG 递归分块器的上下文继承关系",
    },
    {
      id: "entity",
      label: "实体清晰度/E-E-A-T",
      score: entity,
      max: 15,
      comment: ld.hasSameAs
        ? "实体声明完整，具备 sameAs/identifier 知识库消歧属性"
        : s.hasAuthorAuthority
        ? "作者权威链接齐备，建议补充实体级 sameAs 消歧"
        : entity >= 8
        ? "实体与时间标记基本齐备，建议补充 sameAs 权威消歧与作者资质"
        : "缺少明确组织、作者或消歧链接，削弱了大模型图谱的置信度",
    },
    {
      id: "crawlability",
      label: "可抓取性/协议",
      score: crawlability,
      max: 15,
      comment: crawl?.level === "fail"
        ? "noindex 拦截导致 AI 引擎完全不可见"
        : input.lang
        ? `通道正常且声明了 lang="${input.lang}"（有助于跨语言 Embedding 对齐）`
        : "通道正常但未声明 lang 属性，影响多语言分词器空间判定",
    },
    {
      id: "density",
      label: "事实密度",
      score: factDensity,
      max: 15,
      comment: `每千字 ${density.toFixed(1)} 个量化指标，外链一手引用 ${s.externalCitations} 处${s.hasAuthoritativeSources ? "（含 gov/edu 等权威来源）" : ""}，字数 ${wordCount}`,
    },
    {
      id: "readability",
      label: "分块适配/时效",
      score: readability,
      max: 10,
      comment: `平均句长 ${s.avgSentenceLength}（适配注意力分块）${(allMeta["article:modified_time"] || ld.hasDateModified) ? "，标注了最新修订时间" : "，缺少更新时间戳"}${s.hasDateConsistency ? "，时间一致性校验通过" : "，时间一致性未通过"}`,
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
          "在正文首屏配置 100-200 字的高确定性直接回答（Direct Answer），并用 Markdown/HTML 比较表格或步骤列表罗列核心结论；若内容属问答型，建议用 FAQPage JSON-LD 或疑问句 heading + 答案段落结构，最大化 AI 问答引用率。"
        );
        break;
      case "structuredness":
        recommendations.push(
          "保证标题层级严谨递进（避免 H1 直接跳至 H3/H4），并使用 <main> 或 <article> 语义地标包裹主体，防止 RAG 分块引擎将侧边栏噪点误切入知识片段；适度增加列表/表格占比提升结构化元素密度。"
        );
        break;
      case "entity":
        recommendations.push(
          "在 JSON-LD 的 Organization/Person 实体中补充 sameAs 属性（如官方维基或社媒主页），明确声明 author 与 modified_time；并为作者补充 sameAs 权威链接（Wikidata/LinkedIn/官网主页）助力大模型知识图谱精准消歧。"
        );
        break;
      case "crawlability":
        recommendations.push(
          "检查 robots 配置；在 <html> 标签显式声明 lang（如 zh-CN），并在站点根目录配置 llms.txt 显式向 AI 爬虫指引高权重索引路线。"
        );
        break;
      case "density":
        recommendations.push(
          "提高客观事实密度（每千字建议包含至少 3 处带量化单位、百分比或明确年份的数据点），并外链引用权威一手信源（.gov/.edu 或官方机构域名）以提升信息增益（Information Gain）。"
        );
        break;
      case "readability":
        recommendations.push(
          "长句压缩至 45 字以内以提高滑动窗口分块注意力集中度；同步声明 article:modified_time，确保 modified_time ≥ published_time 且距今 ≤1 年以通过时间一致性校验。"
        );
        break;
    }
  }
  if (recommendations.length === 0) {
    recommendations.push("GEO 2.1 各项指标表现优异，符合 2026 AI Search & RAG 最佳实践。");
  }

  return {
    version: "2.0.0",
    // ★ T9: scoringVersion 2.0.0 → 2.1.0 —— 新增 FAQ/结构化密度/作者权威/权威来源/时间一致性 5 个信号
    scoringVersion: "2.1.0",
    total,
    breakdown,
    recommendations,
  };
}
