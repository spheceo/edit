import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

import * as jobs from "../src/jobs.ts";

function home(): string {
  return fs.mkdtempSync(`${os.tmpdir()}/edit-jobs-`);
}

test("a job is listed while it runs and crossed off when it ends", () => {
  const dir = home();
  try {
    const key = jobs.begin(dir, "export", "p1", { output: "/x.mp4" });
    expect(key).toBe("export:p1");
    const smooth = jobs.begin(dir, "smooth", "p1", { clip: "c1" }, "c1");
    expect(smooth).toBe("smooth:p1:c1");
    const listed = JSON.parse(fs.readFileSync(`${dir}/jobs.json`, "utf8")) as jobs.Job[];
    expect(listed.map((job) => job.key)).toEqual(["export:p1", "smooth:p1:c1"]);
    jobs.end(dir, key);
    const left = JSON.parse(fs.readFileSync(`${dir}/jobs.json`, "utf8")) as jobs.Job[];
    expect(left.map((job) => job.key)).toEqual(["smooth:p1:c1"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a restart starts unfinished jobs again, but not one cut short three times", async () => {
  const dir = home();
  try {
    jobs.begin(dir, "export", "p1", { output: "/x.mp4" });
    jobs.begin(dir, "watch", "p2", {});
    const resumed: string[] = [];
    const resumers: jobs.Resumers = {
      export: (job) => {
        resumed.push(job.key);
        // Started again, as the registry does: noted with its resume count.
        jobs.begin(dir, "export", job.project, job.args);
      },
      watch: () => {
        throw new Error("the project is gone");
      },
    };
    for (let restart = 1; restart <= 3; restart++) await jobs.resume(dir, resumers);
    // Resumed after the first and second restarts; the third leaves it.
    expect(resumed).toEqual(["export:p1", "export:p1"]);
    expect(JSON.parse(fs.readFileSync(`${dir}/jobs.json`, "utf8"))).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("without a data folder nothing is written", () => {
  expect(jobs.begin(null, "export", "p", {})).toBe("export:p");
  jobs.end(null, "export:p");
});
