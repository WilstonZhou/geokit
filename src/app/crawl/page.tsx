"use client";

import { useMemo, useState } from "react";
import { Card, SectionTitle, Badge, Stat, Field, inputCls, btnCls } from "@/components/ui";

interface CrawlPageItem {
  url: string;
  finalUrl: string;
  httpStatus: number;
  redirectChain: string[];
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  canonical: string | null;
  noindex: boolean;
  hreflang: string[];
  jsonLdTypes: string[];
  internalLinks: number;
  externalLinks: number;
  wordCount: number;
  geoScore: number;
  seoScore: number;
  blocked?: { reason: string };
  clickDepth: number;
  outLinks: string[];
}

interface GraphNode {
  url: string;
  inlinks: number;
  clickDepth: number;
  orphan: boolean;
}

interface CrawlResult {
  origin: string;
  pages: CrawlPageItem[];
  graph: { nodes: GraphNode[]; edges: { from: string; to: string }[] };
  truncated: boolean;
  reason?: string;
  startedAt: string;
  elapsedMs: number;
}

type StatusFilter = "all" | "2xx" | "3xx" | "4xx" | "5xx" | "blocked";

function statusMatch(status: number, blocked: boolean, f: StatusFilter): boolean {
  if (f === "all") return true;
  if (f === "blocked") return blocked;
  if (blocked) return false;
  if (f === "2xx") return status >= 200 && status < 300;
  if (f === "3xx") return status >= 300 && status < 400;
  if (f === "4xx") return status >= 400 && status < 500;
  if (f === "5xx") return status >= 500;
  return false;
}

export default function CrawlPage() {
  const [site, setSite] = useState("");
  const [maxPages, setMaxPages] = useState(50);
  const [maxDepth, setMaxDepth] = useState(2);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<CrawlResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [orphanOnly, setOrphanOnly] = useState(false);

  async function run() {
    const t = site.trim();
    if (!t) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          site: t,
          config: {
            maxPages: Number(maxPages) || 50,
            maxDepth: Number(maxDepth) || 2,
          },
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "爬取失败");
      setData(json as CrawlResult);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const inlinkMap = useMemo(() => {
    const m = new Map<string, number>();
    if (!data) return m;
    for (const n of data.graph.nodes) m.set(n.url, n.inlinks);
    return m;
  }, [data]);

  const orphanSet = useMemo(() => {
    const s = new Set<string>();
    if (!data) return s;
    for (const n of data.graph.nodes) if (n.orphan) s.add(n.url);
    return s;
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.pages.filter((p) => {
      if (!statusMatch(p.httpStatus, !!p.blocked, statusFilter)) return false;
      if (orphanOnly && !orphanSet.has(p.url)) return false;
      return true;
    });
  }, [data, statusFilter, orphanOnly, orphanSet]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[20px] font-semibold text-ink-900">站点爬取与站点图</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
          BFS 同域页面，每页产出审计摘要与站内出链，构建站点图后标注孤岛页。
          抓不到的页面如实记录 4xx/5xx 与 blocked，不编造内容。
        </p>
      </div>

      <Card>
        <Field label="站点 URL 或域名">
          <div className="flex gap-2">
            <input
              className={inputCls}
              placeholder="https://example.com 或 example.com"
              value={site}
              onChange={(e) => setSite(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && run()}
            />
            <button className={`${btnCls} shrink-0`} onClick={() => run()} disabled={loading || !site.trim()}>
              {loading ? "爬取中…" : "开始爬取"}
            </button>
          </div>
        </Field>

        <div className="mt-3 grid grid-cols-2 gap-3 sm:max-w-md">
          <Field label="最大页面数">
            <input
              type="number"
              min={1}
              max={500}
              className={inputCls}
              value={maxPages}
              onChange={(e) => setMaxPages(Number(e.target.value))}
            />
          </Field>
          <Field label="最大深度">
            <input
              type="number"
              min={0}
              max={5}
              className={inputCls}
              value={maxDepth}
              onChange={(e) => setMaxDepth(Number(e.target.value))}
            />
          </Field>
        </div>
        {err && (
          <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700">{err}</p>
        )}
      </Card>

      {loading && (
        <Card>
          <div className="flex items-center gap-3">
            <span className="pulse-ring h-2.5 w-2.5 rounded-full bg-ocean-500" />
            <span className="text-[13px] text-ink-700">正在 BFS 爬取并分析页面…</span>
          </div>
          <div className="mt-4 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-4 animate-pulse rounded bg-ink-100" style={{ width: `${80 - i * 12}%` }} />
            ))}
          </div>
        </Card>
      )}

      {data && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="页面数" value={data.pages.length} hint={`上限 ${data.pages.length}/${maxPages}`} />
            <Stat label="耗时" value={`${(data.elapsedMs / 1000).toFixed(1)}s`} />
            <Stat label="站点图节点" value={data.graph.nodes.length} hint={`${data.graph.edges.length} 条边`} />
            <Stat
              label="截断"
              value={data.truncated ? "是" : "否"}
              hint={data.reason ?? (data.truncated ? "达到上限" : "完整")}
              tone={data.truncated ? "warn" : "good"}
            />
          </div>

          <Card>
            <SectionTitle title="站点图摘要" desc={`origin: ${data.origin}`} />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="孤岛页" value={data.graph.nodes.filter((n) => n.orphan).length} tone="warn" />
              <Stat label="平均入链" value={(data.graph.nodes.reduce((s, n) => s + n.inlinks, 0) / Math.max(1, data.graph.nodes.length)).toFixed(1)} />
              <Stat label="最大深度" value={data.pages.reduce((m, p) => Math.max(m, p.clickDepth), 0)} />
              <Stat label="blocked 页" value={data.pages.filter((p) => p.blocked).length} tone="bad" />
            </div>
          </Card>

          <Card>
            <SectionTitle
              title={`页面明细（${filtered.length}/${data.pages.length}）`}
              desc="按状态码与孤岛标记过滤。"
              action={
                <div className="flex flex-wrap items-center gap-2">
                  {(["all", "2xx", "3xx", "4xx", "5xx", "blocked"] as StatusFilter[]).map((f) => (
                    <button
                      key={f}
                      onClick={() => setStatusFilter(f)}
                      className={`rounded-md border px-2.5 py-1 text-[11.5px] transition ${
                        statusFilter === f
                          ? "border-ocean-200 bg-ocean-50 text-ocean-700"
                          : "border-ink-200 bg-white text-ink-600 hover:border-ocean-300"
                      }`}
                    >
                      {f === "all" ? "全部" : f}
                    </button>
                  ))}
                  <label className="ml-2 inline-flex items-center gap-1.5 text-[11.5px] text-ink-600">
                    <input
                      type="checkbox"
                      checked={orphanOnly}
                      onChange={(e) => setOrphanOnly(e.target.checked)}
                    />
                    仅孤岛页
                  </label>
                </div>
              }
            />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-[12.5px]">
                <thead>
                  <tr className="border-b border-ink-200 text-left text-[11px] uppercase tracking-wide text-ink-500">
                    <th className="py-2.5 pr-4 font-medium">URL</th>
                    <th className="py-2.5 pr-4 font-medium">状态</th>
                    <th className="py-2.5 pr-4 font-medium">标题</th>
                    <th className="py-2.5 pr-4 font-medium">GEO</th>
                    <th className="py-2.5 pr-4 font-medium">深度</th>
                    <th className="py-2.5 pr-4 font-medium">入链</th>
                    <th className="py-2.5 font-medium">标记</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {filtered.map((p) => (
                    <tr key={p.url} className="align-top">
                      <td className="py-2.5 pr-4 break-words text-ink-900">
                        {p.url}
                        {p.redirectChain.length > 0 && (
                          <span className="ml-1 text-[11px] text-ink-400">→ {p.finalUrl}</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4">
                        {p.blocked ? (
                          <Badge tone="bad">blocked</Badge>
                        ) : (
                          <span
                            className={`tabular ${
                              p.httpStatus >= 200 && p.httpStatus < 300
                                ? "text-emerald-600"
                                : p.httpStatus >= 400
                                  ? "text-rose-600"
                                  : "text-amber-600"
                            }`}
                          >
                            {p.httpStatus}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 text-ink-700">
                        {p.title ?? (p.blocked ? "—" : "—")}
                      </td>
                      <td className="py-2.5 pr-4 tabular text-ink-700">
                        {p.geoScore}
                      </td>
                      <td className="py-2.5 pr-4 tabular text-ink-700">{p.clickDepth}</td>
                      <td className="py-2.5 pr-4 tabular text-ink-700">
                        {inlinkMap.get(p.url) ?? 0}
                      </td>
                      <td className="py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {orphanSet.has(p.url) && <Badge tone="warn">孤岛</Badge>}
                          {p.noindex && <Badge tone="neutral">noindex</Badge>}
                          {p.redirectChain.length > 0 && <Badge tone="info">重定向</Badge>}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={7} className="py-6 text-center text-[12px] text-ink-500">
                        无符合条件的页面
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
