// A review version's full-quality file (the Download button) is noted as a job
// while it goes up, so a restart carries on with it: Nov 7, Predator Teacher,
// Edit restarted on JJ's Mac with 0.7 of v3's 4.9 GB up and nothing sent the rest.

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as cloud from "../src/cloud.ts";
import { fullBehind } from "../src/reviews.ts";

const spies: { mockRestore(): void }[] = [];
// Nothing up yet (fullBehind asks the cloud first).
beforeEach(() => {
  spies.push(spyOn(cloud, "head").mockImplementation(async () => null));
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const listed = (home: string) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, "jobs.json"), "utf8")) as { kind: string; project: string; args: Record<string, unknown> }[];
  } catch {
    return [];
  }
};

test("the full-quality upload is listed in jobs.json while it goes, with what a restart needs, and crossed off once it's up", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "edit-full-"));
  const file = path.join(home, "Predator Teacher.mp4");
  fs.writeFileSync(file, "export");
  let finish = () => {};
  const sent: string[] = [];
  spies.push(
    spyOn(cloud, "uploadFile").mockImplementation(async (from: string, key: string, progress?: (done: number, total: number) => void) => {
      sent.push(`${from} -> ${key}`);
      progress?.(1, 6);
      await new Promise<void>((resolve) => (finish = resolve));
    }),
  );
  const going = fullBehind(home, "p1", "Predator Teacher", file, "edit/reviews/p1/t/full.mp4");
  await Bun.sleep(10);
  expect(listed(home)).toEqual([expect.objectContaining({ kind: "full", project: "p1", args: { name: "Predator Teacher", path: file, key: "edit/reviews/p1/t/full.mp4" } })]);
  finish();
  await going;
  expect(sent).toEqual([`${file} -> edit/reviews/p1/t/full.mp4`]);
  expect(listed(home)).toEqual([]);
});

// Nov 8, Killer Pastor's v3: named at the publish, the page's Download button saved "media.json" (the 404) for the hours its
// export took to go up. Sphe: "we need a way to see progress of when we'll get the full quality download".
test("the review page is told how the full-quality upload goes, and the version names the file only once it's up", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "edit-full-"));
  const file = path.join(home, "Killer Pastor.mp4");
  fs.writeFileSync(file, "export");
  const told: { meta: Record<string, unknown> }[] = [];
  let up = false;
  spies.push(
    spyOn(cloud, "uploadFile").mockImplementation(async (_from: string, _key: string, progress?: (done: number, total: number) => void) => {
      progress?.(2, 6);
      progress?.(4, 6);
      up = true;
    }),
    spyOn(cloud, "mutation").mockImplementation(async (name: string, args: unknown) => {
      expect(name).toBe("reviews:setMeta");
      const given = args as { sourceId: string; version: number; meta: Record<string, unknown> };
      expect([given.sourceId, given.version]).toEqual(["p2", 3]);
      // The file named only once it's up.
      if ("fullKey" in given.meta) expect(up).toBe(true);
      told.push(given);
      return null as never;
    }),
  );
  await fullBehind(home, "p2", "Killer Pastor", file, "edit/reviews/p2/t/full.mp4", 3);
  // Said at the start, at its first part (4 of 6 within 20 s of that isn't said), then the file.
  expect(told.map((one) => one.meta.fullUpload && (one.meta.fullUpload as { sent: number }).sent)).toEqual([0, 2, null]);
  expect(told[1]!.meta.fullUpload).toEqual({ sent: 2, total: 6, at: expect.any(Number), since: expect.any(Number), from: 2 });
  expect(told.at(-1)!.meta).toEqual({ fullKey: "edit/reviews/p2/t/full.mp4", fullUpload: null });
  expect(listed(home)).toEqual([]);
});
