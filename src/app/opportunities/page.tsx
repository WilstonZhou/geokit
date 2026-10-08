"use client";

import { useState } from "react";
import {
  Card,
  SectionTitle,
  Badge,
  Stat,
  Field,
  inputCls,
  btnCls,
  Empty,
} from "@/components/ui";

import type { Opportunity, OpportunityType } from "@/lib/opportunity";

const TYPE_META: Record<
  OpportunityType,
  { label: string; tone: "bad" | "warn" | "neutral" | "info" }
> = {
  "weak-citeability": { label: "可引用性弱", tone: "bad" },
  "citation-gap": { label: "引用缺口", tone: "bad" },
  "ai-crawl-protocol": { label: "AI 抓取协议", tone: "warn" },
  "site-issue-high": { label: "高影响项", tone: "bad" },
  "search-opportunity": { label: "搜索机会", tone: "info" },
  "missing-entity": { label: "实体缺失", tone: "warn" },
  "schema-issue": { label: "Schema 问题", tone: "bad" },
  "poor-web-vitals": { label: "性能差", tone: "bad" },
};

const IMPACT_TONE: Record<string, "bad" | "warn" | "neutral"> = {
  high: "bad",
  medium: "warn",
  low: "neutral",
};

const SAMPLE_INPUT = `{
  "siteAnalysis": {
    "issues": [
      { "type": "low-geo-score", "severity": "high", "title": "1 个页面 GEO 评分 < 40",
        "affectedUrls": ["https://example.com/a"], "evidence": [{"fact":"高分阈值","value":40}],
        "suggestedFix": "对照六维明细补齐" }
    ],
    "geoSummary": {
      "distribution": { "critical": 1, "poor": 0, "fair": 0, "good": 0 },
      "lowestScoring": [{ "url": "https://example.com/a", "geoScore": 30 }],
      "commonWeakDimensions": [{ "id": "answer", "label": "直接回答", "pages": 1 }]
    },
    "schemaCoverage": []
  },
  "userDomain": "example.com",
  "citationAggregation": {
    "domainRanking": [{ "domain": "rival.com", "count": 6 }],
    "competitorFrequency": [],
    "citationGap": [{ "domain": "rival.com", "count": 6 }]
  }
}`;

interface ApiResult {
  total: number;
  counts: Record<OpportunityType, number>;
  opportunities: Opportunity[];
  error?: string;
}

export default function OpportunitiesPage() {
  const [inputText, setInputText] = useState(SAMPLE_INPUT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ApiResult | null>(null);

  async function run() {
    let body: unknown;
    try {
      body = JSON.parse(inputText);
    } catch (e) {
      setError(e instanceof Error ? e.message : "JSON 解析失败");
      return;
    }
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch("/api/opportunities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as ApiResult;
      if (!res.ok) throw new Error(json.error ?? "查询失败");
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold text-ink-900">机会引擎（Opportunity Engine）</h1>
        <p className="mt-1 text-[12.5px] text-ink-500">
          把各 T 的发现统一翻译成「下一步做什么」。每个机会带 impact/effort、可追溯 evidence、清单式建议与复检信号。
          缺哪段输入就跳过对应类型，绝不报错；建议来自规则与模板，不调用任何大模型。
        </p>
      </header>

      <Card>
        <SectionTitle
          title="输入（JSON）"
          desc="字段全部可选：siteAnalysis / citationAggregation / userDomain / robotsAnalysis / llmsTxtAnalysis / gscOpportunities / pageAudits"
        />
        <Field label="OpportunityInput JSON">
          <textarea
            className={`${inputCls} min-h-[200px] font-mono text-[12px]`}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder={SAMPLE_INPUT}
          />
        </Field>
        <div className="mt-3">
          <button className={btnCls} onClick={run} disabled={loading}>
            {loading ? "生成中…" : "生成机会"}
          </button>
        </div>
      </Card>

      {loading && (
        <Card>
          <div className="flex items-center gap-3">
            <span className="pulse-ring h-2.5 w-2.5 rounded-full bg-ocean-500" />
            <span className="text-[13px] text-ink-700">正在按规则与模板生成机会…</span>
          </div>
        </Card>
      )}

      {error && (
        <Card>
          <p className="text-[13px] text-red-600">{error}</p>
        </Card>
      )}

      {data && data.total === 0 && (
        <Card>
          <Empty>当前输入未生成任何机会。每个机会必须能追溯到 evidence，无 evidence 的不会输出。</Empty>
        </Card>
      )}

      {data && data.total > 0 && (
        <>
          <Card>
            <SectionTitle
              title="汇总"
              desc={`共 ${data.total} 个机会，按 impact×effort 排序，同分按受影响范围排序`}
            />
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3">
              {(Object.keys(TYPE_META) as OpportunityType[]).map((t) => (
                <Stat
                  key={t}
                  label={TYPE_META[t].label}
                  value={data.counts[t] ?? 0}
                />
              ))}
            </div>
          </Card>

          <Card>
            <SectionTitle title="机会清单" desc="每条机会含 impact/effort/diagnosis/recommendations/verification" />
            <ul className="divide-y divide-ink-100">
              {data.opportunities.map((o) => {
                const meta = TYPE_META[o.type];
                return (
                  <li key={o.id} className="py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                      <Badge tone={IMPACT_TONE[o.impact]}>impact: {o.impact}</Badge>
                      <Badge tone="neutral">effort: {o.effort}</Badge>
                      <span className="break-all text-[12.5px] font-medium text-ink-900">
                        {o.target}
                      </span>
                      <span className="ml-auto shrink-0 text-[11px] tabular text-ink-500">
                        影响范围 {o.affectedScope}
                      </span>
                    </div>

                    <p className="mt-2 text-[12.5px] text-ink-700">
                      <span className="font-medium text-ink-900">诊断：</span>
                      {o.diagnosis.summary}
                    </p>
                    {o.diagnosis.evidence.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5 pl-1 text-[11.5px] text-ink-600">
                        {o.diagnosis.evidence.map((e, i) => (
                          <li key={i}>
                            · <code className="rounded bg-ink-50 px-1 py-0.5">{e.signal}</code>
                            {e.value !== undefined && (
                              <span className="ml-1 text-ink-700">= {String(e.value)}</span>
                            )}
                            {e.observationId && (
                              <span className="ml-1 text-ink-400">→ obs:{e.observationId}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}

                    <div className="mt-2">
                      <p className="text-[12px] font-medium text-ink-900">建议</p>
                      <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-[12px] text-ink-700">
                        {o.recommendations.map((r, i) => (
                          <li key={i}>
                            {r.action}
                            {r.detail && (
                              <span className="ml-1 text-ink-500">（{r.detail}）</span>
                            )}
                          </li>
                        ))}
                      </ol>
                    </div>

                    <p className="mt-2 rounded-md bg-ocean-50/60 px-2 py-1.5 text-[11.5px] text-ocean-800">
                      <span className="font-medium">复检信号：</span>
                      <code className="rounded bg-white px-1 py-0.5">{o.verification.signalKey}</code>
                      <span className="mx-1">期望 {o.verification.direction}</span>
                      — {o.verification.description}
                    </p>

                    {o.sources.length > 0 && (
                      <p className="mt-1 text-[11px] text-ink-500">
                        来源观测：{o.sources.join(", ")}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
