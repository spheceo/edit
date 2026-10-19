import { afterAll, beforeAll, expect, test } from "bun:test";

import * as fs from "node:fs";

import { isImagePath, isLocalCopy, isMediaPath, Processor, Semaphore } from "../src/media.ts";
import type { MediaStatus } from "../src/media.ts";
import * as tools from "../src/tools.ts";
import { timing } from "../src/transcribe.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

const ffmpeg = Bun.which("ffmpeg");

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv();
  timing.sleep = async () => {};
  tools.forget();
});

afterAll(() => {
  restore();
  mock.stop();
});

test("what imports as media", () => {
  expect(isMediaPath("/a/B.MOV")).toBe(true);
  expect(isMediaPath("/a/b.opus")).toBe(true);
  expect(isMediaPath("/a/b.png")).toBe(false);
  expect(isImagePath("/a/b.JPG")).toBe(true);
  expect(isImagePath("/a/.png")).toBe(false);
  expect(isLocalCopy("/home/cache", "/home/cache/cloud/proxies/x.mp4")).toBe(true);
  expect(isLocalCopy("/home/cache", "/home/cache/cloudy/x.mp4")).toBe(false);
});

test("a semaphore lets one through at a time", async () => {
  const slots = new Semaphore(1);
  const order: string[] = [];
  await Promise.all(
    ["a", "b", "c"].map((name) =>
      slots.with(async () => {
        order.push(`${name} in`);
        await Bun.sleep(1);
        order.push(`${name} out`);
      }),
    ),
  );
  expect(order).toEqual(["a in", "a out", "b in", "b out", "c in", "c out"]);
});

/** Waits for `source`'s stages to settle (none pending or working), from its `media` events. */
function settled(store: { subscribe: (fn: (event: Record<string, unknown>) => void) => () => void }, source: string, done: (status: MediaStatus) => boolean): Promise<MediaStatus> {
  return new Promise((resolve) => {
    const stop = store.subscribe((event) => {
      if (event.type !== "media" || event.path !== source) return;
      const status = event.status as MediaStatus;
      if (done(status)) {
        stop();
        resolve(status);
      }
    });
  });
}

test.skipIf(ffmpeg === null)("footage gets thumbnails, a waveform, previews and (asked) a transcript", async () => {
  const { dir, app, store, cleanup } = fixtureHome("media-processor");
  try {
    const source = `${dir}/clip.mp4`;
    const made = Bun.spawnSync([
      ffmpeg!,
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x180:rate=30:duration=3",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=3",
      "-shortest",
      "-c:v",
      "libx264",
      "-g",
      "15",
      "-c:a",
      "aac",
      source,
    ]);
    expect(made.exitCode).toBe(0);
    const probe = await app.native.probe(source);
    expect([probe.kind, probe.has_audio, probe.width, probe.height]).toEqual(["video", true, 320, 180]);
    const done = settled(store, source, (status) => status.light === "ready" || status.light === "failed");
    app.media.ensure(source, probe);
    app.media.ensure(source, probe); // safe to ask again while it runs
    const status = await done;
    expect([status.thumbs, status.peaks, status.proxy, status.light]).toEqual(["ready", "ready", "ready", "ready"]);
    expect(status.thumb_count).toBeGreaterThan(0);
    const paths = app.media.paths(source);
    expect(fs.existsSync(paths.thumbs)).toBe(true);
    expect(JSON.parse(fs.readFileSync(paths.thumbsMeta, "utf8")).count).toBe(status.thumb_count);
    // Read back from disk by a fresh processor (a restarted server).
    const fresh = new Processor(store).status(source);
    expect([fresh.thumbs, fresh.peaks, fresh.proxy, fresh.light, fresh.thumb_count]).toEqual([
      "ready",
      "ready",
      "ready",
      "ready",
      status.thumb_count,
    ]);

    const transcribed = settled(store, source, (s) => s.transcript === "ready" || s.transcript === "failed");
    expect(app.media.transcribe(source, true).transcript).toBe("working");
    // A second ask while it runs doesn't pay twice.
    expect(app.media.transcribe(source, true).transcript).toBe("working");
    expect((await transcribed).transcript).toBe("ready");
    expect(mock.calls("/v1/transcribe").length).toBe(1);
    expect(app.media.transcribe(source, true).transcript).toBe("ready");
    expect(app.media.transcribe(`${dir}/silent.mp4`, false).transcript).toBe("pending");
  } finally {
    cleanup();
  }
});

test("a failed step says why and the rest go on", async () => {
  const { dir, app, store, cleanup } = fixtureHome("media-failure");
  try {
    const source = `${dir}/not-really.mp4`;
    fs.writeFileSync(source, "not a video");
    const done = settled(store, source, (status) => status.light === "skipped" || status.proxy === "ready");
    app.media.ensure(source, { kind: "video", duration: 2, width: 320, height: 180, fps: 30, has_audio: false });
    const status = await done.catch(() => app.media.status(source));
    expect(status.thumbs).toBe("failed");
    expect(status.peaks).toBe("skipped");
    expect(status.proxy).toBe("ready");
  } finally {
    cleanup();
  }
});
