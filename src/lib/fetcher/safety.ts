/**
 * 出站 URL 安全闸门（SSRF 防护）。
 *
 * GEOkit 会抓取用户提交的任意 URL。没有这层校验时，`/api/llms`、
 * `/api/audit`、`/api/crawl` 等端点会变成开放代理：攻击者可以让服务端
 * 访问回环地址、RFC1918 内网、云元数据（169.254.169.254）等。
 *
 * 规则：
 *   - 只允许 http / https；
 *   - 解析主机名（DNS）后拒绝私有 / 保留地址；
 *   - 跟随重定向时每一跳都要重新校验（见 fetcher/index.ts）；
 *   - 本地开发需要抓 localhost 时，显式设置 GEOKIT_ALLOW_PRIVATE_URLS=on。
 *
 * 残余风险：DNS rebinding（校验时的解析结果与 fetch 实际连接结果不同）
 * 无法仅靠 DNS 预解析彻底消除；要完全消除需要把解析结果钉死到连接层，
 * 那会引入额外依赖。这里的防护覆盖了绝大多数实际 SSRF 场景。
 */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export class UnsafeUrlError extends Error {
  readonly kind = "blocked_url" as const;

  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

const BLOCKED = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv6");
}

/** IPv4-mapped IPv6（::ffff:127.0.0.1）按 IPv4 处理 */
function normalizeMappedIpv4(ip: string): string | null {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1]! : null;
}

/** 判断一个 IP 字面量是否属于禁止访问的地址。非 IP 返回 false。 */
export function isForbiddenIp(ip: string): boolean {
  const mapped = normalizeMappedIpv4(ip);
  if (mapped) return isForbiddenIp(mapped);

  const family = isIP(ip);
  if (family === 4) return BLOCKED.check(ip, "ipv4");
  if (family === 6) return BLOCKED.check(ip, "ipv6");
  return false;
}

function isForbiddenHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  return false;
}

async function resolveAddresses(hostname: string): Promise<string[]> {
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map((r) => r.address);
  } catch {
    // DNS 解析失败交给 fetch 报网络错误；这里不把「解析不了」当成允许。
    return [];
  }
}

/**
 * 校验一个出站 URL。通过返回解析后的 URL，不通过抛 UnsafeUrlError。
 *
 * `allowPrivate` 只应由 fetcher 读取环境变量后传入，不要在调用点散落判断。
 */
export async function assertSafeUrl(
  input: string,
  opts: { allowPrivate?: boolean } = {}
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UnsafeUrlError(`URL 无法解析：${input}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError(`只允许抓取 http/https URL，收到 ${url.protocol}`);
  }

  if (opts.allowPrivate) return url;

  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  if (isIP(hostname)) {
    if (isForbiddenIp(hostname)) {
      throw new UnsafeUrlError(`禁止访问内网/保留地址：${hostname}`);
    }
    return url;
  }

  if (isForbiddenHostname(hostname)) {
    throw new UnsafeUrlError(`禁止访问本机/内网主机名：${hostname}`);
  }

  const addresses = await resolveAddresses(hostname);
  for (const address of addresses) {
    if (isForbiddenIp(address)) {
      throw new UnsafeUrlError(`主机 ${hostname} 解析到内网/保留地址 ${address}`);
    }
  }

  return url;
}
