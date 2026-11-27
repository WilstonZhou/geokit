import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BodyTooLargeError,
  readRequestJson,
  readRequestText,
} from "../../src/lib/api/body";

function post(body: string, headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/test", {
    method: "POST",
    body,
    headers,
  });
}

describe("api/body 请求体限制", () => {
  it("正常 JSON 可以被读取", async () => {
    const value = await readRequestJson(post('{"a":1}'));
    assert.deepEqual(value, { a: 1 });
  });

  it("超过字节上限时抛 BodyTooLargeError（流式读取）", async () => {
    await assert.rejects(
      () => readRequestJson(post(JSON.stringify({ a: "x".repeat(1000) })), 100),
      (e: unknown) => e instanceof BodyTooLargeError
    );
  });

  it("Content-Length 超限时在读取前拒绝", async () => {
    await assert.rejects(
      () =>
        readRequestJson(
          post("{}", { "content-length": "1000000" }),
          100
        ),
      (e: unknown) => e instanceof BodyTooLargeError
    );
  });

  it("非法 JSON 抛 SyntaxError（由路由映射成 400）", async () => {
    await assert.rejects(() => readRequestJson(post("{not json")), SyntaxError);
  });

  it("readRequestText 同样受上限约束", async () => {
    const text = await readRequestText(post("hello"), 10);
    assert.equal(text, "hello");
    await assert.rejects(
      () => readRequestText(post("x".repeat(20)), 10),
      (e: unknown) => e instanceof BodyTooLargeError
    );
  });
});
