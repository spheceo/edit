import { expect, test } from "bun:test";
import * as fs from "node:fs";

import { apply, diff, empty } from "../src/patch.ts";

const clip = (id: string, start: number) => ({ id, track: "v", start, duration: 10 });

test("a patch carries only what changed and applying it gives the new project", () => {
  const before = {
    name: "a",
    settings: { width: 1920, height: 1080, fps: 30 },
    clips: [clip("c1", 0), clip("c2", 10), clip("c3", 20)],
    tracks: [{ id: "v" }],
    mark_in: 3,
  };
  const after = {
    name: "b",
    settings: before.settings,
    clips: [before.clips[0]!, clip("c3", 25), clip("c4", 30)],
    tracks: before.tracks,
    segments: [[0, 10]],
  };
  const patch = diff(before, after);
  expect(patch).toEqual({
    set: { name: "b", segments: [[0, 10]] },
    unset: ["mark_in"],
    lists: { clips: { put: [clip("c3", 25), clip("c4", 30)], remove: ["c2"] } },
  });
  const made = apply(before, patch);
  expect(made as unknown).toEqual(after);
  // What didn't change is the same object (the UI's undo history shares it).
  expect(made.clips[0]).toBe(before.clips[0]!);
  expect(made.settings).toBe(before.settings);
  expect(empty(diff(after, structuredClone(after)))).toBe(true);
});

test("a new order is sent when items moved, and a patch that doesn't fit is refused", () => {
  const before = { clips: [clip("c1", 0), clip("c2", 10)] };
  const after = { clips: [before.clips[1]!, before.clips[0]!] };
  const patch = diff(before, after);
  expect(patch.lists.clips).toEqual({ put: [], remove: [], order: ["c2", "c1"] });
  expect(apply(before, patch)).toEqual(after);
  expect(() => apply({ clips: [clip("c9", 0)] }, patch)).toThrow("clips's new order doesn't match its items");
  expect(() => apply(before, { set: {}, unset: [], lists: { clips: { put: [{}], remove: [] } } })).toThrow("has no id");
});

test("the UI's copy is the same file", () => {
  const server = fs.readFileSync(`${import.meta.dir}/../src/patch.ts`, "utf8");
  const web = fs.readFileSync(`${import.meta.dir}/../../web/src/lib/patch.ts`, "utf8");
  expect(web).toBe(server);
});
