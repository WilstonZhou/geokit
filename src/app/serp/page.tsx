"use client";

import { useState } from "react";
import { Card, SectionTitle, Badge, Stat, Empty, Field, inputCls, btnCls } from "@/components/ui";

const ENGINE_GROUPS = [
  { id: "cn", label: "中文五引擎", engines: ["baidu", "so360", "sogou", "shenma", "toutiao"] },
  { id: "global", label: "国际引擎", engines: ["google", "bing"] },
] as const;

const ENGINE_NAMES: Record<string, string> = {
  baidu: "百度", so360: "360 搜索", sogou: "搜狗", shenma: "神马",
  toutiao: "头条搜索", google: "Google", bing: "Bing",
};

interface SerpItem {
  position: number; title: string; url: string; domain: string; snippet: string;
  owned: boolean; redirectWrapper: boolean; resolved: boolean;
}
interface SerpResult {
  engine: string; engineName: string; keyword: string;
  status: "ok" | "blocked" | "no_results" | "error";
  note?: string; items: SerpItem[]; targetRank: number | null;
  targetFound: boolean; elapsedMs: number;
}

export default function SerpPage() {
  const [keyword, setKeyword] = useState("");
  const [targetDomain, setTargetDomain] = useState("");
  const [group, setGroup] = useState<"cn" | "global" | "all">("cn");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{
    keyword: string; engineCount: number;
    summary: { okEngines: number; blockedEngines: number; averageRank: number | null; bestRank: number | null; totalItems: number };
    results: SerpResult[];
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function run() {
    if (!keyword.trim()) return;
    setLoading(true); setErr(null); setData(null);
    try {
      const res = await fetch("/api/serp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword: keyword.trim(), targetDomain: targetDomain.trim() || undefined, group }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "请求失败");
      setData(json);
      const first = json.results?.find((r: SerpResult) => r.status === "ok");
      if (first) setExpanded(first.engine);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[20px] font-semibold text-ink-900">多引擎关键词排名</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
          同一关键词在多个中文引擎里的真实位次。open-seo 的 SERP 能力完全绑定 DataForSEO 且只支持
          Google / Bing；这里直接采集百度、搜狗、360、神马、头条。
        </p>
      </div>

      <Card>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="关键词">
            <input
              className={inputCls}
              placeholder="例如：跨境支付 平台"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && run()}
            />
          </Field>
          <Field label="目标域名" hint="填了才算你自己排第几">
            <input
              className={inputCls}
              placeholder="例如：whivi.com"
              value={targetDomain}
              onChange={(e) => setTargetDomain(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && run()}
            />
          </Field>
          <Field label="引擎范围">
            <select
              className={inputCls}
              value={group}
              onChange={(e) => setGroup(e.target.value as "cn" | "global" | "all")}
            >
              <option value="cn">中文五引擎</option>
              <option value="global">国际引擎（Google + Bing）</option>
              <option value="all">全部七引擎</option>
            </select>
          </Field>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button className={btnCls} onClick={run} disabled={loading || !keyword.trim()}>
            {loading ? "采集中…" : "开始采集"}
          </button>
          <span className="text-[11.5px] text-ink-500">
            每个引擎独立请求，超时 12s；抓不到的会如实标注原因。
          </span>
        </div>
        {err && (
          <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700">
            {err}
          </p>
        )}
      </Card>

      {loading && (
        <Card>
          <div className="flex items-center gap-3">
            <span className="pulse-ring h-2.5 w-2.5 rounded-full bg-ocean-500" />
            <span className="text-[13px] text-ink-700">
              正在向 {group === "cn" ? 5 : group === "global" ? 2 : 7} 个引擎并发采集…
            </span>
          </div>
          <div className="mt-4 space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-4 animate-pulse rounded bg-ink-100" style={{ width: `${70 - i * 15}%` }} />
            ))}
          </div>
        </Card>
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="采集成功" value={`${data.summary.okEngines}/${data.engineCount}`} tone={data.summary.okEngines > 0 ? "good" : "bad"} />
            <Stat
              label="平均位次"
              value={data.summary.averageRank ?? "—"}
              hint={data.summary.averageRank ? "仅统计上榜引擎" : "未在任何引擎上榜"}
              tone={data.summary.averageRank ? (data.summary.averageRank <= 10 ? "good" : "warn") : "bad"}
            />
            <Stat
              label="最佳位次"
              value={data.summary.bestRank ?? "—"}
              hint={data.summary.bestRank ? "所有引擎中最高位" : undefined}
              tone={data.summary.bestRank ? (data.summary.bestRank <= 3 ? "good" : "warn") : "default"}
            />
            <Stat label="结果总数" value={data.summary.totalItems} hint="去重后的条目数" />
          </div>

          <div className="space-y-3">
            {data.results.map((r) => (
              <Card key={r.engine} className="fade-up">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <h3 className="text-[14px] font-semibold text-ink-900">{r.engineName}</h3>
                    {r.status === "ok" ? (
                      <Badge tone="good">采集成功</Badge>
                    ) : (
                      <Badge tone={r.status === "no_results" ? "warn" : "bad"}>
                        {r.status === "blocked" ? "被拦截" : r.status === "no_results" ? "未解析出结果" : "出错"}
                      </Badge>
                    )}
                    {targetDomain && r.status === "ok" && (
                      r.targetRank !== null ? (
                        <Badge tone={r.targetRank <= 10 ? "good" : "warn"}>
                          第 {r.targetRank} 位
                        </Badge>
                      ) : (
                        <Badge tone="bad">前 {r.items.length} 未上榜</Badge>
                      )
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-[11.5px] text-ink-500">
                    <span className="tabular">{r.elapsedMs}ms</span>
                    <span>{r.items.length} 条</span>
                    {r.items.length > 0 && (
                      <button
                        className="rounded-md border border-ink-200 px-2 py-0.5 transition hover:border-ocean-300 hover:text-ocean-700"
                        onClick={() => setExpanded(expanded === r.engine ? null : r.engine)}
                      >
                        {expanded === r.engine ? "收起" : "展开结果"}
                      </button>
                    )}
                  </div>
                </div>

                {r.note && (
                  <p className="mt-3 rounded-lg border border-ink-200 bg-ink-50 px-3 py-2 text-[12px] leading-relaxed text-ink-700">
                    {r.note}
                  </p>
                )}

                {expanded === r.engine && r.items.length > 0 && (
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full min-w-[700px] text-[12.5px]">
                      <thead>
                        <tr className="border-b border-ink-200 text-left text-[11px] uppercase tracking-wide text-ink-500">
                          <th className="py-2 pr-3 font-medium">#</th>
                          <th className="py-2 pr-3 font-medium">标题</th>
                          <th className="py-2 pr-3 font-medium">域名</th>
                          <th className="py-2 font-medium">摘要</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-ink-100">
                        {r.items.slice(0, 30).map((it) => {
                          const isTarget = targetDomain && it.domain.includes(targetDomain.replace(/^www\./, ""));
                          return (
                            <tr key={it.position} className={isTarget ? "bg-emerald-50/60" : ""}>
                              <td className="tabular py-2.5 pr-3 align-top text-ink-500">{it.position}</td>
                              <td className="py-2.5 pr-3 align-top">
                                <a
                                  href={it.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="font-medium text-ocean-700 hover:underline"
                                >
                                  {it.title}
                                </a>
                                {it.owned && <Badge tone="info"><span className="ml-2">站内</span></Badge>}
                              </td>
                              <td className="py-2.5 pr-3 align-top text-ink-700">
                                {it.domain}
                                {it.redirectWrapper && (
                                  <span className="ml-1.5 cursor-help rounded bg-amber-100 px-1 text-[10px] text-amber-700" title="该结果是搜索引擎的中转链接，真实域名未能解析出来 —— GEOkit 不做猜测">
                                    中转
                                  </span>
                                )}
                              </td>
                              <td className="max-w-md py-2.5 align-top text-[11.5px] leading-relaxed text-ink-500">
                                {it.snippet}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            ))}
          </div>

          {data.summary.okEngines === 0 && (
            <Empty>
              所有引擎均未返回有效结果。这通常是服务端直连被风控所致 ——
              配置出口代理后重试即可，GEOkit 不会因此给你一份假排名。
            </Empty>
          )}
        </>
      )}

      {!data && !loading && (
        <Card>
          <SectionTitle title="支持的引擎" desc="份额为中国市场公开估算值。" />
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {ENGINE_GROUPS.flatMap((g) => g.engines).map((id) => (
              <div key={id} className="rounded-lg border border-ink-200 px-3 py-2.5">
                <p className="text-[13px] font-medium text-ink-900">{ENGINE_NAMES[id]}</p>
                <p className="text-[11px] text-ink-500">{id}</p>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
