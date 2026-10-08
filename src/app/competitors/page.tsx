"use client";

import { useState } from "react";
import {
  Card,
  SectionTitle,
  Badge,
  Field,
  inputCls,
  btnCls,
  Empty,
} from "@/components/ui";

import type { CompetitorReport, DimensionComparison, CompetitorGap } from "@/lib/competitor";

const SAMPLE = `{
  "userDomain": "example.com",
  "competitors": ["rival1.com", "rival2.com"],
  "serpResults": [
    {
      "engine": "baidu", "engineName": "百度", "keyword": "跨境支付",
      "status": "ok", "items": [
        {"position": 1, "title": "竞品1", "url": "https://rival1.com/a", "domain": "rival1.com", "snippet": "", "owned": false, "redirectWrapper": false, "resolved": true},
        {"position": 3, "title": "用户", "url": "https://example.com/a", "domain": "example.com", "snippet": "", "owned": false, "redirectWrapper": false, "resolved": true},
        {"position": 5, "title": "竞品2", "url": "https://rival2.com/a", "domain": "rival2.com", "snippet": "", "owned": false, "redirectWrapper": false, "resolved": true}
      ],
      "targetRank": 3, "targetFound": true, "fetchedAt": "2026-10-08T00:00:00Z", "elapsedMs": 1000
    }
  ],
  "aiCitations": [
    {
      "query": "跨境支付", "model": "gpt-4o",
      "answerText": "推荐 rival1.com。",
      "mentioned": false, "citations": [{"url": "https://rival1.com/a", "title": "竞品1", "position": 1}],
      "citationsStatus": "ok", "competitorsMentioned": ["rival1.com"], "observedAt": "2026-10-08T00:00:00Z"
    }
  ],
  "userPageAudits": [
    {"url": "https://example.com/a", "finalUrl": "https://example.com/a", "httpStatus": 200, "elapsedMs": 500, "title": "用户页面", "titleLength": 4, "metaDescription": "desc", "metaDescriptionLength": 4, "canonical": null, "robotsMeta": null, "hreflang": [], "headings": [], "jsonLdTypes": ["Article"], "ogTags": {}, "twitterTags": {}, "wordCount": 100, "imageCount": 1, "imagesWithoutAlt": 0, "internalLinks": 5, "externalLinks": 2, "hasViewport": true, "lang": "zh", "checks": [], "seoScore": 60, "geoScore": 45, "geoBreakdown": [{"id": "citeability", "label": "可引用性", "score": 8, "max": 20, "comment": ""}], "recommendations": []}
  ],
  "competitorPageAudits": [
    {"domain": "rival1.com", "audits": [
      {"url": "https://rival1.com/a", "finalUrl": "https://rival1.com/a", "httpStatus": 200, "elapsedMs": 400, "title": "竞品1", "titleLength": 3, "metaDescription": "d", "metaDescriptionLength": 1, "canonical": null, "robotsMeta": null, "hreflang": [], "headings": [], "jsonLdTypes": ["Article", "FAQPage"], "ogTags": {}, "twitterTags": {}, "wordCount": 200, "imageCount": 2, "imagesWithoutAlt": 0, "internalLinks": 8, "externalLinks": 3, "hasViewport": true, "lang": "zh", "checks": [], "seoScore": 75, "geoScore": 65, "geoBreakdown": [{"id": "citeability", "label": "可引用性", "score": 16, "max": 20, "comment": ""}], "recommendations": []}
    ]}
  ]
}`;

function gapTone(gap: string): "bad" | "good" | "neutral" | "info" {
  switch (gap) {
    case "behind": return "bad";
    case "ahead": return "good";
    case "parity": return "neutral";
    default: return "info";
  }
}

function gapLabel(gap: string): string {
  switch (gap) {
    case "behind": return "落后";
    case "ahead": return "领先";
    case "parity": return "持平";
    default: return "不可比";
  }
}

function severityTone(s: string): "bad" | "warn" | "neutral" {
  switch (s) {
    case "high": return "bad";
    case "medium": return "warn";
    default: return "neutral";
  }
}

const DIM_LABELS: Record<string, string> = {
  serp: "SERP 位次",
  ai: "AI 提及/引用",
  geo: "GEO 评分",
  protocol: "AI 抓取协议",
  schema: "结构化数据",
};

export default function CompetitorsPage() {
  const [jsonInput, setJsonInput] = useState(SAMPLE);
  const [report, setReport] = useState<CompetitorReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    setReport(null);
    try {
      const parsed = JSON.parse(jsonInput);
      const res = await fetch("/api/competitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
      } else {
        setReport(data as CompetitorReport);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <SectionTitle
        title="竞品情报"
        desc="五维对比：SERP 位次 / AI 提及 / GEO 评分 / AI 抓取协议 / 结构化数据。不做反链，聚焦 AI 与 SERP。"
      />

      <Card>
        <Field label="竞品对比 JSON（userDomain + competitors + 可选预收集数据）">
          <textarea
            className={`${inputCls} min-h-[200px] font-mono text-[12px]`}
            value={jsonInput}
            onChange={(e) => setJsonInput(e.target.value)}
          />
        </Field>
        <div className="mt-3 flex gap-2">
          <button className={btnCls} onClick={run} disabled={loading}>
            {loading ? "分析中…" : "开始对比"}
          </button>
        </div>
        {error && <p className="mt-3 text-[13px] text-rose-600">{error}</p>}
      </Card>

      {report && (
        <div className="space-y-4">
          {/* 维度对比 */}
          <SectionTitle title="维度对比" />
          {report.dimensions.map((dim: DimensionComparison<unknown>) => (
            <Card key={dim.dimension}>
              <div className="flex items-center justify-between">
                <h3 className="text-[14px] font-semibold text-ink-900">
                  {DIM_LABELS[dim.dimension] ?? dim.dimension}
                </h3>
                <div className="flex items-center gap-2">
                  <Badge tone={gapTone(dim.gap)}>{gapLabel(dim.gap)}</Badge>
                  <Badge tone="neutral">{dim.userStatus}</Badge>
                </div>
              </div>
              <p className="mt-2 text-[13px] text-ink-700">{dim.summary}</p>
              {dim.gapDetail && (
                <p className="mt-1 text-[12px] text-ink-500">{dim.gapDetail}</p>
              )}
              {/* 竞品值 */}
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-ink-100 text-ink-500">
                      <th className="py-1.5 text-left font-medium">主体</th>
                      <th className="py-1.5 text-left font-medium">状态</th>
                      <th className="py-1.5 text-left font-medium">值</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-ink-50">
                      <td className="py-1.5 font-medium text-ink-900">{report.userDomain}</td>
                      <td className="py-1.5">{dim.userStatus}</td>
                      <td className="py-1.5">{formatValue(dim.userValue)}</td>
                    </tr>
                    {dim.competitorValues.map((cv) => (
                      <tr key={cv.domain} className="border-b border-ink-50">
                        <td className="py-1.5 font-medium text-ink-900">{cv.domain}</td>
                        <td className="py-1.5">
                          {cv.status}
                          {cv.statusReason && (
                            <span className="text-rose-500"> ({cv.statusReason})</span>
                          )}
                        </td>
                        <td className="py-1.5">{formatValue(cv.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}

          {/* 差距清单 */}
          <SectionTitle title="差距清单" />
          {report.gaps.length === 0 ? (
            <Empty>无差距（用户未落后于任何竞品，或数据不足）。</Empty>
          ) : (
            <div className="space-y-3">
              {report.gaps.map((gap: CompetitorGap, i: number) => (
                <Card key={i}>
                  <div className="flex items-center gap-2">
                    <Badge tone={severityTone(gap.severity)}>{gap.severity}</Badge>
                    <span className="text-[13px] font-medium text-ink-900">
                      {DIM_LABELS[gap.dimension] ?? gap.dimension}
                    </span>
                  </div>
                  <p className="mt-2 text-[13px] text-ink-700">{gap.description}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {gap.affectedCompetitors.map((c) => (
                      <Badge key={c} tone="info">{c}</Badge>
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {!report && !loading && !error && (
        <Empty>填入 JSON 并点击「开始对比」查看五维竞品分析结果。</Empty>
      )}
    </div>
  );
}

/** 简洁格式化维度值 */
function formatValue(v: unknown): string {
  if (v === null) return "—";
  if (typeof v === "object" && v !== null) {
    const obj = v as Record<string, unknown>;
    // 常见字段
    if ("averageRank" in obj) return `均位 ${obj.averageRank ?? "—"}`;
    if ("mentionCount" in obj) return `提及 ${obj.mentionCount}/引用 ${obj.citationCount}`;
    if ("averageScore" in obj) return `均分 ${obj.averageScore}`;
    if ("aiOpennessScore" in obj) return `开放度 ${obj.aiOpennessScore}${obj.hasLlmsTxt ? " +llms.txt" : ""}`;
    if ("typeCount" in obj) return `${obj.typeCount} 种`;
    return JSON.stringify(v).slice(0, 80);
  }
  return String(v);
}
