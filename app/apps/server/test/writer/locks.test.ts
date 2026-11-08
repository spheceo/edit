// Writer scripts join the cloud lock edits have (Nov 8 audit, item C): nine
// "(conflicted copy)" scripts on the team's Macs came from two Macs pushing
// the same scripts with no lock, and from commits whose answer was lost.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import type { Script } from "@edit/types/writer";

import * as cloud from "../../src/writer/cloud.ts";
import * as locks from "../../src/writer/locks.ts";
import * as store from "../../src/writer/store.ts";

const X = "4a001eed-86e7-471f-b0c0-3fcc4009a771";
const Y = "9b002eed-86e7-471f-b0c0-3fcc4009a772";

const rows = new Map<string, Record<string, unknown>>();
const objects = new Map<string, Uint8Array>();
const leases = new Map<string, { holder: string; token: string; until: number }>();
/** Whether the cloud keeps locks for scripts (a Convex from before doesn't). */
let keepsLocks = true;
/** A commit done whose answer is lost on the way back. */
let loseCommit = false;
let tokens = 0;
let server: ReturnType<typeof Bun.serve>;
let env: Record<string, string | undefined>;

const ok = (value: unknown) => Response.json({ status: "success", value });

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
        const bytes = objects.get(key);
        return bytes === undefined ? new Response("", { status: 404 }) : new Response(bytes);
      }
      const body = (await request.json()) as Record<string, any>;
      if (url.pathname === "/v1/cloud/writer/r2/url") return Response.json({ url: `${url.origin}/r2/${encodeURIComponent(body.key)}` });
      if (url.pathname === "/v1/cloud/writer/r2/delete") {
        for (const key of body.keys) objects.delete(key);
        return Response.json({});
      }
      const args = body.args ?? {};
      switch (body.path) {
        case "writer:listScripts":
          return ok([...rows.values()]);
        case "writer:getScript":
          return ok(rows.get(args.scriptId) ?? null);
        case "writer:commitScript": {
          const row = rows.get(args.scriptId);
          const rev = Number(row?.rev ?? 0);
          if (args.baseRev !== rev) return Response.json({ status: "error", errorData: { code: "conflict" } });
          rows.set(args.scriptId, { ...args, scriptId: args.scriptId, rev: rev + 1, updatedBy: args.holder });
          if (loseCommit) {
            loseCommit = false;
            return Response.json({ error: "The connection was closed before the answer came back." }, { status: 504 });
          }
          return ok({ rev: rev + 1, stale: [] });
        }
        case "edit:acquireLock": {
          if (!keepsLocks) return Response.json({ status: "error", errorMessage: "Uncaught Error: projectId isn't a project" });
          const lease = leases.get(args.projectId);
          if (lease !== undefined && lease.until > Date.now() && lease.holder !== args.holder && args.force !== true) return ok({ acquired: false, heldBy: lease.holder, until: lease.until });
          const token = `t${++tokens}`;
          leases.set(args.projectId, { holder: args.holder, token, until: Date.now() + 120_000 });
          return ok({ acquired: true, token, until: Date.now() + 120_000 });
        }
        case "edit:renewLock": {
          const lease = leases.get(args.projectId);
          if (lease === undefined || lease.token !== args.lockToken) return ok({ renewed: false, heldBy: lease?.holder ?? null, until: lease?.until ?? null });
          lease.until = Date.now() + 120_000;
          return ok({ renewed: true, until: lease.until });
        }
        case "edit:releaseLock": {
          const lease = leases.get(args.projectId);
          if (lease?.token === args.lockToken) leases.delete(args.projectId);
          return ok({ released: lease?.token === args.lockToken });
        }
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
  leases.clear();
  keepsLocks = true;
  loseCommit = false;
  locks.resetForTests();
  // The cloud's waits after a refusal are kept by script id for the whole
  // process: cloud_sync.test.ts ends with this file's X (the same id) still
  // waiting, and run before this file (CI's Mac order) nothing here pushed.
  cloud.tryAllAgain();
});

afterEach(() => {
  store.hooks.mayWrite = () => {};
  locks.resetForTests();
});

const script = (id: string, title: string, change: Partial<Script> = {}): Script =>
  ({ id, title, sourceKind: "drive", sourceUrl: "", originalPath: "", status: "ready", stage: "ready", progress: 100, error: null, durationMs: 0, revision: 1, createdAt: 0, updatedAt: 0, overview: [], proxyPath: null, words: [], clips: [], ...change }) as Script;

/** A Mac's data folder holding these scripts, never synced. */
function mac(...scripts: Script[]): string {
  const data = fs.mkdtempSync(join(os.tmpdir(), "edit-writer-locks-"));
  for (const one of scripts) store.write(store.scriptDir(data, one.id), one);
  return data;
}

/** One sync round on `data` as `holder` (a Mac of its own: its locks are its own). */
async function syncAs(data: string, holder: string): Promise<void> {
  locks.resetForTests();
  locks.start(data, () => false);
  store.hooks.mayWrite = locks.mayWrite;
  cloud.useHolderForTests(holder);
  await cloud.syncOnceForTests(data);
}

const copies = (data: string): string[] => store.ids(data).map((id) => store.read(store.scriptDir(data, id)).title).filter((title) => title.endsWith("(conflicted copy)"));

test("two Macs changing different scripts keep no copies, and each gets the other's", { timeout: 20_000 }, async () => {
  const a = mac(script(X, "Predator Tutor"));
  const b = mac(script(Y, "Female Police Captain"));
  await syncAs(a, "Sphe's Mac #aaaaaaaaaaaa");
  await syncAs(b, "Marc's Mac #bbbbbbbbbbbb");
  await syncAs(a, "Sphe's Mac #aaaaaaaaaaaa");
  // Both change their own again.
  store.update(store.scriptDir(a, X), (one) => void (one.title = "Predator Tutor 2"));
  store.update(store.scriptDir(b, Y), (one) => void (one.title = "Female Police Captain 2"));
  await Bun.sleep(2_100);
  await syncAs(a, "Sphe's Mac #aaaaaaaaaaaa");
  await syncAs(b, "Marc's Mac #bbbbbbbbbbbb");
  await syncAs(a, "Sphe's Mac #aaaaaaaaaaaa");
  expect(copies(a)).toEqual([]);
  expect(copies(b)).toEqual([]);
  expect(store.read(store.scriptDir(a, Y)).title).toBe("Female Police Captain 2");
  expect(store.read(store.scriptDir(b, X)).title).toBe("Predator Tutor 2");
});

test("two Macs changing the same script with no lock to stop them keep one copy between them", { timeout: 20_000 }, async () => {
  keepsLocks = false;
  const a = mac(script(X, "Predator Tutor"));
  await syncAs(a, "Sphe's Mac #aaaaaaaaaaaa");
  const b = mac();
  await syncAs(b, "Marc's Mac #bbbbbbbbbbbb");
  await Bun.sleep(2_100);
  store.update(store.scriptDir(a, X), (one) => void (one.title = "Sphe's version"));
  store.update(store.scriptDir(b, X), (one) => void (one.title = "Marc's version"));
  await Bun.sleep(2_100);
  await syncAs(a, "Sphe's Mac #aaaaaaaaaaaa");
  await syncAs(b, "Marc's Mac #bbbbbbbbbbbb");
  await syncAs(b, "Marc's Mac #bbbbbbbbbbbb");
  await syncAs(a, "Sphe's Mac #aaaaaaaaaaaa");
  await syncAs(b, "Marc's Mac #bbbbbbbbbbbb");
  // One copy, pushed as a script of its own, so both Macs have it.
  expect(copies(b)).toEqual(["Marc's version (conflicted copy)"]);
  await Bun.sleep(2_100);
  await syncAs(b, "Marc's Mac #bbbbbbbbbbbb");
  await syncAs(a, "Sphe's Mac #aaaaaaaaaaaa");
  expect(copies(a)).toEqual(["Marc's version (conflicted copy)"]);
  expect(store.read(store.scriptDir(b, X)).title).toBe("Sphe's version");
});

test("a script another computer holds is read-only here, and Take over makes it ours", async () => {
  const a = mac(script(X, "Predator Tutor"));
  locks.start(a, () => false);
  store.hooks.mayWrite = locks.mayWrite;
  cloud.useHolderForTests("Sphe's Mac #aaaaaaaaaaaa");
  // Marc has it open on his Mac.
  leases.set(`writer-${X}`, { holder: "Marc's Mac #bbbbbbbbbbbb", token: "theirs", until: Date.now() + 120_000 });
  locks.viewing(X, "page");
  await cloud.syncOnceForTests(a);
  expect(locks.status(X)).toEqual({ holder: "Marc's Mac", writable: false });
  expect(() => store.update(store.scriptDir(a, X), (one) => void (one.title = "mine"))).toThrow("Marc's Mac is editing this script");
  expect(rows.get(X)).toBeUndefined();
  expect(await locks.takeOver(X, "Sphe's Mac #aaaaaaaaaaaa")).toEqual({ holder: null, writable: true });
  expect(leases.get(`writer-${X}`)!.holder).toBe("Sphe's Mac #aaaaaaaaaaaa");
  store.update(store.scriptDir(a, X), (one) => void (one.title = "mine"));
  await Bun.sleep(2_100);
  await cloud.syncOnceForTests(a);
  expect(rows.get(X)!.title).toBe("mine");
  // Closed here: the lock goes once nothing's left to push and the push's linger is over.
  locks.closed(X, "page");
  await locks.round("Sphe's Mac #aaaaaaaaaaaa", () => false);
  expect(leases.has(`writer-${X}`)).toBe(false);
});

test("a commit whose answer was lost is this Mac's own save, never a copy", { timeout: 20_000 }, async () => {
  const a = mac(script(X, "Predator Tutor"));
  await syncAs(a, "Sphe's Mac #aaaaaaaaaaaa");
  store.update(store.scriptDir(a, X), (one) => void (one.title = "Predator Tutor, edited"));
  await Bun.sleep(2_100);
  loseCommit = true;
  await syncAs(a, "Sphe's Mac #aaaaaaaaaaaa").catch(() => undefined);
  expect(rows.get(X)!.rev).toBe(2);
  // Changed again before the next round (the next start): its body isn't the cloud's any more.
  store.update(store.scriptDir(a, X), (one) => void (one.title = "Predator Tutor, edited again"));
  await Bun.sleep(2_100);
  cloud.tryAllAgain();
  await syncAs(a, "Sphe's Mac #aaaaaaaaaaaa");
  await syncAs(a, "Sphe's Mac #aaaaaaaaaaaa");
  // Taken as its own save, then the newer change pushed on top: no copy.
  expect(copies(a)).toEqual([]);
  expect(rows.get(X)!.rev).toBe(3);
  expect(rows.get(X)!.title).toBe("Predator Tutor, edited again");
});
