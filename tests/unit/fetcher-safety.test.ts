import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assertSafeUrl,
  isForbiddenIp,
  UnsafeUrlError,
} from "../../src/lib/fetcher/safety";

describe("fetcher/safety（SSRF 防护）", () => {
  it("拒绝回环 / 私网 / 链路本地 / 云元数据地址", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
    ]) {
      assert.equal(isForbiddenIp(ip), true, `${ip} 应被拒绝`);
    }
  });

  it("放行公网 IP 字面量", () => {
    assert.equal(isForbiddenIp("8.8.8.8"), false);
    assert.equal(isForbiddenIp("1.1.1.1"), false);
    assert.equal(isForbiddenIp("2606:4700:4700::1111"), false);
  });

  it("拒绝非 http/https 协议", async () => {
    await assert.rejects(
      () => assertSafeUrl("file:///etc/passwd"),
      (e: unknown) => e instanceof UnsafeUrlError
    );
    await assert.rejects(
      () => assertSafeUrl("ftp://example.com/x"),
      (e: unknown) => e instanceof UnsafeUrlError
    );
  });

  it("拒绝 localhost / .local / .internal 主机名", async () => {
    for (const url of [
      "http://localhost:3210/",
      "http://app.localhost/",
      "http://router.local/",
      "http://metadata.internal/",
    ]) {
      await assert.rejects(
        () => assertSafeUrl(url),
        (e: unknown) => e instanceof UnsafeUrlError,
        url
      );
    }
  });

  it("拒绝内网 IP 字面量，允许公网 IP 字面量", async () => {
    await assert.rejects(
      () => assertSafeUrl("http://127.0.0.1:8080/admin"),
      (e: unknown) => e instanceof UnsafeUrlError
    );
    const ok = await assertSafeUrl("https://8.8.8.8/");
    assert.equal(ok.hostname, "8.8.8.8");
  });

  it("显式 allowPrivate 时允许本机地址（开发/测试逃生门）", async () => {
    const ok = await assertSafeUrl("http://127.0.0.1:3210/", {
      allowPrivate: true,
    });
    assert.equal(ok.hostname, "127.0.0.1");
  });
});
