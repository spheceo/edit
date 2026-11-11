// What a coded effect is given from the timeline (effect_inputs.ts): a point
// tracked through the footage under it, as data in its folder, and the
// picture beneath it, rendered there and made again when it changes. On the
// real engine (its tracker and export), when it's built.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import * as vm from "node:vm";

import { registerEffectTools } from "../src/effect_tools.ts";
import * as effects from "../src/effects.ts";
import { dispatch } from "../src/mcp/index.ts";
import { findAddon, useNative, wrap, type Native } from "../src/native/index.ts";
import * as tools from "../src/tools.ts";
import { fixtureHome } from "./helpers/home.ts";

const addon = findAddon();
let before: Native | null = null;

beforeAll(() => {
  registerEffectTools();
});

afterAll(() => {
  if (addon !== null) useNative(before);
});

function hq(name: string) {
  const home = fixtureHome(name);
  const id = home.app.store.create("Inputs", { width: 1280, height: 720, fps: 30 }).project.id;
  // After the home is made (it puts the stub in place): the real engine.
  const previous = useNative(wrap(require(addon!) as Native));
  before ??= previous;
  (require(addon!) as Native).init({ home: home.app.store.home, cacheDir: home.app.store.cacheDir(), ffmpeg: tools.ffmpeg(), ffprobe: tools.ffprobe(), log: () => {} });
  return { ...home, id };
}

async function call(app: ReturnType<typeof fixtureHome>["app"], project: string, name: string, args: Record<string, unknown>) {
  return ((await dispatch(app, { id: 1, method: "tools/call", params: { name, arguments: args } }, project)) as { result: { content: { text?: string }[]; isError: boolean } }).result;
}

/** Footage of a white square crossing a dark textured frame, left to right over 4 s (x = 100 + 200·t, y = 300). */
function crossing(dir: string): string {
  const out = join(dir, "crossing.mp4");
  const made = Bun.spawnSync([
    tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "nullsrc=s=1280x720:d=4:r=30,geq=lum='40+20*sin(X/9)*sin(Y/7)':cb=128:cr=128",
    "-f", "lavfi", "-i", "color=white:s=80x80:d=4:r=30",
    "-filter_complex", "[0:v][1:v]overlay=x='100+200*t':y=300:shortest=1,format=yuv420p",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", out,
  ]);
  if (made.exitCode !== 0) throw new Error(made.stderr.toString());
  return out;
}

function pixel(path: string, time: number, x: number, y: number): number[] {
  return [...Bun.spawnSync([tools.ffmpeg(), "-v", "error", "-ss", String(time), "-i", path, "-frames:v", "1", "-vf", `format=rgb24,crop=1:1:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout];
}

test.skipIf(addon === null)("a point tracked through the footage is written into the effect's folder, frame by frame, where it is on screen", async () => {
  const { app, cleanup, id } = hq("effect-track");
  try {
    const footage = crossing(fs.mkdtempSync(join(os.tmpdir(), "edit-track-")));
    await app.store.update(id, "test", (project) => {
      project.hq = true;
      project.media.push({ id: "m1", name: "crossing", path: footage, kind: "video", duration: 4, width: 1280, height: 720, fps: 30, has_audio: false });
      project.tracks.push({ id: "t1", kind: "video", name: "V1", hidden: false, muted: false, locked: false } as unknown as (typeof project.tracks)[number]);
      project.clips.push({ id: "c1", type: "video", track: "t1", start: 0, duration: 120, media: "m1", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 } } as unknown as (typeof project.clips)[number]);
    });
    const dir = effects.folder(app.store, id, "spark");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, "scene.html"), "<p>spark</p>");
    // The square at 1 s: 300–380 across, 300–380 down.
    const answer = await call(app, id, "effect_track", { name: "spark", time: 1, points: [{ name: "square", box: [300, 300, 380, 380] }] });
    expect(answer.isError).toBe(false);
    expect(answer.content[0]!.text).toContain("window.tracks.track.at(name, t)");
    const script = fs.readFileSync(join(dir, "track.track.js"), "utf8");
    // Run as the page would, then read it back.
    const window: { tracks?: Record<string, { frames: number; fps: number; at: (name: string, t: number) => { x: number; y: number; w: number; h: number } }> } = {};
    vm.runInNewContext(script, { window });
    const data = window.tracks!.track!;
    expect(data.frames).toBe(120);
    for (const t of [0.5, 1, 2, 3]) {
      const at = data.at("square", t);
      // Its centre: 140 + 200·t across, 340 down, within a few pixels.
      expect(Math.abs(at.x - (140 + 200 * t))).toBeLessThan(6);
      expect(Math.abs(at.y - 340)).toBeLessThan(6);
      expect(Math.abs(at.w - 80)).toBeLessThan(2);
    }
    expect((await call(app, id, "effect_track", { name: "spark", time: 9, points: [{ name: "square", box: [0, 0, 10, 10] }] })).content[0]!.text).toContain("no footage at 9.00 s");
  } finally {
    cleanup();
  }
}, 120_000);

test.skipIf(addon === null)("the picture beneath an effect is rendered into its folder, and made again when what's beneath changes", async () => {
  const { app, cleanup, id } = hq("effect-beneath");
  try {
    await app.store.update(id, "test", (project) => {
      project.hq = true;
      project.media.push({ id: "m2", name: "glass", path: "/nowhere/glass.png", kind: "image", duration: 2, width: 1280, height: 720, fps: 0, has_audio: false, effect: "glass" });
      project.tracks.push({ id: "t1", kind: "video", name: "V1", hidden: false, muted: false, locked: false } as unknown as (typeof project.tracks)[number]);
      project.tracks.push({ id: "t2", kind: "video", name: "V2", hidden: false, muted: false, locked: false } as unknown as (typeof project.tracks)[number]);
      project.clips.push({ id: "c0", type: "solid", track: "t1", start: 0, duration: 90, fill: [0, 0, 1, 1], opacity: 1 } as unknown as (typeof project.clips)[number]);
      // The effect over 1–2 s.
      project.clips.push({ id: "c1", type: "video", track: "t2", start: 30, duration: 30, media: "m2", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 } } as unknown as (typeof project.clips)[number]);
    });
    const dir = effects.folder(app.store, id, "glass");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, "scene.html"), "<p>glass</p>");
    const answer = await call(app, id, "effect_beneath", { name: "glass" });
    expect(answer.isError).toBe(false);
    const video = join(dir, "beneath.mp4");
    const length = Number(Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video]).stdout.toString());
    expect(Math.abs(length - 1)).toBeLessThan(0.1);
    const blue = pixel(video, 0.5, 640, 360);
    expect(blue[2]).toBeGreaterThan(200);
    expect(blue[0]! + blue[1]!).toBeLessThan(40);
    // Asked again with nothing changed: as it was.
    expect((await call(app, id, "effect_beneath", { name: "glass" })).content[0]!.text).toContain("already of what's there now");
    // What's beneath changes: made again before the effect's next render (what every export runs first).
    await app.store.update(id, "test", (project) => {
      const solid = project.clips.find((one) => one.id === "c0") as unknown as { fill: number[] };
      solid.fill = [1, 0, 0, 1];
    });
    await effects.waitForRenders(app, id, 1).catch(() => {});
    const red = pixel(video, 0.5, 640, 360);
    expect(red[0]).toBeGreaterThan(200);
    expect(red[1]! + red[2]!).toBeLessThan(40);
    // Not placed: nothing beneath it to give.
    await app.store.update(id, "test", (project) => {
      project.clips = project.clips.filter((one) => one.id !== "c1");
    });
    expect((await call(app, id, "effect_beneath", { name: "glass" })).content[0]!.text).toContain("isn't on the timeline");
  } finally {
    cleanup();
  }
}, 120_000);
