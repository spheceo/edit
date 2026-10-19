import { expect, test } from "bun:test";

import { compressed } from "../src/http/compress.ts";

const big = JSON.stringify({ clips: Array.from({ length: 400 }, (_, n) => ({ id: `c${n}`, text: "Subtitle · Lauren", start: n })) });
const ask = (encoding: string | null, method = "GET") =>
  new Request("http://localhost/api/projects/p", { method, headers: encoding === null ? {} : { "accept-encoding": encoding } });

test("JSON is gzipped for a browser that takes it, and comes back the same", async () => {
  const out = await compressed(ask("gzip, deflate, br"), Response.json(JSON.parse(big)));
  expect(out.headers.get("content-encoding")).toBe("gzip");
  expect(out.headers.get("vary")).toContain("accept-encoding");
  const bytes = new Uint8Array(await out.arrayBuffer());
  expect(bytes.byteLength).toBeLessThan(big.length / 5);
  expect(new TextDecoder().decode(Bun.gunzipSync(bytes))).toBe(big);
});

test("the UI's files are brotli, kept; small, streamed, ranged, HEAD and media answers pass as they are", async () => {
  const js = () => new Response(big.repeat(4), { headers: { "content-type": "application/javascript" } });
  const first = await compressed(ask("br, gzip"), js(), "/assets/index.js");
  expect(first.headers.get("content-encoding")).toBe("br");
  const again = await compressed(ask("br"), js(), "/assets/index.js");
  expect(new Uint8Array(await again.arrayBuffer())).toEqual(new Uint8Array(await first.arrayBuffer()));
  expect((await compressed(ask(null), Response.json(JSON.parse(big)))).headers.get("content-encoding")).toBeNull();
  expect((await compressed(ask("gzip"), Response.json({ ok: true }))).headers.get("content-encoding")).toBeNull();
  expect((await compressed(ask("gzip", "HEAD"), Response.json(JSON.parse(big)))).headers.get("content-encoding")).toBeNull();
  const video = new Response(big, { headers: { "content-type": "video/mp4" } });
  expect((await compressed(ask("gzip"), video)).headers.get("content-encoding")).toBeNull();
  const events = new Response(big, { headers: { "content-type": "text/event-stream" } });
  expect((await compressed(ask("gzip"), events)).headers.get("content-encoding")).toBeNull();
  const part = new Response(big, { status: 206, headers: { "content-type": "application/json", "content-range": "bytes 0-9/99" } });
  expect((await compressed(ask("gzip"), part)).headers.get("content-encoding")).toBeNull();
});
