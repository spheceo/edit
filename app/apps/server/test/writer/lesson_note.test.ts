// Script mode's lessons (writer/lesson_note.ts): a revision's answer carries
// an optional lesson, noted in the team's inbox with the script it was said
// on (the cloud mock's editLessons); none, or an unusable one, adds nothing.

import { afterAll, beforeAll, expect, test } from "bun:test";

import type { Script } from "@edit/types/writer";

import * as cloud from "../../src/cloud.ts";
import { list } from "../../src/lesson_inbox.ts";
import { keep, LESSON_RULE, LESSON_SCHEMA, lessonOf } from "../../src/writer/lesson_note.ts";
import { MockServer } from "../mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  cloud.timing.sleep = async () => {};
});

afterAll(() => {
  restore();
  mock.stop();
});

test("a revision's lesson is noted with its script; none or an unusable one adds nothing", async () => {
  const script = { id: "s1793450000000", title: "Predator Tutor", kind: "interrogation" } as Script;
  const plan = { edits: [], answer: "Done.", lesson: { lesson: "Openings start on the confession, not the arrest.", quote: "we always open on the confession", from: "JJ", scope: "style" } };
  expect(await keep(script, lessonOf(plan))).toContain("Noted for the next teaching round");
  expect(await keep(script, lessonOf({ edits: [], answer: "Done." }))).toBe("");
  expect(await keep(script, { lesson: "no quote", scope: "house" })).toBe("");
  const [noted] = await list();
  expect(noted).toMatchObject({ part: "script", style: "interrogation", scope: "style", from: "JJ", quote: "we always open on the confession", source: { kind: "script", id: script.id, name: "Predator Tutor" } });
  expect((await list()).length).toBe(1);
  // The schema the model answers to has it optional, and the rule names it.
  expect(LESSON_SCHEMA.required).toEqual(["lesson", "quote", "scope"]);
  expect(LESSON_RULE).toContain("leave lesson out");
});
