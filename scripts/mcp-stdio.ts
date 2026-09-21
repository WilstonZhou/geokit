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

async function dispatch(line: string) {
  const result = await handleJsonRpcBatch(line);
  if (result === null) return;
  const payloads = Array.isArray(result) ? result : [result];
  for (const p of payloads) {
    process.stdout.write(JSON.stringify(p) + "\n");
  }
}

process.stdin.on("end", () => process.exit(0));

process.stderr.write("[geokit-mcp] stdio 服务已就绪\n");
