import { afterAll, beforeAll, expect, test } from "bun:test";

import * as fs from "node:fs";

import * as tools from "../src/tools.ts";
import { aligned, join, parseScribe, plan, run, serialize, timing, voicesFrom, type Word } from "../src/transcribe.ts";
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
    // The day's allowance used up: told at once, not after minutes of asking again.
    const asked = mock.calls("/v1/transcribe", "POST").length;
    mock.on("POST", "/v1/transcribe", () => Response.json({ error: "Today's transcription allowance for this connection is used up" }, { status: 429 }), 1);
    await expect(run(source, `${dir}/cache/allowance.json`)).rejects.toThrow("allowance");
    expect(mock.calls("/v1/transcribe", "POST").length).toBe(asked + 1);
    await expect(run(`${dir}/missing.wav`, `${dir}/cache/none.json`)).rejects.toThrow(/^could not extract audio: /);
  } finally {
    cleanup();
  }
});

test.skipIf(ffmpeg === null)("what was heard is kept: a run cut short pays only for the rest, and hearing it again for names asks only for the pieces", async () => {
  const { dir, cleanup } = scratch("transcribe-kept");
  try {
    const source = `${dir}/tone.wav`;
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=100", source]).exitCode).toBe(0);
    fs.mkdirSync(`${dir}/cache`);
    const target = `${dir}/cache/transcript.json`;
    // 100 s: three pieces and the whole file, four requests; the first one asked fails.
    const before = mock.calls("/v1/transcribe", "POST").length;
    mock.on("POST", "/v1/transcribe", () => Response.json({ detail: { message: "quota exceeded" } }, { status: 402 }), 1);
    await expect(run(source, target)).rejects.toThrow("quota exceeded");
    await run(source, target);
    expect(mock.calls("/v1/transcribe", "POST").length - before).toBe(5);
    expect(fs.existsSync(`${dir}/cache/transcript.pieces`)).toBe(false);
    expect(fs.existsSync(`${dir}/cache/transcript.whole.json`)).toBe(true);
    // With the case's names: the pieces again, not the whole file.
    const from = mock.calls("/v1/transcribe", "POST").length;
    await run(source, target, ["John Ruetten"]);
    const asked = mock.calls("/v1/transcribe", "POST").slice(from);
    expect(asked.map((call) => call.query.getAll("keyterm"))).toEqual([["John Ruetten"], ["John Ruetten"], ["John Ruetten"]]);
  } finally {
    cleanup();
  }
});

test.skipIf(ffmpeg === null)("listens for the case's names, and asks once without them when Scribe refuses them", async () => {
  const { dir, cleanup } = scratch("transcribe-names");
  try {
    const source = `${dir}/tone.wav`;
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", source]).exitCode).toBe(0);
    fs.mkdirSync(`${dir}/cache`);
    const before = mock.calls("/v1/transcribe", "POST").length;
    await run(source, `${dir}/cache/named.json`, ["John Ruetten", "Van Nuys"]);
    const asked = mock.calls("/v1/transcribe", "POST").slice(before);
    expect(asked.map((call) => call.query.getAll("keyterm"))).toEqual([["John Ruetten", "Van Nuys"]]);
    expect(JSON.parse(fs.readFileSync(`${dir}/cache/named.json`, "utf8")).keyterms).toEqual(["John Ruetten", "Van Nuys"]);

    mock.on("POST", "/v1/transcribe", () => Response.json({ detail: { message: "invalid keyterms" } }, { status: 422 }), 1);
    const from = mock.calls("/v1/transcribe", "POST").length;
    await run(source, `${dir}/cache/refused.json`, ["John Ruetten"]);
    expect(mock.calls("/v1/transcribe", "POST").slice(from).map((call) => call.query.getAll("keyterm"))).toEqual([["John Ruetten"], []]);
    // Kept as asked, so they aren't asked (and refused) again.
    expect(JSON.parse(fs.readFileSync(`${dir}/cache/refused.json`, "utf8")).keyterms).toEqual(["John Ruetten"]);
  } finally {
    cleanup();
  }
});

test("a long file is planned as even pieces of at most 40 s, each heard with 4 s either side", () => {
  const pieces = plan(100);
  expect(pieces.length).toBe(3);
  expect(pieces[0]).toEqual({ coreFrom: 0, coreTo: 100 / 3, from: 0, to: 100 / 3 + 4 });
  expect(pieces[2]!.to).toBe(100);
  expect(pieces[1]!.from).toBeCloseTo(100 / 3 - 4);
});

const w = (text: string, start: number, speaker?: string): Word => ({ text, start, end: start + 0.3, ...(speaker ? { speaker } : {}) });

test("pieces are joined at a word both heard at the same moment, nothing lost or heard twice", () => {
  const pieces = [
    { coreFrom: 0, coreTo: 10, from: 0, to: 14 },
    { coreFrom: 10, coreTo: 20, from: 6, to: 20 },
  ];
  const left = [w("we", 8), w("were", 8.5), w("going", 9.6), w("to", 10.2), w("the", 10.6), w("car", 11)];
  const right = [w("we're", 8.1), w("going", 9.65), w("to", 10.25), w("the", 10.6), w("car", 11.05), w("now", 12)];
  expect(join(pieces, [left, right]).map((word) => word.text)).toEqual(["we", "were", "going", "to", "the", "car", "now"]);
  // Nothing in common: handed over at the seam.
  const quiet = join(pieces, [[w("hello", 9), w("there", 10.5)], [w("hey", 9.2), w("you", 10.6), w("again", 13)]]);
  expect(quiet.map((word) => word.text)).toEqual(["hello", "you", "again"]);
});

test("each word takes the voice the whole file heard it in, matched by what's said", () => {
  // The whole file's times drift by 20 s; its voices hold.
  const whole = [w("Hey", 30, "speaker_1"), w("man,", 30.3, "speaker_1"), w("are", 30.6, "speaker_1"), w("you", 31, "speaker_1"), w("Reginald?", 31.3, "speaker_1"), w("Yes,", 33, "speaker_0"), w("I", 33.2, "speaker_0"), w("am.", 33.4, "speaker_0")];
  const words = [w("Hey,", 10), w("man,", 10.3), w("are", 10.6), w("you", 11), w("Reginald?", 11.3), w("Uh,", 12.6), w("yes,", 13), w("I", 13.2), w("am.", 13.4)];
  voicesFrom(words, whole);
  expect(words.map((word) => word.speaker)).toEqual(["speaker_1", "speaker_1", "speaker_1", "speaker_1", "speaker_1", "speaker_0", "speaker_0", "speaker_0", "speaker_0"]);
  expect(aligned(["a", "b", "c"], ["x", "a", "c"])).toEqual([[0, 1], [2, 2]]);
});

test.skipIf(ffmpeg === null)("a long file is heard whole and in pieces at once, its words from the pieces", async () => {
  const { dir, cleanup } = scratch("transcribe-long");
  try {
    const source = `${dir}/long.wav`;
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=100", source]).exitCode).toBe(0);
    fs.mkdirSync(`${dir}/cache`);
    const before = mock.calls("/v1/transcribe", "POST").length;
    await run(source, `${dir}/cache/long.json`, ["McCall"]);
    const asked = mock.calls("/v1/transcribe", "POST").slice(before);
    // The whole file and its three pieces, each with the case's names.
    expect(asked.length).toBe(4);
    expect(asked.every((call) => call.query.getAll("keyterm").join() === "McCall")).toBe(true);
    const written = JSON.parse(fs.readFileSync(`${dir}/cache/long.json`, "utf8"));
    // Each piece "heard" Hello there. in its first second: the second and third pieces' fall in the
    // context before their seam, which is the piece before's, so only the first piece's are kept.
    expect(written.words.map((word: Word) => word.text)).toEqual(["Hello", "there."]);
    expect(written.words.map((word: Word) => word.start)).toEqual([0, 0.5]);
    expect(written.words.every((word: Word) => word.speaker === "speaker_0")).toBe(true);
    expect(written.keyterms).toEqual(["McCall"]);
    expect(fs.readdirSync(`${dir}/cache`).filter((name) => name.endsWith(".ogg"))).toEqual([]);
  } finally {
    cleanup();
  }
});
