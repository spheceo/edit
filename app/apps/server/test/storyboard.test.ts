import { expect, test } from "bun:test";
import * as fs from "node:fs";

import { file } from "../src/playback_render.ts";
import { board } from "../src/storyboard.ts";
import { fixtureHome } from "./helpers/home.ts";

test("the progress bar's frames are cut from the smooth render's keyframes, a sheet of 100 at a time, once a render", async () => {
  // Sphe, Nov 12: "try to really work on the precision of the images that show up when we hover".
  const fixture = fixtureHome("storyboard");
  try {
    const id = fixture.store.create("bar", { width: 1280, height: 720, fps: 30 }).project.id;
    const render = file(fixture.app, id);
    fs.mkdirSync(render.slice(0, render.lastIndexOf("/")), { recursive: true });
    expect(Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=6", "-c:v", "libx264", "-g", "60", "-pix_fmt", "yuv420p", render]).exitCode).toBe(0);
    fs.writeFileSync(render.replace(/\.mp4$/u, ".json"), JSON.stringify({ rev: 1, hash: "h", stamp: "s1" }));
    // Another render's stamp: nothing to cut.
    expect(board(fixture.app, id, "older")).toBeNull();
    expect(board(fixture.app, id, "s1")).toBe("making");
    let made = board(fixture.app, id, "s1");
    for (let tries = 0; tries < 100 && made === "making"; tries++) {
      await Bun.sleep(100);
      made = board(fixture.app, id, "s1");
    }
    if (made === null || made === "making" || made === "failed") throw new Error("the sheets weren't cut");
    expect(made.times).toEqual([0, 2, 4]);
    expect(made).toMatchObject({ columns: 10, rows: 10, width: 192, height: 108, stamp: "s1" });
    expect(fs.existsSync(`${render.replace(/\.mp4$/u, "")}.storyboard-s1/sheet-001.jpg`)).toBe(true);
  } finally {
    fixture.cleanup();
  }
});

test("a render the sheets can't be cut from is answered as failed, not cut again each time the bar asks; its half-made folder goes", async () => {
  const fixture = fixtureHome("storyboard-failed");
  try {
    const id = fixture.store.create("bar", { width: 1280, height: 720, fps: 30 }).project.id;
    const render = file(fixture.app, id);
    fs.mkdirSync(render.slice(0, render.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(render, "not a video");
    fs.writeFileSync(render.replace(/\.mp4$/u, ".json"), JSON.stringify({ rev: 1, hash: "h", stamp: "s1" }));
    let made = board(fixture.app, id, "s1");
    for (let tries = 0; tries < 100 && made === "making"; tries++) {
      await Bun.sleep(100);
      made = board(fixture.app, id, "s1");
    }
    expect(made).toBe("failed");
    expect(fs.existsSync(`${render.replace(/\.mp4$/u, "")}.storyboard-s1`)).toBe(false);
    // Asked again: the same answer, nothing started (a cut makes its folder as it starts).
    expect(board(fixture.app, id, "s1")).toBe("failed");
    expect(fs.existsSync(`${render.replace(/\.mp4$/u, "")}.storyboard-s1`)).toBe(false);
  } finally {
    fixture.cleanup();
  }
});
