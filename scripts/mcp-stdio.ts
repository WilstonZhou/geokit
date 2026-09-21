/**
 * GEOkit MCP server — stdio 传输
 *
 * 用法：npm run mcp
 *
 * 加到 CodeBuddy / Claude Desktop 的 MCP 配置里：
 * {
 *   "mcpServers": {
 *     "geokit": {
 *       "command": "node",
 *       "args": ["--experimental-strip-types", "scripts/mcp-stdio.ts"],
 *       "cwd": "<项目绝对路径>",
 *       "env": { "DEEPSEEK_API_KEY": "..." }
 *     }
 *   }
 * }
 */

import { handleJsonRpcBatch } from "../src/lib/mcp";

process.chdir(process.cwd());

let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk: string) => {
  buffer += chunk;

  // 逐行处理：stdio 模式下每行一条 JSON-RPC
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    await dispatch(line);
  }
});

/**
 * 在途请求计数。
 *
 * 曾经这里直接 `stdin.on("end", () => process.exit(0))`，是个隐藏很深的问题：
 * 只要工具调用比 stdin 关闭慢（真实 AI 可见性探测要几秒），end 就会在
 * await 期间触发，进程被立刻杀掉，**响应永远写不出来**。
 *
 * 而 CI 的 stdio 冒烟只调用 list_engines 这类零耗时工具，所以这个缺陷
 * 一直没暴露 —— 恰恰是最需要真实调用的场景会踩到它。
 *
 * 现在：end 只做标记，等所有在途请求写完响应后再退出。
 */
let inFlight = 0;
let stdinEnded = false;

async function dispatch(line: string): Promise<void> {
  inFlight++;
  try {
    const result = await handleJsonRpcBatch(line);
    if (result === null) return;
    const payloads = Array.isArray(result) ? result : [result];
    for (const p of payloads) {
      process.stdout.write(JSON.stringify(p) + "\n");
    }
  } finally {
    inFlight--;
    if (stdinEnded && inFlight === 0) process.exit(0);
  }
}

process.stdin.on("end", () => {
  stdinEnded = true;
  if (inFlight === 0) process.exit(0);
});

process.stderr.write("[geokit-mcp] stdio 服务已就绪\n");
