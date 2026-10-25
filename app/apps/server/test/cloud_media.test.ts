import { afterAll, beforeAll, expect, test } from "bun:test";

import * as fs from "node:fs";

import * as cloud from "../src/cloud.ts";
import * as cloudMedia from "../src/cloud_media.ts";
import { playbackKey, playbackPath } from "../src/cloud_playback.ts";
import { buildRouter } from "../src/routes.ts";
import { respond } from "../src/http/server.ts";
import { testCloud } from "../src/cloud_projects.ts";
import { mediaKey, sharedSourceOf } from "../src/media.ts";
import type { Media, Probe, Project } from "../src/model.ts";
import { useNative, wrap } from "../src/native/index.ts";
import { createStub } from "../src/native/stub.ts";
import { newProject } from "../src/project.ts";
import { cacheKey, watchWindow } from "../src/watch.ts";
import { fixtureHome, type Fixture } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token", EDIT_CLOUD_HOLDER: undefined });
  cloud.timing.sleep = async () => {};
});

afterAll(() => {
  restore();
  mock.stop();
});

const SETTINGS = { width: 1920, height: 1080, fps: 30 };
const VIDEO: Probe = { kind: "video", duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true };
const SOUND: Probe = { kind: "audio", duration: 3, width: 0, height: 0, fps: 0, has_audio: true };

test("overlapping commentary import batches share one excerpt download and cloud publication", async () => {
  const fixture = fixtureHome("youtube-shared-range");
  const previous = process.env.EDIT_YTDLP;
  try {
    const raw = createStub();
    raw.probe = async () => VIDEO;
    let encoded = 0;
    raw.makeCloudProxy = async (source: string, _probe: Probe, out: string) => { encoded++; fs.copyFileSync(source, out); };
    useNative(wrap(raw));
    cloudMedia.configurePlayback(fixture.app);
    const binary = `${fixture.dir}/yt-dlp`;
    fs.writeFileSync(binary, `#!/bin/sh
echo call >> '${fixture.dir}/calls'
for arg in "$@"; do if [ "$prev" = '-P' ]; then out="$arg"; fi; prev="$arg"; done
sleep 0.1
printf 'video' > "$out/scene.mp4"
echo "EDIT-FILE $out/scene.mp4"
`, { mode: 0o755 });
    process.env.EDIT_YTDLP = binary;
    const request = () => cloudMedia.youtubeExcerpts(fixture.home, fixture.store.cacheDir(), "youtube:rangeTEST01", [[10, 20]]);
    const [a, b] = await Promise.all([request(), request()]);
    expect(a).toEqual(b);
    expect(a[0]?.cloud?.cloud?.source).toBe("youtube:rangeTEST01#0-30000");
    expect(fs.readFileSync(`${fixture.dir}/calls`, "utf8").trim().split("\n")).toHaveLength(1);
    expect(encoded).toBe(1);
    expect(fs.readdirSync(cloudMedia.scratchDir(fixture.store.cacheDir()))).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.EDIT_YTDLP; else process.env.EDIT_YTDLP = previous;
    fixture.cleanup();
  }
});

/** A fixture whose addon "makes" a cloud proxy by copying the file (the stub has no encoder). */
function home(name: string): Fixture & { proxies: string[] } {
  const fixture = fixtureHome(name);
  const raw = createStub();
  raw.init({ home: fixture.home, cacheDir: `${fixture.home}/cache`, ffmpeg: "ffmpeg", ffprobe: "ffprobe", mediaFolders: [], log: () => {} });
  const proxies: string[] = [];
  raw.makeCloudProxy = async (source: string, _probe: Probe, out: string) => {
    proxies.push(source);
    fs.copyFileSync(source, out);
  };
  useNative(wrap(raw));
  cloudMedia.configurePlayback(fixture.app);
  return { ...fixture, proxies };
}

function media(id: string, path: string, extra: Partial<Media> = {}): Media {
  return { id, name: `${id}.mp4`, path, kind: "video", duration: 5, width: 1920, height: 1080, fps: 30, has_audio: true, ...extra };
}

function projectWith(items: Media[]): Project {
  const project = newProject("p", "p", SETTINGS);
  project.media.push(...items);
  return project;
}

test("a browser upload's copy is removed only once its upload went up, after a restart too", async () => {
  const fixture = home("cloud-upload-fails");
  const { dir, store, cleanup } = fixture;
  try {
    const video = `${dir}/upload.mov`;
    fs.writeFileSync(video, "only copy of the original");
    mock.cloud.failPuts = 1000;
    await cloudMedia.importLocal(store.cacheDir(), video, VIDEO, "upload.mov");
    cloudMedia.removeWhenUploaded(video);
    expect(await cloudMedia.uploaded(video)).toBe(false);
    // Kept: it's the only copy, and the retry needs it.
    expect(fs.readFileSync(video, "utf8")).toBe("only copy of the original");
    const noted = (JSON.parse(fs.readFileSync(`${fixture.home}/jobs.json`, "utf8")) as { kind: string; args: Record<string, unknown> }[]).filter(
      (job) => job.kind === "upload",
    );
    expect(noted.length).toBe(1);
    expect(noted[0]!.args.removeAfter).toBe(true);
    // Edit starts again with the network back: the retry goes up and then removes it.
    mock.cloud.failPuts = 0;
    cloudMedia.resumeUpload(fixture.home, noted[0]!.args);
    expect(await cloudMedia.uploaded(video)).toBe(true);
    expect(fs.existsSync(video)).toBe(false);
  } finally {
    mock.cloud.failPuts = 0;
    cleanup();
  }
});

test("analysis_sits_beside_the_source", () => {
  expect(cloudMedia.analysisPrefix("sha256:abc")).toBe("edit/analysis/sha256/abc/");
  expect(cloudMedia.analysisPrefix("drive:F1#100-2000")).toBe("edit/analysis/drive/F1/100-2000/");
  expect(cloudMedia.isAnalysis("transcript.json") && cloudMedia.isAnalysis("watch/7bc98.json")).toBe(true);
  expect(!cloudMedia.isAnalysis("preview.mp4") && !cloudMedia.isAnalysis("watch/../x.json")).toBe(true);
  expect(cloudMedia.isAnalysis("watch/.hidden.json")).toBe(false);
});

test("stranded_media_are_named", async () => {
  const project = projectWith([media("m1", "/nowhere/map-x.mp4", { name: "map-x.mp4" })]);
  expect(cloudMedia.stranded(project)).toEqual(["map-x.mp4"]);
  // No cloud media in it: an ordinary project, left to the export.
  await expect(cloudMedia.forExport(project, 0, 150, "/tmp")).resolves.toBeDefined();
});

test("sources_name_their_proxies", () => {
  expect(cloudMedia.proxyKey("drive:abc_D-1")).toBe("edit/proxies/drive/abc_D-1.mp4");
  expect(cloudMedia.proxyKey(cloudMedia.excerptSource("abc", 61.4994, 182.0))).toBe("edit/proxies/drive/abc/61499-182000.mp4");
  expect(cloudMedia.proxyKey("sha256:00ff")).toBe("edit/proxies/sha256/00ff.mp4");
  expect(cloudMedia.proxyKey("youtube:x")).toBeNull();
  expect(cloudMedia.proxyKey("youtube:MeT7tyZqfiw")).toBe("edit/proxies/youtube/MeT7tyZqfiw.mp4");
  expect(cloudMedia.proxyKey(cloudMedia.excerptSource("youtube:MeT7tyZqfiw", 42, 172.5))).toBe("edit/proxies/youtube/MeT7tyZqfiw/42000-172500.mp4");
  expect(cloudMedia.analysisPrefix("youtube:MeT7tyZqfiw#42000-172500")).toBe("edit/analysis/youtube/MeT7tyZqfiw/42000-172500/");
  expect(cloudMedia.proxyKey("drive:../x")).toBeNull();
});

test("proxies_get_bits_for_their_size", () => {
  const { native, cleanup } = fixtureHome("cloud-bits");
  try {
    expect(native.cloudProxyBitrate(1920, 1080)).toBe(4_000_000);
    expect(native.cloudProxyBitrate(1080, 1920)).toBe(4_000_000);
    expect(native.cloudProxyBitrate(3840, 2160)).toBe(4_000_000);
    expect(native.cloudProxyBitrate(1280, 720)).toBe(1_777_777);
    expect(native.cloudProxyBitrate(640, 360)).toBe(800_000);
  } finally {
    cleanup();
  }
});

test("local_copies_live_in_the_cache", () => {
  const cache = "/home/a/.edit/cache";
  const local = cloudMedia.localPath(cache, "edit/proxies/drive/abc/1-2.mp4");
  expect(local).toBe("/home/a/.edit/cache/cloud/proxies/drive/abc/1-2.mp4");
  expect(cloudMedia.isLocalCopy(cache, local)).toBe(true);
  expect(cloudMedia.isLocalCopy(cache, "/home/a/.edit/media/x.mp4")).toBe(false);
});

test("names_fit_keys", () => {
  expect(cloudMedia.segment("a/b\\c.mov")).toBe("a_b_c.mov");
  expect(cloudMedia.segment(".hidden.mp4")).toBe("hidden.mp4");
  const cut = cloudMedia.segment(`${"x".repeat(300)}.mov`);
  expect(cut.endsWith(".mov") && [...cut].length <= 120).toBe(true);
  expect(cloud.validKey(`edit/originals/sha256/ab/${cloudMedia.segment("../../x")}`)).toBe(true);
  expect(cloudMedia.extensionOf("Clip.MOV")).toBe("mov");
  expect(cloudMedia.extensionOf("weird.m?v")).toBe("mp4");
  expect(cloudMedia.extensionOf("none")).toBe("mp4");
  expect(cloudMedia.driveIdOk("1AbC-d_e") && !cloudMedia.driveIdOk("a/b") && !cloudMedia.driveIdOk("")).toBe(true);
});

test("urls_never_show", () => {
  const text = "Server returned 403 for https://acct.r2.cloudflarestorage.com/b/edit/x.mp4?X-Amz-Signature=abc: Forbidden";
  expect(cloudMedia.scrub(text)).toBe("Server returned 403 for <url> Forbidden");
  expect(cloudMedia.scrub(text).includes("Signature")).toBe(false);
  expect(cloudMedia.scrub("'http://a/b' and https://c")).toBe("'<url>' and <url>");
  expect(cloudMedia.scrub("nothing here")).toBe("nothing here");
});

test("records_read_convex_values", () => {
  const record = cloudMedia.readRecord({
    _id: "x",
    source: "sha256:ab",
    name: "a.mov",
    originalKey: "edit/originals/sha256/ab/a.mov",
    originalReady: true,
    proxyKey: null,
    proxyReady: false,
    size: 1234.0,
    duration: null,
    createdAt: 1,
    updatedAt: 2,
  });
  expect(cloudMedia.readyOriginal(record)).toBe("edit/originals/sha256/ab/a.mov");
  expect(cloudMedia.readyProxy(record)).toBeNull();
  expect(Math.trunc(record.size)).toBe(1234);
});

test("exports_fetch_only_what_the_span_uses", async () => {
  const project: Project = {
    ...newProject("p", "p", SETTINGS),
    media: [],
    clips: [
      { id: "c1", track: "v1", start: 0, duration: 30, type: "video", media: "m1" },
      { id: "c2", track: "a1", start: 30, duration: 30, type: "audio", media: "m2" },
      { id: "c3", track: "v1", start: 60, duration: 30, type: "video", media: "m1" },
    ] as Project["clips"],
  };
  expect(cloudMedia.usedMedia(project, 0, 90)).toEqual(["m1", "m2"]);
  expect(cloudMedia.usedMedia(project, 30, 60)).toEqual(["m2"]);
  project.clips = [];
  expect(cloudMedia.usedMedia(project, 0, 90)).toEqual([]);
  // Nothing in the cloud: the project as it is, no cloud needed.
  const [same] = await cloudMedia.forExport(project, 0, 90, "/nonexistent");
  expect(same).toEqual(project);
});

// ---------------------------------------------------------------------------
// Against the mock relay (R2 and the registry in memory).

test("files from a disk: a sound goes up as itself, footage with a proxy made once, and the footage's analysis comes along", async () => {
  const fixture = home("cloud-import");
  const { dir, store, app, proxies, cleanup } = fixture;
  try {
    const cache = store.cacheDir();
    const sound = `${dir}/take.wav`;
    fs.writeFileSync(sound, "RIFF-a-sound");
    const madeSound = await cloudMedia.importLocal(cache, sound, SOUND, "take.wav");
    expect(madeSound.path).toBe(playbackPath(madeSound.cloud!.original, app.port));
    expect(fs.existsSync(sound)).toBe(true);
    expect(madeSound.cloud!.proxy).toBe(madeSound.cloud!.original);
    expect(mock.cloud.text(madeSound.cloud!.original)).toBe("RIFF-a-sound");
    expect(mock.cloud.contentTypes.get(madeSound.cloud!.original)).toBe("audio/wav");
    const soundRecord = await cloudMedia.getRecord(madeSound.cloud!.source);
    expect(soundRecord).toMatchObject({ originalReady: true, proxyReady: true, name: "take.wav", size: 12 });

    // Footage someone already paid to analyse here (before cloud was on).
    const video = `${dir}/interview.mov`;
    fs.writeFileSync(video, "pretend footage");
    const before = `${cache}/${mediaKey(video)}`;
    fs.mkdirSync(`${before}/watch`, { recursive: true });
    fs.writeFileSync(`${before}/transcript.json`, '{"words":[]}');
    fs.writeFileSync(`${before}/faces-v1.json`, "{}");
    const window = { lines: [0, 1] as [number, number], start: 0, end: 12 };
    const lines = [{ start: 0, end: 1, text: "Hello there.", label: null, words: [0, 1] }];
    const answerName = `${cacheKey(mediaKey(video), window, lines)}.json`;
    fs.writeFileSync(`${before}/watch/${answerName}`, JSON.stringify({ model: "m", start: 0, end: 12, cost: 0.01, answer: { people: [], lines: [], segments: [] } }));

    const made = await cloudMedia.importLocal(cache, video, VIDEO, "interview.mov");
    const hex = made.cloud!.source.slice("sha256:".length);
    expect(made.path).toBe(playbackPath(`edit/proxies/sha256/${hex}.mp4`, app.port));
    expect(made.cloud).toEqual({ source: `sha256:${hex}`, original: `edit/originals/sha256/${hex}/interview.mov`, proxy: `edit/proxies/sha256/${hex}.mp4`, size: 15 });
    // The import answered with the proxy made; the uploads go on behind it, noted so a restart carries on.
    const noted = () => (JSON.parse(fs.readFileSync(`${fixture.home}/jobs.json`, "utf8")) as { kind: string }[]).filter((job) => job.kind === "upload");
    expect(noted().length).toBe(1);
    await cloudMedia.uploaded(video);
    expect(fs.existsSync(cloudMedia.localPath(cache, made.cloud!.proxy!))).toBe(false);
    expect(noted()).toEqual([]);
    expect(mock.cloud.objects.has(made.cloud!.original) && mock.cloud.objects.has(made.cloud!.proxy!)).toBe(true);
    expect(await cloudMedia.getRecord(made.cloud!.source)).toMatchObject({ originalReady: true, proxyReady: true });
    expect(fs.readFileSync(video, "utf8")).toBe("pretend footage");
    // Carried to the proxy's cache folder, where everything now looks.
    const after = `${cache}/${mediaKey(made.path)}`;
    expect(fs.readFileSync(`${after}/transcript.json`, "utf8")).toBe('{"words":[]}');
    expect(fs.existsSync(`${after}/faces-v1.json`)).toBe(true);
    expect(JSON.parse(fs.readFileSync(`${after}/watch/keys.json`, "utf8"))).toEqual({ keys: [mediaKey(video)] });
    expect(app.media.status(made.path).transcript).toBe("ready");
    // The watcher finds its answer under the old key: nothing is asked again.
    const asked = mock.calls("/v1/chat/completions").length;
    const [, cost, cached] = await watchWindow(made.path, `${after}/watch`, "t", window, lines, {}, false);
    expect([cost, cached]).toEqual([0, true]);
    expect(mock.calls("/v1/chat/completions").length).toBe(asked);

    // Again (another project): nothing made or uploaded again.
    const puts = mock.calls(/^\/r2\//, "PUT").length;
    const again = await cloudMedia.importLocal(cache, video, VIDEO, "interview.mov");
    expect(again.path).toBe(made.path);
    expect(proxies).toEqual([video]);
    expect(mock.calls(/^\/r2\//, "PUT").length).toBe(puts);

    // In a cloud project, its analysis goes up beside the source, the watcher's keys with it.
    const id = store.create("disk", SETTINGS).project.id;
    testCloud(fixture.home, [[id, null]]).attach(store);
    await store.update(id, "test", (project) => {
      project.media.push({ ...media("m1", made.path), cloud: made.cloud! });
    });
    expect(await cloudMedia.shareAnalysis(app, id)).toBe(4);
    const prefix = `edit/analysis/sha256/${hex}/`;
    expect(mock.cloud.text(`${prefix}transcript.json`)).toBe('{"words":[]}');
    expect(mock.cloud.objects.has(`${prefix}watch/${answerName}`)).toBe(true);
    expect(JSON.parse(mock.cloud.text(`${prefix}watch/keys.json`)!)).toEqual({ keys: [mediaKey(video), mediaKey(made.path)] });
    // Each version goes once.
    expect(await cloudMedia.shareAnalysis(app, id)).toBe(0);
  } finally {
    cleanup();
  }
});

test("opening cloud media streams proxies without downloads, including read-only projects, and fetches shared analysis", async () => {
  const fixture = home("cloud-ensure");
  const { store, app, cleanup } = fixture;
  try {
    const cache = store.cacheDir();
    mock.cloud.put("edit/proxies/sha256/beef.mp4", "a proxy");
    mock.cloud.put("edit/analysis/sha256/beef/transcript.json", '{"from":"kenobi"}');
    const cloudMediaOf = (hex: string) => ({ source: `sha256:${hex}`, original: `edit/originals/sha256/${hex}/clip.mov`, proxy: `edit/proxies/sha256/${hex}.mp4`, size: 7 });
    const ids: string[] = [];
    for (const name of ["mine", "theirs"]) {
      const id = store.create(name, SETTINGS).project.id;
      await store.update(id, "test", (project) => {
        project.media.push({ ...media("m1", "/Users/someone-else/.edit/cache/cloud/x.mp4"), cloud: cloudMediaOf("beef") });
      });
      ids.push(id);
    }
    const projects = testCloud(fixture.home, [
      [ids[0]!, null],
      [ids[1]!, "kenobi"],
    ]);
    projects.attach(store);
    // Someone else's is refused as an edit…
    await expect(store.update(ids[1]!, "test", () => {})).rejects.toThrow("kenobi is editing");
    for (const id of ids) {
      await cloudMedia.ensureLocal(app, id);
      const path = store.get(id)!.project.media[0]!.path;
      expect(playbackKey(path)).toBe("edit/proxies/sha256/beef.mp4");
      expect(fs.existsSync(cloudMedia.localPath(cache, "edit/proxies/sha256/beef.mp4"))).toBe(false);
    }
    // …and the analysis kenobi shared came too.
    const local = store.get(ids[0]!)!.project.media[0]!.path;
    expect(fs.readFileSync(`${cache}/${mediaKey(local)}/transcript.json`, "utf8")).toBe('{"from":"kenobi"}');
    // Nothing to do the second time.
    const rev = store.get(ids[0]!)!.rev;
    await cloudMedia.ensureLocal(app, ids[0]!);
    expect(store.get(ids[0]!)!.rev).toBe(rev);

    // A file only another machine has, and one still uploading.
    await store.update(ids[0]!, "test", (project) => {
      project.media.push(media("m2", "/nowhere/map-x.mp4", { name: "map-x.mp4" }));
      project.media.push({ ...media("m3", "/nowhere/up.mov", { name: "up.mov" }), cloud: { source: "sha256:dead", original: "edit/originals/sha256/dead/up.mov", size: 1 } });
    });
    await expect(cloudMedia.ensureLocal(app, ids[0]!)).rejects.toThrow(
      "some of the project's files couldn't be fetched: still uploading from another machine: up.mov; 1 file isn't on this machine and not in the cloud (map-x.mp4): open the project on the machine that made it so it uploads",
    );
    expect(projects.status(ids[0]!).missing).toBe(
      "1 file isn't on this machine and not in the cloud (map-x.mp4): open the project on the machine that made it so it uploads",
    );
  } finally {
    cleanup();
  }
});

test("cloud playback ignores obsolete local previews and repeated ranges never download proxies", async () => {
  const fixture = home("cloud-playback");
  const { store, app, cleanup } = fixture;
  try {
    const key = "edit/proxies/sha256/range-test.mp4";
    mock.cloud.put(key, "the cloud video");
    const id = store.create("stream", SETTINGS).project.id;
    await store.update(id, "test", (project) => {
      project.media.push({ ...media("m1", "/elsewhere/a.mp4"), cloud: { source: "sha256:range-test", original: "edit/originals/sha256/range-test/a.mov", proxy: key, size: 15 } });
    });
    const source = store.get(id)!.project.media[0]!.path;
    const paths = app.media.paths(source);
    fs.mkdirSync(paths.proxy.slice(0, paths.proxy.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(paths.proxy, "obsolete local video");
    fs.writeFileSync(paths.proxyDone, "");
    const router = buildRouter();
    for (const kind of ["proxy", "audio", "light"]) {
      const response = (await respond(app, router, new Request(`http://localhost:7700/api/projects/${id}/media/m1/${kind}`, { headers: { host: "localhost:7700", range: "bytes=4-8" } }), null))!;
      expect(response.status).toBe(206);
      expect(await response.text()).toBe("cloud");
      expect(response.headers.get("content-range")).toBe("bytes 4-8/15");
    }
    const native = (await respond(app, router, new Request(playbackPath(key, app.port), { headers: { host: "127.0.0.1:7700", range: "bytes=10-14" } }), null))!;
    expect(native.status).toBe(206);
    expect(await native.text()).toBe("video");
    expect(fs.existsSync(cloudMedia.localPath(store.cacheDir(), key))).toBe(false);
    expect(app.media.status(source)).toMatchObject({ proxy: "ready", light: "skipped" });
    expect(mediaKey(playbackPath(key, 7700))).toBe(mediaKey(playbackPath(key, 8800)));
    const pulled = structuredClone(store.get(id)!.project);
    pulled.media[0]!.path = playbackPath(key, 9999);
    expect(store.putFromCloud(pulled, "cloud").project.media[0]!.path).toBe(source);
  } finally { cleanup(); }
});

test("exports read the originals through presigned URLs, share the proxy's waveform, and refuse a file only another machine has", async () => {
  const fixture = home("cloud-export");
  const { dir, store, cleanup } = fixture;
  try {
    const cache = store.cacheDir();
    const proxy = `${dir}/proxy.mp4`;
    fs.writeFileSync(proxy, "proxy");
    fs.mkdirSync(`${cache}/${mediaKey(proxy)}`, { recursive: true });
    fs.writeFileSync(`${cache}/${mediaKey(proxy)}/peaks.bin`, "levels");
    const sound = `${dir}/own.wav`;
    fs.writeFileSync(sound, "own");
    const project = projectWith([
      { ...media("m1", proxy), cloud: { source: "sha256:aa", original: "edit/originals/sha256/aa/clip.mov", proxy: "edit/proxies/sha256/aa.mp4", size: 5 } },
      { ...media("m2", sound, { kind: "audio" }), cloud: { source: "sha256:bb", original: "edit/originals/sha256/bb/own.wav", proxy: "edit/originals/sha256/bb/own.wav", size: 3 } },
    ]);
    project.clips.push(
      { id: "c1", track: "v1", start: 0, duration: 30, type: "video", media: "m1", source_in: 0, speed: 1 } as Project["clips"][number],
      { id: "c2", track: "a1", start: 0, duration: 30, type: "audio", media: "m2", source_in: 0, speed: 1 } as Project["clips"][number],
    );
    const [out, originals] = await cloudMedia.forExport(project, 0, 30, cache);
    const url = out.media[0]!.path;
    expect(url.startsWith(`${mock.url}/r2/edit/originals/sha256/aa/clip.mov?`)).toBe(true);
    expect(mock.calls("/v1/cloud/r2/url").at(-1)!.json()).toEqual({ key: "edit/originals/sha256/aa/clip.mov", method: "GET", expires: 21600 });
    // Its own file is here: used as it is.
    expect(out.media[1]!.path).toBe(sound);
    expect(project.media[0]!.path).toBe(proxy);
    const levels = `${cache}/${mediaKey(url)}/peaks.bin`;
    expect(fs.readFileSync(levels, "utf8")).toBe("levels");
    originals.release();
    expect(fs.existsSync(levels)).toBe(false);

    project.media.push(media("m3", "/nowhere/map-x.mp4", { name: "map-x.mp4" }));
    project.clips.push({ id: "c3", track: "v1", start: 30, duration: 30, type: "video", media: "m3", source_in: 0, speed: 1 } as Project["clips"][number]);
    await expect(cloudMedia.forExport(project, 0, 60, cache)).rejects.toThrow(
      "the edit uses files that aren't on this machine or in the cloud (map-x.mp4): open the project on the machine that made them so they upload, then export again",
    );
    const back = mock.useEnv({ EDIT_RELAY_TOKEN: undefined });
    try {
      await expect(cloudMedia.forExport(project, 0, 30, cache)).rejects.toThrow(
        "this edit's footage is in the cloud: exporting it needs the cloud: sign in to Edit",
      );
    } finally {
      back();
    }
  } finally {
    cleanup();
  }
});

test("the backfill puts what Edit made in the cloud, says what it did, and waits for a map still rendering", async () => {
  const fixture = home("cloud-backfill");
  const { dir, store, app, cleanup } = fixture;
  try {
    const shot = `${dir}/smooth.mp4`;
    fs.writeFileSync(shot, "a smoothed shot");
    const still = `${dir}/map-abc-first.jpg`;
    fs.writeFileSync(still, "first frame");
    const id = store.create("Case", SETTINGS).project.id;
    await store.update(id, "test", (project) => {
      project.media.push(media("m1", shot, { name: "smooth.mp4" }), media("m2", still, { name: "map.mp4", kind: "image" }));
    });
    await expect(cloudMedia.backfill(app, id)).rejects.toThrow("this isn't a cloud project (Move to cloud first)");
    testCloud(fixture.home, [[id, null]]).attach(store);
    const done = await cloudMedia.backfill(app, id);
    expect(done).toEqual({ analysis_shared: 0, failed: [], missing: [], skipped: ["map.mp4 (a map still rendering)"], uploaded: [{ media: "m1", name: "smooth.mp4" }] });
    const saved = store.get(id)!.project.media[0]!;
    // A short render is its own proxy.
    expect(playbackKey(saved.path)).toBe(saved.cloud!.original);
    expect(saved.cloud!.proxy).toBe(saved.cloud!.original);
    expect(mock.cloud.text(saved.cloud!.original)).toBe("a smoothed shot");
    // Nothing left to do.
    expect((await cloudMedia.backfill(app, id)).uploaded).toEqual([]);
    await expect(cloudMedia.backfill(app, "p0-0")).rejects.toThrow("no such project");
  } finally {
    cleanup();
  }
});

test("a Drive file streams to R2 with nothing on this disk, the registry remembers it, and a short download stores nothing", async () => {
  const fixture = home("cloud-drive");
  const { store, cleanup } = fixture;
  try {
    const bytes = new Uint8Array(200_000).map((_, n) => n % 251);
    mock.driveFile("DriveFile1", bytes, "Bodycam 1.mp4");
    const scratch = cloudMedia.scratchDir(store.cacheDir());
    const seen: [number, number | null, string][] = [];
    const original = await cloudMedia.driveOriginal("DriveFile1", scratch, (sent, total, name) => seen.push([sent, total, name]));
    expect(original).toEqual({ file: "DriveFile1", source: "drive:DriveFile1", key: "edit/originals/drive/DriveFile1/Bodycam 1.mp4", name: "Bodycam 1.mp4", size: 200_000 });
    expect(Buffer.from(mock.cloud.objects.get(original.key)!).equals(Buffer.from(bytes))).toBe(true);
    expect(seen[0]).toEqual([0, 200_000, "Bodycam 1.mp4"]);
    expect(seen.at(-1)).toEqual([200_000, 200_000, "Bodycam 1.mp4"]);
    expect(fs.readdirSync(scratch)).toEqual([]);
    expect(await cloudMedia.getRecord("drive:DriveFile1")).toMatchObject({ originalReady: true, size: 200_000 });
    // Again: the registry says it's there, nothing is downloaded.
    const downloads = mock.calls("/drive.usercontent.google.com/download").length;
    expect((await cloudMedia.driveOriginal("DriveFile1", scratch, () => {})).key).toBe(original.key);
    expect(mock.calls("/drive.usercontent.google.com/download").length).toBe(downloads);

    // Drive says 200,000 bytes and sends fewer: nothing is kept.
    mock.on("GET", "/drive.usercontent.google.com/download", (request) => {
      if (request.query.get("id") !== "Short2") return new Response("", { status: 404 });
      if (request.headers.get("range") !== null) {
        return new Response(bytes.slice(0, 1), { status: 206, headers: { "content-type": "video/mp4", "content-range": `bytes 0-0/${bytes.length}`, "content-disposition": 'attachment; filename="short.mp4"' } });
      }
      return new Response(bytes.slice(0, 50_000), { headers: { "content-type": "video/mp4" } });
    });
    await expect(cloudMedia.driveOriginal("Short2", scratch, () => {})).rejects.toThrow("The download ended early. Retry to start it again.");
    expect(mock.cloud.objects.has("edit/originals/drive/Short2/short.mp4")).toBe(false);
    await expect(cloudMedia.driveOriginal("a/b", scratch, () => {})).rejects.toThrow('"a/b" isn\'t a Drive file id');
  } finally {
    cleanup();
  }
});

test("an export reads a cloud original from the file it was imported from while that's unchanged", async () => {
  const fixture = home("cloud-local-original");
  const { dir, store, cleanup } = fixture;
  try {
    const cache = store.cacheDir();
    const proxy = `${dir}/proxy.mp4`;
    fs.writeFileSync(proxy, "proxy");
    const original = `${dir}/interview.mov`;
    fs.writeFileSync(original, "the original");
    const key = "edit/originals/sha256/cc/interview.mov";
    cloudMedia.rememberLocalOriginal(cache, key, original);
    const project = projectWith([{ ...media("m1", proxy), cloud: { source: "sha256:cc", original: key, proxy: "edit/proxies/sha256/cc.mp4", size: 12 } }]);
    project.clips.push({ id: "c1", track: "v1", start: 0, duration: 30, type: "video", media: "m1", source_in: 0, speed: 1 } as Project["clips"][number]);
    let [out] = await cloudMedia.forExport(project, 0, 30, cache);
    expect(out.media[0]!.path).toBe(original);
    // Changed since (or gone): read from the cloud again.
    fs.writeFileSync(original, "another file");
    [out] = await cloudMedia.forExport(project, 0, 30, cache);
    expect(out.media[0]!.path.startsWith(`${mock.url}/r2/${key}?`)).toBe(true);
    fs.rmSync(original);
    [out] = await cloudMedia.forExport(project, 0, 30, cache);
    expect(out.media[0]!.path.startsWith(`${mock.url}/r2/${key}?`)).toBe(true);
  } finally {
    cleanup();
  }
});

test("an export of cloud-only footage mixes from a copy of its sound: made once, shared, then fetched", async () => {
  const fixture = home("cloud-sound");
  const { dir, store, cleanup } = fixture;
  try {
    const cache = store.cacheDir();
    const footage = `${dir}/footage.mp4`;
    const made = Bun.spawnSync([
      "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=red:size=64x36:rate=30:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart", footage,
    ]);
    expect(made.exitCode).toBe(0);
    const original = "edit/originals/sha256/cc/footage.mp4";
    mock.cloud.put(original, fs.readFileSync(footage));
    const proxy = `${dir}/proxy.mp4`;
    fs.writeFileSync(proxy, "proxy");
    const project = projectWith([{ ...media("m1", proxy), cloud: { source: "sha256:cc", original, proxy: "edit/proxies/sha256/cc.mp4", size: 5 } }]);
    project.clips.push({ id: "c1", track: "v1", start: 0, duration: 30, type: "video", media: "m1", source_in: 0, speed: 1 } as Project["clips"][number]);
    const copyKey = cloudMedia.soundKey(original);
    expect(copyKey).toBe("edit/sound/originals/sha256/cc/footage.mp4.mov");
    const [, first] = await cloudMedia.forExport(project, 0, 30, cache);
    const local = first.sounds!.m1!;
    expect(local).toBe(cloudMedia.localPath(cache, copyKey));
    const streams = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", local]);
    expect(streams.stdout.toString().trim()).toBe("audio");
    // Shared for other machines, in the background.
    for (let wait = 0; wait < 100 && !mock.cloud.objects.has(copyKey); wait++) await Bun.sleep(20);
    expect(mock.cloud.objects.has(copyKey)).toBe(true);
    // Another machine (no local copy) fetches it rather than reading the original again.
    fs.rmSync(local);
    const reads = mock.calls(`/r2/${original}`).length;
    const [, again] = await cloudMedia.forExport(project, 0, 30, cache);
    expect(again.sounds!.m1).toBe(local);
    expect(fs.existsSync(local)).toBe(true);
    expect(mock.calls(`/r2/${original}`).length).toBe(reads);
  } finally {
    cleanup();
  }
});

test("a Drive file is copied in the cloud when the relay can, with its progress; a failed job falls back to this Mac", async () => {
  const fixture = home("cloud-drive-job");
  const { store, cleanup } = fixture;
  const sleep = cloudMedia.jobTiming.sleep;
  cloudMedia.jobTiming.sleep = async () => {};
  try {
    const bytes = new Uint8Array(150_000).map((_, n) => n % 239);
    mock.driveFile("DriveJob01", bytes, "Interview.mp4");
    let polls = 0;
    mock.on("POST", "/v1/cloud/jobs/drive", (request) => {
      const body = request.json() as { file: string; key: string };
      expect(body).toEqual({ file: "DriveJob01", key: "edit/originals/drive/DriveJob01/Interview.mp4" });
      return Response.json({ id: "drive-DriveJob01-abc", status: "queued", total: bytes.length });
    });
    mock.on("POST", "/v1/cloud/jobs/status", () => {
      polls += 1;
      if (polls === 1) return Response.json({ id: "drive-DriveJob01-abc", status: "running", bytes: 64_000 });
      // Done there: the object is in R2 and registered.
      mock.cloud.put("edit/originals/drive/DriveJob01/Interview.mp4", bytes);
      return Response.json({ id: "drive-DriveJob01-abc", status: "complete", bytes: bytes.length, output: { size: bytes.length } });
    });
    const scratch = cloudMedia.scratchDir(store.cacheDir());
    const seen: number[] = [];
    const downloads = mock.calls("/drive.usercontent.google.com/download").length;
    const original = await cloudMedia.driveOriginal("DriveJob01", scratch, (sent) => seen.push(sent));
    expect(original.size).toBe(150_000);
    expect(seen).toEqual([0, 64_000, 150_000]);
    // Only the probe's first byte came through this Mac.
    const through = mock.calls("/drive.usercontent.google.com/download").slice(downloads);
    expect(through.every((call) => call.headers.get("range") === "bytes=0-0")).toBe(true);
    expect(await cloudMedia.getRecord("drive:DriveJob01")).toMatchObject({ originalReady: true, size: 150_000 });

    // A job that fails: this Mac streams it.
    mock.driveFile("DriveJob02", bytes, "Second.mp4");
    mock.on("POST", "/v1/cloud/jobs/drive", () => Response.json({ id: "drive-DriveJob02-abc", status: "queued" }));
    mock.on("POST", "/v1/cloud/jobs/status", () => Response.json({ id: "drive-DriveJob02-abc", status: "errored", error: "Google said no" }));
    const second = await cloudMedia.driveOriginal("DriveJob02", scratch, () => {});
    expect(Buffer.from(mock.cloud.objects.get(second.key)!).equals(Buffer.from(bytes))).toBe(true);
  } finally {
    cloudMedia.jobTiming.sleep = sleep;
    cleanup();
  }
});

test("an excerpt takes its words from its recording's shared transcript instead of being heard again", async () => {
  // Writer heard the whole recording (youtube:OVITtAlFG6M) Edit's way and shared it beside the source.
  const whole = {
    model: "scribe_v2",
    language: "eng",
    words: [
      { text: "Before.", start: 9.0, end: 9.5, speaker: "speaker_0" },
      { text: "Your", start: 10.2, end: 10.4, speaker: "speaker_1" },
      { text: "honor.", start: 10.45, end: 10.9, speaker: "speaker_1" },
      { text: "After.", start: 20.5, end: 21.0, speaker: "speaker_0" },
    ],
    speakers: { speaker_0: "Judge", speaker_1: "Scott Williams (Sergeant)" },
    keyterms: ["Scott Williams"],
  };
  mock.cloud.put("edit/analysis/youtube/OVITtAlFG6M/transcript.json", JSON.stringify(whole));
  const dir = fs.mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/whole-`);
  const target = `${dir}/cache/transcript.json`;
  expect(await cloudMedia.wholeTranscript("youtube:OVITtAlFG6M#10000-20000", target, dir)).toBe(true);
  const made = JSON.parse(fs.readFileSync(target, "utf8"));
  expect(made.words.map((word: { text: string; start: number }) => [word.text, Math.round(word.start * 100) / 100])).toEqual([["Your", 0.2], ["honor.", 0.45]]);
  expect([made.speakers.speaker_1, made.keyterms]).toEqual(["Scott Williams (Sergeant)", ["Scott Williams"]]);
  // Already heard here, or nothing shared: left alone.
  expect(await cloudMedia.wholeTranscript("youtube:OVITtAlFG6M#10000-20000", target, dir)).toBe(false);
  // The whole recording takes them all.
  expect(await cloudMedia.wholeTranscript("youtube:OVITtAlFG6M", `${dir}/b.json`, dir)).toBe(true);
  expect(JSON.parse(fs.readFileSync(`${dir}/b.json`, "utf8")).words.length).toBe(4);
  expect(await cloudMedia.wholeTranscript("drive:1AbCdEfGhIjKlMnOpQrStUvWxYz0123#0-5000", `${dir}/c.json`, dir)).toBe(false);
  // Every transcription finds it: a cloud excerpt's proxy here names its source.
  expect(sharedSourceOf("/c", "/c/cloud/proxies/youtube/OVITtAlFG6M/10000-20000.mp4")).toBe("youtube:OVITtAlFG6M#10000-20000");
  expect(sharedSourceOf("/c", "/c/cloud/proxies/youtube/OVITtAlFG6M.mp4")).toBe("youtube:OVITtAlFG6M");
  expect(sharedSourceOf("/c", "/c/cloud/proxies/sha256/ab.mp4")).toBeNull();
  expect(sharedSourceOf("/c", "/elsewhere/a.mp4")).toBeNull();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("streamKey names the proxy for playback kinds and nothing else", async () => {
  const { streamKey } = await import("../src/cloud_media.ts");
  const media = { proxy: "edit/proxies/sha256/abc.mp4" };
  expect(streamKey(media, "proxy")).toBe("edit/proxies/sha256/abc.mp4");
  expect(streamKey(media, "audio")).toBe("edit/proxies/sha256/abc.mp4");
  expect(streamKey(media, "light")).toBe("edit/proxies/sha256/abc.mp4");
  expect(streamKey(media, "thumbs")).toBeNull();
  expect(streamKey(null, "proxy")).toBeNull();
  expect(streamKey({}, "proxy")).toBeNull();
  expect(streamKey({ proxy: "not-a-key" }, "proxy")).toBeNull();
});

test("the preview reads a medium not on this Mac through the server: ranges from R2, never a redirect, one signature for many reads", async () => {
  // The bucket has no CORS policy, so the page's read of a redirect failed (Oct 24, "Loading frame…").
  const key = "edit/proxies/sha256/stream-test.mp4";
  const bytes = new Uint8Array(200_000).map((_, index) => index % 251);
  mock.cloud.objects.set(key, bytes);
  const signedBefore = mock.calls("/v1/cloud/r2/url", "POST").length;
  const read = (range: string) => cloudMedia.streamFromCloud(new Request("http://127.0.0.1/x", { headers: { range } }), { proxy: key }, "audio");
  const first = (await read("bytes=1000-1999"))!;
  expect(first.status).toBe(206);
  expect(first.headers.get("location")).toBeNull();
  expect(first.headers.get("content-range")).toBe("bytes 1000-1999/200000");
  expect([...new Uint8Array(await first.arrayBuffer())]).toEqual([...bytes.subarray(1000, 2000)]);
  const second = (await read("bytes=150000-150099"))!;
  expect([...new Uint8Array(await second.arrayBuffer())]).toEqual([...bytes.subarray(150000, 150100)]);
  // Signed once: a block read is one round trip to R2, not the relay's as well.
  expect(mock.calls("/v1/cloud/r2/url", "POST").length - signedBefore).toBe(1);
  // Not a playback file, or no proxy in the cloud: nothing to stream.
  expect(await cloudMedia.streamFromCloud(new Request("http://127.0.0.1/x"), { proxy: key }, "thumbs")).toBeNull();
  expect(await cloudMedia.streamFromCloud(new Request("http://127.0.0.1/x"), null, "proxy")).toBeNull();
});
