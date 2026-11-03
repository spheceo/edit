import { afterEach, describe, expect, it, vi } from "vitest";
import { media, mediaUrl, type EdgeCache } from "../../../relay/src/media";

const env = { MEDIA_HOST: "media.example.com", MEDIA_SECRET: "a long random secret" };
const r2 = { host: "acct.r2.cloudflarestorage.com", bucket: "b", accessKeyId: "id", secret: "secret" };
const KEY = "edit/proxies/drive/abc.mp4";

/** An edge cache in memory, as caches.default keeps them. */
function edge(): EdgeCache & { kept: Map<string, Response> } {
  const kept = new Map<string, Response>();
  return {
    kept,
    match: async (request) => kept.get(request.url)?.clone(),
    put: async (request, response) => void kept.set(request.url, response),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("proxies through the relay's edge (media.ts)", () => {
  it("hands out a signed media address only for proxies, and only when set up", async () => {
    const url = await mediaUrl(env, KEY, 3600, 1_000_000);
    expect(url).toMatch(/^https:\/\/media\.example\.com\/v1\/media\/edit\/proxies\/drive\/abc\.mp4\?exp=4600&sig=[0-9a-f]{64}$/);
    expect(await mediaUrl(env, "edit/originals/drive/abc/a.mov", 3600)).toBeNull();
    expect(await mediaUrl({}, KEY, 3600)).toBeNull();
  });

  it("serves a range from R2 once, then from the edge for anyone with a valid address; refuses a bad signature or a lapsed one", async () => {
    const reads: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { headers: Record<string, string> }) => {
      reads.push(init.headers.range!);
      return new Response(new Uint8Array(10), { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 0-9/100" } });
    });
    const cache = edge();
    const now = 1_000_000_000;
    const address = new URL((await mediaUrl(env, KEY, 3600, now))!);
    const ask = (url: URL) => media(new Request(url, { headers: { range: "bytes=0-9" } }), url, env, r2, cache, now);
    const first = await ask(address);
    expect(first.status).toBe(206);
    expect(first.headers.get("x-edit-edge")).toBe("MISS");
    expect(first.headers.get("content-range")).toBe("bytes 0-9/100");
    // Another Mac's address for the same key (signed later): the edge's copy.
    const other = new URL((await mediaUrl(env, KEY, 7200, now))!);
    const second = await ask(other);
    expect(second.headers.get("x-edit-edge")).toBe("HIT");
    expect(second.headers.get("content-range")).toBe("bytes 0-9/100");
    expect((await second.arrayBuffer()).byteLength).toBe(10);
    expect(reads).toEqual(["bytes=0-9"]);
    const forged = new URL(address);
    forged.searchParams.set("sig", "0".repeat(64));
    expect((await ask(forged)).status).toBe(403);
    const lapsed = new URL((await mediaUrl(env, KEY, 10, now - 3_600_000))!);
    expect((await ask(lapsed)).status).toBe(403);
    expect((await media(new Request(address), address, env, r2, cache, now)).status).toBe(416);
  });
});
