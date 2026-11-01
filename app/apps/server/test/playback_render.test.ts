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

test("an agent's turn over, its edit is made smooth on Modal by itself; a turn started again meanwhile waits for that one", async () => {
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
    playback.hooks.toCloud = async () => true;
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
