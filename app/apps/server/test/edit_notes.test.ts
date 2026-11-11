// The team's own notes on an edit (Sphe, Nov 2): left at the playhead, pinned
// to the footage there, queued, riding the next message (Nov 3) or pulled
// with "implement the feedback", fixed and reported like a review's, never
// put on the review.

import { afterAll, beforeAll, expect, test } from "bun:test";

import * as editNotes from "../src/edit_notes.ts";
import { respond } from "../src/http/server.ts";
import { handlerFor } from "../src/mcp/registry.ts";
import { buildRouter } from "../src/routes.ts";
import * as reviewGuard from "../src/review_guard.ts";
import * as reviews from "../src/reviews.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  editNotes.followEveryForTests(20);
});

afterAll(() => {
  editNotes.followEveryForTests(5_000);
  reviewGuard.resetForTests();
  restore();
  mock.stop();
});

type Row = editNotes.AppNote;

/** mamagi's edit:*Note* functions, in memory; every call kept. */
function mamagi(): { rows: Row[]; paths: string[] } {
  const rows: Row[] = [];
  const paths: string[] = [];
  let next = 1;
  mock.on("POST", "/v1/cloud/convex", (request) => {
    const { path, args } = request.json<{ path: string; args: Record<string, unknown> }>();
    paths.push(path);
    const mine = () => rows.filter((row) => row.projectId === args.projectId);
    const find = () => mine().find((row) => row.id === args.id)!;
    let value: unknown = null;
    if (path === "edit:listNotes") value = mine();
    else if (path === "edit:addNote") {
      const row: Row = {
        id: `n${next++}`, projectId: String(args.projectId), text: String(args.text), frame: Number(args.frame), endFrame: (args.endFrame as number) ?? null, fps: Number(args.fps),
        clipId: (args.clipId as string) ?? null, source: (args.source as string) ?? null, sourceMs: (args.sourceMs as number) ?? null, box: (args.box as Row["box"]) ?? null,
        status: "queued", fix: null, reason: null, at: next, updatedAt: next, by: { sub: "u1", name: "JJ", picture: null },
      };
      rows.push(row);
      value = row;
    } else if (path === "edit:sendNotes") {
      value = mine().filter((row) => row.status === "queued").map((row) => Object.assign(row, { status: "sent" as const }));
    } else if (path === "edit:resolveNote") {
      const row = find();
      row.status = args.status as Row["status"];
      row.fix = args.status === "done" ? { summary: String(args.summary), clips: args.clips as string[], ranges: args.ranges as number[][] } : null;
      row.reason = args.status === "left" ? String(args.reason) : null;
      value = row;
    } else if (path === "edit:removeNote") {
      rows.splice(rows.indexOf(find()), 1);
      value = { removed: true };
    }
    return Response.json({ status: "success", value });
  });
  return { rows, paths };
}

const video = (id: string, media: string, start: number, duration: number, sourceIn: number, track = "v1") =>
  ({ id, type: "video", media, track, start, duration, source_in: sourceIn, speed: 1, color: "blue", fade_in: 0, fade_out: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1, volume_db: 0 }) as never;

async function judge(app: ReturnType<typeof fixtureHome>["app"]) {
  const id = app.store.createAs("Judge", "courtroom", { width: 1920, height: 1080, fps: 30 }).project.id;
  await app.store.update(id, "test", (project) => {
    project.media.push({ id: "m1", name: "hearing.mp4", path: "/footage/hearing.mp4", kind: "video", duration: 60, width: 1920, height: 1080, fps: 30, has_audio: true } as never);
    project.clips.push(video("c1", "m1", 0, 300, 10), video("c2", "m1", 300, 300, 40));
  });
  return id;
}

test("a note is pinned to the footage on top at the playhead, and follows its clip when the edit moves", async () => {
  const { app, cleanup } = fixtureHome("notes-pin");
  try {
    const id = await judge(app);
    const project = app.store.get(id)!.project;
    // 2 s into c1, whose footage starts 10 s in: hearing.mp4 @12 s.
    expect(editNotes.pinAt(project, 60)).toEqual({ clipId: "c1", source: "hearing.mp4", sourceMs: 12_000 });
    expect(editNotes.pinAt(project, 900)).toEqual({});
    await app.store.update(id, "test", (draft) => {
      // The clip starts 3 s later (same footage start): its 12 s moment is now at 5 s.
      const clip = draft.clips.find((one) => one.id === "c1")!;
      clip.start = 90;
      clip.duration = 210;
    });
    const moved = app.store.get(id)!.project;
    expect(editNotes.frameNow(moved, { frame: 60, clipId: "c1", sourceMs: 12_000 })).toBe(150);
    // Its clip gone: where it was written.
    expect(editNotes.frameNow(moved, { frame: 60, clipId: "gone", sourceMs: 12_000 })).toBe(60);
  } finally {
    cleanup();
  }
});

test("notes are left, listed and taken away through the routes", async () => {
  const { app, cleanup } = fixtureHome("notes-routes");
  try {
    const db = mamagi();
    const id = await judge(app);
    const router = buildRouter();
    const call = async (path: string, method = "GET", body?: unknown) =>
      (await respond(app, router, new Request(`http://localhost:7700${path}`, { method, headers: { host: "localhost:7700", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), null))!;
    const add = await (async () => call(`/api/projects/${id}/notes`, "POST", { text: "blur his face", frame: 330, box: { x: 0.4, y: 0.1, w: 0.2, h: 0.3 } }))();
    expect(add.status).toBe(200);
    expect(db.rows[0]).toMatchObject({ text: "blur his face", frame: 330, clipId: "c2", source: "hearing.mp4", sourceMs: 41_000, box: { x: 0.4, y: 0.1, w: 0.2, h: 0.3 }, fps: 30 });
    // In–Out set and the playhead in it: the note covers it.
    await app.store.update(id, "test", (draft) => {
      draft.mark_in = 30;
      draft.mark_out = 89;
    });
    await call(`/api/projects/${id}/notes`, "POST", { text: "too slow", frame: 45 });
    expect(db.rows[1]).toMatchObject({ frame: 30, endFrame: 90 });
    const listed = (await (await call(`/api/projects/${id}/notes`)).json()) as editNotes.Placed[];
    expect(listed.map((note) => note.now)).toEqual([330, 30]);
    expect((await call(`/api/projects/${id}/notes`, "POST", { text: " ", frame: 1 })).status).toBe(400);
    await call(`/api/projects/${id}/notes/n2`, "DELETE");
    expect(db.rows.map((row) => row.id)).toEqual(["n1"]);
  } finally {
    cleanup();
  }
});

test("implement the feedback: the team's notes go to the agent, are fixed with what changed, and one it didn't answer goes back in the queue; nothing is shared", async () => {
  const { app, cleanup } = fixtureHome("notes-pull");
  let running = true;
  (app as unknown as { agents: unknown }).agents = { chat: () => ({ running }), send: async () => {} };
  try {
    const db = mamagi();
    const id = await judge(app);
    await editNotes.add(app, id, { text: "cut the pause", frame: 60 });
    await editNotes.add(app, id, { text: "what's this?", frame: 400 });
    const message = await reviews.pullFeedback(app, id);
    expect(message).toContain("[app:n1] at 0:02");
    expect(message).toContain("hearing.mp4 @12.00s");
    expect(message).toContain('JJ: "cut the pause"');
    expect(message).not.toContain("REVIEWER NOTES");
    // The team's own words: an ordinary turn, not a guest's review turn.
    expect(reviewGuard.inReviewTurn(id)).toBe(false);
    expect(db.rows.map((row) => row.status)).toEqual(["sent", "sent"]);
    await app.store.update(id, "test", (draft) => {
      draft.clips.find((clip) => clip.id === "c1")!.duration = 250;
    });
    await handlerFor("feedback_done")!.handler({ app, args: { note: "[app:n1]", summary: "cut the pause at 0:02" }, projectId: id } as never);
    expect(db.rows[0]).toMatchObject({ status: "done", fix: { summary: "cut the pause at 0:02", clips: ["c1"] } });
    expect(db.rows[0]!.fix!.ranges.length).toBeGreaterThan(0);
    running = false;
    const end = Date.now() + 5_000;
    while (db.rows[1]!.status !== "queued" && Date.now() < end) await Bun.sleep(20);
    expect(db.rows[1]!.status).toBe("queued");
    // Only asked whether a review was shared from another Mac (reviews.adopt): nothing claimed or shared.
    expect(db.paths.filter((path) => path.startsWith("reviews:") && path !== "reviews:open")).toEqual([]);
  } finally {
    cleanup();
  }
});

test("queued notes ride the next message, whatever it says (Sphe, Nov 3); the one it doesn't answer goes back in the queue", async () => {
  const { app, cleanup } = fixtureHome("notes-send");
  // The turn the send starts: running while it works, done when it's over.
  let running = false;
  const sent: { text: string; context: string }[] = [];
  (app as unknown as { agents: unknown }).agents = {
    chat: () => ({ running }),
    send: async (_id: string, text: string, _model: null, _effort: null, context: string) => {
      sent.push({ text, context });
      running = true;
    },
  };
  try {
    const db = mamagi();
    const id = await judge(app);
    await editNotes.add(app, id, { text: "cut the pause", frame: 60 });
    const router = buildRouter();
    const response = await respond(
      app,
      router,
      new Request(`http://localhost:7700/api/projects/${id}/agent`, {
        method: "POST",
        headers: { host: "localhost:7700", "content-type": "application/json" },
        body: JSON.stringify({ text: "tighten the intro" }),
      }),
      null,
    );
    expect(response?.status).toBe(200);
    expect(sent[0]!.text).toBe("tighten the intro");
    expect(sent[0]!.context).toContain("[app:n1] at 0:02");
    expect(sent[0]!.context).toContain("implement the feedback");
    expect(sent[0]!.context).toContain("don't fix them unasked");
    expect(db.rows[0]!.status).toBe("sent");
    running = false;
    const end = Date.now() + 5_000;
    while (db.rows[0]!.status !== "queued" && Date.now() < end) await Bun.sleep(20);
    expect(db.rows[0]!.status).toBe("queued");
  } finally {
    cleanup();
  }
});

test("Bodycam HQ's comments: numbered as the team sees them, a spot or an area, asks the agent does, and a settled one brought back by its number", async () => {
  const { app, cleanup } = fixtureHome("notes-hq");
  let running = false;
  const sent: { text: string; context: string }[] = [];
  (app as unknown as { agents: unknown }).agents = {
    chat: () => ({ running }),
    send: async (_id: string, text: string, _model: null, _effort: null, context: string) => {
      sent.push({ text, context });
      running = true;
    },
  };
  try {
    const db = mamagi();
    const id = await judge(app);
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    await editNotes.add(app, id, { text: "the ring is late", frame: 60, box: { x: 0.5, y: 0.25, w: 0.0025, h: 0.0025 } });
    await editNotes.add(app, id, { text: "make this card bigger", frame: 90, box: { x: 0.1, y: 0.6, w: 0.3, h: 0.2 } });
    const router = buildRouter();
    await respond(
      app,
      router,
      new Request(`http://localhost:7700/api/projects/${id}/agent`, { method: "POST", headers: { host: "localhost:7700", "content-type": "application/json" }, body: JSON.stringify({ text: "go" }) }),
      null,
    );
    const told = sent[0]!.context;
    // Asks, done whatever the message says, each by its number.
    expect(told).toContain("they're asks");
    expect(told).not.toContain("don't fix them unasked");
    expect(told).toContain("#1 [app:n1]");
    expect(told).toContain("#2 [app:n2]");
    expect(told).toContain("the spot they pinned: 2, -269 px from the frame's centre");
    expect(told).toContain("the area they boxed: centre -480, 216 px from the frame's centre, 576×216 px");
    // Settled, then wanted again: back by its number.
    db.rows[0]!.status = "done";
    const reopen = handlerFor("feedback_reopen")!.handler;
    const said = (await reopen({ app, args: { note: "#1" }, projectId: id, scope: id })) as { text: string }[];
    expect(said[0]!.text).toContain("open again");
    expect(db.rows[0]!.status).toBe("queued");
    await expect(Promise.resolve(reopen({ app, args: { note: "#1" }, projectId: id, scope: id }))).rejects.toThrow("open already");
    await expect(Promise.resolve(reopen({ app, args: { note: "#9" }, projectId: id, scope: id }))).rejects.toThrow("no comment #9");
    running = false;
  } finally {
    cleanup();
  }
});
