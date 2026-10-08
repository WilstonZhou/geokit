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

import type {
  QueryAnalysis,
  QueryCluster,
} from "@/lib/query";

const SAMPLE_INPUT = `{
  "query": "跨境支付 怎么选",
  "serpResults": [
    {
      "engine": "baidu", "engineName": "百度", "keyword": "跨境支付 怎么选",
      "status": "ok", "items": [
        { "position": 1, "title": "跨境支付怎么选？对比五大方案", "url": "https://rival.com/a", "domain": "rival.com", "snippet": "...", "owned": false, "redirectWrapper": false, "resolved": true },
        { "position": 2, "title": "Stripe vs PayPal 对比", "url": "https://rival.com/b", "domain": "rival.com", "snippet": "...", "owned": false, "redirectWrapper": false, "resolved": true }
      ],
      "targetRank": null, "targetFound": false, "fetchedAt": "2026-10-08T00:00:00Z", "elapsedMs": 1000
    }
  ],
  "aiCitations": [
    {
      "query": "跨境支付 怎么选", "model": "gpt-4o",
      "answerText": "跨境支付选 Stripe。怎么接入？看官方文档。",
      "mentioned": false, "citations": [{ "url": "https://rival.com/a", "title": "对比" }],
      "citationsStatus": "ok", "competitorsMentioned": [], "observedAt": "2026-10-08T00:00:00Z"
    }
  ],
  "userDomain": "example.com"
}`;

const SAMPLE_CLUSTER = `{
  "action": "cluster",
  "queries": [
    { "query": "跨境支付", "serpResults": [
      { "engine": "baidu", "engineName": "百度", "keyword": "x", "status": "ok",
        "items": [{ "position": 1, "title": "A", "url": "https://shared.com/a", "domain": "shared.com", "snippet": "", "owned": false, "redirectWrapper": false, "resolved": true },
                   { "position": 2, "title": "B", "url": "https://shared.com/b", "domain": "shared.com", "snippet": "", "owned": false, "redirectWrapper": false, "resolved": true }],
        "targetRank": null, "targetFound": false, "fetchedAt": "2026-10-08", "elapsedMs": 1 }
    ] },
    { "query": "海外收款", "serpResults": [
      { "engine": "baidu", "engineName": "百度", "keyword": "y", "status": "ok",
        "items": [{ "position": 1, "title": "A", "url": "https://shared.com/a", "domain": "shared.com", "snippet": "", "owned": false, "redirectWrapper": false, "resolved": true },
                   { "position": 2, "title": "C", "url": "https://shared.com/c", "domain": "shared.com", "snippet": "", "owned": false, "redirectWrapper": false, "resolved": true }],
        "targetRank": null, "targetFound": false, "fetchedAt": "2026-10-08", "elapsedMs": 1 }
    ] }
  ]
}`;

type Mode = "analyze" | "cluster";

interface AnalyzeResult extends QueryAnalysis { error?: string }
interface ClusterResult {
  total: number;
  queriesAnalyzed: number;
  clusters: QueryCluster[];
  error?: string;
}

export default function QueriesPage() {
  const [mode, setMode] = useState<Mode>("analyze");
  const [inputText, setInputText] = useState(SAMPLE_INPUT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analyzeData, setAnalyzeData] = useState<AnalyzeResult | null>(null);
  const [clusterData, setClusterData] = useState<ClusterResult | null>(null);

  function switchMode(m: Mode) {
    setMode(m);
    setInputText(m === "analyze" ? SAMPLE_INPUT : SAMPLE_CLUSTER);
    setAnalyzeData(null);
    setClusterData(null);
    setError(null);
  }

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
    setAnalyzeData(null);
    setClusterData(null);
    try {
      const res = await fetch("/api/queries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as AnalyzeResult & ClusterResult;
      if (!res.ok) throw new Error(json.error ?? "查询失败");
      if (mode === "analyze") setAnalyzeData(json);
      else setClusterData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold text-ink-900">Query Intelligence（轻量）</h1>
        <p className="mt-1 text-[12.5px] text-ink-500">
          把一个 query 的已有观测汇总：意图分类 → 相关问题 → 竞品 → AI 引用 → 内容缺口 → 聚类。
          全部规则驱动，不调任何大模型；缺数据源时对应段落标 unavailable。
        </p>
      </header>

      <Card>
        <div className="flex gap-2">
          <button
            className={mode === "analyze" ? btnCls : `${btnCls} opacity-60`}
            onClick={() => switchMode("analyze")}
          >单 query 分析</button>
          <button
            className={mode === "cluster" ? btnCls : `${btnCls} opacity-60`}
            onClick={() => switchMode("cluster")}
          >多 query 聚类</button>
        </div>
      </Card>

      <Card>
        <SectionTitle
          title={mode === "analyze" ? "输入（QueryAnalysisInput JSON）" : "输入（ClusterInput JSON）"}
          desc={mode === "analyze"
            ? "字段：query / serpResults / aiCitations / gscOpportunities / userCrawl / userDomain"
            : "字段：queries[{query, serpResults}] / jaccardThreshold / minSharedUrls"}
        />
        <Field label="JSON">
          <textarea
            className={`${inputCls} min-h-[200px] font-mono text-[12px]`}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
          />
        </Field>
        <div className="mt-3">
          <button className={btnCls} onClick={run} disabled={loading}>
            {loading ? "分析中…" : (mode === "analyze" ? "分析 query" : "聚类 queries")}
          </button>
        </div>
      </Card>

      {loading && (
        <Card>
          <div className="flex items-center gap-3">
            <span className="pulse-ring h-2.5 w-2.5 rounded-full bg-ocean-500" />
            <span className="text-[13px] text-ink-700">正在按规则分析…</span>
          </div>
        </Card>
      )}

      {error && (
        <Card><p className="text-[13px] text-red-600">{error}</p></Card>
      )}

      {/* 分析模式 */}
      {mode === "analyze" && analyzeData && (
        <>
          <Card>
            <SectionTitle title="意图分类" desc="规则驱动，5 类：informational/comparative/transactional/local/navigational" />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge tone="info">{analyzeData.intent.intent}</Badge>
              <Badge tone={analyzeData.intent.confidence === "high" ? "good" : analyzeData.intent.confidence === "medium" ? "warn" : "neutral"}>
                置信度 {analyzeData.intent.confidence}
              </Badge>
            </div>
            <ul className="mt-2 space-y-0.5 text-[12px] text-ink-600">
              {analyzeData.intent.basis.map((b, i) => (
                <li key={i}>· {b}</li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap gap-3 text-[11px]">
              {(["serp", "ai", "gsc", "crawl"] as const).map((k) => (
                <Badge key={k} tone={analyzeData.sourceAvailability[k] === "available" ? "good" : "neutral"}>
                  {k}: {analyzeData.sourceAvailability[k]}
                </Badge>
              ))}
            </div>
          </Card>

          <Card>
            <SectionTitle title={`相关问题（${analyzeData.relatedQuestions.length}）`} desc="从 SERP 标题与 AI 答案提取，不编造" />
            {analyzeData.relatedQuestions.length === 0 ? (
              <Empty>无相关问题候选</Empty>
            ) : (
              <ul className="space-y-1.5">
                {analyzeData.relatedQuestions.map((q, i) => (
                  <li key={i} className="text-[12.5px]">
                    <span className="text-ink-900">{q.question}</span>
                    <span className="ml-2 text-[11px] text-ink-500">{q.sources.join(" / ")}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <SectionTitle title={`竞品（${analyzeData.competitors.length}）`} desc="SERP 与 AI 引用里反复出现的域名" />
            {analyzeData.competitors.length === 0 ? (
              <Empty>无竞品候选</Empty>
            ) : (
              <ul className="divide-y divide-ink-100">
                {analyzeData.competitors.map((c) => (
                  <li key={c.domain} className="py-2 text-[12.5px]">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink-900">{c.domain}</span>
                      <Badge tone={c.source === "both" ? "bad" : c.source === "serp" ? "info" : "neutral"}>
                        {c.source}
                      </Badge>
                      <span className="text-ink-600">SERP {c.serpCount} 次（位置 {c.serpPositions.join(",") || "—"}）</span>
                      <span className="text-ink-600">AI {c.aiMentionCount} 次</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <SectionTitle title={`内容缺口（${analyzeData.contentGaps.length}）`} desc="对照 T3 用户爬取，竞品普遍覆盖、用户未覆盖的话题" />
            {analyzeData.contentGaps.length === 0 ? (
              <Empty>无内容缺口</Empty>
            ) : (
              <ul className="divide-y divide-ink-100">
                {analyzeData.contentGaps.map((g, i) => (
                  <li key={i} className="py-2 text-[12.5px]">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink-900">{g.topic}</span>
                      <Badge tone={g.userCoverage === "none" ? "bad" : "warn"}>
                        用户 {g.userCoverage}
                      </Badge>
                      <span className="text-ink-600">
                        竞品 {g.competitorCoverage.covered}/{g.competitorCoverage.total} 覆盖
                      </span>
                    </div>
                    <ul className="mt-1 text-[11.5px] text-ink-500">
                      {g.evidence.map((e, j) => (
                        <li key={j}>· <a href={e.competitorUrl} className="text-ocean-600 hover:underline" target="_blank" rel="noreferrer">{e.competitorUrl}</a> — {e.title}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      {/* 聚类模式 */}
      {mode === "cluster" && clusterData && (
        <Card>
          <SectionTitle title={`聚类结果（${clusterData.total} 簇 / ${clusterData.queriesAnalyzed} query）`} desc="基于共享 SERP URL 重合度，Jaccard ≥ 0.3 或共享 ≥ 2 条" />
          {clusterData.clusters.length === 0 ? (
            <Empty>无符合条件的簇</Empty>
          ) : (
            <ul className="space-y-3">
              {clusterData.clusters.map((c) => (
                <li key={c.id} className="rounded-md border border-ink-100 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="info">{c.id}</Badge>
                    <span className="text-[11px] text-ink-500">重合度 {c.overlapScore}</span>
                    <span className="text-[11px] text-ink-500">共享 URL {c.sharedUrls.length}</span>
                  </div>
                  <ul className="mt-2 text-[12.5px] text-ink-900">
                    {c.queries.map((q) => (<li key={q}>· {q}</li>))}
                  </ul>
                  <details className="mt-1 text-[11px] text-ink-500">
                    <summary className="cursor-pointer">共享 URL（{c.sharedUrls.length}）</summary>
                    <ul className="mt-1">{c.sharedUrls.map((u) => (<li key={u} className="break-all">{u}</li>))}</ul>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
