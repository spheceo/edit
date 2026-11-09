// Words heard on this Mac, free: Apple's SpeechTranscriber (macOS 26) through
// edit-speech (scripts/edit-speech.swift, found by tools.speech()). ~45-50x real time
// on an M1 with no drift, one word per entry with its time; but no speakers
// and no custom vocabulary, and 15-19% of its words differ from Scribe's
// (fillers and short replies, mostly). So it's the rough first hearing of a
// long recording: Scribe is paid only for the stretches a script uses and for
// subtitles, and who speaks comes from pyannote (voices.ts).
//
// The transcript it writes is transcribe.ts's, `model: "apple-speech"`, no
// `speaker` on any word. One hearing at a time: Apple's recogniser is one
// process for the whole Mac (~570 MB), and two at once only share it.

import * as fs from "node:fs";
import * as os from "node:os";

import * as diag from "./diag.ts";
import { writeAtomic } from "./files.ts";
import { parent } from "./paths.ts";
import * as tools from "./tools.ts";
import { serialize, type Transcript, type Word } from "./transcribe.ts";

export const MODEL = "apple-speech";

/** Test hooks: `helper` in place of the one tools.speech() finds (a path, or null for none). */
export const timing = { helper: undefined as string | null | undefined };

const ready = new Map<string, Promise<string | null>>();

/** Whether this Mac hears on device: macOS 26 or later (Darwin 25) with edit-speech here. Never throws. */
export async function available(): Promise<boolean> {
  return (await helper()) !== null;
}

/**
 * Hears `file` (audio or video) on this Mac and writes its transcript to
 * `target` (atomically, transcribe.ts's `serialize`). Rejects with the
 * helper's reason (unsupported Mac, no model, unreadable file), or when
 * `signal` aborts, killing the helper.
 */
export async function hear(file: string, target: string, signal?: AbortSignal): Promise<Transcript> {
  const path = await helper();
  if (path === null) throw new Error("on-device speech needs macOS 26 or later and edit-speech");
  const turn = queue.then(() => run(path, file, target, signal));
  queue = turn.then(
    () => undefined,
    () => undefined,
  );
  if (signal === undefined) return turn;
  // Aborted while waiting its turn: rejected at once (run() then starts nothing).
  const aborted = new Promise<never>((_, reject) => {
    const stop = () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
  return Promise.race([turn, aborted]);
}

let queue: Promise<void> = Promise.resolve();

interface Heard {
  words: Word[];
  language?: string;
  ms?: number;
  seconds?: number;
}

async function run(path: string, file: string, target: string, signal?: AbortSignal): Promise<Transcript> {
  signal?.throwIfAborted();
  const child = Bun.spawn([path, file, "--ffmpeg", tools.ffmpeg()], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    signal?.throwIfAborted();
    if (code !== 0) throw new Error(reason(err) ?? `edit-speech exited ${code}`);
    let heard: Heard;
    try {
      heard = JSON.parse(out) as Heard;
    } catch {
      throw new Error(`edit-speech's answer wasn't JSON: ${out.slice(0, 200)}`);
    }
    if (!Array.isArray(heard.words)) throw new Error("edit-speech's answer had no words");
    const words: Word[] = heard.words
      .filter((word) => typeof word.text === "string" && word.text !== "" && Number.isFinite(word.start) && Number.isFinite(word.end))
      .map((word) => ({ text: word.text, start: word.start, end: Math.max(word.start, word.end) }));
    const transcript: Transcript = { model: MODEL, language: heard.language ?? "en-US", words };
    const folder = parent(target);
    if (folder !== null) fs.mkdirSync(folder, { recursive: true });
    writeAtomic(target, serialize(transcript));
    const length = heard.seconds ?? words.at(-1)?.end ?? 0;
    diag.info("speech", `${file}: ${clock(length)}, ${words.length} words in ${((heard.ms ?? 0) / 1000).toFixed(1)} s`);
    return transcript;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

/** The helper's one-line reason: its last line that isn't progress. */
function reason(stderr: string): string | null {
  const lines = stderr.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return lines.findLast((line) => !line.startsWith("speech: ")) ?? lines.at(-1) ?? null;
}

function clock(seconds: number): string {
  const whole = Math.round(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** The helper's path once it's known to start here (built first in a dev run), else null; cached per path. */
function helper(): Promise<string | null> {
  if (process.platform !== "darwin" || Number(os.release().split(".")[0]) < 25) return Promise.resolve(null);
  const given = timing.helper;
  const found = given === undefined ? tools.speech() : given === null ? null : { path: given, build: null };
  if (found === null) return Promise.resolve(null);
  let known = ready.get(found.path);
  if (known === undefined) {
    known = prepare(found.path, found.build).catch(() => null);
    ready.set(found.path, known);
  }
  return known;
}

async function prepare(path: string, build: string[] | null): Promise<string | null> {
  if (build !== null) {
    const made = Bun.spawn(build, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const [err, code] = await Promise.all([new Response(made.stderr).text(), made.exited]);
    if (code !== 0) {
      diag.warn("speech", `edit-speech didn't build: ${reason(err) ?? `exit ${code}`}`);
      if (!fs.existsSync(path)) return null;
    }
  }
  try {
    fs.accessSync(path, fs.constants.X_OK);
  } catch {
    return null;
  }
  return path;
}
