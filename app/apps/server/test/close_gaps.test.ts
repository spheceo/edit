// Sphe, Nov 8: "when there is a gap in the edit say after something was removed we should be able to tell the agent to remove that gap".
import { expect, test } from "bun:test";

import { closeGaps, gapsOf } from "../src/edit_tools.ts";
import type { Clip } from "../src/model.ts";
import { clip, project as made } from "./helpers/model.ts";

test("a timeline's gaps are where nothing on any track plays, and closing one slides everything after it back", () => {
  const p = made();
  const v = p.tracks.find((track) => track.kind === "video")!.id;
  const a = p.tracks.find((track) => track.kind === "audio")?.id ?? v;
  p.clips.push(
    clip({ id: "one", track: v, start: 0, duration: 100, type: "solid" }),
    clip({ id: "sound", track: a, start: 90, duration: 30, type: "solid" }),
    // 120–150 is empty on every track.
    clip({ id: "two", track: v, start: 150, duration: 50, type: "solid" }),
  );
  p.mark_out = 190;
  expect(gapsOf(p)).toEqual([[120, 150]]);
  const closed = closeGaps(p, gapsOf(p).map(([start, end]) => ({ start, duration: end - start }) as Clip));
  expect(closed).toBe(30);
  expect(p.clips.find((one) => one.id === "two")!.start).toBe(120);
  expect(p.mark_out).toBe(160);
  expect(gapsOf(p)).toEqual([]);
});
