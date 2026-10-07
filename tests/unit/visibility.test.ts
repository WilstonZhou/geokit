import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractCitations } from "../../src/lib/visibility/parser";
import { analyzeCitations, diffCitationRecords } from "../../src/lib/visibility/aggregate";
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

describe("T2: Citation Diff（同一 query 集合前后两次观测）", () => {
  function rec(
    query: string,
    model: string,
    mentioned: boolean,
    urls: string[],
    observedAt: string
  ): CitationRecord {
    return {
      query,
      model,
      answerText: "",
      mentioned,
      citations: urls.map((url) => ({ url })),
      citationsStatus: urls.length > 0 ? "ok" : "unavailable",
      competitorsMentioned: [],
      observedAt,
    };
  }

  it("新增提及 / 失去提及 / 无变化", () => {
    const prev = [
      rec("q1", "m1", false, ["https://a.com"], "2026-10-01T00:00:00Z"),
      rec("q2", "m1", true, [], "2026-10-01T00:00:00Z"),
      rec("q3", "m1", true, ["https://c.com"], "2026-10-01T00:00:00Z"),
    ];
    const cur = [
      rec("q1", "m1", true, ["https://a.com"], "2026-10-02T00:00:00Z"),
      rec("q2", "m1", false, [], "2026-10-02T00:00:00Z"),
      rec("q3", "m1", true, ["https://c.com"], "2026-10-02T00:00:00Z"),
    ];
    const diff = diffCitationRecords(prev, cur);
    const byQuery = new Map(diff.map((d) => [d.query, d]));
    assert.equal(byQuery.get("q1")!.mention, "added");
    assert.equal(byQuery.get("q2")!.mention, "lost");
    assert.equal(byQuery.get("q3")!.mention, "unchanged");
  });

  it("引用 URL 的增加与消失", () => {
    const prev = [rec("q", "m", true, ["https://old.com", "https://keep.com"], "2026-10-01T00:00:00Z")];
    const cur = [rec("q", "m", true, ["https://new.com", "https://keep.com"], "2026-10-02T00:00:00Z")];
    const [entry] = diffCitationRecords(prev, cur);
    assert.deepEqual(entry.citationsAdded, ["https://new.com"]);
    assert.deepEqual(entry.citationsLost, ["https://old.com"]);
    assert.equal(entry.hasPrevious, true);
  });

  it("无前值时 hasPrevious=false，不做编造", () => {
    const cur = [rec("q-new", "m", true, ["https://x.com"], "2026-10-02T00:00:00Z")];
    const [entry] = diffCitationRecords([], cur);
    assert.equal(entry.hasPrevious, false);
    assert.equal(entry.mention, null);
    assert.deepEqual(entry.citationsAdded, []);
  });

  it("当前运行刚写入存档的记录不会被误当成前值（observedAt 需严格更早）", () => {
    const same = "2026-10-02T00:00:00Z";
    const cur = [rec("q", "m", true, ["https://x.com"], same)];
    // 前值集合里混入了本次运行的记录（observedAt 相同 / 更晚）→ 不可作为前值
    const prev = [
      rec("q", "m", false, ["https://stale.com"], same),
      rec("q", "m", false, ["https://later.com"], "2026-10-03T00:00:00Z"),
    ];
    const [entry] = diffCitationRecords(prev, cur);
    assert.equal(entry.hasPrevious, false);
  });
});
