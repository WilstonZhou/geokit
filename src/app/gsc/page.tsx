"use client";

import { useMemo, useState } from "react";
import { Card, SectionTitle, Badge, Stat, Field, inputCls, btnCls } from "@/components/ui";

type GscStatus = "ok" | "blocked" | "unavailable" | "error";
type Dimension = "query" | "page" | "date" | "country" | "device";

interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface GscOpportunity {
  kind: "high-impression-low-ctr" | "ranking-opportunity" | "content-gap";
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  evidence: string[];
  suggestion: string;
}

interface GscResult {
  status: GscStatus;
  statusReason?: string;
  httpStatus?: number;
  rows: GscRow[];
  siteUrl?: string;
  startDate?: string;
  endDate?: string;
  dimensions?: string[];
  rowCount?: number;
  analysis?: {
    opportunities: GscOpportunity[];
    counts: Record<string, number>;
  };
  error?: string;
}

const DIMENSION_OPTIONS: { id: Dimension; label: string }[] = [
  { id: "query", label: "查询词" },
  { id: "page", label: "页面" },
  { id: "country", label: "国家" },
  { id: "device", label: "设备" },
  { id: "date", label: "日期" },
];

const OPP_META: Record<
  GscOpportunity["kind"],
  { label: string; tone: "bad" | "warn" | "neutral" }
> = {
  "high-impression-low-ctr": { label: "高曝光低点击", tone: "bad" },
  "ranking-opportunity": { label: "排名机会位", tone: "warn" },
  "content-gap": { label: "内容缺口", tone: "neutral" },
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const STATUS_TEXT: Record<GscStatus, string> = {
  ok: "成功",
  blocked: "被拒绝",
  unavailable: "未配置/不可用",
  error: "错误",
};

export default function GscPage() {
  const [siteUrl, setSiteUrl] = useState("sc-domain:");
  // 默认日期取当前时间；放进 useState 惰性初始化器，仅在挂载时计算一次
  const [endDate, setEndDate] = useState(() => isoDate(new Date()));
  const [startDate, setStartDate] = useState(() =>
    isoDate(new Date(Date.now() - 27 * 86_400_000))
  );
  const [dims, setDims] = useState<Dimension[]>(["query"]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<GscResult | null>(null);

  function toggleDim(d: Dimension) {
    setDims((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]
    );
  }

  async function run() {
    if (!siteUrl.trim() || siteUrl.trim() === "sc-domain:") {
      setError("请填写 Search Console 资源，如 sc-domain:example.com");
      return;
    }
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch("/api/gsc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siteUrl: siteUrl.trim(),
          startDate,
          endDate,
          dimensions: dims,
        }),
      });
      const json = (await res.json()) as GscResult;
      if (!res.ok) throw new Error(json.error ?? "查询失败");
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const totals = useMemo(() => {
    const rows = data?.rows ?? [];
    let clicks = 0;
    let impressions = 0;
    let posWeighted = 0;
    for (const r of rows) {
      clicks += r.clicks;
      impressions += r.impressions;
      posWeighted += r.position * r.impressions;
    }
    return {
      clicks,
      impressions,
      ctr: impressions > 0 ? clicks / impressions : 0,
      avgPosition: impressions > 0 ? posWeighted / impressions : 0,
    };
  }, [data]);

  const sortedRows = useMemo(
    () => [...(data?.rows ?? [])].sort((a, b) => b.impressions - a.impressions),
    [data]
  );

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold text-ink-900">Google Search Console 搜索表现</h1>
        <p className="mt-1 text-[12.5px] text-ink-500">
          拉取真实 Search Analytics 数据，识别高曝光低点击、排名机会位与内容缺口。需要自备 Google 凭证（见下方配置说明）。
        </p>
      </header>

      <Card>
        <SectionTitle title="查询条件" />
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Search Console 资源">
            <input
              className={inputCls}
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
              placeholder="sc-domain:example.com 或 https://example.com/"
            />
          </Field>
          <Field label="维度（可多选）">
            <div className="flex flex-wrap gap-2 pt-1">
              {DIMENSION_OPTIONS.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => toggleDim(d.id)}
                  className={`rounded-md border px-2.5 py-1 text-[12px] transition ${
                    dims.includes(d.id)
                      ? "border-ocean-200 bg-ocean-50 text-ocean-700"
                      : "border-ink-200 bg-white text-ink-600 hover:border-ocean-300"
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="开始日期">
            <input
              type="date"
              className={inputCls}
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </Field>
          <Field label="结束日期">
            <input
              type="date"
              className={inputCls}
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </Field>
        </div>
        <div className="mt-4">
          <button className={btnCls} onClick={run} disabled={loading}>
            {loading ? "查询中…" : "拉取搜索表现"}
          </button>
        </div>
      </Card>

      {loading && (
        <Card>
          <div className="flex items-center gap-3">
            <span className="pulse-ring h-2.5 w-2.5 rounded-full bg-ocean-500" />
            <span className="text-[13px] text-ink-700">正在调用 Search Console API 并分页拉取…</span>
          </div>
        </Card>
      )}

      {error && (
        <Card>
          <p className="text-[13px] text-red-600">{error}</p>
        </Card>
      )}

      {data && data.status !== "ok" && (
        <Card>
          <SectionTitle
            title={`状态：${STATUS_TEXT[data.status]}`}
            desc={data.statusReason}
          />
          {data.status === "unavailable" && (
            <div className="mt-3 space-y-2 rounded-lg bg-ink-50 p-3 text-[12px] text-ink-700">
              <p className="font-medium text-ink-900">配置方式（任选其一，写进 .env.local）：</p>
              <p>
                <code className="rounded bg-white px-1 py-0.5">GOOGLE_OAUTH_ACCESS_TOKEN=ya29....</code>
                （OAuth access token，约 1 小时有效，可由 Google OAuth Playground 获取）
              </p>
              <p>
                <code className="rounded bg-white px-1 py-0.5">GOOGLE_SERVICE_ACCOUNT_JSON=&#123;...&#125;</code>
                （service account JSON 内联；自动用 RS256 JWT 换取并缓存令牌）
              </p>
              <p>
                <code className="rounded bg-white px-1 py-0.5">GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json</code>
                （service account JSON 文件路径）
              </p>
              <p className="text-ink-500">
                service account 需在 Search Console 对应资源里被添加为用户；凭证不会被写入日志或存档。
              </p>
            </div>
          )}
          {data.httpStatus !== undefined && (
            <p className="mt-2 text-[12px] text-ink-500">HTTP 状态码：{data.httpStatus}</p>
          )}
        </Card>
      )}

      {data && data.status === "ok" && (
        <>
          <Card>
            <SectionTitle
              title="汇总"
              desc={`${data.siteUrl} · ${data.startDate} ~ ${data.endDate} · ${data.rowCount ?? 0} 行`}
            />
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="总点击" value={totals.clicks.toLocaleString()} />
              <Stat label="总展示" value={totals.impressions.toLocaleString()} />
              <Stat label="平均 CTR" value={`${(totals.ctr * 100).toFixed(2)}%`} />
              <Stat label="加权平均位置" value={totals.avgPosition.toFixed(1)} />
            </div>
          </Card>

          {data.analysis && data.analysis.opportunities.length > 0 && (
            <Card>
              <SectionTitle
                title={`搜索机会（${data.analysis.opportunities.length}）`}
                desc={`高曝光低点击 ${data.analysis.counts["high-impression-low-ctr"] ?? 0} · 排名机会位 ${data.analysis.counts["ranking-opportunity"] ?? 0} · 内容缺口 ${data.analysis.counts["content-gap"] ?? 0}`}
              />
              <ul className="mt-2 divide-y divide-ink-100">
                {data.analysis.opportunities.map((o, i) => {
                  const meta = OPP_META[o.kind];
                  return (
                    <li key={`${o.kind}-${i}`} className="py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                        <span className="break-all text-[12.5px] font-medium text-ink-900">
                          {o.key}
                        </span>
                        <span className="ml-auto shrink-0 text-[11px] tabular text-ink-500">
                          展示 {o.impressions} · 点击 {o.clicks} · 位置 {o.position.toFixed(1)}
                        </span>
                      </div>
                      <ul className="mt-1.5 space-y-0.5 pl-1 text-[11.5px] text-ink-600">
                        {o.evidence.map((e, j) => (
                          <li key={j}>· {e}</li>
                        ))}
                      </ul>
                      <p className="mt-1 text-[12px] text-ink-700">
                        <span className="font-medium text-ink-900">建议：</span>
                        {o.suggestion}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          {data.analysis && data.analysis.opportunities.length === 0 && (
            <Card>
              <p className="py-4 text-center text-[12px] text-ink-500">
                当前阈值下未发现明显机会（阈值见 gsc/analyze.ts 常量）。
              </p>
            </Card>
          )}

          <Card>
            <SectionTitle title="明细（按展示量降序）" desc={`共 ${sortedRows.length} 行`} />
            <div className="mt-2 max-h-[520px] overflow-auto">
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-white text-left text-ink-500">
                  <tr className="border-b border-ink-100">
                    <th className="py-2 pr-3 font-medium">维度值</th>
                    <th className="py-2 pr-3 text-right font-medium">点击</th>
                    <th className="py-2 pr-3 text-right font-medium">展示</th>
                    <th className="py-2 pr-3 text-right font-medium">CTR</th>
                    <th className="py-2 text-right font-medium">位置</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((r, i) => (
                    <tr key={i} className="border-b border-ink-50">
                      <td className="max-w-[420px] truncate py-1.5 pr-3 text-ink-800" title={r.keys.join(" | ")}>
                        {r.keys.join(" | ")}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular text-ink-700">{r.clicks}</td>
                      <td className="py-1.5 pr-3 text-right tabular text-ink-700">{r.impressions}</td>
                      <td className="py-1.5 pr-3 text-right tabular text-ink-700">
                        {(r.ctr * 100).toFixed(2)}%
                      </td>
                      <td className="py-1.5 text-right tabular text-ink-700">{r.position.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
