// What Edit.app's native preview decodes each picture from (routes.ts `nativeSources`).

import { expect, test } from "bun:test";
import * as fs from "node:fs";

import { localPath } from "../src/cloud_media.ts";
import { PLAYBACK_ROUTE } from "../src/cloud_playback.ts";
import * as cloudMedia from "../src/cloud_media.ts";
import { hooks, nativeSources, reset } from "../src/native_preview.ts";
import * as player from "../src/player.ts";
import * as pieces from "../src/proxy_pieces.ts";
import { spyOn } from "bun:test";
import { fixtureHome } from "./helpers/home.ts";
import { clip, media } from "./helpers/model.ts";

test("the native preview reads a media's made preview, else its footage; a cloud one's copy here, else its footage here, else the loopback stream", async () => {
  const { dir, app, store, cleanup } = fixtureHome("native-sources");
  try {
    const id = store.create("p", { width: 1920, height: 1080, fps: 30 }).project.id;
    for (const name of ["made.mp4", "making.mp4", "still.png"]) fs.writeFileSync(`${dir}/${name}`, "x");
    await store.update(id, "test", (p) => {
      p.media.push(media({ id: "made", name: "made.mp4", path: `${dir}/made.mp4`, kind: "video", duration: 1, has_audio: true }));
      p.media.push(media({ id: "making", name: "making.mp4", path: `${dir}/making.mp4`, kind: "video", duration: 1, has_audio: true }));
      p.media.push(media({ id: "still", name: "still.png", path: `${dir}/still.png`, kind: "image", duration: 1 }));
      p.media.push(media({ id: "song", name: "song.mp3", path: `${dir}/song.mp3`, kind: "audio", duration: 1 }));
      p.media.push({ ...media({ id: "here", name: "here.mp4", path: "https://r2.example/a", kind: "video", duration: 1, has_audio: true }), cloud: { proxy: "edit/proxies/aa/here.mp4" } } as never);
      p.media.push({ ...media({ id: "there", name: "there.mp4", path: "https://r2.example/b", kind: "video", duration: 1, has_audio: true }), cloud: { proxy: "edit/proxies/bb/there.mp4" } } as never);
      p.media.push({ ...media({ id: "footage", name: "made.mp4", path: `${dir}/made.mp4`, kind: "video", duration: 1, has_audio: true }), cloud: { proxy: "edit/proxies/cc/footage.mp4" } } as never);
      p.media.push({ ...media({ id: "unshown", name: "unshown.mp4", path: "https://r2.example/c", kind: "video", duration: 1, has_audio: true }), cloud: { proxy: "edit/proxies/dd/unshown.mp4" } } as never);
      // Listed before "there" in the media, but played after it: fetched after it.
      p.media.unshift({ ...media({ id: "later", name: "later.mp4", path: "https://r2.example/d", kind: "video", duration: 1, has_audio: true }), cloud: { proxy: "edit/proxies/ee/later.mp4" } } as never);
      p.clips.push(clip({ id: "c0", type: "video", track: "v1", media: "later", start: 300, duration: 30, source_in: 0 }));
      p.clips.push(clip({ id: "c1", type: "video", track: "v1", media: "there", start: 0, duration: 30, source_in: 0 }));
    });
    // One preview made, the other on its way.
    const made = app.media.paths(`${dir}/made.mp4`);
    fs.mkdirSync(made.proxy.slice(0, made.proxy.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(made.proxy, "preview");
    fs.writeFileSync(made.proxyDone, "");
    // One cloud preview whole on this Mac.
    const here = localPath(store.cacheDir(), "edit/proxies/aa/here.mp4");
    fs.mkdirSync(here.slice(0, here.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(here, "copy");
    // A streamed one's whole preview comes down behind it.
    const fetched: string[] = [];
    const fetch = spyOn(cloudMedia, "fetchKey").mockImplementation(async (key) => { fetched.push(key); });
    fs.writeFileSync(made.audio, "sound");
    const answer = (await (await nativeSources(app, store.get(id)!.project)).json()) as { cache: string; sources: Record<string, string>; sounds: Record<string, string> };
    fetch.mockRestore();
    // Whole copies in playhead order: the footage the timeline plays first comes first; and the project is the window's now.
    expect(fetched).toEqual(["edit/proxies/bb/there.mp4", "edit/proxies/ee/later.mp4"]);
    expect(player.isNative(id)).toBe(true);
    // The sound the window mixes while it plays: a made preview's sound file, a cloud copy's own (the sound is in it), else the footage or the stream.
    expect(answer.sounds).toEqual({
      made: made.audio,
      making: `${dir}/making.mp4`,
      song: `${dir}/song.mp3`,
      here,
      there: `http://127.0.0.1:${app.port}${PLAYBACK_ROUTE}?key=${encodeURIComponent("edit/proxies/bb/there.mp4")}`,
      later: `http://127.0.0.1:${app.port}${PLAYBACK_ROUTE}?key=${encodeURIComponent("edit/proxies/ee/later.mp4")}`,
      footage: `${dir}/made.mp4`,
      unshown: `http://127.0.0.1:${app.port}${PLAYBACK_ROUTE}?key=${encodeURIComponent("edit/proxies/dd/unshown.mp4")}`,
    });
    expect(answer.cache).toBe(store.cacheDir());
    expect(answer.sources).toEqual({
      made: made.proxy,
      making: `${dir}/making.mp4`,
      still: `${dir}/still.png`,
      here,
      there: `http://127.0.0.1:${app.port}${PLAYBACK_ROUTE}?key=${encodeURIComponent("edit/proxies/bb/there.mp4")}`,
      later: `http://127.0.0.1:${app.port}${PLAYBACK_ROUTE}?key=${encodeURIComponent("edit/proxies/ee/later.mp4")}`,
      footage: `${dir}/made.mp4`,
      // In the project but on no clip: streamed if ever asked, never fetched.
      unshown: `http://127.0.0.1:${app.port}${PLAYBACK_ROUTE}?key=${encodeURIComponent("edit/proxies/dd/unshown.mp4")}`,
    });
  } finally {
    cleanup();
  }
});

test("footage that's its own proxy (an original of 256 MB or less) comes down whole too, so it isn't streamed for good", async () => {
  const { app, store, cleanup } = fixtureHome("native-sources-own");
  try {
    const id = store.create("p", { width: 1920, height: 1080, fps: 30 }).project.id;
    const own = "edit/originals/sha256/ab/map.mp4";
    await store.update(id, "test", (p) => {
      p.media.push({ ...media({ id: "map", name: "map.mp4", path: "https://r2.example/map", kind: "video", duration: 8 }), cloud: { proxy: own } } as never);
      p.clips.push(clip({ id: "c1", type: "video", track: "v1", media: "map", start: 0, duration: 30, source_in: 0 }));
    });
    const fetched: string[] = [];
    const fetch = spyOn(cloudMedia, "fetchKey").mockImplementation(async (key, local) => {
      fetched.push(key);
      fs.mkdirSync(local.slice(0, local.lastIndexOf("/")), { recursive: true });
      fs.writeFileSync(local, "copy");
    });
    const ask = async () => ((await (await nativeSources(app, store.get(id)!.project)).json()) as { sources: Record<string, string> }).sources;
    try {
      expect((await ask()).map).toBe(`http://127.0.0.1:${app.port}${PLAYBACK_ROUTE}?key=${encodeURIComponent(own)}`);
      await Bun.sleep(10);
      expect(fetched).toEqual([own]);
      expect((await ask()).map).toBe(localPath(store.cacheDir(), own));
    } finally {
      fetch.mockRestore();
    }
  } finally {
    cleanup();
  }
});

test("a pieced proxy's pieces here that the timeline plays are cut into files the window reads instead of the stream; the rest stream", async () => {
  const { app, store, cleanup } = fixtureHome("native-sources-pieces");
  reset();
  try {
    const id = store.create("p", { width: 1920, height: 1080, fps: 30 }).project.id;
    const key = pieces.proxyKeyOf("drive:longFile0001");
    const base = pieces.baseOf(key)!;
    const cache = store.cacheDir();
    // A two-hour file: 120 pieces; the second one here, which the clip plays, and the sixth, which nothing plays.
    const layout = { ...pieces.plan("drive:longFile0001", "edit/originals/drive/longFile0001/long.mp4", 7200, 30, 1920, 1080, true), head: 1, total: 1 };
    const write = (path: string, text: string) => {
      fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      fs.writeFileSync(path, text);
    };
    write(localPath(cache, `${base}/layout.json`), JSON.stringify(layout));
    write(localPath(cache, `${base}/video/1.m4s`), "piece");
    write(localPath(cache, `${base}/video/5.m4s`), "piece");
    await store.update(id, "test", (p) => {
      p.media.push({ ...media({ id: "long", name: "long.mp4", path: "https://r2.example/long", kind: "video", duration: 7200 }), cloud: { proxy: key } } as never);
      p.clips.push(clip({ id: "c1", type: "video", track: "v1", media: "long", start: 0, duration: 30, source_in: 65 }));
    });
    const url = `http://127.0.0.1:${app.port}${PLAYBACK_ROUTE}?key=${encodeURIComponent(key)}`;
    const cuts: [string, number, number, string][] = [];
    const cutting = spyOn(hooks, "cut").mockImplementation(async (from, start, end, out) => {
      cuts.push([from, start, end, out]);
      write(out, "cut");
    });
    const ask = async () => (await (await nativeSources(app, store.get(id)!.project)).json()) as { sources: Record<string, string>; excerpts: Record<string, unknown> };
    try {
      const first = await ask();
      expect(first.sources.long).toBe(url);
      expect(first.excerpts).toEqual({});
      await Bun.sleep(10);
      const file = localPath(cache, `${base}/native/1.mp4`);
      // Only what the timeline plays is cut: a cut piece is a second copy of its minute.
      expect(cuts).toEqual([[url, 60, 120, file]]);
      const second = await ask();
      expect(second.sources.long).toBe(url);
      expect(second.excerpts).toEqual({ long: [{ from: 60, to: 120, path: file }] });
    } finally {
      cutting.mockRestore();
    }
  } finally {
    reset();
    cleanup();
  }
});

// The real cut, where the test above stands in for it: nothing made the pieces' folder, so on a real Mac every cut
// failed ("Error opening output files: No such file or directory", JJ's Mac, Nov 10) while that test passed.
test.skipIf(Bun.which("ffmpeg") === null)("a piece is cut into a folder nothing has made yet, and lands whole", async () => {
  const { dir, cleanup } = fixtureHome("native-sources-cut");
  try {
    const footage = `${dir}/footage.mp4`;
    const made = Bun.spawnSync(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=d=4:s=160x90:r=30", "-g", "30", "-pix_fmt", "yuv420p", footage]);
    expect(made.exitCode).toBe(0);
    const out = `${dir}/pieces/youtube/abc/native/1.mp4`;
    await hooks.cut(footage, 1, 3, out);
    expect(fs.statSync(out).size).toBeGreaterThan(1000);
    expect(fs.readdirSync(`${dir}/pieces/youtube/abc/native`)).toEqual(["1.mp4"]);
    // One that fails leaves nothing the window would take for a piece.
    await expect(hooks.cut(`${dir}/missing.mp4`, 0, 1, `${dir}/pieces/youtube/abc/native/2.mp4`)).rejects.toThrow();
    expect(fs.readdirSync(`${dir}/pieces/youtube/abc/native`)).toEqual(["1.mp4"]);
  } finally {
    cleanup();
  }
});
