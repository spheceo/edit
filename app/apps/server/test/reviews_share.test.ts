// A share is one job with steps (export → review copy → copy check → upload →
// publish), each written before the next starts, so a share a restart cut short
// carries on from its last finished step without doing one twice (the Nov 8
// audit, item B: a restart mid-share after its export resumed nothing, and the
// Share dialog said "Up on the link" on the export's end, before the copy, the
// upload and the publish).

import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as nodePath from "node:path";

import * as cloud from "../src/cloud.ts";
import * as jobs from "../src/jobs.ts";
import * as remote from "../src/remote_actions.ts";
import * as reviews from "../src/reviews.ts";
import * as tools from "../src/tools.ts";
import { fixtureHome } from "./helpers/home.ts";

const spies: { mockRestore(): void }[] = [];
afterEach(async () => {
  await Bun.sleep(20);
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/** The cloud as a share sees it: R2 by key, Repack's versions (with their meta), every call kept. */
function fakeCloud(refuse: () => boolean = () => false) {
  const r2 = new Map<string, number>();
  const versions: { n: number; meta: Record<string, unknown> }[] = [];
  const calls: string[] = [];
  spies.push(
    spyOn(cloud, "enabled").mockReturnValue(true),
    spyOn(cloud, "uploadFile").mockImplementation(async (from: string, key: string) => {
      calls.push(`upload ${key.split("/").pop()}`);
      r2.set(key, fs.statSync(from).size);
    }),
    spyOn(cloud, "head").mockImplementation(async (key: string) => (r2.has(key) ? { size: r2.get(key)!, etag: null, contentType: null } : null)),
    spyOn(cloud, "query").mockImplementation(async (name: string) => {
      calls.push(name);
      return (name === "reviews:get" ? { reviewId: "r1", url: "https://review.test/r1", versions } : null) as never;
    }),
    spyOn(cloud, "mutation").mockImplementation(async (name: string, args: unknown) => {
      if (name === "reviews:setMeta") return null as never;
      calls.push(name);
      if (name === "reviews:publish") {
        if (refuse()) throw new Error("Repack didn't answer");
        const n = versions.length + 1;
        versions.push({ n, meta: (args as { meta: Record<string, unknown> }).meta });
        return { reviewId: "r1", url: "https://review.test/r1", version: n } as never;
      }
      return null as never;
    }),
  );
  // The steps' own calls: the copy, the poster, the publish (describe's JSON beside the video and the full-quality file behind aren't steps).
  const steps = () => calls.filter((one) => ["upload video.mp4", "upload poster.jpg", "reviews:publish", "reviews:compress"].includes(one));
  return { r2, versions, calls, steps };
}

const ffmpeg = (...args: string[]) => tools.run([tools.ffmpeg(), "-v", "error", "-nostdin", "-y", ...args]);

/** A project with a whole export on record (6 s, picture and sound), and where its review copy goes. */
async function exported(name: string) {
  const fixture = fixtureHome(name);
  const { app, home, dir } = fixture;
  const id = app.store.createAs("Cops Realize", "bodycam", { width: 160, height: 120, fps: 30 }).project.id;
  const path = nodePath.join(dir, "Cops Realize.mp4");
  await ffmpeg("-f", "lavfi", "-i", "testsrc=size=160x120:rate=30", "-f", "lavfi", "-i", "sine=r=48000", "-t", "6", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", path);
  const record = { path, name: "Cops Realize.mp4", finished_ms: Date.now(), seconds: 1, bytes: fs.statSync(path).size, frames: 180, whole: true, start: 0, format: "h264", timeline: "t1" };
  fs.writeFileSync(nodePath.join(home, "exports.json"), JSON.stringify({ [id]: [record] }));
  const work = nodePath.join(home, "cache", "reviews", id);
  // Nothing else running on this Mac.
  (app as unknown as { exports: unknown }).exports = { running: () => false, runningFor: () => null, cancel: () => false };
  (app as unknown as { agents: unknown }).agents = { hasRunningTurns: () => false, chat: () => ({ running: false }) };
  return { ...fixture, id, path, copy: nodePath.join(work, "t1.mp4"), poster: nodePath.join(work, "t1.jpg"), work };
}

/** The share's job as a restart left it: after `step`, with what the steps before it made. */
function cutShort(home: string, id: string, step: string, args: Record<string, unknown>, attempts = 0): void {
  const now = Date.now();
  fs.writeFileSync(nodePath.join(home, "jobs.json"), JSON.stringify([{ key: `share:${id}`, kind: "share", project: id, args: { id: "s1", path: null, ...args }, state: "running", step, attempts, started_ms: now - 60_000, updated_ms: now }]));
}

/** Carries the listed share on, as serve.ts's resumer does after a restart, and waits for it to end. */
async function carryOn(app: Parameters<typeof reviews.resumeShareJob>[0], home: string, id: string): Promise<void> {
  await jobs.resume(home, { share: (job) => reviews.resumeShareJob(app, job) }, ["share"]);
  for (let tries = 0; tries < 400 && jobs.live(jobs.get(home, `share:${id}`)!); tries++) await Bun.sleep(10);
}

test("a share runs its steps in order, says each where the dialog reads it, and is up on the link only once published", async () => {
  const { app, home, id, cleanup } = await exported("share-steps");
  const { calls, versions, steps: made } = fakeCloud();
  const steps: string[] = [];
  const step = jobs.step;
  spies.push(spyOn(jobs, "step").mockImplementation((...given: Parameters<typeof jobs.step>) => {
    steps.push(given[2]);
    step(...given);
  }));
  try {
    const shared = reviews.share(app, id, null);
    // Listed at once, and what the dialog reads says it's going, not up.
    expect(reviews.shareNow(home, id).share?.state).toBe("running");
    expect(reviews.shareNow(home, id).line).not.toBeNull();
    expect(remote.busyWith(app)).toContain("a share");
    expect(await shared).toEqual({ url: "https://review.test/r1", version: 1 });
    expect(steps.filter((one, at) => one !== steps[at - 1])).toEqual(["review copy", "copy check", "uploading", "publishing"]);
    expect(made()).toEqual(["upload video.mp4", "upload poster.jpg", "reviews:publish"]);
    // Its version is named by this share, so a publish carried on after a restart is never made twice.
    expect(typeof versions[0]!.meta.share).toBe("string");
    expect(reviews.shareNow(home, id)).toEqual({ line: null, share: expect.objectContaining({ state: "done", version: 1, url: "https://review.test/r1" }) });
    // Done in the same write that listed its full-quality upload, which goes on behind, after the publish.
    expect(calls.indexOf("upload full.mp4")).toBeGreaterThan(calls.indexOf("reviews:publish"));
    expect(remote.busyWith(app)).not.toContain("a share");
  } finally {
    cleanup();
  }
});

test("cut short after the review copy was made and checked: carried on from the upload, the copy not made again", async () => {
  const { app, home, id, path, copy, poster, work, cleanup } = await exported("share-after-copy");
  const { steps } = fakeCloud();
  try {
    fs.mkdirSync(work, { recursive: true });
    fs.copyFileSync(path, copy);
    fs.writeFileSync(poster, "jpg");
    const made = fs.statSync(copy).mtimeMs;
    cutShort(home, id, "uploading", { checked: true });
    // A restart cut it short: listed and going, so an update waits for it.
    expect(remote.busyWith(app)).toContain("a share");
    await carryOn(app, home, id);
    expect(steps()).toEqual(["upload video.mp4", "upload poster.jpg", "reviews:publish"]);
    expect(fs.existsSync(copy) ? fs.statSync(copy).mtimeMs : made).toBe(made);
    expect(reviews.shareNow(home, id).share).toMatchObject({ state: "done", version: 1 });
  } finally {
    cleanup();
  }
});

test("cut short mid-upload with the copy already up on R2: it isn't sent again", async () => {
  const { app, home, id, path, copy, poster, work, cleanup } = await exported("share-mid-upload");
  const { r2, steps } = fakeCloud();
  try {
    fs.mkdirSync(work, { recursive: true });
    fs.copyFileSync(path, copy);
    fs.writeFileSync(poster, "jpg");
    r2.set(`edit/reviews/${id}/t1/video.mp4`, fs.statSync(copy).size);
    cutShort(home, id, "uploading", { checked: true });
    await carryOn(app, home, id);
    expect(steps()).toEqual(["upload poster.jpg", "reviews:publish"]);
  } finally {
    cleanup();
  }
});

test("cut short after the upload: carried on from the publish, nothing sent again", async () => {
  const { app, home, id, path, copy, poster, work, cleanup } = await exported("share-after-upload");
  const { steps } = fakeCloud();
  try {
    fs.mkdirSync(work, { recursive: true });
    fs.copyFileSync(path, copy);
    fs.writeFileSync(poster, "jpg");
    cutShort(home, id, "publishing", { checked: true, uploaded: true });
    await carryOn(app, home, id);
    expect(steps()).toEqual(["reviews:publish"]);
    expect(reviews.read(home).shared[id]?.versions.map((one) => one.n)).toEqual([1]);
  } finally {
    cleanup();
  }
});

test("cut short between Repack taking the version and this Mac noting it: the version is found by the share's id, never published twice", async () => {
  const { app, home, id, path, copy, poster, work, cleanup } = await exported("share-after-publish");
  const { calls, versions } = fakeCloud();
  try {
    fs.mkdirSync(work, { recursive: true });
    fs.copyFileSync(path, copy);
    fs.writeFileSync(poster, "jpg");
    versions.push({ n: 1, meta: { share: "s1" } });
    cutShort(home, id, "publishing", { checked: true, uploaded: true });
    await carryOn(app, home, id);
    expect(calls).not.toContain("reviews:publish");
    expect(reviews.read(home).shared[id]).toMatchObject({ reviewId: "r1", url: "https://review.test/r1", versions: [expect.objectContaining({ n: 1 })] });
    expect(reviews.shareNow(home, id).share).toMatchObject({ state: "done", version: 1 });
  } finally {
    cleanup();
  }
});

test("cut short as its export finished (the export listed, the share not told): that export is shared, not exported again", async () => {
  const { app, home, id, store, cleanup } = await exported("share-after-export");
  const { calls } = fakeCloud();
  let exports = 0;
  (app as unknown as { exports: unknown }).exports = { running: () => false, runningFor: () => null, cancel: () => false, start: async () => void exports++ };
  try {
    const project = store.get(id)!.project;
    const snapshot = nodePath.join(home, "jobs", `share-${id}.json`);
    fs.mkdirSync(nodePath.dirname(snapshot), { recursive: true });
    fs.writeFileSync(snapshot, JSON.stringify(project));
    // The export on record is of this edit, finished after the share began.
    const records = JSON.parse(fs.readFileSync(nodePath.join(home, "exports.json"), "utf8")) as Record<string, Record<string, unknown>[]>;
    records[id]![0]!.timeline = (await import("../src/exports.ts")).timelineHash(project);
    fs.writeFileSync(nodePath.join(home, "exports.json"), JSON.stringify(records));
    const now = Date.now();
    fs.writeFileSync(nodePath.join(home, "jobs.json"), JSON.stringify([{ key: `share:${id}`, kind: "share", project: id, args: { id: "s1", export: { options: {} }, snapshot }, state: "running", step: "exporting", attempts: 0, started_ms: now - 60_000, updated_ms: now }]));
    await carryOn(app, home, id);
    expect(exports).toBe(0);
    expect(calls).toContain("reviews:publish");
    expect(reviews.shareNow(home, id).share).toMatchObject({ state: "done" });
    // Its kept edit goes once it's shared.
    expect(fs.existsSync(snapshot)).toBe(false);
  } finally {
    cleanup();
  }
});

test("a share that fails is kept failed with why, where the dialog reads it; Retry carries it on from that step", async () => {
  const { app, home, id, path, copy, poster, work, cleanup } = await exported("share-fails");
  let refuse = true;
  const { steps } = fakeCloud(() => refuse);
  try {
    fs.mkdirSync(work, { recursive: true });
    fs.copyFileSync(path, copy);
    fs.writeFileSync(poster, "jpg");
    cutShort(home, id, "publishing", { checked: true, uploaded: true });
    await carryOn(app, home, id);
    expect(reviews.shareNow(home, id)).toEqual({ line: null, share: expect.objectContaining({ state: "failed", error: "Repack didn't answer" }) });
    expect(remote.busyWith(app)).not.toContain("a share");
    refuse = false;
    expect(await reviews.retryShare(app, id)).toEqual({ url: "https://review.test/r1", version: 1 });
    // The copy and poster aren't sent again: only the publish, which failed, then went.
    expect(steps()).toEqual(["reviews:publish", "reviews:publish"]);
    expect(reviews.shareNow(home, id).share).toMatchObject({ state: "done" });
  } finally {
    cleanup();
  }
});

test("a share cancelled before a restart carried it on is crossed off, not left blocking the next", async () => {
  const { app, home, id, cleanup } = await exported("share-cancel-listed");
  fakeCloud();
  try {
    cutShort(home, id, "uploading", { checked: true });
    expect(reviews.cancelShare(app, id)).toBe(true);
    expect(jobs.get(home, `share:${id}`)).toBeUndefined();
    expect(remote.busyWith(app)).not.toContain("a share");
  } finally {
    cleanup();
  }
});
