// The page's crossfades (@edit/types/crossfades) on the cuts edit-core's own
// test pins (crates/edit-core/src/eval.rs,
// a_cut_between_footage_crossfades_its_sound_as_far_as_no_word_is_cut_into):
// the preview blends a cut exactly where the export does.

import { CROSSFADE_REACH, crossfadeGain, crossfades } from "@edit/types/crossfades";
import { describe, expect, it } from "vitest";
import type { Clip, Project } from "./types";

/** Two footage sounds on one track, back to back at frame 90 (3 s), each with `room`: seconds with no word before it, after it, and inside it at each end. */
function cut(room: [number, number, number] | null, secondIn: number, library?: "music"): Project {
  const sound = (id: string, start: number, sourceIn: number): Clip => ({
    id, track: "a1", start, duration: 90, color: "green", fade_in: 6, fade_out: 6, keyframes: {},
    type: "audio", media: "m1", source_in: sourceIn, speed: 1, volume_db: 0,
    ...(room === null ? {} : { room: { from: sourceIn - room[0], to: sourceIn + 3 + room[1], words_from: sourceIn + room[2], words_to: sourceIn + 3 - room[2] } }),
  }) as Clip;
  return {
    version: 1, id: "p", name: "t", style: "bodycam", settings: { width: 1920, height: 1080, fps: 30 },
    media: [{ id: "m1", name: "a.mp4", path: "/a.mp4", kind: "video", duration: 60, width: 1920, height: 1080, fps: 30, has_audio: true, ...(library ? { library } : {}) }],
    tracks: [{ id: "a1", kind: "audio", name: "A1", muted: false, hidden: false, locked: false }],
    clips: [sound("s1", 0, 10), sound("s2", 90, secondIn)],
    next_id: 10, markers: [],
  } as unknown as Project;
}

describe("crossfades", () => {
  it("blends a cut between footage as far as no word is cut into, as edit-core does", () => {
    const reach = CROSSFADE_REACH;
    const both = crossfades(cut([1, 1, 1], 30));
    expect(both.get("s1")).toEqual({ lead: 0, tail: reach, crossIn: 0, crossOut: 2 * reach });
    expect(both.get("s2")).toEqual({ lead: reach, tail: 0, crossIn: 2 * reach, crossOut: 0 });
    // A word right after the first clip's end, cut out: the first stops at the cut, falling only before it.
    expect(crossfades(cut([1, 0, 1], 30)).get("s1")).toEqual({ lead: 0, tail: 0, crossIn: 0, crossOut: reach });
    // 40 ms of quiet before the second clip: it reaches back 40 ms.
    expect(crossfades(cut([0.04, 1, 1], 30)).get("s2")?.lead).toBeCloseTo(0.04, 9);
    // Words right up to the cut, quiet beyond it: only what was cut out fades, under what's kept.
    const kept = crossfades(cut([1, 1, 0], 30));
    expect(kept.get("s1")).toEqual({ lead: 0, tail: reach, crossIn: 0, crossOut: reach });
    expect(kept.get("s2")).toEqual({ lead: reach, tail: 0, crossIn: reach, crossOut: 0 });
    for (let x = 0; x <= 1; x += 0.1) expect(crossfadeGain(x) ** 2 + crossfadeGain(1 - x) ** 2).toBeCloseTo(1, 9);
  });

  it("leaves a cut as it was without room, a take carrying on, or the library's sound", () => {
    expect(crossfades(cut(null, 30)).size).toBe(0);
    expect(crossfades(cut([0, 0, 0], 30)).size).toBe(0);
    expect(crossfades(cut([1, 1, 1], 13)).size).toBe(0);
    expect(crossfades(cut([1, 1, 1], 30, "music")).size).toBe(0);
  });
});
