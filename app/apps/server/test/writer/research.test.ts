import { expect, test } from "bun:test";

import { host, meta, pageTitle, paragraphs } from "../../src/writer/research.ts";

test("reads a page's paragraphs and what its metadata says", () => {
  const html = `<html><head><meta property="og:site_name" content="News 4"><title>A &amp; B</title><script>var x = "<p>not this</p>";</script></head><body><p class="a">The boy was arrested in March 2011 in Jacksonville, Florida, police said.</p><p>Short.</p></body></html>`;
  expect(paragraphs(html)).toBe("The boy was arrested in March 2011 in Jacksonville, Florida, police said.");
  expect(meta(html, "og:site_name")).toBe("News 4");
  expect(pageTitle(html)).toBe("A & B");
  expect(host("https://www.wjxt.com/news/a")).toBe("www.wjxt.com");
});
