// onscreen.ts's tests: calls to action on screen and B-roll across a cut, from the caches.

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

import type { Clip, Project } from "../src/model.ts";
import { useNative, wrap, type Native, type ScreenText } from "../src/native/index.ts";
import { createStub } from "../src/native/stub.ts";
import { issues } from "../src/onscreen.ts";
import { join } from "../src/paths.ts";
import { newProject } from "../src/project.ts";

const SETTINGS = { width: 1920, height: 1080, fps: 30 };
let before: Native | null = null;
afterEach(() => {
  useNative(before);
});

/** An addon whose caches say `text` (second → what's on screen) and whose files' cuts are `cuts`. */
function addon(text: Record<number, ScreenText[]>, cuts: number[] | null): string {
  const cache = fs.mkdtempSync(join(os.tmpdir(), "edit-onscreen-"));
  if (cuts !== null) fs.writeFileSync(join(cache, "cuts-v1.json"), JSON.stringify(cuts));
  const raw = createStub() as unknown as Record<string, unknown>;
  raw.stub = false;
  raw.mediaCache = () => cache;
  raw.screenTextCached = () => text;
  raw.screenTextDetect = async () => text;
  before = useNative(wrap(raw as unknown as Native));
  return cache;
}

function project(clips: Clip[]): Project {
  const p = newProject("p", "courtroom", SETTINGS);
  p.media.push({ id: "m1", name: "hearing.mp4", path: "/h.mp4", kind: "video", duration: 600, width: 1920, height: 1080, fps: 30, has_audio: true });
  p.clips.push(...clips);
  return p;
}

const video = (id: string, start: number, duration: number, source_in: number, speed = 1, name?: string): Clip =>
  ({
    id, track: "v1", start, duration, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m1",
    source_in, speed, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1, ...(name === undefined ? {} : { name }),
  }) as Clip;

// Corrupt Cop's: "SUBSCRIBED" bottom left at 208–213 s of the file.
const SUBSCRIBED: Record<number, ScreenText[]> = Object.fromEntries(
  Array.from({ length: 20 }, (_, i) => 200 + i).map((second) => [
    second,
    second >= 208 && second <= 213 ? [{ b: [0.177, 0.874, 0.32, 0.911], t: "SUBSCRIBED" }] : [{ b: [0.27, 0.19, 0.3, 0.21], t: "BLK" }],
  ]),
);

test("a channel's subscribe button on screen is flagged with the box to blur, until a blur covers it", () => {
  addon(SUBSCRIBED, []);
  const p = project([video("c1", 0, 600, 200)]);
  const found = issues(p);
  expect(found.pending).toEqual([]);
  // 208–214 s of the file is frames 240–420; the box in project pixels from the centre.
  expect(found.issues).toEqual([{ kind: "source_cta", clip: "c1", start: 240, end: 420, text: "SUBSCRIBED", blur_box: [-483, 424, 275, 40] }]);
  p.clips.push({
    id: "b1", track: "v1", start: 0, duration: 600, color: "blue", fade_in: 0, fade_out: 0, type: "adjustment",
    blur: { radius: 40, x: -480, y: 425, width: 320, height: 80, feather: 10, shape: "rect" }, opacity: 1,
  } as Clip);
  expect(issues(p).issues).toEqual([]);
});

test("a B-roll shot across a cut in its footage is flagged; one between cuts, or not B-roll, isn't", () => {
  addon({}, [135.1, 300]);
  // 132 s at half speed for 210 frames: 132–135.5 s, across the cut at 135.1 (frame 186).
  const across = project([video("c121", 0, 210, 132, 0.5, "Cut-in 3 · B-roll: shot 3")]);
  expect(issues(across).issues.filter((one) => (one as { kind: string }).kind === "broll_crosses_cut")).toEqual([
    { kind: "broll_crosses_cut", clip: "c121", at: 186, cut_seconds: 135.1 },
  ]);
  expect(issues(project([video("c2", 0, 150, 136, 0.5, "Cut-in 3 · B-roll: shot 3")])).issues).toEqual([]);
  expect(issues(project([video("c3", 0, 210, 132, 0.5)])).issues).toEqual([]);
});

test("footage not read yet is pending", () => {
  addon({}, null);
  expect(issues(project([video("c1", 0, 60, 10, 1, "Cut-in 1 · B-roll: shot 1")])).pending).toEqual(["hearing.mp4"]);
});
