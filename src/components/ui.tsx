import type { ReactNode } from "react";

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-ink-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${className}`}
    >
      {children}
    </div>
  );
}

export function SectionTitle({
  title,
  desc,
  action,
}: {
  title: string;
  desc?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-[15px] font-semibold text-ink-900">{title}</h2>
        {desc && <p className="mt-1 text-[13px] leading-relaxed text-ink-500">{desc}</p>}
      </div>
      {action}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad" | "info";
}) {
  const map = {
    neutral: "bg-ink-100 text-ink-700 border-ink-200",
    good: "bg-emerald-50 text-emerald-700 border-emerald-200",
    warn: "bg-amber-50 text-amber-700 border-amber-200",
    bad: "bg-rose-50 text-rose-700 border-rose-200",
    info: "bg-ocean-50 text-ocean-700 border-ocean-200",
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium ${map[tone]}`}
    >
      {children}
    </span>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const color =
    tone === "good"
      ? "text-emerald-600"
      : tone === "warn"
        ? "text-amber-600"
        : tone === "bad"
          ? "text-rose-600"
          : "text-ink-900";
  return (
    <div className="rounded-xl border border-ink-200 bg-white p-4">
      <p className="text-[11.5px] font-medium text-ink-500">{label}</p>
      <p className={`tabular mt-1.5 text-2xl font-semibold leading-none ${color}`}>{value}</p>
      {hint && <p className="mt-1.5 text-[11px] leading-snug text-ink-500">{hint}</p>}
    </div>
  );
}

/** 环形评分 */
export function ScoreRing({
  score,
  size = 96,
  label,
}: {
  score: number;
  size?: number;
  label?: string;
}) {
  const r = (size - 12) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score));
  const color =
    pct >= 75 ? "#10b981" : pct >= 50 ? "#f59e0b" : pct >= 25 ? "#f97316" : "#e11d48";
  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e2e8f0" strokeWidth="8" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
        />
      </svg>
      <div className="-mt-[calc(50%+6px)] flex flex-col items-center">
        <span className="tabular text-xl font-semibold text-ink-900">{pct}</span>
      </div>
      {label && <p className="mt-7 text-[11px] text-ink-500">{label}</p>}
    </div>
  );
}

export function Bar({ ratio, tone = "ocean" }: { ratio: number; tone?: "ocean" | "warn" | "bad" | "good" }) {
  const color =
    tone === "good" ? "bg-emerald-500" : tone === "warn" ? "bg-amber-500" : tone === "bad" ? "bg-rose-500" : "bg-ocean-500";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-100">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-200 bg-ink-50/50 px-5 py-10 text-center text-[13px] text-ink-500">
      {children}
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-ink-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-ink-500">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-[13.5px] text-ink-900 outline-none transition placeholder:text-ink-500/60 focus:border-ocean-400 focus:ring-2 focus:ring-ocean-100";

export const btnCls =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-ocean-600 px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-ocean-700 disabled:cursor-not-allowed disabled:opacity-45";
