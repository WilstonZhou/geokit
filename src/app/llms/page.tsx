"use client";

import { useState } from "react";
import { Card, SectionTitle, Badge, Stat, Empty, Field, inputCls, btnCls } from "@/components/ui";

interface Policy {
  crawler: { ua: string; name: string; vendor: string; purpose: string; cnRelevant: boolean };
  policy: "allowed" | "blocked" | "unspecified";
  matchedRule: string | null;
  implication: string;
}
interface Robots {
  url: string; exists: boolean; raw: string | null; sitemaps: string[];
  policies: Policy[]; aiOpennessScore: number; summary: string; recommendations: string[];
}
interface Llms {
  url: string; exists: boolean; bytes: number; lineCount: number;
  hasTitle: boolean; title: string | null; hasBlockquoteSummary: boolean;
  sections: number; linkCount: number;
  issues: { level: "pass" | "warn" | "fail"; label: string; detail: string }[];
  score: number; raw: string | null; recommendations: string[];
}

type Tab = "robots" | "llms" | "generate";

export default function LlmsPage() {
  const [site, setSite] = useState("");
  const [tab, setTab] = useState<Tab>("robots");
  const [loading, setLoading] = useState(false);
  const [robots, setRobots] = useState<Robots | null>(null);
  const [llms, setLlms] = useState<Llms | null>(null);
  const [genSite, setGenSite] = useState("");
  const [genName, setGenName] = useState("");
  const [genDesc, setGenDesc] = useState("");
  const [draft, setDraft] = useState<{ content: string; sources: string[]; warnings: string[] } | null>(null);
  const [genLoading, setGenLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function analyze(target?: string) {
    const s = (target ?? site).trim();
    if (!s) return;
    setLoading(true); setErr(null);
    try {
      const res = await fetch("/api/llms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site: s }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "分析失败");
      setRobots(json.robots);
      setLlms(json.llms);
      setGenSite(s);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function generate() {
    if (!genSite.trim()) return;
    setGenLoading(true);
    try {
      const res = await fetch("/api/llms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          site: genSite.trim(),
          action: "generate",
          siteName: genName.trim() || undefined,
          description: genDesc.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "生成失败");
      setDraft(json);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setGenLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[20px] font-semibold text-ink-900">AI 抓取协议层</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
          robots.txt 对 AI 爬虫的态度、以及 llms.txt 的检测与生成。值得一提：在 open-seo
          的仓库里，&ldquo;llms.txt&rdquo; 这个词
          <span className="font-medium text-ink-700">只出现在一份产品研究文档里，没有任何代码实现</span>。
        </p>
      </div>

      <Card>
        <Field label="站点">
          <div className="flex gap-2">
            <input
              className={inputCls}
              placeholder="https://example.com"
              value={site}
              onChange={(e) => setSite(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && analyze()}
            />
            <button className={`${btnCls} shrink-0`} onClick={() => analyze()} disabled={loading || !site.trim()}>
              {loading ? "分析中…" : "检测"}
            </button>
          </div>
        </Field>
        {err && (
          <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700">{err}</p>
        )}
      </Card>

      {loading && (
        <Card>
          <div className="flex items-center gap-3">
            <span className="pulse-ring h-2.5 w-2.5 rounded-full bg-ocean-500" />
            <span className="text-[13px] text-ink-700">正在抓取 robots.txt 与 llms.txt…</span>
          </div>
        </Card>
      )}

      {(robots || llms) && (
        <>
          <div className="flex gap-2 border-b border-ink-200">
            {([
              ["robots", "robots.txt AI 策略"],
              ["llms", "llms.txt 检测"],
              ["generate", "生成 llms.txt"],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`-mb-px border-b-2 px-4 py-2 text-[13px] transition ${
                  tab === id
                    ? "border-ocean-600 font-medium text-ocean-700"
                    : "border-transparent text-ink-500 hover:text-ink-900"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "robots" && robots && <RobotsPanel r={robots} />}
          {tab === "llms" && llms && <LlmsPanel l={llms} />}
          {tab === "generate" && (
            <GeneratePanel
              genSite={genSite} setGenSite={setGenSite}
              genName={genName} setGenName={setGenName}
              genDesc={genDesc} setGenDesc={setGenDesc}
              draft={draft} loading={genLoading} onGenerate={generate}
            />
          )}
        </>
      )}

      {!robots && !llms && !loading && (
        <Empty>输入一个站点地址开始检测。</Empty>
      )}
    </div>
  );
}

function RobotsPanel({ r }: { r: Robots }) {
  const allowed = r.policies.filter((p) => p.policy === "allowed").length;
  const blocked = r.policies.filter((p) => p.policy === "blocked").length;
  const cn = r.policies.filter((p) => p.crawler.cnRelevant);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="AI 开放度" value={r.exists ? `${r.aiOpennessScore}%` : "—"} tone={r.aiOpennessScore >= 70 ? "good" : "warn"} />
        <Stat label="放行" value={allowed} hint={`共 ${r.policies.length} 个已知爬虫`} tone="good" />
        <Stat label="封禁" value={blocked} tone={blocked > 0 ? "bad" : "good"} />
        <Stat label="Sitemap 声明" value={r.sitemaps.length} />
      </div>

      <Card>
        <SectionTitle title="结论" />
        <p className="text-[12.5px] leading-relaxed text-ink-700">{r.summary}</p>
        {r.recommendations.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {r.recommendations.map((rec, i) => (
              <li key={i} className="flex gap-2 text-[12px] leading-relaxed text-ink-600">
                <span className="text-ocean-500">→</span><span>{rec}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {cn.length > 0 && (
        <Card>
          <SectionTitle title="中文相关爬虫" desc="直接影响百度 / 字节系 AI 产品能否拿到你的内容。" />
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {cn.map((p) => (
              <div key={p.crawler.ua} className={`rounded-lg border p-3 ${
                p.policy === "blocked" ? "border-rose-200 bg-rose-50/40" : "border-ink-200 bg-white"
              }`}>
                <div className="flex items-center justify-between">
                  <span className="text-[12.5px] font-medium text-ink-900">{p.crawler.name}</span>
                  <Badge tone={p.policy === "blocked" ? "bad" : p.policy === "allowed" ? "good" : "neutral"}>
                    {p.policy === "blocked" ? "封禁" : p.policy === "allowed" ? "放行" : "未指定"}
                  </Badge>
                </div>
                <p className="mt-1 text-[11px] text-ink-500">{p.crawler.vendor} · {p.crawler.purpose}</p>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-600">{p.implication}</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <SectionTitle title={`全部 ${r.policies.length} 个已知爬虫`} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[12.5px]">
            <thead>
              <tr className="border-b border-ink-200 text-left text-[11px] uppercase tracking-wide text-ink-500">
                <th className="py-2 pr-3 font-medium">User-Agent</th>
                <th className="py-2 pr-3 font-medium">厂商</th>
                <th className="py-2 pr-3 font-medium">用途</th>
                <th className="py-2 pr-3 font-medium">策略</th>
                <th className="py-2 font-medium">影响</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {r.policies.map((p) => (
                <tr key={p.crawler.ua} className={p.policy === "blocked" ? "bg-rose-50/30" : ""}>
                  <td className="py-2.5 pr-3 font-mono text-[11px] text-ink-900">{p.crawler.ua}</td>
                  <td className="py-2.5 pr-3 text-ink-700">{p.crawler.vendor}</td>
                  <td className="py-2.5 pr-3 text-ink-500">{p.crawler.purpose}</td>
                  <td className="py-2.5 pr-3">
                    <Badge tone={p.policy === "blocked" ? "bad" : p.policy === "allowed" ? "good" : "neutral"}>
                      {p.policy === "blocked" ? "封禁" : p.policy === "allowed" ? "放行" : "未指定"}
                    </Badge>
                  </td>
                  <td className="py-2.5 text-[11.5px] leading-relaxed text-ink-500">{p.implication}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {r.raw && (
        <Card>
          <SectionTitle title="robots.txt 原文" />
          <pre className="max-h-72 overflow-auto rounded-lg bg-ink-50 p-3 text-[11px] leading-relaxed text-ink-700">
            {r.raw}
          </pre>
        </Card>
      )}
    </div>
  );
}

function LlmsPanel({ l }: { l: Llms }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="规范得分" value={l.exists ? `${l.score}%` : "—"} tone={l.score >= 70 ? "good" : l.score > 0 ? "warn" : "bad"} />
        <Stat label="文件状态" value={l.exists ? "存在" : "缺失"} tone={l.exists ? "good" : "bad"} />
        <Stat label="分区数" value={l.sections} hint="## 层级" />
        <Stat label="推荐链接" value={l.linkCount} />
      </div>

      <Card>
        <SectionTitle title={`校验结果 · ${l.url}`} />
        {!l.exists ? (
          <Empty>
            站点根目录没有 llms.txt。目前采用这个标准的站点还不算多 —— 先做等于先占位。
          </Empty>
        ) : (
          <div className="space-y-2.5">
            {l.issues.map((i, idx) => (
              <div key={idx} className={`rounded-lg border p-3 ${
                i.level === "pass" ? "border-emerald-200 bg-emerald-50/40"
                  : i.level === "warn" ? "border-amber-200 bg-amber-50/40"
                    : "border-rose-200 bg-rose-50/40"
              }`}>
                <div className="flex items-center justify-between">
                  <span className="text-[12.5px] font-medium text-ink-900">{i.label}</span>
                  <Badge tone={i.level === "pass" ? "good" : i.level === "warn" ? "warn" : "bad"}>
                    {i.level === "pass" ? "通过" : i.level === "warn" ? "待优化" : "不合格"}
                  </Badge>
                </div>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-600">{i.detail}</p>
              </div>
            ))}
          </div>
        )}
        <div className="mt-4">
          <p className="mb-2 text-[12px] font-medium text-ink-700">建议</p>
          <ul className="space-y-1.5">
            {l.recommendations.map((rec, i) => (
              <li key={i} className="flex gap-2 text-[12px] leading-relaxed text-ink-600">
                <span className="text-ocean-500">→</span><span>{rec}</span>
              </li>
            ))}
          </ul>
        </div>
      </Card>

      {l.raw && (
        <Card>
          <SectionTitle title="llms.txt 原文" desc={`${l.lineCount} 行 · ${(l.bytes / 1024).toFixed(1)} KB`} />
          <pre className="max-h-80 overflow-auto rounded-lg bg-ink-50 p-3 text-[11px] leading-relaxed text-ink-700">
            {l.raw}
          </pre>
        </Card>
      )}
    </div>
  );
}

function GeneratePanel({
  genSite, setGenSite, genName, setGenName, genDesc, setGenDesc,
  draft, loading, onGenerate,
}: {
  genSite: string; setGenSite: (v: string) => void;
  genName: string; setGenName: (v: string) => void;
  genDesc: string; setGenDesc: (v: string) => void;
  draft: { content: string; sources: string[]; warnings: string[] } | null;
  loading: boolean;
  onGenerate: () => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="站点" hint="首页地址，用于解析真实导航链接">
            <input className={inputCls} value={genSite} onChange={(e) => setGenSite(e.target.value)} />
          </Field>
          <Field label="站点名" hint="留空则取页面 title">
            <input className={inputCls} value={genName} onChange={(e) => setGenName(e.target.value)} />
          </Field>
        </div>
        <div className="mt-4">
          <Field label="一句话定位" hint="留空则取 meta description">
            <input className={inputCls} value={genDesc} onChange={(e) => setGenDesc(e.target.value)} />
          </Field>
        </div>
        <button className={`${btnCls} mt-4`} onClick={onGenerate} disabled={loading || !genSite.trim()}>
          {loading ? "生成中…" : "生成草稿"}
        </button>
        <p className="mt-3 text-[11.5px] leading-relaxed text-ink-500">
          草稿里的每个链接都来自站点首页的真实解析结果 —— GEOkit 不会替你编造 URL。
        </p>
      </Card>

      {draft && (
        <>
          {draft.warnings.length > 0 && (
            <Card className="border-amber-200 bg-amber-50/40">
              {draft.warnings.map((w, i) => (
                <p key={i} className="text-[12.5px] leading-relaxed text-amber-800">⚠ {w}</p>
              ))}
            </Card>
          )}
          <Card>
            <SectionTitle
              title="生成的 llms.txt"
              desc={`基于 ${draft.sources.length} 个真实解析出的站内链接`}
              action={
                <button
                  className="rounded-lg border border-ink-200 px-3 py-1.5 text-[12px] text-ink-700 transition hover:border-ocean-300 hover:text-ocean-700"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(draft.content);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    } catch { /* 剪贴板不可用时忽略 */ }
                  }}
                >
                  {copied ? "已复制 ✓" : "复制"}
                </button>
              }
            />
            <pre className="max-h-96 overflow-auto rounded-lg bg-ink-50 p-4 text-[11.5px] leading-relaxed text-ink-800">
              {draft.content}
            </pre>
            <p className="mt-3 text-[11.5px] leading-relaxed text-ink-500">
              把内容保存为 <code className="rounded bg-ink-100 px-1">/llms.txt</code>{" "}
              部署到站点根目录，然后回到「llms.txt 检测」标签页复检。
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
