// avatars.ts's tests: the photo of who started a project, from Google's hosts only, fetched once.

import { afterEach, expect, test } from "bun:test";

import * as avatars from "../src/avatars.ts";
import type { App } from "../src/app.ts";
import { Router } from "../src/http/router.ts";
import { respond } from "../src/http/server.ts";
import { fixtureHome } from "./helpers/home.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

test("only Google's photo hosts are fetched, at the size shown", () => {
  expect(avatars.source("https://lh3.googleusercontent.com/a/ACg8ocK=s96-c")).toBe("https://lh3.googleusercontent.com/a/ACg8ocK=s96-c");
  expect(avatars.source("https://lh5.googleusercontent.com/a/ACg8ocK=s1024")).toBe("https://lh5.googleusercontent.com/a/ACg8ocK=s96-c");
  expect(avatars.source("https://lh3.googleusercontent.com/a/ACg8ocK?x=1")).toBe("https://lh3.googleusercontent.com/a/ACg8ocK=s96-c");
  for (const refused of ["http://lh3.googleusercontent.com/a/x", "https://evil.com/a.jpg", "https://lh3.googleusercontent.com.evil.com/a", "https://user@lh3.googleusercontent.com/a", "https://127.0.0.1/a", "not a url", ""]) {
    expect(avatars.source(refused)).toBeNull();
  }
});

test("a photo is fetched once and kept; one that won't come, or isn't an image, is a 404", async () => {
  const { app, cleanup } = fixtureHome("avatars");
  try {
    const router = new Router<App>();
    avatars.routes(router);
    const asked: string[] = [];
    let answer: () => Response = () => new Response(JPEG);
    globalThis.fetch = (async (input: string | URL | Request) => {
      asked.push(String(input));
      return answer();
    }) as typeof fetch;
    const get = async (url: string) => (await respond(app, router, new Request(`http://localhost:7700/api/avatar?url=${encodeURIComponent(url)}`, { headers: { host: "localhost:7700" } }), null))!;

    const first = await get("https://lh3.googleusercontent.com/a/one=s96-c");
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(JPEG);
    // Twice at once, then again: one fetch.
    const both = await Promise.all([get("https://lh3.googleusercontent.com/a/one=s96-c"), get("https://lh3.googleusercontent.com/a/one=s96-c")]);
    expect(both.map((one) => one.status)).toEqual([200, 200]);
    expect(asked).toEqual(["https://lh3.googleusercontent.com/a/one=s96-c"]);

    answer = () => new Response("<html>", { headers: { "content-type": "text/html" } });
    expect((await get("https://lh3.googleusercontent.com/a/two")).status).toBe(404);
    answer = () => new Response(null, { status: 429 });
    expect((await get("https://lh3.googleusercontent.com/a/three")).status).toBe(404);
    // Not asked again straight away.
    expect((await get("https://lh3.googleusercontent.com/a/three")).status).toBe(404);
    expect(asked.length).toBe(3);
    // Not Google's: never fetched.
    expect((await get("https://example.com/a.jpg")).status).toBe(404);
    expect(asked.length).toBe(3);
  } finally {
    cleanup();
  }
});
