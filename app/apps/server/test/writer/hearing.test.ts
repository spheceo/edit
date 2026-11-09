// writer/hearing.ts: a stretch cut and heard in one scope; a stop ends both and leaves nothing behind.

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";

import * as tools from "../../src/tools.ts";
import { plan, timing } from "../../src/transcribe.ts";
import * as voices from "../../src/voices.ts";
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

test.skipIf(ffmpeg === null)("with pyannote's voices on, a long recording is heard by Scribe in pieces only, never whole, and its voices are pyannote's", async () => {
  const { dir, cleanup } = scratch("hearing-pyannote");
  try {
    // Longer than one request hears whole (90 s): without pyannote it would be heard in pieces and whole.
    const source = `${dir}/long.wav`;
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=100", source]).exitCode).toBe(0);
    mock.on("POST", "/v1/diarize/jobs", () => Response.json({ id: "job-writer" }, { status: 202 }));
    mock.on("GET", "/v1/diarize/jobs/job-writer", () => Response.json({ segments: [{ start: 0, end: 100, speaker: "SPEAKER_07" }] }));
    voices.setOnForTests(true);
    voices.timing.pollMs = 1;
    const before = mock.requests.length;
    const heard = await hear(source, null, `${dir}/work`, []);
    const asked = mock.requests.slice(before);
    expect(asked.filter((one) => one.path === "/v1/transcribe/jobs")).toHaveLength(0);
    expect(asked.filter((one) => one.method === "POST" && one.path === "/v1/transcribe")).toHaveLength(plan(100).length);
    expect(asked.filter((one) => one.method === "POST" && one.path === "/v1/diarize/jobs")).toHaveLength(1);
    expect(heard.voices).toBe(voices.MODEL);
    expect(new Set(heard.words.map((word) => word.speaker))).toEqual(new Set(["speaker_7"]));
    expect(fs.existsSync(`${dir}/work/transcript.whole.json`)).toBe(false);
  } finally {
    voices.setOnForTests(null);
    cleanup();
  }
}, 30_000);
