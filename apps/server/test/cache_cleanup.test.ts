import { expect, test } from "bun:test";
import * as fs from "node:fs";

import { cleanCache } from "../src/cache_cleanup.ts";
import { fixtureHome } from "./helpers/home.ts";

test("the cache loses rebuildable files of media nobody uses and old half-written ones, never paid analysis or what's in use", async () => {
  const { dir, app, store, cleanup } = fixtureHome("cache-clean");
  try {
    const cache = store.cacheDir();
    const footage = `${dir}/used.mp4`;
    fs.writeFileSync(footage, "x");
    const live = store.create("p", { width: 1920, height: 1080, fps: 30 });
    const project = structuredClone(live.project);
    project.media = [{ id: "m1", name: "used.mp4", path: footage, kind: "video", duration: 1, width: 2, height: 2, fps: 30, has_audio: false }];
    await store.replace(project.id, null, project, "test");
    const usedKey = app.native.mediaKey(footage);
    const old = Date.now() - 3 * 24 * 3600 * 1000;
    const put = (path: string, bytes: number, at = old) => {
      fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      fs.writeFileSync(path, Buffer.alloc(bytes));
      fs.utimesSync(path, at / 1000, at / 1000);
    };
    // Used: everything stays but an old half-written file.
    put(`${cache}/${usedKey}/preview.mp4`, 10);
    put(`${cache}/${usedKey}/preview.partial.mp4.sb-a0dac0bf-H5wfgu`, 20);
    // Nobody's: the previews go, the transcript and watch answers stay.
    const gone = "0123456789abcdef";
    put(`${cache}/${gone}/preview.mp4`, 30);
    put(`${cache}/${gone}/preview-light.mp4`, 40);
    put(`${cache}/${gone}/thumbs.jpg`, 5);
    put(`${cache}/${gone}/transcript.json`, 7);
    put(`${cache}/${gone}/watch/abc.json`, 3);
    // Nobody's but touched just now: stays.
    put(`${cache}/fedcba9876543210/preview.mp4`, 50, Date.now());
    const dry = cleanCache(app, true);
    expect(dry.bytes).toBe(20 + 30 + 40 + 5);
    expect(fs.existsSync(`${cache}/${gone}/preview.mp4`)).toBe(true);
    const done = cleanCache(app, false);
    expect(done.bytes).toBe(95);
    expect(fs.existsSync(`${cache}/${usedKey}/preview.mp4`)).toBe(true);
    expect(fs.existsSync(`${cache}/${usedKey}/preview.partial.mp4.sb-a0dac0bf-H5wfgu`)).toBe(false);
    expect(fs.existsSync(`${cache}/${gone}/preview.mp4`)).toBe(false);
    expect(fs.existsSync(`${cache}/${gone}/transcript.json`)).toBe(true);
    expect(fs.existsSync(`${cache}/${gone}/watch/abc.json`)).toBe(true);
    expect(fs.existsSync(`${cache}/fedcba9876543210/preview.mp4`)).toBe(true);
  } finally {
    cleanup();
  }
});
