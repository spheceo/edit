import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

import { readState } from "../src/files.ts";
import * as jobs from "../src/jobs.ts";
import { scratch } from "./helpers/home.ts";

function read(dir: string): jobs.Job[] {
  return JSON.parse(fs.readFileSync(`${dir}/jobs.json`, "utf8")) as jobs.Job[];
}

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

test("a restart starts unfinished jobs again; one cut short three times is kept as given up, not started", async () => {
  const dir = home();
  try {
    jobs.begin(dir, "export", "p1", { output: "/x.mp4" });
    const resumed: string[] = [];
    const resumers: jobs.Resumers = {
      export: (job) => {
        resumed.push(job.key);
        // Started again, as the registry does: noted again under its key.
        jobs.begin(dir, "export", job.project, job.args);
      },
    };
    for (let restart = 1; restart <= 3; restart++) await jobs.resume(dir, resumers);
    // Resumed after the first and second restarts; the third leaves it, listed and given up.
    expect(resumed).toEqual(["export:p1", "export:p1"]);
    const listed = read(dir);
    expect(listed.length).toBe(1);
    expect(listed[0]!.given_up).toContain("cut short");
    expect(jobs.givenUp(dir).map((job) => job.key)).toEqual(["export:p1"]);
    // Excluded from every later restart.
    await jobs.resume(dir, resumers);
    expect(resumed.length).toBe(2);
    expect(read(dir).length).toBe(1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("taking over keeps every job listed, its count raised, until its work ends", () => {
  const dir = home();
  try {
    jobs.begin(dir, "export", "p1", { output: "/x.mp4" });
    jobs.begin(dir, "watch", "p2", {});
    expect(jobs.takeOver(dir).map((job) => job.key)).toEqual(["export:p1", "watch:p2"]);
    expect(read(dir).map((job) => [job.key, job.resumes])).toEqual([["export:p1", 1], ["watch:p2", 1]]);
    // A resumer noting it again is the same entry, its count kept.
    jobs.begin(dir, "export", "p1", { output: "/x.mp4" });
    expect(read(dir).map((job) => [job.key, job.resumes])).toEqual([["export:p1", 1], ["watch:p2", 1]]);
    jobs.end(dir, "export:p1");
    expect(read(dir).map((job) => job.key)).toEqual(["watch:p2"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a crash while recovering (taken over twice, nothing ended) loses neither job", () => {
  const dir = home();
  try {
    jobs.begin(dir, "export", "p1", {});
    jobs.begin(dir, "upload", "-", {}, "sha256:e0");
    jobs.takeOver(dir);
    // The server dies before any resumer noted its job again.
    expect(jobs.takeOver(dir).map((job) => job.key)).toEqual(["export:p1", "upload:-:sha256:e0"]);
    expect(read(dir).map((job) => job.resumes)).toEqual([2, 2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a resumer that throws keeps its job; one that says it's gone crosses it off", async () => {
  const dir = home();
  try {
    jobs.begin(dir, "watch", "p2", {});
    jobs.begin(dir, "smooth", "p3", { clip: "c1" }, "c1");
    await jobs.resume(dir, {
      watch: () => {
        throw new Error("the relay doesn't answer");
      },
      smooth: () => {
        throw new jobs.Gone("the clip is gone");
      },
    });
    expect(read(dir).map((job) => [job.key, job.resumes])).toEqual([["watch:p2", 1]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("unstick starts a given-up job again, its count cleared", async () => {
  const dir = home();
  try {
    jobs.begin(dir, "export", "p1", {});
    const started: string[] = [];
    // Each restart cuts it short again (its resumer never gets it to the end).
    const resumers: jobs.Resumers = { export: (job) => void started.push(job.key) };
    for (let restart = 1; restart <= 3; restart++) await jobs.resume(dir, resumers);
    expect(started.length).toBe(2);
    expect(jobs.givenUp(dir).length).toBe(1);
    const revived = jobs.startGivenUp(dir);
    expect(revived.keys).toEqual(["export:p1"]);
    await revived.started;
    expect(started.length).toBe(3);
    expect(read(dir).map((job) => [job.key, job.resumes, job.given_up])).toEqual([["export:p1", 0, undefined]]);
    // Nothing left given up: unstick again does nothing.
    expect(jobs.startGivenUp(dir).keys).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a given-up job started anew by hand starts its count over", () => {
  const dir = home();
  try {
    fs.writeFileSync(`${dir}/jobs.json`, JSON.stringify([{ key: "export:p1", kind: "export", project: "p1", args: {}, started_ms: 0, resumes: 2, given_up: "cut short by 3 restarts in a row" }]));
    jobs.begin(dir, "export", "p1", { output: "/y.mp4" });
    expect(read(dir).map((job) => [job.resumes, job.given_up, job.args])).toEqual([[0, undefined, { output: "/y.mp4" }]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a jobs.json from before given-up jobs (no resumes, no given_up) loads as before", () => {
  const dir = home();
  try {
    fs.writeFileSync(`${dir}/jobs.json`, JSON.stringify([{ key: "watch:p2", kind: "watch", project: "p2", args: {}, started_ms: 0 }]));
    expect(jobs.takeOver(dir).map((job) => [job.key, job.resumes])).toEqual([["watch:p2", 1]]);
    expect(jobs.givenUp(dir)).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a job that gets further each run (a big upload resuming) is started again however often it's cut short", async () => {
  const dir = home();
  try {
    jobs.begin(dir, "upload", "-", { file: "/ten-hours.mp4" }, "sha256:e0");
    const resumed: string[] = [];
    const resumers: jobs.Resumers = {
      upload: (job) => {
        resumed.push(job.key);
        const key = jobs.begin(dir, "upload", job.project, job.args, "sha256:e0");
        jobs.progressed(dir, key);
      },
    };
    for (let restart = 1; restart <= 5; restart++) await jobs.resume(dir, resumers);
    expect(resumed.length).toBe(5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("without a data folder nothing is written", () => {
  expect(jobs.begin(null, "export", "p", {})).toBe("export:p");
  jobs.end(null, "export:p");
});

test("a state file that won't read is set aside, never read as empty and written over", () => {
  const { dir, cleanup } = scratch("state-broken");
  try {
    const path = `${dir}/jobs.json`;
    fs.writeFileSync(path, "{ not json");
    const warned: string[] = [];
    expect(readState(path, (message) => warned.push(message))).toBeUndefined();
    expect(fs.existsSync(path)).toBe(false);
    const aside = fs.readdirSync(dir).find((name) => name.startsWith("jobs.json.broken-"));
    expect(aside).toBeDefined();
    expect(fs.readFileSync(`${dir}/${aside}`, "utf8")).toBe("{ not json");
    expect(warned[0]).toContain("isn't valid JSON");
    // None at all is simply empty, quietly.
    expect(readState(`${dir}/none.json`, (message) => warned.push(message))).toBeUndefined();
    expect(warned.length).toBe(1);
  } finally {
    cleanup();
  }
});
