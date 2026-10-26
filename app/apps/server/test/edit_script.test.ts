// Edit Script: a script's calls become one plan's operations; errors name their line; the read side lists clips as calls.

import { expect, test } from "bun:test";
import { evalScript } from "../src/script_eval.ts";
import { forTests } from "../src/edit_script.ts";
import type { ScriptContext } from "../src/script_runtime.ts";

const ctx = (): ScriptContext => ({
  project: { id: "p", title: "Essay", fps: 30, width: 1920, height: 1080, rev: 7, span: [0, 20], duration: 60 },
  clips: [
    { id: "c1", type: "video", name: "Cut-in 1 · B-roll: stream", track: "v2", from: 2, to: 6, media: "m1", source_in: 10, speed: 0.8 },
    { id: "c2", type: "text", name: "Janitor · emphasis", track: "v3", from: 3, to: 5, text: "MOST HATED" },
  ],
  shots: [{ id: "c1", from: 2, to: 6, facts: { sees: "an empty walkway", text: "", people: "", empty: true, fits: "no", why: "no N3on" } }],
  words: [{ text: "the", at: 2.1 }, { text: "most", at: 2.4 }, { text: "hated", at: 2.7 }, { text: "streamer.", at: 3.1 }],
  media: [{ id: "m1", name: "Monkey [qXGbUquhQrE].mp4", kind: "video", duration: 200, width: 1920, height: 1080 }],
});

test("a script's calls queue plan operations in frames, with ids a later call can use", async () => {
  const out = await evalScript({ code: `const s = shot("m1", { from: said("most hated"), to: 5, source_in: 20 });\npunch(s, { at: [sec("0:04")], on: [400, -50] });\ntrim("c1", { from: 2.5 });\nremove("c2");\nfor (const x of shots.filter((x) => x.facts?.fits === "no")) note(x.id);`, library: [], context: ctx(), run: "t" });
  expect(out.error).toBeUndefined();
  expect(out.ops[0]).toMatchObject({ op: "add", clip: { id: "xt0", media: "m1", start: 72, duration: 78, source_in: 20 } });
  expect(out.ops[1]).toMatchObject({ op: "commentary_punch", clip: "xt0", at: [120], x: 400, y: -50 });
  // Trimmed half a second later: its source moves 0.4 s on at 0.8x.
  expect(out.ops[2]).toMatchObject({ op: "update", select: { ids: ["c1"] }, patch: { start: 75, duration: 105 } });
  expect((out.ops[2] as { patch: { source_in: number } }).patch.source_in).toBeCloseTo(10.4);
  expect(out.ops[3]).toMatchObject({ op: "delete", select: { ids: ["c2"] } });
  expect(out.notes).toEqual(["c1"]);
});

test("a script that throws saves nothing and names its line; library functions are in scope", async () => {
  const library = [{ name: "flashText", code: `export function flashText(words: string, at: number) {\n  flash(at);\n  text(words, { from: at, to: at + 2 });\n}` }];
  const ok = await evalScript({ code: `flashText("NOTHING WORKED", 10);`, library, context: ctx(), run: "t" });
  expect(ok.ops.map((o) => o.op)).toEqual(["transition", "commentary_text"]);
  const bad = await evalScript({ code: `const a = 1;\nshot("nope", { from: 1, to: 2 });`, library: [], context: ctx(), run: "t" });
  expect(bad.error).toContain("line 2");
  expect(bad.error).toContain("no media nope");
  const missing = await evalScript({ code: `said("never said")`, library: [], context: ctx(), run: "t" });
  expect(missing.error).toContain("doesn't say");
});

test("read_edit lists clips as re-runnable calls with what's seen, and the lints flag a misfit", () => {
  const text = forTests.listing(ctx(), ["flashText(words, at)"]);
  expect(text).toContain(`shot("m1", {id: "c1", from: 2, to: 6, source_in: 10, speed: 0.8})`);
  expect(text).toContain("DOESN'T FIT: no N3on");
  expect(text).toContain(`text("MOST HATED", {id: "c2"`);
  expect(text).toContain("// says @2.1: the most hated streamer.");
  expect(forTests.lints(ctx())[0]).toContain("doesn't fit its words: no N3on");
});
