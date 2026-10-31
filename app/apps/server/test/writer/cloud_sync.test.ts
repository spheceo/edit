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
      if (body.path === "writer:listScripts") return Response.json({ status: "success", value: [...rows.values()] });
      if (body.path === "writer:commitScript") {
        const args = body.args;
        const rev = Number(rows.get(args.scriptId)?.rev ?? 0);
        if (args.baseRev !== rev) return Response.json({ status: "error", errorData: { code: "conflict" } });
        rows.set(args.scriptId, { ...args, rev: rev + 1 });
        return Response.json({ status: "success", value: { rev: rev + 1 } });
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
