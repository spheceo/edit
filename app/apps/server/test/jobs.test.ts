import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

import { readState } from "../src/files.ts";
import * as encoder from "../src/encoder.ts";
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

test("a restart Edit made itself (an update) isn't counted against the jobs it cut; an old note doesn't count", () => {
  const dir = home();
  try {
    jobs.begin(dir, "export", "p1", { output: "/x.mp4" });
    for (let restart = 0; restart < 5; restart++) {
      jobs.plannedRestart(dir);
      expect(jobs.takeOver(dir).map((job) => [job.key, job.attempts])).toEqual([["export:p1", 0]]);
    }
    // Read once: the next start without a note counts as before.
    expect(jobs.takeOver(dir).map((job) => job.attempts)).toEqual([1]);
    fs.writeFileSync(`${dir}/restart.json`, JSON.stringify({ at: Date.now() - 3_600_000 }));
    expect(jobs.takeOver(dir).map((job) => job.attempts)).toEqual([2]);
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
    expect(read(dir).map((job) => [job.key, job.attempts])).toEqual([["export:p1", 1], ["watch:p2", 1]]);
    // A resumer noting it again is the same entry, its count kept.
    jobs.begin(dir, "export", "p1", { output: "/x.mp4" });
    expect(read(dir).map((job) => [job.key, job.attempts])).toEqual([["export:p1", 1], ["watch:p2", 1]]);
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
    expect(read(dir).map((job) => job.attempts)).toEqual([2, 2]);
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
    expect(read(dir).map((job) => [job.key, job.attempts])).toEqual([["watch:p2", 1]]);
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
    expect(read(dir).map((job) => [job.key, job.attempts, job.given_up])).toEqual([["export:p1", 0, undefined]]);
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
    expect(read(dir).map((job) => [job.attempts, job.given_up, job.args])).toEqual([[0, undefined, { output: "/y.mp4" }]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a jobs.json from before given-up jobs (no resumes, no given_up) loads as before", () => {
  const dir = home();
  try {
    fs.writeFileSync(`${dir}/jobs.json`, JSON.stringify([{ key: "watch:p2", kind: "watch", project: "p2", args: {}, started_ms: 0 }]));
    expect(jobs.takeOver(dir).map((job) => [job.key, job.attempts])).toEqual([["watch:p2", 1]]);
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

test("a job's steps, its ending and a hand-off round trip through jobs.json as plain objects", () => {
  const dir = home();
  try {
    const key = jobs.begin(dir, "share", "p1", { id: "s1" }, "", "exporting");
    jobs.step(dir, key, "review copy", { path: "/x.mp4" });
    expect(jobs.get(dir, key)).toMatchObject({ kind: "share", state: "running", step: "review copy", args: { id: "s1", path: "/x.mp4" }, attempts: 0 });
    // Published: kept done, and its full-quality upload listed, in one write.
    jobs.handOff(dir, key, { kind: "full", project: "p1", args: { key: "k" }, part: "k" }, { state: "done", step: "published", args: { published: { version: 2 } } });
    expect(read(dir).map((job) => [job.key, job.state, job.step])).toEqual([["share:p1", "done", "published"], ["full:p1:k", "running", undefined]]);
    // Done and failed jobs aren't started again by a restart.
    jobs.settle(dir, "full:p1:k", "failed", { error: "R2 closed the connection", build: "nightly-70" });
    expect(jobs.takeOver(dir)).toEqual([]);
    expect(jobs.get(dir, "full:p1:k")).toMatchObject({ state: "failed", error: "R2 closed the connection", build: "nightly-70" });
    // Begun again, a failed job starts over.
    jobs.begin(dir, "full", "p1", { key: "k" }, "k");
    expect(jobs.get(dir, "full:p1:k")).toMatchObject({ state: "running", attempts: 0 });
    expect(jobs.get(dir, "full:p1:k")?.error).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an export handed to its archive in one write: no crash falls between them", () => {
  const dir = home();
  try {
    const key = jobs.begin(dir, "export", "p1", { output: "/x.mp4" });
    jobs.handOff(dir, key, { kind: "archive", project: "p1", args: { output: "/x.mp4" } });
    expect(read(dir).map((job) => job.key)).toEqual(["archive:p1"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the old ledgers are taken in once, and removed: failed exports, running turns, fixes under way; the old retry queue goes", () => {
  const dir = home();
  try {
    fs.mkdirSync(`${dir}/agent`);
    fs.writeFileSync(`${dir}/jobs.json`, JSON.stringify([{ key: "watch:p2", kind: "watch", project: "p2", args: {}, started_ms: 5, resumes: 1 }]));
    fs.writeFileSync(`${dir}/export-failures.json`, JSON.stringify({ p1: { project: "p1", name: "Cops", options: { format: "h264" }, output: "/out/p1.mp4", error: "Native encoder stalled", at: 7, build: "nightly-47", share: true } }));
    fs.writeFileSync(`${dir}/agent/running-turns.json`, JSON.stringify({ at: 9, projects: ["p3", "p3~fresh"] }));
    fs.writeFileSync(`${dir}/review-fixes.json`, JSON.stringify({ p4: { reviewId: "r1", noteIds: ["n1"], before: "t0", at: 11 } }));
    fs.writeFileSync(`${dir}/retry-after-update.json`, JSON.stringify({ build: "nightly-48", from: "nightly-47", items: [{ kind: "export", project: "p1", name: "Cops" }] }));
    const listed = jobs.list(dir);
    expect(listed.map((job) => [job.key, job.state, job.attempts])).toEqual([
      ["watch:p2", "running", 1],
      ["export:p1", "failed", 0],
      ["turn:p3", "running", 0],
      ["turn:p3:p3~fresh", "running", 0],
      ["fix:p4", "running", 0],
    ]);
    expect(jobs.get(dir, "export:p1")).toMatchObject({ error: "Native encoder stalled", build: "nightly-47", updated_ms: 7, args: { name: "Cops", options: { format: "h264" }, output: "/out/p1.mp4", share: true } });
    expect(jobs.get(dir, "turn:p3:p3~fresh")).toMatchObject({ args: { chat: "p3~fresh" }, updated_ms: 9 });
    expect(jobs.get(dir, "fix:p4")).toMatchObject({ args: { reviewId: "r1", noteIds: ["n1"], before: "t0", at: 11 }, step: "fixing" });
    for (const old of ["export-failures.json", "agent/running-turns.json", "review-fixes.json", "retry-after-update.json"]) expect(fs.existsSync(`${dir}/${old}`)).toBe(false);
    // Read by hand: an array of plain objects, one a line or so.
    expect(Array.isArray(JSON.parse(fs.readFileSync(`${dir}/jobs.json`, "utf8")))).toBe(true);
    // Taken in once: reading again changes nothing.
    expect(jobs.list(dir)).toEqual(listed);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a job that's still going (a turn's minute) has its time noted and its restarts forgiven", async () => {
  const dir = home();
  try {
    const key = jobs.begin(dir, "turn", "p1", { chat: "p1" });
    jobs.takeOver(dir);
    expect(jobs.get(dir, key)?.attempts).toBe(1);
    const before = jobs.get(dir, key)!.updated_ms;
    await Bun.sleep(2);
    jobs.touch(dir, key);
    expect(jobs.get(dir, key)).toMatchObject({ attempts: 0 });
    expect(jobs.get(dir, key)!.updated_ms).toBeGreaterThan(before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a job waiting on a time, the encoder or the person isn't cut short by a restart; it's woken when it's due", async () => {
  const dir = home();
  let exporting = true;
  const undo = encoder.register(() => (exporting ? "an export" : null));
  try {
    for (const [project, fields] of [
      ["later", { retry_at: Date.now() + 60_000 }],
      ["due", { retry_at: Date.now() - 1 }],
      ["encoder", { until: "encoder" as const }],
      ["person", { until: "person" as const }],
    ] as const) {
      jobs.begin(dir, "case", project, {});
      jobs.settle(dir, jobs.keyOf("case", project), "waiting", { step: "waiting", ...fields });
    }
    // None was cut short: a restart hands none back, and counts none.
    expect(jobs.takeOver(dir)).toEqual([]);
    expect(read(dir).every((job) => job.attempts === 0 && job.state === "waiting")).toBe(true);
    const woken: string[] = [];
    jobs.useResumers(dir, { case: (job) => void woken.push(job.project) });
    await jobs.wake(dir);
    expect(woken).toEqual(["due"]);
    exporting = false;
    await jobs.wake(dir);
    expect(woken).toEqual(["due", "encoder"]);
    // The person's answer, never a timer, carries the last one on; the first waits for its time.
    expect(read(dir).filter((job) => job.state === "waiting").map((job) => job.project).sort()).toEqual(["later", "person"]);
  } finally {
    undo();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
