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
import type {
  SchemaDiagnosis,
  SchemaDraft,
  FieldCheck,
  TypeSignal,
  ConsistencyIssue,
  EntitySignal,
  ManualField,
} from "@/lib/schema";

interface ApiResult {
  ok?: boolean;
  url?: string;
  httpStatus?: number;
  diagnosis: SchemaDiagnosis;
  draft: SchemaDraft;
  error?: string;
}

const TYPE_LABEL: Record<string, string> = {
  article: "文章",
  product: "产品",
  faq: "FAQ",
  howto: "HowTo 教程",
  "local-business": "本地商家",
  organization: "组织/机构",
  website: "官网首页",
  unknown: "无法判定",
};

const CONF_TONE: Record<string, "good" | "warn" | "neutral"> = {
  high: "good",
  medium: "warn",
  low: "neutral",
};

const STATUS_META: Record<
  FieldCheck["status"],
  { label: string; tone: "good" | "bad" | "warn" | "neutral" }
> = {
  present: { label: "已具备", tone: "good" },
  empty: { label: "空值", tone: "bad" },
  incomplete: { label: "不完整", tone: "warn" },
  missing: { label: "缺失", tone: "bad" },
};

const ENTITY_LABEL: { key: keyof SchemaDiagnosis["entityClarity"]; label: string }[] = [
  { key: "author", label: "作者" },
  { key: "organization", label: "组织" },
  { key: "sameAs", label: "sameAs" },
  { key: "contact", label: "联系方式" },
  { key: "datePublished", label: "发布时间" },
  { key: "dateModified", label: "更新时间" },
];

function SignalList({ signals }: { signals: TypeSignal[] }) {
  if (signals.length === 0)
    return <p className="text-[11.5px] text-ink-400">无可用信号</p>;
  return (
    <ul className="space-y-0.5 text-[11.5px] text-ink-600">
      {signals.map((s, i) => (
        <li key={i}>
          · <code className="rounded bg-ink-50 px-1 py-0.5">{s.signal}</code>
          <span className="ml-1 text-ink-700">{s.value}</span>
          <span className="ml-1 text-ink-400">[{s.source}]</span>
        </li>
      ))}
    </ul>
  );
}

export default function SchemaPage() {
  const [url, setUrl] = useState("");
  const [showHtml, setShowHtml] = useState(false);
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ApiResult | null>(null);
  const [copied, setCopied] = useState(false);

  async function run() {
    if (!url.trim() && !html.trim()) {
      setError("请填写 URL，或展开高级选项粘贴 HTML");
      return;
    }
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch("/api/schema", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), html: showHtml ? html : "" }),
      });
      const json = (await res.json()) as ApiResult;
      if (!res.ok) throw new Error(json.error ?? "诊断失败");
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function copyDraft() {
    if (!data?.draft.jsonLdString) return;
    void navigator.clipboard.writeText(data.draft.jsonLdString).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const d = data?.diagnosis;
  const draft = data?.draft;
  const requiredFields = d?.fieldChecks.filter((f) => f.level === "required") ?? [];
  const recommendedFields =
    d?.fieldChecks.filter((f) => f.level === "recommended") ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold text-ink-900">Schema / 实体诊断</h1>
        <p className="mt-1 text-[12.5px] text-ink-500">
          规则驱动检测页面类型，对照 Schema.org 检查必填/推荐字段、JSON-LD 与可见内容一致性、
          作者/组织/sameAs/联系方式/时间标注，并给出可复制的零编造 JSON-LD 草稿。只诊断，不修改站点。
        </p>
      </header>

      <Card>
        <Field label="页面 URL">
          <input
            className={inputCls}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/article"
          />
        </Field>
        <div className="mt-2">
          <button
            className="text-[12px] text-ocean-700 underline"
            onClick={() => setShowHtml((v) => !v)}
          >
            {showHtml ? "收起 HTML 直贴" : "高级：直接粘贴 HTML 离线分析"}
          </button>
        </div>
        {showHtml && (
          <Field label="页面 HTML">
            <textarea
              className={`${inputCls} min-h-[140px] font-mono text-[12px]`}
              value={html}
              onChange={(e) => setHtml(e.target.value)}
              placeholder="粘贴页面完整 HTML（将优先于 URL 抓取）"
            />
          </Field>
        )}
        <div className="mt-3">
          <button className={btnCls} onClick={run} disabled={loading}>
            {loading ? "诊断中…" : "开始诊断"}
          </button>
        </div>
      </Card>

      {loading && (
        <Card>
          <div className="flex items-center gap-3">
            <span className="pulse-ring h-2.5 w-2.5 rounded-full bg-ocean-500" />
            <span className="text-[13px] text-ink-700">正在抓取并按规则诊断…</span>
          </div>
        </Card>
      )}

      {error && (
        <Card>
          <p className="text-[13px] text-red-600">{error}</p>
        </Card>
      )}

      {data && d && (
        <>
          <Card>
            <SectionTitle title="页面类型判定" desc="规则驱动，每条判定附信号依据；候选类型按置信度排序" />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-[15px] font-semibold text-ink-900">
                {TYPE_LABEL[d.detection.type] ?? d.detection.type}
              </span>
              <Badge tone={CONF_TONE[d.detection.confidence]}>
                置信度：{d.detection.confidence}
              </Badge>
              {d.existingTypes.length > 0 && (
                <span className="text-[11.5px] text-ink-500">
                  已有 JSON-LD：{d.existingTypes.join(", ")}
                </span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {d.detection.candidates.map((c, i) => (
                <Badge key={i} tone={i === 0 ? "info" : "neutral"}>
                  {TYPE_LABEL[c.type] ?? c.type} · {c.confidence}
                </Badge>
              ))}
            </div>
            <div className="mt-2">
              <SignalList signals={d.detection.signals} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="必填缺失" value={d.missingRequiredCount} />
              <Stat label="推荐缺口" value={d.missingRecommendedCount} />
              <Stat label="一致性问题" value={d.consistencyIssues.length} />
              <Stat label="已有 Schema 类型" value={d.existingTypes.length} />
            </div>
          </Card>

          {requiredFields.length > 0 && (
            <FieldGroup title="必填字段（Schema.org）" fields={requiredFields} />
          )}
          {recommendedFields.length > 0 && (
            <FieldGroup title="推荐字段" fields={recommendedFields} />
          )}

          {d.consistencyIssues.length > 0 && (
            <Card>
              <SectionTitle title="JSON-LD 与页面内容一致性" />
              <ul className="mt-2 space-y-2">
                {d.consistencyIssues.map((c: ConsistencyIssue, i) => (
                  <li key={i} className="rounded-md bg-amber-50 px-3 py-2 text-[12px]">
                    <div className="flex items-center gap-2">
                      <Badge tone={c.severity === "mismatch" ? "bad" : "warn"}>
                        {c.severity === "mismatch" ? "矛盾" : "疑似"}
                      </Badge>
                      <code className="text-[11px]">{c.kind}</code>
                    </div>
                    <p className="mt-1 text-ink-700">{c.detail}</p>
                    <p className="mt-0.5 text-[11.5px] text-ink-500">
                      JSON-LD：{c.jsonLdValue ?? "-"} ｜ 页面：{c.pageValue ?? "-"}
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card>
            <SectionTitle title="实体清晰度" desc="作者 / 组织 / sameAs / 联系方式 / 发布与更新时间" />
            <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-3">
              {ENTITY_LABEL.map(({ key, label }) => {
                const s: EntitySignal = d.entityClarity[key];
                return (
                  <div
                    key={key}
                    className="rounded-md border border-ink-100 px-3 py-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] font-medium text-ink-800">{label}</span>
                      <Badge tone={s.present ? "good" : "bad"}>
                        {s.present ? "已标注" : "缺失"}
                      </Badge>
                    </div>
                    {s.present && (
                      <p className="mt-1 break-all text-[11px] text-ink-600">
                        {s.value} <span className="text-ink-400">[{s.source}]</span>
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>

          <Card>
            <SectionTitle title="建议" />
            {d.recommendations.length === 0 ? (
              <Empty>未发现需要改进的 Schema / 实体问题。</Empty>
            ) : (
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-[12.5px] text-ink-700">
                {d.recommendations.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ol>
            )}
          </Card>

          {draft && (
            <Card>
              <SectionTitle
                title="JSON-LD 草稿（可复制）"
                desc="只含页面真实存在的信息；拿不到的字段在下方清单中标注需人工补充，绝不编造"
              />
              {draft.jsonLdString ? (
                <>
                  <div className="mt-2 flex items-center gap-2">
                    <button className={btnCls} onClick={copyDraft}>
                      {copied ? "已复制 ✓" : "复制 JSON"}
                    </button>
                    <span className="text-[11.5px] text-ink-500">
                      已填 {draft.filledFields.length} 个字段，
                      {draft.manualFields.length} 个待人工补充
                    </span>
                  </div>
                  <pre className="mt-2 max-h-[420px] overflow-auto rounded-md bg-ink-900 p-3 text-[11.5px] leading-relaxed text-ink-50">
                    {draft.jsonLdString}
                  </pre>
                </>
              ) : (
                <Empty>
                  页面可观测信息不足以生成任何真实字段（类型：{draft.pageType}）。
                  请先补充页面内容，或参照下方清单人工编写。
                </Empty>
              )}

              {draft.manualFields.length > 0 && (
                <div className="mt-3">
                  <p className="text-[12px] font-medium text-ink-900">需人工补充（不会写进自动草稿）</p>
                  <ul className="mt-1 space-y-1">
                    {draft.manualFields.map((m: ManualField, i) => (
                      <li key={i} className="text-[11.5px] text-ink-700">
                        <Badge tone={m.level === "required" ? "bad" : "warn"}>
                          {m.level === "required" ? "必填" : "推荐"}
                        </Badge>
                        <code className="ml-1 rounded bg-ink-50 px-1 py-0.5">{m.path}</code>
                        <span className="ml-1 text-ink-500">— {m.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {draft.sourcedFrom.length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-[11.5px] text-ocean-700">
                    草稿字段来源核对（{draft.sourcedFrom.length}）
                  </summary>
                  <ul className="mt-1 space-y-0.5 text-[11px] text-ink-600">
                    {draft.sourcedFrom.map((s, i) => (
                      <li key={i}>
                        <code>{s.field}</code> ← {s.source}：{s.value}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function FieldGroup({ title, fields }: { title: string; fields: FieldCheck[] }) {
  return (
    <Card>
      <SectionTitle title={title} />
      <ul className="mt-2 divide-y divide-ink-100">
        {fields.map((f) => {
          const meta = STATUS_META[f.status];
          return (
            <li key={f.path} className="flex items-center gap-2 py-1.5">
              <Badge tone={meta.tone}>{meta.label}</Badge>
              <code className="text-[11.5px] text-ink-800">{f.path}</code>
              {f.observed && (
                <span className="truncate text-[11px] text-ink-500">= {f.observed}</span>
              )}
              {f.note && <span className="text-[11px] text-ink-400">（{f.note}）</span>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
