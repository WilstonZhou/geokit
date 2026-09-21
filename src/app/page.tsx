import Link from "next/link";
import { ENGINES } from "@/lib/engines";
import { PROVIDER_LIST } from "@/lib/visibility";
import { AI_CRAWLERS } from "@/lib/llms";
import { Card, SectionTitle, Badge, Stat } from "@/components/ui";

/** 对比数据全部来自对 github.com/every-app/open-seo 的实测扫描，非推测 */
const FACTS = {
  openSeo: {
    loc: "284,500",
    srcLoc: "128,304",
    srcFiles: "879",
    files: "1,419",
    googleMentions: 973,
    bingMentions: 7,
    baiduMentions: 0,
    sogouMentions: 0,
    providers: ["ChatGPT", "Claude", "Gemini", "Perplexity"],
    license: "MIT（2026 Ben Senescu）",
    deps: 44,
    stack: "TanStack Start / Cloudflare Workers / Drizzle",
  },
};

const CAPABILITIES = [
  {
    icon: "⌕",
    title: "多引擎 SERP 采集",
    desc: "百度、搜狗、360、神马、头条自建采集与位次解析，外加 Google / Bing。每个引擎返回完整结果列表与目标域名的真实位次。",
    href: "/serp",
    highlight: "五个中文引擎 = open-seo 的 0 覆盖区",
  },
  {
    icon: "✓",
    title: "页面审计 + GEO 评分",
    desc: "除传统技术检查外，输出六维「AI 引用友好度」评分：可引用性、结构化、实体清晰度、可抓取性、事实密度、可读性时效。",
    href: "/audit",
    highlight: "open-seo 完全没有的维度",
  },
  {
    icon: "◎",
    title: "中文 AI 可见性矩阵",
    desc: "一次向九个模型提问，检测品牌是否被提及：DeepSeek、豆包、Kimi、通义、文心、元宝 + ChatGPT、Claude、Gemini。",
    href: "/visibility",
    highlight: "中文用户真在用，open-seo 一个不覆盖",
  },
  {
    icon: "§",
    title: "AI 抓取协议层",
    desc: "robots.txt 的 20 个 AI 爬虫策略检测、llms.txt 校验与自动起草 —— 后者在 open-seo 里只有一份 PM 文档，代码为零。",
    href: "/llms",
    highlight: "从想法到可用实现",
  },
];

export default function Home() {
  return (
    <div className="space-y-8">
      {/* Hero */}
      <section className="rounded-2xl border border-ink-200 bg-gradient-to-br from-ocean-50 via-white to-white p-8">
        <Badge tone="info">开源 · MIT · 零付费依赖</Badge>
        <h1 className="mt-3 text-[26px] font-semibold leading-snug text-ink-900">
          鲸析 GEOkit
          <span className="ml-3 text-[15px] font-normal text-ink-500">
            面向中文市场与 AI 搜索时代的 SEO / GEO 作战系统
          </span>
        </h1>
        <p className="mt-3 max-w-3xl text-[13.5px] leading-relaxed text-ink-700">
          open-seo 是个好项目 —— 28 万行代码、自研站点审计、完整的 MCP。但它的世界里没有中文：源码里
          <span className="mx-1 font-semibold text-ink-900">Google 出现 973 次</span>，而
          <span className="mx-1 font-semibold text-rose-600">百度 0 次、搜狗 0 次</span>，AI
          可见性也只盯着 ChatGPT / Claude / Gemini / Perplexity。
          <br className="my-1" />
          当你的用户在 DeepSeek 里问「跨境支付怎么选」，这类工具帮不上任何忙 —— GEOkit 就是为解决这个问题而生的。
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/serp"
            className="inline-flex items-center gap-2 rounded-lg bg-ocean-600 px-4 py-2.5 text-[13px] font-medium text-white hover:bg-ocean-700"
          >
            开始查多引擎排名 →
          </Link>
          <Link
            href="/audit"
            className="inline-flex items-center gap-2 rounded-lg border border-ink-200 bg-white px-4 py-2.5 text-[13px] font-medium text-ink-700 hover:border-ocean-300 hover:text-ocean-700"
          >
            跑一次页面审计
          </Link>
          <Link
            href="/mcp"
            className="inline-flex items-center gap-2 rounded-lg border border-ink-200 bg-white px-4 py-2.5 text-[13px] font-medium text-ink-700 hover:border-ocean-300 hover:text-ocean-700"
          >
            接入 MCP
          </Link>
        </div>
      </section>

      {/* 四个能力 */}
      <section>
        <SectionTitle
          title="四项核心能力"
          desc="每一项都针对实测出的 open-seo 空白区，而不是为了差异化而差异化。"
        />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {CAPABILITIES.map((c) => (
            <Link key={c.href} href={c.href} className="group">
              <Card className="h-full transition-all hover:border-ocean-300 hover:shadow-md">
                <div className="flex items-start gap-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-ocean-50 text-lg text-ocean-600">
                    {c.icon}
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-[14.5px] font-semibold text-ink-900 group-hover:text-ocean-700">
                      {c.title}
                    </h3>
                    <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-500">{c.desc}</p>
                    <Badge tone="info">
                      <span className="mt-2 inline-block">{c.highlight}</span>
                    </Badge>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      {/* 硬数据对比 */}
      <section>
        <SectionTitle
          title="实测对比：GEOkit vs open-seo"
          desc="以下右侧数据来自对仓库 github.com/every-app/open-seo 克隆后的全量源码扫描（grep 计数），不是估算。"
        />
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[13px]">
              <thead>
                <tr className="border-b border-ink-200 text-left text-[11.5px] uppercase tracking-wide text-ink-500">
                  <th className="py-2.5 pr-4 font-medium">维度</th>
                  <th className="py-2.5 pr-4 font-medium">open-seo</th>
                  <th className="py-2.5 pr-4 font-medium">鲸析 GEOkit</th>
                  <th className="py-2.5 font-medium">说明</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                <Row
                  k="中文搜索引擎"
                  a="百度 0 / 搜狗 0 次提及"
                  b={`${ENGINES.baidu.name}、${ENGINES.sogou.name}、${ENGINES.so360.name}、${ENGINES.shenma.name}、${ENGINES.toutiao.name}`}
                  note="源码级事实，非推测"
                />
                <Row
                  k="全球搜索引擎"
                  a={`Google（${FACTS.openSeo.googleMentions} 次）、Bing（${FACTS.openSeo.bingMentions} 次）`}
                  b="Google、Bing"
                  note="基本持平"
                />
                <Row
                  k="中文 AI 助手覆盖"
                  a="无（仅 ChatGPT / Claude / Gemini / Perplexity）"
                  b="DeepSeek、豆包、Kimi、通义、文心、元宝 + 三大国际模型"
                  note="open-seo 的 AI Visibility 走 DataForSEO llm_mentions"
                />
                <Row
                  k="数据依赖"
                  a="核心数据全部走 DataForSEO 付费 API"
                  b="自建采集与评分，零付费依赖"
                  note="自托管才真正省钱"
                />
                <Row
                  k="GEO 评分"
                  a="无 —— 只回答 Google 会不会收录"
                  b="六维 AI 引用友好度评分 + 可执行建议"
                  note="方法论层面的差异"
                />
                <Row
                  k="llms.txt"
                  a="仅 docs/site-audit-pm-research.md 提及，无代码"
                  b="检测 + 校验 + 自动生成"
                  note="它有想法，我们落成功能"
                />
                <Row
                  k="AI 爬虫策略"
                  a="无"
                  b={`${AI_CRAWLERS.length} 个已知爬虫的放行/封禁检测`}
                  note="含 Bytespider、Baiduspider 等国产爬虫"
                />
                <Row
                  k="界面语言"
                  a="英文"
                  b="中文优先"
                  note="UI 无 i18n 层"
                />
                <Row
                  k="技术栈"
                  a={FACTS.openSeo.stack}
                  b="Next.js 16 / React 19 / Tailwind v4"
                  note="更容易 fork 与二次开发"
                />
                <Row
                  k="运行依赖"
                  a={`${FACTS.openSeo.deps} 个直接依赖`}
                  b="4 个（next / react / react-dom / zod）"
                  note="审计只看主要内容时可更少"
                />
                <Row
                  k="许可证"
                  a={FACTS.openSeo.license}
                  b="MIT"
                  note="同样友好"
                />
              </tbody>
            </table>
          </div>
          <p className="mt-4 rounded-lg bg-ink-50 px-3 py-2 text-[11.5px] leading-relaxed text-ink-500">
            客观地说：open-seo 是个体量远大于 GEOkit 的成熟项目（src 合计
            {FACTS.openSeo.srcLoc} 行 / {FACTS.openSeo.srcFiles} 个文件），它的站点审计是真自研爬虫、
            MCP 工具链很完整、产品完成度也高。GEOkit 不是要全面超越它 —— 而是在
            <span className="font-medium text-ink-700">中文市场与 AI 搜索可见性</span>
            这两个它结构性缺席的战场上做到最好，并让整套东西保持足够小、足够可读，你能直接 fork 改。
          </p>
        </Card>
      </section>

      {/* 引擎与模型 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <h3 className="text-[14px] font-semibold text-ink-900">搜索引擎覆盖</h3>
          <p className="mt-1 text-[12px] text-ink-500">份额为中国市场公开估算，用于排序参考。</p>
          <div className="mt-4 space-y-2.5">
            {Object.values(ENGINES).map((e) => (
              <div key={e.id} className="flex items-center gap-3">
                <span className="w-16 shrink-0 text-[12.5px] font-medium text-ink-900">{e.name}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-100">
                  <div
                    className="h-full rounded-full bg-ocean-500"
                    style={{ width: `${Math.min(100, e.shareCn * 1.6)}%` }}
                  />
                </div>
                <span className="tabular w-12 shrink-0 text-right text-[11.5px] text-ink-500">
                  {e.shareCn}%
                </span>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <h3 className="text-[14px] font-semibold text-ink-900">AI 可见性探测模型</h3>
          <p className="mt-1 text-[12px] text-ink-500">
            标注「高」为中文场景高频入口，也是 open-seo 完全不覆盖的部分。
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            {PROVIDER_LIST.map((p) => (
              <div
                key={p.id}
                className={`rounded-lg border p-2.5 ${
                  p.cnRelevance === "high"
                    ? "border-ocean-200 bg-ocean-50/50"
                    : "border-ink-200 bg-white"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[12.5px] font-medium text-ink-900">{p.name}</span>
                  {p.cnRelevance === "high" && <Badge tone="info">中文高频</Badge>}
                </div>
                <p className="mt-1 text-[11px] text-ink-500">{p.vendor}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* 诚实声明 */}
      <Card>
        <SectionTitle title="关于「抓不到数据」这件事" />
        <p className="text-[13px] leading-relaxed text-ink-700">
          搜索引擎和部分 AI 平台会拦截服务端直连请求 —— 这是所有自托管 SEO
          工具都会遇到的工程现实，不是 bug，也没法通过写巧妙代码绕过。
        </p>
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          <Stat label="GEOkit 的选择" value="如实返回" hint="返回 status=blocked 并写明原因与解决办法" tone="good" />
          <Stat label="常见竞品做法" value="降级占位" hint="用估算值或缓存旧数据填充，前端看不出差别" tone="bad" />
          <Stat label="生产建议" value="配代理" hint="住宅代理或服务端出口 IP，各引擎均可单独配置" />
        </div>
        <p className="mt-4 text-[12.5px] leading-relaxed text-ink-500">
          宁可让你知道「这次没抓到」，也不要让你基于假数据做出错的投放决策。这条原则贯穿 GEOkit
          的每一个接口。
        </p>
      </Card>
    </div>
  );
}

function Row({ k, a, b, note }: { k: string; a: string; b: string; note?: string }) {
  return (
    <tr className="align-top">
      <td className="py-3 pr-4 text-[12.5px] font-medium text-ink-900">{k}</td>
      <td className="py-3 pr-4 text-[12.5px] leading-relaxed text-ink-500 line-through decoration-rose-300 decoration-1">
        {a}
      </td>
      <td className="py-3 pr-4 text-[12.5px] font-medium leading-relaxed text-ocean-700">{b}</td>
      <td className="py-3 text-[11.5px] leading-relaxed text-ink-500">{note}</td>
    </tr>
  );
}
