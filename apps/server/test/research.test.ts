// research.rs's tests, same names, plus the research tools against the mock
// (pages and images served by it; the headless browser replaced by `hooks.dump`).

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";

import type { App } from "../src/app.ts";
import { dispatch } from "../src/mcp/index.ts";
import * as research from "../src/research.ts";
import { articleBody, decode, hooks, imageHits, textOf } from "../src/research.ts";
import * as tools from "../src/tools.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

test("script_rendered_pages_read_their_json_ld", () => {
  const story = "A little more than a week after the arrests, police said. ".repeat(20);
  const page = `<html><head><script type="application/ld+json">{"@graph":[{"@type":"NewsArticle","headline":"H","articleBody":"${story}"}]}</script></head><body><div id="app"></div></body></html>`;
  expect(articleBody(page)).toBe(story);
  expect(articleBody("<html><body>nothing</body></html>")).toBeNull();
});

test("reads_bing_image_results", () => {
  const page =
    '<a class="iusc" style="x" m="{&quot;purl&quot;:&quot;https://news.example/story&quot;,&quot;murl&quot;:&quot;https://img.example/a.jpg?x=1&amp;y=2&quot;,&quot;t&quot;:&quot;Crash scene&quot;}" href="/x">';
  expect(imageHits(page)).toEqual([["https://img.example/a.jpg?x=1&y=2", "https://news.example/story", "Crash scene"]]);
});

test("decodes_duckduckgo_links", () => {
  expect(decode("https%3A%2F%2Fmynorthwest.com%2Fkent%2Dhit")).toBe("https://mynorthwest.com/kent-hit");
  expect(textOf("<b>Kent</b> police &amp; <i>the</i>\n  teen")).toBe("Kent police & the teen");
});

// ---------------------------------------------------------------------------
// The tools, against the mock.

const ffmpeg = Bun.which("ffmpeg");
let mock: MockServer;
let restore: () => void;
const dump = hooks.dump;
let photo: Uint8Array = new Uint8Array();
let tiny: Uint8Array = new Uint8Array();

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv();
  tools.forget();
  if (ffmpeg !== null) {
    const make = (size: string, color: string) => {
      const made = Bun.spawnSync([ffmpeg, "-v", "error", "-f", "lavfi", "-i", `color=${color}:s=${size}`, "-frames:v", "1", "-f", "image2", "-c:v", "mjpeg", "-"], {
        stdin: "ignore",
      });
      return new Uint8Array(made.stdout);
    };
    photo = make("640x480", "red");
    tiny = make("100x80", "blue");
  }
  mock.on("GET", "/img/photo.jpg", () => new Response(photo, { headers: { "content-type": "image/jpeg" } }));
  mock.on("GET", "/img/tiny.jpg", () => new Response(tiny, { headers: { "content-type": "image/jpeg" } }));
  mock.on("GET", "/img/page.jpg", () => new Response("<html>not an image</html>"));
});

afterAll(() => {
  restore();
  mock.stop();
});

afterEach(() => {
  hooks.dump = dump;
  research.forgetPages();
});

async function call(app: App, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const reply = (await dispatch(app, { id: 1, method: "tools/call", params: { name, arguments: args } }, null)) as {
    result: { content: { type: string; text?: string }[]; isError: boolean };
  };
  const text = reply.result.content.find((part) => part.type === "text")?.text ?? "";
  return { text, isError: reply.result.isError };
}

test("search_web lists DuckDuckGo's results through its redirect links", async () => {
  const { app, cleanup } = fixtureHome("research-search");
  try {
    app.store.create("Case", { width: 1920, height: 1080, fps: 30 });
    const asked: string[] = [];
    hooks.dump = async (url) => {
      asked.push(url);
      return '<div><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fkentreporter.com%2Fcrash&amp;rut=x">Kent <b>crash</b></a><a class="result__snippet" href="x">A teen &amp; a car</a></div>';
    };
    const found = await call(app, "search_web", { query: "kent crash 2024" });
    expect(found).toEqual({ text: "1. Kent crash\n   https://kentreporter.com/crash\n   A teen & a car", isError: false });
    expect(asked).toEqual(["https://html.duckduckgo.com/html/?q=kent%20crash%202024"]);
    hooks.dump = async () => "<html>anomaly detected</html>";
    expect(await call(app, "search_web", { query: "x" })).toEqual({
      text: "DuckDuckGo wants a check that a person is searching; try again in a few minutes",
      isError: true,
    });
    expect((await call(app, "search_web", {})).text).toBe("query is required");
  } finally {
    cleanup();
  }
});

const STORY = "Kent police said the teen drove the Prius into the crash on July 13. ".repeat(40);

test.skipIf(ffmpeg === null || Bun.which("ffprobe") === null)(
  "an article is read plainly, saved with its photos, and found again by its words",
  async () => {
    const { app, cleanup, home } = fixtureHome("research-article");
    try {
      const id = app.store.create("Case", { width: 1920, height: 1080, fps: 30 }).project.id;
      mock.on("GET", "/news/story", (_request, server) =>
        new Response(
          `<html><head><title>ignored</title><meta property="og:title" content="Teen charged in Kent crash"><meta property="og:site_name" content="Kent Reporter"><meta property="article:published_time" content="2024-07-20"><meta property="og:image" content="${server.url}/img/photo.jpg"></head><body><article><p>${STORY}</p><img src="${server.url}/img/tiny.jpg"><img src="${server.url}/img/logo.png"></article></body></html>`,
          { headers: { "content-type": "text/html" } },
        ),
      );
      hooks.dump = async () => {
        throw new Error("the browser isn't needed for a server-rendered story");
      };
      const url = `${mock.url}/news/story`;
      const read = await call(app, "read_page", { url, limit: 500 });
      expect(read.text.length).toBe(500);
      expect(read.text.startsWith("ignored Kent police said")).toBe(true);
      const saved = await call(app, "add_article", { url, summary: "The teen was charged." });
      // The lead photo is kept; the small one is too small, the logo a decoration.
      expect(saved).toEqual({
        text: 'saved "Teen charged in Kent crash" (Kent Reporter, 2024-07-20) to the project\'s articles, and added 1 of its photos to the review',
        isError: false,
      });
      const [article] = research.articles(home, id);
      expect(article!.id.length).toBe(16);
      const listing = await call(app, "case_articles", {});
      expect(listing.text).toBe(`${article!.id} · Teen charged in Kent crash (Kent Reporter, 2024-07-20)\n   The teen was charged.`);
      const found = await call(app, "case_articles", { find: "PRIUS" });
      expect(found.text.startsWith(`[Kent Reporter · ${article!.id}] …`)).toBe(true);
      // Each mention with ~200 characters either side; the next looked for after it.
      expect(found.text.split("\n\n").length).toBe(14);
      expect((await call(app, "case_articles", { find: "tesla" })).text).toBe('"tesla" isn\'t in the saved articles');
      expect((await call(app, "case_articles", { id: "nope" })).text).toBe("no article nope");
      const items = research.items(home, id);
      expect(items.map((item) => [item.width, item.height, item.query, item.status])).toEqual([[640, 480, "article: Kent Reporter", "new"]]);
    } finally {
      cleanup();
    }
  },
);

test.skipIf(ffmpeg === null || Bun.which("ffprobe") === null)(
  "collect_images downloads Bing's results once, and the review keeps, rejects and clears them",
  async () => {
    const { app, cleanup, home, native } = fixtureHome("research-collect");
    try {
      const id = app.store.create("Case", { width: 1920, height: 1080, fps: 30 }).project.id;
      const hit = (image: string, title: string) =>
        `<a class="iusc" m="{&quot;purl&quot;:&quot;https://news.example/${title}&quot;,&quot;murl&quot;:&quot;${mock.url}/img/${image}&quot;,&quot;t&quot;:&quot;${title}&quot;}">`;
      const pages: string[] = [];
      hooks.dump = async (url) => {
        pages.push(url);
        return url.includes("first=1&") || url.endsWith("first=1") ? hit("photo.jpg", "Scene") + hit("tiny.jpg", "Icon") + hit("page.jpg", "Page") : "";
      };
      const first = await call(app, "collect_images", { queries: ["kent crash scene"], per_query: 10 });
      expect(first.text).toBe(
        "added 1 new images to the Research review (0 already there, 2 couldn't be used: blocked, not an image or too small); 1 in all. The user reviews them in the media bin's Research view; the ones they keep land in the media bin.",
      );
      expect(pages).toEqual([
        "https://www.bing.com/images/search?q=kent%20crash%20scene&first=1",
        "https://www.bing.com/images/async?q=kent%20crash%20scene&first=36&count=35&mmasync=1",
      ]);
      // Seen before: not downloaded again.
      const again = await call(app, "collect_images", { queries: ["kent crash scene"], per_query: 1 });
      expect(again.text.startsWith("added 0 new images to the Research review (1 already there, 0 couldn't be used")).toBe(true);
      expect((await call(app, "collect_images", { queries: "x" })).text).toBe("invalid type: string \"x\", expected a sequence");

      const [item] = research.items(home, id);
      // A look at what's waiting: a sheet of thumbnails and the list.
      let sheet: { width: number; height: number }[] = [];
      native.composeSheet = async (images) => {
        sheet = images.map((image) => ({ width: image.width, height: image.height }));
        return { data: Buffer.from("png"), mime: "image/png", width: 1, height: 1 };
      };
      const look = await call(app, "look_at_found", {});
      expect(look.text).toBe(`found images 1–1 of 1 waiting, left to right then down:\n1 ${item!.id} — Scene (https://news.example/Scene)`);
      expect(sheet).toEqual([{ width: 320, height: 240 }]);
      expect((await call(app, "look_at_found", { offset: 5 })).text).toBe("no found images waiting from 5 (1 waiting)");

      // Kept: into the media bin, named after its caption.
      const kept = await call(app, "use_found", { found_id: item!.id });
      const media = app.store.get(id)!.project.media;
      expect(kept.text).toBe(`kept ${item!.id}: media ${media[0]!.id} (Scene)`);
      expect(media[0]!.name).toBe("Scene");
      expect(research.items(home, id)[0]!.status).toBe("kept");
      expect((await call(app, "reject_found", { ids: [item!.id] })).text).toBe("rejected 0");
      expect(() => research.clear(home, id, "kept")).toThrow("kept images stay (they're in the media bin)");
      expect(research.clear(home, id, "new")).toBe(0);
      expect((await call(app, "use_found", { found_id: "nope" })).text).toBe("no such found image");
    } finally {
      cleanup();
    }
  },
);

test("one collection per project at a time", async () => {
  const { app, cleanup, home } = fixtureHome("research-once");
  try {
    const id = app.store.create("Case", { width: 1920, height: 1080, fps: 30 }).project.id;
    let release: () => void = () => {};
    hooks.dump = () =>
      new Promise((done) => {
        release = () => done("");
      });
    const running = research.collect(home, id, ["a"], 5);
    expect(research.collecting(id)).toBe(true);
    await expect(research.collect(home, id, ["b"], 5)).rejects.toThrow(
      "already collecting images for this project; wait for it to finish",
    );
    release();
    expect(await running).toEqual([0, 0, 0]);
    expect(research.collecting(id)).toBe(false);
    // A crash releases it too.
    hooks.dump = async () => {
      throw new TypeError("boom");
    };
    await expect(research.collect(home, id, ["a"], 5)).rejects.toThrow("a search crashed");
    expect(research.collecting(id)).toBe(false);
    expect(fs.existsSync(home)).toBe(true);
  } finally {
    cleanup();
  }
});
