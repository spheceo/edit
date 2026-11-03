import { expect, test } from "bun:test";

import { pictureHash } from "../src/playback_render.ts";
import { project, stubNative } from "./helpers/model.ts";

test("smooth playback stays for changes nothing on screen shows, and goes for one it does", () => {
  stubNative();
  const p = project("smooth");
  const before = pictureHash(p);
  // The script's notes and words change nothing seen or heard.
  expect(pictureHash({ ...p, script: { source: "doc", blocks: [{ kind: "narration", text: "Then she left." }] } } as typeof p)).toBe(before);
  expect(pictureHash({ ...p, settings: { ...p.settings, fps: 25 } })).not.toBe(before);
});

test("an agent's turn over, its edit is made smooth by itself, here; a turn started again meanwhile waits for that one", async () => {
  // The user, Oct 31: "too many loading frame issues… the biggest issue"; a finished edit was only rendered once someone watched it.
  const { fixtureHome } = await import("./helpers/home.ts");
  const playback = await import("../src/playback_render.ts");
  const { app, store, cleanup } = fixtureHome("playback-after-turn");
  const trials = process.env.EDIT_TRIALS;
  delete process.env.EDIT_TRIALS;
  try {
    // Nothing exporting here (the fixture's exports are a stub).
    Object.assign(app.exports, { localRunning: () => false, running: () => false });
    playback.hooks.afterTurnMs = 30;
    const id = store.create("smooth", { width: 1920, height: 1080, fps: 30 }).project.id;
    playback.start(app);
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    // A turn ends, and another starts before the wait is over: nothing yet.
    store.emit({ type: "agent", project: id, event: "status", running: true } as never);
    store.emit({ type: "agent", project: id, event: "status", running: false } as never);
    store.emit({ type: "agent", project: id, event: "status", running: true } as never);
    await wait(80);
    expect(playback.status(app, id).state).toBe("none");
    // That one ends and stays over: asked for.
    store.emit({ type: "agent", project: id, event: "status", running: false } as never);
    await wait(80);
    expect(playback.status(app, id).state).not.toBe("none");
  } finally {
    if (trials !== undefined) process.env.EDIT_TRIALS = trials;
    cleanup();
  }
});

test("while a changed edit renders, the old render is never offered as it", async () => {
  // JJ, Nov 2: "I've made changes to the window screen rather than the paper, but on the screen, it still shows the paper thing."
  const fs = await import("node:fs");
  const { fixtureHome } = await import("./helpers/home.ts");
  const playback = await import("../src/playback_render.ts");
  const { app, store, cleanup } = fixtureHome("playback-stale");
  playback.hooks.waitMs = 10;
  try {
    Object.assign(app.exports, { localRunning: () => false, running: () => false });
    const id = store.create("stale", { width: 1920, height: 1080, fps: 30 }).project.id;
    const live = store.get(id)!;
    const mp4 = playback.file(app, id);
    fs.mkdirSync(mp4.replace(/\/[^/]+$/u, ""), { recursive: true });
    fs.writeFileSync(mp4, "old picture");
    fs.writeFileSync(mp4.replace(/\.mp4$/u, ".json"), JSON.stringify({ rev: live.rev, hash: playback.pictureHash(live.project), stamp: "old" }));
    expect(playback.status(app, id)).toMatchObject({ state: "ready", rev: live.rev });
    expect(playback.status(app, id).url).not.toBeNull();
    // The picture changes; its render waits (here, for ever).
    await store.update(id, "test", (p) => {
      p.settings.fps = 25;
    });
    // Its render waits behind an export.
    Object.assign(app.exports, { localRunning: () => true, running: () => true });
    const asked = playback.request(app, id);
    expect(asked.rev).toBe(store.get(id)!.rev);
    expect(asked.url).toBeNull();
    for (let tries = 0; playback.status(app, id).state !== "waiting" && tries < 200; tries++) await Bun.sleep(5);
    expect(playback.status(app, id)).toMatchObject({ state: "waiting", url: null });
    // The export over: it goes on (and ends, the stub having no renderer) before this test's app goes.
    Object.assign(app.exports, { localRunning: () => false, running: () => false });
    for (let tries = 0; ["waiting", "rendering"].includes(playback.status(app, id).state) && tries < 400; tries++) await Bun.sleep(5);
  } finally {
    playback.hooks.waitMs = 10_000;
    cleanup();
  }
});

test("a render of the same picture any Mac put in R2 is played at once; one not there is made here", async () => {
  // Sphe, Nov 2: "open up the project on a new Mac … instantly start playing it".
  const { fixtureHome } = await import("./helpers/home.ts");
  const playback = await import("../src/playback_render.ts");
  const { spyOn } = await import("bun:test");
  const { app, store, native, cleanup } = fixtureHome("playback-shared");
  const { inCloud } = playback.hooks;
  const looked: string[] = [];
  try {
    Object.assign(app.exports, { localRunning: () => false, running: () => false });
    const id = store.create("shared", { width: 1920, height: 1080, fps: 30 }).project.id;
    const hash = playback.pictureHash(store.get(id)!.project);
    playback.hooks.inCloud = async (key) => {
      looked.push(key);
      return true;
    };
    const rendered = spyOn(native.ExportJob, "start");
    playback.request(app, id);
    for (let tries = 0; playback.status(app, id).state !== "ready" && tries < 200; tries++) await Bun.sleep(5);
    expect(looked).toEqual([playback.cloudKey(id, hash)]);
    expect(playback.status(app, id).state).toBe("ready");
    expect(rendered).not.toHaveBeenCalled();
    rendered.mockRestore();

    // Another picture, none in R2: made here.
    await store.update(id, "test", (p) => {
      p.settings.fps = 25;
    });
    playback.hooks.inCloud = async () => false;
    const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 1920, height: 1080, audio: true }, fps: 25 } as never);
    const here = spyOn(native.ExportJob, "start").mockImplementation((job) => {
      (require("node:fs") as typeof import("node:fs")).writeFileSync(job.output, "picture");
      return { cancel: () => {}, wait: async () => ({ seconds: 1, bytes: 7 }) };
    });
    playback.request(app, id);
    const rev = store.get(id)!.rev;
    for (let tries = 0; !(playback.status(app, id).state === "ready" && playback.status(app, id).rev === rev) && tries < 200; tries++) await Bun.sleep(5);
    expect(here).toHaveBeenCalled();
    expect(playback.status(app, id)).toMatchObject({ state: "ready", rev });
    plan.mockRestore();
    here.mockRestore();
  } finally {
    playback.hooks.inCloud = inCloud;
    cleanup();
  }
});
