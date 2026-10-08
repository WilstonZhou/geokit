"use client";

import { useState } from "react";
import { Card, SectionTitle, Badge, Stat, Field, inputCls, btnCls } from "@/components/ui";

type ProbeStatus = "MENTIONED" | "NOT_MENTIONED" | "INDETERMINATE" | "BLOCKED" | "ERROR" | "UNOBSERVABLE";

interface CitationInfo {
  query: string;
  model: string;
  mentioned: boolean;
  mentionContext?: string;
  citations: { url: string; title?: string; position?: number }[];
  citationsStatus: string;
  competitorsMentioned: string[];
  observedAt: string;
}

interface Probe {
  provider: string; providerName: string; vendor: string;
  status: ProbeStatus;
  mentioned: boolean; excerpt: string | null; citedDomains: string[];
  requestedModel: string; servedModel: string | null;
  promptVersion: string; parserVersion: string; confidence: string;
  note?: string; elapsedMs: number;
  unobservableReason?: string;
  citation?: CitationInfo;
}
interface Report {
  brand: string; prompt: string; promptVersion: string; probes: Probe[];
  visibilityScore: number;
  observedCount: number; configuredCount: number; mentionedCount: number;
  failedCount: number; unobservableCount: number;
  topCitedDomains: { domain: string; count: number }[];
  parserVersion: string; generatedAt: string;
}

/**
 * 六态与后端一一对应。
 * 刻意不把 BLOCKED / ERROR / UNOBSERVABLE 收合成一个「失败」——
 * 「厂商限流拒绝」和「压根没配 key」的处置动作完全不同。
 */
const STATUS_TEXT: Record<ProbeStatus, { text: string; tone: "good" | "warn" | "bad" | "neutral" }> = {
  MENTIONED: { text: "已提及", tone: "good" },
  NOT_MENTIONED: { text: "未提及", tone: "bad" },
  INDETERMINATE: { text: "无法判定", tone: "warn" },
  BLOCKED: { text: "厂商拒绝", tone: "warn" },
  ERROR: { text: "调用失败", tone: "warn" },
  UNOBSERVABLE: { text: "未观测", tone: "neutral" },
};

/** 单元格里的短标签：能引用时附上引用数，绝不留空白 */
function cellText(p: Probe): string {
  const base = STATUS_TEXT[p.status]?.text ?? p.status;
  if (p.citation && p.citation.citations.length > 0) {
    return `${base} · 引${p.citation.citations.length}`;
  }
  return base;
}

/** 单元格悬停说明：非 ok 状态必须说清为什么 */
function cellTitle(p: Probe): string {
  const st = STATUS_TEXT[p.status];
  const why =
    p.note ??
    (p.citation && p.citation.citationsStatus !== "ok"
      ? "模型响应中未包含可提取的引用链接"
      : undefined) ??
    p.unobservableReason;
  return `${p.providerName}：${st?.text ?? p.status}${why ? ` —— ${why}` : ""}`;
}

export default function VisibilityPage() {
  const [brand, setBrand] = useState("");
  const [topicsText, setTopicsText] = useState("");
  const [competitorsText, setCompetitorsText] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  /** 每个 query 一份报告 —— 矩阵与卡片都从这里来 */
  const [reports, setReports] = useState<{ topic: string; report: Report }[]>([]);
  const [cfg, setCfg] = useState<{ id: string; name: string; vendor: string; cnRelevance: string; configured: boolean; envKey: string }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function loadConfig() {
    try {
      const r = await fetch("/api/visibility");
      setCfg((await r.json()).providers);
    } catch { /* ignore */ }
  }

  if (!cfg && typeof window !== "undefined") {
    // 首次渲染后拉一次配置状态
    setTimeout(loadConfig, 0);
  }

  async function run() {
    // 多 query：每行一个。仍复用单 query API —— 不改变后端接口形状
    const topics = Array.from(
      new Set(topicsText.split("\n").map((t) => t.trim()).filter(Boolean))
    ).slice(0, 10);
    if (!brand.trim() || topics.length === 0) return;
    // 竞品清单：逗号/空格分隔，可选。只用于标注答案里提到了哪些竞品
    const competitors = Array.from(
      new Set(competitorsText.split(/[,，\s]+/).map((c) => c.trim()).filter(Boolean))
    );

    setLoading(true); setErr(null); setReports([]);
    setProgress({ done: 0, total: topics.length });
    try {
      const collected: { topic: string; report: Report }[] = [];
      for (const topic of topics) {
        const res = await fetch("/api/visibility", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brand: brand.trim(), topic, competitors }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "探测失败");
        collected.push({ topic, report: json });
        setReports([...collected]);
        setProgress((p) => ({ ...p, done: p.done + 1 }));
      }
      loadConfig();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  /** 模型列 = 所有报告中出现过的 provider（保持首次出现顺序） */
  const columns: { provider: string; providerName: string }[] = [];
  for (const { report } of reports) {
    for (const p of report.probes) {
      if (!columns.some((c) => c.provider === p.provider)) {
        columns.push({ provider: p.provider, providerName: p.providerName });
      }
    }
  }
  const totals = reports.reduce(
    (acc, { report }) => ({
      mentioned: acc.mentioned + report.mentionedCount,
      observed: acc.observed + report.observedCount,
      failed: acc.failed + report.failedCount + report.unobservableCount,
      scoreSum: acc.scoreSum + report.visibilityScore,
      scoreN: acc.scoreN + (report.configuredCount ? 1 : 0),
      cited: acc.cited + report.topCitedDomains.length,
    }),
    { mentioned: 0, observed: 0, failed: 0, scoreSum: 0, scoreN: 0, cited: 0 }
  );
  const avgScore = totals.scoreN ? Math.round(totals.scoreSum / totals.scoreN) : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[20px] font-semibold text-ink-900">中文 AI 可见性矩阵</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
          向九个模型提问，看它们会不会提到你的品牌、引用了哪些来源。
          open-seo 的 AI Visibility 只覆盖 ChatGPT / Claude / Gemini / Perplexity ——
          而中文用户实际在问 DeepSeek、豆包、Kimi、通义、文心、元宝。
        </p>
      </div>

      <Card>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="品牌 / 公司名">
            <input className={inputCls} placeholder="例如：鲸汇通" value={brand} onChange={(e) => setBrand(e.target.value)} />
          </Field>
          <Field label="提问主题" hint="每行一个 query，可批量（最多 10 个）。模拟真实用户的提问方式，效果最接近实际">
            <textarea
              className={`${inputCls} min-h-[72px] resize-y`}
              placeholder={"例如：\n跨境支付平台有哪些推荐\n地热能是什么"}
              value={topicsText}
              onChange={(e) => setTopicsText(e.target.value)}
            />
          </Field>
          <Field label="竞品（可选）" hint="逗号或空格分隔。模型答案里提到这些竞品时会单独标注">
            <input
              className={inputCls}
              placeholder="例如：竞品A, 竞品B"
              value={competitorsText}
              onChange={(e) => setCompetitorsText(e.target.value)}
            />
          </Field>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button className={btnCls} onClick={run} disabled={loading || !brand.trim() || !topicsText.trim()}>
            {loading ? `探测中… ${progress.done}/${progress.total}` : "开始探测"}
          </button>
          <span className="text-[11.5px] text-ink-500">
            API key 从服务端环境变量读取，不经过前端。
          </span>
        </div>
        {err && (
          <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700">{err}</p>
        )}
      </Card>

      {/* Key 配置状态 */}
      {cfg && (
        <Card>
          <SectionTitle
            title="模型与密钥状态"
            desc="未配置的模型会返回「未配置 Key」而非猜测结果 —— 这是 GEOkit 的诚实原则。"
          />
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            {cfg.map((p) => (
              <div
                key={p.id}
                className={`rounded-lg border p-2.5 ${
                  p.cnRelevance === "high" ? "border-ocean-200 bg-ocean-50/40" : "border-ink-200 bg-white"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12.5px] font-medium text-ink-900">{p.name}</span>
                  <Badge tone={p.configured ? "good" : "neutral"}>{p.configured ? "已配置" : "未配置"}</Badge>
                </div>
                <p className="mt-1 text-[11px] text-ink-500">{p.vendor}</p>
                <code className="mt-1 block truncate text-[10px] text-ink-400">{p.envKey}</code>
              </div>
            ))}
          </div>
          <p className="mt-3 rounded-lg bg-ink-50 px-3 py-2 text-[11.5px] leading-relaxed text-ink-500">
            在项目根目录创建 <code className="rounded bg-white px-1">.env.local</code> 并在其中写入对应环境变量，重启服务即生效。
            标注「中文高频」的六个模型，正是 open-seo 完全不覆盖的那些。
          </p>
        </Card>
      )}

      {loading && (
        <Card>
          <div className="flex items-center gap-3">
            <span className="pulse-ring h-2.5 w-2.5 rounded-full bg-ocean-500" />
            <span className="text-[13px] text-ink-700">
              正在并发询问各模型… {progress.done}/{progress.total}
            </span>
          </div>
        </Card>
      )}

      {reports.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat
              label="可见性得分"
              value={avgScore !== null ? `${avgScore}%` : "—"}
              hint="各 query 已配置模型提及率的均值"
              tone={!totals.observed ? "default" : avgScore !== null && avgScore >= 50 ? "good" : "bad"}
            />
            <Stat
              label="提及该品牌"
              value={`${totals.mentioned}/${totals.observed}`}
              hint="分子分母均为实际观测数（跨 query 累计）"
            />
            <Stat
              label="未能观测"
              value={totals.failed}
              hint="厂商拒绝 / 故障 / 未配置 Key，均不计入命中率"
            />
            <Stat label="权威信源池" value={totals.cited} hint="多个模型共同引用的域名数（跨 query 去重前）" />
          </div>

          {/* query × model 矩阵：单元格必有一态，非 ok 状态悬停可看原因 */}
          <Card>
            <SectionTitle
              title="query × model 矩阵"
              desc="「引 N」表示该回答里提取到 N 条真实引用链接；悬停可看未提及 / 无法判定的原因。"
            />
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[12px]">
                <thead>
                  <tr>
                    <th className="w-56 border-b border-ink-200 px-2 py-2 text-left font-medium text-ink-500">Query</th>
                    {columns.map((c) => (
                      <th key={c.provider} className="border-b border-ink-200 px-2 py-2 text-left font-medium text-ink-900">
                        {c.providerName}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {reports.map(({ topic, report }) => {
                    const byProvider = new Map(report.probes.map((p) => [p.provider, p]));
                    return (
                      <tr key={topic}>
                        <td className="border-b border-ink-100 px-2 py-2 align-top text-ink-700">{topic}</td>
                        {columns.map((c) => {
                          const p = byProvider.get(c.provider);
                          if (!p) {
                            return (
                              <td key={c.provider} className="border-b border-ink-100 px-2 py-2 text-ink-400">—</td>
                            );
                          }
                          const st = STATUS_TEXT[p.status];
                          return (
                            <td key={c.provider} className="border-b border-ink-100 px-2 py-2" title={cellTitle(p)}>
                              <Badge tone={st?.tone ?? "neutral"}>{cellText(p)}</Badge>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <Card>
            <SectionTitle title="探测结果" desc="每个模型的回答摘要、真实提取到的引用来源与竞品提及。" />
            <div className="space-y-4">
              {reports.map(({ topic, report }) => (
                <div key={topic}>
                  <p className="mb-2 text-[12.5px] font-semibold text-ink-900">Query：{topic}</p>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {report.probes.map((p) => {
                      const st = STATUS_TEXT[p.status];
                      return (
                        <div
                          key={p.provider}
                          className={`rounded-lg border p-3.5 ${
                            p.status === "MENTIONED" ? "border-emerald-200 bg-emerald-50/40"
                              : p.status === "NOT_MENTIONED" ? "border-rose-200 bg-rose-50/40"
                                : "border-ink-200 bg-white"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              <span className="text-[13.5px] font-semibold text-ink-900">{p.providerName}</span>
                              <span className="ml-2 text-[11px] text-ink-500">{p.vendor}</span>
                            </div>
                            <Badge tone={st?.tone ?? "neutral"}>{st?.text ?? p.status}</Badge>
                          </div>

                          {p.excerpt && (
                            <p className="mt-2.5 rounded bg-white/80 px-2.5 py-2 text-[11.5px] leading-relaxed text-ink-600">
                              {p.excerpt}
                            </p>
                          )}
                          {/* T2：真实提取到的引用来源 —— 模型没给就明说，不留空白 */}
                          {p.citation && p.citation.citations.length > 0 && (
                            <div className="mt-2">
                              <p className="text-[10.5px] text-ink-400">回答中的引用来源：</p>
                              <ul className="mt-1 space-y-0.5">
                                {p.citation.citations.slice(0, 8).map((c) => (
                                  <li key={c.url} className="truncate text-[11px]">
                                    {c.title && <span className="text-ink-700">{c.title} · </span>}
                                    <span className="text-ocean-600">{c.url}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {p.citation && p.citation.citations.length === 0 && (
                            <p className="mt-2 text-[11px] text-ink-400">
                              引用来源：{p.citation.citationsStatus === "ok" ? "无" : "模型未提供可提取的引用（unavailable）"}
                            </p>
                          )}
                          {p.citation && p.citation.competitorsMentioned.length > 0 && (
                            <div className="mt-2 flex flex-wrap items-center gap-1">
                              <span className="text-[10.5px] text-ink-400">竞品提及：</span>
                              {p.citation.competitorsMentioned.map((c) => (
                                <span key={c} className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">{c}</span>
                              ))}
                            </div>
                          )}
                          {p.citation?.mentionContext && (
                            <p className="mt-2 rounded bg-white/80 px-2.5 py-1.5 text-[11px] leading-relaxed text-ink-500">
                              提及上下文：…{p.citation.mentionContext}…
                            </p>
                          )}
                          {p.citedDomains.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {p.citedDomains.slice(0, 6).map((d) => (
                                <span key={d} className="rounded bg-ink-100 px-1.5 py-0.5 text-[10px] text-ink-600">{d}</span>
                              ))}
                            </div>
                          )}
                          {p.note && (
                            <p className="mt-2 text-[11.5px] leading-relaxed text-ink-500">{p.note}</p>
                          )}
                          {/* 可复现性元数据：没有这些，这张卡上的结论无法被任何人复核 */}
                          <p className="tabular mt-2 text-[10.5px] leading-relaxed text-ink-400">
                            {p.elapsedMs} ms · {p.servedModel ?? p.requestedModel} · prompt v{p.promptVersion} ·{" "}
                            {p.parserVersion} · confidence: {p.confidence}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {reports.some(({ report }) => report.topCitedDomains.length > 0) && (
            <Card>
              <SectionTitle
                title="权威信源池"
                desc="被多个模型共同引用的域名 —— 比起「发外链就有权重」的老经验，这更接近 AI 时代的投放逻辑。"
              />
              <div className="space-y-2">
                {reports.map(({ topic, report }) =>
                  report.topCitedDomains.map((d) => (
                    <div key={`${topic}-${d.domain}`} className="flex items-center gap-3">
                      <span className="w-56 shrink-0 truncate text-[12.5px] text-ink-900">{d.domain}</span>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-100">
                        <div
                          className="h-full rounded-full bg-ocean-500"
                          style={{ width: `${(d.count / report.configuredCount || 0.1) * 100}%` }}
                        />
                      </div>
                      <span className="tabular w-16 shrink-0 text-right text-[11.5px] text-ink-500">
                        {d.count} 次
                      </span>
                    </div>
                  ))
                )}
              </div>
            </Card>
          )}

          {totals.observed === 0 && (
            <Card className="border-amber-200 bg-amber-50/40">
              <SectionTitle title="当前没有任何模型被真实调用" />
              <p className="text-[12.5px] leading-relaxed text-ink-700">
                上面所有模型都返回了「未配置 Key」。GEOkit 不会用随机文本模拟 AI 的回答来判断品牌是否被提及 ——
                那种结果看着漂亮，但对决策毫无价值。
              </p>
              <p className="mt-2 text-[12.5px] leading-relaxed text-ink-700">
                在 <code className="rounded bg-white px-1.5 py-0.5">.env.local</code> 里加入至少一个厂商的 API key
                后重启服务，即可得到真实的探测结果。
              </p>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
