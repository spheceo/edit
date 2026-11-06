// pull_feedback: the team asks in the chat ("implement the new feedback") and
// the agent pulls the review's open notes from Repack itself (Sphe, Nov 2).

import { afterAll, beforeAll, expect, test } from "bun:test";

import * as fs from "node:fs";

import * as machine from "../src/machine.ts";
import * as reviewGuard from "../src/review_guard.ts";
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

afterAll(() => {
  reviews.followEveryForTests(5_000);
  reviewGuard.resetForTests();
  restore();
  mock.stop();
});

type Call = { path: string; args: Record<string, unknown> };

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

test("pulls the open notes, claims them by hand, hands them over as a review turn, and shares nothing when nothing changed", async () => {
  const { app, home, cleanup } = fixtureHome("pull-feedback");
  const live = app.store.createAs("Judge", "courtroom", { width: 1920, height: 1080, fps: 30 });
  const id = live.project.id;
  // The agent's turn is running: it's the turn that called the tool.
  let running = true;
  (app as unknown as { agents: unknown }).agents = { chat: () => ({ running }), send: async () => {} };
  try {
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, notes: {}, shared: { [id]: { reviewId: "r1", url: "https://feedback.test/r/x", versions: [{ n: 1, timeline: "t", path: "/nowhere.mp4", fps: 30, durationMs: 10_000, clips: [] }] } } }));
    const note = (noteId: string, extra: Record<string, unknown> = {}) => ({ noteId, reviewId: "r1", sourceId: id, parentId: null, anchor: { kind: "time", ms: 1000 }, status: "open", fromApp: false, version: 1, author: "Marc", text: "Why this music?", createdAt: 1, updatedAt: 1, ...extra });
    const calls = convex({
      "reviews:changes": () => ({ notes: [note("n1"), note("n2", { status: "done", text: "old" }), note("n3", { intent: "fyi", text: "love it" })], cursor: 1, more: false }),
      "reviews:open": () => [{ sourceId: id, reviewId: "r1", approved: null }],
      "reviews:claim": (args) => ({ claimed: args.noteIds }),
    });
    const message = await reviews.pullFeedback(app, id);
    expect(message).toContain("[n1]");
    expect(message).toContain("Why this music?");
    expect(message).not.toContain("[n2]");
    expect(message).not.toContain("[n3]");
    expect(message).toContain("don't export or share it yourself");
    expect(message.startsWith("(Edit, automatically)")).toBe(false);
    const claim = calls.find((call) => call.path === "reviews:claim");
    expect(claim?.args).toMatchObject({ noteIds: ["n1"], manual: true, machine: machine.id() });
    // Guests' words are in the turn now: it edits this video only.
    expect(reviewGuard.inReviewTurn(id)).toBe(true);
    expect(reviewGuard.refusal(id, "search_web", null)).not.toBeNull();
    // A second pull while this one runs is refused.
    expect(await reviews.pullFeedback(app, id).catch((error: Error) => error.message)).toContain("being fixed already");
    await reviews.unfixed(app, id, "n1", "a question: answered in the chat");
    running = false;
    // The follow ends (nothing changed): the next pull may go, and finds nothing new.
    const end = Date.now() + 5_000;
    let again = "";
    while (Date.now() < end) {
      again = await reviews.pullFeedback(app, id).catch((error: Error) => error.message);
      if (!again.includes("being fixed already")) break;
      await Bun.sleep(30);
    }
    expect(again).toContain("No open notes to fix");
    expect(again).toContain("again: true");
    expect(calls.some((call) => call.path === "reviews:publish" || call.path === "reviews:fixProgress")).toBe(false);
  } finally {
    cleanup();
  }
});

// The database gives a request's notes, claimed without "by hand", only to the
// computer working on that request (Nov 2): asked in the chat there's none,
// so a note that came in during the fix is claimed by hand too.
test("a note that came in during a pulled fix is claimed by hand, as the first were", async () => {
  const { app, home, cleanup } = fixtureHome("pull-late-note");
  const live = app.store.createAs("Judge", "courtroom", { width: 1920, height: 1080, fps: 30 });
  const id = live.project.id;
  let running = true;
  let sends = 0;
  (app as unknown as { agents: unknown }).agents = {
    chat: () => ({ running }),
    send: async () => {
      sends++;
      setTimeout(() => void reviews.unfixed(app, id, "n4", "answered").catch(() => {}), 30);
    },
  };
  try {
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, notes: {}, shared: { [id]: { reviewId: "r1", url: "https://feedback.test/r/x", versions: [{ n: 1, timeline: "t", path: "/nowhere.mp4", fps: 30, durationMs: 10_000, clips: [] }] } } }));
    const note = (noteId: string) => ({ noteId, reviewId: "r1", sourceId: id, parentId: null, anchor: { kind: "time", ms: 1000 }, status: "open", fromApp: false, version: 1, author: "Marc", text: `note ${noteId}`, createdAt: 1, updatedAt: 1 });
    let heard = [note("n1")];
    const calls = convex({
      "reviews:changes": () => ({ notes: heard, cursor: 1, more: false }),
      "reviews:open": () => [{ sourceId: id, reviewId: "r1", approved: null }],
      "reviews:claim": (args) => ({ claimed: args.noteIds }),
    });
    await reviews.pullFeedback(app, id);
    // A reviewer's note lands while the agent works.
    heard = [note("n4")];
    await reviews.poll(app);
    await reviews.unfixed(app, id, "n1", "answered");
    running = false;
    const end = Date.now() + 5_000;
    while (!calls.some((call) => call.path === "reviews:claim" && (call.args.noteIds as string[]).includes("n4")) && Date.now() < end) await Bun.sleep(20);
    const late = calls.find((call) => call.path === "reviews:claim" && (call.args.noteIds as string[]).includes("n4"));
    expect(late?.args).toMatchObject({ noteIds: ["n4"], manual: true, machine: machine.id() });
    expect(sends).toBe(1);
    // The follow ends before the fixture goes.
    while (Date.now() < end && (await reviews.pullFeedback(app, id).catch((error: Error) => error.message)).includes("being fixed already")) await Bun.sleep(20);
  } finally {
    cleanup();
  }
});

test("a project never shared for review has nothing to pull", async () => {
  const { app, cleanup } = fixtureHome("pull-unshared");
  const live = app.store.createAs("Judge", "courtroom", { width: 1920, height: 1080, fps: 30 });
  try {
    convex({});
    expect(await reviews.pullFeedback(app, live.project.id).catch((error: Error) => error.message)).toContain("hasn't been shared for review");
  } finally {
    cleanup();
  }
});

// Sphe, Nov 6: JJ's reviews were shared from Mathias's Mac; on Sphe's they
// couldn't be pulled ("This project hasn't been shared for review").
test("a review shared from another Mac is taken in from the cloud and pulled here", async () => {
  const { app, home, cleanup } = fixtureHome("pull-other-mac");
  const live = app.store.createAs("Cops Realize", "interrogation", { width: 1920, height: 1080, fps: 30 });
  const id = live.project.id;
  let running = true;
  (app as unknown as { agents: unknown }).agents = { chat: () => ({ running }), send: async () => {} };
  try {
    const note = { noteId: "n1", reviewId: "r9", sourceId: id, parentId: null, anchor: { kind: "time", ms: 45_000 }, status: "open", fromApp: false, version: 2, author: "JJ", text: "audio in both ears", createdAt: 1, updatedAt: 1 };
    convex({
      "reviews:changes": () => ({ notes: [note], cursor: 1, more: false }),
      "reviews:open": () => [{ sourceId: id, reviewId: "r9", url: "https://feedback.test/r/other", approved: null }],
      "reviews:get": () => ({ versions: [
        { n: 1, meta: { timeline: "t1", fps: 30, durationMs: 60_000, clipMap: [["c1", 0, 900]] } },
        { n: 2, meta: { timeline: "t2", fps: 30, durationMs: 61_000, clipMap: [["c1", 0, 930]] } },
      ] }),
      "reviews:claim": (args) => ({ claimed: args.noteIds }),
    });
    const message = await reviews.pullFeedback(app, id);
    expect(message).toContain("[n1]");
    expect(message).toContain("audio in both ears");
    const shared = reviews.read(home).shared[id];
    expect(shared).toMatchObject({ reviewId: "r9", url: "https://feedback.test/r/other" });
    expect(shared?.versions.map((one) => [one.n, one.timeline, one.path, one.clips.length])).toEqual([[1, "t1", "", 1], [2, "t2", "", 1]]);
    // v2 has a comment: the fix goes up as v3.
    expect(reviews.shareReplacesLatest(shared!.versions.length, reviews.onLatest(home, id).length)).toBe(false);
    await reviews.unfixed(app, id, "n1", "answered");
    running = false;
    const end = Date.now() + 5_000;
    while (Date.now() < end && (await reviews.pullFeedback(app, id).catch((error: Error) => error.message)).includes("being fixed already")) await Bun.sleep(20);
  } finally {
    cleanup();
  }
});
