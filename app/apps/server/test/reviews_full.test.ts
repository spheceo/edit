// A review version's full-quality file (the Download button) is noted as a job
// while it goes up, so a restart carries on with it: Nov 7, Predator Teacher,
// Edit restarted on JJ's Mac with 0.7 of v3's 4.9 GB up and nothing sent the rest.

import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as cloud from "../src/cloud.ts";
import { fullBehind } from "../src/reviews.ts";

const spies: { mockRestore(): void }[] = [];
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
