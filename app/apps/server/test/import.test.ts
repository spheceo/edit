import { afterAll, beforeAll, expect, test } from "bun:test";

import * as fs from "node:fs";

import { footageRate, hooks, houseMedia, importMade, importPaths, placeAtEnd } from "../src/import.ts";
import type { Project } from "../src/model.ts";
import { newProject } from "../src/project.ts";
import * as tools from "../src/tools.ts";
import { timing } from "../src/transcribe.ts";
import { expandHome } from "../src/paths.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

const ffmpeg = Bun.which("ffmpeg");
const ffprobe = Bun.which("ffprobe");

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  // Cloud off (no relay token) unless a test turns it on.
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: undefined });
  timing.sleep = async () => {};
  tools.forget();
});

afterAll(() => {
  restore();
  mock.stop();
});

function makeClip(path: string, audio: boolean): void {
  const args = [ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=2"];
  if (audio) args.push("-f", "lavfi", "-i", "sine=duration=2", "-shortest", "-c:a", "aac");
  args.push("-c:v", "libx264", path);
  expect(Bun.spawnSync(args).exitCode).toBe(0);
}

test("placing at the end links picture and sound and cycles colours", () => {
  const project: Project = newProject("p", "t", { width: 1920, height: 1080, fps: 30 });
  project.media.push(
    { id: "m1", name: "a", path: "/a.mp4", kind: "video", duration: 2.5, width: 1, height: 1, fps: 30, has_audio: true },
    { id: "m2", name: "b", path: "/b.wav", kind: "audio", duration: 1, width: 0, height: 0, fps: 0, has_audio: true },
  );
  placeAtEnd(project, "m1");
  placeAtEnd(project, "m2");
  placeAtEnd(project, "nope");
  expect(project.clips.map((clip) => [clip.type, clip.track, clip.start, clip.duration, clip.color, clip.link ?? null])).toEqual([
    ["video", "v1", 0, 75, "blue", "l6"],
    ["audio", "a4", 0, 75, "blue", "l6"],
    ["audio", "a4", 75, 30, "green", null],
  ]);
});

test.skipIf(ffmpeg === null || ffprobe === null)("importing probes, adds once, places, and starts the media work", async () => {
  const { dir, app, store, cleanup } = fixtureHome("import");
  try {
    const footage = `${dir}/clip.mp4`;
    makeClip(footage, true);
    fs.writeFileSync(`${dir}/notes.txt`, "hi");
    const id = store.create("p", { width: 1920, height: 1080, fps: 30 }).project.id;
    const [rev, added, errors] = await importPaths(app, id, [footage, `${dir}/notes.txt`, `${dir}/gone.mp4`], true, "ui");
    expect(rev).toBe(2);
    expect(added).toEqual(["m6"]);
    expect(errors).toEqual([
      `${dir}/notes.txt is not a supported local media file`,
      `${dir}/gone.mp4 is not a supported local media file`,
    ]);
    const project = store.get(id)!.project;
    expect(project.media[0]).toMatchObject({ id: "m6", name: "clip.mp4", path: footage, kind: "video", has_audio: true, width: 320 });
    expect(project.clips.map((clip) => clip.type)).toEqual(["video", "audio"]);
    // The first footage into an empty project sets its rate.
    expect(project.settings.fps).toBe(footageRate(project.media[0]!.fps).fps);
    // Footage in a project with no script and no case names yet waits for
    // them: heard now, it would be heard again when the research comes.
    expect(app.media.status(footage).transcript).toBe("pending");
    // The same file again is the same media.
    const [, again] = await importPaths(app, id, [footage], false, "ui");
    expect(again).toEqual(["m6"]);
    expect(store.get(id)!.project.media.length).toBe(1);
  } finally {
    cleanup();
  }
});

test.skipIf(ffmpeg === null || ffprobe === null)("in cloud mode the file goes up first, and a failure says which", async () => {
  const { dir, app, store, cleanup } = fixtureHome("import-cloud");
  const before = hooks.importLocal;
  const token = process.env.EDIT_RELAY_TOKEN;
  try {
    process.env.EDIT_RELAY_TOKEN = "cloud-token";
    const ok = `${dir}/ok.mp4`;
    const bad = `${dir}/bad.mp4`;
    makeClip(ok, false);
    makeClip(bad, false);
    hooks.importLocal = async (_cache, path, probe, name) => {
      if (path === bad) throw new Error("the relay said no");
      return { path: `${dir}/proxy-of-${name}`, name, probe, cloud: { source: "sha256:ab", original: "edit/originals/sha256/ab/ok.mp4", size: 10 } };
    };
    const id = store.create("p", { width: 1920, height: 1080, fps: 30 }).project.id;
    const [, added, errors] = await importPaths(app, id, [ok, bad], false, "script");
    expect(added.length).toBe(1);
    expect(errors).toEqual(["bad.mp4 couldn't go to the cloud: the relay said no"]);
    expect(store.get(id)!.project.media[0]!.cloud?.source).toBe("sha256:ab");
    // A script's import doesn't transcribe on its own.
    expect(app.media.status(`${dir}/proxy-of-ok.mp4`).transcript).toBe("pending");
  } finally {
    hooks.importLocal = before;
    if (token === undefined) delete process.env.EDIT_RELAY_TOKEN;
    else process.env.EDIT_RELAY_TOKEN = token;
    cleanup();
  }
});

test.skipIf(ffmpeg === null || ffprobe === null)("house media join a plan's own copy, once", async () => {
  const { dir, app, store, cleanup } = fixtureHome("import-house");
  try {
    const sound = `${dir}/shutter.wav`;
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=duration=0.2", sound]).exitCode).toBe(0);
    const id = store.create("p", { width: 1920, height: 1080, fps: 30 }).project.id;
    const copy = store.checkout(id)!.project;
    const [ids, made] = await houseMedia(app, copy, [sound, sound]);
    expect(ids).toEqual(["m6", "m6"]);
    expect(copy.media.length).toBe(1);
    expect(made.length).toBe(1);
    // Nothing is saved until the plan is.
    expect(store.get(id)!.project.media.length).toBe(0);
    const [rev, added] = await importMade(app, id, made, false, "agent");
    expect([rev, added]).toEqual([2, ["m6"]]);
  } finally {
    cleanup();
  }
});

test("a ~/ path is in the user's home", () => {
  expect(expandHome("~/Movies/a.mp4")).toBe(`${process.env.HOME}/Movies/a.mp4`);
  expect(expandHome("/abs/a.mp4")).toBe("/abs/a.mp4");
  expect(expandHome("~user/a.mp4")).toBe("~user/a.mp4");
});

test("a subtitled video takes its footage's rate (NTSC ones exactly) or one it divides into evenly, at most 30", () => {
  const rate = (fps: number) => {
    const { fps: whole, ntsc } = footageRate(fps);
    return ntsc ? `${whole}n` : `${whole}`;
  };
  expect([23.976023976023978, 24, 25, 29.97002997, 30, 50, 59.94005994, 60, 15, 12.5, 0, Number.NaN].map(rate)).toEqual([
    "24n", "24", "25", "30n", "30", "25", "30n", "30", "30", "30", "30", "30",
  ]);
});
