import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  canonicalUrl,
  canonicalQuery,
  originOf,
  siteSubject,
  searchSubject,
  aiSlotSubject,
  httpSource,
  searchEngineSource,
  providerSource,
} from "../../src/lib/evidence/identity";
import { keyOf, sha256Hex } from "../../src/lib/store/hash";
import { redactHeaders, redactUrl, REDACTED } from "../../src/lib/evidence/redact";
import { summarizeAiStatuses, visibilityScoreOf } from "../../src/lib/evidence/ai-status";

describe("Evidence & Identity (Unit Tests)", () => {
  describe("1 canonicalUrl 规范化", () => {
    it("去除尾斜杠、凭证、默认端口与 hash", () => {
      assert.strictEqual(canonicalUrl("https://user:pass@Example.COM:443/guide/#anchor"), "https://example.com/guide");
      assert.strictEqual(canonicalUrl("https://example.com/"), "https://example.com");
      assert.strictEqual(canonicalUrl("http://example.com:8080/path"), "http://example.com:8080/path");
    });

    it("canonicalQuery 规范化关键词空白", () => {
      assert.strictEqual(canonicalQuery("  跨境  支付  平台 "), "跨境 支付 平台");
    });

    it("originOf 提取协议与域名端口", () => {
      assert.strictEqual(originOf("https://example.com/path?a=1"), "https://example.com");
    });
  });

  describe("2 Canonical Subject 与 Source", () => {
    it("siteSubject 统一为 site:<canonicalUrl>", () => {
      assert.strictEqual(siteSubject("https://example.com/"), "site:https://example.com");
    });

    it("searchSubject 包含 URL 与 query", () => {
      assert.strictEqual(
        searchSubject("https://example.com", "跨境支付"),
        "search:site=https://example.com|q=跨境支付"
      );
    });

    it("aiSlotSubject 标识提供方与模型", () => {
      assert.strictEqual(
        aiSlotSubject("deepseek", "deepseek-chat"),
        "ai-slot:deepseek:deepseek-chat"
      );
    });

    it("source 标识来源", () => {
      assert.strictEqual(httpSource("https://example.com"), "http:https://example.com");
      assert.strictEqual(searchEngineSource("baidu"), "search-engine:baidu");
      assert.strictEqual(providerSource("deepseek"), "provider:deepseek");
    });
  });

  describe("3 确定性哈希 Key 生成", () => {
    it("相同输入产出完全相同的 key", () => {
      const k1 = keyOf("ai_mention", "ai-slot:deepseek:deepseek-chat", "provider:deepseek");
      const k2 = keyOf("ai_mention", "ai-slot:deepseek:deepseek-chat", "provider:deepseek");
      assert.strictEqual(k1, k2);
      assert.strictEqual(k1.length, 64);
    });

    it("sha256Hex 产出 64 位十六进制", () => {
      const h = sha256Hex("test");
      assert.strictEqual(h.length, 64);
    });
  });

  describe("4 敏感信息脱敏 Redaction", () => {
    it("Header 中敏感认证信息全部替换为 REDACTED", () => {
      const headers = {
        Authorization: "Bearer sk-1234567890abcdef",
        "X-Api-Key": "my-secret-key",
        "Content-Type": "application/json",
        Cookie: "sessionid=xyz123",
      };
      const redacted = redactHeaders(headers);
      assert.strictEqual(redacted.Authorization, REDACTED);
      assert.strictEqual(redacted["X-Api-Key"], REDACTED);
      assert.strictEqual(redacted.Cookie, REDACTED);
      assert.strictEqual(redacted["Content-Type"], "application/json");
    });

    it("URL 查询参数中包含的 key 和 token 均被擦除", () => {
      const raw = "https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSySecretKey";
      const sanitized = redactUrl(raw);
      assert.ok(!sanitized.includes("AIzaSySecretKey"));
      assert.ok(sanitized.includes(`key=${encodeURIComponent(REDACTED)}`) || sanitized.includes(`key=${REDACTED}`));
    });

    it("URL 内嵌的 userinfo 凭据被擦除", () => {
      const sanitized = redactUrl("https://user:pass@example.com/path");
      assert.ok(!sanitized.includes("user"));
      assert.ok(!sanitized.includes("pass"));
      assert.ok(sanitized.includes("example.com"));
    });
  });

  describe("5 AI 状态与可见性分数聚合", () => {
    it("summarizeAiStatuses 正确统计六态漏斗", () => {
      const statuses = ["MENTIONED", "NOT_MENTIONED", "BLOCKED", "UNOBSERVABLE"] as const;
      const s = summarizeAiStatuses(statuses);
      assert.strictEqual(s.attemptedCount, 4);
      assert.strictEqual(s.mentionedCount, 1);
      assert.strictEqual(s.notMentionedCount, 1);
      assert.strictEqual(s.blockedCount, 1);
      assert.strictEqual(s.unobservableCount, 1);
      assert.strictEqual(s.determinableCount, 2);
    });

    it("visibilityScoreOf 分母只以可判定探针计算", () => {
      const s = summarizeAiStatuses(["MENTIONED", "NOT_MENTIONED", "BLOCKED"]);
      const score = visibilityScoreOf(s);
      assert.strictEqual(score, 50); // 1 / (1 + 1) = 50%
    });
  });
});

describe("Evidence 回归：新记录不应被误标 migratedFrom", () => {
  it("显式 subject/source 的新采集保留 identity 且带 provenance", async () => {
    const { evidenceFromFetch } = await import("../../src/lib/evidence/store");
    const ev = evidenceFromFetch(
      {
        ok: true,
        status: 200,
        finalUrl: "https://example.com/robots.txt",
        headers: { "content-type": "text/plain" },
        body: "User-agent: *",
        byteLength: 13,
        bodyHash: "h",
        elapsedMs: 1,
        attempts: [{ attempt: 1, elapsedMs: 1, outcome: "ok" }],
        waitedMs: 0,
        request: {
          url: "https://example.com/robots.txt",
          method: "GET",
          headers: {},
        },
        context: {
          purpose: "robots",
          subject: "site:https://example.com",
          source: "http:https://example.com",
          requestedAt: "2026-10-01T00:00:00Z",
        },
      },
      "robots_txt"
    );
    assert.equal(ev.subject, "site:https://example.com");
    assert.equal(ev.source, "http:https://example.com");
    assert.equal(ev.migratedFrom, undefined);
    assert.ok(ev.provenance);
    assert.equal(ev.provenance?.httpStatus, 200);
  });
});
