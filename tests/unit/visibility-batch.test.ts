import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { batchProbeVisibility } from "../../src/lib/services/visibility";
import type { VisibilityReport, VisibilityProbe } from "../../src/lib/visibility";
import type { CitationRecord } from "../../src/lib/evidence/types";

/**
 * T2 验收要求：批量探测使用可注入的假 probe，不访问真实外网。
 * 覆盖：有引用 / 无引用（unavailable）/ 拒答（INDETERMINATE）/ 超时与 HTTP 错误（抛异常）。
 */

function fakeCitation(topic: string, model: string, urls: string[]): CitationRecord {
  return {
    query: topic,
    model,
    answerText: urls.length > 0 ? `见 ${urls.join("、")}` : "无可引用的回答",
    mentioned: true,
    citations: urls.map((url, i) => ({ url, position: i })),
    citationsStatus: urls.length > 0 ? "ok" : "unavailable",
    competitorsMentioned: [],
    observedAt: new Date().toISOString(),
  };
}

function fakeProbe(status: string, citation?: CitationRecord): VisibilityProbe {
  return {
    provider: "fake",
    providerName: "假模型",
    vendor: "测试",
    status,
    mentioned: status === "MENTIONED",
    excerpt: null,
    rawResponse: citation?.answerText ?? null,
    citedDomains: [],
    requestedModel: "fake-model",
    servedModel: null,
    requestParams: {},
    promptVersion: "1.0.0",
    promptHash: "hash",
    parserVersion: "ai-visibility@0.1.0",
    confidence: "medium",
    evidenceId: null,
    elapsedMs: 1,
    citation,
  } as unknown as VisibilityProbe;
}

function fakeReport(topic: string, probes: VisibilityProbe[]): VisibilityReport {
  return {
    brand: "brand1",
    prompt: `关于「${topic}」`,
    promptVersion: "1.0.0",
    probes,
    visibilityScore: 50,
    observedCount: 1,
    configuredCount: 1,
    mentionedCount: 1,
    failedCount: 0,
    unobservableCount: 0,
    statusCounts: {} as VisibilityReport["statusCounts"],
    topCitedDomains: [],
    parserVersion: "ai-visibility@0.1.0",
    requestParams: {},
    generatedAt: new Date().toISOString(),
  };
}

describe("T2: batchProbeVisibility 批量探测（注入假 probe）", () => {
  it("多 query 批量：有引用 / 无引用 / 拒答 各态都能产出记录", async () => {
    const topics = ["q-ok", "q-no-citation", "q-refused"];
    const probe = async (_brand: string, topic: string) => {
      if (topic === "q-ok") {
        return fakeReport(topic, [
          fakeProbe("MENTIONED", fakeCitation(topic, "模型A", ["https://a.com/1", "https://b.com/2"])),
        ]);
      }
      if (topic === "q-no-citation") {
        return fakeReport(topic, [
          fakeProbe("MENTIONED", fakeCitation(topic, "模型A", [])),
        ]);
      }
      // 拒答：INDETERMINATE，同样没有引用
      return fakeReport(topic, [
        fakeProbe("INDETERMINATE", fakeCitation(topic, "模型B", [])),
      ]);
    };

    const reports = await batchProbeVisibility("brand1", topics, 2, probe);
    assert.equal(reports.length, 3);

    const allCitations = reports.flatMap((r) => r.probes.map((p) => p.citation));
    assert.equal(allCitations.length, 3);
    // 有引用的记录只含真实出现在响应文本里的 URL
    const okRecord = allCitations.find((c) => c?.citationsStatus === "ok");
    assert.equal(okRecord?.citations.length, 2);
    assert.ok(okRecord?.citations.every((c) => c.url.startsWith("https://")));
    // 无引用 / 拒答 → unavailable，且没有任何编造的 URL
    const unavailable = allCitations.filter((c) => c?.citationsStatus === "unavailable");
    assert.equal(unavailable.length, 2);
    assert.ok(unavailable.every((c) => c!.citations.length === 0));
  });

  it("单个 query 探测失败（超时 / HTTP 错误）不影响其他 query", async () => {
    const topics = ["q1", "q-boom", "q3"];
    const probe = async (_brand: string, topic: string) => {
      if (topic === "q-boom") {
        throw new Error("HTTP 500 / timeout");
      }
      return fakeReport(topic, [fakeProbe("MENTIONED", fakeCitation(topic, "模型A", []))]);
    };

    const reports = await batchProbeVisibility("brand1", topics, 2, probe);
    assert.equal(reports.length, 2);
    const got = reports.map((r) => r.prompt).sort();
    assert.deepEqual(got, ["关于「q1」", "关于「q3」"]);
  });

  it("并发上限不被突破", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const topics = ["a", "b", "c", "d", "e", "f"];
    const probe = async (_brand: string, topic: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return fakeReport(topic, []);
    };

    await batchProbeVisibility("brand1", topics, 2, probe);
    assert.equal(maxInFlight <= 2, true);
  });

  it("空 query 被跳过", async () => {
    const probe = async (_brand: string, topic: string) => fakeReport(topic, []);
    const reports = await batchProbeVisibility("brand1", ["", "  ", "q1"], 2, probe);
    assert.equal(reports.length, 1);
  });

  it("同一 query 内：单模型被拒（BLOCKED）/故障（ERROR）不影响其他模型", async () => {
    // 真实场景：probeProvider 对 4xx 返回 BLOCKED、对 5xx/网络异常返回 ERROR，
    // 这两条路径不产生 citation（没有响应文本可提取），也绝不能编造
    const probe = async (_brand: string, topic: string) =>
      fakeReport(topic, [
        fakeProbe("BLOCKED"), // 厂商 4xx 拒绝
        fakeProbe("ERROR"), // HTTP 500 / 网络故障
        fakeProbe("UNOBSERVABLE"), // 未配 key
        fakeProbe("MENTIONED", fakeCitation(topic, "模型D", ["https://ok.com/1"])),
      ]);

    const reports = await batchProbeVisibility("brand1", ["q-mixed"], 2, probe);
    assert.equal(reports.length, 1);
    const probes = reports[0].probes;
    assert.equal(probes.length, 4);

    // 失败态探针如实保留状态，且不带任何引用记录
    for (const st of ["BLOCKED", "ERROR", "UNOBSERVABLE"]) {
      const p = probes.find((x) => x.status === st);
      assert.ok(p, `应存在 ${st} 探针`);
      assert.equal(p.citation, undefined, `${st} 不得产出引用记录`);
    }
    // 正常探针不受影响
    const ok = probes.find((x) => x.status === "MENTIONED");
    assert.equal(ok?.citation?.citationsStatus, "ok");
    assert.equal(ok?.citation?.citations.length, 1);
  });
});
