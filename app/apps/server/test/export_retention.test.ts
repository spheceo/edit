import { expect, test } from "bun:test";
import * as fs from "node:fs";

import { AFTER_MS, apply, decide, type Context, type Kept } from "../src/export_retention.ts";
import { scratch } from "./helpers/home.ts";

const DAY = 24 * 3600 * 1000;

function files(dir: string, names: string[], bytes = 100): string[] {
  fs.mkdirSync(`${dir}/Movies/Edit`, { recursive: true });
  return names.map((name) => {
    const path = `${dir}/Movies/Edit/${name}`;
    fs.writeFileSync(path, Buffer.alloc(bytes));
    return path;
  });
}

function context(dir: string, over: Partial<Context> = {}): Context {
  return { now: 100 * DAY, roots: [`${dir}/Movies/Edit`], reviewed: () => null, onDrive: () => null, busy: () => false, ...over };
}

/** An export listed as finished `daysAgo` before the test's day 100; its file (when there is one) written then, as an export's is. */
function record(path: string, daysAgo: number): Kept {
  const finished = 100 * DAY - daysAgo * DAY;
  if (fs.existsSync(path)) fs.utimesSync(path, finished / 1000, finished / 1000);
  return { path, name: path.split("/").pop()!, finished_ms: finished, bytes: 100 };
}

test("the newest export always stays; older ones go once a newer one is a week old, shared or not, saying where they still are", () => {
  const { dir, cleanup } = scratch("retention-rule");
  try {
    const [v1, v2, v3] = files(dir, ["v1.mp4", "v2.mp4", "v3.mp4"]);
    const records = { p: [record(v1!, 20), record(v2!, 9), record(v3!, 2)] };
    const shared = new Map([[v1!, 1]]);
    const decisions = decide(records, context(dir, { reviewed: (_, path) => shared.get(path) ?? null }));
    const by = (path: string) => decisions.find((one) => one.path === path)!;
    // v3 is the newest; v2's newer one (v3) is 2 days old: both stay. v1's newer v2 is 9 days old: goes, on the review link as v1.
    expect(by(v3!)).toMatchObject({ remove: false, why: "the newest: re-exports copy from it" });
    expect(by(v2!)).toMatchObject({ remove: false, why: "no newer export a week old yet" });
    expect(by(v1!)).toMatchObject({ remove: true, version: 1, removed: { review: 1, reason: "still on the review link as v1" } });
    // Never shared: the same week's rule.
    const lone = decide({ p: [record(v1!, 20), record(v2!, 9)] }, context(dir));
    expect(lone.find((one) => one.path === v1!)).toMatchObject({ remove: true, why: "a newer export is a week old; never shared" });
    // A subtitle video's copy on Drive since.
    const onDrive = decide({ p: [record(v1!, 20), record(v2!, 9)] }, context(dir, { onDrive: () => 100 * DAY - 10 * DAY }));
    expect(onDrive.find((one) => one.path === v1!)?.removed).toMatchObject({ drive: true, reason: "still on Drive" });
    expect(AFTER_MS).toBe(7 * DAY);
  } finally {
    cleanup();
  }
});

test("never another project's newest file, nor a file written there after the export", () => {
  const { dir, cleanup } = scratch("retention-shared-path");
  try {
    const [same, later] = files(dir, ["Untitled.mp4", "later.mp4"]);
    // Project a's older export and project b's newest were both written to Untitled.mp4.
    const shared = decide({ a: [record(same!, 20), record(later!, 9)], b: [record(same!, 1)] }, context(dir));
    expect(shared.find((one) => one.project === "a" && one.path === same!)).toMatchObject({ remove: false, why: "another project's newest export is at that path" });
    // Written over by hand (or by an export Edit no longer lists) after this one finished.
    const listed = record(same!, 20);
    fs.utimesSync(same!, (100 * DAY) / 1000, (100 * DAY) / 1000);
    const rewritten = decide({ a: [listed, record(later!, 9)] }, context(dir));
    expect(rewritten.find((one) => one.path === same!)).toMatchObject({ remove: false, why: "the file there was written after this export" });
  } finally {
    cleanup();
  }
});

test("never one in use, never a file outside Edit's export folders, and nothing gone already", () => {
  const { dir, cleanup } = scratch("retention-guards");
  try {
    const [v1, v2] = files(dir, ["v1.mp4", "v2.mp4"]);
    fs.mkdirSync(`${dir}/Desktop`, { recursive: true });
    const theirs = `${dir}/Desktop/mine.mp4`;
    fs.writeFileSync(theirs, "the user's own");
    const busy = decide({ p: [record(v1!, 20), record(v2!, 9)] }, context(dir, { busy: (_, path) => path === v1 }));
    expect(busy.find((one) => one.path === v1!)).toMatchObject({ remove: false, why: "in use (exporting, sharing or uploading)" });
    const foreign = decide({ p: [record(theirs, 20), record(v2!, 9)] }, context(dir));
    expect(foreign.find((one) => one.path === theirs)).toMatchObject({ remove: false, why: "not in Edit's export folders" });
    // Archived to the cloud (no file here): nothing to decide.
    const gone = decide({ p: [record(`${dir}/Movies/Edit/archived.mp4`, 20), record(v2!, 9)] }, context(dir));
    expect(gone.some((one) => one.path.endsWith("archived.mp4"))).toBe(false);
  } finally {
    cleanup();
  }
});

test("with the disk nearly full, older versions go at once, the oldest first, only till there's room; never the newest", () => {
  const { dir, cleanup } = scratch("retention-full");
  try {
    const [v1, v2, v3, v4] = files(dir, ["v1.mp4", "v2.mp4", "v3.mp4", "v4.mp4"]);
    // All newer than a week: the week's rule takes none.
    const records = { p: [record(v1!, 4), record(v2!, 3), record(v3!, 2), record(v4!, 1)] };
    const decisions = decide(records, context(dir, { short: 150 }));
    const removed = decisions.filter((one) => one.remove).map((one) => one.path);
    // 100 bytes each, 150 short: v1 and v2, the oldest.
    expect(removed).toEqual([v1!, v2!]);
    expect(decisions.find((one) => one.path === v1!)?.why).toBe("the disk is nearly full; never shared");
    expect(decisions.find((one) => one.path === v4!)?.remove).toBe(false);
    // Room enough: none.
    expect(decide(records, context(dir, { short: -1 })).some((one) => one.remove)).toBe(false);
  } finally {
    cleanup();
  }
});

test("applying deletes the files and keeps their entries, marked removed with where they still are; a dry run touches nothing", () => {
  const { dir, cleanup } = scratch("retention-apply");
  try {
    const home = `${dir}/home`;
    fs.mkdirSync(home, { recursive: true });
    const [v1, v2] = files(dir, ["v1.mp4", "v2.mp4"]);
    const records = { p: [record(v1!, 20), record(v2!, 9)] };
    fs.writeFileSync(`${home}/exports.json`, JSON.stringify(records));
    const decisions = decide(records, context(dir, { reviewed: (_, path) => (path === v1 ? 3 : null) }));
    expect(apply(home, decisions, true)).toEqual({ files: 1, bytes: 100 });
    expect(fs.existsSync(v1!)).toBe(true);
    expect(apply(home, decisions, false)).toEqual({ files: 1, bytes: 100 });
    expect(fs.existsSync(v1!)).toBe(false);
    expect(fs.existsSync(v2!)).toBe(true);
    const kept = JSON.parse(fs.readFileSync(`${home}/exports.json`, "utf8")) as Record<string, Kept[]>;
    expect(kept.p!.length).toBe(2);
    expect(kept.p![0]!.removed).toMatchObject({ review: 3, reason: "still on the review link as v3" });
    // Marked: never looked at again.
    expect(decide(kept, context(dir)).some((one) => one.path === v1)).toBe(false);
  } finally {
    cleanup();
  }
});
