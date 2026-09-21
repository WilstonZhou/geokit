"use client";

import { useState } from "react";
import { Card, SectionTitle, Badge, Stat, Field, inputCls, btnCls } from "@/components/ui";

interface Probe {
  provider: string; providerName: string; vendor: string;
  status: "mentioned" | "not_mentioned" | "unconfigured" | "error";
  mentioned: boolean; excerpt: string | null; citedDomains: string[];
  note?: string; elapsedMs: number;
}
interface Report {
  brand: string; prompt: string; probes: Probe[];
  visibilityScore: number; configuredCount: number; mentionedCount: number;
  topCitedDomains: { domain: string; count: number }[]; generatedAt: string;
}

const STATUS_TEXT: Record<Probe["status"], { text: string; tone: "good" | "warn" | "bad" | "neutral" }> = {
  mentioned: { text: "已提及", tone: "good" },
  not_mentioned: { text: "未提及", tone: "bad" },
  unconfigured: { text: "未配置 Key", tone: "neutral" },
  error: { text: "调用失败", tone: "warn" },
};

export default function VisibilityPage() {
  const [brand, setBrand] = useState("");
  const [topic, setTopic] = useState("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<Report | null>(null);
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
    if (!brand.trim() || !topic.trim()) return;
    setLoading(true); setErr(null); setData(null);
    try {
      const res = await fetch("/api/visibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand: brand.trim(), topic: topic.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "探测失败");
      setData(json);
      loadConfig();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[20px] font-semibold text-ink-900">中文 AI 可见性矩阵</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
          向九个模型提问同一个问题，看它们会不会提到你的品牌。open-seo 的 AI Visibility 只覆盖
          ChatGPT / Claude / Gemini / Perplexity —— 而中文用户实际在问 DeepSeek、豆包、Kimi、通义、文心、元宝。
        </p>
      </div>

      <Card>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="品牌 / 公司名">
            <input className={inputCls} placeholder="例如：鲸汇通" value={brand} onChange={(e) => setBrand(e.target.value)} />
          </Field>
          <Field label="提问主题" hint="模拟真实用户的提问方式，效果最接近实际">
            <input
              className={inputCls}
              placeholder="例如：跨境支付平台有哪些推荐"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && run()}
            />
          </Field>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button className={btnCls} onClick={run} disabled={loading || !brand.trim() || !topic.trim()}>
            {loading ? "探测中…" : "开始探测"}
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
            <span className="text-[13px] text-ink-700">正在并发询问各模型…</span>
          </div>
        </Card>
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat
              label="可见性得分"
              value={data.configuredCount ? `${data.visibilityScore}%` : "—"}
              hint={data.configuredCount ? "已配置模型中的提及率" : "需要先配置至少一个 API key"}
              tone={!data.configuredCount ? "default" : data.visibilityScore >= 50 ? "good" : "bad"}
            />
            <Stat label="提及该品牌" value={`${data.mentionedCount}/${data.configuredCount}`} />
            <Stat label="参与探测" value={`${data.probes.length}`} hint="个模型，含未配置" />
            <Stat label="引用域名池" value={data.topCitedDomains.length} hint="多个模型共同引用即权威信源" />
          </div>

          <Card>
            <SectionTitle title="探测结果" />
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {data.probes.map((p) => {
                const st = STATUS_TEXT[p.status];
                return (
                  <div
                    key={p.provider}
                    className={`rounded-lg border p-3.5 ${
                      p.status === "mentioned" ? "border-emerald-200 bg-emerald-50/40"
                        : p.status === "not_mentioned" ? "border-rose-200 bg-rose-50/40"
                          : "border-ink-200 bg-white"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <span className="text-[13.5px] font-semibold text-ink-900">{p.providerName}</span>
                        <span className="ml-2 text-[11px] text-ink-500">{p.vendor}</span>
                      </div>
                      <Badge tone={st.tone}>{st.text}</Badge>
                    </div>

                    {p.excerpt && (
                      <p className="mt-2.5 rounded bg-white/80 px-2.5 py-2 text-[11.5px] leading-relaxed text-ink-600">
                        {p.excerpt}
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
                    <p className="tabular mt-2 text-[10.5px] text-ink-400">{p.elapsedMs} ms</p>
                  </div>
                );
              })}
            </div>
          </Card>

          {data.topCitedDomains.length > 0 && (
            <Card>
              <SectionTitle
                title="权威信源池"
                desc="被多个模型共同引用的域名 —— 比起「发外链就有权重」的老经验，这更接近 AI 时代的投放逻辑。"
              />
              <div className="space-y-2">
                {data.topCitedDomains.map((d) => (
                  <div key={d.domain} className="flex items-center gap-3">
                    <span className="w-56 shrink-0 truncate text-[12.5px] text-ink-900">{d.domain}</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-100">
                      <div
                        className="h-full rounded-full bg-ocean-500"
                        style={{ width: `${(d.count / data.configuredCount || 0.1) * 100}%` }}
                      />
                    </div>
                    <span className="tabular w-16 shrink-0 text-right text-[11.5px] text-ink-500">
                      {d.count} 次
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {data.configuredCount === 0 && (
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
