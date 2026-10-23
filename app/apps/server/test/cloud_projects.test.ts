import { afterAll, beforeAll, expect, test } from "bun:test";

import * as fs from "node:fs";

import * as cloud from "../src/cloud.ts";
import {
  BACKOFF_MAX,
  Cloud,
  conflictedName,
  Entry,
  liveHolder,
  open,
  readSettings,
  readState,
  remote,
  remove,
  routes,
  runStep,
  SETTINGS,
  STATE,
  STATE_DIR,
  summary,
  takeOver,
  writePrivate,
  list,
  creatorOf,
} from "../src/cloud_projects.ts";
import { baseRouter, respond } from "../src/http/server.ts";
import type { Project } from "../src/model.ts";
import { newProject } from "../src/project.ts";
import { nowMs, type Event } from "../src/store.ts";
import { fixtureHome, scratch } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

const SETTINGS_1080 = { width: 1920, height: 1080, fps: 30 };

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

const at = (start: number, seconds: number) => start + seconds * 1000;

test("a_new_project_takes_the_lock_then_pushes_after_a_pause", () => {
  const t0 = 1_000_000;
  const entry = Entry.fresh();
  expect(entry.lock).toEqual({ kind: "provisional" });
  // New: dirty from the start, so the lock is asked for straight away.
  expect(entry.step(t0)).toBe("Acquire");
  entry.acquired("token", t0);
  entry.wrote(t0);
  // Edits keep coming: the push waits for a pause.
  expect(entry.step(at(t0, 1))).toBeNull();
  entry.wrote(at(t0, 1));
  expect(entry.step(at(t0, 2))).toBeNull();
  expect(entry.step(at(t0, 3))).toBe("Push");
  // A change during the push keeps it dirty for another.
  const edits = entry.edits;
  entry.wrote(at(t0, 3));
  entry.pushed(1, edits);
  expect(entry.saved.dirty).toBe(true);
  expect(entry.saved.rev).toBe(1);
  expect(entry.step(at(t0, 6))).toBe("Push");
  entry.pushed(2, entry.edits);
  expect(entry.saved.dirty).toBe(false);
  expect(entry.status(true).sync).toBe("synced");
});

test("a_held_lock_is_kept_while_working_and_let_go_when_idle_even_open", () => {
  const t0 = 1_000_000;
  const entry = new Entry({ rev: 0, dirty: false });
  entry.viewers.set("ui", t0);
  // Looking on doesn't take it (it checks who has it); an agent turn here does.
  expect(entry.step(t0)).toBe("Check");
  expect(entry.step(t0, true)).toBe("Acquire");
  entry.acquired("token", t0);
  entry.changedAt = t0;
  expect(entry.step(at(t0, 10))).toBeNull();
  entry.viewers.set("ui", at(t0, 30));
  expect(entry.step(at(t0, 45))).toBe("Renew");
  entry.renewedAt = at(t0, 45);
  // A turn still running keeps it past the quiet minute.
  expect(entry.step(at(t0, 70), true)).toBeNull();
  // Open but idle (nothing changed for a minute, nothing running): let go, so a teammate can carry on.
  entry.viewers.set("ui", at(t0, 69));
  expect(entry.step(at(t0, 70))).toBe("Release");
  entry.released();
  expect(entry.lock).toEqual({ kind: "unknown" });
  expect(entry.saved.token).toBeUndefined();
  // Still open: it watches who has it, without taking it.
  expect(entry.step(at(t0, 71))).toBe("Check");
});

test("closing_pushes_at_once_then_releases", () => {
  const t0 = 1_000_000;
  const entry = new Entry({ rev: 3, dirty: false, token: "t" });
  entry.renewedAt = t0;
  entry.viewers.set("ui", t0);
  entry.wrote(t0);
  entry.viewers.clear();
  entry.closing = true;
  // No waiting for the pause.
  expect(entry.step(t0)).toBe("Push");
  entry.pushed(4, entry.edits);
  expect(entry.step(t0)).toBe("Release");
  // Let go, it stays let go (the recent change doesn't take it again).
  const released = new Entry(entry.saved);
  released.changedAt = entry.changedAt;
  released.released();
  expect(released.step(at(t0, 1))).toBeNull();
  // An agent still writing keeps it.
  entry.wrote(at(t0, 1));
  expect(entry.closing).toBe(false);
  expect(entry.step(at(t0, 1))).toBeNull();
});

test("offline_edits_are_allowed_and_retried_with_backoff", () => {
  const t0 = 1_000_000;
  const entry = new Entry({ rev: 2, dirty: false });
  entry.wrote(t0);
  expect(entry.step(t0)).toBe("Acquire");
  entry.unreachable(t0);
  // Unknown becomes provisional: edits go on, queued.
  expect(entry.lock).toEqual({ kind: "provisional" });
  expect(entry.status(true).sync).toBe("offline");
  expect(entry.step(at(t0, 4))).toBeNull();
  expect(entry.step(at(t0, 5))).toBe("Acquire");
  entry.unreachable(at(t0, 5));
  expect(entry.step(at(t0, 14))).toBeNull();
  expect(entry.step(at(t0, 15))).toBe("Acquire");
  for (let n = 0; n < 10; n++) entry.unreachable(at(t0, 15));
  expect(entry.retryAt).toBe(at(t0, 15) + BACKOFF_MAX);
  entry.acquired("t", at(t0, 100));
  expect(entry.offline).toBe(false);
  expect(entry.step(at(t0, 100))).toBe("Push");
});

test("someone_elses_lock_is_read_only_and_watched_while_open", () => {
  const t0 = 1_000_000;
  const entry = new Entry({ rev: 0, dirty: false });
  entry.elsewhere("kenobi", t0);
  const status = entry.status(true);
  expect(status.sync).toBe("readonly");
  expect(status.holder).toBe("kenobi");
  // Nobody here looking: left alone.
  expect(entry.step(at(t0, 30))).toBeNull();
  entry.viewers.set("ui", at(t0, 30));
  expect(entry.step(at(t0, 30))).toBe("Check");
  entry.checkedAt = at(t0, 30);
  expect(entry.step(at(t0, 35))).toBeNull();
  expect(entry.step(at(t0, 40))).toBe("Check");
  // A pull asked for goes first, whatever the lock.
  entry.wantPull = true;
  expect(entry.step(at(t0, 41))).toBe("Pull");
});

test("a_busy_entry_waits_and_cloud_off_says_so", () => {
  const t0 = 1_000_000;
  const entry = Entry.fresh();
  entry.busy = "Acquire";
  expect(entry.step(t0)).toBeNull();
  expect(entry.status(false).sync).toBe("off");
  entry.busy = "Push";
  expect(entry.status(true).sync).toBe("syncing");
  entry.busy = null;
  entry.note = { kind: "conflict", message: "kept" };
  expect(entry.status(true).sync).toBe("conflict");
  expect(entry.status(true).message).toBe("kept");
  entry.pushed(1, entry.edits);
  expect(entry.status(true).sync).toBe("synced");
});

test("a_long_push_or_pull_keeps_the_lease_alive_beside_it", () => {
  const t0 = 1_000_000;
  const entry = new Entry({ rev: 3, dirty: true, token: "t" });
  entry.renewedAt = t0;
  entry.busy = "Push";
  // Nothing due yet, and the step itself can't renew while it runs.
  expect(entry.keepAliveDue(at(t0, 30))).toBe(false);
  expect(entry.step(at(t0, 50))).toBeNull();
  expect(entry.keepAliveDue(at(t0, 50))).toBe(true);
  entry.renewing = true;
  expect(entry.keepAliveDue(at(t0, 51))).toBe(false);
  entry.renewing = false;
  // Never beside a renewal or release of its own, nor for a lock not held.
  entry.busy = "Renew";
  expect(entry.keepAliveDue(at(t0, 50))).toBe(false);
  entry.busy = "Pull";
  entry.lock = { kind: "elsewhere", holder: "kenobi" };
  expect(entry.keepAliveDue(at(t0, 50))).toBe(false);
});

test("a_token_from_before_a_restart_is_renewed_first", () => {
  const entry = new Entry({ rev: 5, dirty: false, token: "old" });
  expect(entry.lock).toEqual({ kind: "held" });
  entry.viewers.set("ui", performance.now());
  // A turn picked up again after the restart keeps it; idle, it's let go.
  expect(entry.step(performance.now(), true)).toBe("Renew");
  expect(entry.step(performance.now())).toBe("Release");
});

test("settings_are_private_and_writes_follow_the_lock", () => {
  const { dir: home, cleanup } = scratch("cloud-settings");
  try {
    // The setting holds the token: this user only.
    const settings = { token: "secret-token", holder: "Sphe's Mac" };
    writePrivate(`${home}/${SETTINGS}`, JSON.stringify(settings));
    expect(fs.statSync(`${home}/${SETTINGS}`).mode & 0o777).toBe(0o600);
    expect(readSettings(home)).toEqual(settings);

    // Writes follow the lock: someone else's is refused, saying who.
    const entry = new Entry({ rev: 0, dirty: false });
    const now = performance.now();
    expect(entry.permission(now)).toEqual({ kind: "ask" });
    entry.elsewhere("kenobi", now);
    const refused = entry.permission(now);
    expect(refused.kind === "refuse" && refused.why.startsWith("kenobi is editing")).toBe(true);
    // Old news is checked again: they may have let go.
    expect(entry.permission(at(now, 11))).toEqual({ kind: "ask" });
    entry.acquired("t", now);
    expect(entry.permission(now)).toEqual({ kind: "allow" });
    expect(Entry.fresh().permission(now)).toEqual({ kind: "allow" });

    // What's kept per project survives a restart (no global settings
    // touched: `Cloud.open` isn't used here).
    const kept = new Cloud(home, "kenobi", settings);
    kept.projects.set("p3-3", Entry.fresh());
    kept.wrote("p3-3");
    kept.projects.set("p4-4", new Entry({ rev: 9, dirty: false, token: "lock" }));
    kept.persist();
    expect(fs.statSync(`${home}/${STATE_DIR}/${STATE}`).mode & 0o777).toBe(0o600);
    const state = readState(home);
    expect(state.get("p3-3")!.dirty).toBe(true);
    expect(state.get("p4-4")!.rev).toBe(9);
    expect(new Entry(state.get("p4-4")!).lock).toEqual({ kind: "held" });
    // serde's shape: the token left out when there's none.
    expect(JSON.parse(fs.readFileSync(`${home}/${STATE_DIR}/${STATE}`, "utf8"))).toEqual({
      "p3-3": { rev: 0, dirty: true },
      "p4-4": { rev: 9, dirty: false, token: "lock" },
    });
    if (process.env.EDIT_CLOUD_HOLDER === undefined) expect(kept.holder()).toBe("Sphe's Mac");
  } finally {
    cleanup();
  }
});

test("summaries_and_copies_read_well", () => {
  const project = newProject("p1-1", "Case", SETTINGS_1080);
  const said = summary(project);
  expect(said.clips).toBe(0);
  expect(said.fps).toBe(project.settings.fps);
  expect(JSON.stringify(said).length < 64 * 1024).toBe(true);
  expect(conflictedName("Case")).toBe("Case (conflicted copy)");
  expect(liveHolder({ holder: "kenobi", until: nowMs() + 60_000 })).toBe("kenobi");
  expect(liveHolder({ holder: "kenobi", until: 1 })).toBeNull();
  expect(liveHolder(null)).toBeNull();
});

// ---------------------------------------------------------------------------
// Against the mock relay's Convex: whole flows, as the loop runs them.

function setup(name: string) {
  const fixture = fixtureHome(name, { machine: "this-mac" });
  const projects = new Cloud(fixture.home, "this-mac");
  projects.attach(fixture.store);
  const events: Event[] = [];
  fixture.store.subscribe((event) => events.push(event));
  return { ...fixture, projects, events };
}

test("a new project takes the lock on its first push, which lands as rev 1 with its summary", async () => {
  const { app, store, projects, cleanup } = setup("cloud-push");
  try {
    const id = store.create("Case", SETTINGS_1080).project.id;
    expect(projects.isCloud(id)).toBe(true);
    await runStep(app, projects, id, "Acquire");
    expect(projects.status(id).lock).toBe("held");
    await store.update(id, "test", (project) => {
      project.name = "Case 2";
    });
    await runStep(app, projects, id, "Push");
    expect(projects.status(id)).toMatchObject({ sync: "synced", rev: 1, dirty: false });
    const row = mock.cloud.convex.projects.get(id)!;
    expect(row.rev).toBe(1);
    expect(row.updatedBy).toBe("this-mac");
    expect(row.summary).toMatchObject({ clips: 0, media: 0, width: 1920, subtitles: false });
    expect(mock.cloud.convex.body(id)!.name).toBe("Case 2");
    // Let go: anyone may take it now.
    await runStep(app, projects, id, "Release");
    expect(mock.cloud.convex.locks.has(id)).toBe(false);
    expect(projects.status(id).lock).toBe("unknown");
  } finally {
    cleanup();
  }
});

test("a write to a project someone else holds is refused, saying who; one nobody holds takes the lock first", async () => {
  const { store, projects, cleanup } = setup("cloud-refuse");
  try {
    const theirs = store.create("Theirs", SETTINGS_1080).project.id;
    const mine = store.create("Mine", SETTINGS_1080).project.id;
    for (const id of [theirs, mine]) projects.projects.set(id, new Entry({ rev: 0, dirty: false }));
    mock.cloud.convex.lockFor(theirs, "kenobi");
    await expect(store.update(theirs, "agent", (project) => void (project.name = "x"))).rejects.toThrow(
      "kenobi is editing this project, so it's read-only here until they close it (or you take over in the editor).",
    );
    expect(projects.status(theirs)).toMatchObject({ lock: "elsewhere", holder: "kenobi", sync: "readonly" });
    // Asked again only once it's old news.
    const asked = mock.calls("/v1/cloud/convex").length;
    await expect(store.update(theirs, "agent", () => {})).rejects.toThrow("kenobi is editing");
    expect(mock.calls("/v1/cloud/convex").length).toBe(asked);
    await store.update(mine, "agent", (project) => void (project.name = "Mine 2"));
    expect(projects.status(mine)).toMatchObject({ lock: "held", dirty: true, sync: "pending" });
    expect(mock.cloud.convex.locks.get(mine)!.holder).toBe("this-mac");
  } finally {
    cleanup();
  }
});

test("offline, writes go ahead and are queued", async () => {
  const { store, projects, cleanup } = setup("cloud-offline");
  try {
    const id = store.create("Case", SETTINGS_1080).project.id;
    projects.projects.set(id, new Entry({ rev: 2, dirty: false }));
    const back = mock.useEnv({ EDIT_RELAY_URL: "http://127.0.0.1:9" });
    try {
      await store.update(id, "agent", (project) => void (project.name = "offline edit"));
    } finally {
      back();
    }
    expect(projects.status(id)).toMatchObject({ lock: "provisional", sync: "offline", dirty: true });
  } finally {
    cleanup();
  }
});

test("a conflict keeps this machine's changes as a conflicted copy and takes the cloud's version", async () => {
  const { app, store, projects, events, cleanup } = setup("cloud-conflict");
  try {
    const id = store.create("Case", SETTINGS_1080).project.id;
    await runStep(app, projects, id, "Acquire");
    await runStep(app, projects, id, "Push");
    // Another machine saves rev 2 meanwhile (its lock came and went).
    const theirs: Project = { ...structuredClone(store.get(id)!.project), name: "Case (their edit)" };
    mock.cloud.convex.saveElsewhere(theirs as unknown as Record<string, unknown>, "kenobi");
    await store.update(id, "test", (project) => void (project.name = "Case (my edit)"));
    await runStep(app, projects, id, "Push");
    expect(store.get(id)!.project.name).toBe("Case (their edit)");
    const copy = store.list().find((summary) => summary.name === "Case (my edit) (conflicted copy)");
    expect(copy).toBeDefined();
    expect(projects.isCloud(copy!.id)).toBe(false);
    expect(projects.status(id)).toMatchObject({ sync: "conflict", rev: 2, dirty: false });
    expect(String(projects.status(id).message)).toBe(
      "“Case (my edit)” was changed on another machine meanwhile, so the cloud's version is open. Your changes here are kept as “Case (my edit) (conflicted copy)” on this Mac.",
    );
    const said = events.find((event) => event.type === "cloud-conflict");
    expect(said).toMatchObject({ id, copy: { id: copy!.id, name: "Case (my edit) (conflicted copy)" } });
    // Nothing of theirs was overwritten.
    expect(mock.cloud.convex.body(id)!.name).toBe("Case (their edit)");
  } finally {
    cleanup();
  }
});

test("a project from the cloud says who started it: its own record, else Convex's (from before Edit kept one)", async () => {
  const { store, projects, cleanup } = setup("cloud-creator");
  try {
    expect(creatorOf({ sub: "s1", name: "Kenobi", picture: "https://lh3.googleusercontent.com/a/k=s96-c" })).toEqual({ sub: "s1", name: "Kenobi", picture: "https://lh3.googleusercontent.com/a/k=s96-c" });
    expect(creatorOf({ sub: "s1", name: "Kenobi" })).toEqual({ sub: "s1", name: "Kenobi" });
    for (const nobody of [null, {}, { sub: "", name: "x" }, { sub: "s1" }, "s1"]) expect(creatorOf(nobody)).toBeNull();
    const id = store.create("Case", SETTINGS_1080).project.id;
    const body = structuredClone(store.get(id)!.project) as unknown as Record<string, unknown>;
    delete body.created_by;
    mock.cloud.convex.saveElsewhere({ ...body, name: "kenobi's" }, "kenobi", { sub: "s1", name: "Kenobi", email: "kenobi@example.com" });
    projects.projects.set(id, new Entry({ rev: 0, dirty: false }));
    await store.update(id, "agent", (project) => void (project.name += " + agent"));
    expect(store.get(id)!.project).toMatchObject({ name: "kenobi's + agent", created_by: { sub: "s1", name: "Kenobi" } });
    // Never the email.
    expect(JSON.stringify(store.get(id)!.project)).not.toContain("kenobi@");
  } finally {
    cleanup();
  }
});

test("a save landing while the lock's first download runs is never written over", async () => {
  const { store, projects, cleanup } = setup("cloud-claim-race");
  const download = remote.download;
  try {
    const id = store.create("Case", SETTINGS_1080).project.id;
    // Kenobi saved a newer version; this machine hasn't asked about the lock yet.
    mock.cloud.convex.saveElsewhere({ ...structuredClone(store.get(id)!.project), name: "kenobi's" } as unknown as Record<string, unknown>, "kenobi");
    projects.projects.set(id, new Entry({ rev: 0, dirty: false }));
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = () => {};
    const downloading = new Promise<void>((resolve) => {
      started = resolve;
    });
    remote.download = async (url) => {
      started();
      await held;
      return download(url);
    };
    const first = store.update(id, "agent", (project) => void (project.name += " + agent"));
    await downloading;
    // The lock is ours now: the editor's save goes ahead meanwhile.
    await store.update(id, "ui", (project) => void (project.name = "my save"));
    release();
    await first;
    expect(store.get(id)!.project.name).toBe("my save + agent");
    expect(projects.dirty(id)).toBe(true);
  } finally {
    remote.download = download;
    cleanup();
  }
});

test("losing the lock with changes not pushed keeps them as a copy and goes read-only on the new holder's version", async () => {
  const { app, store, projects, cleanup } = setup("cloud-lost");
  try {
    const id = store.create("Case", SETTINGS_1080).project.id;
    await runStep(app, projects, id, "Acquire");
    await runStep(app, projects, id, "Push");
    await store.update(id, "test", (project) => void (project.name = "unpushed"));
    // Kenobi takes over (force) and saves.
    const token = mock.cloud.convex.lockFor(id, "kenobi");
    expect(token).toContain("their-token");
    mock.cloud.convex.saveElsewhere({ ...structuredClone(store.get(id)!.project), name: "kenobi's" } as unknown as Record<string, unknown>, "kenobi");
    await runStep(app, projects, id, "Renew");
    expect(projects.status(id)).toMatchObject({ lock: "elsewhere", holder: "kenobi", sync: "readonly" });
    expect(store.get(id)!.project.name).toBe("kenobi's");
    expect(store.list().some((summary) => summary.name === "unpushed (conflicted copy)")).toBe(true);
    expect(String(projects.status(id).message)).toBe(
      "kenobi took over “unpushed” before your last changes reached the cloud. They're kept as “unpushed (conflicted copy)” on this Mac.",
    );
    // Taking it back (force) shows their latest version, and it's ours again.
    await takeOver(app, id);
    expect(projects.status(id)).toMatchObject({ lock: "held", holder: null });
    expect(mock.cloud.convex.locks.get(id)!.holder).toBe("this-mac");
  } finally {
    cleanup();
  }
});

test("opening a project only in the cloud downloads it, and an unknown one is no such project", async () => {
  const { app, store, projects, cleanup } = setup("cloud-open");
  try {
    const project = newProject("p42-1", "From kenobi", SETTINGS_1080);
    mock.cloud.convex.saveElsewhere(project as unknown as Record<string, unknown>, "kenobi");
    const status = await open(app, "p42-1", "ui-1");
    expect(store.get("p42-1")!.project.name).toBe("From kenobi");
    expect(status).toMatchObject({ cloud: true, lock: "held", rev: 1, sync: "synced" });
    await expect(open(app, "p404-1", "ui-1")).rejects.toThrow("no such project");
    expect(projects.isCloud("p404-1")).toBe(false);
    // The cloud's list says where each is.
    const listed = (await list(app)) as { projects: Record<string, unknown>[]; holder: string };
    expect(listed.holder).toBe("this-mac");
    expect(listed.projects.find((item) => item.id === "p42-1")).toMatchObject({ name: "From kenobi", local: true, here: true, rev: 1 });
  } finally {
    cleanup();
  }
});

test("deleting is refused while someone else edits it or the cloud can't be reached", async () => {
  const { app, store, projects, cleanup } = setup("cloud-delete");
  try {
    const id = store.create("Case", SETTINGS_1080).project.id;
    await runStep(app, projects, id, "Acquire");
    await runStep(app, projects, id, "Push");
    await runStep(app, projects, id, "Release");
    mock.cloud.convex.lockFor(id, "kenobi");
    await expect(remove(app, id)).rejects.toThrow("Can't delete it: kenobi is editing it.");
    mock.cloud.convex.locks.delete(id);
    const back = mock.useEnv({ EDIT_RELAY_URL: "http://127.0.0.1:9" });
    try {
      await expect(remove(app, id)).rejects.toThrow("Can't reach the cloud to delete it there too; try again when you're online.");
    } finally {
      back();
    }
    expect(await remove(app, id)).toBe(true);
    expect(projects.isCloud(id)).toBe(false);
    expect(mock.cloud.convex.projects.has(id)).toBe(false);
    // Only on this machine: nothing to do in the cloud.
    const local = store.create("Local", SETTINGS_1080).project.id;
    projects.forget(local);
    expect(await remove(app, local)).toBe(false);
  } finally {
    cleanup();
  }
});

test("the cloud routes: settings (private, checked), status, open and close, take over", async () => {
  const { app, home, store, projects, cleanup } = setup("cloud-routes");
  const router = baseRouter();
  routes(router);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = (await respond(
      app,
      router,
      new Request(`http://127.0.0.1:7700${path}`, {
        method,
        headers: body === undefined ? { host: "localhost:7700" } : { host: "localhost:7700", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      null,
    ))!;
    const text = await response.text();
    return { status: response.status, body: (text.startsWith("{") ? JSON.parse(text) : { text }) as Record<string, unknown> };
  };
  try {
    const settings = await call("GET", "/api/cloud?check=true");
    expect(settings).toEqual({
      status: 200,
      body: { connected: true, holder: "this-mac", on: true, problem: null, relay: mock.url, token: "env" },
    });
    const refused = await call("POST", "/api/cloud", { token: "two words" });
    expect(refused).toEqual({ status: 400, body: { error: "That doesn't look like a cloud token (one line, no spaces)." } });
    const named = await call("POST", "/api/cloud", { holder: "  Sphe's Mac  " });
    expect(named.body.holder).toBe("Sphe's Mac");
    expect(fs.statSync(`${home}/cloud.json`).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(`${home}/cloud.json`, "utf8"))).toEqual({ holder: "Sphe's Mac" });
    expect(await call("POST", "/api/cloud", { holder: 5 })).toEqual({
      status: 422,
      body: { text: "Failed to deserialize the JSON body into the target type: holder: invalid type: integer `5`, expected a string at line 1 column 11" },
    });

    const id = store.create("Case", SETTINGS_1080).project.id;
    const opened = await call("POST", `/api/projects/${id}/cloud/open`, { client: "ui-1" });
    expect(opened.body).toMatchObject({ cloud: true, lock: "held" });
    expect(mock.cloud.convex.locks.get(id)!.holder).toBe("Sphe's Mac");
    const beat = await call("POST", `/api/projects/${id}/cloud/open`, { client: "ui-1", heartbeat: true });
    expect(beat.body.lock).toBe("held");
    expect((await call("GET", `/api/projects/${id}/cloud`)).body.cloud).toBe(true);
    expect((await call("GET", "/api/projects/nope/cloud")).body).toEqual({ cloud: false, on: true });
    expect(await call("POST", `/api/projects/${id}/cloud/close`, { client: "ui-1" })).toEqual({ status: 200, body: { ok: true } });
    expect(projects.projects.get(id)!.closing).toBe(true);
    const notCloud = await call("POST", "/api/projects/p9-9/cloud/takeover");
    expect(notCloud).toEqual({ status: 409, body: { error: "this isn't a cloud project" } });
    expect(await call("POST", "/api/projects/p9-9/cloud/upload")).toEqual({ status: 400, body: { error: "no such project" } });
    expect(await call("POST", "/api/projects/p9-9/cloud/open", { client: "ui-1" })).toEqual({ status: 404, body: { error: "no such project" } });
    // With no sign-in (and no EDIT_RELAY_TOKEN) the cloud is off.
    process.env.EDIT_RELAY_TOKEN = "";
    try {
      const off = await call("GET", "/api/cloud");
      expect([off.body.on, off.body.token]).toEqual([false, null]);
    } finally {
      process.env.EDIT_RELAY_TOKEN = "cloud-token";
    }
  } finally {
    cleanup();
  }
});

test("no cloud attached: the settings say so and statuses are local", async () => {
  const fixture = fixtureHome("cloud-none");
  const router = baseRouter();
  routes(router);
  try {
    const response = (await respond(fixture.app, router, new Request("http://localhost:7700/api/cloud", { headers: { host: "localhost:7700" } }), null))!;
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no cloud here" });
    expect(await open(fixture.app, "p1-1", "ui")).toEqual({ cloud: false, on: false });
    expect(await remove(fixture.app, "p1-1")).toBe(false);
  } finally {
    fixture.cleanup();
  }
});
