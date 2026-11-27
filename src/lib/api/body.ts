/**
 * API 请求体读取与大小限制。
 *
 * Next.js App Router 的 Route Handler **没有** Pages API 的 1MB bodyParser
 * 限制；直接 `await req.json()` 会把任意大小的请求体读进内存。这里用流式
 * 读取并在超限时立即取消，避免单个请求打爆进程。
 */

export const DEFAULT_JSON_MAX_BYTES = 1 * 1024 * 1024;
/** 允许携带 HTML 原文的端点（audit / llms / schema / MCP） */
export const HTML_JSON_MAX_BYTES = 8 * 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`请求体超过上限 ${limitBytes} 字节`);
    this.name = "BodyTooLargeError";
  }
}

async function readBodyWithLimit(req: Request, maxBytes: number): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BodyTooLargeError(maxBytes);
  }

  const stream = req.body;
  if (!stream) return "";

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** 读取文本请求体（MCP 等需要原始 JSON-RPC 文本的端点） */
export async function readRequestText(
  req: Request,
  maxBytes: number = DEFAULT_JSON_MAX_BYTES
): Promise<string> {
  return readBodyWithLimit(req, maxBytes);
}

/** 读取 JSON 请求体；空 body 视为语法错误（与 Next 的 req.json() 一致） */
export async function readRequestJson(
  req: Request,
  maxBytes: number = DEFAULT_JSON_MAX_BYTES
): Promise<unknown> {
  const text = await readBodyWithLimit(req, maxBytes);
  return JSON.parse(text);
}
