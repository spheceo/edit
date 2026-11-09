import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import type { Script } from "@edit/types/writer";

import * as cloud from "../../src/writer/cloud.ts";
import * as store from "../../src/writer/store.ts";

const ID = "4a001eed-86e7-471f-b0c0-3fcc4009a771";

// A relay and R2 in one: Convex's writer functions over the rows here, and presigned addresses that are this server's /r2/.
const rows = new Map<string, Record<string, unknown>>();
const objects = new Map<string, Uint8Array>();
/** Keys whose next GETs fail with a 500, so many times each. */
const failing = new Map<string, number>();
/** What the next listing answers, when a script was saved again between the listing and the pull: the rows as they were. */
let listedBefore: Record<string, unknown>[] | null = null;
let server: ReturnType<typeof Bun.serve>;
let env: Record<string, string | undefined>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/r2/")) {
        const key = decodeURIComponent(url.pathname.slice(4));
        if (request.method === "PUT") {
          objects.set(key, new Uint8Array(await request.arrayBuffer()));
          return new Response("");
        }
        const fails = failing.get(key) ?? 0;
        if (fails > 0) {
          failing.set(key, fails - 1);
          return new Response("", { status: 500 });
        }
        const bytes = objects.get(key);
        return bytes === undefined ? new Response("", { status: 404 }) : new Response(bytes);
      }
      const body = (await request.json()) as Record<string, any>;
      if (url.pathname === "/v1/cloud/writer/r2/url") return Response.json({ url: `${url.origin}/r2/${encodeURIComponent(body.key)}` });
      if (url.pathname === "/v1/cloud/writer/r2/delete") {
        for (const key of body.keys) objects.delete(key);
        return Response.json({});
      }
      if (body.path === "writer:listScripts") {
        const value = listedBefore ?? [...rows.values()];
        listedBefore = null;
        return Response.json({ status: "success", value });
      }
      if (body.path === "writer:getScript") return Response.json({ status: "success", value: rows.get(body.args.scriptId) ?? null });
      if (body.path === "writer:commitScript") {
        const args = body.args;
        const row = rows.get(args.scriptId);
        const rev = Number(row?.rev ?? 0);
        if (args.baseRev !== rev) return Response.json({ status: "error", errorData: { code: "conflict" } });
        const kept = new Set([args.bodyKey, ...(args.files as { key: string }[]).map((file) => file.key)]);
        const stale = [row?.bodyKey, ...((row?.files as { key: string }[] | undefined) ?? []).map((file) => file.key)].filter((key): key is string => typeof key === "string" && !kept.has(key));
        rows.set(args.scriptId, { ...args, scriptId: args.scriptId, rev: rev + 1 });
        return Response.json({ status: "success", value: { rev: rev + 1, stale } });
      }
      return Response.json({ status: "error", errorData: { message: `no ${body.path}` } });
    },
  });
  env = { url: process.env.EDIT_RELAY_URL, token: process.env.EDIT_RELAY_TOKEN };
  process.env.EDIT_RELAY_URL = `http://127.0.0.1:${server.port}`;
  process.env.EDIT_RELAY_TOKEN = "test";
});

afterAll(async () => {
  await server.stop(true);
  for (const [name, value] of [["EDIT_RELAY_URL", env.url], ["EDIT_RELAY_TOKEN", env.token]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

beforeEach(() => {
  listedBefore = null;
  rows.clear();
  objects.clear();
  failing.clear();
});

const script = (change: Partial<Script>): Script =>
  ({ id: ID, title: "Predator Tutor", sourceKind: "drive", sourceUrl: "", originalPath: "", status: "ready", stage: "ready", progress: 100, error: null, durationMs: 0, revision: 1, createdAt: 0, updatedAt: 0, overview: [], proxyPath: null, words: [], clips: [], ...change }) as Script;

const builtClips = [{ kind: "recording" }, { kind: "cut-in" }] as unknown as Script["clips"];

/** The cloud's rev of the script: its body and files, some of them in R2. */
function inCloud(rev: number, body: Script, files: { name: string; bytes?: string }[]): void {
  const bodyKey = `writer/scripts/${ID}/body/${rev}.json`;
  objects.set(bodyKey, new TextEncoder().encode(JSON.stringify(body)));
  const listed = files.map(({ name, bytes }) => {
    const key = `writer/scripts/${ID}/files/r${rev}/${name}`;
    if (bytes !== undefined) objects.set(key, new TextEncoder().encode(bytes));
    return { name, key, size: bytes?.length ?? 842 };
  });
  rows.set(ID, { scriptId: ID, title: body.title, rev, bodyKey, files: listed, updatedBy: "Mathias’s MacBook Pro" });
}

/** This Mac's copy of the script, synced last at `rev` (none: never synced here) and changed since. */
function here(body: Script, rev: number | null): string {
  const data = fs.mkdtempSync(join(os.tmpdir(), "edit-cloud-sync-"));
  const dir = store.scriptDir(data, ID);
  fs.mkdirSync(dir, { recursive: true });
  store.write(dir, body);
  fs.mkdirSync(join(data, "cloud"), { recursive: true });
  const scripts = rev === null ? {} : { [ID]: { rev, body: "what this Mac pushed last", files: {}, summary: 2 } };
  fs.writeFileSync(join(data, "cloud", "ledger.json"), JSON.stringify({ scripts }));
  return data;
}

const copies = (data: string): string[] => store.ids(data).filter((id) => id !== ID).map((id) => store.read(store.scriptDir(data, id)).title);

/** This Mac's ledger for the script, at `rev`, naming `files` (the body hash is stale, so a sync pushes). */
function ledger(data: string, rev: number, files: Record<string, { key: string; size: number; mtime: number }>): void {
  fs.writeFileSync(join(data, "cloud", "ledger.json"), JSON.stringify({ scripts: { [ID]: { rev, body: "what this Mac pushed last", files, summary: 2 } } }));
}

const cloudFiles = (): { name: string; key: string }[] => (rows.get(ID)?.files as { name: string; key: string }[] | undefined) ?? [];

// Nov 3, Predator Dad: playback 404'd because a Mac that didn't hold the
// preview pushed the script, and the commit took the preview out of the
// cloud's list (then deleted it from R2). The local copy was already gone.
test("a save from a Mac that doesn't hold the preview keeps the cloud's copy", async () => {
  const preview = "the preview";
  inCloud(4, script({ title: "Predator Dad", revision: 4 }), [{ name: "proxy.mp4", bytes: preview }]);
  const key = `writer/scripts/${ID}/files/r4/proxy.mp4`;
  const data = here(script({ title: "Predator Dad", revision: 5 }), 4);
  // At the cloud's rev, but the ledger never recorded the preview (an older
  // Edit left footage out of it), and the file isn't on this Mac.
  ledger(data, 4, {});

  await cloud.syncOnceForTests(data);

  expect(cloudFiles().find((file) => file.name === "proxy.mp4")?.key).toBe(key);
  expect(new TextDecoder().decode(objects.get(key)!)).toBe(preview);
});

test("saving this Mac's built script over an unbuilt cloud rev keeps that rev's preview", async () => {
  const preview = "the preview";
  inCloud(7, script({ title: "Predator Dad", clips: [], revision: 7 }), [{ name: "proxy.mp4", bytes: preview }]);
  const key = `writer/scripts/${ID}/files/r7/proxy.mp4`;
  const data = here(script({ title: "Predator Dad", clips: builtClips, revision: 6 }), 5);

  await cloud.syncOnceForTests(data);

  expect(cloudFiles().find((file) => file.name === "proxy.mp4")?.key).toBe(key);
  expect(new TextDecoder().decode(objects.get(key)!)).toBe(preview);
});

test("a file removed on this Mac stays removed, and one left to the cloud stays listed", async () => {
  inCloud(4, script({ revision: 4 }), [
    { name: "chat.json", bytes: "[]" },
    { name: "research.json", bytes: "{}" },
  ]);
  const data = here(script({ revision: 5 }), 4);
  ledger(data, 4, {
    "chat.json": { key: `writer/scripts/${ID}/files/r4/chat.json`, size: 2, mtime: 0 },
    "research.json": { key: `writer/scripts/${ID}/files/r4/research.json`, size: 2, mtime: 0 },
  });
  fs.mkdirSync(join(data, "cloud"), { recursive: true });
  fs.writeFileSync(join(data, "cloud", "storage.json"), JSON.stringify({ [ID]: ["research.json"] }));

  await cloud.syncOnceForTests(data);

  const names = cloudFiles().map((file) => file.name);
  expect(names).not.toContain("chat.json");
  expect(names).toContain("research.json");
  expect(objects.has(`writer/scripts/${ID}/files/r4/research.json`)).toBe(true);
  expect(objects.has(`writer/scripts/${ID}/files/r4/chat.json`)).toBe(false);
});

// Oct 31: Predator Tutor's rev 7 named an edit-shared.json no longer in the
// cloud, so a Mac pulling it kept its own version as a conflicted copy, failed
// on the file, and did both again a minute later: 294 copies from Mathias's Mac.
test("a rev naming a file that isn't in the cloud comes down without it, and this Mac's version is kept once", async () => {
  inCloud(7, script({ title: "Predator Tutor", clips: builtClips, revision: 7 }), [{ name: "chat.json", bytes: "[]" }, { name: "edit-shared.json" }]);
  const data = here(script({ title: "Predator Tutor", clips: builtClips, revision: 6 }), 5);

  await cloud.syncOnceForTests(data);
  await cloud.syncOnceForTests(data);

  expect(copies(data)).toEqual(["Predator Tutor (conflicted copy)"]);
  expect(store.read(store.scriptDir(data, ID)).revision).toBe(7);
  expect(fs.readFileSync(join(store.scriptDir(data, ID), "chat.json"), "utf8")).toBe("[]");
  expect(cloud.revOf(data, ID)).toBeGreaterThanOrEqual(7);
});

test("a pull that fails after keeping this Mac's version and is tried again keeps no second copy", async () => {
  inCloud(7, script({ clips: builtClips, revision: 7 }), [{ name: "chat.json", bytes: "[]" }]);
  failing.set(`writer/scripts/${ID}/files/r7/chat.json`, 1);
  const data = here(script({ clips: builtClips, revision: 6 }), 5);

  await cloud.syncOnceForTests(data).catch(() => undefined);
  expect(copies(data)).toHaveLength(1);
  await cloud.syncOnceForTests(data);

  expect(copies(data)).toHaveLength(1);
  expect(store.read(store.scriptDir(data, ID)).revision).toBe(7);
});

// Oct 31, M's Mac: four imports that never finished here (Writer's copies,
// brought in by Edit) became conflicted copies, each then a stopped import.
test("an import that never finished here is replaced by the cloud's script, not kept as a copy", async () => {
  for (const stale of [script({ status: "processing", stage: "transcribing", progress: 60 }), script({ status: "error", error: "None of the recordings came through." })]) {
    rows.clear();
    inCloud(14, script({ clips: builtClips, revision: 14 }), []);
    const data = here(stale, null);

    await cloud.syncOnceForTests(data);

    expect(copies(data)).toEqual([]);
    expect(store.read(store.scriptDir(data, ID))).toMatchObject({ status: "ready", revision: 14 });
  }
});

// JJ's Mac, Nov 4: 12,032 folders among the scripts with no script.json, each
// a clone of one: a script whose pull was cut short (its chat and files came
// down, its body never) was deleted on another Mac, and each pull, every 30 s
// for days, copied the folder to keep "this Mac's version", found no script in
// the copy and gave up, leaving it. A folder with no body has no version here.
test("a script deleted elsewhere whose folder here has no body is removed, never copied", async () => {
  for (const syncedAt of [null, 3]) {
    rows.clear();
    rows.set(ID, { scriptId: ID, title: "Interrogation compilation", rev: 4, deletedAt: 1, files: [] });
    const data = here(script({}), syncedAt);
    const dir = store.scriptDir(data, ID);
    fs.rmSync(join(dir, "script.json"));
    fs.writeFileSync(join(dir, "chat.json"), "[]");

    for (let round = 0; round < 3; round++) await cloud.syncOnceForTests(data);

    expect(fs.readdirSync(store.scriptsRoot(data))).toEqual([]);
  }
});

// Nov 9: Marc wrote a script a save a minute, and the Macs following it (one
// of them untouched for two days) kept ten "(conflicted copy)" scripts of his.
// A pull held the row of a revision his next save had already replaced, found
// its body gone, and took that for a lost body: its own older copy went up
// "as the next revision", was refused, and was then kept as a copy.
test("a script saved again while it comes down is taken at the newer revision: nothing here goes up, and no copy is kept", async () => {
  inCloud(4, script({ title: "Cop Kicks", revision: 4 }), [{ name: "chat.json", bytes: "four" }]);
  const data = fs.mkdtempSync(join(os.tmpdir(), "edit-cloud-sync-"));
  await cloud.syncOnceForTests(data);
  expect(store.read(store.scriptDir(data, ID)).revision).toBe(4);

  // Rev 5 is listed; before its body is fetched, rev 6 is saved and rev 5's body and files are removed.
  inCloud(5, script({ title: "Cop Kicks", revision: 5 }), [{ name: "chat.json", bytes: "five" }]);
  const stale = [{ ...rows.get(ID)! }];
  objects.delete(`writer/scripts/${ID}/body/5.json`);
  objects.delete(`writer/scripts/${ID}/files/r5/chat.json`);
  inCloud(6, script({ title: "Cop Kicks", revision: 6 }), [{ name: "chat.json", bytes: "six!" }]);
  listedBefore = stale;
  await cloud.syncOnceForTests(data);

  expect(store.read(store.scriptDir(data, ID)).revision).toBe(6);
  expect(fs.readFileSync(join(store.scriptDir(data, ID), "chat.json"), "utf8")).toBe("six!");
  expect(copies(data)).toEqual([]);
  expect(rows.get(ID)!.rev).toBe(6);
  // And the next round has nothing to send.
  await cloud.syncOnceForTests(data);
  expect(rows.get(ID)!.rev).toBe(6);
  expect(copies(data)).toEqual([]);
});

test("a file gone because the script was saved again is fetched from the newer revision, not left out and sent up from here", async () => {
  inCloud(4, script({ title: "Cop Kicks", revision: 4 }), [{ name: "chat.json", bytes: "four" }]);
  const data = fs.mkdtempSync(join(os.tmpdir(), "edit-cloud-sync-"));
  await cloud.syncOnceForTests(data);

  // Rev 5's body is still there when the pull reads it; its chat was replaced by rev 6's.
  inCloud(5, script({ title: "Cop Kicks", revision: 5 }), [{ name: "chat.json", bytes: "five" }]);
  const stale = [{ ...rows.get(ID)! }];
  objects.delete(`writer/scripts/${ID}/files/r5/chat.json`);
  inCloud(6, script({ title: "Cop Kicks", revision: 6 }), [{ name: "chat.json", bytes: "six!" }]);
  listedBefore = stale;
  await cloud.syncOnceForTests(data);

  expect(store.read(store.scriptDir(data, ID)).revision).toBe(6);
  expect(fs.readFileSync(join(store.scriptDir(data, ID), "chat.json"), "utf8")).toBe("six!");
  expect(copies(data)).toEqual([]);
  await cloud.syncOnceForTests(data);
  expect(rows.get(ID)!.rev).toBe(6);
  expect(cloudFiles().find((file) => file.name === "chat.json")?.key).toBe(`writer/scripts/${ID}/files/r6/chat.json`);
});
