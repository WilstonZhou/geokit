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
 * 退出时序 —— 两个坑，踩过第一个才看见第二个。
 *
 * 坑一（在途请求被杀）：
 *   曾经这里直接 `stdin.on("end", () => process.exit(0))`。只要工具调用比
 *   stdin 关闭慢（真实 AI 可见性探测要几秒），end 就会在 await 期间触发，
 *   进程被立刻杀掉，**响应永远写不出来**。
 *   CI 冒烟只调 list_engines 这类零耗时工具，把这个缺陷捂得严严实实。
 *
 * 坑二（响应写一半被截断）：
 *   修好坑一后还有个更隐蔽的：stdout 在 pipe 模式下是**异步**的，
 *   `write()` 返回不代表已经交给对端。此时调 process.exit() 会直接丢弃
 *   缓冲区里没写完的部分 —— 小响应看不出来，check_ai_visibility 那种
 *   几十 KB 的响应就会在中途被切断，客户端拿到半截 JSON。
 *
 * 因此退出必须满足三个条件，缺一不可：
 *   ① stdin 已 EOF          ② 无在途请求
 *   ③ 所有 write 的 flush 回调都已触发
 */
let inFlight = 0;
let stdinEnded = false;
let exiting = false;

/** 写一行并等待它真正 flush 出去（pipe 缓冲区已交给内核） */
function writeLine(payload: string): Promise<void> {
  return new Promise((resolve) => {
    // write 返回 false 表示数据在缓冲区排队，必须等 callback 才算落定
    const flushed = process.stdout.write(payload + "\n", () => resolve());
    if (flushed) resolve();
  });
}

async function dispatch(line: string): Promise<void> {
  inFlight++;
  try {
    const result = await handleJsonRpcBatch(line);
    if (result === null) return;
    const payloads = Array.isArray(result) ? result : [result];
    for (const p of payloads) {
      await writeLine(JSON.stringify(p));
    }
  } finally {
    inFlight--;
    maybeExit();
  }
}

function maybeExit(): void {
  if (exiting) return;
  if (!stdinEnded || inFlight > 0) return;
  exiting = true;
  // 走到这里说明三个条件都满足了，缓冲区已空，可以安全退出
  process.exit(0);
}

process.stdin.on("end", () => {
  stdinEnded = true;
  maybeExit();
});

process.stderr.write("[geokit-mcp] stdio 服务已就绪\n");
