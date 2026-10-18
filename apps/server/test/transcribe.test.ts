import { afterAll, beforeAll, expect, test } from "bun:test";

import * as fs from "node:fs";

import * as tools from "../src/tools.ts";
import { parseScribe, run, serialize, timing } from "../src/transcribe.ts";
import { scratch } from "./helpers/home.ts";
import { MockServer, scribeAnswer } from "./mocks/server.ts";

test("keeps_spoken_words_only", () => {
  const transcript = parseScribe({
    language_code: "eng",
    words: [
      { text: "Hello", start: 0.1, end: 0.4, type: "word", speaker_id: "speaker_0" },
      { text: " ", start: 0.4, end: 0.5, type: "spacing" },
      { text: "(laughs)", start: 0.5, end: 0.9, type: "audio_event" },
      { text: "there", start: 0.9, end: 1.2, type: "word", speaker_id: "speaker_0" },
    ],
  });
  expect(transcript.words.length).toBe(2);
  expect(transcript.words[1]!.text).toBe("there");
  expect(transcript.language).toBe("eng");
});

test("no words is an error, and odd times are made sane", () => {
  expect(() => parseScribe({ language_code: "eng" })).toThrow("the transcription service returned no words");
  const transcript = parseScribe({ words: [{ text: " hi ", start: -1, end: -2, type: "word" }] });
  expect(transcript.words).toEqual([{ text: "hi", start: 0, end: -1 }]);
  expect(transcript.language).toBeNull();
});

test("a transcript is written with its fields in order", () => {
  expect(
    serialize({
      model: "scribe_v2",
      language: "eng",
      words: [{ text: "Hi", start: 0.5, end: 0.75, speaker: "speaker_1" }, { text: "you", start: 1, end: 1.5 }],
      speakers: { speaker_1: "Officer", speaker_0: "Jane" },
    }),
  ).toBe(
    '{"model":"scribe_v2","language":"eng","words":[{"text":"Hi","start":0.5,"end":0.75,"speaker":"speaker_1"},{"text":"you","start":1,"end":1.5}],"speakers":{"speaker_0":"Jane","speaker_1":"Officer"}}',
  );
});

const ffmpeg = Bun.which("ffmpeg");

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "relay-token" });
  timing.sleep = async () => {};
  tools.forget();
});

afterAll(() => {
  restore();
  mock.stop();
});

test.skipIf(ffmpeg === null)("transcribes through the relay, asking again while it's busy", async () => {
  const { dir, cleanup } = scratch("transcribe");
  try {
    const source = `${dir}/tone.wav`;
    const made = Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", source]);
    expect(made.exitCode).toBe(0);
    mock.on("POST", "/v1/transcribe", () => Response.json({ error: "busy" }, { status: 429 }), 2);
    const target = `${dir}/cache/transcript.json`;
    fs.mkdirSync(`${dir}/cache`);
    await run(source, target);
    const sent = mock.calls("/v1/transcribe", "POST");
    expect(sent.length).toBe(3);
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer relay-token");
    expect(sent[0]!.headers.get("content-type")).toBe("audio/ogg");
    expect(sent[0]!.body.length).toBeGreaterThan(100);
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual(parseScribe(scribeAnswer()));
    // The audio sent is never left behind.
    expect(fs.existsSync(`${dir}/cache/transcript.ogg`)).toBe(false);

    mock.on("POST", "/v1/transcribe", () => Response.json({ detail: { message: "quota exceeded" } }, { status: 402 }), 1);
    await expect(run(source, `${dir}/cache/again.json`)).rejects.toThrow("transcription failed (402): quota exceeded");
    await expect(run(`${dir}/missing.wav`, `${dir}/cache/none.json`)).rejects.toThrow(/^could not extract audio: /);
  } finally {
    cleanup();
  }
});
