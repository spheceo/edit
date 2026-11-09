import { afterAll, beforeAll, expect, test } from "bun:test";

import * as fs from "node:fs";

import * as cloud from "../src/cloud.ts";
import { Cloud, Entry, open, readState, runStep } from "../src/cloud_projects.ts";
import { Store } from "../src/store.ts";
import { displayName, holderFor, holderId, keepsLock, TIMING, timingProblems } from "../src/sync_core.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token", EDIT_CLOUD_HOLDER: undefined });
  cloud.timing.sleep = async () => {};
});

afterAll(() => {
  restore();
  mock.stop();
});

// Nov 8 audit (3.4): the timers that interact (idle release 60 s vs heartbeat
// 75 s, quit 5 s vs a 15 s Convex call) were set apart from each other.
test("the sync timings keep their relations, and a broken one is said", () => {
  expect(timingProblems()).toEqual([]);
  expect(timingProblems({ ...TIMING, QUIT_CALL: 15_000 })).toEqual(["one call must fit in the quit budget: QUIT_CALL < QUIT_BUDGET"]);
  expect(timingProblems({ ...TIMING, RENEW_EVERY: 45_000 })).toContain("a take-over must be heard within a heartbeat: RENEW_EVERY ≤ HEARTBEAT");
  expect(timingProblems({ ...TIMING, VIEWER_TTL: 60_000 })).toContain("an editor must be able to miss a heartbeat: VIEWER_TTL > 2 × HEARTBEAT");
  // The editor's heartbeat is the one these are set against.
  const editor = fs.readFileSync(new URL("../../web/src/components/Editor.tsx", import.meta.url), "utf8");
  expect(editor).toContain(`const HEARTBEAT_MS = ${TIMING.HEARTBEAT.toLocaleString("en").replaceAll(",", "_")};`);
  // serve.ts quits on the same budget.
  expect(fs.readFileSync(new URL("../src/serve.ts", import.meta.url), "utf8")).toContain("TIMING.QUIT_BUDGET");
});

test("work keeps a lock, a close lets it go, and looking keeps it while open", () => {
  expect(keepsLock({ watched: true, working: false, lingering: false, closing: false })).toBe(true);
  expect(keepsLock({ watched: false, working: true, lingering: false, closing: true })).toBe(true);
  expect(keepsLock({ watched: false, working: false, lingering: true, closing: false })).toBe(true);
  expect(keepsLock({ watched: false, working: false, lingering: true, closing: true })).toBe(false);
  expect(keepsLock({ watched: false, working: false, lingering: false, closing: false })).toBe(false);
});

// Nov 8 audit (2b): the holder was the computer's name, so two Macs named
// alike both held the lock and forked silently.
test("two data folders on one computer are two holders, kept across restarts, and one is refused while the other has it", async () => {
  const a = fixtureHome("holder-a", { machine: "MacBook Pro" });
  const b = fixtureHome("holder-b", { machine: "MacBook Pro" });
  try {
    const first = holderId(a.home);
    expect(first).toMatch(/^[a-z0-9]{12}$/);
    expect(holderId(a.home)).toBe(first);
    expect(holderId(b.home)).not.toBe(first);
    expect(holderFor(a.home, "MacBook Pro")).toBe(`MacBook Pro #${first}`);
    expect(displayName(holderFor(a.home, "MacBook Pro"))).toBe("MacBook Pro");
    expect(displayName("Mathias’s MacBook Pro")).toBe("Mathias’s MacBook Pro");

    const mine = new Cloud(a.home, "MacBook Pro");
    mine.attach(a.store);
    const theirs = new Cloud(b.home, "MacBook Pro");
    theirs.attach(b.store);
    const id = a.store.create("Case", { width: 1920, height: 1080, fps: 30 }).project.id;
    await runStep(a.app, mine, id, "Acquire");
    await runStep(a.app, mine, id, "Push");
    expect(mine.status(id)).toMatchObject({ lock: "held", sync: "synced" });
    // The other folder, same computer name: refused, told who (by name), never a second holder.
    const opened = await open(b.app, id, "ui-b");
    expect(opened).toMatchObject({ lock: "elsewhere", holder: "MacBook Pro", writable: false });
    await expect(b.store.update(id, "agent", (project) => void (project.name = "forked"))).rejects.toThrow("MacBook Pro is editing this project");
    expect(mock.cloud.convex.locks.get(id)!.holder).toBe(mine.holder());
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

// Nov 8 audit (2b): a push's attempt was kept in memory, so one whose answer
// was lost at quit came back on the next start as a conflicted copy.
test("a push whose answer is lost at quit makes no copy on the next start", async () => {
  const fixture = fixtureHome("lost-answer-first", { machine: "this-mac" });
  try {
    const projects = new Cloud(fixture.home, "this-mac");
    projects.attach(fixture.store);
    const id = fixture.store.create("Case", { width: 1920, height: 1080, fps: 30 }).project.id;
    await runStep(fixture.app, projects, id, "Acquire");
    await runStep(fixture.app, projects, id, "Push");
    await fixture.store.update(id, "ui", (project) => void (project.name = "Case, edited before quitting"));
    // The commit lands in the cloud, but its answer never comes back (Edit quit while it was on its way).
    mock.cloud.convex.loseNextAnswer("commitProject");
    await runStep(fixture.app, projects, id, "Push");
    expect(mock.cloud.convex.projects.get(id)!.rev).toBe(2);
    expect(projects.dirty(id)).toBe(true);
    // Written down before it went, so the next start knows it (it was in memory only, and lost with it).
    expect(readState(fixture.home).get(id)!.attempt).toMatchObject({ base: 1 });
    // The next start: a new store and cloud on the same folder.
    const store = Store.open(fixture.home);
    const again = new Cloud(fixture.home, "this-mac");
    for (const [key, saved] of readState(fixture.home)) again.projects.set(key, new Entry(saved));
    again.attach(store);
    const app = { ...fixture.app, store } as typeof fixture.app;
    await runStep(app, again, id, "Acquire");
    expect(store.list().filter((summary) => summary.name.endsWith("(conflicted copy)"))).toEqual([]);
    expect(again.status(id)).toMatchObject({ rev: 2, dirty: false, sync: "synced" });
    expect(store.get(id)!.project.name).toBe("Case, edited before quitting");
  } finally {
    fixture.cleanup();
  }
});
