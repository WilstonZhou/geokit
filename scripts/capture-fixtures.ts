/**
 * 采集 SERP 真实 HTML，固化为离线 fixture。
 *
 * 存在的意义：百度 mu / 360 data-mdurl / 搜狗 citeLinkClass 这三处特殊解析
 * 是拿真实请求次数逐个试出来的，任何文档里都没有。Phase 0 要动 Fetcher 层，
 * 必须有离线、稳定、可复现的输入把这些行为锁住 —— 不能依赖实时网络。
 *
 * 只在需要刷新 fixture 时手动运行：npx tsx scripts/capture-fixtures.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), "tests", "fixtures", "serp");
const KEYWORD = process.env.FIXTURE_KEYWORD || "跨境支付";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

const TARGETS: { id: string; label: string; build: (kw: string) => string }[] = [
  {
    id: "baidu",
    label: "百度（依赖 mu 属性取真实 URL）",
    build: (kw) => `https://www.baidu.com/s?wd=${encodeURIComponent(kw)}&rn=20`,
  },
  {
    id: "so360",
    label: "360（依赖 data-mdurl 属性）",
    build: (kw) => `https://www.so.com/s?q=${encodeURIComponent(kw)}`,
  },
  {
    id: "sogou",
    label: "搜狗（依赖 citeLinkClass 展示文本）",
    build: (kw) => `https://www.sogou.com/web?query=${encodeURIComponent(kw)}`,
  },
];

async function grab(url: string) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        "Accept-Language": "zh-CN,zh;q=0.9",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    const html = await res.text();
    return { res, html, elapsedMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  for (const t of TARGETS) {
    const url = t.build(KEYWORD);
    process.stdout.write(`抓取 ${t.id} … `);
    try {
      const { res, html, elapsedMs } = await grab(url);

      // fixture 里必须保留这些特征，否则这组文件就失去保护价值
      const markers: Record<string, number> = {
        baidu: (html.match(/\smu="/g) || []).length,
        so360: (html.match(/data-mdurl=/g) || []).length,
        sogou: (html.match(/citeLinkClass/g) || []).length,
      };

      writeFileSync(join(OUT, `${t.id}.html`), html, "utf8");
      writeFileSync(
        join(OUT, `${t.id}.meta.json`),
        JSON.stringify(
          {
            engineId: t.id,
            label: t.label,
            keyword: KEYWORD,
            url,
            httpStatus: res.status,
            byteLength: Buffer.byteLength(html, "utf8"),
            elapsedMs,
            capturedAt: new Date().toISOString(),
            featureMarkerCount: markers[t.id] ?? 0,
          },
          null,
          2
        ),
        "utf8"
      );

      const n = markers[t.id] ?? 0;
      const verdict = n > 0 ? `✅ 特征出现 ${n} 次` : "⚠️ 特征 0 次 —— 可能被风控页替换，此 fixture 无效";
      console.log(`HTTP ${res.status}  ${(html.length / 1024).toFixed(0)}KB  ${verdict}`);
    } catch (e) {
      console.log(`❌ ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`\n输出目录: ${OUT}`);
}

main();
