import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { CachePaths } from "../index";
import { ffmpeg, home, native } from "./native";

const clip = join(home, "clip.mp4");
const tone = join(home, "tone.wav");

beforeAll(() => {
  // 2 s of 320×180 colour bars with a 1 kHz tone, and 3 s of a sine.
  expect(
    ffmpeg([
      "-f", "lavfi", "-i", "smptebars=size=320x180:rate=30:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip,
    ]),
  ).toBe(true);
  expect(ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3", tone])).toBe(true);
});

function paths(source: string): CachePaths {
  const dir = native.mediaCache(source)!;
  mkdirSync(dir, { recursive: true });
  return {
    proxy: join(dir, "preview.mp4"),
    audio: join(dir, "preview.m4a"),
    proxyDone: join(dir, "preview.done"),
    thumbs: join(dir, "thumbs.jpg"),
    thumbsMeta: join(dir, "thumbs.json"),
    peaks: join(dir, "peaks.bin"),
    transcript: join(dir, "transcript.json"),
    light: join(dir, "preview-light.mp4"),
  };
}

describe("probing", () => {
  test("footage and sound", async () => {
    const video = await native.probe(clip);
    expect(video.kind).toBe("video");
    expect([video.width, video.height, video.fps, video.has_audio]).toEqual([320, 180, 30, true]);
    const sound = await native.probe(tone);
    expect(sound.kind).toBe("audio");
    expect(Math.abs(sound.duration - 3)).toBeLessThan(0.05);
  });

  test("a missing file rejects with ffprobe's reason", async () => {
    const missing = join(home, "missing.mp4");
    expect(native.probe(missing)).rejects.toThrow(`could not read ${missing}`);
  });
});

describe("previews", () => {
  test("the preview reports progress and lands whole; then the light one", async () => {
    const probe = await native.probe(clip);
    const where = paths(clip);
    const progress: number[] = [];
    await native.makePreview({ source: clip, probe, paths: where, fromCloudProxy: false }, (value) =>
      progress.push(value),
    );
    expect(existsSync(where.proxy) && existsSync(where.audio) && existsSync(where.proxyDone)).toBe(true);
    for (const value of progress) expect(value).toBeLessThanOrEqual(1);
    await native.makeLightPreview(clip, where, probe);
    expect(native.lightPreview(clip)).toBe(where.light);
    const light = await native.probe(where.light);
    expect(light.kind).toBe("video");
  }, 60_000);

  test("waveform peaks: a byte per 1/100 s", async () => {
    const out = join(home, "tone.peaks");
    await native.makePeaks(tone, out);
    const peaks = readFileSync(out);
    expect(Math.abs(peaks.length - 300)).toBeLessThanOrEqual(1);
    // The sine's 1/8 amplitude, square-rooted onto 0..255.
    expect(Math.abs(peaks[150] - Math.round(Math.sqrt(0.125) * 255))).toBeLessThanOrEqual(1);
  });

  test("a cloud proxy of footage, not of sound", async () => {
    const out = join(home, "proxy", "clip.mp4");
    await native.makeCloudProxy(clip, await native.probe(clip), out);
    expect((await native.probe(out)).has_audio).toBe(true);
    expect(native.makeCloudProxy(tone, await native.probe(tone), out)).rejects.toThrow(
      "only footage gets a cloud proxy",
    );
  }, 60_000);
});

describe("sound", () => {
  test("loudness of stretches, read off one analysis", async () => {
    await native.loudnessPrepare([tone, tone]);
    const [whole, nothing] = await native.loudnessSpans(tone, [
      { from: 0, seconds: 3 },
      { from: 10, seconds: 1 },
    ]);
    // FFmpeg's sine source is at 1/8 amplitude: about -21 LUFS, peak -18 dBFS.
    expect(whole.integrated).toBeGreaterThan(-23);
    expect(whole.integrated).toBeLessThan(-19);
    expect(Math.abs(whole.peak + 18.06)).toBeLessThan(0.2);
    // Past the end it's silence: the gate's floor.
    expect(nothing.integrated).toBeLessThanOrEqual(-70);
    const loudest = await native.loudestMoment(tone);
    expect(loudest).toBeGreaterThanOrEqual(0);
    expect(loudest).toBeLessThanOrEqual(3);
    native.loudnessWarm(tone);
  });
});

describe("analysis", () => {
  test("camera angles in small grey frames", async () => {
    const frame = (value: number) => Buffer.alloc(64 * 36, value);
    const stripes = Buffer.alloc(64 * 36);
    for (let i = 0; i < stripes.length; i++) stripes[i] = i % 64 < 32 ? 0 : 255;
    // 25 s of one picture, then 25 s of another: two angles.
    const frames = Buffer.concat([...Array(50).fill(frame(128)), ...Array(50).fill(stripes)]);
    const { scenes, angles } = await native.seatsScenes(frames);
    expect(angles).toBe(2);
    expect(scenes.length).toBe(2);
    expect(scenes[0]).toEqual([0, 25, 0]);
    expect(scenes[1]).toEqual([25, Infinity, 1]);
  });

  test("faces: none cached for a file never looked at", () => {
    expect(native.facesCached(tone)).toBeNull();
  });

  test("tracking needs a box", async () => {
    expect(
      native.trackAnchors({ path: clip, size: [320, 180], fps: 30, from: 0, to: 1, anchors: [] }),
    ).rejects.toThrow("no box to track");
  });

  test("the desktop profile's pictures are drawn once into <home>/graphics", async () => {
    const files = await native.desktopFiles(960, 540, "Photo Viewer", "Notepad");
    expect(files.length).toBe(3);
    for (const file of files) {
      expect(file.startsWith(join(home, "graphics"))).toBe(true);
      expect(existsSync(file)).toBe(true);
    }
  });

  test("censor checks start with nothing read", () => {
    const project = {
      version: 1,
      id: "p-censor",
      name: "censor",
      settings: { width: 320, height: 180, fps: 30 },
      media: [
        { id: "m1", name: "clip", path: clip, kind: "video", duration: 2, width: 320, height: 180, fps: 30, has_audio: true },
      ],
      tracks: [{ id: "v1", kind: "video" }, { id: "v2", kind: "video" }],
      clips: [
        { id: "a", track: "v1", type: "video", media: "m1", start: 0, duration: 60 },
        { id: "b", track: "v2", type: "video", media: "m1", start: 0, duration: 30 },
      ],
    };
    const check = native.censorIssues({ json: JSON.stringify(project) }, false);
    expect(check.issues).toEqual([]);
  });
});
