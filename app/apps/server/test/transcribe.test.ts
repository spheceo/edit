import { afterAll, beforeAll, expect, test } from "bun:test";

import * as fs from "node:fs";

import { Effect } from "effect";

import { runtime } from "../src/effect/runtime.ts";
import { kindOf } from "../src/effect/service.ts";
import * as tools from "../src/tools.ts";
import {
  aligned,
  AllowanceUsedUp,
  GatewayDown,
  join,
  parseScribe,
  plan,
  RELAY_MAX_BYTES,
  RelayBusy,
  RelayMaxBytes,
  RelayTimedOut,
  RequestTimeoutMs,
  RelayUnreachable,
  Retries,
  retryable,
  run,
  serialize,
  timing,
  TooLongForOneRequest,
  transcribeFile,
  TranscriptionRefused,
  voicesFrom,
  wholeBitrate,
  type Word,
} from "../src/transcribe.ts";
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
  timing.instant = true;
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
    // The whole file (for its voices: without the names, which cost more) and its three pieces with them.
    expect(asked.length).toBe(4);
    expect(asked.map((call) => call.query.getAll("keyterm").join()).sort()).toEqual(["", "McCall", "McCall", "McCall"]);
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

test.skipIf(ffmpeg === null)("a gateway timeout (524) is asked again twice, then said", async () => {
  const { dir, cleanup } = scratch("transcribe-gateway");
  try {
    const source = `${dir}/tone.wav`;
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", source]).exitCode).toBe(0);
    fs.mkdirSync(`${dir}/cache`);
    const before = mock.calls("/v1/transcribe", "POST").length;
    mock.on("POST", "/v1/transcribe", () => new Response("error code: 524", { status: 524 }), 1);
    await run(source, `${dir}/cache/transcript.json`);
    expect(mock.calls("/v1/transcribe", "POST").length - before).toBe(2);
    expect(JSON.parse(fs.readFileSync(`${dir}/cache/transcript.json`, "utf8"))).toEqual(parseScribe(scribeAnswer()));
    const again = mock.calls("/v1/transcribe", "POST").length;
    mock.on("POST", "/v1/transcribe", () => new Response("error code: 524", { status: 524 }), 3);
    await expect(run(source, `${dir}/cache/later.json`)).rejects.toThrow("transcription failed (524)");
    expect(mock.calls("/v1/transcribe", "POST").length - again).toBe(3);
  } finally {
    cleanup();
  }
});

test("the whole hearing's limit is the relay's, in every environment", () => {
  const toml = fs.readFileSync(`${import.meta.dir}/../../relay/wrangler.toml`, "utf8");
  const limits = [...toml.matchAll(/^MAX_UPLOAD_BYTES = "(\d+)"/gm)].map((found) => Number(found[1]));
  expect(limits.length).toBeGreaterThan(0);
  for (const limit of limits) expect(limit).toBe(RELAY_MAX_BYTES);
});

test("a whole hearing is sent at a rate that fits one request, and none fits past ~10 hours", () => {
  // Nov 1: Mathias's interviews, 4 h 39 min and 5 h 1 min, sent at 32 kbps, were 413 every time.
  for (const seconds of [60, 2 * 3600, 3 * 3600, 4 * 3600 + 39 * 60, 5 * 3600 + 60, 7 * 3600 + 43 * 60, 10 * 3600]) {
    const kbps = wholeBitrate(seconds);
    expect(kbps).not.toBeNull();
    expect(kbps!).toBeLessThanOrEqual(32);
    expect(kbps!).toBeGreaterThanOrEqual(8);
    // What Opus at that rate makes, with room to spare.
    expect((seconds * kbps! * 1000) / 8).toBeLessThan(RELAY_MAX_BYTES * 0.9);
  }
  expect(wholeBitrate(3600)).toBe(32);
  expect(wholeBitrate(11 * 3600)).toBeNull();
});

test("only a busy relay, the gateway and a dropped connection are worth asking again", () => {
  expect(retryable(new RelayBusy({ message: "" }))).toBe(true);
  expect(retryable(new GatewayDown({ status: 524, message: "" }))).toBe(true);
  expect(retryable(new RelayUnreachable({ message: "" }))).toBe(true);
  expect(retryable(new TooLongForOneRequest({ bytes: 1, message: "" }))).toBe(false);
  expect(retryable(new AllowanceUsedUp({ message: "" }))).toBe(false);
  expect(retryable(new TranscriptionRefused({ status: 402, message: "" }))).toBe(false);
});

test.skipIf(ffmpeg === null)("a recording too big for one request is said at once, never asked again", async () => {
  const { dir, cleanup } = scratch("transcribe-413");
  try {
    const source = `${dir}/tone.wav`;
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", source]).exitCode).toBe(0);
    fs.mkdirSync(`${dir}/cache`);
    const before = mock.calls("/v1/transcribe", "POST").length;
    mock.on("POST", "/v1/transcribe", () => Response.json({ error: "That recording is too long for one request." }, { status: 413 }), 1);
    await expect(run(source, `${dir}/cache/transcript.json`)).rejects.toThrow("transcription failed (413): That recording is too long for one request.");
    expect(mock.calls("/v1/transcribe", "POST").length - before).toBe(1);
  } finally {
    cleanup();
  }
});

test.skipIf(ffmpeg === null)("a long file the relay won't take whole keeps its words from the pieces, without voices, instead of stopping", async () => {
  const { dir, cleanup } = scratch("transcribe-whole-413");
  let refusing = true;
  try {
    const source = `${dir}/tone.wav`;
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=100", source]).exitCode).toBe(0);
    fs.mkdirSync(`${dir}/cache`);
    // A 100 s tone at "32k" is ~550 kB whole and ~230 kB a piece: the relay refuses only the whole.
    mock.on("POST", "/v1/transcribe", (request) =>
      refusing && request.body.length > 400_000 ? Response.json({ error: "That recording is too long for one request." }, { status: 413 }) : Response.json(scribeAnswer()),
    );
    const target = `${dir}/cache/transcript.json`;
    await run(source, target);
    const written = JSON.parse(fs.readFileSync(target, "utf8")) as { words: Word[] };
    expect(written.words.length).toBeGreaterThan(0);
    expect(written.words.every((word) => word.speaker === undefined)).toBe(true);
    // Nothing kept for the whole, so a later run asks for it again (the relay's limit may have grown).
    expect(fs.existsSync(`${dir}/cache/transcript.whole.json`)).toBe(false);
    expect(fs.existsSync(`${dir}/cache/transcript.whole.ogg`)).toBe(false);
  } finally {
    refusing = false;
    cleanup();
  }
}, 30_000);

test.skipIf(ffmpeg === null)("a long file over the limit at 32 kbps is heard whole at a rate that fits, and keeps its voices", async () => {
  const { dir, cleanup } = scratch("transcribe-whole-smaller");
  const limit = 300_000;
  let refusing = true;
  try {
    const source = `${dir}/tone.wav`;
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=100", source]).exitCode).toBe(0);
    fs.mkdirSync(`${dir}/cache`);
    // As the relay does: a request over its limit is a 413. A 100 s tone at "32k" is ~550 kB whole and ~230 kB a piece; the limit sits between.
    mock.on("POST", "/v1/transcribe", (request) =>
      refusing && request.body.length > limit ? Response.json({ error: "That recording is too long for one request." }, { status: 413 }) : Response.json(scribeAnswer(["Hello", "there."], "speaker_3")),
    );
    const before = mock.calls("/v1/transcribe", "POST").length;
    const target = `${dir}/cache/transcript.json`;
    await runtime.runPromise(transcribeFile(source, target).pipe(Effect.provideService(RelayMaxBytes, limit), Effect.provideService(Retries, Retries.instant)));
    const sent = mock.calls("/v1/transcribe", "POST").slice(before);
    // Three pieces and the whole, every one of them under the limit: nothing was refused.
    expect(sent.length).toBe(4);
    expect(sent.every((call) => call.body.length <= limit)).toBe(true);
    const written = JSON.parse(fs.readFileSync(target, "utf8")) as { words: Word[] };
    expect(written.words.some((word) => word.speaker === "speaker_3")).toBe(true);
    expect(fs.existsSync(`${dir}/cache/transcript.whole.json`)).toBe(true);
    expect(fs.existsSync(`${dir}/cache/transcript.whole.ogg`)).toBe(false);
  } finally {
    refusing = false;
    cleanup();
  }
}, 30_000);

test.skipIf(ffmpeg === null)("a relay that doesn't answer in time is abandoned and asked again; an answer that isn't Scribe's is said at once", async () => {
  const { dir, cleanup } = scratch("transcribe-slow");
  try {
    const source = `${dir}/tone.wav`;
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", source]).exitCode).toBe(0);
    fs.mkdirSync(`${dir}/cache`);
    const before = mock.calls("/v1/transcribe", "POST").length;
    // The first answer comes after the time allowed: abandoned, then asked again.
    mock.on("POST", "/v1/transcribe", async () => (await Bun.sleep(1500), Response.json(scribeAnswer())), 1);
    const quick = <E, R>(work: Effect.Effect<void, E, R>) => work.pipe(Effect.provideService(RequestTimeoutMs, 300), Effect.provideService(Retries, Retries.instant));
    await runtime.runPromise(quick(transcribeFile(source, `${dir}/cache/slow.json`)));
    expect(mock.calls("/v1/transcribe", "POST").length - before).toBe(2);
    expect(JSON.parse(fs.readFileSync(`${dir}/cache/slow.json`, "utf8")).words.length).toBeGreaterThan(0);

    // A 200 that isn't Scribe's words: not a transcript of nothing, and not asked again.
    const from = mock.calls("/v1/transcribe", "POST").length;
    mock.on("POST", "/v1/transcribe", () => Response.json({ words: "not a list" }), 1);
    const failed = await runtime.runPromise(quick(transcribeFile(source, `${dir}/cache/odd.json`)).pipe(Effect.flip));
    expect((failed as { _tag: string })._tag).toBe("AnswerUnreadable");
    expect(kindOf(failed)).toBe("permanent");
    expect(mock.calls("/v1/transcribe", "POST").length - from).toBe(1);
  } finally {
    cleanup();
  }
}, 30_000);

test("each transcription failure has a kind: what Edit asks again, what Try again is offered for", () => {
  expect(kindOf(new RelayBusy({ message: "" }))).toBe("temporary");
  expect(kindOf(new RelayTimedOut({ message: "" }))).toBe("temporary");
  expect(kindOf(new AllowanceUsedUp({ message: "" }))).toBe("later");
  expect(kindOf(new TooLongForOneRequest({ bytes: 1, message: "" }))).toBe("permanent");
  expect(kindOf(new TranscriptionRefused({ status: 402, message: "" }))).toBe("later");
  expect(kindOf(new TranscriptionRefused({ status: 400, message: "" }))).toBe("permanent");
});
