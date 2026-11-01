// writer/hearing.ts: a stretch cut and heard in one scope; a stop ends both and leaves nothing behind.

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";

import * as tools from "../../src/tools.ts";
import { timing } from "../../src/transcribe.ts";
import { hear } from "../../src/writer/hearing.ts";
import { scratch } from "../helpers/home.ts";
import { MockServer, scribeAnswer } from "../mocks/server.ts";

const ffmpeg = Bun.which("ffmpeg");
let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "relay-token" });
  timing.instant = true;
  tools.forget();
});
afterAll(() => {
  restore();
  mock.stop();
});

test.skipIf(ffmpeg === null)("a stretch is cut, heard and its cut removed; a stop mid-hearing says so and leaves no cut behind", async () => {
  const { dir, cleanup } = scratch("hearing");
  try {
    const source = `${dir}/tone.wav`;
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", source]).exitCode).toBe(0);
    const heard = await hear(source, [500, 1500], `${dir}/work`, []);
    expect(heard.words.length).toBeGreaterThan(0);
    expect(fs.existsSync(`${dir}/work/stretch.m4a`)).toBe(false);

    // The relay slow to answer, and the job stopped while it waits.
    let slow = true;
    mock.on("POST", "/v1/transcribe", async () => (slow ? (await Bun.sleep(3000), Response.json(scribeAnswer())) : Response.json(scribeAnswer())));
    const stop = new AbortController();
    const stopped = hear(source, [500, 1500], `${dir}/stopped`, [], stop.signal);
    setTimeout(() => stop.abort(), 800);
    await expect(stopped).rejects.toThrow("Stopped by you. Completed work is saved.");
    slow = false;
    expect(fs.existsSync(`${dir}/stopped/stretch.m4a`)).toBe(false);
    expect(fs.existsSync(`${dir}/stopped/transcript.json`)).toBe(false);
  } finally {
    cleanup();
  }
}, 30_000);
