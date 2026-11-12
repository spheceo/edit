import { expect, test } from "bun:test";
import * as fs from "node:fs";

import { chunkDir, keepPrevious, previousOf, segment, soundPath, stream } from "../src/playback_stream.ts";
import * as tools from "../src/tools.ts";
import { fixtureHome } from "./helpers/home.ts";

/** A 2 s picture-only H.264 chunk, as the engine's chunk sink writes them. */
async function chunk(path: string, seconds = 2) {
  await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=160x90:rate=30:duration=${seconds}`, "-c:v", "libx264", "-g", "30", "-pix_fmt", "yuv420p", path]);
}

test("a render under way serves the chunks it has made, never another render's; a finished one its manifest's", async () => {
  const { app, store, cleanup } = fixtureHome("playback-stream");
  try {
    const id = "p1";
    const dir = chunkDir(app, id);
    expect(dir.endsWith("/export-chunks/p1_playback")).toBe(true);
    fs.mkdirSync(dir, { recursive: true });
    const output = `${store.cacheDir()}/playback/${id}.mp4`;
    // Nothing planned yet: nothing to play, the sound still to come.
    expect(await stream(app, id, output, true, Date.now())).toMatchObject({ segments: [], sound: "pending" });
    const started = Date.now() - 1000;
    fs.writeFileSync(`${dir}/plan-v1.json`, JSON.stringify({ version: 1, extension: "mp4", chunks: [{ start: 0, end: 60, key: "aaa" }, { start: 60, end: 120, key: "bbb" }] }));
    await chunk(`${dir}/bbb.mp4`);
    const now = await stream(app, id, output, false, started);
    expect(now.segments).toEqual([{ start: 0, end: 60, key: "aaa", ready: false }, { start: 60, end: 120, key: "bbb", ready: true }]);
    expect(now.codec).toMatch(/^avc1\.64/);
    expect(now.sound).toBe("none");
    // A render started after that plan was written: the plan isn't its, so nothing is served as its.
    expect((await stream(app, id, output, false, Date.now() + 60_000)).segments).toEqual([]);
    // Its mix beside the partial file: the sound is there, at an address of its own.
    fs.mkdirSync(`${store.cacheDir()}/playback`, { recursive: true });
    // One another process left isn't this render's.
    fs.writeFileSync(`${output}.1-${id}.playback.partial.mp4.sound.m4a`, "stale");
    expect((await stream(app, id, output, true, started)).sound).toBe("pending");
    fs.writeFileSync(`${output}.${process.pid}-${id}.playback.partial.mp4.sound.m4a`, "sound");
    const heard = await stream(app, id, output, true, started);
    expect(heard.sound).toBe("ready");
    expect(heard.soundUrl).toMatch(/^\/api\/projects\/p1\/playback\/sound\?v=5-/);
    // Finished: the manifest says where each chunk is in the joined file.
    await chunk(output, 4);
    fs.writeFileSync(`${dir}/manifest-v1.json`, JSON.stringify({ version: 1, output, size: fs.statSync(output).size, modified_ns: 0, fps: 30, chunks: [{ key: "aaa", at: 0, frames: 60 }, { key: "bbb", at: 60, frames: 60 }], sound: null }));
    fs.rmSync(`${dir}/bbb.mp4`);
    const done = await stream(app, id, output, false, null);
    expect(done.segments.map((one) => [one.start, one.end, one.ready])).toEqual([[0, 60, true], [60, 120, true]]);
  } finally {
    cleanup();
  }
});

test("a chunk goes to the viewer as a fragmented MP4 of its own frames, from its file or the joined render", async () => {
  const { app, store, cleanup } = fixtureHome("playback-segment");
  try {
    const id = "p2";
    const dir = chunkDir(app, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/plan-v1.json`, JSON.stringify({ version: 1, extension: "mp4", chunks: [{ start: 0, end: 60, key: "one" }, { start: 60, end: 120, key: "two" }] }));
    await chunk(`${dir}/one.mp4`);
    const output = `${store.cacheDir()}/playback/${id}.mp4`;
    fs.mkdirSync(`${store.cacheDir()}/playback`, { recursive: true });
    await chunk(output, 4);
    fs.writeFileSync(`${dir}/manifest-v1.json`, JSON.stringify({ version: 1, output, size: fs.statSync(output).size, modified_ns: 0, fps: 30, chunks: [{ key: "one", at: 0, frames: 60 }, { key: "two", at: 60, frames: 60 }], sound: null }));
    for (const key of ["one", "two"]) {
      const bytes = new Uint8Array(await segment(app, id, key, 30, output).arrayBuffer());
      const file = `${dir}/${key}.fragment.mp4`;
      fs.writeFileSync(file, bytes);
      // Fragmented (a moof), and its own 60 frames.
      expect(Buffer.from(bytes).includes(Buffer.from("moof"))).toBe(true);
      const frames = new TextDecoder().decode(await tools.run([tools.ffprobe(), "-v", "error", "-count_packets", "-select_streams", "v:0", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", file])).trim();
      expect(Number(frames)).toBe(60);
    }
    expect(() => segment(app, id, "three", 30, output)).toThrow();
    expect(() => segment(app, id, "../x", 30, output)).toThrow();
  } finally {
    cleanup();
  }
});

test("the render before a new one stays playable for a viewer still on it: its chunks, its manifest, its sound, after its file is replaced", async () => {
  // Sphe, Nov 12: watching on while the agent works, its changes swapped in when they're ready.
  const { app, store, cleanup } = fixtureHome("playback-previous");
  try {
    const id = "p3";
    const dir = chunkDir(app, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(`${store.cacheDir()}/playback`, { recursive: true });
    const output = `${store.cacheDir()}/playback/${id}.mp4`;
    const previous = previousOf(output);
    expect(previous).toBe(`${store.cacheDir()}/playback/${id}.previous.mp4`);
    await chunk(output, 4);
    fs.writeFileSync(`${dir}/manifest-v1.json`, JSON.stringify({ version: 1, output, size: fs.statSync(output).size, modified_ns: 0, fps: 30, chunks: [{ key: "old1", at: 0, frames: 60 }, { key: "same", at: 60, frames: 60 }], sound: "aac" }));
    expect(keepPrevious(app, id, output, previous)).toBe(true);
    const before = await stream(app, id, previous, true, null, true);
    expect(before.soundUrl).not.toBeNull();
    // The new render: a changed first chunk, the same second one, its own joined file renamed over the old.
    fs.writeFileSync(`${dir}/plan-v1.json`, JSON.stringify({ version: 1, extension: "mp4", chunks: [{ start: 0, end: 60, key: "new1" }, { start: 60, end: 120, key: "same" }] }));
    const next = `${output}.partial.mp4`;
    await chunk(next, 6);
    fs.renameSync(next, output);
    fs.writeFileSync(`${dir}/manifest-v1.json`, JSON.stringify({ version: 1, output, size: fs.statSync(output).size, modified_ns: 0, fps: 30, chunks: [{ key: "new1", at: 0, frames: 60 }, { key: "same", at: 60, frames: 60 }], sound: "aac" }));
    // The engine's tidy after the join: nothing in the chunk folder but its manifest and plan.
    for (const name of fs.readdirSync(dir)) if (name !== "manifest-v1.json" && name !== "plan-v1.json") fs.rmSync(`${dir}/${name}`);
    // The previous render's stream is still its own, and its chunk that the new render dropped is still served.
    const still = await stream(app, id, previous, true, null, true);
    expect(still.segments.map((one) => [one.key, one.ready])).toEqual([["old1", true], ["same", true]]);
    expect(still.soundUrl).toBe(before.soundUrl);
    // Cut from the kept file: fragmented, its own 60 frames.
    const file = `${store.cacheDir()}/old1.fragment.mp4`;
    fs.writeFileSync(file, new Uint8Array(await segment(app, id, "old1", 30, output).arrayBuffer()));
    expect(Buffer.from(fs.readFileSync(file)).includes(Buffer.from("moof"))).toBe(true);
    expect(Number(new TextDecoder().decode(await tools.run([tools.ffprobe(), "-v", "error", "-count_packets", "-select_streams", "v:0", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", file])).trim())).toBe(60);
    // The old sound address keeps the old sound; the new one's is a new address, and its sound.
    const now = await stream(app, id, output, true, null);
    expect(now.soundUrl).not.toBe(before.soundUrl);
    const version = (url: string | null) => new URL(url ?? "", "http://x").searchParams.get("v");
    expect(soundPath(app, id, output, version(before.soundUrl))).toBe(previous);
    expect(soundPath(app, id, output, version(now.soundUrl))).toBe(output);
    expect(soundPath(app, id, output, null)).toBe(output);
    expect(fs.statSync(previous).size).toBeLessThan(fs.statSync(output).size);
  } finally {
    cleanup();
  }
});
