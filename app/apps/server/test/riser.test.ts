// A riser builds into the time it's placed at: it ends there.

import { expect, test } from "bun:test";

import { placeSound, risersOffCut } from "../src/edit_tools.ts";
import type { AudioClip } from "../src/model.ts";
import { fixtureHome } from "./helpers/home.ts";
import { media } from "./helpers/model.ts";

test("a_riser_ends_on_the_time_and_a_hit_lands_its_hit_on_it", async () => {
  const { app, cleanup } = fixtureHome("riser");
  try {
    const id = app.store.create("p", { width: 1920, height: 1080, fps: 30 }).project.id;
    await app.store.update(id, "test", (project) => {
      project.media.push(media({ id: "r", name: "Riser_1sec.mp3", path: "/lib/sfx/abc/Riser_1sec.mp3", kind: "audio", duration: 1, markers: [{ time: 0.1, name: "hit", note: "" }] }));
      project.media.push(media({ id: "b", name: "Boom.wav", path: "/lib/sfx/def/Boom.wav", kind: "audio", duration: 2, markers: [{ time: 0.25, name: "hit", note: "" }] }));
    });
    const sound = { volume_db: 0, seconds: 0.5, lead: null, fade_out: 0, color: "yellow" as const };
    await placeSound(app.store, id, "r", "Riser_1sec.mp3", [], [2], sound);
    await placeSound(app.store, id, "b", "Boom.wav", [], [2], { ...sound, seconds: null });
    const clips = app.store.get(id)!.project.clips as AudioClip[];
    const riser = clips.find((clip) => clip.media === "r")!;
    // Its last half second, ending on frame 60.
    expect([riser.start, riser.start + riser.duration, riser.source_in]).toEqual([45, 60, 0.5]);
    const boom = clips.find((clip) => clip.media === "b")!;
    expect(boom.start).toBe(Math.round((2 - 0.25) * 30));
  } finally {
    cleanup();
  }
});

// Killer Pastor (JJ, Nov 8): "For a riser, the climax must hit at the exact time where we have our transition."
test("a riser's climax lands on its cut: its late hit on the time, and one left early by a moved cut is flagged", async () => {
  const { app, cleanup } = fixtureHome("riser-climax");
  try {
    const id = app.store.create("p", { width: 1920, height: 1080, fps: 30 }).project.id;
    await app.store.update(id, "test", (project) => {
      // The library's Riser_1sec: its loudest moment 0.795 s into 0.973 s.
      project.media.push(media({ id: "r", name: "Riser_1sec.mp3", path: "/lib/sfx/abc/Riser_1sec.mp3", kind: "audio", duration: 0.972854, markers: [{ time: 0.795, name: "hit", note: "" }] }));
    });
    const sound = { volume_db: 0, seconds: null, lead: null, fade_out: 0, color: "yellow" as const };
    await placeSound(app.store, id, "r", "Riser_1sec.mp3", [], [10], sound);
    const riser = (app.store.get(id)!.project.clips as AudioClip[]).find((clip) => clip.media === "r")!;
    // 0.795 s after its start is frame 300; its tail plays on past the cut.
    expect(riser.start).toBe(Math.round((10 - 0.795) * 30));
    expect(riser.start + riser.duration).toBeGreaterThan(300);
    // A bridge flash at 10.3 s (its middle on frame 309): the riser now peaks 9 frames early.
    await app.store.update(id, "test", (project) => {
      project.clips.push({ id: "fl", track: project.tracks.find((track) => track.kind === "video")!.id, start: 303, duration: 12, name: "Bridge flash", color: "white", fade_in: 0, fade_out: 0, type: "adjustment" } as never);
    });
    const issues = risersOffCut(app.store.get(id)!.project);
    expect(issues).toEqual([expect.objectContaining({ kind: "riser_off_cut", clip: riser.id, cut: 309, frames_off: 9 })]);
    expect(String((issues[0] as { fix: string }).fix)).toContain(`move it to start ${riser.start + 9}`);
    await app.store.update(id, "test", (project) => {
      const placed = project.clips.find((clip) => clip.id === riser.id)!;
      placed.start += 9;
    });
    expect(risersOffCut(app.store.get(id)!.project)).toEqual([]);
  } finally {
    cleanup();
  }
});
