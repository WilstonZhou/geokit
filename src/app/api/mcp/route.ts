import { NextResponse } from "next/server";
import { handleJsonRpcBatch, SERVER_INFO, MCP_PROTOCOL_VERSION } from "@/lib/mcp";
import { BodyTooLargeError, HTML_JSON_MAX_BYTES, readRequestText } from "@/lib/api/body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GEOkit MCP endpoint（Streamable HTTP）
 *
 * 用法：把这个 URL 挂到任意支持 MCP over HTTP 的客户端。
 *   POST http://localhost:3210/api/mcp
 *   Content-Type: application/json
 */
export async function POST(req: Request) {
  let raw: string;
  try {
    raw = await readRequestText(req, HTML_JSON_MAX_BYTES);
  } catch (e) {
    const status = e instanceof BodyTooLargeError ? 413 : 400;
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: e instanceof BodyTooLargeError ? -32600 : -32700,
          message: e instanceof Error ? e.message : "请求体读取失败",
        },
      },
      { status }
    );
  }

  if (!raw.trim()) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Empty request" } },
      { status: 400 }
    );
  }

  try {
    const result = await handleJsonRpcBatch(raw);
    if (result === null) return new Response(null, { status: 202 });
    return NextResponse.json(result, {
      headers: {
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32603,
          message: e instanceof Error ? e.message : "Internal error",
        },
      },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    server: SERVER_INFO,
    protocolVersion: MCP_PROTOCOL_VERSION,
    transport: "Streamable HTTP (JSON-RPC 2.0)",
    endpoint: "/api/mcp",
    method: "POST",
    stdio: "npm run mcp",
    quickStart: {
      initialize: {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: MCP_PROTOCOL_VERSION },
      },
      listTools: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      callTool: {
        jsonrpc: "2.0", id: 3, method: "tools/call",
        params: { name: "audit_page", arguments: { url: "https://example.com" } },
      },
    },
  });
}
