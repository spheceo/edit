// A Script import as one Effect: when its words fail, the preview being made beside them is
// stopped with it (its FFmpeg ended, nothing half-made left), and the failure keeps its kind.

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";

import * as jobs from "../../src/jobs.ts";
import * as macSpeech from "../../src/mac_speech.ts";
import { waitingByItself } from "../../src/remote_actions.ts";
import * as tools from "../../src/tools.ts";
import * as captionTurns from "../../src/writer/caption_turns.ts";
import { timing } from "../../src/transcribe.ts";
import * as imports from "../../src/writer/imports.ts";
import * as store from "../../src/writer/store.ts";
import * as writerJobs from "../../src/writer/jobs.ts";
import { fixtureHome } from "../helpers/home.ts";
import { MockServer, scribeAnswer } from "../mocks/server.ts";

const ffmpeg = Bun.which("ffmpeg");
let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "relay-token" });
  timing.instant = true;
  tools.forget();
  // The words come from Scribe (the mock relay) whatever Mac runs this: on one that hears on device (macOS 26 with
  // edit-speech built), Apple heard the 8 minutes first, the preview was made meanwhile, and the first test failed.
  macSpeech.timing.helper = null;
  // Who says each line asks Claude: not here (it waited on the real one, 10–16 s, and the wait below ran out).
  captionTurns.asking.ask = () => async () => {
    throw new Error("no Claude in tests");
  };
});
afterAll(() => {
  macSpeech.timing.helper = undefined;
  restore();
  mock.stop();
});

const ffmpegsFor = (path: string) => Bun.spawnSync(["pgrep", "-f", path]).stdout.toString().trim().split("\n").filter(Boolean).length;
/**
 * The FFmpegs still running on `path` once they've had up to 5 s to go: a stop
 * kills them at once, but a loaded CI runner can take past half a second to reap
 * one (Nov 10: Check red on Linux, 1 still there at 500 ms; 25 of 25 passed on a desk).
 */
async function ffmpegsLeft(path: string): Promise<number> {
  for (let waited = 0; waited < 5_000 && ffmpegsFor(path) > 0; waited += 100) await Bun.sleep(100);
  return ffmpegsFor(path);
}

test.skipIf(ffmpeg === null)("an import whose words fail stops its preview too, and says the failure with its kind", async () => {
  const { dir, app, cleanup } = fixtureHome("import-stops");
  try {
    // 8 minutes of sound: its preview (sound over black) takes a while to make (20 minutes ran past the test's time in the full suite).
    const source = `${dir}/interview.m4a`;
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=480", "-c:a", "aac", "-b:a", "32k", source]).exitCode).toBe(0);
    // The relay refuses at once (a quota): not asked again, so the words fail long before the preview is made.
    mock.on("POST", "/v1/transcribe", () => Response.json({ detail: { message: "quota exceeded" } }, { status: 402 }));
    const data = store.dataDir(app.store.home);
    const failed = await imports.fromFile(app, data, source, null, "Stops", null).catch((error: unknown) => error);
    expect((failed as Error).message).toContain("quota exceeded");
    expect((failed as imports.ImportStopped).kind).toBe("later");
    const [id] = store.ids(data);
    const scriptDir = store.scriptDir(data, id!);
    const script = store.read(scriptDir);
    expect(script.status).toBe("error");
    expect(script.stuckOn).toBeUndefined();
    // The preview's FFmpeg is gone, and no half-made preview is left.
    expect(await ffmpegsLeft(scriptDir)).toBe(0);
    expect(fs.existsSync(store.proxyPath(scriptDir))).toBe(false);
  } finally {
    cleanup();
  }
}, 120_000);

test.skipIf(ffmpeg === null)("an import asked for by a route is answered once its script exists, carries on alone and says how it ended (JJ, Nov 1)", async () => {
  const { dir, app, cleanup } = fixtureHome("import-started");
  try {
    const data = store.dataDir(app.store.home);
    // A refusal before the script exists is answered at once, as before.
    await expect(imports.fromFile(app, data, `${dir}/nowhere.m4a`, null, "Nowhere", null, null, "started")).rejects.toThrow("can't be opened");
    expect(store.ids(data)).toHaveLength(0);

    const source = `${dir}/call.m4a`;
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=20", "-c:a", "aac", "-b:a", "32k", source]).exitCode).toBe(0);
    mock.on("POST", "/v1/transcribe", async () => (await Bun.sleep(800), Response.json(scribeAnswer(["Where", "were", "you?"]))));
    const asked = Date.now();
    const answered = await imports.fromFile(app, data, source, null, "Started", null, null, "started");
    // Answered before the import is through: it's importing, its slot held.
    expect(Date.now() - asked).toBeLessThan(700);
    expect(answered.status).toBe("processing");
    expect(imports.importing(answered.id)).toBe(true);
    for (let i = 0; i < 200 && imports.importing(answered.id); i++) await Bun.sleep(50);
    expect(imports.importing(answered.id)).toBe(false);
    const now = store.read(store.scriptDir(data, answered.id));
    expect(now.status).toBe("ready");
    expect(now.words.length).toBeGreaterThan(0);

    // One that stops does so on the script, with its reason; its slot is let go too.
    mock.on("POST", "/v1/transcribe", () => Response.json({ detail: { message: "quota exceeded" } }, { status: 402 }));
    const second = await imports.fromFile(app, data, source, null, "Stops later", null, null, "started");
    expect(second.status).toBe("processing");
    for (let i = 0; i < 200 && imports.importing(second.id); i++) await Bun.sleep(50);
    const stopped = store.read(store.scriptDir(data, second.id));
    expect(stopped.status).toBe("error");
    expect(stopped.error).toContain("quota exceeded");
    // Retry, answered the same way.
    mock.on("POST", "/v1/transcribe", () => Response.json(scribeAnswer(["Where", "were", "you?"])));
    const retried = await imports.resume(app, data, second.id, { kind: "retry" }, "started");
    expect(retried.status).toBe("processing");
    for (let i = 0; i < 200 && imports.importing(second.id); i++) await Bun.sleep(50);
    expect(store.read(store.scriptDir(data, second.id)).status).toBe("ready");

    // Made with a first build (New project): built once its import is ready, no longer importing by then
    // (the build refuses a script still importing: JJ's Mac, Nov 3–6, 16 of 16 never built).
    const built: { id: string; note: string; importing: boolean }[] = [];
    const hook = imports.hooks.build;
    imports.hooks.build = (_app, id, note) => void built.push({ id, note, importing: imports.importing(id) });
    try {
      const third = await imports.fromFile(app, data, source, null, "Builds after", null, { note: "the first message" }, "started");
      for (let i = 0; i < 200 && built.length === 0; i++) await Bun.sleep(50);
      expect(built).toEqual([{ id: third.id, note: "the first message", importing: false }]);
      expect(store.read(store.scriptDir(data, third.id)).firstBuild).toBeUndefined();
    } finally {
      imports.hooks.build = hook;
    }
  } finally {
    cleanup();
  }
}, 60_000);

test("footage Edit made whose sound can't be read is taken away to be made again; a person's own file never is (Nov 1, Mom Secretly)", () => {
  const { dir, cleanup } = fixtureHome("import-remake");
  try {
    const scriptDir = `${dir}/s`;
    fs.mkdirSync(`${scriptDir}/drive`, { recursive: true });
    fs.mkdirSync(`${scriptDir}/pieces`, { recursive: true });
    for (const file of ["proxy.mp4", "pieces/a.mp4", "drive/00-rec.mp4", "drive/00-rec.mp4.verified", "drive/manifest.json"]) fs.writeFileSync(`${scriptDir}/${file}`, "x");
    const script = { sourceKind: "drive", originalPath: `${scriptDir}/proxy.mp4` } as Parameters<typeof imports.remakeFootage>[1];
    expect(imports.remakeFootage(scriptDir, script)).toBe(true);
    expect(fs.existsSync(`${scriptDir}/proxy.mp4`)).toBe(false);
    expect(fs.existsSync(`${scriptDir}/pieces`)).toBe(false);
    expect(fs.existsSync(`${scriptDir}/drive/00-rec.mp4`)).toBe(false);
    expect(fs.existsSync(`${scriptDir}/drive/00-rec.mp4.verified`)).toBe(false);
    expect(fs.existsSync(`${scriptDir}/drive/manifest.json`)).toBe(true);
    // Nothing left to make again: not asked twice.
    expect(imports.remakeFootage(scriptDir, script)).toBe(false);
    // A person's own file is theirs.
    fs.writeFileSync(`${dir}/mine.mp4`, "x");
    expect(imports.remakeFootage(scriptDir, { sourceKind: "file", originalPath: `${dir}/mine.mp4` } as Parameters<typeof imports.remakeFootage>[1])).toBe(false);
    expect(fs.existsSync(`${dir}/mine.mp4`)).toBe(true);
    expect(imports.unreadable({ _tag: "AudioUnreadable", message: "x" })).toBe(true);
    expect(imports.unreadable(new Error("could not extract audio: [aac @ 0x1] channel element 0.0 duplicate"))).toBe(true);
    expect(imports.unreadable(new Error("could not reach the transcription relay"))).toBe(false);
  } finally {
    cleanup();
  }
});

test.skipIf(ffmpeg === null)("an import refused for the transcription plan's credit waits in the job table, said once in Needs attention, and is woken to try again", async () => {
  const { dir, app, cleanup } = fixtureHome("import-credit");
  try {
    const source = `${dir}/call.m4a`;
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=20", "-c:a", "aac", "-b:a", "32k", source]).exitCode).toBe(0);
    // ElevenLabs' answer when the plan runs out (Nov 8, four imports on two Macs).
    mock.on("POST", "/v1/transcribe", () => Response.json({ detail: { status: "quota_exceeded", message: "This request exceeds your quota of 100000. You have 15 credits remaining, while 230 credits are required for this request." } }, { status: 401 }));
    const data = store.dataDir(app.store.home);
    const failed = await imports.fromFile(app, data, source, null, "Credit", null).catch((error: unknown) => error);
    expect((failed as Error).message).toContain("The transcription plan is out of credit; Edit tries again by itself at");
    const [id] = store.ids(data);
    const waiting = jobs.get(app.store.home, jobs.keyOf("script", id!));
    expect(waiting).toMatchObject({ kind: "script", state: "waiting", args: { waiting_on: "quota" } });
    expect(waiting!.retry_at).toBeGreaterThan(Date.now() + 20 * 60_000);
    expect(waitingByItself(app.store.home)[0]).toStartWith("The transcription plan is out of credit: 1 import waiting");
    // Never cut short by a restart, nor tried before its time.
    expect(jobs.takeOver(app.store.home, ["script"])).toEqual([]);
    const woken: string[] = [];
    jobs.useResumers(app.store.home, { script: (job) => void woken.push(job.project) });
    await jobs.wake(app.store.home, ["script"]);
    expect(woken).toEqual([]);
    // Its time come: the one resumer tries it again.
    const listed = JSON.parse(fs.readFileSync(`${app.store.home}/jobs.json`, "utf8")) as jobs.Job[];
    for (const job of listed) if (job.kind === "script") job.retry_at = Date.now() - 1;
    fs.writeFileSync(`${app.store.home}/jobs.json`, JSON.stringify(listed));
    await jobs.wake(app.store.home, ["script"]);
    expect(woken).toEqual([id!]);
  } finally {
    cleanup();
  }
}, 120_000);

test.skipIf(ffmpeg === null)("deleting a script stops its import first; Claude on a script is stopped and waited for (JJ, Nov 10: Delete said \"This import is still running\" and held off the update)", async () => {
  const { dir, app, cleanup } = fixtureHome("import-delete");
  try {
    const data = store.dataDir(app.store.home);
    const source = `${dir}/call.m4a`;
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=20", "-c:a", "aac", "-b:a", "32k", source]).exitCode).toBe(0);
    // The words take long: the import is still running when it's stopped.
    mock.on("POST", "/v1/transcribe", async () => (await Bun.sleep(20_000), Response.json(scribeAnswer(["Too", "late"]))));
    expect(await imports.stop("5b1f0c2d-3e4a-4b6c-9d7e-8f0a1b2c3d4e")).toBe(false);
    for (const answer of ["started", "finished"] as const) {
      const built: string[] = [];
      const hook = imports.hooks.build;
      imports.hooks.build = (_app, id) => void built.push(id);
      try {
        const ending = answer === "finished" ? imports.fromFile(app, data, source, null, `Unwanted ${answer}`, null, { note: "" }, "finished").catch((error: unknown) => error) : null;
        if (ending !== null) for (let i = 0; i < 100 && store.ids(data).length === 0; i++) await Bun.sleep(20);
        const script = answer === "started" ? await imports.fromFile(app, data, source, null, `Unwanted ${answer}`, null, { note: "" }, "started") : store.read(store.scriptDir(data, store.ids(data)[0]!));
        await Bun.sleep(300);
        expect(imports.importing(script.id)).toBe(true);
        const asked = Date.now();
        expect(await imports.stop(script.id)).toBe(true);
        expect(Date.now() - asked).toBeLessThan(5_000);
        expect(imports.importing(script.id)).toBe(false);
        expect(imports.anyImporting()).toBe(false);
        store.remove(data, script.id);
        if (ending !== null) await ending;
        // Nothing of it comes back, and no build starts.
        await Bun.sleep(500);
        expect(fs.existsSync(store.scriptDir(data, script.id))).toBe(false);
        expect(await ffmpegsLeft(store.scriptDir(data, script.id))).toBe(0);
        expect(built).toEqual([]);
      } finally {
        imports.hooks.build = hook;
      }
    }

    // Claude on a script: stopped, and the delete waits for its last word.
    const id = "6c2f0c2d-3e4a-4b6c-9d7e-8f0a1b2c3d4e";
    fs.mkdirSync(store.scriptDir(data, id), { recursive: true });
    writerJobs.start(data, id, "Busy", { kind: "build", note: "" } as writerJobs.Work, async (job) => {
      await new Promise((resolve) => job.signal.addEventListener("abort", resolve));
      await Bun.sleep(200);
      throw new Error("stopped");
    });
    expect(writerJobs.running(id)).toBe(true);
    expect(await writerJobs.stopAndWait(id)).toBe(true);
    expect(writerJobs.running(id)).toBe(false);
    expect(await writerJobs.stopAndWait(id)).toBe(true);
    // One that won't let go in time is said so.
    writerJobs.start(data, id, "Stuck", { kind: "build", note: "" } as writerJobs.Work, () => new Promise(() => {}));
    expect(await writerJobs.stopAndWait(id, 100)).toBe(false);
  } finally {
    // The stuck one never ends: forgotten, so no later test finds it still running.
    writerJobs.resetForTests();
    cleanup();
  }
}, 120_000);
