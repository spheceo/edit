import { expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import type { Clip, Script, Word } from "@edit/types/writer";

import * as real from "../../src/writer/exact.ts";

// Hearing is Scribe and Claude: here it moves every word it hears 1 s later, as exact times would.
const heard: string[] = [];
let hearing: Promise<void> = Promise.resolve();
void mock.module("../../src/writer/exact.ts", () => ({
  ...real,
  run: async (script: Script, _dir: string, footage: string, clips: Clip[]) => {
    heard.push(footage);
    await hearing;
    const spans = real.stretches(script, clips);
    for (const word of script.words) {
      if (spans.some(([from, to]) => word.startMs >= from && word.startMs < to)) {
        word.startMs += 1_000;
        word.endMs += 1_000;
      }
    }
    script.exact = [...(script.exact ?? []), ...spans];
    return { stretches: spans.length, heardMs: 0, retimed: 0, respelled: 0, relabelled: 0 };
  },
}));

const { idle, pending, soon } = await import("../../src/writer/exact_after.ts");
const jobs = await import("../../src/writer/jobs.ts");
const store = await import("../../src/writer/store.ts");

const ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const word = (text: string, startMs: number): Word => ({ id: `w${startMs}`, text, startMs, endMs: startMs + 400, speaker: "p1" });

function made(): { data: string; dir: string } {
  const data = fs.mkdtempSync(join(os.tmpdir(), "edit-exact-after-"));
  const dir = store.scriptDir(data, ID);
  fs.mkdirSync(dir, { recursive: true });
  // The footage is here: what's heard is read from it.
  fs.writeFileSync(store.proxyPath(dir), "");
  const words = [word("one", 10_000), word("two", 10_500), word("three", 11_000), word("far", 60_000), word("away", 60_500)];
  store.write(dir, { id: ID, title: "Flirting", sourceKind: "youtube", sourceUrl: "", originalPath: "", status: "ready", stage: "", progress: 100, error: null, durationMs: 120_000, revision: 3, createdAt: 0, updatedAt: 0, overview: [], proxyPath: null, captions: true, speakers: { p1: "Officer" }, words, exact: [[0, 30_000]], clips: [{ id: "c1", startMs: 10_000, endMs: 11_400 }] } as Script);
  return { data, dir };
}

// JJ's Mac, Nov 5: a revision waited on its new footage being heard. Now it's done once Claude answers, and the footage it brought in is heard after.
test("a revision's new footage is heard after it, its clip moved onto the exact times", async () => {
  const { data, dir } = made();
  expect(pending(data, ID)).toBe(false);
  // The revision added a clip of footage not heard before.
  store.update(dir, (script) => void script.clips.push({ id: "c2", startMs: 60_000, endMs: 60_900 }));
  expect(pending(data, ID)).toBe(true);
  soon(data, ID);
  await idle(ID);
  const script = store.read(dir);
  expect(heard.at(-1)).toBe(store.proxyPath(dir));
  expect(script.clips.find((clip) => clip.id === "c2")!.startMs).toBeGreaterThanOrEqual(60_500);
  // The clip already heard stays where it was.
  expect(script.clips.find((clip) => clip.id === "c1")).toEqual({ id: "c1", startMs: 10_000, endMs: 11_400 });
  expect(script.revision).toBe(5);
  expect(script.speakers).toEqual({ p1: "Officer" });
  expect(pending(data, ID)).toBe(false);
});

test("it lands once the job on the script ends, and looks again when the words changed meanwhile", async () => {
  const { data, dir } = made();
  store.update(dir, (script) => void script.clips.push({ id: "c2", startMs: 60_000, endMs: 60_900 }));
  let finish = () => {};
  const job = new Promise<void>((resolve) => (finish = resolve));
  jobs.start(data, ID, "Flirting", { kind: "exact" }, async () => {
    await job;
    return ["", 0];
  });
  soon(data, ID);
  await Bun.sleep(1_200);
  // Nothing lands while the job runs.
  expect(store.read(dir).clips.find((clip) => clip.id === "c2")!.startMs).toBe(60_000);
  // The job heard the words itself meanwhile: this pass's hearing is stale, so it looks again and finds nothing left.
  store.update(dir, (script) => {
    script.words = script.words.map((one) => (one.startMs >= 60_000 ? { ...one, startMs: one.startMs + 2_000, endMs: one.endMs + 2_000 } : one));
    script.exact = [...(script.exact ?? []), [57_000, 66_000]];
  });
  finish();
  await idle(ID);
  const script = store.read(dir);
  expect(script.words.find((one) => one.text === "far")!.startMs).toBe(62_000);
  expect(script.clips.find((clip) => clip.id === "c2")!.startMs).toBe(60_000);
});

test("a second revision while one is heard is heard after it", async () => {
  const { data, dir } = made();
  let release = () => {};
  hearing = new Promise<void>((resolve) => (release = resolve));
  store.update(dir, (script) => void script.clips.push({ id: "c2", startMs: 60_000, endMs: 60_900 }));
  soon(data, ID);
  store.update(dir, (script) => void script.clips.push({ id: "c3", startMs: 100_000, endMs: 100_500 }));
  store.update(dir, (script) => void (script.words = [...script.words, word("late", 100_000)]));
  soon(data, ID);
  release();
  hearing = Promise.resolve();
  await idle(ID);
  await Bun.sleep(50);
  await idle(ID);
  expect(pending(data, ID)).toBe(false);
});
