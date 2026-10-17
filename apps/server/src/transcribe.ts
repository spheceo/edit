// Transcription through Edit's relay (apps/relay/), which holds the ElevenLabs
// key. Edit sends small mono Opus audio and keeps Scribe's words, cached per
// source file so the same footage is never paid for twice.

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import { ioMessage, writeAtomic } from "./files.ts";
import { withExtension } from "./paths.ts";
import * as relay from "./relay.ts";
import * as tools from "./tools.ts";

/** One spoken word. Times are seconds into the source. */
export interface Word {
  text: string;
  start: number;
  end: number;
  /** Scribe's voice number, if it heard more than one person. */
  speaker?: string;
}

export interface Transcript {
  model: string;
  language?: string | null;
  words: Word[];
  /**
   * Who each voice is ("speaker_0" → "Officer", "Jane Doe (Mother)"), read
   * from the conversation by a model once the words are in.
   */
  speakers?: Record<string, string>;
  /** Each voice's role in Repack's colour code (officer, suspect, witness…). */
  roles?: Record<string, string>;
  /** Each voice's colour ("#00e5c7"), from its role (see speakers.rs). */
  colors?: Record<string, string>;
}

/**
 * A transcript as transcribe.rs writes it: its fields in order, the maps
 * sorted (BTreeMaps) and left out when empty, and each word's speaker only
 * when it has one.
 */
export function serialize(transcript: Transcript): string {
  const sortedMap = (map: Record<string, string> | undefined) => {
    const keys = Object.keys(map ?? {}).sort();
    return keys.length === 0 ? undefined : Object.fromEntries(keys.map((key) => [key, map![key]!]));
  };
  // Integer-like keys ("0") would be listed first by the JS object, so the
  // maps are written by hand.
  const writeMap = (map: Record<string, string>) =>
    `{${Object.keys(map)
      .map((key) => `${JSON.stringify(key)}:${JSON.stringify(map[key])}`)
      .join(",")}}`;
  const words = transcript.words.map((word) => {
    const out: Word = { text: word.text, start: word.start, end: word.end };
    if (word.speaker !== undefined && word.speaker !== null) out.speaker = word.speaker;
    return JSON.stringify(out);
  });
  let text = `{"model":${JSON.stringify(transcript.model)},"language":${JSON.stringify(transcript.language ?? null)},"words":[${words.join(",")}]`;
  for (const field of ["speakers", "roles", "colors"] as const) {
    const map = sortedMap(transcript[field]);
    if (map !== undefined) text += `,${JSON.stringify(field)}:${writeMap(map)}`;
  }
  return `${text}}`;
}

/** Waits before asking a busy relay again (a 429), then gives up. */
const BUSY_WAITS = [15, 30, 60, 60, 60, 60];

/** How long a wait before asking again lasts (tests make it instant). */
export const timing = { sleep: (seconds: number) => Bun.sleep(seconds * 1000) };

/** Extracts audio, sends it to the relay, writes `target` (transcript JSON). */
export async function run(source: string, target: string): Promise<void> {
  const auth = relay.authHeaders();
  const audio = withExtension(target, "ogg");
  // Asked before the media's other work has made its cache folder.
  fs.mkdirSync(target.slice(0, target.lastIndexOf("/")) || ".", { recursive: true });
  const encoded = Bun.spawn(
    [
      tools.ffmpeg(),
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      source,
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "libopus",
      "-b:a",
      "32k",
      "-application",
      "voip",
      audio,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  const [stderr, code] = await Promise.all([new Response(encoded.stderr).text(), encoded.exited]);
  if (code !== 0) {
    fs.rmSync(audio, { force: true });
    throw new Error(`could not extract audio: ${stderr.trim()}`);
  }
  // The relay takes a few transcriptions at once (a script import's footage
  // and voice-over takes can ask together): a 429 waits and asks again.
  const waits = [...BUSY_WAITS];
  let status: number;
  let body: string;
  try {
    for (;;) {
      let response: Response;
      try {
        response = await fetch(`${relay.url()}/v1/transcribe`, {
          method: "POST",
          headers: { ...auth, "content-type": "audio/ogg" },
          body: Bun.file(audio),
          signal: AbortSignal.timeout(1800 * 1000),
        });
        body = await response.text();
      } catch (error) {
        throw new Error(`could not reach the transcription relay: ${diag.messageOf(error)}`);
      }
      status = response.status;
      if (status === 429) {
        const wait = waits.shift();
        if (wait !== undefined) {
          diag.warn("media", `transcription busy (429): asking again in ${wait} s`);
          await timing.sleep(wait);
          continue;
        }
      }
      break;
    }
  } finally {
    fs.rmSync(audio, { force: true });
  }
  let value: unknown = null;
  try {
    value = JSON.parse(body);
  } catch {
    value = null;
  }
  if (status !== 200) {
    const object = (typeof value === "object" && value !== null ? value : {}) as {
      error?: unknown;
      detail?: { message?: unknown };
    };
    const message =
      typeof object.error === "string"
        ? object.error
        : typeof object.detail?.message === "string"
          ? object.detail.message
          : body.trim();
    throw new Error(`transcription failed (${status}): ${message}`);
  }
  const transcript = parseScribe(value);
  try {
    writeAtomic(target, serialize(transcript));
  } catch (error) {
    throw new Error(ioMessage(error));
  }
}

/** Scribe's answer, keeping only spoken words (not spacing or sound events). */
export function parseScribe(value: unknown): Transcript {
  const answer = (typeof value === "object" && value !== null ? value : {}) as {
    words?: unknown;
    language_code?: unknown;
  };
  if (!Array.isArray(answer.words)) throw new Error("the transcription service returned no words");
  const words: Word[] = [];
  for (const item of answer.words as Record<string, unknown>[]) {
    if (typeof item !== "object" || item === null || item.type !== "word") continue;
    if (typeof item.text !== "string" || typeof item.start !== "number" || typeof item.end !== "number") continue;
    const text = item.text.trim();
    if (text === "") continue;
    const start = item.start;
    const word: Word = { text, start: Math.max(start, 0), end: Math.max(item.end, start) };
    if (typeof item.speaker_id === "string") word.speaker = item.speaker_id;
    words.push(word);
  }
  return {
    model: "scribe_v2",
    language: typeof answer.language_code === "string" ? answer.language_code : null,
    words,
  };
}
