// A Script import as one Effect: when its words fail, the preview being made beside them is
// stopped with it (its FFmpeg ended, nothing half-made left), and the failure keeps its kind.

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";

import * as tools from "../../src/tools.ts";
import * as captionTurns from "../../src/writer/caption_turns.ts";
import { timing } from "../../src/transcribe.ts";
import * as imports from "../../src/writer/imports.ts";
import * as store from "../../src/writer/store.ts";
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
  // Who says each line asks Claude: not here (it waited on the real one, 10–16 s, and the wait below ran out).
  captionTurns.asking.ask = () => async () => {
    throw new Error("no Claude in tests");
  };
});
afterAll(() => {
  restore();
  mock.stop();
});

const ffmpegsFor = (path: string) => Bun.spawnSync(["pgrep", "-f", path]).stdout.toString().trim().split("\n").filter(Boolean).length;

test.skipIf(ffmpeg === null)("an import whose words fail stops its preview too, and says the failure with its kind", async () => {
  const { dir, app, cleanup } = fixtureHome("import-stops");
  try {
    // 20 minutes of sound: its preview (sound over black) takes a while to make.
    const source = `${dir}/interview.m4a`;
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=1200", "-c:a", "aac", "-b:a", "32k", source]).exitCode).toBe(0);
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
    await Bun.sleep(500);
    expect(ffmpegsFor(scriptDir)).toBe(0);
    expect(fs.existsSync(store.proxyPath(scriptDir))).toBe(false);
  } finally {
    cleanup();
  }
}, 60_000);

test.skipIf(ffmpeg === null)("an import asked for by a route is answered once its script exists, carries on alone and says how it ended (JJ, Nov 1)", async () => {
  const { dir, app, cleanup } = fixtureHome("import-started");
  try {
    const data = store.dataDir(app.store.home);
    // A refusal before the script exists is answered at once, as before.
    await expect(imports.fromFile(app, data, `${dir}/nowhere.m4a`, null, "Nowhere", null, "started")).rejects.toThrow("can't be opened");
    expect(store.ids(data)).toHaveLength(0);

    const source = `${dir}/call.m4a`;
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=20", "-c:a", "aac", "-b:a", "32k", source]).exitCode).toBe(0);
    mock.on("POST", "/v1/transcribe", async () => (await Bun.sleep(800), Response.json(scribeAnswer(["Where", "were", "you?"]))));
    const asked = Date.now();
    const answered = await imports.fromFile(app, data, source, null, "Started", null, "started");
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
    const second = await imports.fromFile(app, data, source, null, "Stops later", null, "started");
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
