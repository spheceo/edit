// What failed on the old build, tried again once on the new one, when the Mac
// is idle (the user, Nov 2: "could we make changes so that these failed stuff
// can restart when a new nightly comes on").

import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";

import * as fs from "node:fs";

import { readOnly } from "../src/cloud_projects.ts";
import { chunkFolder, ExportRegistry, failedExports, type ExportFailure } from "../src/exports.ts";
import * as reviews from "../src/reviews.ts";
import * as retry from "../src/retry_after_update.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip } from "./helpers/model.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  mock.on("POST", "/v1/cloud/convex", () => Response.json({ status: "success", value: { chosen: false, requests: [] } }));
});

afterAll(() => {
  restore();
  mock.stop();
});

beforeEach(() => reviews.resetCheckInForTests());

/** Nothing running on this Mac, unless a test says so. */
function idle(app: unknown, busy = false): void {
  (app as { exports: unknown }).exports = { running: () => busy, runningFor: () => null };
  (app as { agents: unknown }).agents = { hasRunningTurns: () => false, chat: () => ({ running: false }) };
}

/** What the retries did, in place of exporting and sharing. */
function recorder(): { done: string[]; actions: retry.Actions } {
  const done: string[] = [];
  return {
    done,
    actions: {
      share: async (_app, item) => void done.push(`share ${item.project}`),
      export: async (_app, failure) => void done.push(`export ${failure.project} ${failure.output}`),
    },
  };
}

const failure = (project: string, extra: Partial<ExportFailure> = {}): ExportFailure => ({
  project, name: project, options: { format: "h264" } as ExportFailure["options"], output: `/out/${project}.mp4`, error: "Native encoder stalled", at: 1, build: "nightly-47", ...extra,
});

/** A home where `mom`'s share failed after its fixes and `cops`'s export failed; `old` the build that ran last. */
function setUp(name: string, old: string | null) {
  const fixture = fixtureHome(name);
  const { app, home } = fixture;
  const mom = app.store.createAs("Mom Secretly", "bodycam", { width: 1920, height: 1080, fps: 30 }).project.id;
  const cops = app.store.createAs("Cops Surprise", "bodycam", { width: 1920, height: 1080, fps: 30 }).project.id;
  const version = { n: 1, timeline: "t", path: "/nowhere.mp4", fps: 30, durationMs: 10_000, clips: [] };
  fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, notes: {}, shared: { [mom]: { reviewId: "r1", url: "u", versions: [version] } }, unshared: { [mom]: true } }));
  // A share's own export failing too: that's the share's to try again, not the export's.
  fs.writeFileSync(`${home}/export-failures.json`, JSON.stringify({ [cops]: failure(cops), [mom]: failure(mom, { share: true }) }));
  if (old !== null) fs.writeFileSync(`${home}/last-build.json`, JSON.stringify({ build: old }));
  idle(app);
  return { ...fixture, mom, cops };
}

test("a new build tries again, once and one at a time, the share that failed after its fixes and the export that failed", async () => {
  const { app, home, mom, cops, cleanup } = setUp("retry-new-build", "nightly-47");
  try {
    expect(retry.noteBuild(app, "nightly-48").map((one) => `${one.kind} ${one.project}`)).toEqual([`share ${mom}`, `export ${cops}`]);
    // A stale chunk cache goes before it's tried, so it renders fresh.
    fs.mkdirSync(chunkFolder(app.store.cacheDir(), cops), { recursive: true });
    fs.writeFileSync(`${chunkFolder(app.store.cacheDir(), cops)}/manifest-v1.json`, "{}");
    const { done, actions } = recorder();
    expect(await retry.step(app, actions)).toBe("shared");
    expect(await retry.step(app, actions)).toBe("exported");
    expect(fs.existsSync(chunkFolder(app.store.cacheDir(), cops))).toBe(false);
    expect(done).toEqual([`share ${mom}`, `export ${cops} /out/${cops}.mp4`]);
    // Each was taken once: nothing's left, and starting again on the same build queues nothing.
    expect(await retry.step(app, actions)).toBeNull();
    expect(retry.noteBuild(app, "nightly-48")).toEqual([]);
    expect(retry.pending(home)).toEqual([]);
  } finally {
    cleanup();
  }
});

test("the build that ran before was never noted (older builds didn't): it counts as new", () => {
  const { app, cleanup } = setUp("retry-first-noted", null);
  try {
    expect(retry.noteBuild(app, "nightly-48")).toHaveLength(2);
  } finally {
    cleanup();
  }
});

test("the same build tries nothing again", () => {
  const { app, home, cleanup } = setUp("retry-same-build", "nightly-48");
  try {
    expect(retry.noteBuild(app, "nightly-48")).toEqual([]);
    expect(retry.pending(home)).toEqual([]);
  } finally {
    cleanup();
  }
});

test("a busy Mac (an export, an agent turn) waits, and the queue is kept for when it's idle", async () => {
  const { app, home, cleanup } = setUp("retry-busy", "nightly-47");
  try {
    retry.noteBuild(app, "nightly-48");
    const { done, actions } = recorder();
    idle(app, true);
    expect(await retry.step(app, actions)).toBeNull();
    idle(app);
    (app as unknown as { agents: unknown }).agents = { hasRunningTurns: () => true, chat: () => ({ running: true }) };
    expect(await retry.step(app, actions)).toBeNull();
    expect(done).toEqual([]);
    expect(retry.pending(home)).toHaveLength(2);
    idle(app);
    expect(await retry.step(app, actions)).toBe("shared");
  } finally {
    cleanup();
  }
});

test("never on a project another computer holds, nor a share on an approved review, nor one a reviewer asked of this Mac again", async () => {
  const { app, home, mom, cops, cleanup } = setUp("retry-skipped", "nightly-47");
  try {
    retry.noteBuild(app, "nightly-48");
    const { done, actions } = recorder();
    // Mom's review approved meanwhile; Cops open on Sphe's MacBook Air.
    const state = JSON.parse(fs.readFileSync(`${home}/reviews.json`, "utf8")) as { shared: Record<string, Record<string, unknown>> };
    state.shared[mom]!.approved = { version: 1, by: "JJ", at: 2 };
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify(state));
    (app.store as unknown as { mayWrite: unknown }).mayWrite = async (id: string) => {
      if (id === cops) throw new Error(readOnly("Sphe's MacBook Air"));
    };
    expect(await retry.step(app, actions)).toBe("skipped: v1 of its review was approved");
    expect(await retry.step(app, actions)).toBe("skipped: the project is open on Sphe's MacBook Air");
    expect(done).toEqual([]);
    expect(retry.pending(home)).toEqual([]);
    // Asked again of this Mac: the request does it, not the retry.
    delete state.shared[mom]!.approved;
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify(state));
    retry.noteBuild(app, "nightly-49");
    mock.on("POST", "/v1/cloud/convex", (request) => {
      const { path } = request.json<{ path: string }>();
      return Response.json({ status: "success", value: path === "reviews:checkIn" ? { chosen: true, requests: [{ reviewId: "r1", sourceId: mom, title: "Mom Secretly", requestedAt: 3 }] } : path === "reviews:changes" ? { notes: [], cursor: 0, more: false } : path === "reviews:open" ? [{ sourceId: mom, reviewId: "r1", approved: null }] : { ok: false, reason: "gone" } });
    });
    await reviews.checkIn(app);
    expect(await retry.step(app, actions)).toBe("skipped: a reviewer asked again on this Mac, and that request does it");
  } finally {
    mock.on("POST", "/v1/cloud/convex", () => Response.json({ status: "success", value: { chosen: false, requests: [] } }));
    cleanup();
  }
});

test("a retry that fails again is a normal failure, not tried again until the next build", async () => {
  const { app, home, cops, cleanup } = setUp("retry-fails-again", "nightly-47");
  try {
    retry.noteBuild(app, "nightly-48");
    let tries = 0;
    const actions: retry.Actions = {
      share: async () => {
        tries++;
        throw new Error("sharing v2 failed");
      },
      export: async () => {
        tries++;
      },
    };
    expect(await retry.step(app, actions)).toBe("failed: sharing v2 failed");
    expect(await retry.step(app, actions)).toBe("exported");
    expect(await retry.step(app, actions)).toBeNull();
    expect(retry.noteBuild(app, "nightly-48")).toEqual([]);
    expect(tries).toBe(2);
    // The export failed again (still noted): the next build tries it again.
    expect(failedExports(home)[cops]).toBeDefined();
    expect(retry.noteBuild(app, "nightly-49").map((one) => one.kind)).toEqual(["share", "export"]);
  } finally {
    cleanup();
  }
});

test("an export that fails is noted with its settings and build, a share's as a share's, and forgotten once the project exports; the panel says a retry's note", async () => {
  const { dir, home, store, app, native, cleanup } = fixtureHome("retry-noted-failures");
  const registry = new ExportRegistry(home);
  app.exports = registry;
  const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 });
  let fail = true;
  const render = spyOn(native.ExportJob, "start").mockImplementation((job) => ({
    cancel: () => {},
    wait: async () => {
      if (fail) throw new Error("Native encoder stalled");
      fs.writeFileSync(job.output, "export");
      return { seconds: 1, bytes: 6 };
    },
  }));
  const settle = async () => {
    for (let tries = 0; registry.running() && tries < 200; tries++) await Bun.sleep(5);
  };
  try {
    const project = store.create("one", { width: 64, height: 36, fps: 30 }).project;
    await store.update(project.id, "test", (p) => p.clips.push(clip({ id: "solid", track: p.tracks[0]!.id, start: 0, duration: 30, type: "solid" })));
    const options = native.exportDefaults();
    await registry.start(store, app.library, store.get(project.id)!.project, options, `${dir}/one.mp4`, { share: true });
    await settle();
    const noted = failedExports(home)[project.id];
    expect(noted).toMatchObject({ project: project.id, error: expect.stringContaining("Native encoder stalled"), share: true, options: { format: options.format } });
    expect(typeof noted?.build).toBe("string");
    // The retry: its note in the panel; succeeding, the failure is forgotten.
    fail = false;
    await registry.start(store, app.library, store.get(project.id)!.project, options, `${dir}/one.mp4`, { note: retry.NOTE });
    expect(registry.activity()[0]?.note).toBe(retry.NOTE);
    await settle();
    expect(registry.activity()[0]).toMatchObject({ state: "done", note: retry.NOTE });
    expect(failedExports(home)[project.id]).toBeUndefined();
  } finally {
    render.mockRestore(); plan.mockRestore(); cleanup();
  }
});

test("the real retry of a share exports through the share, its export saying it's a retry, and a failure leaves it for the next build", async () => {
  const { app, home, mom, cleanup } = setUp("retry-real-share", "nightly-47");
  const started: Record<string, unknown>[] = [];
  (app as unknown as { exports: unknown }).exports = {
    running: () => false,
    runningFor: () => null,
    cancel: () => false,
    exported: () => false,
    start: async (_store: unknown, _library: unknown, _project: unknown, _options: unknown, path: string, extra: Record<string, unknown>) => {
      started.push(extra);
      setTimeout(() => app.store.emit({ type: "export", id: mom, state: "done", progress: 1, path }), 10);
      return path;
    },
  };
  try {
    retry.noteBuild(app, "nightly-48");
    expect(await retry.step(app)).toBe("shared");
    expect(started).toEqual([{ share: true, note: retry.NOTE }]);
    // The fixture has no export on record, so the share stops after the export: still unshared, for the next build.
    expect((JSON.parse(fs.readFileSync(`${home}/reviews.json`, "utf8")) as { unshared?: Record<string, true> }).unshared?.[mom]).toBe(true);
    expect(retry.noteBuild(app, "nightly-49").some((one) => one.kind === "share" && one.project === mom)).toBe(true);
  } finally {
    cleanup();
  }
});
