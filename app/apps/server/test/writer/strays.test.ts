// Folders among the scripts with no script.json (writer/storage.ts clearStrays):
// JJ's Mac, Nov 4, had 12,032, every one a clone of one deleted script.

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import * as cloud from "../../src/writer/cloud.ts";
import { clearStrays } from "../../src/writer/storage.ts";
import * as store from "../../src/writer/store.ts";

const DAY = 24 * 3_600_000;
const ids = Array.from({ length: 6 }, (_, at) => `0000000${at}-1111-4222-8333-444444444444`);

/** A data folder with a folder per id, each holding a chat and a half-made preview `ageMs` old; `script` ids hold a script too. */
function setUp(ageMs: number, script: string[] = []): { data: string; projects: string } {
  const home = fs.mkdtempSync(join(os.tmpdir(), "edit-strays-"));
  const data = store.dataDir(home);
  const then = (Date.now() - ageMs) / 1000;
  for (const id of ids) {
    const dir = store.scriptDir(data, id);
    fs.mkdirSync(join(dir, "compilation"), { recursive: true });
    for (const name of ["chat.json", "proxy.mp4.partial", "compilation/videos.json"]) {
      fs.writeFileSync(join(dir, name), "[]");
      fs.utimesSync(join(dir, name), then, then);
    }
    if (script.includes(id)) fs.writeFileSync(join(dir, "script.json"), "{}");
    for (const at of [join(dir, "compilation"), dir]) fs.utimesSync(at, then, then);
  }
  fs.mkdirSync(join(home, "projects"));
  return { data, projects: join(home, "projects") };
}

const clear = (data: string, projects: string) => Effect.runPromise(clearStrays(data, projects, ids));
const left = (data: string) => store.ids(data).sort();

afterEach(() => cloud.liveForTests(null));

test("a folder with no script, untouched a day, not in the cloud and used by no project, is cleared", async () => {
  const { data, projects } = setUp(2 * DAY, [ids[5]!]);
  cloud.liveForTests(new Set([ids[1]!]));
  fs.writeFileSync(join(projects, "p1.json"), JSON.stringify({ media: [{ path: join(store.scriptDir(data, ids[2]!), "compilation", "00.mp4") }, { path: "/elsewhere/a.mp4" }] }));

  expect((await clear(data, projects)).sort()).toEqual([ids[0]!, ids[3]!, ids[4]!]);
  // In the cloud (a pull cut short comes down again), a project's media inside, a script.
  expect(left(data)).toEqual([ids[1]!, ids[2]!, ids[5]!]);
});

test("one touched within the day stays", async () => {
  const { data, projects } = setUp(DAY / 2);
  cloud.liveForTests(new Set());
  expect(await clear(data, projects)).toEqual([]);
  expect(left(data)).toHaveLength(ids.length);
});

test("nothing is cleared before the cloud has listed its scripts, or when a project won't read", async () => {
  const { data, projects } = setUp(2 * DAY);
  expect(await clear(data, projects)).toEqual([]);
  cloud.liveForTests(new Set());
  fs.writeFileSync(join(projects, "broken.json"), "{");
  expect(await clear(data, projects)).toEqual([]);
  expect(left(data)).toHaveLength(ids.length);
});
