/**
 * 鲸析 GEOkit — 零依赖轻量 HTML 解析
 *
 * 不引入 jsdom / cheerio：保持在 Cloudflare Workers、Node、Edge 三个运行时都能跑，
 * 并且让依赖树足够小，方便 fork 后自行改造。
 */

export interface Tag {
  name: string;
  attrs: Record<string, string>;
  /** 标签在原文中的起始下标 */
  start: number;
  /** 标签结束（>）之后的下标 */
  contentStart: number;
  /** 内容结束下标（不含闭合标签） */
  contentEnd: number;
  end: number;
  selfClosing: boolean;
}

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/** 解析出所有标签及其层级位置 */
export function findTags(html: string, names: string[]): Tag[] {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const out: Tag[] = [];
  const re = /<([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(html)) !== null) {
    const name = m[1].toLowerCase();
    if (!wanted.has(name)) continue;

    const attrs = parseAttrs(m[2] ?? "");
    const start = m.index;
    const contentStart = start + m[0].length;
    const selfClosing = /\/\s*$/.test(m[2] ?? "") || VOID_TAGS.has(name);

    if (selfClosing) {
      out.push({
        name, attrs, start, contentStart,
        contentEnd: contentStart, end: contentStart, selfClosing: true,
      });
      continue;
    }

    const closeIdx = findClosingIndex(html, name, contentStart);
    const contentEnd = closeIdx === -1 ? html.length : closeIdx;
    const end = closeIdx === -1 ? html.length : html.indexOf(">", closeIdx) + 1;

    out.push({ name, attrs, start, contentStart, contentEnd, end, selfClosing: false });
  }
  return out;
}

/** 从 contentStart 起寻找匹配的闭合标签，处理同名嵌套 */
function findClosingIndex(html: string, name: string, from: number): number {
  const openRe = new RegExp(`<${name}(\\s[^>]*)?>`, "gi");
  const closeRe = new RegExp(`</${name}\\s*>`, "gi");
  let depth = 0;

  let next =
    nextMatchAny(html, [
      { re: openRe, kind: "open" },
      { re: closeRe, kind: "close" },
    ], from);

  while (next) {
    if (next.kind === "open") depth++;
    else {
      depth--;
      if (depth < 0) return next.index;
    }
    next = nextMatchAny(html, [
      { re: openRe, kind: "open" },
      { re: closeRe, kind: "close" },
    ], next.index + next.length);
  }
  return -1;
}

function nextMatchAny(
  html: string,
  matchers: { re: RegExp; kind: "open" | "close" }[],
  from: number
): { index: number; length: number; kind: "open" | "close" } | null {
  let best: { index: number; length: number; kind: "open" | "close" } | null = null;
  for (const m of matchers) {
    m.re.lastIndex = from;
    const r = m.re.exec(html);
    if (r && (!best || r.index < best.index)) {
      best = { index: r.index, length: r[0].length, kind: m.kind };
    }
  }
  return best;
}

/** 解析属性串 → 对象 */
export function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const key = m[1].toLowerCase();
    const val = m[3] ?? m[4] ?? m[5] ?? "";
    attrs[key] = decodeEntities(val);
  }
  return attrs;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

export function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** 取 <title> */
export function getTitle(html: string): string | null {
  const t = findTags(html, ["title"])[0];
  if (!t) return null;
  const raw = html.slice(t.contentStart, t.contentEnd).trim();
  return raw ? decodeEntities(raw) : null;
}

/** 按 name / property 取 meta content */
export function getMeta(html: string, key: string): string | null {
  const metas = findTags(html, ["meta"]);
  for (const mt of metas) {
    if (mt.attrs.name === key || mt.attrs.property === key) {
      return mt.attrs.content ?? null;
    }
  }
  return null;
}

/** 取全部 meta，方便 UI 直接展示 */
export function getAllMeta(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const mt of findTags(html, ["meta"])) {
    const key = mt.attrs.name || mt.attrs.property;
    if (key) out[key] = mt.attrs.content ?? "";
  }
  return out;
}

export function getCanonical(html: string): string | null {
  for (const ln of findTags(html, ["link"])) {
    if (ln.attrs.rel?.toLowerCase() === "canonical") return ln.attrs.href ?? null;
  }
  return null;
}

export function getHeading(html: string, level: number): string[] {
  return findTags(html, [`h${level}`]).map((h) =>
    stripTags(html.slice(h.contentStart, h.contentEnd))
  );
}

/** 相对 URL → 绝对 URL */
export function absolutize(url: string, base: string): string {
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

/** 取主域名（含对 .com.cn / .co.uk 等二级后缀的处理） */
export function getDomain(raw: string): string {
  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    const host = u.hostname.replace(/^www\./, "");
    const parts = host.split(".");
    if (parts.length <= 2) return host;
    const multi = new Set(["com", "co", "org", "net", "gov", "edu", "ac"]);
    const tld = parts[parts.length - 1];
    const sld = parts[parts.length - 2];
    if (multi.has(sld) && parts.length >= 3) {
      return parts.slice(-3).join(".");
    }
    return `${sld}.${tld}`;
  } catch {
    return raw;
  }
}
