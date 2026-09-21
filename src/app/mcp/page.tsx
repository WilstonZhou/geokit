import Link from "next/link";
import { Card, SectionTitle, Badge } from "@/components/ui";
import { TOOLS } from "@/lib/mcp";

export const dynamic = "force-dynamic";

const STDIO_CONFIG = {
  mcpServers: {
    geokit: {
      command: "npx",
      args: ["-y", "tsx", "scripts/mcp-stdio.ts"],
      cwd: "<你的项目绝对路径>",
      env: {
        DEEPSEEK_API_KEY: "<可选>",
        KIMI_API_KEY: "<可选>",
        OPENAI_API_KEY: "<可选>",
      },
    },
  },
};

export default function McpPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[20px] font-semibold text-ink-900">MCP 服务</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
          open-seo 把「最好的 MCP」当作头号卖点 —— 这点我认同，AI Agent 调用才是
          SEO 工具的正确姿势。GEOkit 同样自带 MCP server，并且把中文引擎、中文 AI
          模型、GEO 评分、llms.txt 全部开成了 tool。
        </p>
      </div>

      <Card>
        <SectionTitle title="两种接入方式" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-ink-200 p-4">
            <Badge tone="info">Streamable HTTP</Badge>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-600">
              服务已在运行，直接把这个 URL 填进支持 MCP over HTTP 的客户端：
            </p>
            <code className="mt-2 block rounded bg-ink-50 px-2.5 py-2 text-[11.5px] text-ink-800">
              POST http://localhost:3210/api/mcp
            </code>
            <p className="mt-2 text-[11.5px] text-ink-500">
              GET 同一地址可返回握手示例。无需额外进程。
            </p>
          </div>

          <div className="rounded-lg border border-ink-200 p-4">
            <Badge tone="info">stdio</Badge>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-600">
              适合本地 Agent（CodeBuddy / Claude Desktop / Cursor）：
            </p>
            <code className="mt-2 block rounded bg-ink-50 px-2.5 py-1.5 text-[11.5px] text-ink-800">
              npm run mcp
            </code>
            <p className="mt-2 text-[11.5px] text-ink-500">
              在项目根目录创建 .mcp.json，或在客户端的 MCP 配置中加入下方片段。
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <SectionTitle title="客户端配置示例" desc="把 cwd 换成你本机的实际路径。" />
        <pre className="overflow-auto rounded-lg bg-ink-50 p-4 text-[11.5px] leading-relaxed text-ink-800">
          {JSON.stringify(STDIO_CONFIG, null, 2)}
        </pre>
      </Card>

      <Card>
        <SectionTitle
          title={`可用工具（${TOOLS.length} 个）`}
          desc="对比 open-seo：它约 25 个工具，集中在 Google 生态 + DataForSEO 取数。"
        />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {TOOLS.map((t) => (
            <div key={t.name} className="rounded-lg border border-ink-200 p-3.5">
              <div className="flex items-baseline justify-between gap-2">
                <code className="text-[12.5px] font-medium text-ocean-700">{t.name}</code>
                <Badge>{t.title}</Badge>
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-ink-600">{t.description}</p>
              {t.inputSchema.required && t.inputSchema.required.length > 0 && (
                <p className="mt-2 text-[11px] text-ink-500">
                  必填参数：<code className="text-ink-700">{t.inputSchema.required.join(", ")}</code>
                </p>
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle title="一个完整调用示例" />
        <pre className="overflow-auto rounded-lg bg-ink-50 p-4 text-[11.5px] leading-relaxed text-ink-800">
{`# 1. 列出可用引擎
{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"list_engines","arguments":{}}}

# 2. 查百度 + 搜狗上某个词的真实排名
{"jsonrpc":"2.0","id":2,"method":"tools/call",
 "params":{"name":"check_serp_ranking",
           "arguments":{"keyword":"跨境支付平台",
                        "engines":["baidu","sogou"],
                        "targetDomain":"whivi.com"}}}

# 3. 审计页面并拿 GEO 评分
{"jsonrpc":"2.0","id":3,"method":"tools/call",
 "params":{"name":"audit_page",
           "arguments":{"url":"https://whivi.com"}}}

# 4. 看看 AI 认不认识这个品牌
{"jsonrpc":"2.0","id":4,"method":"tools/call",
 "params":{"name":"check_ai_visibility",
           "arguments":{"brand":"鲸汇通","topic":"跨境支付平台推荐"}}}`}
        </pre>
        <p className="mt-3 text-[11.5px] leading-relaxed text-ink-500">
          用 curl 也可以：<code className="rounded bg-ink-100 px-1.5">curl -X POST http://localhost:3210/api/mcp -d &apos;{"{"}&quot;jsonrpc&quot;:&quot;2.0&quot;,&quot;id&quot;:1,&quot;method&quot;:&quot;tools/list&quot;{"}"}&apos;</code>
        </p>
      </Card>

      <Card>
        <SectionTitle title="和 SEO 工具搭配的建议" />
        <p className="text-[12.5px] leading-relaxed text-ink-700">
          MCP 的价值不在「能用」，而在「Agent 能闭环做完一件事」。典型链路：
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px]">
          {["check_serp_ranking 找排名缺口", "→", "audit_page 定位页面问题", "→",
            "generate_llms_txt 补 AI 协议", "→", "check_ai_visibility 复检"].map((s, i) => (
            <span key={i} className={s === "→" ? "text-ocean-400" : "rounded-md border border-ink-200 bg-white px-2.5 py-1 text-ink-700"}>
              {s}
            </span>
          ))}
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-ink-500">
          回到<Link href="/" className="text-ocean-700 hover:underline">总览页</Link>看完整能力地图。
        </p>
      </Card>
    </div>
  );
}
