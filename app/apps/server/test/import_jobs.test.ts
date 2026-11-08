// The script import as a job in the job table (Nov 8 audit, item F): its
// files' states survive a restart, what was fetched isn't fetched again,
// every step is bounded, the plan's credit and the shared encoder are waits
// rather than errors, and what follows the layout never fails the import.

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";

import { createApp } from "../src/app.ts";
import * as encoder from "../src/encoder.ts";
import * as steps from "../src/import_steps.ts";
import * as jobs from "../src/jobs.ts";
import { Processor } from "../src/media.ts";
import type { MediaStatus, Probe, ScriptJob } from "../src/model.ts";
import * as relay from "../src/relay.ts";
import { waitingByItself } from "../src/remote_actions.ts";
import { carryOn, Jobs, skipFootage, start, timing } from "../src/script.ts";
import * as seams from "../src/seams.ts";
import type { Excerpt } from "../src/seams.ts";
import { fixtureHome, type Fixture } from "./helpers/home.ts";

const SOUNDLESS: Probe = { kind: "video", duration: 60, width: 640, height: 360, fps: 30, has_audio: false };
const HEARD: Probe = { ...SOUNDLESS, has_audio: true };

let restores: (() => void)[] = [];
const waits = timing.retryWaits;
const sleep = timing.sleep;

beforeEach(() => {
  timing.retryWaits = [0];
  timing.sleep = async () => {};
  const cloud = spyOn(relay, "cloudEnabled").mockReturnValue(true);
  const articles = spyOn(seams.research, "articles").mockReturnValue([{ id: "a", title: "A", url: "https://example.test", outlet: "A", text: "", summary: "" }]);
  const names = spyOn(seams.research, "caseNames").mockResolvedValue([]);
  // These are the job table's tests, not media's: no thumbnails or waveforms
  // made for the footage. Its addresses are a server that isn't there, and
  // each of them held media's one background slot for 11 s after these tests
  // had ended, so the next file's media test (CI's order, Nov 8) timed out.
  const analysis = spyOn(Processor.prototype, "ensure").mockImplementation(() => {});
  restores = [() => cloud.mockRestore(), () => articles.mockRestore(), () => names.mockRestore(), () => analysis.mockRestore()];
});

afterEach(() => {
  for (const undo of restores) undo();
  timing.retryWaits = waits;
  timing.sleep = sleep;
});

function mocked<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}

/** A project with a script of two footage files (two Drive ids). */
async function twoFiles(fixture: Fixture): Promise<string> {
  const id = fixture.store.create("import", { width: 640, height: 360, fps: 30 }).project.id;
  await fixture.store.update(id, "test", (p) => {
    p.style = "courtroom";
    p.script = {
      blocks: [
        { kind: "footage", file: "FILEcase0001", url: "https://drive.google.com/file/d/FILEcase0001/view", start: 0, end: 4, label: "00:00–00:04", words: ["where", "you"], notes: ["Case 1: link"] },
        { kind: "narration", text: "Then it happened." },
        { kind: "footage", file: "FILEcase0002", url: "https://drive.google.com/file/d/FILEcase0002/view", start: 0, end: 4, label: "00:00–00:04", words: ["where", "you"], notes: ["Case 2: link"] },
      ],
    };
  });
  return id;
}

/** Drive files on R2 as the registry would have them, each a whole-file excerpt. */
function cloudFootage(probe: Probe, fail: (file: string) => Error | null = () => null): { fetched: string[] } {
  const fetched: string[] = [];
  mocked(
    spyOn(seams.cloudMedia, "driveOriginal").mockImplementation(async (file: string) => {
      fetched.push(file);
      const why = fail(file);
      if (why !== null) throw why;
      return { file, source: `drive:${file}`, key: `edit/originals/drive/${file}/a.mp4`, name: `${file}.mp4`, size: 100 };
    }),
  );
  mocked(
    spyOn(seams.cloudMedia, "driveExcerpts").mockImplementation(async (_cache: string, original) => {
      const proxy = `edit/proxies/drive/${original.file}.mp4`;
      const path = `http://127.0.0.1:7700/api/cloud/preview?key=${encodeURIComponent(proxy)}`;
      const excerpt: Excerpt = { path, from: 0, to: probe.duration, cloud: { path, name: original.name, probe, cloud: { source: original.source, original: original.key, proxy, size: 100 } } };
      return [excerpt];
    }),
  );
  return { fetched };
}

/** Waits until the import isn't working any more. */
async function settled(scripts: Jobs, id: string): Promise<ScriptJob> {
  for (let i = 0; i < 1000 && scripts.working(id); i++) await Bun.sleep(2);
  return scripts.get(id)!;
}

function caseJob(home: string, id: string): jobs.Job | undefined {
  return jobs.get(home, jobs.keyOf("case", id));
}

test("an import waiting on the person survives a restart with its files' states, and carries on without fetching what it had", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-waits", { services: { scripts } });
  try {
    const id = await twoFiles(fixture);
    const { fetched } = cloudFootage(SOUNDLESS, (file) => (file === "FILEcase0002" ? new steps.NeedsPerson("This Drive file isn't shared. Set it so anyone with the link can view.") : null));
    mocked(spyOn(seams.voiceover, "generate").mockResolvedValue({}));
    await start(fixture.app, id, false);
    const before = await settled(scripts, id);
    expect(before.state).toBe("waiting");
    expect(before.files.map((file) => [file.state, file.why ?? null])).toEqual([["done", null], ["failed", "person"]]);
    // Not tried again by itself: only the person can answer that one.
    expect(fetched).toEqual(["FILEcase0001", "FILEcase0002"]);
    // In the job table, waiting on the person: never cut short by a restart, never given up.
    expect(caseJob(fixture.home, id)).toMatchObject({ state: "waiting", until: "person" });
    expect(jobs.takeOver(fixture.home, ["case"])).toEqual([]);

    // A restart: a new process reads the same Downloads panel back.
    const after = new Jobs(fixture.home);
    expect(after.get(id)).toEqual(before);
    expect(after.working(id)).toBe(false);
    const restarted = createApp({ store: fixture.store, services: { scripts: after } });
    // Going on without the file nobody shared: the one fetched before is laid out from what the job kept.
    await skipFootage(restarted, id, "FILEcase0002");
    const done = await settled(after, id);
    expect(done.state).toBe("done");
    expect(fetched).toEqual(["FILEcase0001", "FILEcase0002"]);
    expect(fixture.store.get(id)!.project.clips.length).toBeGreaterThan(0);
    // Done: kept to show, its excerpts let go.
    expect(caseJob(fixture.home, id)).toMatchObject({ state: "done" });
    expect(caseJob(fixture.home, id)!.args.made).toEqual({});
  } finally {
    fixture.cleanup();
  }
});

test("a step past its time lands its file in failed with a passing reason, tried again by itself, then Retry is offered", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-timeout", { services: { scripts } });
  try {
    const id = await twoFiles(fixture);
    const { fetched } = cloudFootage(SOUNDLESS, (file) => (file === "FILEcase0002" ? new steps.StepTimedOut("Cutting an excerpt", 600_000, false) : null));
    await start(fixture.app, id, false);
    const job = await settled(scripts, id);
    // Tried again once by itself (timing.retryWaits), then the person's: Retry, another link or skip, never a job left running.
    expect(fetched.filter((file) => file === "FILEcase0002").length).toBe(2);
    expect(job.state).toBe("waiting");
    expect(job.files[1]).toMatchObject({ state: "failed", why: "passing" });
    expect(job.files[1]!.error).toContain("took more than 10 min");
    expect(scripts.working(id)).toBe(false);
    expect(steps.passing(job.files[1]!.error!)).toBe(true);
  } finally {
    fixture.cleanup();
  }
});

test("steps are bounded: past its time a step fails as passing, or as the encoder's when an export holds it", async () => {
  await expect(steps.bounded("Reading the footage's length", 20, () => new Promise(() => {}))).rejects.toBeInstanceOf(steps.StepTimedOut);
  const passing = await steps.bounded("a probe", 20, () => new Promise(() => {})).catch((error: unknown) => error);
  expect(steps.whyOf(passing)).toBe("passing");
  const export_ = encoder.register(() => "an export");
  try {
    const shared = await steps.encoding("a proxy", 20, () => new Promise(() => {})).catch((error: unknown) => error);
    expect(steps.whyOf(shared)).toBe("encoder");
    expect((shared as Error).message).toContain("the hardware encoder was busy");
  } finally {
    export_();
  }
  expect(encoder.busy()).toBe(false);
});

test("an encode that ran out of time beside an export waits for the encoder, and carries on when the export ends", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-encoder", { services: { scripts } });
  let exporting = true;
  const export_ = encoder.register(() => (exporting ? "an export" : null));
  try {
    const id = await twoFiles(fixture);
    // Past its time while the export held the encoder; the try after the export gets it.
    let shared = true;
    cloudFootage(SOUNDLESS, (file) => (file === "FILEcase0002" && shared ? new steps.StepTimedOut("Making the footage's proxy", 900_000, true) : null));
    mocked(spyOn(seams.voiceover, "generate").mockResolvedValue({}));
    await start(fixture.app, id, false);
    const job = await settled(scripts, id);
    expect(job.state).toBe("waiting");
    expect(job.files[1]).toMatchObject({ state: "waiting", why: "encoder" });
    expect(caseJob(fixture.home, id)).toMatchObject({ state: "waiting", until: "encoder", args: { waiting_on: "encoder" } });
    expect(waitingByItself(fixture.home)).toEqual(["1 import waiting for the hardware encoder (an export holds it): they carry on when it's free."]);
    // The job table's one resumer wakes it, but not while the export runs.
    jobs.useResumers(fixture.home, { case: (one) => void carryOn(fixture.app, one.project) });
    await jobs.wake(fixture.home, ["case"]);
    expect(scripts.working(id)).toBe(false);
    exporting = false;
    shared = false;
    await jobs.wake(fixture.home, ["case"]);
    const done = await settled(scripts, id);
    expect(done.state).toBe("done");
    expect(done.files.every((file) => file.state === "done")).toBe(true);
  } finally {
    export_();
    fixture.cleanup();
  }
});

test("the transcription plan out of credit: the import waits, said once in Needs attention, and is tried again later", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-credit", { services: { scripts } });
  const every = steps.QUOTA_RETRY_MS.value;
  try {
    const id = await twoFiles(fixture);
    cloudFootage(HEARD);
    mocked(spyOn(seams.voiceover, "generate").mockResolvedValue({}));
    let refusal: MediaStatus["transcript_error"] = "transcription failed (401): This request exceeds your quota of 10000. You have 15 credits remaining.";
    mocked(spyOn(fixture.app.media, "transcribe").mockImplementation(() => fixture.app.media.status("x")));
    mocked(
      spyOn(fixture.app.media, "status").mockImplementation(() => ({ proxy: "ready", proxy_progress: 1, light: "skipped", thumbs: "ready", thumb_count: 1, peaks: "ready", transcript: "failed", ...(refusal === undefined ? {} : { transcript_error: refusal }) })),
    );
    await start(fixture.app, id, false);
    const job = await settled(scripts, id);
    expect(job.state).toBe("waiting");
    expect(job.error).toContain("The transcription plan is out of credit");
    expect(job.retry_at).toBeGreaterThan(Date.now() + 20 * 60_000);
    expect(fixture.store.get(id)!.project.clips).toEqual([]);
    const durable = caseJob(fixture.home, id)!;
    expect(durable).toMatchObject({ state: "waiting", args: { waiting_on: "quota" } });
    expect(waitingByItself(fixture.home)[0]).toStartWith("The transcription plan is out of credit: 1 import waiting");
    // Not yet due: the wake leaves it.
    jobs.useResumers(fixture.home, { case: (one) => void carryOn(fixture.app, one.project) });
    await jobs.wake(fixture.home, ["case"]);
    expect(scripts.working(id)).toBe(false);
    // Due, and the credit's back (a refusal of another kind lays it out without those words).
    const listed = JSON.parse(fs.readFileSync(`${fixture.home}/jobs.json`, "utf8")) as jobs.Job[];
    for (const one of listed) if (one.key === durable.key) one.retry_at = Date.now() - 1;
    fs.writeFileSync(`${fixture.home}/jobs.json`, JSON.stringify(listed));
    refusal = undefined;
    await jobs.wake(fixture.home, ["case"]);
    const done = await settled(scripts, id);
    expect(done.state).toBe("done");
    expect(fixture.store.get(id)!.project.clips.length).toBeGreaterThan(0);
    expect(waitingByItself(fixture.home)).toEqual([]);
  } finally {
    steps.QUOTA_RETRY_MS.value = every;
    fixture.cleanup();
  }
});

test("a voice-over that fails leaves the import done, laid out, with the voice-over's own line failed", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-voice", { services: { scripts } });
  try {
    const id = await twoFiles(fixture);
    cloudFootage(SOUNDLESS);
    timing.retryWaits = [];
    mocked(spyOn(seams.voiceover, "generate").mockRejectedValue(new Error("the voice service didn't answer")));
    await start(fixture.app, id, false);
    const job = await settled(scripts, id);
    expect(job.state).toBe("done");
    expect(job.error).toBeUndefined();
    expect(job.after).toEqual([{ step: "voiceover", state: "failed", note: "The voice-over couldn't be made: the voice service didn't answer" }]);
    expect(fixture.store.get(id)!.project.clips.length).toBeGreaterThan(0);
  } finally {
    fixture.cleanup();
  }
});

test("a transcription still running when its wait runs out is said: laid out without those words", async () => {
  const scripts = new Jobs();
  const fixture = fixtureHome("import-late-words", { services: { scripts } });
  const wait = steps.LIMITS.transcript;
  try {
    const id = await twoFiles(fixture);
    cloudFootage(HEARD);
    mocked(spyOn(seams.voiceover, "generate").mockResolvedValue({}));
    mocked(spyOn(fixture.app.media, "transcribe").mockImplementation(() => fixture.app.media.status("x")));
    mocked(spyOn(fixture.app.media, "status").mockImplementation(() => ({ proxy: "ready", proxy_progress: 1, light: "skipped", thumbs: "ready", thumb_count: 1, peaks: "ready", transcript: "working" })));
    steps.LIMITS.transcript = -1;
    await start(fixture.app, id, false);
    const job = await settled(scripts, id);
    expect(job.state).toBe("done");
    const words = job.after?.find((one) => one.step === "words");
    expect(words?.state).toBe("waiting");
    expect(words?.note).toContain("Laid out without words for 2 files");
    expect(words?.note).toContain("Transcription is still running");
  } finally {
    steps.LIMITS.transcript = wait;
    fixture.cleanup();
  }
});

test("failures read as one vocabulary: the person's, passing, the plan's credit, the encoder's", () => {
  expect(steps.whyOf(new steps.NeedsPerson("This Drive file isn't shared."))).toBe("person");
  expect(steps.whyOf(new Error("Download stopped ((28) Google Drive sent nothing for 60 s)."))).toBe("passing");
  expect(steps.whyOf("transcription failed (401): exceeds your quota … 15 credits remaining")).toBe("quota");
  expect(steps.whyOf({ _tag: "AllowanceUsedUp", message: "transcription failed (429): allowance" })).toBe("quota");
  expect(steps.whyOf({ _tag: "DownloadFailed", reason: "VideoGone", message: "gone" })).toBe("person");
  expect(steps.whyOf(new steps.StepTimedOut("a proxy", 1000, true))).toBe("encoder");
  // Words kept from an older build still read the same way.
  expect(steps.whyOf("YouTube video abcdefghijk couldn't be downloaded: Private video")).toBe("person");
  expect(steps.whyOf("Google Drive's download limit for this file is used up for today. Try later, or upload a copy.")).toBe("person");
});
