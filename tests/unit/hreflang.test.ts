import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractFromHtml,
  extractFromHttpHeaders,
  extractFromPage,
  extractFromSitemap,
  analyzeHreflang,
  isValidLangCode,
  normalizeLangCode,
  type PageInput,
} from "../../src/lib/hreflang";

/* ------------------------------------------------------------------ */
/* 三种来源解析                                                        */
/* ------------------------------------------------------------------ */

describe("extractFromHtml", () => {
  it("从 HTML link 标签提取 hreflang", () => {
    const html = `
      <html>
      <head>
        <link rel="alternate" hreflang="zh-CN" href="https://example.com/zh/">
        <link rel="alternate" hreflang="en" href="https://example.com/en/">
        <link rel="alternate" hreflang="x-default" href="https://example.com/">
      </head>
      </html>
    `;
    const entries = extractFromHtml(html);
    assert.strictEqual(entries.length, 3);
    assert.strictEqual(entries[0].lang, "zh-CN");
    assert.strictEqual(entries[0].source, "html");
    assert.strictEqual(entries[2].lang, "x-default");
  });

  it("忽略非 alternate 的 link 标签", () => {
    const html = `<link rel="canonical" href="https://example.com/">`;
    const entries = extractFromHtml(html);
    assert.strictEqual(entries.length, 0);
  });
});

describe("extractFromHttpHeaders", () => {
  it("从 Link 响应头提取 hreflang", () => {
    const headers = {
      link: '<https://example.com/en/>; rel="alternate"; hreflang="en", <https://example.com/zh/>; rel="alternate"; hreflang="zh-CN"',
    };
    const entries = extractFromHttpHeaders(headers);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].source, "http-header");
    assert.strictEqual(entries[0].lang, "en");
  });

  it("无 Link 头返回空数组", () => {
    assert.strictEqual(extractFromHttpHeaders({}).length, 0);
  });
});

describe("extractFromSitemap", () => {
  it("从 sitemap XML 提取 hreflang", () => {
    const xml = `
      <urlset xmlns:xhtml="http://www.w3.org/1999/xhtml">
        <url>
          <loc>https://example.com/zh/</loc>
          <xhtml:link rel="alternate" hreflang="en" href="https://example.com/en/"/>
          <xhtml:link rel="alternate" hreflang="zh-CN" href="https://example.com/zh/"/>
        </url>
        <url>
          <loc>https://example.com/en/</loc>
          <xhtml:link rel="alternate" hreflang="zh-CN" href="https://example.com/zh/"/>
          <xhtml:link rel="alternate" hreflang="en" href="https://example.com/en/"/>
        </url>
      </urlset>
    `;
    const entries = extractFromSitemap(xml);
    assert.strictEqual(entries.size, 2);
    assert.strictEqual(entries.get("https://example.com/zh/")?.length, 2);
    assert.strictEqual(entries.get("https://example.com/en/")?.length, 2);
  });
});

/* ------------------------------------------------------------------ */
/* 语言代码                                                            */
/* ------------------------------------------------------------------ */

describe("isValidLangCode", () => {
  it("合法代码", () => {
    assert.strictEqual(isValidLangCode("zh-CN"), true);
    assert.strictEqual(isValidLangCode("en"), true);
    assert.strictEqual(isValidLangCode("x-default"), true);
  });

  it("非法代码", () => {
    assert.strictEqual(isValidLangCode("zh_CN"), false);
    assert.strictEqual(isValidLangCode("english"), false);
  });
});

describe("normalizeLangCode", () => {
  it("规范化", () => {
    assert.strictEqual(normalizeLangCode("ZH-cn"), "zh-CN");
    assert.strictEqual(normalizeLangCode("EN-us"), "en-US");
    assert.strictEqual(normalizeLangCode("x-default"), "x-default");
  });
});

/* ------------------------------------------------------------------ */
/* 六类检查                                                            */
/* ------------------------------------------------------------------ */

describe("analyzeHreflang - 无多语言配置", () => {
  it("站点无 hreflang 时返回不适用", () => {
    const pages: PageInput[] = [
      { url: "https://example.com/", html: "<html><head></head><body></body></html>" },
    ];
    const result = analyzeHreflang(pages);
    assert.strictEqual(result.isMultilingual, false);
    assert.strictEqual(result.issues.length, 0);
  });
});

describe("analyzeHreflang - 缺少自引用", () => {
  it("检测缺少自引用", () => {
    const pages: PageInput[] = [
      {
        url: "https://example.com/zh/",
        html: `<link rel="alternate" hreflang="en" href="https://example.com/en/">`,
      },
      {
        url: "https://example.com/en/",
        html: `<link rel="alternate" hreflang="zh-CN" href="https://example.com/zh/">`,
      },
    ];
    const result = analyzeHreflang(pages);
    assert.strictEqual(result.isMultilingual, true);
    const issue = result.issues.find((i) => i.type === "missing-self-reference");
    assert.ok(issue);
    assert.strictEqual(issue.severity, "high");
  });
});

describe("analyzeHreflang - 缺少回链", () => {
  it("A 指向 B 但 B 未回链", () => {
    const pages: PageInput[] = [
      {
        url: "https://example.com/zh/",
        html: `
          <link rel="alternate" hreflang="zh-CN" href="https://example.com/zh/">
          <link rel="alternate" hreflang="en" href="https://example.com/en/">
        `,
      },
      {
        url: "https://example.com/en/",
        html: `<link rel="alternate" hreflang="en" href="https://example.com/en/">`,
      },
    ];
    const result = analyzeHreflang(pages);
    const issue = result.issues.find((i) => i.type === "missing-reciprocal");
    assert.ok(issue);
    assert.ok(issue.affectedUrls.includes("https://example.com/zh/"));
  });

  it("双向回链时不报", () => {
    const pages: PageInput[] = [
      {
        url: "https://example.com/zh/",
        html: `
          <link rel="alternate" hreflang="zh-CN" href="https://example.com/zh/">
          <link rel="alternate" hreflang="en" href="https://example.com/en/">
        `,
      },
      {
        url: "https://example.com/en/",
        html: `
          <link rel="alternate" hreflang="en" href="https://example.com/en/">
          <link rel="alternate" hreflang="zh-CN" href="https://example.com/zh/">
        `,
      },
    ];
    const result = analyzeHreflang(pages);
    const issue = result.issues.find((i) => i.type === "missing-reciprocal");
    assert.strictEqual(issue, undefined);
  });
});

describe("analyzeHreflang - 非法语言代码", () => {
  it("检测非法代码", () => {
    const pages: PageInput[] = [
      {
        url: "https://example.com/",
        html: `<link rel="alternate" hreflang="zh_CN" href="https://example.com/zh/">`,
      },
    ];
    const result = analyzeHreflang(pages);
    const issue = result.issues.find((i) => i.type === "invalid-lang-code");
    assert.ok(issue);
    assert.strictEqual(issue.severity, "medium");
  });
});

describe("analyzeHreflang - 指向无效页面", () => {
  it("指向 404 页面", () => {
    const pages: PageInput[] = [
      {
        url: "https://example.com/zh/",
        html: `<link rel="alternate" hreflang="en" href="https://example.com/en/">`,
      },
      {
        url: "https://example.com/en/",
        httpStatus: 404,
      },
    ];
    const result = analyzeHreflang(pages);
    const issue = result.issues.find((i) => i.type === "broken-target");
    assert.ok(issue);
    assert.strictEqual(issue.severity, "high");
  });

  it("指向 noindex 页面", () => {
    const pages: PageInput[] = [
      {
        url: "https://example.com/zh/",
        html: `<link rel="alternate" hreflang="en" href="https://example.com/en/">`,
      },
      {
        url: "https://example.com/en/",
        noindex: true,
      },
    ];
    const result = analyzeHreflang(pages);
    const issue = result.issues.find((i) => i.type === "broken-target");
    assert.ok(issue);
  });
});

describe("analyzeHreflang - canonical 冲突", () => {
  it("hreflang 目标与 canonical 不一致", () => {
    const pages: PageInput[] = [
      {
        url: "https://example.com/zh/",
        html: `<link rel="alternate" hreflang="en" href="https://example.com/en/">`,
      },
      {
        url: "https://example.com/en/",
        canonical: "https://example.com/en-canonical/",
      },
    ];
    const result = analyzeHreflang(pages);
    const issue = result.issues.find((i) => i.type === "canonical-conflict");
    assert.ok(issue);
  });
});

describe("analyzeHreflang - x-default 缺失", () => {
  it("缺少 x-default 报 low severity", () => {
    const pages: PageInput[] = [
      {
        url: "https://example.com/zh/",
        html: `
          <link rel="alternate" hreflang="zh-CN" href="https://example.com/zh/">
          <link rel="alternate" hreflang="en" href="https://example.com/en/">
        `,
      },
      {
        url: "https://example.com/en/",
        html: `
          <link rel="alternate" hreflang="en" href="https://example.com/en/">
          <link rel="alternate" hreflang="zh-CN" href="https://example.com/zh/">
        `,
      },
    ];
    const result = analyzeHreflang(pages);
    const issue = result.issues.find((i) => i.type === "missing-x-default");
    assert.ok(issue);
    assert.strictEqual(issue.severity, "low");
  });
});

describe("analyzeHreflang - 语言声明不一致", () => {
  it("声明中文但内容 CJK 占比低", () => {
    const pages: PageInput[] = [
      {
        url: "https://example.com/",
        htmlLang: "zh-CN",
        textContent: "ThisisanEnglishpagewithalmostnoChinese",
      },
    ];
    const result = analyzeHreflang(pages);
    const issue = result.issues.find((i) => i.type === "lang-mismatch-suspect");
    assert.ok(issue);
    assert.strictEqual(issue.severity, "low");
    assert.ok(issue.title.includes("疑似"));
  });

  it("声明英文但内容 CJK 占比高", () => {
    const pages: PageInput[] = [
      {
        url: "https://example.com/",
        htmlLang: "en",
        textContent: "这是中文内容这是中文内容这是中文内容",
      },
    ];
    const result = analyzeHreflang(pages);
    const issue = result.issues.find((i) => i.type === "lang-mismatch-suspect");
    assert.ok(issue);
  });
});

/* ------------------------------------------------------------------ */
/* 回归：URL 解析 / 缺回链 / BCP 47                                     */
/* ------------------------------------------------------------------ */

describe("hreflang 回归", () => {
  it("相对 href 会按页面 URL 解析成绝对地址", () => {
    const entries = extractFromPage({
      url: "https://example.com/zh/",
      html: `<link rel="alternate" hreflang="en" href="/en/">
             <link rel="alternate" hreflang="zh-CN" href="/zh/">`,
    });
    assert.deepEqual(
      entries.map((e) => e.url).sort(),
      ["https://example.com/en/", "https://example.com/zh/"]
    );
  });

  it("相对 href 不再误报 missing-self-reference", () => {
    const result = analyzeHreflang([
      {
        url: "https://example.com/zh/",
        html: `<link rel="alternate" hreflang="en" href="/en/">
               <link rel="alternate" hreflang="zh-CN" href="/zh/">`,
      },
      {
        url: "https://example.com/en/",
        html: `<link rel="alternate" hreflang="en" href="/en/">
               <link rel="alternate" hreflang="zh-CN" href="/zh/">`,
      },
    ]);
    assert.equal(
      result.issues.some((i) => i.type === "missing-self-reference"),
      false
    );
  });

  it("目标页已爬取但没有任何 hreflang → missing-reciprocal", () => {
    const result = analyzeHreflang([
      {
        url: "https://example.com/zh/",
        html: `<link rel="alternate" hreflang="en" href="https://example.com/en/">
               <link rel="alternate" hreflang="zh-CN" href="https://example.com/zh/">`,
      },
      {
        url: "https://example.com/en/",
        html: `<html><head></head><body>English</body></html>`,
      },
    ]);
    const issue = result.issues.find((i) => i.type === "missing-reciprocal");
    assert.ok(issue);
    assert.ok(issue!.affectedUrls.includes("https://example.com/zh/"));
  });

  it("接受 zh-Hans / zh-Hant 等合法 BCP 47 代码", () => {
    assert.equal(isValidLangCode("zh-Hans"), true);
    assert.equal(isValidLangCode("zh-Hant"), true);
    assert.equal(isValidLangCode("sr-Latn-RS"), true);
    assert.equal(isValidLangCode("x-default"), true);
    assert.equal(isValidLangCode("x-Default"), true);
    assert.equal(isValidLangCode("not a lang"), false);
  });

  it("normalizeLangCode 保留 script 大小写规范", () => {
    assert.equal(normalizeLangCode("zh-hans"), "zh-Hans");
    assert.equal(normalizeLangCode("zh-hant-tw"), "zh-Hant-TW");
    assert.equal(normalizeLangCode("X-DEFAULT"), "x-default");
  });

  it("sitemap link 属性顺序不影响解析", () => {
    const xml = `<urlset xmlns:xhtml="http://www.w3.org/1999/xhtml">
      <url>
        <loc>https://example.com/zh/</loc>
        <xhtml:link href="https://example.com/en/" hreflang="en" rel="alternate"/>
      </url>
    </urlset>`;
    const map = extractFromSitemap(xml);
    assert.equal(map.get("https://example.com/zh/")?.[0]?.url, "https://example.com/en/");
  });

  it("HTTP Link 头参数顺序/额外参数不影响解析", () => {
    const entries = extractFromHttpHeaders({
      link: '<https://example.com/en/>; hreflang="en"; type="text/html"; rel="alternate"',
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.lang, "en");
  });
});
