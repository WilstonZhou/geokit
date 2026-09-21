import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "鲸析 GEOkit — 中文 SEO / GEO 作战系统",
  description:
    "面向中文市场与 AI 搜索时代的开源 SEO/GEO 工具：百度/搜狗/360/神马/头条多引擎排名、页面审计与 GEO 评分、中文 AI 可见性探测、llms.txt 生成。",
};

const NAV = [
  { href: "/", label: "总览", icon: "◈" },
  { href: "/serp", label: "多引擎排名", icon: "⌕" },
  { href: "/audit", label: "页面审计", icon: "✓" },
  { href: "/visibility", label: "AI 可见性", icon: "◎" },
  { href: "/llms", label: "AI 协议", icon: "§" },
  { href: "/mcp", label: "MCP", icon: "⚡" },
];

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-white">
        <div className="flex min-h-screen">
          <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-ink-200 bg-ink-50/60">
            <div className="border-b border-ink-200 px-5 py-5">
              <Link href="/" className="flex items-center gap-2.5">
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-ocean-500 to-ocean-700 text-base shadow-sm">
                  🐳
                </span>
                <span>
                  <span className="block text-[15px] font-semibold leading-tight text-ink-900">
                    鲸析 GEOkit
                  </span>
                  <span className="block text-[11px] leading-tight text-ink-500">
                    中文 SEO / GEO 作战系统
                  </span>
                </span>
              </Link>
            </div>

            <nav className="flex-1 space-y-1 px-3 py-4">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] text-ink-700 transition-colors hover:bg-white hover:text-ocean-700 hover:shadow-sm"
                >
                  <span className="w-4 text-center text-ocean-500">{item.icon}</span>
                  <span>{item.label}</span>
                </Link>
              ))}
            </nav>

            <div className="border-t border-ink-200 p-3">
              <div className="rounded-lg bg-white p-3 shadow-sm">
                <p className="text-[11px] font-medium text-ink-900">零付费依赖</p>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
                  核心能力自建引擎实现，无需 DataForSEO 账号即可开跑。
                </p>
              </div>
            </div>
          </aside>

          <main className="min-w-0 flex-1">
            <div className="mx-auto max-w-6xl px-8 py-8">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
