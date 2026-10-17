import { describe, expect, it, vi } from "vitest";
import { afterEach } from "vitest";
import { BLOCK, forgetBlocks, network, rangeReader, setStreaming } from "./range-source";

const file = Uint8Array.from({ length: BLOCK * 3 + 100 }, (_, i) => i % 251);

function server(ranges = true) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const [start, end] = (init.headers as Record<string, string>).Range.slice(6).split("-").map(Number);
    if (!ranges) return new Response(file, { headers: { "content-length": String(file.length) } });
    return new Response(file.slice(start, end + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${file.length}` } });
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  let parts: number[] = [];
  for await (const part of stream as unknown as AsyncIterable<Uint8Array>) parts = parts.concat(Array.from(part));
  return parts;
}

describe("block range reads", () => {
  afterEach(() => { forgetBlocks("/file"); setStreaming(false); });

  it("asks for bounded, block-aligned ranges and returns exactly the bytes requested", async () => {
    const fetcher = server();
    const reader = rangeReader("/file", fetcher);
    expect(await reader.getSize()).toBe(file.length);
    expect(await collect(reader.read(BLOCK - 10, BLOCK * 3 + 50))).toEqual([...file.slice(BLOCK - 10, BLOCK * 3 + 50)]);
    // The size came with the first block, which the read then reused.
    const ranges = fetcher.mock.calls.map(([, init]) => (init.headers as Record<string, string>).Range);
    expect(ranges).toEqual([0, 1, 2, 3].map((i) => `bytes=${i * BLOCK}-${Math.min(file.length, (i + 1) * BLOCK) - 1}`));
  });

  it("serves nearby reads from blocks already fetched", async () => {
    const fetcher = server();
    const reader = rangeReader("/file", fetcher);
    await reader.getSize();
    await collect(reader.read(10, 20));
    expect(await collect(reader.read(1000, 2000))).toEqual([...file.slice(1000, 2000)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps a file's size and blocks when it's opened again", async () => {
    const fetcher = server();
    await rangeReader("/file", fetcher).getSize();
    await collect(rangeReader("/file", fetcher).read(BLOCK + 1, BLOCK + 9));
    const cached = network.cached;
    const again = rangeReader("/file", fetcher);
    expect(await again.getSize()).toBe(file.length);
    expect(await collect(again.read(BLOCK + 1, BLOCK + 9))).toEqual([...file.slice(BLOCK + 1, BLOCK + 9)]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(network.cached).toBeGreaterThan(cached);
  });

  it("reads ahead once access turns sequential, only while playing", async () => {
    const fetcher = server();
    const reader = rangeReader("/file", fetcher);
    await reader.getSize();
    await collect(reader.read(10, 20));
    await collect(reader.read(BLOCK + 10, BLOCK + 20));
    // A scrub fetches only the blocks it reads.
    expect(fetcher).toHaveBeenCalledTimes(2);
    setStreaming(true);
    await collect(reader.read(BLOCK * 2 + 10, BLOCK * 2 + 20));
    const ranges = fetcher.mock.calls.map(([, init]) => (init.headers as Record<string, string>).Range);
    expect(ranges).toEqual([0, 1, 2, 3].map((i) => `bytes=${i * BLOCK}-${Math.min(file.length, (i + 1) * BLOCK) - 1}`));
  });

  it("slices a whole-file answer from a server without range support", async () => {
    const reader = rangeReader("/file", server(false));
    await reader.getSize();
    expect(await collect(reader.read(BLOCK + 5, BLOCK + 9))).toEqual([...file.slice(BLOCK + 5, BLOCK + 9)]);
  });
});
