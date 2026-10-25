import { expect, test } from "bun:test";
import * as fs from "node:fs";

import { cleanCache, cleanCloudPreviews } from "../src/cache_cleanup.ts";
import { playbackPath } from "../src/cloud_playback.ts";
import * as cloudMedia from "../src/cloud_media.ts";
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
    // An export's leftover chunks go after a few days; its manifest and fresh ones stay.
    put(`${cache}/export-chunks/p/0123.mp4`, 11);
    put(`${cache}/export-chunks/p/4567.mp4`, 13, Date.now());
    put(`${cache}/export-chunks/p/manifest-v1.json`, 2);
    const dry = cleanCache(app, true);
    expect(dry.bytes).toBe(20 + 30 + 40 + 5 + 11);
    expect(fs.existsSync(`${cache}/${gone}/preview.mp4`)).toBe(true);
    const done = cleanCache(app, false);
    expect(fs.existsSync(`${cache}/export-chunks/p/0123.mp4`)).toBe(false);
    expect(fs.existsSync(`${cache}/export-chunks/p/4567.mp4`)).toBe(true);
    expect(fs.existsSync(`${cache}/export-chunks/p/manifest-v1.json`)).toBe(true);
    expect(done.bytes).toBe(106);
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

test("a Drive download goes days after its last export, never one a project uses or a file of the user's", async () => {
  const { dir, app, store, cleanup } = fixtureHome("cache-drive");
  try {
    const cache = store.cacheDir();
    const live = store.create("p", { width: 1920, height: 1080, fps: 30 });
    const uploads = store.uploadsDir(live.project.id);
    const make = (path: string) => {
      fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      fs.writeFileSync(path, "video");
      return path;
    };
    const old = make(`${uploads}/drive/1yg-M2MtATPMklbr1buzd0mgR9sNzsgOZ/Old.mp4`);
    const fresh = make(`${uploads}/drive/1v-D25jVesJWbr72fktxOvccIIeX11aHz/Fresh.mp4`);
    const theirs = make(`${dir}/Movies/drive/1abcdefghijk/Mine.mp4`);
    const inUse = make(`${uploads}/drive/1zzzzzzzzzzzz/Used.mp4`);
    const project = structuredClone(live.project);
    project.media = [{ id: "m1", name: "Used.mp4", path: inUse, kind: "video", duration: 1, width: 2, height: 2, fps: 30, has_audio: false }];
    await store.replace(project.id, null, project, "test");
    for (const [key, path] of [["a", old], ["b", fresh], ["c", theirs], ["d", inUse]] as const) {
      cloudMedia.rememberLocalOriginal(cache, `edit/originals/sha256/${key}/x.mp4`, path);
    }
    // Four days pass for all but the fresh one, which an export just read.
    const later = Date.now() + 4 * 24 * 3600 * 1000;
    const known = cloudMedia.readLocalOriginals(cache);
    known["edit/originals/sha256/b/x.mp4"]!.used_ms = later;
    cloudMedia.writeLocalOriginals(cache, known);
    cleanCache(app, false, later);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(theirs)).toBe(true);
    expect(fs.existsSync(inUse)).toBe(true);
    expect(Object.keys(cloudMedia.readLocalOriginals(cache)).sort()).toEqual(["edit/originals/sha256/b/x.mp4", "edit/originals/sha256/c/x.mp4", "edit/originals/sha256/d/x.mp4"]);
  } finally {
    cleanup();
  }
});

test("past the cache's limit or with the disk nearly full, the previews of the projects saved longest ago go, never a recent one's or paid analysis", async () => {
  const { dir, app, store, cleanup } = fixtureHome("cache-limit");
  try {
    const cache = store.cacheDir();
    const day = 24 * 3600 * 1000;
    const projects = store.home + "/projects";
    // Three projects, saved 9, 5 and 0 days ago, each with its own footage.
    const keys: string[] = [];
    for (const [name, daysAgo] of [["oldest", 9], ["older", 5], ["recent", 0]] as const) {
      const footage = `${dir}/${name}.mp4`;
      fs.writeFileSync(footage, name);
      const live = store.create(name, { width: 1920, height: 1080, fps: 30 });
      const project = structuredClone(live.project);
      project.media = [{ id: "m1", name: `${name}.mp4`, path: footage, kind: "video", duration: 1, width: 2, height: 2, fps: 30, has_audio: false }];
      await store.replace(project.id, null, project, "test");
      const at = (Date.now() - daysAgo * day) / 1000;
      fs.utimesSync(`${projects}/${project.id}.json`, at, at);
      const key = app.native.mediaKey(footage);
      keys.push(key);
      fs.mkdirSync(`${cache}/${key}`, { recursive: true });
      fs.writeFileSync(`${cache}/${key}/preview.mp4`, Buffer.alloc(1000));
      fs.writeFileSync(`${cache}/${key}/preview.done`, "");
      // Made when the project was (a preview made just now is never trimmed).
      for (const made of ["preview.mp4", "preview.done"]) fs.utimesSync(`${cache}/${key}/${made}`, at, at);
      fs.writeFileSync(`${cache}/${key}/transcript.json`, Buffer.alloc(10));
    }
    const [oldest, older, recent] = keys as [string, string, string];
    // Under both limits: nothing goes.
    expect(cleanCache(app, false, Date.now(), { cacheBytes: 1e9, freeBytes: 0, free: 1e12 }).files).toBe(0);
    // A little over the limit: only the oldest project's previews.
    const dry = cleanCache(app, true, Date.now(), { cacheBytes: 2500, freeBytes: 0, free: 1e12 });
    expect(dry.bytes).toBe(1000);
    expect(fs.existsSync(`${cache}/${oldest}/preview.mp4`)).toBe(true);
    cleanCache(app, false, Date.now(), { cacheBytes: 2500, freeBytes: 0, free: 1e12 });
    expect(fs.existsSync(`${cache}/${oldest}/preview.mp4`)).toBe(false);
    expect(fs.existsSync(`${cache}/${oldest}/preview.done`)).toBe(false);
    expect(fs.existsSync(`${cache}/${oldest}/transcript.json`)).toBe(true);
    expect(fs.existsSync(`${cache}/${older}/preview.mp4`)).toBe(true);
    // The disk nearly full: the older one's go too, never the recent one's.
    cleanCache(app, false, Date.now(), { cacheBytes: 1e9, freeBytes: 1e9, free: 0 });
    expect(fs.existsSync(`${cache}/${older}/preview.mp4`)).toBe(false);
    expect(fs.existsSync(`${cache}/${recent}/preview.mp4`)).toBe(true);
  } finally {
    cleanup();
  }
});

test("with a project's footage missing (a drive unplugged), no media folder is taken for unused; a hard-linked preview counts once", async () => {
  const { dir, app, store, cleanup } = fixtureHome("cache-unplugged");
  try {
    const cache = store.cacheDir();
    const live = store.create("Case", { width: 1920, height: 1080, fps: 30 });
    const project = structuredClone(live.project);
    project.media = [{ id: "m1", name: "a.mp4", path: "/Volumes/LaCie/gone/a.mp4", kind: "video", duration: 1, width: 2, height: 2, fps: 30, has_audio: false }];
    await store.replace(project.id, null, project, "test");
    // Some folder no project's key names: with a file missing, it may be that one's.
    const stray = `${cache}/0123456789abcdef`;
    fs.mkdirSync(stray, { recursive: true });
    fs.writeFileSync(`${stray}/preview.mp4`, Buffer.alloc(500));
    fs.linkSync(`${stray}/preview.mp4`, `${stray}/proxy.mp4`);
    const old = (Date.now() - 30 * 24 * 3600 * 1000) / 1000;
    fs.utimesSync(`${stray}/preview.mp4`, old, old);
    expect(cleanCache(app, true).files).toBe(0);
    expect(fs.existsSync(`${stray}/preview.mp4`)).toBe(true);
    // The footage back: now it's plainly unused, and its 500 bytes are counted once.
    project.media = [];
    await store.replace(project.id, null, project, "test");
    const report = cleanCache(app, true);
    expect(report.bytes).toBe(500);
    void dir;
  } finally {
    cleanup();
  }
});

test("cloud-cache proxies past the budget go oldest first, recent ones stay", () => {
  const { app, store, cleanup } = fixtureHome("cache-cloud");
  try {
    const cache = store.cacheDir();
    const old = (Date.now() - 5 * 24 * 3600 * 1000) / 1000;
    const put = (path: string, bytes: number, at?: number) => {
      fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      fs.writeFileSync(path, Buffer.alloc(bytes));
      if (at !== undefined) fs.utimesSync(path, at, at);
    };
    put(`${cache}/cloud/proxies/drive/old.mp4`, 1000, old);
    put(`${cache}/cloud/proxies/drive/new.mp4`, 1000);
    const dry = cleanCache(app, true, Date.now(), { cacheBytes: 1500, freeBytes: 0, free: 1e12 });
    expect(dry.bytes).toBe(1000);
    expect(fs.existsSync(`${cache}/cloud/proxies/drive/old.mp4`)).toBe(true);
    cleanCache(app, false, Date.now(), { cacheBytes: 1500, freeBytes: 0, free: 1e12 });
    expect(fs.existsSync(`${cache}/cloud/proxies/drive/old.mp4`)).toBe(false);
    expect(fs.existsSync(`${cache}/cloud/proxies/drive/new.mp4`)).toBe(true);
  } finally { cleanup(); }
});

test("cloud-only cleanup verifies R2, removes fresh previews and legacy aliases, and keeps paid analysis and pending uploads", async () => {
  const { app, store, cleanup } = fixtureHome("cache-streamed");
  try {
    const cache = store.cacheDir();
    const key = "edit/proxies/sha256/abc.mp4";
    const local = cloudMedia.localPath(cache, key);
    fs.mkdirSync(local.slice(0, local.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(local, "video");
    const alias = app.native.mediaKey(local);
    const legacy = "0123456789abcdef";
    const put = (name: string, bytes: string) => {
      fs.mkdirSync(name.slice(0, name.lastIndexOf("/")), { recursive: true });
      fs.writeFileSync(name, bytes);
    };
    put(`${cache}/${alias}/preview.mp4`, "preview");
    put(`${cache}/${alias}/transcript.json`, '{"words":[]}');
    put(`${cache}/${alias}/watch/keys.json`, JSON.stringify({ keys: [legacy] }));
    put(`${cache}/${legacy}/preview-light.mp4`, "light");
    put(`${cache}/${legacy}/watch/answer.json`, "paid answer");
    const id = store.create("cloud", { width: 1920, height: 1080, fps: 30 }).project.id;
    await store.update(id, "test", (project) => {
      project.media.push({ id: "m1", name: "clip", path: local, kind: "video", duration: 1, fps: 30, width: 2, height: 2, has_audio: false,
        cloud: { source: "sha256:abc", original: "edit/originals/sha256/abc/a.mov", proxy: key, size: 10 } });
    });
    const head = async () => ({ size: 5 });
    expect((await cleanCloudPreviews(app, true, head)).files).toBe(3);
    expect(fs.existsSync(local)).toBe(true);
    // A missing cloud copy, or an unreachable cloud, is not permission to delete.
    expect((await cleanCloudPreviews(app, false, async () => null)).files).toBe(0);
    expect((await cleanCloudPreviews(app, false, async () => { throw new Error("offline"); })).files).toBe(0);
    // The persisted upload still needs its scratch file, even if R2 has an older object.
    fs.writeFileSync(`${store.home}/jobs.json`, JSON.stringify([{ kind: "upload", args: { local } }]));
    expect((await cleanCloudPreviews(app, false, head)).files).toBe(2);
    expect(fs.existsSync(local)).toBe(true);
    expect(fs.existsSync(`${cache}/${legacy}/watch/answer.json`)).toBe(true);
    expect(fs.existsSync(`${cache}/${alias}/transcript.json`)).toBe(true);
    const target = app.media.paths(playbackPath(key, app.port)).transcript;
    expect(fs.readFileSync(target, "utf8")).toBe('{"words":[]}');
    fs.writeFileSync(`${store.home}/jobs.json`, "[]");
    // A size mismatch never removes the proxy itself.
    expect((await cleanCloudPreviews(app, false, async () => ({ size: 6 }))).files).toBe(0);
    expect((await cleanCloudPreviews(app, false, head)).files).toBe(1);
    expect(fs.existsSync(local)).toBe(false);
  } finally { cleanup(); }
});

test("a missing cloud proxy does not block orphan cleanup, but a missing local-only file still protects its previews", async () => {
  const { app, store, cleanup } = fixtureHome("cache-cloud-missing");
  try {
    const id = store.create("cloud", { width: 2, height: 2, fps: 30 }).project.id;
    await store.update(id, "test", (project) => {
      project.media.push({ id: "m1", name: "cloud", path: "/not/here.mp4", kind: "video", duration: 1, fps: 30, width: 2, height: 2, has_audio: false,
        cloud: { source: "sha256:abc", original: "edit/originals/sha256/abc/a.mov", proxy: "edit/proxies/sha256/abc.mp4", size: 1 } });
    });
    const path = `${store.cacheDir()}/0123456789abcdef/preview.mp4`;
    fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(path, "video");
    const old = (Date.now() - 5 * 86400_000) / 1000;
    fs.utimesSync(path, old, old);
    expect(cleanCache(app, true).files).toBe(1);
    await store.update(id, "test", (project) => { delete project.media[0]!.cloud; });
    expect(cleanCache(app, true).files).toBe(0);
  } finally { cleanup(); }
});

test("explicit legacy migration removes completed orphan previews, never paid data, referenced media or incomplete work", async () => {
  const { app, store, cleanup } = fixtureHome("cache-legacy");
  try {
    const cache = store.cacheDir();
    const orphan = `${cache}/0123456789abcdef`;
    const working = `${cache}/fedcba9876543210`;
    for (const dir of [orphan, working]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${orphan}/preview.done`, "");
    fs.writeFileSync(`${orphan}/preview.mp4`, "video");
    fs.writeFileSync(`${orphan}/preview-light.mp4`, "light");
    fs.writeFileSync(`${orphan}/preview.m4a`, "sound");
    fs.writeFileSync(`${orphan}/transcript.json`, "paid");
    fs.writeFileSync(`${working}/preview.mp4`, "incomplete");
    const id = store.create("local", { width: 2, height: 2, fps: 30 }).project.id;
    await store.update(id, "test", (project) => {
      project.media.push({ id: "m1", name: "source", path: `${orphan}/preview.mp4`, kind: "video", duration: 1, fps: 30, width: 2, height: 2, has_audio: false });
    });
    const head = async () => { throw new Error("an orphan needs no cloud request"); };
    expect((await cleanCloudPreviews(app, true, head)).files).toBe(0);
    expect((await cleanCloudPreviews(app, true, head, true)).files).toBe(3);
    expect(fs.existsSync(`${orphan}/preview-light.mp4`)).toBe(true);
    await cleanCloudPreviews(app, false, head, true);
    expect(fs.existsSync(`${orphan}/preview.mp4`)).toBe(true);
    expect(fs.existsSync(`${orphan}/transcript.json`)).toBe(true);
    expect(fs.existsSync(`${orphan}/preview-light.mp4`)).toBe(false);
    expect(fs.existsSync(`${working}/preview.mp4`)).toBe(true);
  } finally { cleanup(); }
});
