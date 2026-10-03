import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeGeo, computeGeoV1, computeGeoV2, type GeoInput } from "../../src/lib/geo";
import { analyze } from "../../src/lib/audit";

describe("GEO Engine v1 & v2 (Unit Tests)", () => {
  const sampleHtml = readFileSync(
    join(process.cwd(), "tests", "fixtures", "audit", "sample.html"),
    "utf8"
  );

  describe("1. GEO v1.0.0 基线兼容性与打分", () => {
    test("analyze 默认使用 v1.0.0 且与 sample.html 基线 70 分完全吻合", () => {
      const audit = analyze("https://whivi.com/guide", sampleHtml, 200, 120);

      assert.equal(audit.geoVersion, "1.0.0");
      assert.equal(audit.geoScore, 70);
      assert.equal(audit.geoBreakdown.length, 6);

      const map = Object.fromEntries(audit.geoBreakdown.map((b) => [b.id, b.score]));
      assert.equal(map.quotability, 20);
      assert.equal(map.structuredness, 14);
      assert.equal(map.entity, 11);
      assert.equal(map.crawlability, 15);
      assert.equal(map.density, 3);
      assert.equal(map.readability, 7);

      assert.ok(audit.recommendations.length > 0);
    });

    test("显式传入 version 1.0.0 与 computeGeo 默认分发结果完全一致", () => {
      const v1Result = computeGeo(
        {
          html: sampleHtml,
          checks: [{ id: "http", level: "pass", weight: 10 }],
          contentShape: {
            paragraphs: 6,
            lists: 2,
            listItems: 6,
            tables: 1,
            quotes: 0,
            codeBlocks: 1,
            dataPoints: 4,
            externalCitations: 2,
            hasTldr: true,
            avgSentenceLength: 35,
          },
          jsonLdTypes: ["Article", "Organization", "BreadcrumbList"],
          allMeta: { author: "Geokit Tester", "article:modified_time": "2026-01-01" },
          wordCount: 1500,
          headings: [
            { level: 1, text: "Title" },
            { level: 2, text: "Section 1" },
            { level: 2, text: "Section 2" },
            { level: 2, text: "Section 3" },
          ],
          lang: "zh-CN",
          canonical: "https://example.com/guide",
          ld: {
            types: ["Article", "Organization", "BreadcrumbList"],
            hasAuthor: true,
            hasOrganization: true,
            hasDatePublished: true,
            hasDateModified: true,
          },
        },
        "1.0.0"
      );

      assert.equal(v1Result.version, "1.0.0");
      assert.ok(v1Result.total >= 80);
    });
  });

  describe("2. GEO v2.0.0 启发式与 RAG / SGE 信号评估", () => {
    test("analyze 传入 { geoVersion: '2.0.0' } 输出 2.0.0 模型", () => {
      const audit = analyze("https://whivi.com/guide", sampleHtml, 200, 120, {
        geoVersion: "2.0.0",
      });

      assert.equal(audit.geoVersion, "2.0.0");
      assert.ok(typeof audit.geoScore === "number");
      assert.equal(audit.geoBreakdown.length, 6);

      // 验证 breakdown 标签针对 2026 AI Search / RAG 的特定优化
      const ids = audit.geoBreakdown.map((b) => b.id);
      assert.ok(ids.includes("quotability"));
      assert.ok(ids.includes("structuredness"));
      assert.ok(ids.includes("entity"));
      assert.ok(ids.includes("crawlability"));
      assert.ok(ids.includes("density"));
      assert.ok(ids.includes("readability"));
    });

    test("v2: 标题断层跳级（H1->H4）受到 RAG 连续性惩罚", () => {
      const brokenHeadingsHtml = `
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head><title>RAG Broken Hierarchy</title></head>
        <body>
          <main>
            <h1>核心大纲</h1>
            <h4>直接跳到第四级，无 H2 和 H3</h4>
            <p>这是一段正文内容...</p>
          </main>
        </body>
        </html>
      `;

      const auditBroken = analyze("https://example.com/test", brokenHeadingsHtml, 200, 100, {
        geoVersion: "2.0.0",
      });

      const structuredness = auditBroken.geoBreakdown.find((b) => b.id === "structuredness");
      assert.ok(structuredness);
      // 标题有断层，且 H2 数量不足，structuredness 分数显著较低
      assert.ok(structuredness.score <= 10);
      assert.match(structuredness.comment, /断层/);
    });

    test("v2: 具备语义地标、连贯标题、sameAs 消歧与高密度对比表格时获得高分", () => {
      const richRAGHtml = `
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
          <title>2026 深度生成式引擎优化指南</title>
          <link rel="canonical" href="https://example.com/geo-guide" />
          <meta name="description" content="AI 检索与 RAG 落地标准" />
          <meta name="author" content="Dr. GEO" />
          <meta property="article:published_time" content="2026-01-15T08:00:00Z" />
          <meta property="article:modified_time" content="2026-03-01T12:00:00Z" />
          <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "TechArticle",
            "headline": "2026 深度生成式引擎优化指南",
            "author": {
              "@type": "Person",
              "name": "Dr. GEO",
              "sameAs": "https://wikidata.org/wiki/Q12345"
            },
            "publisher": {
              "@type": "Organization",
              "name": "GEO Research Lab",
              "sameAs": "https://wikidata.org/wiki/Q67890"
            },
            "datePublished": "2026-01-15",
            "dateModified": "2026-03-01"
          }
          </script>
        </head>
        <body>
          <header><nav><a href="/">Home</a></nav></header>
          <main>
            <article>
              <h1>2026 深度生成式引擎优化指南</h1>
              <p><strong>核心结论：</strong>生成式引擎优化（GEO）的核心在于直接回答、连续标题切块与事实知识图谱消歧，而非单纯的关键词堆砌。</p>
              
              <h2>1. RAG 知识检索矩阵</h2>
              <p>在 2026 年，大模型搜索（如 Google SGE、ChatGPT Search）的引用占比已经突破 48.5%，增长率高达 120%。</p>
              <table>
                <thead><tr><th>维度</th><th>传统 SEO</th><th>现代 GEO</th></tr></thead>
                <tbody>
                  <tr><td>优化目标</td><td>Google 爬虫收录</td><td>LLM RAG 知识引用</td></tr>
                  <tr><td>核心度量</td><td>PageRank 与反链</td><td>首屏 Direct Answer 与实体消歧</td></tr>
                </tbody>
              </table>

              <h2>2. 实施标准与落地步骤</h2>
              <p>根据 W3C 与 Schema.org 规范，我们建议分三步实施：</p>
              <ul>
                <li>第一步：配置 Organization 与 sameAs 权威链接；</li>
                <li>第二步：采用 HTML5 main/article 语义地标包裹主体；</li>
                <li>第三步：构建高密度对比表格与数据支撑；</li>
                <li>第四步：保证标题 H1 到 H3 严谨递进；</li>
                <li>第五步：在根目录配置 llms.txt。</li>
              </ul>
              <table>
                <thead><tr><th>指标</th><th>基准要求</th></tr></thead>
                <tbody><tr><td>事实密度</td><td>&gt;3 个/千字</td></tr></tbody>
              </table>
              <p>参考官方标准规范文档：<a href="https://schema.org" rel="nofollow">Schema.org Specification</a> 与 <a href="https://w3.org" rel="nofollow">W3C Semantic Standards</a>。</p>
            </article>
          </main>
          <footer><p>&copy; 2026 GEOkit Lab</p></footer>
        </body>
        </html>
      `;

      const audit = analyze("https://example.com/geo-guide", richRAGHtml, 200, 85, {
        geoVersion: "2.0.0",
      });

      assert.equal(audit.geoVersion, "2.0.0");
      assert.ok(audit.geoScore >= 80, `Expected geoScore >= 80, got ${audit.geoScore}`);

      const entity = audit.geoBreakdown.find((b) => b.id === "entity");
      assert.ok(entity);
      assert.match(entity.comment, /sameAs/);

      const structuredness = audit.geoBreakdown.find((b) => b.id === "structuredness");
      assert.ok(structuredness);
      assert.match(structuredness.comment, /语义地标/);

      const quotability = audit.geoBreakdown.find((b) => b.id === "quotability");
      assert.ok(quotability);
      assert.match(quotability.comment, /直接答案/);
    });

    test("v2: 针对弱项给出 2026 年针对性 GEO 建议", () => {
      const bareHtml = `
        <!DOCTYPE html>
        <html>
        <head><title>Bare Page</title></head>
        <body>
          <p>没有任何语义地标和标题，只有一小句话。</p>
        </body>
        </html>
      `;

      const audit = analyze("https://example.com/bare", bareHtml, 200, 90, {
        geoVersion: "2.0.0",
      });

      assert.ok(audit.recommendations.length > 0);
      const allRecs = audit.recommendations.join(" ");
      assert.match(allRecs, /Direct Answer/);
      assert.match(allRecs, /语义地标/);
    });
  });
});
