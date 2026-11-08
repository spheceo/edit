// Disconnects, sleep and wake, and concurrent work, as the Nov 8 audit's
// "Done means" asks (item I): a restart resumes each kind of work from its
// step with no work done twice and no record lost; a Mac that slept past a
// wait wakes the job once; two imports and an export at once share the
// encoder and the one job table. Upload resume over a dropped connection is
// in cloud.test.ts; what can't be scripted is in docs/plans/2026-11-08-audit.md.

import { afterEach, expect, setSystemTime, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

import * as encoder from "../src/encoder.ts";
import * as jobs from "../src/jobs.ts";
import type { Project } from "../src/model.ts";
import { Store, UpdateError } from "../src/store.ts";
import { fixtureHome } from "./helpers/home.ts";

const SETTINGS = { width: 1920, height: 1080, fps: 30 };

function home(): string {
  return fs.mkdtempSync(`${os.tmpdir()}/edit-concurrent-`);
}

afterEach(() => {
  setSystemTime();
});

test("two imports and an export at once: one job each, the encoder shared, and a restart resumes each from its step, never a finished one", async () => {
  const dir = home();
  const releases: (() => void)[] = [];
  try {
    // The export renders (the registry says so to the encoder); both imports start.
    const exportKey = jobs.begin(dir, "export", "p1", { output: "/x.mp4" }, "", "exporting");
    let exporting = true;
    releases.push(encoder.register(() => (exporting ? "an export of p1" : null)));
    const a = jobs.begin(dir, "case", "p2", { files: 2 }, "", "downloading");
    const b = jobs.begin(dir, "case", "p3", { files: 3 }, "", "downloading");
    // Import A's proxy encodes beside the export: it knows the encoder is shared (its pace judge forgives it).
    const proxy = encoder.hold("p2's proxy");
    releases.push(proxy.release);
    jobs.step(dir, a, "proxies", { proxied: 1 });
    expect(encoder.shared(proxy.token)).toBe(true);
    expect(encoder.others(proxy.token)).toEqual(["an export of p1"]);
    // Import B can't take the encoder while the export holds it: it waits for it, asleep.
    jobs.settle(dir, b, "waiting", { until: "encoder", step: "waiting for the encoder" });
    // Import A finishes; its proxy lets go.
    proxy.release();
    jobs.settle(dir, a, "done", { step: "laid out" });
    // Every write landed in the one table: nothing lost between them.
    const listed = jobs.list(dir);
    expect(listed.map((job) => [job.key, job.state, job.step])).toEqual([
      [exportKey, "running", "exporting"],
      [a, "done", "laid out"],
      [b, "waiting", "waiting for the encoder"],
    ]);
    // Edit restarts (an update) with the export under way.
    const resumed: [string, string | undefined][] = [];
    const resumers: jobs.Resumers = {
      export: (job) => void resumed.push([job.key, job.step]),
      case: (job) => void resumed.push([job.key, job.step]),
    };
    await jobs.resume(dir, resumers, ["export", "case"]);
    // The export from its step; A is done and B asleep on the encoder: neither started again.
    expect(resumed).toEqual([[exportKey, "exporting"]]);
    expect(jobs.dueNow(dir, ["case"])).toEqual([]);
    // The export ends: B is woken once, and only once.
    exporting = false;
    jobs.end(dir, exportKey);
    const woken = jobs.dueNow(dir, ["case"]);
    expect(woken.map((job) => job.key)).toEqual([b]);
    expect(jobs.dueNow(dir, ["case"])).toEqual([]);
    expect(jobs.get(dir, b)!.state).toBe("running");
    expect(jobs.get(dir, a)!.state).toBe("done");
  } finally {
    for (const release of releases) release();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a Mac asleep past a job's wait wakes it once when it's back, and not before its time", () => {
  const dir = home();
  try {
    const start = new Date("2026-11-08T20:00:00Z");
    setSystemTime(start);
    const key = jobs.begin(dir, "script", "s1", { file: "a" }, "", "transcribing");
    // The transcription plan's credit: tried again in 30 minutes.
    jobs.settle(dir, key, "waiting", { retry_at: start.getTime() + 30 * 60_000, step: "waiting for credit" });
    setSystemTime(new Date(start.getTime() + 29 * 60_000));
    expect(jobs.dueNow(dir, ["script"])).toEqual([]);
    // The lid closed, opened two hours later: timers that didn't fire meanwhile; the next look wakes it once.
    setSystemTime(new Date(start.getTime() + 150 * 60_000));
    expect(jobs.dueNow(dir, ["script"]).map((job) => job.key)).toEqual([key]);
    expect(jobs.dueNow(dir, ["script"])).toEqual([]);
    // A restart in between wouldn't have cut it short either (asleep jobs aren't counted as cut short).
    expect(jobs.get(dir, key)!.attempts).toBe(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a save the server took just before it went down is there once after the restart, and the same save sent again isn't taken twice", async () => {
  const { home: data, store, cleanup } = fixtureHome("save-restart");
  try {
    const live = store.create("Case", SETTINGS);
    const id = live.project.id;
    const saved = { ...structuredClone(live.project), name: "Renamed before the restart" } as Project;
    expect((await store.replace(id, live.rev, saved, "page")).rev).toBe(live.rev + 1);
    // The answer never reached the page (the server went down); it comes back up and the page sends the save again.
    const again = Store.open(data);
    expect(again.get(id)!.project.name).toBe("Renamed before the restart");
    expect(again.get(id)!.rev).toBe(live.rev + 1);
    const resent = await again.replace(id, live.rev, saved, "page").then(
      () => null,
      (error: unknown) => error,
    );
    // Refused as behind, with the server's copy (which is the page's own) to take: no second revision, nothing lost.
    expect(resent).toBeInstanceOf(UpdateError);
    expect((resent as UpdateError).kind).toBe("conflict");
    expect(again.get(id)!.rev).toBe(live.rev + 1);
    expect(Store.open(data).get(id)!.project.name).toBe("Renamed before the restart");
  } finally {
    cleanup();
  }
});
