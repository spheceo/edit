// broll.ts's tests, and the B-roll pieces on the stub: map pages, stand-ins,
// smoothing, stills and transcripts.

import * as fs from "node:fs";

import { expect, test } from "bun:test";

import type { App } from "../src/app.ts";
import * as broll from "../src/broll.ts";
import { frameName, framesHad, outlineIn, ryu, rustJson, urlencode } from "../src/broll.ts";
import { baseRouter, respond } from "../src/http/server.ts";
import { importPaths, placeAtEnd } from "../src/import.ts";
import { isImagePath } from "../src/media.ts";
import { routes } from "../src/media_tools.ts";
import type { Project, VideoClip } from "../src/model.ts";
import { serialize } from "../src/transcribe.ts";
import { fixtureHome, write } from "./helpers/home.ts";

const ffmpeg = Bun.which("ffmpeg");
const ffprobe = Bun.which("ffprobe");

test("places_are_encoded_for_the_search", () => {
  expect(urlencode("Kent Police, WA & co")).toBe("Kent+Police%2C+WA+%26+co");
});

test("building_outlines_are_read", () => {
  const found = {
    destinations: [
      {
        primary: { structureType: "POINT" },
        containingPlaces: [
          {
            structureType: "BUILDING",
            displayPolygon: { type: "Polygon", coordinates: [[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 0.0]]] },
          },
        ],
      },
    ],
  };
  expect(outlineIn(found)?.length).toBe(4);
  expect(outlineIn({ destinations: [] })).toBeNull();
});

test("images_are_recognised", () => {
  expect(isImagePath("/x/Still.PNG")).toBe(true);
  expect(isImagePath("/x/clip.mp4")).toBe(false);
});

test("whole_frames_are_resumed_from", () => {
  const { dir, cleanup } = fixtureHome("map-frames");
  try {
    write(`${dir}/${frameName(0)}`, new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]));
    // Cut off mid-write (no end marker), and a gap.
    write(`${dir}/${frameName(1)}`, new Uint8Array([0xff, 0xd8, 1, 2]));
    write(`${dir}/${frameName(3)}`, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    expect(framesHad(dir, 5)).toEqual([0, 3]);
  } finally {
    cleanup();
  }
});

test("the map page takes its config", () => {
  expect(typeof broll.MAP_PAGE).toBe("string");
  expect(broll.MAP_PAGE).toContain("const C = __CONFIG__;");
});

test("map configs are written as serde_json writes them (their files are named by it)", () => {
  expect(ryu(170)).toBe("170.0");
  expect(ryu(0.12)).toBe("0.12");
  expect(ryu(-25)).toBe("-25.0");
  expect(ryu(0)).toBe("0.0");
  expect(ryu(47.6062)).toBe("47.6062");
  expect(ryu(1e15)).toBe("1000000000000000.0");
  expect(ryu(1e16)).toBe("1e16");
  expect(ryu(1.5e-7)).toBe("1.5e-7");
  expect(ryu(0.0001)).toBe("0.0001");
  expect(ryu(123456789012345680)).toBe("1.2345678901234568e17");
});

function makeFile(args: string[], out: string): void {
  const made = Bun.spawnSync([ffmpeg!, "-hide_banner", "-loglevel", "error", "-y", ...args, out]);
  expect(made.exitCode).toBe(0);
}

/**
 * A moving map shot's stand-in (its first frame) becomes the footage when
 * the render is done: same media id, so clips placed on it play the shot;
 * until then it's listed as pending and exports wait.
 */
test.skipIf(ffmpeg === null || ffprobe === null)("map_footage_swaps_in_for_its_first_frame", async () => {
  const { app, cleanup, home } = fixtureHome("map-swap");
  const { mapsPending } = broll.state;
  try {
    const project = app.store.create("map", { width: 1920, height: 1080, fps: 30 }).project.id;
    const maps = `${home}/maps`;
    fs.mkdirSync(maps, { recursive: true });
    const first = `${maps}/map-k-first.jpg`;
    const out = `${maps}/map-k.mp4`;
    makeFile(["-f", "lavfi", "-i", "color=c=red:s=320x180", "-frames:v", "1"], first);
    makeFile(["-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=2", "-pix_fmt", "yuv420p"], out);
    const [, added] = await importPaths(app, project, [first], false, "agent");
    const media = added[0]!;
    await app.store.update(project, "test", (edited) => placeAtEnd(edited, media));
    mapsPending.set(project, new Map([[first, { media, error: null }]]));
    expect(broll.smoothingPending(project)).toEqual([`${media} (map view rendering)`]);
    await expect(broll.waitForMaps(app, project, 600)).rejects.toThrow("still rendering");
    expect(await broll.waitForSmoothing(project, 600)).toBe(false);

    // A render that failed: the export refuses the stand-in and says why.
    mapsPending.get(project)!.get(first)!.error = "tiles refused";
    await expect(broll.waitForMaps(app, project, 0)).rejects.toThrow("tiles refused");
    // Cut short (Edit closed mid-render: nothing pending any more).
    const standIn = mapsPending.get(project)!;
    mapsPending.delete(project);
    await expect(broll.waitForMaps(app, project, 0)).rejects.toThrow("cut short");
    for (const map of standIn.values()) map.error = null;
    mapsPending.set(project, standIn);

    await broll.swapInMap(app, project, first, out);

    const live = app.store.get(project)!.project;
    const swapped = live.media.find((item) => item.id === media)!;
    expect(swapped.path).toBe(fs.realpathSync(out));
    expect(swapped.kind).toBe("video");
    expect(Math.abs(swapped.duration - 2.0)).toBeLessThan(0.1);
    expect(live.clips.some((clip) => "media" in clip && clip.media === media)).toBe(true);
    expect(broll.smoothingPending(project)).toEqual([]);
    await broll.waitForMaps(app, project, 0);

    // A render that failed is listed (with what to do) but holds nothing up.
    mapsPending.set(project, new Map([["elsewhere.jpg", { media: "m9", error: "tiles refused" }]]));
    expect(broll.smoothingPending(project)[0]!.startsWith("m9 (map view failed: tiles refused")).toBe(true);
    await broll.waitForMaps(app, project, 0);
    expect(await broll.waitForSmoothing(project, 0)).toBe(true);
    mapsPending.delete(project);
  } finally {
    cleanup();
  }
});

/**
 * An export starts a map whose render stalled, failed or was cut short again
 * by itself (from its job file and kept frames), instead of refusing it and
 * waiting for the agent to call map_view again (Oct 21).
 */
test.skipIf(ffmpeg === null || ffprobe === null)("an export starts a stuck map again by itself", async () => {
  const { app, cleanup, home } = fixtureHome("map-resume");
  const { mapsPending, mapRenders } = broll.state;
  const project = app.store.create("map", { width: 1920, height: 1080, fps: 30 }).project.id;
  try {
    const dir = `${home}/maps`;
    fs.mkdirSync(dir, { recursive: true });
    const first = `${dir}/map-r-first.jpg`;
    makeFile(["-f", "lavfi", "-i", "color=c=red:s=320x180", "-frames:v", "1"], first);
    const [, added] = await importPaths(app, project, [first], false, "agent");
    const media = added[0]!;
    await app.store.update(project, "test", (edited) => placeAtEnd(edited, media));
    // No job file: refused as before, saying what to do.
    await expect(broll.waitForMaps(app, project, 0)).rejects.toThrow("cut short");
    // With one, it's started again (here it joins a render already under way, so no Chrome opens).
    expect(broll.standInJob(first)).toBe(`${dir}/map-r.job.json`);
    write(broll.standInJob(first), JSON.stringify({ key: "r", config: '{"frames":12}', width: 1920, height: 1080, fps: 30, frames: 12, dir }));
    mapRenders.set("r", { ready: { done: false } as never, projects: new Set(), failed: null });
    await expect(broll.waitForMaps(app, project, 0)).rejects.toThrow("still rendering");
    expect(mapRenders.get("r")!.projects.has(project)).toBe(true);
    expect(broll.smoothingPending(project)).toEqual([`${media} (map view rendering)`]);
    // Its stand-in gone from the project: nothing to start.
    expect(broll.resumeMap(app, "elsewhere", first)).toBe(false);
  } finally {
    mapRenders.delete("r");
    mapsPending.delete(project);
    cleanup();
  }
});

test("the map page, its frames and its picture come back through the routes", async () => {
  const { app, cleanup, dir } = fixtureHome("map-routes");
  const router = baseRouter();
  routes(router);
  const ask = (method: string, path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", "127.0.0.1:7700");
    return respond(app, router, new Request(`http://127.0.0.1:7700${path}`, { method, ...init, headers }), null);
  };
  try {
    expect((await ask("GET", "/api/maps/none"))!.status).toBe(404);
    const frames = `${dir}/frames`;
    fs.mkdirSync(frames);
    let picture: unknown = null;
    let ready: unknown = null;
    const done = { send: (value: unknown) => (picture = value) };
    const early = { send: (value: unknown) => (ready = value) };
    broll.state.mapJobs.set("tok", { page: "<html>map</html>", done: done as never, ready: early as never, frames });
    const page = (await ask("GET", "/api/maps/tok"))!;
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await page.text()).toBe("<html>map</html>");
    const frame = (await ask("POST", "/api/maps/tok/frame/2", { headers: { "content-type": "image/jpeg" }, body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) }))!;
    expect(frame.status).toBe(204);
    expect(framesHad(frames, 3)).toEqual([2]);
    expect((await ask("POST", "/api/maps/tok/frame/x", { body: "" }))!.status).toBe(400);
    const phase = (await ask("POST", "/api/maps/tok", { headers: { "x-map-phase": "ready", "content-type": "application/json" }, body: '{"track":[[1,2,3,4]]}' }))!;
    expect(phase.status).toBe(204);
    expect(ready).toEqual({ track: [[1, 2, 3, 4]] });
    const shot = (await ask("POST", "/api/maps/tok", {
      headers: { "content-type": "image/png", "x-map-info": '{"building":[1,2,3,4]}' },
      body: new Uint8Array([137, 80, 78, 71]),
    }))!;
    expect(shot.status).toBe(204);
    expect(picture).toEqual({ ok: [new Uint8Array([137, 80, 78, 71]), { building: [1, 2, 3, 4] }] });
    // Answered once.
    expect((await ask("POST", "/api/maps/tok", { headers: { "content-type": "text/plain" }, body: "x" }))!.status).toBe(404);
  } finally {
    broll.state.mapJobs.delete("tok");
    cleanup();
  }
});

test("map_view without a place or a point says what it needs", async () => {
  const { app, cleanup } = fixtureHome("map-args");
  try {
    const project = app.store.create("map", { width: 1920, height: 1080, fps: 30 }).project.id;
    await expect(broll.mapView(app, project, {})).rejects.toThrow("give a place (an address or name) or lat and lon");
  } finally {
    cleanup();
  }
});

test("a finished map asked for again is the media it already is", async () => {
  const { app, cleanup } = fixtureHome("map-again");
  try {
    const id = app.store.create("map", { width: 1920, height: 1080, fps: 30 }).project.id;
    await app.store.update(id, "test", (project) => {
      // In a cloud project the map's path is its cloud copy; only its name is the file's.
      project.media.push({ id: "m7", name: "map-d5237a608b36.mp4", path: "/cache/cloud/proxies/sha256/53b4.mp4", kind: "video", duration: 8, width: 1920, height: 1080, fps: 30, has_audio: false });
    });
    expect(broll.existingMedia(app, id, "/home/media/p/maps/map-d5237a608b36.mp4")).toBe("m7");
    expect(broll.existingMedia(app, id, "/home/media/p/maps/map-5d85b0021f29.mp4")).toBeNull();
  } finally {
    cleanup();
  }
});

test("rustJson sorts keys at every depth", () => {
  expect(rustJson({ b: 1, a: [true, null, "x"], c: { z: 1, y: 2 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}');
});

async function withTranscript(app: App, dir: string): Promise<import("../src/model.ts").Media> {
  const media = { id: "m", name: "bodycam", path: `${dir}/bodycam.mp4`, kind: "video" as const, duration: 60, width: 1920, height: 1080, fps: 30, has_audio: true };
  write(
    app.media.paths(media.path).transcript,
    serialize({
      model: "scribe_v2",
      language: "eng",
      words: [
        { text: "Stop", start: 1.0, end: 1.3, speaker: "speaker_0" },
        { text: "right", start: 1.35, end: 1.6, speaker: "speaker_0" },
        { text: "there.", start: 1.65, end: 2.0, speaker: "speaker_0" },
        { text: "Okay.", start: 3.0, end: 3.3, speaker: "speaker_1" },
        { text: "Later.", start: 9.0, end: 9.4 },
      ],
      speakers: { speaker_0: "Officer" },
    }),
  );
  return media;
}

test("a media's words come as phrases by speaker, or word by word", async () => {
  const { app, cleanup, dir } = fixtureHome("media-transcript");
  try {
    const media = await withTranscript(app, dir);
    expect(await broll.mediaTranscript(app, media, 0, Number.MAX_VALUE, false)).toBe(
      "[1.00–2.00s] (Officer) Stop right there.\n[3.00–3.30s] (speaker_1) Okay.\n[9.00–9.40s] Later.\n",
    );
    expect(await broll.mediaTranscript(app, media, 1.2, 3, true)).toBe("1.35–1.60 right\n1.65–2.00 there.");
    expect(await broll.mediaTranscript(app, media, 20, 30, false)).toBe("nothing is said in bodycam between 20.0s and 30.0s");
    await expect(broll.mediaTranscript(app, { ...media, has_audio: false }, 0, 1, false)).rejects.toThrow("bodycam has no sound");
  } finally {
    cleanup();
  }
});

test.skipIf(ffmpeg === null || ffprobe === null)("a slowed clip is smoothed into new footage at 1x, once", async () => {
  const { app, cleanup, dir } = fixtureHome("smooth");
  try {
    const source = `${dir}/clip.mp4`;
    makeFile(["-f", "lavfi", "-i", "testsrc=size=160x90:rate=30:duration=2", "-pix_fmt", "yuv420p"], source);
    const live = app.store.create("p", { width: 320, height: 180, fps: 30 });
    const project = structuredClone(live.project) as Project;
    project.media = [{ id: "m1", name: "clip.mp4", path: source, kind: "video", duration: 2, width: 160, height: 90, fps: 30, has_audio: false }];
    const clip: VideoClip = {
      id: "c1",
      track: project.tracks[0]!.id,
      start: 0,
      duration: 30,
      color: "blue",
      fade_in: 0,
      fade_out: 0,
      type: "video",
      media: "m1",
      source_in: 0.5,
      speed: 0.5,
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
      opacity: 1,
    };
    project.clips = [clip];
    await app.store.replace(project.id, null, project, "test");
    await expect(broll.smoothSlowMotion(app, project.id, "nope")).rejects.toThrow("no clip nope");
    const done = (await broll.smoothSlowMotion(app, project.id, "c1")) as { clip: string; media: string; seconds: number };
    expect(done).toEqual({ clip: "c1", media: done.media, seconds: 1 });
    const saved = app.store.get(project.id)!.project;
    const smoothed = saved.clips[0] as VideoClip;
    expect(smoothed.speed).toBe(1);
    expect(smoothed.source_in).toBe(0);
    const made = saved.media.find((item) => item.id === smoothed.media)!;
    expect(made.name).toMatch(/^clip-0\.50x-[0-9a-f]{12}\.mp4$/);
    expect(fs.existsSync(made.path)).toBe(true);
    await expect(broll.smoothSlowMotion(app, project.id, "c1")).rejects.toThrow("c1 plays at 1×; slow it first (speed below 1, e.g. 0.5)");
  } finally {
    cleanup();
  }
});

test.skipIf(ffmpeg === null)("a still becomes 30 s of footage, made once", async () => {
  const { cleanup, dir } = fixtureHome("still");
  try {
    const image = `${dir}/photo.png`;
    makeFile(["-f", "lavfi", "-i", "color=c=green:s=64x48", "-frames:v", "1"], image);
    const out = await broll.stillVideo(image, `${dir}/stills`);
    expect(out).toMatch(/\/stills\/photo-[0-9a-f]{12}\.mp4$/);
    const again = await broll.stillVideo(image, `${dir}/stills`);
    expect(again).toBe(out);
    await expect(broll.stillVideo(`${dir}/none.png`, `${dir}/stills`)).rejects.toThrow(`${dir}/none.png: No such file or directory (os error 2)`);
  } finally {
    cleanup();
  }
});
