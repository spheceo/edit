import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import type { Script } from "@edit/types/writer";

import * as cloud from "../../src/writer/cloud.ts";
import { free } from "../../src/writer/storage.ts";
import * as store from "../../src/writer/store.ts";

const ID = "7d0e4c1a-2b3f-4a5e-8c9d-0f1e2d3c4b5a";
const HOUR = 3_600_000;

/** A ready script an hour untouched, with `files` in its folder (each an hour old) and the cloud's record of `inCloud`. */
function setUp(files: Record<string, number>, inCloud: string[], shared: string[] = [], fields: Partial<Script> = {}): [string, string] {
  const data = fs.mkdtempSync(join(os.tmpdir(), "edit-storage-"));
  const dir = store.scriptDir(data, ID);
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  store.write(dir, { id: ID, title: "Case", sourceKind: "youtube", sourceUrl: "", originalPath: join(dir, "original.mp4"), status: "ready", stage: "", progress: 100, error: null, durationMs: 1_000, revision: 1, createdAt: 0, updatedAt: now - HOUR, overview: [], proxyPath: null, words: [], clips: [], ...fields } as Script);
  fs.utimesSync(join(dir, "script.json"), (now - HOUR) / 1000, (now - HOUR) / 1000);
  const ledgerFiles: Record<string, { key: string; size: number; mtime: number }> = {};
  for (const [name, size] of Object.entries(files)) {
    const path = join(dir, name);
    fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(path, Buffer.alloc(size));
    fs.utimesSync(path, (now - HOUR) / 1000, (now - HOUR) / 1000);
    if (inCloud.includes(name)) ledgerFiles[name] = { key: `writer/scripts/${ID}/${name}`, size, mtime: Math.floor(fs.statSync(path).mtimeMs) };
  }
  fs.writeFileSync(join(dir, "edit-shared.json"), JSON.stringify(shared.map((file) => ({ source: `youtube:${file}`, key: `edit/originals/youtube/x/${file}`, file }))));
  fs.mkdirSync(join(data, "cloud"), { recursive: true });
  fs.writeFileSync(join(data, "cloud", "ledger.json"), JSON.stringify({ scripts: { [ID]: { rev: 2, body: "", files: ledgerFiles } } }));
  return [data, dir];
}

describe("a script's footage left to the cloud", () => {
  test("footage the cloud holds goes, noted as the cloud's; what only this Mac has stays", async () => {
    const [data, dir] = setUp({ "proxy.mp4": 1000, "original.mp4": 2000, "compilation/01.mp4": 500, "footage/clip.mp4": 300, "research.json": 10 }, ["proxy.mp4", "research.json"], ["original.mp4"]);
    expect(await free(data, ID)).toBe(3000);
    expect(["proxy.mp4", "original.mp4", "compilation/01.mp4", "footage/clip.mp4", "research.json"].map((name) => fs.existsSync(join(dir, name)))).toEqual([false, false, true, true, true]);
    // The sync's own copy is noted as left in the cloud (so a push keeps it); Edit's original is found through edit-shared.json.
    expect(cloud.purgedNames(data, ID)).toEqual(["proxy.mp4"]);
  });

  test("a file changed since its upload stays (the cloud's is another), as does everything of a script in use", async () => {
    const [data, dir] = setUp({ "proxy.mp4": 1000 }, ["proxy.mp4"]);
    fs.writeFileSync(join(dir, "proxy.mp4"), Buffer.alloc(1001));
    expect(await free(data, ID)).toBe(0);
    const [busyData] = setUp({ "proxy.mp4": 1000 }, ["proxy.mp4"], [], { status: "processing" });
    expect(await free(busyData, ID)).toBe(0);
    const [freshData] = setUp({ "proxy.mp4": 1000 }, ["proxy.mp4"], [], { updatedAt: Date.now() });
    expect(await free(freshData, ID)).toBe(0);
  });

  test("a script that never reached the cloud keeps its footage", async () => {
    const [data] = setUp({ "proxy.mp4": 1000 }, ["proxy.mp4"]);
    fs.writeFileSync(join(data, "cloud", "ledger.json"), JSON.stringify({ scripts: {} }));
    expect(await free(data, ID)).toBe(0);
  });
});
