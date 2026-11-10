// Claude on a script carries on after an update (Sphe, Nov 10: "let Update go through at any time"):
// before Edit restarts itself its jobs are stopped where they are and left written down, the next run
// shows them carrying on and starts each again from what it kept, the producer's request said once.

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

import type { Script } from "@edit/types/writer";

import * as busy from "../../src/busy.ts";
import * as durable from "../../src/jobs.ts";
import * as chat from "../../src/writer/chat.ts";
import { carryOn as carryOnImports, carrying } from "../../src/writer/index.ts";
import * as fixing from "../../src/writer/fixing.ts";
import * as jobs from "../../src/writer/jobs.ts";
import * as scripting from "../../src/writer/scripting.ts";
import * as store from "../../src/writer/store.ts";
import * as work from "../../src/writer/work.ts";
import { fixtureHome } from "../helpers/home.ts";

const ID = "3d4c5b6a-7f8e-4d9c-8b1a-2c3d4e5f6a7b";

function made(home: string, fields: Partial<Script> = {}): { data: string; dir: string } {
  const data = store.dataDir(home);
  const dir = store.scriptDir(data, ID);
  fs.mkdirSync(dir, { recursive: true });
  store.write(dir, { id: ID, title: "Case", sourceKind: "file", sourceUrl: "", originalPath: join(dir, "original.mp4"), status: "ready", stage: "ready", progress: 100, error: null, durationMs: 10_000, revision: 1, createdAt: 0, updatedAt: 0, overview: [], proxyPath: null, words: [], clips: [], ...fields } as Script);
  return { data, dir };
}

const listed = (home: string) => durable.list(home, "writer");

/** Waits for the script's job to end (its status no longer running). */
async function ended(data: string): Promise<void> {
  for (let i = 0; i < 200 && jobs.status(data, ID)?.running === true; i++) await Bun.sleep(10);
}

afterEach(() => {
  jobs.resetForTests();
  jobs.useHome(null);
});

test("a job cut off by a restart stays running and written down, shows as carrying on, and carries on from what it kept", async () => {
  const { home, cleanup } = fixtureHome("writer-carry-on");
  try {
    jobs.useHome(home);
    const { data, dir } = made(home);
    const request = "Make the opening tighter.";
    const runs: { resumed: boolean; kept: Record<string, unknown> }[] = [];
    // A revision: its request said, a step kept, then Claude at work until it's stopped.
    jobs.start(data, ID, "Case", { kind: "revise", request, focus: { selected: [], picked: null, playheadMs: null } }, async (job) => {
      runs.push({ resumed: job.resumed === true, kept: { ...job.kept } });
      chat.asked(dir, request, job.resumed);
      job.keep?.({ read: true });
      await jobs.wait(job, 60_000);
      return ["never", 0];
    });
    await Bun.sleep(20);
    // An update doesn't wait for it.
    expect(busy.wouldLose({} as never)).toEqual([]);
    expect(await jobs.holdForRestart(2_000)).toEqual([ID]);
    // Left running on the script and in the job table, with what it was started with and kept; nothing said it failed.
    const kept = JSON.parse(fs.readFileSync(join(dir, "build.json"), "utf8"));
    expect(kept).toMatchObject({ running: true, stage: jobs.CARRYING_ON, error: null });
    expect(listed(home)).toMatchObject([{ key: `writer:${ID}`, state: "running", args: { work: { kind: "revise", request }, title: "Case", kept: { read: true } } }]);
    expect(chat.read(dir).filter((turn) => turn.role === "editor")).toEqual([]);

    // The next run: shown carrying on, and nothing else starts on it meanwhile.
    jobs.resetForTests();
    jobs.useHome(home);
    jobs.markInterrupted(data, ID);
    expect(jobs.status(data, ID)).toMatchObject({ running: true, stage: jobs.CARRYING_ON, error: null });
    expect(jobs.running(ID)).toBe(true);
    expect(() => jobs.start(data, ID, "Case", { kind: "find" }, async () => ["", 0])).toThrow("already writing");

    // Carried on: from what it kept, its request not said again, and crossed off once done.
    const [job] = listed(home);
    jobs.start(data, ID, "Case", job!.args.work as jobs.Work, async (again) => {
      runs.push({ resumed: again.resumed === true, kept: { ...again.kept } });
      chat.asked(dir, request, again.resumed);
      chat.add(dir, "editor", "Tightened the opening.");
      return ["Tightened the opening.", 0];
    }, undefined, { resumed: true, kept: job!.args.kept as Record<string, unknown> });
    await ended(data);
    expect(runs).toEqual([{ resumed: false, kept: {} }, { resumed: true, kept: { read: true } }]);
    expect(chat.read(dir).map((turn) => turn.text)).toEqual([request, "Tightened the opening."]);
    expect(jobs.status(data, ID)).toMatchObject({ running: false, report: "Tightened the opening.", error: null });
    expect(listed(home)).toEqual([]);
  } finally {
    cleanup();
  }
});

test("a job that can't carry on says it stopped, and a stop pressed while it waits to carry on lets it go", async () => {
  const { home, cleanup } = fixtureHome("writer-carry-off");
  try {
    jobs.useHome(home);
    const { data, dir } = made(home);
    const running = { running: true, stage: "Writing the script", startedAt: 1, finishedAt: null, report: null, costUsd: null, error: null };
    // Running on disk with nothing in the job table (cut off too often and given up, or from before jobs were written down).
    fs.writeFileSync(join(dir, "build.json"), JSON.stringify(running));
    jobs.markInterrupted(data, ID);
    expect(jobs.status(data, ID)).toMatchObject({ running: false, error: expect.stringContaining("start it again") });
    expect(jobs.running(ID)).toBe(false);

    // Waiting to carry on: Stop crosses it off, and the script says it was stopped.
    fs.writeFileSync(join(dir, "build.json"), JSON.stringify(running));
    durable.begin(home, "writer", ID, { work: { kind: "find" }, title: "Case" });
    jobs.markInterrupted(data, ID);
    expect(jobs.running(ID)).toBe(true);
    jobs.stop(ID, data);
    expect(jobs.running(ID)).toBe(false);
    expect(listed(home)).toEqual([]);
    expect(jobs.status(data, ID)).toMatchObject({ running: false, error: jobs.STOPPED });

    // Given up by the job table: no longer shown carrying on.
    fs.writeFileSync(join(dir, "build.json"), JSON.stringify(running));
    const key = durable.begin(home, "writer", ID, { work: { kind: "find" }, title: "Case" });
    jobs.markInterrupted(data, ID);
    expect(jobs.running(ID)).toBe(true);
    const all = JSON.parse(fs.readFileSync(join(home, "jobs.json"), "utf8")) as durable.Job[];
    fs.writeFileSync(join(home, "jobs.json"), JSON.stringify(all.map((one) => (one.key === key ? { ...one, state: "given_up" } : one))));
    expect(jobs.running(ID)).toBe(false);
    expect(jobs.status(data, ID)?.running).toBe(false);
  } finally {
    cleanup();
  }
});

test("the resumer starts the job again from the job table, and leaves alone a script that's gone or has a job of its own", async () => {
  const { home, app, cleanup } = fixtureHome("writer-resumer");
  try {
    jobs.useHome(home);
    const { data } = made(home);
    // Hearing exactly asks for rough words: this script has none, so the job carried on ends at once, as it would have.
    durable.begin(home, "writer", ID, { work: { kind: "exact" }, title: "Case" });
    work.carryOn(app, listed(home)[0]!);
    await ended(data);
    expect(jobs.status(data, ID)?.error).toContain("rough words");
    expect(listed(home)).toEqual([]);

    // One started here meanwhile is that job's: left to it, its entry kept.
    let finish = () => {};
    jobs.start(data, ID, "Case", { kind: "find" }, () => new Promise((resolve) => (finish = () => resolve(["found", 0]))));
    const mine = listed(home)[0]!;
    work.carryOn(app, { ...mine, args: { work: { kind: "exact" }, title: "Case" } });
    expect(listed(home)).toMatchObject([{ args: { work: { kind: "find" } } }]);
    finish();
    await ended(data);

    // The script is gone: crossed off.
    durable.begin(home, "writer", "4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b", { work: { kind: "exact" }, title: "Gone" });
    expect(() => work.carryOn(app, listed(home)[0]!)).toThrow(durable.Gone);
  } finally {
    cleanup();
  }
});

test("the producer's request is said once when a job carries on, and as often as asked otherwise", () => {
  const { home, cleanup } = fixtureHome("writer-asked");
  try {
    const { dir } = made(home);
    chat.asked(dir, "Build the script.");
    chat.asked(dir, "Build the script.", true);
    expect(chat.read(dir).map((turn) => turn.text)).toEqual(["Build the script."]);
    // Answered since: a new ask, said.
    chat.add(dir, "editor", "Built.");
    chat.asked(dir, "Build the script.", true);
    chat.asked(dir, "Build the script.");
    expect(chat.read(dir).map((turn) => turn.text)).toEqual(["Build the script.", "Built.", "Build the script.", "Build the script."]);
  } finally {
    cleanup();
  }
});

test("a build saved before the restart isn't written again: its fresh read carries on alone", async () => {
  const { home, app, cleanup } = fixtureHome("writer-fresh-eyes");
  try {
    const { data } = made(home);
    const controller = new AbortController();
    // No cut-ins: the fresh read refuses at once, so what comes back is the build kept before the restart.
    const job: jobs.Job = { id: ID, signal: controller.signal, stage: () => {}, resumed: true, kept: { built: { report: "Built 12 cut-ins.", cost: 1.5 } }, keep: () => {} };
    expect(await scripting.buildAndReview(app, data, ID, "", undefined, true, job)).toEqual(["Built 12 cut-ins.", 1.5]);
  } finally {
    cleanup();
  }
});

test("review fixes carried on keep the notes they took and don't fix again those they got to", async () => {
  const { home, app, cleanup } = fixtureHome("writer-fixes-on");
  try {
    const { data } = made(home);
    const note = (id: string, status: string, createdAt: number) => ({ id, reviewId: "r1", version: 1, anchor: null, text: `Note ${id}`, author: "Ana", status, changedRanges: [], attempted: true, fromApp: false, confirmed: false, createdAt, updatedAt: 0 });
    fs.mkdirSync(join(data, "reviews"), { recursive: true });
    fs.writeFileSync(join(data, "reviews", "notes.json"), JSON.stringify({ cursor: 1, notes: { a: note("a", "open", 1), b: note("b", "done", 2) }, links: {}, tried: {}, attempts: {}, approved: {} }));
    const keeps: Record<string, unknown>[] = [];
    // Taking the notes again asks the cloud, which isn't here: carried on, it doesn't.
    const job: jobs.Job = { id: ID, signal: new AbortController().signal, stage: () => {}, resumed: true, kept: { claimed: ["a", "b"], handled: ["a"], fixed: 1, cost: 0.4, lines: ["Fixed Ana's note: tightened it."] }, keep: (what) => void keeps.push(what) };
    const [report, cost] = await fixing.run(app, data, ID, ["a", "b"], null, job);
    // "a" was done before the restart; "b" was marked fixed just before it, so it counts without being fixed again.
    expect(report).toBe("Fixed 2 of 2 review notes.\nFixed Ana's note: tightened it.");
    expect(cost).toBe(0.4);
    expect(keeps.at(-1)).toMatchObject({ handled: ["a", "b"], fixed: 2 });
  } finally {
    cleanup();
  }
});

test("an import a restart cut off stays importing until it carries on, and one that can't says it stopped", async () => {
  const { home, app, cleanup } = fixtureHome("writer-import-on");
  try {
    // Importing on disk, from a file that's gone: it carries on, and stops as any import would.
    const { data } = made(home, { status: "processing", stage: "transcribing", progress: 60, sourceKind: "file", originalPath: join(home, "nowhere.m4a") });
    const cut = store.markInterrupted(data);
    expect(cut).toEqual([ID]);
    expect(store.read(store.scriptDir(data, ID)).status).toBe("processing");
    carrying.signInMs = 10;
    carryOnImports(app, data, cut);
    for (let i = 0; i < 300 && store.read(store.scriptDir(data, ID)).status === "processing"; i++) await Bun.sleep(10);
    const script = store.read(store.scriptDir(data, ID));
    expect(script.status).toBe("error");
    expect(script.error).not.toBeNull();
    // Stopped while not importing: marked so, for Retry, as before.
    made(home, { status: "processing" });
    store.markStopped(data, ID);
    expect(store.read(store.scriptDir(data, ID))).toMatchObject({ status: "error", error: store.STOPPED_WHEN_CLOSED });
  } finally {
    carrying.signInMs = 60_000;
    cleanup();
  }
});
