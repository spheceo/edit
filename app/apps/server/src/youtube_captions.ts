// Word-timed English YouTube captions before a paid hearing. Times remain
// on the original recording's clock until an excerpt is requested. The
// transcript's model stays explicit: these are captions, not Scribe voices.
import * as fs from "node:fs";

import * as diag from "./diag.ts";
import { writeAtomic } from "./files.ts";
import { join, parent } from "./paths.ts";
import { serialize, type Transcript, type Word } from "./transcribe.ts";
import * as youtube from "./youtube.ts";

export const MODEL = "youtube-captions";
interface Json3 { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string; tOffsetMs?: number; isSpeakerChange?: number }[] }[] }

/** Reject line-timed captions: inventing word times loses precise cut edges. */
export function parseCaptions(value: Json3): Transcript | null {
  const words: { text: string; at: number; change: boolean }[] = [];
  let carry = false;
  let bracket = false;
  let timed = 0;
  for (const event of value.events ?? []) {
    if (!Number.isFinite(event.tStartMs)) continue;
    for (const [segmentIndex, segment] of (event.segs ?? []).entries()) {
      const text = (segment.utf8 ?? "").trim();
      carry ||= segment.isSpeakerChange === 1 || text.startsWith(">>");
      const tokens = text.replace(/^>>\s*/u, "").split(/\s+/u).filter(Boolean);
      if (tokens.length === 1 && Number.isFinite(segment.tOffsetMs)) timed++;
      const base = event.tStartMs! + (segment.tOffsetMs ?? 0);
      const next = event.segs?.[segmentIndex + 1]?.tOffsetMs;
      const weights = tokens.map((token) => Math.max(60, [...token].filter((letter) => /\p{L}/u.test(letter)).length * 60));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      const span = Math.min(total, next === undefined ? total : Math.max(1, next - (segment.tOffsetMs ?? 0)));
      let elapsed = 0;
      for (const [tokenIndex, token] of tokens.entries()) {
        const at = base + (total ? elapsed / total * span : 0);
        elapsed += weights[tokenIndex] ?? 0;
        if (token.startsWith("[") || bracket) { bracket = !token.endsWith("]"); continue; }
        if (!Number.isFinite(at) || at < 0) continue;
        words.push({ text: token, at, change: carry });
        carry = false;
      }
    }
  }
  if (!words.length || timed < words.length / 2) return null;
  words.sort((a, b) => a.at - b.at);
  let turn = 0;
  const out: Word[] = [];
  for (const [index, word] of words.entries()) {
    if (index === 0 || word.change) turn++;
    // Same duration estimate as Writer's caption reader. Silence stays silence.
    const letters = [...word.text].filter((letter) => /\p{L}/u.test(letter)).length;
    const digits = [...word.text].filter((letter) => /[0-9]/u.test(letter)).length;
    const next = words[index + 1]?.at ?? word.at + 2000;
    const end = Math.min(word.at + Math.max(60, letters * 60 + digits * 250), Math.max(next, word.at + 1));
    out.push({ text: word.text, start: word.at / 1000, end: end / 1000, speaker: `caption_turn_${turn}` });
  }
  return { model: MODEL, language: "en", words: out };
}

/** A cloud/script source, not a path guessed from a video filename. */
export function captionRange(source: string): { id: string; start: number; end: number } | null {
  const match = /^youtube:([A-Za-z0-9_-]{11})(?:#(\d+)-(\d+))?$/u.exec(source);
  if (!match) return null;
  const start = Number(match[2] ?? 0) / 1000;
  const end = match[3] === undefined ? Infinity : Number(match[3]) / 1000;
  return end > start ? { id: match[1]!, start, end } : null;
}

const flights = new Map<string, Promise<Transcript | null>>();
async function fetchCaptions(home: string, id: string, dir: string): Promise<Transcript | null> {
  fs.mkdirSync(dir, { recursive: true });
  const binary = await youtube.ytdlp(home);
  const paths = ["en-orig", "en", "en-US", "en-GB"].map((language) => join(dir, `captions.${language}.json3`));
  for (const path of paths) fs.rmSync(path, { force: true });
  const runtime = youtube.runtimeArgs();
  const child = Bun.spawn([binary, ...runtime, "--skip-download", "--no-playlist", "--no-warnings", "--quiet", "--write-subs", "--write-auto-subs", "--sub-langs", "en-orig,en,en-US,en-GB", "--sub-format", "json3", "-o", join(dir, "captions"), `https://www.youtube.com/watch?v=${id}`], { stdout: "ignore", stderr: "pipe", env: youtube.runtimeEnv(runtime) });
  const stderr = new Response(child.stderr).text();
  const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
  try {
    await child.exited;
    await stderr;
    // A later track may fail after a usable one was already written. Prefer
    // original-language word captions; never invent precise times from lines.
    for (const path of paths) {
      try {
        const transcript = parseCaptions(JSON.parse(fs.readFileSync(path, "utf8")) as Json3);
        if (transcript) return transcript;
      } catch { /* This track is absent or invalid; try the next English one. */ }
    }
    return null;
  } finally {
    clearTimeout(timeout);
    for (const path of paths) fs.rmSync(path, { force: true });
  }
}

/** False means no usable captions; only then should the caller pay for Scribe. */
export async function writeCaptionTranscript(home: string, source: string, target: string): Promise<boolean> {
  const range = captionRange(source);
  if (!range) return false;
  const dir = join(home, "cache", "youtube-captions", range.id);
  const kept = join(dir, "transcript-v1.json");
  const unavailable = join(dir, "unavailable.json");
  let transcript: Transcript | null = null;
  try {
    const cached = JSON.parse(fs.readFileSync(kept, "utf8")) as Transcript;
    if (cached.model === MODEL && Array.isArray(cached.words) && cached.words.length) transcript = cached;
  } catch { /* Not fetched yet. */ }
  if (!transcript) {
    try { if (Date.now() - Number(fs.readFileSync(unavailable, "utf8")) < 30 * 60_000) return false; } catch { /* First probe. */ }
    const key = `${home}:${range.id}`;
    let flight = flights.get(key);
    if (!flight) {
      flight = fetchCaptions(home, range.id, dir).catch((error: unknown) => {
        diag.warn("transcribe", `${range.id}: captions unavailable: ${diag.messageOf(error)}`);
        return null;
      });
      flights.set(key, flight);
    }
    try { transcript = await flight; } finally { if (flights.get(key) === flight) flights.delete(key); }
    if (transcript) writeAtomic(kept, serialize(transcript));
    else { fs.mkdirSync(dir, { recursive: true }); writeAtomic(unavailable, String(Date.now())); }
  }
  if (!transcript) return false;
  const seconds = (value: number) => Math.round(value * 1000) / 1000;
  const words = transcript.words.filter((word) => word.end > range.start && word.start < range.end)
    .map((word) => ({ ...word, start: seconds(Math.max(0, word.start - range.start)), end: seconds(Math.min(word.end, range.end) - range.start) }));
  fs.mkdirSync(parent(target) ?? ".", { recursive: true });
  writeAtomic(target, serialize({ ...transcript, words }));
  diag.info("transcribe", `${source}: ${words.length} words from YouTube captions; subject/speaker verification still follows`);
  return true;
}
