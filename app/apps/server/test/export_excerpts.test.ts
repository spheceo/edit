import { expect, test } from "bun:test";
import * as fs from "node:fs";

import * as cloudBlocks from "../src/cloud_blocks.ts";
import { behind, CELL, cellKey, cellSpan, cellsOf, objectOf, pin, pinned, prepare, TO_THE_END } from "../src/export_excerpts.ts";
import type { Project } from "../src/model.ts";
import * as tools from "../src/tools.ts";
import { scratch } from "./helpers/home.ts";

function project(clips: unknown[]): Project {
  return {
    settings: { width: 1920, height: 1080, fps: 30 },
    media: [
      { id: "a", name: "a.mp4", path: "https://r2/a.mp4?sig", kind: "video", duration: 600, width: 1920, height: 1080, fps: 29.97, has_audio: true },
      { id: "b", name: "b.mp4", path: "https://r2/b.mp4?sig", kind: "video", duration: 50, width: 1920, height: 1080, fps: 30, has_audio: true },
    ],
    clips,
  } as unknown as Project;
}

test("an export needs the 30 s cells of each original its clips show, in the order they're shown, each once", () => {
  const edit = project([
    // 10 s of a from 95 s, at frame 300.
    { id: "c1", track: "v1", type: "video", media: "a", source_in: 95, start: 300, duration: 300 },
    // A from 5 s at double speed for 20 s (40 s of it): cells 0 and 1.
    { id: "c2", track: "v1", type: "video", media: "a", source_in: 5, start: 0, duration: 600 },
    // b's last seconds: cell 1 ends at the file's end.
    { id: "c3", track: "v2", type: "video", media: "b", source_in: 40, start: 900, duration: 150, speed: 1 },
    // Sound only, or outside the span asked for: no cells.
    { id: "s", track: "a1", type: "audio", media: "a", source_in: 400, start: 0, duration: 300 },
    { id: "late", track: "v1", type: "video", media: "a", source_in: 500, start: 5000, duration: 30 },
  ]);
  (edit.clips[1] as { speed?: number }).speed = 2;
  const cells = cellsOf(edit, 0, 2000, new Set(["a", "b"]));
  expect(cells.map((cell) => `${cell.media}${cell.index}@${cell.first}`)).toEqual(["a0@0", "a1@0", "a3@300", "b1@900"]);
  // On a's frame grid (29.97 fps): frame ⌊90 × 29.97⌋ = 2697.
  expect(cells[2]!.from).toBeCloseTo(2697 / 29.97, 9);
  expect(cells[2]!.to).toBe(4 * CELL);
  expect(cells[3]).toMatchObject({ from: 30, to: 50 });
  expect(cellSpan(0, 30, 10)).toEqual({ from: 0, to: 10 });
  expect(cellKey("edit/originals/drive/abc/Cam 1.MOV", 29.97, 7)).toBe("edit/excerpts/originals/drive/abc/Cam 1.MOV/cells-30-29.970/7.mov");
  expect(cellKey("edit/originals/drive/abc/a.mkv", 30, 0)).toBe(null);
});

test("cells are cut from the original, picture copied, kept in the cache, and found there the next time", async () => {
  const { dir, cleanup } = scratch("excerpts");
  try {
    const source = `${dir}/source.mp4`;
    await tools.run([tools.ffmpeg(), "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "70", "-c:v", "libx264", "-g", "48", "-bf", "2", "-c:a", "aac", "-shortest", source]);
    const edit = {
      settings: { width: 160, height: 90, fps: 30 },
      media: [{ id: "m", name: "source.mp4", path: source, kind: "video", duration: 70, width: 160, height: 90, fps: 30, has_audio: true }],
      clips: [{ id: "c", track: "v1", type: "video", media: "m", source_in: 25, start: 0, duration: 300 }],
    } as unknown as Project;
    const cache = `${dir}/cache`;
    const urls = new Map([["m", source]]);
    const originals = new Map([["m", "edit/originals/sha256/abc/source.mp4"]]);
    const first = await prepare(edit, 0, 300, cache, urls, originals);
    // 25–35 s: cells 0 and 1.
    expect(first.map((one) => [one.from, one.to])).toEqual([[0, 30], [30, 60]]);
    // The last cell of an original reaches on past its end.
    const tail = await prepare({ ...edit, clips: [{ id: "t", track: "v1", type: "video", media: "m", source_in: 65, start: 0, duration: 120 }] } as unknown as Project, 0, 120, cache, urls, originals);
    expect(tail.map((one) => [one.from, one.to])).toEqual([[60, TO_THE_END]]);
    for (const excerpt of first) {
      expect(excerpt.path.startsWith(`${cache}/cloud/excerpts/originals/sha256/abc/source.mp4/cells-30-30.000/`)).toBe(true);
      const streams = new TextDecoder().decode(await tools.run([tools.ffprobe(), "-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", excerpt.path]));
      // Picture only: the sound is mixed from its own copy.
      expect(streams.trim()).toBe("video");
    }
    const stamp = fs.statSync(first[1]!.path).mtimeMs;
    const again = await prepare(edit, 0, 300, cache, urls, originals);
    expect(again).toEqual(first);
    expect(fs.statSync(first[1]!.path).size).toBeGreaterThan(0);
    expect(fs.statSync(first[1]!.path).mtimeMs).toBeGreaterThanOrEqual(stamp);
  } finally {
    cleanup();
  }
}, 30_000);

test("a background render's cells wait for the viewer once, briefly — never per cell, so it cannot sit at 0% while watched", async () => {
  const { dir, cleanup } = scratch("excerpts-behind-viewer");
  try {
    const source = `${dir}/source.mp4`;
    await tools.run([tools.ffmpeg(), "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30", "-t", "35", "-c:v", "libx264", "-g", "48", source]);
    const edit = {
      settings: { width: 160, height: 90, fps: 30 },
      media: [{ id: "m", name: "source.mp4", path: source, kind: "video", duration: 35, width: 160, height: 90, fps: 30, has_audio: false }],
      clips: [{ id: "c", track: "v1", type: "video", media: "m", source_in: 5, start: 0, duration: 300 }],
    } as unknown as Project;
    // The viewer stays busy the whole time: the one bounded wait (50 ms here) is all the delay there is.
    cloudBlocks.noteViewerMiss();
    const began = Date.now();
    const made = await prepare(edit, 0, 300, `${dir}/cache`, new Map([["m", source]]), new Map([["m", "edit/originals/sha256/abc/source.mp4"]]), () => false, { atOnce: 2, behindViewer: true, restMaxMs: 50 });
    expect(made.length).toBeGreaterThan(0);
    expect(Date.now() - began).toBeLessThan(20_000);
  } finally {
    cloudBlocks.noteViewerMiss(0);
    cleanup();
  }
});

test("a cell that can't be cut leaves its stretch to the cloud, the export going on; a cancel stops the cuts", async () => {
  const { dir, cleanup } = scratch("excerpts-fallback");
  try {
    const edit = {
      settings: { width: 160, height: 90, fps: 30 },
      media: [
        { id: "gone", name: "gone.mp4", path: "x", kind: "video", duration: 70, width: 160, height: 90, fps: 30, has_audio: false },
        { id: "mkv", name: "a.mkv", path: "y", kind: "video", duration: 70, width: 160, height: 90, fps: 30, has_audio: false },
      ],
      clips: [
        { id: "c1", track: "v1", type: "video", media: "gone", source_in: 5, start: 0, duration: 30 },
        { id: "c2", track: "v1", type: "video", media: "mkv", source_in: 5, start: 30, duration: 30 },
      ],
    } as unknown as Project;
    const cache = `${dir}/cache`;
    // One original that won't read, one in a container the cells don't take: neither has excerpts, and nothing throws.
    const urls = new Map([["gone", `${dir}/missing.mp4`], ["mkv", `${dir}/a.mkv`]]);
    const originals = new Map([["gone", "edit/originals/sha256/aa/missing.mp4"], ["mkv", "edit/originals/sha256/bb/a.mkv"]]);
    const steps: [number, number][] = [];
    expect(await prepare(edit, 0, 60, cache, urls, originals, () => false, { onStep: (done, total) => steps.push([done, total]) })).toEqual([]);
    // Said once up front, then once per cell, including a cell that can't be cut.
    const total = steps[0]?.[1] ?? 0;
    expect(steps[0]?.[0]).toBe(0);
    expect(total).toBeGreaterThan(0);
    expect(steps.at(-1)).toEqual([total, total]);
    expect(steps).toHaveLength(total + 1);
    expect(fs.readdirSync(`${cache}/cloud/tmp`)).toEqual([]);
    // Cancelled: it says so, and nothing is left half cut.
    await expect(prepare(edit, 0, 60, cache, urls, originals, () => true)).rejects.toThrow("cancelled");
    expect(fs.readdirSync(`${cache}/cloud/tmp`)).toEqual([]);
  } finally {
    cleanup();
  }
});

test("an export's excerpts are pinned against the cache's cleaner until it lets them go", () => {
  const first = pin(["/c/a.mp4", "/c/b.mp4"]);
  const second = pin(["/c/a.mp4"]);
  expect(pinned("/c/a.mp4") && pinned("/c/b.mp4")).toBe(true);
  first();
  first();
  expect(pinned("/c/a.mp4")).toBe(true);
  expect(pinned("/c/b.mp4")).toBe(false);
  second();
  expect(pinned("/c/a.mp4")).toBe(false);
});

test("objects are named as the engine names them: an original without its signature, a proxy by its key whatever the port", () => {
  expect(objectOf("https://r2.example/edit/originals/drive/abc/a.mp4?X-Amz-Signature=1")).toBe("https://r2.example/edit/originals/drive/abc/a.mp4");
  const proxy = (port: number) => `http://127.0.0.1:${port}/api/cloud/preview?key=${encodeURIComponent("edit/proxies/drive/abc.mp4")}`;
  expect(objectOf(proxy(7700))).toBe("cloud:edit/proxies/drive/abc.mp4");
  expect(objectOf(proxy(7710))).toBe(objectOf(proxy(7700)));
  expect(objectOf(`http://127.0.0.1:7700/api/cloud/preview?key=${encodeURIComponent("edit/proxies/drive/other.mp4")}`)).not.toBe(objectOf(proxy(7700)));
});

test("a background render's reads of this server's preview path say they're behind the viewer; others are as they are", () => {
  const preview = "http://127.0.0.1:7700/api/cloud/preview?key=edit%2Fpieces%2Fv3%2Fsha256%2Fab%2Fproxy.mp4";
  expect(behind(preview)).toBe(`${preview}&behind=1`);
  expect(behind("/footage/a.mp4")).toBe("/footage/a.mp4");
  expect(behind("https://r2.example/edit/originals/a.mp4?X-Amz-Signature=x")).toBe("https://r2.example/edit/originals/a.mp4?X-Amz-Signature=x");
});
