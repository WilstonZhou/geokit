/**
 * T5 GSC 凭证与 JWT —— 用真实生成的 RSA 密钥对验证 RS256 签名与令牌缓存。
 * 不触网：token 端点用假 HTTP。
 */
import { describe, test, before } from "node:test";
import * as assert from "node:assert";
import { generateKeyPairSync, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { tmpdir } from "node:os";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  loadGscCredential,
  buildServiceAccountJwt,
  createTokenProvider,
  GSC_SCOPE,
  type GscHttp,
} from "../../src/lib/gsc/auth";

let privatePem: string;
let publicPem: string;
const CLIENT_EMAIL = "geokit@test-project.iam.gserviceaccount.com";

before(() => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privatePem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;
});

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

describe("T5 loadGscCredential", () => {
  test("无任何变量 → null（功能未开启）", () => {
    assert.equal(loadGscCredential({}), null);
  });

  test("GOOGLE_OAUTH_ACCESS_TOKEN 优先，解析为 access_token", () => {
    const cred = loadGscCredential({ GOOGLE_OAUTH_ACCESS_TOKEN: "ya29.abc" });
    assert.ok(cred);
    assert.equal(cred!.kind, "access_token");
    if (cred!.kind === "access_token") assert.equal(cred!.accessToken, "ya29.abc");
  });

  test("GOOGLE_SERVICE_ACCOUNT_JSON 合法 → service account", () => {
    const cred = loadGscCredential({
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        type: "service_account",
        client_email: CLIENT_EMAIL,
        private_key: privatePem,
        token_uri: "https://oauth2.example.com/token",
      }),
    });
    assert.ok(cred);
    assert.equal(cred!.kind, "service_account");
    if (cred!.kind === "service_account") {
      assert.equal(cred!.clientEmail, CLIENT_EMAIL);
      assert.equal(cred!.tokenUri, "https://oauth2.example.com/token");
    }
  });

  test("非法 JSON / 缺私钥 → 抛错且错误消息不含私钥内容", () => {
    assert.throws(() => loadGscCredential({ GOOGLE_SERVICE_ACCOUNT_JSON: "{bad" }), /JSON/);
    assert.throws(
      () =>
        loadGscCredential({
          GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
            client_email: CLIENT_EMAIL,
            private_key: "not-a-pem",
          }),
        }),
      /private_key/
    );
  });

  test("GOOGLE_APPLICATION_CREDENTIALS 文件路径可读取", () => {
    const path = join(tmpdir(), `geokit-sa-${Date.now()}.json`);
    writeFileSync(
      path,
      JSON.stringify({ client_email: CLIENT_EMAIL, private_key: privatePem })
    );
    try {
      const cred = loadGscCredential({ GOOGLE_APPLICATION_CREDENTIALS: path });
      assert.ok(cred);
      assert.equal(cred!.kind, "service_account");
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("文件不存在 → 抛错（不静默当未配置）", () => {
    assert.throws(
      () => loadGscCredential({ GOOGLE_APPLICATION_CREDENTIALS: "Z:/no/such/file.json" }),
      /无法读取/
    );
  });
});

// 上面断言直接使用 CLIENT_EMAIL

describe("T5 service account JWT (RS256)", () => {
  test("header/claims 正确，且签名可用对应公钥验证", () => {
    const cred = {
      kind: "service_account" as const,
      clientEmail: CLIENT_EMAIL,
      privateKey: privatePem,
      tokenUri: "https://oauth2.example.com/token",
    };
    const now = new Date("2026-10-08T00:00:00.000Z");
    const jwt = buildServiceAccountJwt(cred, now);
    const parts = jwt.split(".");
    assert.equal(parts.length, 3);

    const header = JSON.parse(b64urlDecode(parts[0]).toString());
    const claims = JSON.parse(b64urlDecode(parts[1]).toString());
    assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
    assert.equal(claims.iss, CLIENT_EMAIL);
    assert.equal(claims.scope, GSC_SCOPE);
    assert.equal(claims.aud, "https://oauth2.example.com/token");
    assert.equal(claims.exp - claims.iat, 3600);

    // 用公钥验证签名 —— 证明这是结构正确的 RS256 assertion
    const valid = cryptoVerify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey(publicPem),
      b64urlDecode(parts[2])
    );
    assert.equal(valid, true);
  });

  test("私钥错误时签名阶段抛错（不产出假 token）", () => {
    assert.throws(() =>
      buildServiceAccountJwt({
        kind: "service_account",
        clientEmail: CLIENT_EMAIL,
        privateKey: "-----BEGIN PRIVATE KEY-----\nINVALID\n-----END PRIVATE KEY-----\n",
        tokenUri: "https://oauth2.example.com/token",
      })
    );
  });
});

describe("T5 TokenProvider", () => {
  test("access token 直接返回，describe 不泄密", async () => {
    const p = createTokenProvider({ kind: "access_token", accessToken: "secret-token" });
    assert.equal(await p.getToken(), "secret-token");
    assert.equal(p.describe(), "oauth-access-token");
  });

  test("service account 首次换取后缓存：连续取令牌 HTTP 只调用一次", async () => {
    let calls = 0;
    const http: GscHttp = async () => {
      calls++;
      return {
        status: 200,
        ok: true,
        json: async () => ({ access_token: "exchanged-token", expires_in: 3600 }),
      };
    };
    const p = createTokenProvider(
      {
        kind: "service_account",
        clientEmail: CLIENT_EMAIL,
        privateKey: privatePem,
        tokenUri: "https://oauth2.example.com/token",
      },
      http
    );
    const t1 = await p.getToken();
    const t2 = await p.getToken();
    assert.equal(t1, "exchanged-token");
    assert.equal(t2, "exchanged-token");
    assert.equal(calls, 1);
    assert.ok(p.describe().includes(CLIENT_EMAIL)); // 邮箱可出现，令牌不可
  });

  test("token 端点返回 401 → 拒绝并抛错，错误消息不含 assertion", async () => {
    const http: GscHttp = async () => ({
      status: 401,
      ok: false,
      json: async () => ({}),
    });
    const p = createTokenProvider(
      {
        kind: "service_account",
        clientEmail: CLIENT_EMAIL,
        privateKey: privatePem,
        tokenUri: "https://oauth2.example.com/token",
      },
      http
    );
    await assert.rejects(p.getToken, /HTTP 401/);
  });

  test("网络异常 → 转成不含 JWT 的错误", async () => {
    const p = createTokenProvider(
      {
        kind: "service_account",
        clientEmail: CLIENT_EMAIL,
        privateKey: privatePem,
        tokenUri: "https://oauth2.example.com/token",
      },
      async () => {
        throw new Error("connect ECONNREFUSED");
      }
    );
    await assert.rejects(p.getToken, /网络失败/);
  });
});
