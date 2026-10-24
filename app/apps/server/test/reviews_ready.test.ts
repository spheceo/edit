// "Ready for changes" on the fixing computer (accounts/docs/fixing.md): Edit
// checks in, takes a waiting request for a project here, sets the agent on its
// notes, says how it's going, and shares only when the edit changed.

import { afterAll, beforeAll, expect, test } from "bun:test";

import * as fs from "node:fs";

import * as machine from "../src/machine.ts";
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

test("off the fixing computer it only checks in", async () => {
  const { app, cleanup } = fixtureHome("ready-not-chosen");
  try {
    const calls = convex({ "reviews:checkIn": () => ({ chosen: false, requests: [] }) });
    expect(await reviews.checkIn(app)).toEqual([]);
    expect(reviews.fixesHere()).toBe(false);
    expect(calls.map((call) => call.path)).toEqual(["reviews:checkIn"]);
    expect(calls[0]!.args).toMatchObject({ machine: machine.id(), name: machine.name() });
  } finally {
    cleanup();
  }
});

test("on the fixing computer it takes the request, follows the agent's turn and, with nothing changed, says so without sharing", async () => {
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
      "reviews:open": () => [],
      "reviews:takeFix": () => ({ ok: true, sourceId: id, title: "Judge", version: 1, noteIds: ["n1"] }),
      "reviews:claim": (args) => ({ claimed: args.noteIds }),
      "reviews:fixProgress": () => ({ ok: true }),
    });
    expect(await reviews.checkIn(app)).toEqual([id]);
    expect(reviews.fixesHere()).toBe(true);
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
  } finally {
    cleanup();
  }
});
