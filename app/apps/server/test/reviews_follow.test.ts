// Following Repack's reviews from the moment Edit starts, signed in or not yet:
// the sign-in is read from the Keychain after the follower starts (or comes
// later), and a follower that waited for the cloud never ran (Marc's 5 notes
// on Judge EXPLODES v2 went unheard on Oct 23).

import { afterAll, beforeAll, expect, test } from "bun:test";

import * as fs from "node:fs";

import * as reviews from "../src/reviews.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  // Nobody signed in yet, and no relay token: the cloud is off.
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "" });
});

afterAll(() => {
  reviews.stop();
  restore();
  mock.stop();
});

const asked = () => mock.calls("/v1/cloud/convex", "POST").filter((call) => call.json<{ path?: string }>().path === "reviews:changes").length;
const until = async (done: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await Bun.sleep(10);
};

test("the reviews are followed once someone signs in, even when Edit started before the sign-in was read", async () => {
  const { app, cleanup } = fixtureHome("reviews-follow");
  try {
    reviews.start(app, 20);
    await Bun.sleep(120);
    expect(asked()).toBe(0);
    // Signed in now (the cloud on): the follower already running asks Repack.
    process.env.EDIT_RELAY_TOKEN = "cloud-token";
    await until(() => asked() > 0, 2_000);
    expect(asked()).toBeGreaterThan(0);
  } finally {
    reviews.stop();
    cleanup();
  }
});

const note = (id: string, fields: Record<string, unknown>) => ({
  noteId: id,
  reviewId: "r1",
  sourceId: "p1",
  parentId: null,
  anchor: { kind: "time", ms: 16_600 },
  status: "open",
  fromApp: false,
  createdAt: 1,
  updatedAt: 1,
  ...fields,
});

test("a second reviewer's notes on a later version are heard as new, beside the first one's settled notes", () => {
  const state = reviews.read("/nonexistent");
  // Marius on v1, fixed in v2.
  reviews.heard(state, [note("m1", { version: 1, author: "Marius", text: "too loud", status: "done" })], new Set(["p1"]));
  // Marc on v2, hours later: open, his own, and the project is to fix again.
  expect(reviews.heard(state, [note("c1", { version: 2, author: "Marc", text: "We want to avoid double line subtitles" })], new Set(["p1"]))).toEqual(["p1"]);
  expect(Object.values(state.notes).map((one) => [one.id, one.author, one.version, one.status])).toEqual([
    ["m1", "Marius", 1, "done"],
    ["c1", "Marc", 2, "open"],
  ]);
});

test("the reconcile finds an open client note Edit never heard, takes it in and says so loudly; Edit's own and replies aren't", async () => {
  const { app, home, cleanup } = fixtureHome("reviews-reconcile");
  const events: Record<string, unknown>[] = [];
  app.store.subscribe((event) => events.push(event as Record<string, unknown>));
  const live = app.store.createAs("Judge", "courtroom", { width: 1920, height: 1080, fps: 30 });
  const id = live.project.id;
  process.env.EDIT_RELAY_TOKEN = "cloud-token";
  try {
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 104, autoFix: true, notes: {}, shared: { [id]: { reviewId: "r1", url: "https://feedback.test/r/x", versions: [{ n: 2 }] } } }));
    mock.on("POST", "/v1/cloud/convex", (request) => {
      const { path } = request.json<{ path: string }>();
      if (path !== "reviews:get") return Response.json({ status: "success", value: null });
      return Response.json({
        status: "success",
        value: {
          title: "Judge",
          notes: [
            note("c1", { sourceId: id, version: 2, author: "Marc", text: "We want to avoid double line subtitles" }),
            note("c2", { sourceId: id, version: 2, author: "Marc", text: "Same here" }),
            note("e1", { sourceId: id, version: 2, author: "Edit", fromApp: true, text: "Please confirm: …" }),
            note("r1", { sourceId: id, version: 2, author: "JJ", parentId: "c1", text: "agreed" }),
            note("d1", { sourceId: id, version: 1, author: "Marius", status: "done", text: "done one" }),
          ],
        },
      });
    });
    expect(await reviews.reconcile(app)).toEqual([id]);
    expect(Object.keys(reviews.read(home).notes).sort()).toEqual(["c1", "c2"]);
    const said = events.find((event) => event.type === "review-missed");
    expect(said?.message).toContain("2 open notes from Marc on “Judge”");
    // Once in, it's quiet.
    expect(await reviews.reconcile(app)).toEqual([]);
    // An approved review isn't read again (its notes get no follow-up), nor a project not here.
    const asked = () => mock.calls("/v1/cloud/convex").filter((call) => call.json<{ path: string }>().path === "reviews:get").length;
    const before = asked();
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ ...reviews.read(home), shared: { [id]: { reviewId: "r1", url: "https://feedback.test/r/x", versions: [{ n: 2 }], approved: { version: 2, by: "kenobi", at: 1 } }, "p-gone": { reviewId: "r2", url: "https://feedback.test/r/y", versions: [{ n: 1 }] } } }));
    expect(await reviews.reconcile(app)).toEqual([]);
    expect(asked()).toBe(before);
  } finally {
    process.env.EDIT_RELAY_TOKEN = "";
    cleanup();
  }
});
