import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractCitations } from "../../src/lib/visibility/parser";
import { analyzeCitations } from "../../src/lib/visibility/aggregate";
import type { CitationRecord } from "../../src/lib/evidence/types";

describe("T2: AI Citation Intelligence (Parser)", () => {
  it("正常包含引用的回答", () => {
    const raw = "这是一个带链接的回答：[GEOkit](https://github.com/WilstonZhou/geokit) 和直接链接 https://example.com/page。";
    const result = extractCitations(raw, "query1", "model1", true, "brand1", ["competitor1"]);
    assert.equal(result.citationsStatus, "ok");
    assert.equal(result.citations?.length, 2);
    assert.equal(result.citations[0].url, "https://github.com/WilstonZhou/geokit");
    assert.equal(result.citations[0].title, "GEOkit");
    assert.equal(result.citations[1].url, "https://example.com/page");
  });

  it("无引用的泛泛回答", () => {
    const raw = "这是一个没有任何链接的纯文本回复，模型没有给出引用。";
    const result = extractCitations(raw, "query2", "model2", false, "brand1");
    assert.equal(result.citationsStatus, "unavailable");
    assert.equal(result.citations?.length, 0);
  });

  it("模型拒答 / 403 (Blocked)", () => {
    const raw = "抱歉，我无法回答这个问题。";
    const result = extractCitations(raw, "query3", "model3", false, "brand1");
    assert.equal(result.citationsStatus, "unavailable");
    assert.equal(result.citations?.length, 0);
  });

  it("提及上下文与竞品分析", () => {
    const raw = "根据对比，我们的 brand1 比 competitorA 更好，但 competitorB 也很强。";
    const result = extractCitations(raw, "query4", "model4", true, "brand1", ["competitorA", "competitorB", "competitorC"]);
    assert.equal(result.competitorsMentioned?.length, 2);
    assert.ok(result.competitorsMentioned.includes("competitorA"));
    assert.ok(result.competitorsMentioned.includes("competitorB"));
    assert.ok(result.mentionContext !== undefined);
    assert.ok(result.mentionContext.includes("brand1"));
  });
});

describe("T2: Citation Aggregate Analysis", () => {
  it("聚合分析缺口计算", () => {
    const records: CitationRecord[] = [
      {
        query: "q1", model: "m1", answerText: "", mentioned: false, observedAt: "",
        citationsStatus: "ok", competitorsMentioned: ["comp1"],
        citations: [
          { url: "https://wikipedia.org/page1" },
          { url: "https://example.com/page1" }
        ]
      },
      {
        query: "q2", model: "m2", answerText: "", mentioned: false, observedAt: "",
        citationsStatus: "ok", competitorsMentioned: ["comp2"],
        citations: [
          { url: "https://wikipedia.org/page2" },
          { url: "https://competitor.com/product" }
        ]
      }
    ];

    const agg = analyzeCitations(records, "example.com");
    
    assert.equal(agg.domainRanking[0].domain, "wikipedia.org");
    assert.equal(agg.domainRanking[0].count, 2);

    // citation gap excludes example.com but includes wikipedia.org which has count=2
    assert.equal(agg.citationGap.length, 1);
    assert.equal(agg.citationGap[0].domain, "wikipedia.org");

    assert.equal(agg.competitorFrequency.length, 2);
  });
});
