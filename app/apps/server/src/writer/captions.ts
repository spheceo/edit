// YouTube's own captions as a recording's words, in place of hearing it:
// free, and minutes for a hearing of many hours. Used for every YouTube
// source, including compilation cases; other recordings fall back to hearing.
//
// Prefer word-timed English captions, especially the original `en-orig`
// track; English manual and other automatic tracks are fallbacks. A manual
// cue's words are spread across its duration: approximate until exact.ts
// hears the chosen footage. YouTube's word captions mark a change of speaker
// with ">>" (`isSpeakerChange`), but say nothing of who speaks. Each ">>"
// starts a turn of its own (`t0001`, `t0002`…), which the turns pass
// (caption_turns.ts) then gives to people by reading the conversation.
//
// A word has no end: it ends at the next word's start or after the time it
// takes to say (`spokenMs`), whichever comes first, so the pauses between
// words are there for the edges and the tightening.
//
// Measured on Oct 25 2026 against ElevenLabs on a 20-minute hearing Writer
// had heard (3,042 words matched): starts 49 ms from ElevenLabs' (110 ms for
// nine words in ten); ends 58 ms late (140 ms), where the next word's start
// would be 373 ms; 93% of ">>" marks fall on a change of speaker, but they
// mark only about two thirds of the changes.
//
// Kept as `captions.json` beside the recording's hearing, never as its
// `transcript.json`, so it's never taken for heard words.

import * as fs from "node:fs";

import type { Script } from "@edit/types/writer";

import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import { writeAtomic } from "../files.ts";
import { join } from "../paths.ts";
import type { Transcript, Word } from "../transcribe.ts";
import * as edit from "../youtube.ts";
import { run } from "./proc.ts";
import { isYoutube } from "./youtube.ts";

/** What a transcript made from captions is called (`Transcript.model`). */
export const MODEL = "youtube-captions";
/** Milliseconds a letter: the 75th percentile of 89k words ElevenLabs timed in Writer's scripts (2 letters 120 ms, 8 letters 459, 12 letters 740). */
const MS_A_LETTER = 60;
/** A digit is said in a word or more ("$8,320"). */
const MS_A_DIGIT = 250;
const SHORTEST_MS = 60;

/** Whether a script's footage takes YouTube's captions where they're there. */
export const wanted = (script: Script): boolean => script.sourceKind === "youtube" || (script.parts ?? []).some((part) => part.url !== undefined && part.url !== null && isYoutube(part.url));

/** How long `word` takes to say, at most, in ms. */
export function spokenMs(word: string): number {
  const letters = [...word].filter((c) => /\p{L}/u.test(c)).length;
  const digits = [...word].filter((c) => /[0-9]/.test(c)).length;
  return Math.max(letters * MS_A_LETTER + digits * MS_A_DIGIT, SHORTEST_MS);
}

/** The recording's words from YouTube's captions, kept in `work`; null when the video has no usable English captions, or YouTube can't be asked. */
export async function transcript(app: App, url: string, work: string, signal?: AbortSignal): Promise<Transcript | null> {
  const found = cached(work);
  if (found !== null) return found;
  fs.mkdirSync(work, { recursive: true });
  const raw = await fetchTrack(app, url, work, signal);
  if (raw === null) return null;
  const heard = parse(raw);
  if (heard.words.length === 0) return null;
  writeAtomic(join(work, "captions.json"), JSON.stringify(heard));
  return heard;
}

/** Captions read before, kept apart from a paid hearing. */
export function cached(work: string): Transcript | null {
  try {
    const found = JSON.parse(fs.readFileSync(join(work, "captions.json"), "utf8")) as Transcript;
    return found.model === MODEL && found.words.length > 0 ? found : null;
  } catch {
    return null;
  }
}

type Json3 = { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string; tOffsetMs?: number; isSpeakerChange?: number }[] }[] };

async function fetchTrack(app: App, url: string, work: string, signal?: AbortSignal): Promise<Json3 | null> {
  const folder = join(work, `.captions-${crypto.randomUUID()}`);
  fs.mkdirSync(folder, { recursive: true });
  try {
    const binary = await edit.ytdlp(app.store.home);
    const runtime = edit.runtimeArgs();
    const args = [...runtime, "--skip-download", "--no-simulate", "--no-playlist", "--no-warnings", "--write-subs", "--write-auto-subs", "--sub-langs", "en.*", "--sub-format", "json3", "--dump-single-json", "-o", join(folder, "captions"), url];
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) for (const name of fs.readdirSync(folder)) fs.rmSync(join(folder, name), { force: true });
      let said: string | null = null;
      let failure = "";
      try {
        said = await run(binary, args, { timeoutMs: 120_000, env: edit.runtimeEnv(runtime) ?? process.env, ...(signal ? { signal } : {}) });
      } catch (error) {
        if (signal?.aborted) throw error;
        failure = error instanceof Error ? error.message : String(error);
      }
      let info: Record<string, unknown> | null = null;
      for (const line of (said ?? "").split("\n").reverse()) {
        try {
          info = JSON.parse(line) as Record<string, unknown>;
          break;
        } catch {
          // Not the info line.
        }
      }
      const chosen = select(folder, info);
      if (chosen !== null) {
        diag.info("writer", `YouTube captions: ${chosen[0]} (${wordTimed(chosen[1]) ? "word-timed" : "cue timings estimated; chosen footage is heard exactly"})`);
        return chosen[1];
      }
      if (said !== null) return null;
      if (attempt === 0 && failure.includes("429")) {
        await Bun.sleep(20_000);
        continue;
      }
      diag.warn("writer", `YouTube's captions couldn't be read: ${failure.split("\n").reverse().find((line) => line.trim() !== "") ?? "yt-dlp failed"}`);
      return null;
    }
    return null;
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

/** An English track's language code: "en", "en-orig", or "en-" and a region; never a translation named with another video's id. */
export function english(language: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(language)) return false;
  const lower = language.toLowerCase().replaceAll("_", "-");
  if (lower === "en" || lower === "en-orig") return true;
  const parts = lower.split("-").filter((part) => part !== "");
  if (parts[0] !== "en") return false;
  const rest = parts.slice(1);
  return rest.length > 0 && rest.every((part) => part.length >= 2 && part.length <= 4 && /^[a-z]+$/.test(part));
}

function wordTimed(value: Json3): boolean {
  let total = 0;
  let timed = 0;
  for (const event of value.events ?? []) {
    for (const segment of event.segs ?? []) {
      const count = (segment.utf8 ?? "").replace(/^>+/, "").split(/\s+/).filter((word) => word !== "").length;
      total += count;
      if (count === 1 && typeof segment.tOffsetMs === "number") timed++;
    }
  }
  return total > 0 && timed * 2 >= total;
}

/** The best English track in `folder`: the original word-timed one, then any word-timed, then manual cues; an automatic translation never. */
export function select(folder: string, info: Record<string, unknown> | null): [string, Json3] | null {
  const candidates: [[number, boolean, string], Json3][] = [];
  for (const name of fs.readdirSync(folder)) {
    if (!name.startsWith("captions.") || !name.endsWith(".json3")) continue;
    const language = name.slice("captions.".length, -".json3".length);
    if (!english(language)) continue;
    const subtitles = (info?.subtitles ?? {}) as Record<string, unknown>;
    const manual = Array.isArray(subtitles[language]) && (subtitles[language] as unknown[]).length > 0;
    const requested = ((info?.requested_subtitles ?? {}) as Record<string, { url?: unknown }>)[language]?.url;
    const translated = typeof requested === "string" && requested.split(/[?&]/).some((part) => part.startsWith("tlang="));
    if (translated && !manual) continue;
    let value: Json3;
    try {
      value = JSON.parse(fs.readFileSync(join(folder, name), "utf8")) as Json3;
    } catch {
      continue;
    }
    if (parse(value).words.length === 0) continue;
    const timed = wordTimed(value);
    const rank = language === "en-orig" && timed ? 0 : timed ? 1 : manual ? 2 : 3;
    candidates.push([[rank, language !== "en", language], value]);
  }
  candidates.sort(([a], [b]) => a[0] - b[0] || Number(a[1]) - Number(b[1]) || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
  const best = candidates[0];
  return best === undefined ? null : [best[0][2], best[1]];
}

/** A json3 track as words, each ">>" opening a turn of its own. */
export function parse(value: Json3): Transcript {
  const events = value.events ?? [];
  const said: [string, number, boolean, number | null][] = [];
  for (const [eventIndex, event] of events.entries()) {
    const start = event.tStartMs;
    if (typeof start !== "number" || !Number.isFinite(start) || start < 0) continue;
    const nextEvent = events.slice(eventIndex + 1).map((next) => next.tStartMs).find((at): at is number => typeof at === "number" && at > start);
    const duration = typeof event.dDurationMs === "number" && event.dDurationMs > 0 ? start + event.dDurationMs : null;
    const eventEnd = duration !== null && nextEvent !== undefined ? Math.min(duration, nextEvent) : (duration ?? nextEvent ?? null);
    const segments = event.segs ?? [];
    for (const [segmentIndex, segment] of segments.entries()) {
      const raw = (segment.utf8 ?? "").trim();
      const change = segment.isSpeakerChange === 1 || raw.startsWith(">>");
      const text = (raw.startsWith(">>") ? raw.slice(2) : raw).trim();
      const offset = segment.tOffsetMs ?? 0;
      if (!Number.isFinite(offset) || offset < 0) continue;
      const at = start + offset;
      const nextOffset = segments.slice(segmentIndex + 1).map((next) => next.tOffsetMs).find((next): next is number => typeof next === "number" && next > offset);
      const next = nextOffset === undefined ? null : start + nextOffset;
      const bound = next !== null && eventEnd !== null ? Math.min(next, eventEnd) : (next ?? eventEnd);
      const limit = bound !== null && bound > at ? bound : null;
      const pieces = text.split(/\s+/).filter((piece) => piece !== "");
      if (pieces.length === 0) {
        if (change) said.push(["", at, true, limit]);
        continue;
      }
      const total = pieces.reduce((sum, piece) => sum + spokenMs(piece), 0);
      const span = limit === null ? total : limit - at;
      let elapsed = 0;
      for (const [index, piece] of pieces.entries()) {
        said.push([piece, at + (elapsed / total) * span, change && index === 0, limit]);
        elapsed += spokenMs(piece);
      }
    }
  }
  const words: [string, number, boolean, number | null][] = [];
  let carry = false;
  let bracket = false;
  for (const [text, at, change, limit] of said) {
    const opens = text.startsWith("[");
    if (opens || bracket || text === "") {
      carry ||= change;
      bracket = (opens || bracket) && !text.endsWith("]");
      continue;
    }
    words.push([text, at, change || carry, limit]);
    carry = false;
  }
  words.sort((a, b) => a[1] - b[1]);
  let turn = 0;
  const out: Word[] = words.map(([text, at, change, limit], index) => {
    if (change || index === 0) turn++;
    const next = words[index + 1]?.[1] ?? at + 2_000;
    const end = Math.max(Math.min(at + spokenMs(text), Math.max(next, at + 1), limit ?? Infinity), at + 1);
    return { text, start: at / 1000, end: end / 1000, speaker: `t${String(turn).padStart(4, "0")}` };
  });
  return { model: MODEL, language: "en", words: out };
}
