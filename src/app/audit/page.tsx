"use client";

import { useState } from "react";
import { Card, SectionTitle, Badge, Stat, ScoreRing, Bar, Field, inputCls, btnCls } from "@/components/ui";

interface Check {
  id: string; label: string; level: "pass" | "warn" | "fail";
  detail: string; value?: string; fix?: string; weight: number;
}
interface Breakdown {
  id: string; label: string; score: number; max: number; comment: string;
}
interface Audit {
  url: string; finalUrl: string; httpStatus: number; elapsedMs: number;
  title: string | null; titleLength: number;
  metaDescription: string | null; metaDescriptionLength: number;
  canonical: string | null; robotsMeta: string | null; hreflang: string[];
  headings: { level: number; text: string }[];
  jsonLdTypes: string[]; ogTags: Record<string, string>; twitterTags: Record<string, string>;
  wordCount: number; imageCount: number; imagesWithoutAlt: number;
  internalLinks: number; externalLinks: number;
  hasViewport: boolean; lang: string | null;
  checks: Check[]; seoScore: number; geoScore: number;
  geoBreakdown: Breakdown[]; recommendations: string[];
}

export default function AuditPage() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<Audit | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run(target?: string) {
    const t = (target ?? url).trim();
    if (!t) return;
    setLoading(true); setErr(null);
    try {
      const res = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: t }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "审计失败");
      setData(json);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[20px] font-semibold text-ink-900">页面审计与 GEO 评分</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
          除了传统技术检查，这里会回答一个问题：<span className="font-medium text-ink-700">
          AI 愿意引用这个页面吗？</span>
          {" "}open-seo 的审计停留在「Google 会不会收录」这一层。
        </p>
      </div>

      <Card>
        <Field label="页面 URL">
          <div className="flex gap-2">
            <input
              className={inputCls}
              placeholder="https://example.com/page"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && run()}
            />
            <button className={`${btnCls} shrink-0`} onClick={() => run()} disabled={loading || !url.trim()}>
              {loading ? "审计中…" : "开始审计"}
            </button>
          </div>
        </Field>
        <div className="mt-3 flex flex-wrap gap-2">
          {["https://whivi.com", "https://www.baidu.com", "https://github.com"].map((s) => (
            <button
              key={s}
              onClick={() => { setUrl(s); run(s); }}
              className="rounded-md border border-ink-200 px-2.5 py-1 text-[11.5px] text-ink-700 transition hover:border-ocean-300 hover:text-ocean-700"
            >
              {s.replace("https://", "")}
            </button>
          ))}
        </div>
        {err && (
          <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700">{err}</p>
        )}
      </Card>

      {loading && (
        <Card>
          <div className="flex items-center gap-3">
            <span className="pulse-ring h-2.5 w-2.5 rounded-full bg-ocean-500" />
            <span className="text-[13px] text-ink-700">正在抓取并分析页面…</span>
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
          {/* 双评分 */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card className="flex flex-col items-center justify-center">
              <h3 className="text-[13px] font-medium text-ink-700">传统 SEO 分</h3>
              <div className="mt-3"><ScoreRing score={data.seoScore} label="Google 视角" /></div>
              <p className="mt-3 text-center text-[11.5px] leading-relaxed text-ink-500">
                元信息、可访问性、移动端等基础项，open-seo 也覆盖这部分。
              </p>
            </Card>

            <Card className="flex flex-col items-center justify-center border-ocean-200 bg-gradient-to-br from-ocean-50 to-white">
              <h3 className="text-[13px] font-medium text-ocean-800">GEO 分</h3>
              <div className="mt-3"><ScoreRing score={data.geoScore} size={112} label="AI 引用友好度" /></div>
              <p className="mt-3 text-center text-[11.5px] leading-relaxed text-ink-600">
                六维度评估「AI 是否愿意且能够引用此页」—— open-seo 无此能力。
              </p>
            </Card>

            <div className="grid grid-cols-2 gap-3">
              <Stat label="HTTP" value={data.httpStatus || "—"} tone={data.httpStatus === 200 ? "good" : "bad"} />
              <Stat label="正文词数" value={data.wordCount.toLocaleString()} />
              <Stat label="标题数" value={data.headings.length} hint={`${data.headings.filter(h => h.level === 1).length} 个 H1`} />
              <Stat label="图片缺 Alt" value={data.imagesWithoutAlt} hint={`共 ${data.imageCount} 张`} tone={data.imagesWithoutAlt === 0 ? "good" : "warn"} />
              <Stat label="内链" value={data.internalLinks} />
              <Stat label="外链" value={data.externalLinks} />
            </div>
          </div>

          {/* GEO 六维 */}
          {data.geoBreakdown.length > 0 && (
            <Card>
              <SectionTitle title="GEO 六维拆解" desc="每一项都由可观测的真实信号计算得出，下面是它的依据。" />
              <div className="space-y-3.5">
                {data.geoBreakdown.map((b) => {
                  const ratio = b.score / b.max;
                  return (
                    <div key={b.id}>
                      <div className="mb-1 flex items-baseline justify-between gap-3">
                        <span className="text-[13px] font-medium text-ink-900">{b.label}</span>
                        <span className="tabular text-[12px] text-ink-500">
                          <span className={ratio >= 0.75 ? "text-emerald-600" : ratio >= 0.5 ? "text-amber-600" : "text-rose-600"}>
                            {b.score}
                          </span>
                          /{b.max}
                        </span>
                      </div>
                      <Bar ratio={ratio} tone={ratio >= 0.75 ? "good" : ratio >= 0.5 ? "warn" : "bad"} />
                      <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-500">{b.comment}</p>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* 整改建议 */}
          <Card>
            <SectionTitle title="可执行建议" desc="按收益从高到低排列。" />
            <ol className="space-y-2.5">
              {data.recommendations.map((r, i) => (
                <li key={i} className="flex gap-3">
                  <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md bg-ocean-100 text-[11px] font-semibold text-ocean-700">
                    {i + 1}
                  </span>
                  <span className="text-[12.5px] leading-relaxed text-ink-700">{r}</span>
                </li>
              ))}
            </ol>
          </Card>

          {/* 检查项 */}
          <Card>
            <SectionTitle title="技术检查明细" desc={`共 ${data.checks.length} 项。`} />
            <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
              {data.checks.map((c) => (
                <div
                  key={c.id}
                  className={`rounded-lg border p-3 ${
                    c.level === "pass" ? "border-emerald-200 bg-emerald-50/40"
                      : c.level === "warn" ? "border-amber-200 bg-amber-50/40"
                        : "border-rose-200 bg-rose-50/40"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-ink-900">{c.label}</span>
                    <Badge tone={c.level === "pass" ? "good" : c.level === "warn" ? "warn" : "bad"}>
                      {c.level === "pass" ? "通过" : c.level === "warn" ? "待优化" : "不合格"}
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-600">{c.detail}</p>
                  {c.value && (
                    <p className="mt-1.5 truncate rounded bg-white/70 px-2 py-1 text-[11px] text-ink-500" title={c.value}>
                      {c.value}
                    </p>
                  )}
                  {c.fix && (
                    <p className="mt-2 text-[11.5px] leading-relaxed text-ink-700">
                      <span className="font-medium">怎么改：</span>{c.fix}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </Card>

          {/* 页面实况 */}
          <Card>
            <SectionTitle title="页面实况" />
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-[12.5px] md:grid-cols-2">
              <Row k="最终 URL" v={data.finalUrl} />
              <Row k="耗时" v={`${data.elapsedMs} ms`} />
              <Row k="Title" v={data.title ?? "—"} sub={`${data.titleLength} 字`} />
              <Row k="Description" v={data.metaDescription ?? "—"} sub={`${data.metaDescriptionLength} 字`} />
              <Row k="Canonical" v={data.canonical ?? "—"} />
              <Row k="lang" v={data.lang ?? "—"} />
              <Row k="robots meta" v={data.robotsMeta ?? "（未声明，默认 index,follow）"} />
              <Row k="hreflang" v={data.hreflang.length ? data.hreflang.join(", ") : "—"} />
              <Row k="JSON-LD 类型" v={data.jsonLdTypes.length ? data.jsonLdTypes.join(", ") : "—"} />
              <Row k="OG 标签" v={Object.keys(data.ogTags).length ? Object.keys(data.ogTags).join(", ") : "—"} />
              <Row k="viewport" v={data.hasViewport ? "已声明" : "缺失"} />
              <Row k="链接构成" v={`内链 ${data.internalLinks} / 外链 ${data.externalLinks}`} />
            </dl>
            {data.headings.length > 0 && (
              <div className="mt-5 border-t border-ink-100 pt-4">
                <p className="mb-2 text-[12px] font-medium text-ink-700">标题结构</p>
                <div className="space-y-1">
                  {data.headings.slice(0, 14).map((h, i) => (
                    <div key={i} className="flex items-start gap-2" style={{ paddingLeft: `${(h.level - 1) * 14}px` }}>
                      <span className="mt-0.5 shrink-0 rounded bg-ink-100 px-1.5 text-[10px] font-medium text-ink-600">
                        H{h.level}
                      </span>
                      <span className="text-[12px] leading-relaxed text-ink-700">{h.text}</span>
                    </div>
                  ))}
                  {data.headings.length > 14 && (
                    <p className="text-[11px] text-ink-500">…另有 {data.headings.length - 14} 个标题</p>
                  )}
                </div>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

function Row({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-500">{k}</dt>
      <dd className="mt-0.5 break-words text-ink-900">
        {v} {sub && <span className="text-[11px] text-ink-500">（{sub}）</span>}
      </dd>
    </div>
  );
}
