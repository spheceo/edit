// A riser builds into the time it's placed at: it ends there.

import { expect, test } from "bun:test";

import { placeSound } from "../src/edit_tools.ts";
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
