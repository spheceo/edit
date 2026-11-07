// "Ready for changes" asked of this computer: Edit checks in (saying whether
// it's busy), takes a request asked of it for a project here, sets the agent
// on its notes, says how it's going, and shares only when the edit changed; a
// request it can't do here is declined with why, and a busy one waits.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

import * as fs from "node:fs";

import { readOnly } from "../src/cloud_projects.ts";
import { optionsKey, timelineHash } from "../src/exports.ts";
import * as machine from "../src/machine.ts";
import { native } from "../src/native/index.ts";
import * as reviews from "../src/reviews.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  reviews.followEveryForTests(20);
});

beforeEach(async () => {
  await reviews.settledForTests();
  reviews.resetCheckInForTests();
});

afterAll(() => {
  reviews.followEveryForTests(5_000);
  restore();
  mock.stop();
});

type Call = { path: string; args: Record<string, unknown> };

/** Repack's reviews functions as the relay answers them; every call kept. */
function convex(answers: Record<string, (args: Record<string, unknown>) => unknown>): Call[] {
  const calls: Call[] = [];
  mock.on("POST", "/v1/cloud/convex", (request) => {
    const { path, args } = request.json<{ path: string; args: Record<string, unknown> }>();
    calls.push({ path, args });
    const answer = answers[path];
    return Response.json({ status: "success", value: answer ? answer(args) : null });
  });
  return calls;
}

/** The services a check-in reads to tell whether this computer is busy: nothing running, unless a test says so. */
function idle(app: unknown, agents: Record<string, unknown> = {}): void {
  (app as { exports: unknown }).exports = { running: () => false };
  (app as { agents: unknown }).agents = { hasRunningTurns: () => false, chat: () => ({ running: false }), ...agents };
}

const request = (sourceId: string, extra: Record<string, unknown> = {}) => ({ reviewId: "r1", sourceId, title: "Judge", version: 1, by: "JJ", requestedAt: 1, ...extra });

test("with nothing asked of it, it only checks in, saying it isn't busy", async () => {
  const { app, cleanup } = fixtureHome("ready-not-asked");
  idle(app);
  try {
    const calls = convex({ "reviews:checkIn": () => ({ chosen: false, requests: [] }) });
    expect(await reviews.checkIn(app)).toEqual([]);
    expect(reviews.askedHere()).toBe(false);
    expect(calls.map((call) => call.path)).toEqual(["reviews:checkIn"]);
    expect(calls[0]!.args).toMatchObject({ machine: machine.id(), name: machine.name(), busy: false });
  } finally {
    cleanup();
  }
});

test("a check-in says busy while an agent turn runs on any project here", async () => {
  const { app, cleanup } = fixtureHome("ready-busy-flag");
  idle(app, { hasRunningTurns: () => true });
  try {
    const calls = convex({ "reviews:checkIn": () => ({ chosen: false, requests: [] }) });
    await reviews.checkIn(app);
    expect(calls[0]!.args.busy).toBe(true);
    // An export alone is busy too.
    idle(app);
    (app as unknown as { exports: unknown }).exports = { running: () => true };
    await reviews.checkIn(app);
    expect(calls[1]!.args.busy).toBe(true);
  } finally {
    cleanup();
  }
});

test("a request for a project that isn't here, with the cloud off, is declined with why, once", async () => {
  const { app, cleanup } = fixtureHome("ready-decline-missing");
  idle(app);
  try {
    let asked = [request("p-elsewhere")];
    const calls = convex({
      "reviews:checkIn": () => ({ chosen: true, requests: asked }),
      "reviews:changes": () => ({ notes: [], cursor: 0, more: false }),
      "reviews:open": () => [],
      "reviews:declineFix": () => ({ ok: true }),
    });
    expect(await reviews.checkIn(app)).toEqual([]);
    expect(reviews.askedHere()).toBe(true);
    const declines = () => calls.filter((call) => call.path === "reviews:declineFix").map((call) => call.args);
    expect(declines()).toEqual([{ machine: machine.id(), reviewId: "r1", reason: "the project isn't on this computer, and Edit's cloud projects are off here" }]);
    expect(calls.some((call) => call.path === "reviews:takeFix")).toBe(false);
    // Still listed (the database hadn't moved it yet): not declined again.
    await reviews.checkIn(app);
    expect(declines()).toHaveLength(1);
    // Asked again later: a new request, declined again.
    asked = [request("p-elsewhere", { requestedAt: 2 })];
    await reviews.checkIn(app);
    expect(declines()).toHaveLength(2);
  } finally {
    cleanup();
  }
});

test("a request for a project another computer holds is declined, naming it", async () => {
  const { app, cleanup } = fixtureHome("ready-decline-held");
  idle(app);
  const live = app.store.createAs("Judge", "courtroom", { width: 1920, height: 1080, fps: 30 });
  (app.store as unknown as { mayWrite: unknown }).mayWrite = async () => {
    throw new Error(readOnly("Sphe's MacBook Air"));
  };
  try {
    const calls = convex({
      "reviews:checkIn": () => ({ chosen: true, requests: [request(live.project.id)] }),
      "reviews:changes": () => ({ notes: [], cursor: 0, more: false }),
      "reviews:open": () => [],
      "reviews:declineFix": () => ({ ok: true }),
    });
    expect(await reviews.checkIn(app)).toEqual([]);
    expect(calls.find((call) => call.path === "reviews:declineFix")?.args).toEqual({ machine: machine.id(), reviewId: "r1", reason: "the project is open on Sphe's MacBook Air" });
    expect(calls.some((call) => call.path === "reviews:takeFix")).toBe(false);
  } finally {
    cleanup();
  }
});

test("a request whose project is busy here waits: never declined, never taken", async () => {
  const { app, cleanup } = fixtureHome("ready-busy-waits");
  const live = app.store.createAs("Judge", "courtroom", { width: 1920, height: 1080, fps: 30 });
  idle(app, { hasRunningTurns: () => true, chat: () => ({ running: true }) });
  try {
    const calls = convex({
      "reviews:checkIn": () => ({ chosen: true, requests: [request(live.project.id)] }),
      "reviews:changes": () => ({ notes: [], cursor: 0, more: false }),
      "reviews:open": () => [],
      "reviews:declineFix": () => ({ ok: true }),
    });
    expect(await reviews.checkIn(app)).toEqual([]);
    expect(await reviews.checkIn(app)).toEqual([]);
    expect(calls.filter((call) => call.path === "reviews:checkIn").map((call) => call.args.busy)).toEqual([true, true]);
    expect(calls.some((call) => call.path === "reviews:declineFix" || call.path === "reviews:takeFix")).toBe(false);
    expect(reviews.askedHere()).toBe(true);
  } finally {
    cleanup();
  }
});

// Nov 7, Cops Realize: JJ's Mac took Ready for changes on 9 new notes and
// stopped with "already taken by another run"; the claim stayed, so no run
// (Sphe's pull_feedback either) could take them for half an hour.
test("notes it claimed but hasn't heard are handed straight back, and the request fails saying so", async () => {
  const { app, home, cleanup } = fixtureHome("ready-unheard");
  const live = app.store.createAs("Cops", "bodycam", { width: 1920, height: 1080, fps: 30 });
  const id = live.project.id;
  const sent: string[] = [];
  idle(app, { send: async (_project: string, text: string) => void sent.push(text) });
  try {
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, notes: {}, shared: { [id]: { reviewId: "r1", url: "https://feedback.test/r/x", versions: [{ n: 1, timeline: "t", path: "/nowhere.mp4", fps: 30, durationMs: 10_000, clips: [] }] } } }));
    const calls = convex({
      "reviews:checkIn": () => ({ chosen: true, requests: [request(id)] }),
      "reviews:changes": () => ({ notes: [], cursor: 0, more: false }),
      "reviews:open": () => [{ sourceId: id, reviewId: "r1", approved: null }],
      "reviews:takeFix": () => ({ ok: true, sourceId: id, title: "Cops", version: 1, noteIds: ["n1", "n2"] }),
      "reviews:claim": (args) => ({ claimed: args.noteIds }),
      "reviews:release": () => ({ released: [] }),
      "reviews:fixProgress": () => ({ ok: true }),
    });
    expect(await reviews.checkIn(app)).toEqual([id]);
    const end = Date.now() + 10_000;
    while (!calls.some((call) => call.path === "reviews:fixProgress" && call.args.state === "failed") && Date.now() < end) await Bun.sleep(20);
    expect(calls.find((call) => call.path === "reviews:release")?.args).toMatchObject({ noteIds: ["n1", "n2"] });
    expect(calls.find((call) => call.path === "reviews:fixProgress" && call.args.state === "failed")?.args.error).toContain("handed back");
    expect(sent).toEqual([]);
  } finally {
    cleanup();
  }
});

test("asked of this computer it takes the request, follows the agent's turn and, with nothing changed, says so without sharing", async () => {
  const { app, home, cleanup } = fixtureHome("ready-chosen");
  const live = app.store.createAs("Judge", "courtroom", { width: 1920, height: 1080, fps: 30 });
  const id = live.project.id;
  let running = false;
  const sent: string[] = [];
  // The agent panel: a turn that answers the note without changing the edit.
  (app as unknown as { agents: unknown }).agents = {
    chat: () => ({ running }),
    send: async (project: string, text: string) => {
      sent.push(text);
      running = true;
      setTimeout(() => {
        void reviews.unfixed(app, project, "n1", "it's a question: answered").then(() => {
          running = false;
        });
      }, 30);
    },
  };
  try {
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, notes: {}, shared: { [id]: { reviewId: "r1", url: "https://feedback.test/r/x", versions: [{ n: 1, timeline: "t", path: "/nowhere.mp4", fps: 30, durationMs: 10_000, clips: [] }] } } }));
    const note = { noteId: "n1", reviewId: "r1", sourceId: id, parentId: null, anchor: { kind: "time", ms: 1000 }, status: "open", fromApp: false, version: 1, author: "Marc", text: "Why this music?", createdAt: 1, updatedAt: 1 };
    const calls = convex({
      "reviews:checkIn": () => ({ chosen: true, requests: [{ reviewId: "r1", sourceId: id, title: "Judge", version: 1, by: "Marc", requestedAt: 1 }] }),
      "reviews:changes": () => ({ notes: [note], cursor: 1, more: false }),
      "reviews:open": () => [{ sourceId: id, reviewId: "r1", approved: null }],
      "reviews:takeFix": () => ({ ok: true, sourceId: id, title: "Judge", version: 1, noteIds: ["n1"] }),
      "reviews:claim": (args) => ({ claimed: args.noteIds }),
      "reviews:fixProgress": () => ({ ok: true }),
    });
    expect(await reviews.checkIn(app)).toEqual([id]);
    expect(reviews.askedHere()).toBe(true);
    // fixReady runs on by itself: wait for its last word.
    const end = Date.now() + 15_000;
    while (!calls.some((call) => call.path === "reviews:fixProgress" && call.args.state === "done") && Date.now() < end) await Bun.sleep(50);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Why this music?");
    const claim = calls.find((call) => call.path === "reviews:claim");
    expect(claim?.args).toMatchObject({ noteIds: ["n1"], machine: machine.id() });
    expect(claim?.args.manual).toBeUndefined();
    const said = calls.filter((call) => call.path === "reviews:fixProgress").map((call) => call.args);
    expect(said[0]).toMatchObject({ reviewId: "r1", machine: machine.id(), stage: "Fixing the notes", done: 0, total: 1 });
    expect(said.at(-1)).toMatchObject({ state: "done", stage: "Answered: nothing in the edit changed" });
    // Nothing shared.
    expect(calls.some((call) => call.path === "reviews:publish")).toBe(false);
    const reported = calls.filter((call) => call.path === "reviews:status");
    expect(reported).toHaveLength(1);
    expect(reported[0]!.args).toMatchObject({ noteId: "n1", state: "left", reason: "it's a question: answered", details: "it's a question: answered" });
    expect(calls.some((call) => call.path === "reviews:reply")).toBe(false);
    const saved = JSON.parse(fs.readFileSync(`${home}/reviews.json`, "utf8")) as { notes: Record<string, { unfixed?: string }> };
    expect(saved.notes.n1?.unfixed).toBe("it's a question: answered");
  } finally {
    cleanup();
  }
});

// Nov 2, JJ's Mom Secretly: every note done in v2, then sharing v2 failed
// (Native encoder stalled), and the page had no way to try again. Now it
// offers "Share v2 again": takeFix answers reshare with no notes to claim.
test("Share again: with nothing to claim, it goes straight to exporting and sharing, never to the agent", async () => {
  const { app, home, cleanup } = fixtureHome("ready-reshare");
  const live = app.store.createAs("Mom Secretly", "bodycam", { width: 1920, height: 1080, fps: 30 });
  const id = live.project.id;
  const sent: string[] = [];
  idle(app, { send: async (_project: string, text: string) => void sent.push(text) });
  let exports = 0;
  (app as unknown as { exports: unknown }).exports = {
    running: () => false,
    runningFor: () => null,
    cancel: () => false,
    exported: () => false,
    start: async (_store: unknown, _library: unknown, _project: unknown, _options: unknown, path: string) => {
      exports++;
      setTimeout(() => app.store.emit({ type: "export", id, state: "done", progress: 1, path }), 10);
      return path;
    },
  };
  try {
    // v1 shared, with JJ's notes on it, done in the fix whose share failed.
    const v1 = { n: 1, timeline: "an-older-cut", path: "/nowhere.mp4", fps: 30, durationMs: 10_000, clips: [] };
    const note = { id: "n1", reviewId: "r1", project: id, version: 1, ms: 0, endMs: null, text: "cut the intro", author: "JJ", status: "done", parentId: null, createdAt: 1, updatedAt: 1, fix: { summary: "cut", ranges: [], clips: [] } };
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, notes: { n1: note }, shared: { [id]: { reviewId: "r1", url: "https://feedback.test/r/x", versions: [v1] } } }));
    const calls = convex({
      "reviews:checkIn": () => ({ chosen: true, requests: [request(id, { title: "Mom Secretly" })] }),
      "reviews:changes": () => ({ notes: [], cursor: 1, more: false }),
      "reviews:open": () => [{ sourceId: id, reviewId: "r1", approved: null }],
      "reviews:takeFix": () => ({ ok: true, sourceId: id, title: "Mom Secretly", version: 1, noteIds: [], reshare: true }),
      "reviews:fixProgress": () => ({ ok: true }),
    });
    expect(await reviews.checkIn(app)).toEqual([id]);
    const said = () => calls.filter((call) => call.path === "reviews:fixProgress").map((call) => call.args);
    const end = Date.now() + 10_000;
    while (!said().some((one) => one.state === "failed" || one.state === "done") && Date.now() < end) await Bun.sleep(20);
    // v1 has JJ's comments: the fixes go up as v2, exported now.
    expect(said()[0]).toMatchObject({ reviewId: "r1", state: "sharing", stage: "Exporting v2" });
    expect(exports).toBe(1);
    expect(calls.some((call) => call.path === "reviews:claim")).toBe(false);
    expect(sent).toEqual([]);
    // The fixture has no export on record, so the share itself stops there; it's said, and kept to try again.
    expect(said().at(-1)).toMatchObject({ state: "failed" });
    expect(String(said().at(-1)!.error)).toContain("The fixes are in, but sharing v2 failed");
    const saved = JSON.parse(fs.readFileSync(`${home}/reviews.json`, "utf8")) as { unshared?: Record<string, true> };
    expect(saved.unshared?.[id]).toBe(true);
  } finally {
    cleanup();
  }
});

test("Share again with a new note: the agent fixes it, and the earlier fixes are shared even when this round changes nothing", async () => {
  const { app, home, cleanup } = fixtureHome("ready-reshare-notes");
  const live = app.store.createAs("Mom Secretly", "bodycam", { width: 1920, height: 1080, fps: 30 });
  const id = live.project.id;
  let running = false;
  idle(app, {
    chat: () => ({ running }),
    send: async (project: string) => {
      running = true;
      setTimeout(() => void reviews.unfixed(app, project, "n2", "a question: answered").then(() => (running = false)), 30);
    },
  });
  (app as unknown as { exports: unknown }).exports = { running: () => false, runningFor: () => null, cancel: () => false, exported: () => false, start: async () => { throw new Error("no exports in this test"); } };
  try {
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, notes: {}, shared: { [id]: { reviewId: "r1", url: "u", versions: [{ n: 1, timeline: "older", path: "/nowhere.mp4", fps: 30, durationMs: 10_000, clips: [] }] } } }));
    const note = { noteId: "n2", reviewId: "r1", sourceId: id, parentId: null, anchor: { kind: "time", ms: 1000 }, status: "open", fromApp: false, version: 1, author: "JJ", text: "Why this music?", createdAt: 1, updatedAt: 1 };
    const calls = convex({
      "reviews:checkIn": () => ({ chosen: true, requests: [request(id)] }),
      "reviews:changes": () => ({ notes: [note], cursor: 1, more: false }),
      "reviews:open": () => [{ sourceId: id, reviewId: "r1", approved: null }],
      "reviews:takeFix": () => ({ ok: true, sourceId: id, title: "Mom Secretly", version: 1, noteIds: ["n2"], reshare: true }),
      "reviews:claim": (args) => ({ claimed: args.noteIds }),
      "reviews:fixProgress": () => ({ ok: true }),
    });
    expect(await reviews.checkIn(app)).toEqual([id]);
    const said = () => calls.filter((call) => call.path === "reviews:fixProgress").map((call) => call.args);
    const end = Date.now() + 10_000;
    while (!said().some((one) => one.state === "failed" || one.state === "done") && Date.now() < end) await Bun.sleep(20);
    expect(said().some((one) => one.state === "sharing")).toBe(true);
    expect(said().some((one) => one.stage === "Answered: nothing in the edit changed")).toBe(false);
  } finally {
    cleanup();
  }
});

test("Share again when the edit as it is now is already the latest version shared: said, nothing shared twice", async () => {
  const { app, home, cleanup } = fixtureHome("ready-reshare-shared");
  const live = app.store.createAs("Mom Secretly", "bodycam", { width: 1920, height: 1080, fps: 30 });
  const id = live.project.id;
  idle(app);
  try {
    const v2 = { n: 2, timeline: timelineHash(live.project), path: "/nowhere.mp4", fps: 30, durationMs: 10_000, clips: [] };
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, notes: {}, shared: { [id]: { reviewId: "r1", url: "u", versions: [{ ...v2, n: 1, timeline: "older" }, v2] } } }));
    const calls = convex({
      "reviews:fixProgress": () => ({ ok: true }),
    });
    await reviews.fixReady(app, id, "r1", [], 20, true);
    const said = calls.filter((call) => call.path === "reviews:fixProgress").map((call) => call.args);
    expect(said).toEqual([expect.objectContaining({ reviewId: "r1", state: "done", stage: "v2 is already shared as the edit is now" })]);
    expect(calls.some((call) => call.path === "reviews:claim" || call.path === "reviews:publish")).toBe(false);
    // No notes and no reshare: nothing to do, and nothing claimed.
    expect(await reviews.fixReady(app, id, "r1", [], 20, false).catch((error: Error) => error.message)).toBe("there were no notes to fix");
    expect(calls.some((call) => call.path === "reviews:claim")).toBe(false);
  } finally {
    cleanup();
  }
});

test("a fix goes up in place of the latest version unless it has a reviewer's comment", () => {
  const { home, cleanup } = fixtureHome("ready-versions");
  try {
    const note = (id: string, version: number, extra: Record<string, unknown> = {}) => ({ id, reviewId: "r1", project: "p", version, ms: 0, endMs: null, text: "x", author: "Marc", status: "open", parentId: null, createdAt: 1, updatedAt: 1, ...extra });
    const versions = [1, 2].map((n) => ({ n, timeline: "t", path: "/nowhere.mp4", fps: 30, durationMs: 10_000, clips: [] }));
    const notes = { a: note("a", 1), b: note("b", 2, { parentId: "a" }), c: note("c", 2, { fromApp: true }) };
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, notes, shared: { p: { reviewId: "r1", url: "u", versions } } }));
    // Notes on v1, a reply and the agent's own words on v2: v2 is replaced.
    expect(reviews.onLatest(home, "p")).toEqual([]);
    expect(reviews.shareReplacesLatest(versions.length, reviews.onLatest(home, "p").length)).toBe(true);
    // A comment on v2: the fix is v3. Nothing shared yet is a first version, not a replace.
    expect(reviews.shareReplacesLatest(0, 0)).toBe(false);
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, notes: { ...notes, d: note("d", 2) }, shared: { p: { reviewId: "r1", url: "u", versions } } }));
    expect(reviews.onLatest(home, "p").map((one) => one.id)).toEqual(["d"]);
    expect(reviews.shareReplacesLatest(versions.length, reviews.onLatest(home, "p").length)).toBe(false);
  } finally {
    cleanup();
  }
});

// Oct 31, the "Helpful" Son: a restart carried the share's export on by
// itself, then the followed fix asked for its own and was refused ("this
// project already has an export running"); the export finished 90 s later and
// v3 was never shared.
test("a share follows the export already running for the same picture, and waits out a different one", async () => {
  const { app, cleanup } = fixtureHome("ready-busy-export");
  const live = app.store.createAs("Helpful Son", "bodycam", { width: 1920, height: 1080, fps: 30 });
  const id = live.project.id;
  const house = native().exportDefaults();
  // A share always asks for YouTube, even with no options (Sphe, Nov 3). The export it follows has those settings.
  const shareOptions = { ...house, preset: "youtube" as const };
  let busy: { output: string; timeline: string; options: string } | null = null;
  const started: string[] = [];
  (app as unknown as { exports: unknown }).exports = {
    runningFor: () => busy,
    running: () => busy !== null,
    cancel: () => false,
    exported: () => false,
    start: async (_store: unknown, _library: unknown, _project: unknown, _options: unknown, path: string) => {
      if (busy !== null) throw new Error("this project already has an export running");
      started.push(path);
      busy = { output: path, timeline: timelineHash(live.project), options: optionsKey(shareOptions) };
      setTimeout(() => {
        busy = null;
        app.store.emit({ type: "export", id, state: "done", progress: 1, path });
      }, 30);
      return path;
    },
  };
  const finish = (path: string) => {
    busy = null;
    app.store.emit({ type: "export", id, state: "done", progress: 1, path });
  };
  try {
    // The same picture and the YouTube settings a share asks for: followed to its file, no second export.
    busy = { output: "/out/resumed.mp4", timeline: timelineHash(live.project), options: optionsKey(shareOptions) };
    const same = reviews.exportAndShare(app, id, {});
    setTimeout(() => finish("/out/resumed.mp4"), 50);
    // No such export on record in the fixture, so the share itself stops after: past the export is what's tested.
    expect(await same.catch((error: Error) => error.message)).toContain("isn't one of this project's whole exports");
    expect(started).toEqual([]);
    // A different export (another format): waited out, then this one starts.
    busy = { output: "/out/agent.mov", timeline: timelineHash(live.project), options: optionsKey({ ...house, format: "prores" }) };
    const other = reviews.exportAndShare(app, id, {});
    setTimeout(() => finish("/out/agent.mov"), 50);
    expect(await other.catch((error: Error) => error.message)).toContain("isn't one of this project's whole exports");
    expect(started).toHaveLength(1);
  } finally {
    cleanup();
  }
});

test("a share whose export goes without a word (its process died, the event lost) exports again once, then says so, never waiting for ever", async () => {
  const { app, cleanup } = fixtureHome("ready-silent-export");
  const live = app.store.createAs("Helpful Son", "bodycam", { width: 1920, height: 1080, fps: 30 });
  const id = live.project.id;
  const house = native().exportDefaults();
  let busy: { output: string; timeline: string; options: string } | null = null;
  const started: string[] = [];
  (app as unknown as { exports: unknown }).exports = {
    runningFor: () => busy,
    running: () => busy !== null,
    cancel: () => false,
    exported: () => false,
    start: async (_store: unknown, _library: unknown, _project: unknown, _options: unknown, path: string) => {
      started.push(path);
      busy = { output: path, timeline: timelineHash(live.project), options: optionsKey(house) };
      // Gone 30 ms later, with no end said.
      setTimeout(() => (busy = null), 30);
      return path;
    },
  };
  const before = { ...reviews.exportWatch };
  reviews.exportWatch.everyMs = 20;
  try {
    const shared = await reviews.exportAndShare(app, id, {}).catch((error: Error) => error.message);
    expect(shared).toContain("the export stopped without saying how, twice");
    expect(started).toHaveLength(2);
    // Not left "being shared": another share can start.
    const again = await reviews.exportAndShare(app, id, {}).catch((error: Error) => error.message);
    expect(again).not.toContain("already being shared");
  } finally {
    Object.assign(reviews.exportWatch, before);
    cleanup();
  }
}, 30_000);

// Nov 6, JJ's Cops Realize: the turn fixed 7 of 31 notes, ended saying "this
// round is not finished", and v2 was shared with the other 22 untouched.
test("a turn that ends with notes unanswered is sent back for them before anything's shared; one never answered is left saying so", async () => {
  const { app, home, cleanup } = fixtureHome("ready-unanswered");
  const live = app.store.createAs("Cops", "bodycam", { width: 1920, height: 1080, fps: 30 });
  const id = live.project.id;
  let running = false;
  const sent: string[] = [];
  idle(app, {
    chat: () => ({ running }),
    send: async (project: string, text: string) => {
      sent.push(text);
      running = true;
      setTimeout(() => {
        // The first turn answers n1 only; the next answers n2 and never n3.
        const which = sent.length === 1 ? ["n1"] : sent.length === 2 ? ["n2"] : [];
        void Promise.all(which.map((one) => reviews.unfixed(app, project, one, "answered"))).then(() => (running = false));
      }, 30);
    },
  });
  try {
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, notes: {}, shared: { [id]: { reviewId: "r1", url: "u", versions: [{ n: 1, timeline: "t", path: "/nowhere.mp4", fps: 30, durationMs: 10_000, clips: [] }] } } }));
    const note = (n: string, text: string) => ({ noteId: n, reviewId: "r1", sourceId: id, parentId: null, anchor: { kind: "time", ms: 1000 }, status: "open", fromApp: false, version: 1, author: "JJ", text, createdAt: 1, updatedAt: 1 });
    const calls = convex({
      "reviews:checkIn": () => ({ chosen: true, requests: [request(id)] }),
      "reviews:changes": () => ({ notes: [note("n1", "one"), note("n2", "two"), note("n3", "three")], cursor: 1, more: false }),
      "reviews:open": () => [{ sourceId: id, reviewId: "r1", approved: null }],
      "reviews:takeFix": () => ({ ok: true, sourceId: id, title: "Cops", version: 1, noteIds: ["n1", "n2", "n3"] }),
      "reviews:claim": (args) => ({ claimed: args.noteIds }),
      "reviews:fixProgress": () => ({ ok: true }),
    });
    expect(await reviews.checkIn(app)).toEqual([id]);
    const said = () => calls.filter((call) => call.path === "reviews:fixProgress").map((call) => call.args);
    const end = Date.now() + 15_000;
    while (!said().some((one) => one.state === "failed" || one.state === "done") && Date.now() < end) await Bun.sleep(20);
    // Sent back twice: n2 and n3, then n3 alone; a send that answered nothing ends it.
    expect(sent).toHaveLength(3);
    expect(sent[1]).toContain("Your turn ended with 2 of the 3 notes unanswered");
    expect(sent[1]).toContain("[n2]");
    expect(sent[1]).not.toContain("[n1]");
    expect(sent[2]).toContain("[n3]");
    expect(sent[2]).not.toContain("[n2]");
    const left = calls.filter((call) => call.path === "reviews:status" && call.args.noteId === "n3");
    expect(left).toHaveLength(1);
    expect(String(left[0]!.args.details)).toContain("didn't get to this note");
  } finally {
    cleanup();
  }
});
