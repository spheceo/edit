// What Edit.app's window player reads a script's recordings from
// (writer/window_sources.ts): the files behind the addresses the script page
// plays, a preview only in the cloud brought down when there's room, and
// nothing for a script the person can't see or an address that isn't a
// script's recording. And a script open on this Mac keeps its footage here.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import type { Script } from "@edit/types/writer";

import type { App } from "../../src/app.ts";
import * as tools from "../../src/tools.ts";
import * as locks from "../../src/writer/locks.ts";
import { free } from "../../src/writer/storage.ts";
import * as store from "../../src/writer/store.ts";
import { hooks, reset, windowSources } from "../../src/writer/window_sources.ts";

const ID = "7d0e4c1a-2b3f-4a5e-8c9d-0f1e2d3c4b5a";
const OTHER = "11111111-2222-4333-8444-555555555555";
const HOUR = 3_600_000;
const proxyOf = (id: string): string => `/api/writer/scripts/${id}/proxy?v=1000`;

let home: string;
let clip: string;
let app: App;
const kept = { ...hooks };

function script(id: string, fields: Partial<Script> = {}): string {
  const dir = store.scriptDir(store.dataDir(home), id);
  fs.mkdirSync(dir, { recursive: true });
  store.write(dir, { id, title: "Case", sourceKind: "youtube", sourceUrl: "", originalPath: "", status: "ready", stage: "", progress: 100, error: null, durationMs: 1_000, revision: 1, createdAt: 0, updatedAt: Date.now() - HOUR, overview: [], proxyPath: null, words: [], clips: [], ...fields } as Script);
  return dir;
}

/** The cloud's record of `id`'s preview, `size` bytes. */
function inCloud(id: string, size: number): void {
  const data = store.dataDir(home);
  fs.mkdirSync(join(data, "cloud"), { recursive: true });
  fs.writeFileSync(join(data, "cloud", "ledger.json"), JSON.stringify({ scripts: { [id]: { rev: 2, body: "", files: { "proxy.mp4": { key: `writer/scripts/${id}/proxy.mp4`, size, mtime: 0 } } } } }));
}

beforeAll(async () => {
  home = fs.mkdtempSync(join(os.tmpdir(), "edit-window-sources-"));
  clip = join(home, "clip.mp4");
  await tools.run([tools.ffmpeg(), "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "2", "-c:v", "libx264", "-c:a", "aac", "-shortest", clip]);
  app = { store: { home, cacheDir: () => join(home, "cache") } } as unknown as App;
});
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));
beforeEach(() => {
  reset();
  locks.resetForTests();
  Object.assign(hooks, kept);
  fs.rmSync(store.dataDir(home), { recursive: true, force: true });
});

test("a preview on this Mac is answered with its file and what's in it, a commentary's clip footage and a script's own file too", async () => {
  const dir = script(ID);
  fs.copyFileSync(clip, store.proxyPath(dir));
  fs.mkdirSync(join(dir, "footage"));
  fs.copyFileSync(clip, join(dir, "footage", "yt-abc-0.mp4"));
  fs.copyFileSync(clip, join(dir, "found (1).mp4"));
  const srcs = [proxyOf(ID), `/api/writer/scripts/${ID}/footage/yt-abc-0.mp4`, `/api/writer/scripts/${ID}/files/${encodeURIComponent("found (1).mp4")}`];
  const answer = await windowSources(app, srcs, () => true);
  expect(answer.coming).toEqual([]);
  expect(answer.cache).toBe(join(home, "cache"));
  expect(Object.keys(answer.sources)).toEqual(srcs);
  const proxy = answer.sources[proxyOf(ID)]!;
  expect(proxy).toMatchObject({ path: store.proxyPath(dir), width: 320, height: 180, fps: 30, sound: true });
  expect(proxy.durationMs).toBeGreaterThan(1_900);
  expect(proxy.durationMs).toBeLessThan(2_200);
  expect(answer.sources[srcs[1]!]!.path).toBe(join(dir, "footage", "yt-abc-0.mp4"));
  expect(answer.sources[srcs[2]!]!.path).toBe(join(dir, "found (1).mp4"));
});

test("a preview only in the cloud comes down behind the ask when there's room, once, and is answered when it's here", async () => {
  const dir = script(ID);
  inCloud(ID, 5_000);
  let fetched = 0;
  let land = (): void => {};
  hooks.overBudget = () => -1_000_000;
  hooks.fetchPreview = () => {
    fetched++;
    return new Promise((resolve) => {
      land = () => {
        fs.copyFileSync(clip, store.proxyPath(dir));
        resolve(store.proxyPath(dir));
      };
    });
  };
  expect(await windowSources(app, [proxyOf(ID)], () => true)).toMatchObject({ sources: {}, coming: [proxyOf(ID)] });
  // Asked again while it's on its way: still coming, not fetched twice.
  expect(await windowSources(app, [proxyOf(ID)], () => true)).toMatchObject({ sources: {}, coming: [proxyOf(ID)] });
  expect(fetched).toBe(1);
  land();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const here = await windowSources(app, [proxyOf(ID)], () => true);
  expect(here.coming).toEqual([]);
  expect(here.sources[proxyOf(ID)]!.path).toBe(store.proxyPath(dir));
});

test("with no room for it the preview stays in the cloud (the page plays it), and the disk isn't measured again at every ask", async () => {
  script(ID);
  inCloud(ID, 5_000);
  let measured = 0;
  let fetched = 0;
  // 4,000 bytes under the budget: 5,000 more wouldn't fit.
  hooks.overBudget = () => {
    measured++;
    return -4_000;
  };
  hooks.fetchPreview = () => {
    fetched++;
    return Promise.resolve("");
  };
  for (let ask = 0; ask < 3; ask++) expect(await windowSources(app, [proxyOf(ID)], () => true)).toMatchObject({ sources: {}, coming: [] });
  expect([measured, fetched]).toEqual([1, 0]);
});

test("a preview that isn't in the cloud either, a script the person can't see, and an address that's no script's recording are left out", async () => {
  const dir = script(ID);
  fs.copyFileSync(clip, store.proxyPath(dir));
  const other = script(OTHER);
  fs.copyFileSync(clip, store.proxyPath(other));
  script("99999999-2222-4333-8444-555555555555");
  hooks.fetchPreview = () => Promise.reject(new Error("never asked"));
  const srcs = [
    proxyOf(ID),
    proxyOf(OTHER),
    proxyOf("99999999-2222-4333-8444-555555555555"),
    `/api/writer/scripts/${ID}/files/..%2F${OTHER}%2Fproxy.mp4`,
    `/api/writer/scripts/${ID}/files/.hidden.mp4`,
    `/api/writer/scripts/${ID}/footage/..%2Fproxy.mp4`,
    `/api/projects/p1/media/m1/proxy`,
    "not an address",
  ];
  const answer = await windowSources(app, srcs, (id) => id === ID || id.startsWith("9"));
  expect(Object.keys(answer.sources)).toEqual([proxyOf(ID)]);
  expect(answer.coming).toEqual([]);
});

test("a script open on this Mac keeps its footage here: the window reads its preview from the file", async () => {
  const data = store.dataDir(home);
  const dir = script(ID);
  const past = (Date.now() - HOUR) / 1000;
  fs.writeFileSync(store.proxyPath(dir), Buffer.alloc(1000));
  fs.utimesSync(store.proxyPath(dir), past, past);
  fs.utimesSync(join(dir, "script.json"), past, past);
  fs.mkdirSync(join(data, "cloud"), { recursive: true });
  fs.writeFileSync(join(data, "cloud", "ledger.json"), JSON.stringify({ scripts: { [ID]: { rev: 2, body: "", files: { "proxy.mp4": { key: `writer/scripts/${ID}/proxy.mp4`, size: 1000, mtime: Math.floor(fs.statSync(store.proxyPath(dir)).mtimeMs) } } } } }));
  locks.viewing(ID, "page");
  expect(await free(data, ID)).toBe(0);
  expect(fs.existsSync(store.proxyPath(dir))).toBe(true);
  // Closed, it goes as before.
  locks.closed(ID, "page");
  expect(await free(data, ID)).toBe(1000);
  expect(fs.existsSync(store.proxyPath(dir))).toBe(false);
});
