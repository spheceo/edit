// Update goes through mid-import (Sphe, Nov 10: "be able to update mid import. this is important"): before Edit
// restarts itself, a script's import is interrupted, so it stays importing and the next start carries it on, and the
// job table is kept as it is, so nothing the restart's stop makes fail is written down as failed.

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";

import * as busy from "../src/busy.ts";
import { importDrive } from "../src/drive_import.ts";
import * as jobs from "../src/jobs.ts";
import * as macSpeech from "../src/mac_speech.ts";
import * as tools from "../src/tools.ts";
import { timing } from "../src/transcribe.ts";
import * as captionTurns from "../src/writer/caption_turns.ts";
import * as imports from "../src/writer/imports.ts";
import * as store from "../src/writer/store.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer, scribeAnswer } from "./mocks/server.ts";

const ffmpeg = Bun.which("ffmpeg");
let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "relay-token" });
  timing.instant = true;
  tools.forget();
  macSpeech.timing.helper = null;
  captionTurns.asking.ask = () => async () => {
    throw new Error("no Claude in tests");
  };
});
afterAll(() => {
  macSpeech.timing.helper = undefined;
  restore();
  mock.stop();
});

test.skipIf(ffmpeg === null)("a script's import stopped for an update stays importing, asks the transcriber nothing more, and carries on after it to the end", async () => {
  const { dir, app, cleanup } = fixtureHome("update-mid-import");
  try {
    const data = store.dataDir(app.store.home);
    const source = `${dir}/call.m4a`;
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=200", "-c:a", "aac", "-b:a", "32k", source]).exitCode).toBe(0);
    // Each piece answered slowly: the import is mid-transcription when the update comes.
    mock.on("POST", "/v1/transcribe", async () => (await Bun.sleep(1_500), Response.json(scribeAnswer(["Where", "were", "you?"]))));
    const script = await imports.fromFile(app, data, source, null, "Mid import", null, null, "started");
    for (let i = 0; i < 200 && mock.calls("/v1/transcribe").length === 0; i++) await Bun.sleep(50);
    expect(mock.calls("/v1/transcribe").length).toBeGreaterThan(0);
    // An update doesn't wait for it.
    expect(busy.wouldLose(app)).toEqual([]);

    expect(await imports.stopAll()).toBe(1);
    expect(imports.importing(script.id)).toBe(false);
    const asked = mock.calls("/v1/transcribe").length;
    await Bun.sleep(3_000);
    // Nothing more asked of the transcriber, and the script is still importing on disk, not stopped as failed.
    expect(mock.calls("/v1/transcribe").length).toBe(asked);
    expect(store.read(store.scriptDir(data, script.id)).status).toBe("processing");

    // The next start: named as cut off by the restart, and carried on to the end.
    mock.on("POST", "/v1/transcribe", () => Response.json(scribeAnswer(["Where", "were", "you?"])));
    expect(store.markInterrupted(data)).toEqual([script.id]);
    const done = await imports.resume(app, data, script.id, { kind: "retry" });
    expect(done.status).toBe("ready");
    expect(done.words.length).toBeGreaterThan(0);
    expect(await imports.stopAll()).toBe(0);
  } finally {
    cleanup();
  }
}, 120_000);

test("footage from a Drive link is listed while it comes in, and once Edit is restarting nothing it ends is written", async () => {
  const { app, cleanup } = fixtureHome("update-drive-link");
  try {
    const home = app.store.home;
    const footage = () => JSON.parse(fs.existsSync(`${home}/jobs.json`) ? fs.readFileSync(`${home}/jobs.json`, "utf8") : "[]").filter((job: jobs.Job) => job.kind === "footage");
    // Ended as it fails (no Drive link): not left behind.
    await expect(importDrive(app, "p1", "https://example.com/not-drive", true, "")).rejects.toThrow("isn't a Google Drive");
    expect(footage()).toEqual([]);
    // Restarting: what it was is kept, so the next start carries it on.
    const key = jobs.begin(home, "footage", "p1", { url: "https://drive.google.com/drive/folders/abcdefghijk", place: true, origin: "" }, "x");
    jobs.freeze();
    try {
      jobs.end(home, key);
      jobs.settle(home, key, "failed", { error: "killed" });
      await expect(importDrive(app, "p1", "https://example.com/not-drive", true, "")).rejects.toThrow();
      expect(footage()).toMatchObject([{ key, state: "running", args: { place: true } }]);
    } finally {
      jobs.freeze(false);
    }
  } finally {
    cleanup();
  }
});
