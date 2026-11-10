import { expect, test } from "vitest";

import { effectAddress, effectsAt as at, showings } from "./effects";
import type { Project } from "./types";

function project(): Project {
  return {
    settings: { width: 1920, height: 1080, fps: 30 },
    tracks: [{ id: "v1" }, { id: "v2" }],
    media: [
      { id: "m1", kind: "video" },
      { id: "m2", kind: "image", effect: "board" },
      { id: "m3", kind: "image", effect: "windows" },
    ],
    clips: [
      { id: "c1", type: "video", track: "v1", media: "m1", start: 0, duration: 900, source_in: 0, speed: 1 },
      { id: "c2", type: "video", track: "v2", media: "m2", start: 300, duration: 150, source_in: 0, speed: 1 },
      // A second showing of the board, from two seconds into it.
      { id: "c3", type: "video", track: "v2", media: "m2", start: 600, duration: 60, source_in: 2, speed: 1 },
      { id: "c4", type: "video", track: "v1", media: "m3", start: 620, duration: 100, source_in: 0, speed: 1 },
      { id: "c5", type: "text", track: "v2", start: 0, duration: 900 },
    ],
  } as unknown as Project;
}

test("the effect the playhead is on, the second of it to draw, and the pages to have loaded", () => {
  const edit = showings(project());
  expect(edit.map((showing) => showing.name)).toEqual(["board", "board", "windows"]);
  const effectsAt = (shown: typeof edit, frame: number) => at(shown, 30, frame);
  // Footage only, the board more than three seconds off.
  expect(effectsAt(edit, 100)).toEqual({ playing: null, near: [] });
  // Three seconds before it starts its page is loaded, and nothing of it is drawn.
  expect(effectsAt(edit, 210)).toEqual({ playing: null, near: ["board"] });
  expect(effectsAt(edit, 300)).toEqual({ playing: { name: "board", seconds: 0 }, near: ["board"] });
  expect(effectsAt(edit, 345)).toEqual({ playing: { name: "board", seconds: 1.5 }, near: ["board"] });
  // Its last frame, then gone.
  expect(effectsAt(edit, 449).playing?.name).toBe("board");
  expect(effectsAt(edit, 450).playing).toBeNull();
  // The second showing starts two seconds in.
  expect(effectsAt(edit, 615)).toEqual({ playing: { name: "board", seconds: 2.5 }, near: ["board", "windows"] });
  // Two at once: the upper track's is the one drawn.
  expect(effectsAt(edit, 630).playing?.name).toBe("board");
  expect(effectsAt(edit, 700)).toEqual({ playing: { name: "windows", seconds: 80 / 30 }, near: ["windows"] });
});

test("a changed effect is a new address, so its page is loaded again", () => {
  expect(effectAddress({ page: "/api/effects/key/p1/board/scene.html", changed: 5 })).toBe("/api/effects/key/p1/board/scene.html?v=5");
});
