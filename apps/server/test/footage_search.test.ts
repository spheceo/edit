// footage_search.rs's test, same name.

import { expect, test } from "bun:test";

import { norm, search } from "../src/footage_search.ts";

test("exact_runs_beat_scattered_words_and_small_words_dont_count", () => {
  const list = "officers found the baby in a bucket in the trunk of the car later the baby was".split(" ").map(norm);
  const hits = search(list, "baby in a bucket");
  expect(list.slice(hits[0]![0], hits[0]![1])).toEqual(["baby", "in", "a", "bucket"]);
  expect(hits[0]![2]).toBeGreaterThanOrEqual(1.0);
  expect(search(list, "the a of").length).toBeLessThanOrEqual(list.length);
  expect(search(list, "helicopter")).toEqual([]);
});
