// Rough words first (Nov 9): a recording Apple hears is never sent to Scribe while it's transcribed; the build's
// chosen stretches are the only footage Scribe hears; captions behave as before; without Apple (Linux) Scribe hears
// it as before; and with the plan out of credit the build keeps the rough cut and says so plainly.

import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import * as fs from "node:fs";

import type { Clip, Script, Word } from "@edit/types/writer";

import type { App } from "../../src/app.ts";
import * as realClaude from "../../src/writer/claude.ts";
import * as realSpeech from "../../src/mac_speech.ts";
import { scratch } from "../helpers/home.ts";
import { MockServer, scribeAnswer } from "../mocks/server.ts";

// Apple's recogniser, here on any computer when a test says so: it hears "rough words here" every 2 s.
const apple = { on: false, heard: 0 };
void mock.module("../../src/mac_speech.ts", () => ({
  ...realSpeech,
  available: async () => apple.on,
  hear: async (file: string, target: string) => {
    if (!apple.on) return realSpeech.hear(file, target);
    apple.heard++;
    const words = Array.from({ length: 20 }, (_, n) => ({ text: n % 2 === 0 ? "rough" : "words", start: n * 2, end: n * 2 + 0.4 }));
    const transcript = { model: realSpeech.MODEL, language: "en", words };
    fs.writeFileSync(target, JSON.stringify(transcript));
    return transcript;
  },
}));
// Who says each line (Sonnet) answers nothing new, so the voices and the cast stay as they were.
const sonnet = { standIn: false };
void mock.module("../../src/writer/claude.ts", () => ({
  ...realClaude,
  structured: (...args: Parameters<typeof realClaude.structured>) => (sonnet.standIn ? Promise.resolve({ lines: [], newPeople: [] }) : realClaude.structured(...args)),
}));

const tools = await import("../../src/tools.ts");
const { timing } = await import("../../src/transcribe.ts");
const transcription = await import("../../src/writer/transcription.ts");
const exact = await import("../../src/writer/exact.ts");
const scripting = await import("../../src/writer/scripting.ts");
const store = await import("../../src/writer/store.ts");
const exactAfter = await import("../../src/writer/exact_after.ts");
const voices = await import("../../src/voices.ts");
const table = await import("../../src/jobs.ts");
const steps = await import("../../src/import_steps.ts");

const ffmpeg = Bun.which("ffmpeg");
let server: MockServer;
let restore: () => void;
const app = null as unknown as App;

beforeAll(() => {
  server = MockServer.start();
  restore = server.useEnv({ EDIT_RELAY_TOKEN: "relay-token" });
  timing.instant = true;
  tools.forget();
  voices.setOnForTests(false);
});
afterAll(() => {
  voices.setOnForTests(null);
  restore();
  server.stop();
});

const scribePosts = () => server.requests.filter((one) => one.method === "POST" && one.path.startsWith("/v1/transcribe")).length;

function tone(dir: string, seconds: number): string {
  const file = `${dir}/footage.wav`;
  expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", `sine=frequency=300:duration=${seconds}`, "-ac", "1", "-ar", "16000", file]).exitCode).toBe(0);
  return file;
}

function script(file: string, durationMs: number, extra: Partial<Script> = {}): Script {
  return { id: "5c1d2a77-0b6e-4f0a-9d3e-6b9f2a1c0e11", title: "Rough case", sourceKind: "file", sourceUrl: file, originalPath: file, status: "processing", stage: "", progress: 0, error: null, durationMs, words: [], clips: [], overview: [], revision: 1, createdAt: 0, updatedAt: 0, proxyPath: null, ...extra };
}

test.skipIf(ffmpeg === null)("a recording Apple hears is never sent to Scribe; its words are rough, kept apart from a paid hearing", async () => {
  const { dir, cleanup } = scratch("rough-apple");
  apple.on = true;
  try {
    const file = tone(dir, 40);
    const one = script(file, 40_000);
    const before = scribePosts();
    await transcription.transcribe(app, one, dir);
    expect(scribePosts()).toBe(before);
    expect(apple.heard).toBeGreaterThan(0);
    expect(one.words.map((word) => word.text).slice(0, 2)).toEqual(["rough", "words"]);
    expect(one.words.every((word) => word.speaker === undefined)).toBe(true);
    expect(one.rough).toBe(true);
    expect(one.captions).toBe(false);
    expect(exact.wanted(one)).toBe(true);
    // Kept as apple.json, never as the recording's transcript.json, so it's never handed to Edit as heard words.
    expect(fs.existsSync(`${dir}/transcript/whole/apple.json`)).toBe(true);
    expect(fs.existsSync(`${dir}/transcript/whole/transcript.json`)).toBe(false);
    expect(transcription.roughOnly(`${dir}/transcript/whole`)).toBe(true);
    // A retry reads Apple's words again, hearing nothing.
    const heard = apple.heard;
    await transcription.transcribe(app, script(file, 40_000), dir);
    expect(apple.heard).toBe(heard);
    expect(scribePosts()).toBe(before);
  } finally {
    apple.on = false;
    cleanup();
  }
}, 30_000);

test.skipIf(ffmpeg === null)("without Apple (Linux, an older macOS) Scribe hears the recording as before, and its words aren't rough", async () => {
  const { dir, cleanup } = scratch("rough-linux");
  try {
    const file = tone(dir, 20);
    const one = script(file, 20_000);
    const before = scribePosts();
    await transcription.transcribe(app, one, dir);
    expect(scribePosts()).toBeGreaterThan(before);
    expect(one.rough).toBe(false);
    expect(exact.wanted(one)).toBe(false);
    expect(fs.existsSync(`${dir}/transcript/whole/transcript.json`)).toBe(true);
  } finally {
    cleanup();
  }
}, 30_000);

test("a captioned recording behaves as before: its captions, no Scribe, and its chosen footage heard exactly; an older script's `captions` still counts", async () => {
  const { dir, cleanup } = scratch("rough-captions");
  apple.on = true;
  try {
    fs.mkdirSync(`${dir}/transcript/whole`, { recursive: true });
    const words = [{ text: "Your", start: 1, end: 1.2, speaker: "t0001" }, { text: "Honor.", start: 1.3, end: 1.7, speaker: "t0001" }];
    fs.writeFileSync(`${dir}/transcript/whole/captions.json`, JSON.stringify({ model: "youtube-captions", language: "en", words }));
    const one = script("", 10_000, { sourceKind: "youtube", sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    const before = [scribePosts(), apple.heard];
    await transcription.transcribe(app, one, dir);
    expect([scribePosts(), apple.heard]).toEqual(before);
    expect(one.words.map((word) => word.text)).toEqual(["Your", "Honor."]);
    expect(one.captions).toBe(true);
    expect(one.rough).toBe(true);
    expect(exact.wanted({ ...one, rough: undefined })).toBe(true);
  } finally {
    apple.on = false;
    cleanup();
  }
});

/** A built rough script of 5 minutes: a word every second, one clip at 100–105 s between two cut-ins. */
function built(file: string): Script {
  const words: Word[] = Array.from({ length: 300 }, (_, n) => ({ id: `w${String(n).padStart(5, "0")}`, text: n % 2 === 0 ? "Hello" : "there.", startMs: n * 1000, endMs: n * 1000 + 400 }));
  const clips: Clip[] = [
    { id: "c0", startMs: 0, endMs: 1, kind: "cut-in", narration: "The opening." },
    { id: "c1", startMs: 100_000, endMs: 105_400 },
    { id: "c2", startMs: 0, endMs: 1, kind: "cut-in", narration: "The end." },
  ];
  return { ...script(file, 300_000), status: "ready", stage: "ready", progress: 100, rough: true, words, clips, speakers: {} };
}

test.skipIf(ffmpeg === null)("the exact stage sends Scribe only the chosen stretches, and says how much of the footage that was", async () => {
  const { dir, cleanup } = scratch("rough-exact");
  sonnet.standIn = true;
  try {
    const file = tone(dir, 300);
    const one = built(file);
    const spans = exact.stretches(one, one.clips);
    expect(spans).toEqual([[97_000, 108_400]]);
    const before = server.requests.length;
    const report = await exact.run(one, dir, file, one.clips, () => {});
    const posted = server.requests.slice(before).filter((request) => request.method === "POST" && request.path.startsWith("/v1/transcribe"));
    // One request for the one 11.4 s stretch, never the 5 minutes, and never a whole hearing for voices.
    expect(posted).toHaveLength(exact.pieces(11.4).length);
    expect(posted.every((request) => request.path === "/v1/transcribe")).toBe(true);
    expect(report.heardMs).toBe(11_400);
    expect(report.footageMs).toBe(300_000);
    expect(one.exact).toEqual(spans);
    expect(exact.said(report, 0)).toContain("0:11 of 5:00 (4%) of the footage");
  } finally {
    sonnet.standIn = false;
    cleanup();
  }
}, 30_000);

test.skipIf(ffmpeg === null)("with the plan out of credit the build keeps the rough cut and says so plainly, the wait is in the job table and its waking hears the footage; Hear exactly completes it too", async () => {
  // The wait is kept in `<home>/jobs.json`, beside the script's `writer/` data.
  const { dir: home, cleanup } = scratch("rough-quota");
  const data = store.dataDir(home);
  sonnet.standIn = true;
  const retryWas = steps.QUOTA_RETRY_MS.value;
  const quota = () => Response.json({ error: 'ElevenLabs transcription failed (401): {"detail":{"status":"quota_exceeded","message":"This request exceeds your quota of 0. You have 0 credits remaining."}}' }, { status: 401 });
  try {
    const one = built("");
    // Six stretches: once the plan refuses, no lane asks for more than the one it had in hand.
    one.clips.splice(2, 0, ...[150, 180, 210, 240, 270].map((at): Clip => ({ id: `c${at}`, startMs: at * 1000, endMs: at * 1000 + 2_400 })));
    const spans = exact.stretches(one, one.clips);
    expect(spans).toHaveLength(6);
    const dir = store.scriptDir(data, one.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = tone(dir, 300);
    store.write(dir, { ...one, originalPath: file, sourceUrl: file });
    const job = { stage: () => {}, signal: new AbortController().signal } as unknown as Parameters<typeof scripting.exactOnce>[3];
    server.on("POST", "/v1/transcribe", quota, 10);
    const asked = scribePosts();
    const [said] = await scripting.exactOnce(app, data, one.id, job);
    expect(scribePosts() - asked).toBeLessThanOrEqual(4);
    expect(said).toContain("Heard roughly; the exact hearing waits for the transcription plan's credit");
    const waited = store.read(dir);
    expect(waited.exact).toBeUndefined();
    expect(waited.clips.find((clip) => clip.id === "c1")).toMatchObject({ startMs: 100_000, endMs: 105_400 });
    expect(exactAfter.waitsForCredit(data, one.id)).toBe(true);
    expect(exactAfter.pending(data, one.id)).toBe(true);
    // Durable: a waiting job with its time, which a restart leaves asleep (not "cut short") and the table wakes when due.
    const key = table.keyOf("script", one.id, "exact");
    const listed = table.get(home, key);
    expect(listed).toMatchObject({ kind: "script", project: one.id, state: "waiting", step: "waiting for credit", args: { waiting_on: "exact" } });
    expect(listed!.retry_at).toBeGreaterThan(Date.now() + 29 * 60_000);
    expect(table.takeOver(home)).toEqual([]);
    expect(table.get(home, key)?.state).toBe("waiting");
    // Still no credit when woken: it waits again, with a new time.
    steps.QUOTA_RETRY_MS.value = 0;
    table.settle(home, key, "waiting", { retry_at: Date.now() - 1 });
    server.on("POST", "/v1/transcribe", quota, 10);
    const woken: string[] = [];
    table.useResumers(home, {
      // As serve.ts starts a script's wait again.
      script: (woke) => {
        woken.push(woke.key);
        if (woke.args.waiting_on !== "exact") return;
        table.end(home, woke.key);
        exactAfter.soon(data, woke.project);
      },
    });
    await table.wake(home);
    await exactAfter.idle(one.id);
    expect(woken).toEqual([key]);
    expect(exactAfter.waitsForCredit(data, one.id)).toBe(true);
    expect(store.read(dir).exact).toBeUndefined();
    // The credit is back (the quota answers are used up): the next waking hears the chosen footage by itself and the wait is over.
    server.requests.length = 0;
    server.on("POST", "/v1/transcribe", () => Response.json(scribeAnswer(["Hello", "there."])));
    await table.wake(home);
    await exactAfter.idle(one.id);
    expect(woken).toEqual([key, key]);
    expect(store.read(dir).exact).toEqual(spans);
    expect(exactAfter.waitsForCredit(data, one.id)).toBe(false);
    expect(table.get(home, key)).toBeUndefined();
    // Hear exactly, pressed, on a script waiting for credit: the same wait, over once heard.
    const moved = store.update(dir, (script) => {
      delete script.exact;
    });
    const spans2 = exact.stretches(moved, moved.clips);
    expect(spans2.length).toBeGreaterThan(0);
    server.on("POST", "/v1/transcribe", quota, 10);
    const [said2] = await scripting.exactOnce(app, data, one.id, job);
    expect(said2).toContain("waits for the transcription plan's credit");
    expect(exactAfter.waitsForCredit(data, one.id)).toBe(true);
    server.on("POST", "/v1/transcribe", () => Response.json(scribeAnswer(["Hello", "there."])));
    const [again] = await scripting.exactOnce(app, data, one.id, job);
    expect(again).toContain("Heard the chosen footage exactly");
    expect(store.read(dir).exact).toEqual(spans2);
    expect(exactAfter.pending(data, one.id)).toBe(false);
    expect(exactAfter.waitsForCredit(data, one.id)).toBe(false);
  } finally {
    steps.QUOTA_RETRY_MS.value = retryWas;
    sonnet.standIn = false;
    cleanup();
  }
}, 60_000);

test("words only Scribe heard between two both heard are added; the plan's words keep their ids, and clips find them by id", () => {
  const word = (id: string, text: string, startMs: number): Word => ({ id, text, startMs, endMs: startMs + 300 });
  // Apple dropped "um" and the reply "yeah", and heard "30" where Scribe heard "thirty".
  const ours = [word("a", "Where", 1_000), word("b", "were", 1_400), word("c", "you", 1_800), word("d", "at", 3_000), word("e", "30", 3_400), word("f", "past", 3_800), word("g", "nine", 4_200)];
  const heard = [
    { text: "Where", start: 1_050, end: 1_350 },
    { text: "were", start: 1_450, end: 1_750 },
    { text: "you?", start: 1_850, end: 2_150 },
    { text: "Yeah,", start: 2_300, end: 2_500 },
    { text: "um,", start: 2_600, end: 2_800 },
    { text: "at", start: 3_050, end: 3_350 },
    { text: "thirty", start: 3_450, end: 3_750 },
    { text: "past", start: 3_850, end: 4_150 },
    { text: "nine.", start: 4_250, end: 4_550 },
  ];
  const before = structuredClone(ours);
  const voicesOf: (string | null)[] = ours.map(() => null);
  const inserts: import("../../src/writer/exact.ts").Insert[] = [];
  exact.retime(ours, 0, 10_000, heard, voicesOf, inserts);
  const [after] = exact.withInserts(ours, voicesOf, inserts);
  expect(after.map((one) => one.text)).toEqual(["Where", "were", "you?", "Yeah,", "um,", "at", "thirty", "past", "nine."]);
  expect(after.filter((one) => one.id.startsWith("w-"))).toHaveLength(2);
  expect(after.find((one) => one.id === "e")!.text).toBe("thirty");
  // A clip from "at" to "nine" lands on the same words' exact times, past the two added ones.
  const [moved] = exact.remapFrom(before, [{ id: "c", startMs: 3_000, endMs: 4_500 }], after, 10_000);
  expect(moved!.startMs).toBeLessThanOrEqual(3_050);
  expect(moved!.startMs).toBeGreaterThan(2_800);
  expect(moved!.endMs).toBeGreaterThanOrEqual(4_550);
});
