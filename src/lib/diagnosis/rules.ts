/**
 * 规则库：check → issueId → fixId（Phase 2 · S2-1）。
 *
 * ★ 本文件**不重新实现任何检查**。
 *   它只读 `analyze()` 已经算好的 `CheckResult`（id / level / value / weight），
 *   把它翻译成稳定 issueId。判断逻辑全部在 audit.ts 里，这里只做映射。
 *
 * 这样拆的原因很实际：一旦这里开始自己判断「title 够不够好」，
 * 就会出现两套口径 —— UI 说 pass、CI 说 fail。而一个做 SEO 的工具
 * 有两条真相，等于没有真相。
 */
import type { FixContext, FixRule, Severity } from "./types";

/** 严重度判定。与 Phase 2 PLAN 一致，且以 CheckResult 的实际字段为准 */
export function severityOf(check: {
  level: "pass" | "warn" | "fail";
  weight: number;
}): Severity {
  // weight 100 是「整个页面没抓到」那一档（emptyAudit 的 fetch check）
  // —— 抓不到就没得谈，其余分数全是虚构的。
  if (check.weight >= 100) return "blocker";
  if (check.level === "fail") return "major";
  return "minor";
}

/**
 * 单个 check → issueId（以及可自动修时的 fixId）。
 *
 * 返回 null = 这一项 pass，不产生诊断。
 */
export function mapCheck(check: {
  id: string;
  level: "pass" | "warn" | "fail";
  value?: string;
}): { issueId: string; fixId?: string } | null {
  if (check.level === "pass") return null;

  const empty = (check.value ?? "") === "";

  switch (check.id) {
    // ── 页面根本没抓到 ──────────────────────────────────────
    case "fetch":
      // 无自动修：抓不到是网络/权限问题，改 HTML 修不了
      return { issueId: "fetch/unreachable" };

    // ── HTTP ───────────────────────────────────────────────
    case "http":
      // 3xx 是 warn，4xx/5xx 是 fail；都不是改 HTML 能修的
      return { issueId: check.level === "fail" ? "http/error" : "http/redirect" };

    // ── 标题 ───────────────────────────────────────────────
    case "title":
      // 补标题要懂业务，不可预测 ⇒ 只诊断，不修
      return { issueId: empty ? "title/missing" : "title/length" };

    // ── 描述 ───────────────────────────────────────────────
    case "desc":
      return { issueId: empty ? "desc/missing" : "desc/length" };

    // ── canonical ──────────────────────────────────────────
    case "canonical":
      // 值来自页面自身 URL，diff 可预测 ⇒ 可自动修
      return { issueId: "canonical/missing", fixId: "canonical" };

    // ── robots meta ────────────────────────────────────────
    case "robots":
      // noindex 可能是故意的（内页/草稿），自动解封是危险的 ⇒ 只诊断
      return { issueId: "robots/noindex" };

    // ── H1 ─────────────────────────────────────────────────
    case "h1":
      return { issueId: "h1/structure" };

    // ── 图片 alt ───────────────────────────────────────────
    case "alt":
      // 只补空 alt（声明「这是装饰图」），不编描述 —— 编描述需要看懂图
      return {
        issueId: check.level === "fail" ? "alt/mostly-missing" : "alt/partly-missing",
        fixId: "alt-empty",
      };

    // ── viewport ───────────────────────────────────────────
    case "viewport":
      return { issueId: "viewport/missing", fixId: "viewport" };

    // ── lang ───────────────────────────────────────────────
    case "lang":
      return { issueId: "lang/missing", fixId: "lang" };

    // ── 结构化数据 ─────────────────────────────────────────
    case "jsonld":
      // schema 类型要按页面性质选，不可预测 ⇒ 只诊断
      return { issueId: "jsonld/missing" };

    // ── OG ─────────────────────────────────────────────────
    case "og":
      return { issueId: "og/incomplete", fixId: "og-skeleton" };

    default:
      // 未知 check：不猜，原样透传为诊断（不配自动修）
      return { issueId: `${check.id}/${check.level}` };
  }
}

/* ────────────────────────────────────────────────────────────
 * 修复规则
 *
 * 五条，全部满足：幂等 / 最小 diff / 不覆盖已有值。
 * 实现方式是最朴素的字符串操作 —— 不引入 HTML formatter，
 * 因为格式化会重写整个文件，那与「最小 diff」直接冲突。
 * ──────────────────────────────────────────────────────────── */

/** 在 `</head>` 前插入一行；找不到 head 就放弃（不猜位置） */
function insertBeforeHeadClose(html: string, snippet: string): string | null {
  const i = html.search(/<\/head\s*>/i);
  if (i < 0) return null;
  return `${html.slice(0, i)}${snippet}${html.slice(i)}`;
}

const viewportRule: FixRule = {
  fixId: "viewport",
  issueIds: ["viewport/missing"],
  summary: '补充 <meta name="viewport" content="width=device-width, initial-scale=1">',
  applies: (html) => !/<meta[^>]+name\s*=\s*["']?viewport["']?/i.test(html),
  patch: (html) =>
    insertBeforeHeadClose(
      html,
      '<meta name="viewport" content="width=device-width, initial-scale=1">'
    ),
};

const langRule: FixRule = {
  fixId: "lang",
  issueIds: ["lang/missing"],
  summary: '在 <html> 上声明 lang="zh-CN"',
  applies: (html) => {
    const m = html.match(/<html\b[^>]*>/i);
    if (!m) return false;
    return !/\slang\s*=/i.test(m[0]);
  },
  patch: (html, ctx) => {
    const m = html.match(/<html\b[^>]*>/i);
    if (!m) return null;
    // ★ 已有 lang 就不动 —— 哪怕它是 en，判定权在站方不在我们
    if (/\slang\s*=/i.test(m[0])) return null;
    const tag = m[0]!;
    const replaced = tag.replace(/>$/, ` lang="${ctx.lang ?? "zh-CN"}">`);
    return html.replace(tag, replaced);
  },
};

const canonicalRule: FixRule = {
  fixId: "canonical",
  issueIds: ["canonical/missing"],
  summary: "为页面声明绝对地址的 canonical",
  applies: (html) => !/<link[^>]+rel\s*=\s*["']?canonical["']?/i.test(html),
  patch: (html, ctx) => {
    if (!ctx.url) return null;
    return insertBeforeHeadClose(html, `<link rel="canonical" href="${ctx.url}">`);
  },
};

/**
 * OG 骨架 —— 只补能确定的三个：title / description / url。
 *
 * ★ 刻意**不补 og:image**。图片地址必须指向一张真实存在的图，
 *   而我们无从得知它是什么；填一个占位图链接，等于让分享出去的
 *   卡片带一张假图 —— 比不补更糟。这正是「抓不到就说抓不到」。
 */
const ogSkeletonRule: FixRule = {
  fixId: "og-skeleton",
  issueIds: ["og/incomplete"],
  summary: "补齐 og:title / og:description / og:url（不含 og:image，图片地址无法推断）",
  applies: (html, ctx) => missingOg(html, ctx).length > 0,
  patch: (html, ctx) => {
    const missing = missingOg(html, ctx);
    if (missing.length === 0) return null;
    return insertBeforeHeadClose(html, missing.join(""));
  },
};

/** 哪些 og 标签「缺且能确定值」 */
function missingOg(html: string, ctx: FixContext): string[] {
  const has = (prop: string) =>
    new RegExp(`<meta[^>]+property\\s*=\\s*["']?${prop}["']?`, "i").test(html);

  const out: string[] = [];
  if (!has("og:title") && ctx.title) {
    out.push(`<meta property="og:title" content="${escapeAttr(ctx.title)}">`);
  }
  if (!has("og:description") && ctx.description) {
    out.push(`<meta property="og:description" content="${escapeAttr(ctx.description)}">`);
  }
  if (!has("og:url") && ctx.url) {
    out.push(`<meta property="og:url" content="${escapeAttr(ctx.url)}">`);
  }
  return out;
}

const altEmptyRule: FixRule = {
  fixId: "alt-empty",
  issueIds: ["alt/mostly-missing", "alt/partly-missing"],
  summary: '给缺 alt 的 <img> 补空值 alt=""（声明装饰图；描述性 alt 需要人写）',
  applies: (html) => /<img\b(?![^>]*\salt\s*=)[^>]*>/i.test(html),
  patch: (html) => {
    let changed = false;
    const out = html.replace(/<img\b(?![^>]*\salt\s*=)[^>]*>/gi, (tag) => {
      changed = true;
      return tag.replace(/\/?>$/, (end) => ` alt=""${end}`);
    });
    return changed ? out : null;
  },
};

/** 属性值里的引号：挡住注入，也挡住把 HTML 写坏 */
function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** 规则库。Auto Fix 只能从这里取规则 —— 库里没有的 = 不许自动改 */
export const FIX_RULES: readonly FixRule[] = [
  viewportRule,
  langRule,
  canonicalRule,
  ogSkeletonRule,
  altEmptyRule,
];

export function findFixRule(fixId: string): FixRule | undefined {
  return FIX_RULES.find((r) => r.fixId === fixId);
}
