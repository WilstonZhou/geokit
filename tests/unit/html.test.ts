import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  findTags,
  stripTags,
  getTitle,
  getMeta,
  getAllMeta,
  getCanonical,
  getHeading,
  absolutize,
  getDomain,
  decodeEntities,
} from "../../src/lib/html";

describe("HTML Parser (Unit Tests)", () => {
  it("findTags handles void tags and standard closing tags", () => {
    const html = `<html><head><meta name="description" content="test"><title>Hello World</title></head><body><img src="a.jpg"></body></html>`;
    const metas = findTags(html, ["meta"]);
    assert.strictEqual(metas.length, 1);
    assert.strictEqual(metas[0].attrs.name, "description");
    assert.strictEqual(metas[0].selfClosing, true);

    const titles = findTags(html, ["title"]);
    assert.strictEqual(titles.length, 1);
    assert.strictEqual(titles[0].selfClosing, false);
    assert.strictEqual(html.slice(titles[0].contentStart, titles[0].contentEnd), "Hello World");
  });

  it("findTags handles nested tags of the same name", () => {
    const html = `<div>Outer <div>Inner</div> End Outer</div>`;
    const divs = findTags(html, ["div"]);
    assert.strictEqual(divs.length, 2);
    assert.strictEqual(html.slice(divs[0].contentStart, divs[0].contentEnd), "Outer <div>Inner</div> End Outer");
    assert.strictEqual(html.slice(divs[1].contentStart, divs[1].contentEnd), "Inner");
  });

  it("getTitle extracts text and decodes entities", () => {
    const html = `<head><title>Antigravity &amp; AI &lt;Test&gt;</title></head>`;
    assert.strictEqual(getTitle(html), "Antigravity & AI <Test>");
  });

  it("getMeta and getAllMeta retrieve attributes properly", () => {
    const html = `
      <meta name="description" content="A great tool">
      <meta property="og:title" content="OG Title">
      <meta name="keywords" content="seo, geo">
    `;
    assert.strictEqual(getMeta(html, "description"), "A great tool");
    assert.strictEqual(getMeta(html, "og:title"), "OG Title");

    const all = getAllMeta(html);
    assert.strictEqual(all.description, "A great tool");
    assert.strictEqual(all["og:title"], "OG Title");
    assert.strictEqual(all.keywords, "seo, geo");
  });

  it("getCanonical extracts href attribute", () => {
    const html = `<link rel="canonical" href="https://example.com/canonical-url">`;
    assert.strictEqual(getCanonical(html), "https://example.com/canonical-url");
  });

  it("getHeading extracts heading content and ignores tags inside", () => {
    const html = `<h1>Main <span>Sub</span> Title</h1><h1>Second</h1>`;
    assert.deepStrictEqual(getHeading(html, 1), ["Main Sub Title", "Second"]);
  });

  it("absolutize converts relative links against base URL", () => {
    const base = "https://example.com/dir/page.html";
    assert.strictEqual(absolutize("/about", base), "https://example.com/about");
    assert.strictEqual(absolutize("sub.html", base), "https://example.com/dir/sub.html");
    assert.strictEqual(absolutize("https://other.com/x", base), "https://other.com/x");
    assert.strictEqual(absolutize("invalid-url", "not-a-url"), "invalid-url");
  });

  it("getDomain extracts primary domain with multi-part TLD support", () => {
    assert.strictEqual(getDomain("https://www.google.com/search?q=test"), "google.com");
    assert.strictEqual(getDomain("http://sub.domain.co.uk/path"), "domain.co.uk");
    assert.strictEqual(getDomain("https://example.com.cn/test"), "example.com.cn");
    assert.strictEqual(getDomain("invalid"), "invalid");
  });

  it("stripTags removes scripts, styles, and tags", () => {
    const html = `<div>Hello <script>alert(1)</script><style>body{color:red}</style><b>World</b></div>`;
    assert.strictEqual(stripTags(html), "Hello World");
  });

  it("decodeEntities resolves HTML basic named and decimal/hex entities", () => {
    assert.strictEqual(decodeEntities("&amp; &#8212; &#x26; &quot;Quote&quot;"), "& — & \"Quote\"");
  });
});
