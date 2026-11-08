// Who speaks when, from pyannoteAI (Precision-3) through Edit's relay
// (apps/relay/src/diarize_jobs.ts), while the relay's flag is on (Sphe, Nov 8:
// "scribe + pyannote for now, let's have it be a flag and we'll see how things
// go"). Scribe, or YouTube's captions, still give the words; pyannote gives
// the voices, as `speaker_N` like Scribe's, and speakers.ts and the watch name
// them as before.
//
// Why: Scribe's voices drift on a long file. The Female Police Captain's
// 84-minute interrogation heard whole had Kimberly and the detective as one
// voice from 48:40 to 54:30 (the same 13 minutes heard alone came out right),
// where pyannote kept every voice apart start to end. And YouTube's captions
// have no voices at all: each line was its own "caption_turn_N", guessed at
// one by one, and JJ's notes on those cases were mostly wrong speakers ("in
// between the two women, where we have essentially swapped their roles").
//
// A recording already in the cloud is heard there by its key (pyannote fetches
// it itself, no download: an 84-minute MP4 in 89 s), whole, once, kept in the
// cache by its key; each excerpt of it takes its stretch, so every excerpt of
// one case shares one set of voices. A file only on this computer is sent as
// small Opus audio. Each job is kept beside what it's for, so a restart asks
// for the same job again rather than paying for a new one.

import * as fs from "node:fs";

import * as cameras from "./cameras.ts";
import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";
import { writeAtomic } from "./files.ts";
import { join, parent } from "./paths.ts";
import * as relay from "./relay.ts";
import * as tools from "./tools.ts";
import { serialize, type Transcript, type Word } from "./transcribe.ts";

/** What a transcript's `voices` says when its voices are pyannote's. */
export const MODEL = "pyannote-precision-3";

/** One stretch of one voice, in the recording's seconds. */
export interface Turn {
  start: number;
  end: number;
  speaker: string;
}

/** How long between looks at a job, and how long one may take (tests make them short). */
export const timing = { pollMs: 10_000, deadlineMs: 3 * 3600_000, healthMs: 60_000 };

let health: { at: number; on: boolean } | null = null;

/** Whether the relay gives pyannote's voices now (its /health `diarize`, asked once a minute). */
export async function on(): Promise<boolean> {
  if (health !== null && Date.now() - health.at < timing.healthMs) return health.on;
  let found = false;
  try {
    const answer = await fetch(`${relay.url()}/health`, { signal: AbortSignal.timeout(20_000) });
    found = answer.ok && ((await answer.json()) as { diarize?: unknown }).diarize === true;
  } catch {
    // Unreachable: Scribe's voices, as before.
  }
  health = { at: Date.now(), on: found };
  return found;
}

/** Tests: the flag as given, or asked of the relay again (null). */
export function setOnForTests(value: boolean | null): void {
  health = value === null ? null : { at: Number.MAX_SAFE_INTEGER / 2, on: value };
}

/** pyannote's "SPEAKER_01" as Edit's "speaker_1". */
function voiceId(speaker: string): string {
  const n = /(\d+)$/u.exec(speaker)?.[1];
  return n === undefined ? `speaker_${speaker.toLowerCase().replace(/[^a-z0-9]+/gu, "_")}` : `speaker_${Number(n)}`;
}

/** The turns as pyannote gave them, held to what they must be. */
function readTurns(value: unknown): Turn[] {
  if (!Array.isArray(value)) throw new Error("pyannote's answer has no voices");
  return value
    .filter((one): one is Turn => typeof one === "object" && one !== null && Number.isFinite(one.start) && Number.isFinite(one.end) && typeof one.speaker === "string" && one.end > one.start)
    .map((one) => ({ start: one.start, end: one.end, speaker: voiceId(one.speaker) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

async function ask(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(`${relay.url()}${path}`, { ...init, headers: { ...relay.authHeaders(), "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(120_000) });
  } catch (error) {
    throw new Error(`${relay.UNREACHABLE} for the voices: ${diag.messageOf(error)}`);
  }
}

/**
 * The voices of the audio at `key` in the cloud: kept in `keep` once heard;
 * the job beside it (`<keep>.job`) while pyannote works, so a restart follows
 * the same job.
 */
export async function ofKey(key: string, keep: string): Promise<Turn[]> {
  try {
    const kept = JSON.parse(fs.readFileSync(keep, "utf8")) as { key?: unknown; turns?: unknown };
    if (kept.key === key) return readTurns(kept.turns);
  } catch {
    // Not heard yet.
  }
  const jobFile = `${keep}.job`;
  let id: string | null = null;
  try {
    const job = JSON.parse(fs.readFileSync(jobFile, "utf8")) as { key?: unknown; id?: unknown; at?: unknown };
    if (job.key === key && typeof job.id === "string" && typeof job.at === "number" && Date.now() - job.at < 24 * 3600_000) id = job.id;
  } catch {
    // No job yet.
  }
  fs.mkdirSync(parent(keep) ?? ".", { recursive: true });
  if (id === null) {
    const started = await ask("/v1/diarize/jobs", { method: "POST", body: JSON.stringify({ key }) });
    const text = await started.text();
    if (started.status !== 202 && started.status !== 200) throw new Error(`the relay couldn't start the voices (${started.status}): ${text.slice(0, 200)}`);
    id = (JSON.parse(text) as { id: string }).id;
    writeAtomic(jobFile, JSON.stringify({ key, id, at: Date.now() }));
  }
  const began = Date.now();
  for (;;) {
    const answer = await ask(`/v1/diarize/jobs/${encodeURIComponent(id)}?${new URLSearchParams({ key })}`).catch((error: unknown) => {
      // Offline for a moment: the job goes on in the cloud.
      diag.warn("voices", `${key}: asking for its voices: ${diag.messageOf(error)}; asking again`);
      return null;
    });
    if (answer !== null && answer.status === 200) {
      const turns = readTurns(((await answer.json()) as { segments?: unknown }).segments);
      writeAtomic(keep, JSON.stringify({ key, model: MODEL, turns }));
      fs.rmSync(jobFile, { force: true });
      return turns;
    }
    if (answer !== null && answer.status !== 202 && !(answer.status >= 500 && answer.status !== 502)) {
      fs.rmSync(jobFile, { force: true });
      throw new Error(`pyannote's voices failed (${answer.status}): ${(await answer.text()).slice(0, 200)}`);
    }
    if (Date.now() - began > timing.deadlineMs) {
      fs.rmSync(jobFile, { force: true });
      throw new Error(`pyannote's voices didn't come within ${Math.round(timing.deadlineMs / 60_000)} min`);
    }
    await Bun.sleep(timing.pollMs);
  }
}

/** The voices of a file only on this computer: its audio sent as small Opus (~14 MB an hour), then as `ofKey`. */
export async function ofFile(source: string, keep: string): Promise<Turn[]> {
  try {
    const kept = JSON.parse(fs.readFileSync(keep, "utf8")) as { turns?: unknown; file?: unknown };
    if (kept.file === source) return readTurns(kept.turns);
  } catch {
    // Not heard yet.
  }
  let key: string | null = null;
  try {
    const job = JSON.parse(fs.readFileSync(`${keep}.job`, "utf8")) as { key?: unknown };
    if (typeof job.key === "string" && /^edit\/transcribe\//u.test(job.key)) key = job.key;
  } catch {
    // Not sent yet.
  }
  if (key === null) {
    const audio = `${keep}.ogg`;
    fs.mkdirSync(parent(keep) ?? ".", { recursive: true });
    try {
      const child = Bun.spawn([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-protocol_whitelist", tools.protocols(source), ...tools.urlArgs(source), "-i", source, "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "32k", "-application", "voip", audio], { stdout: "ignore", stderr: "pipe" });
      const stderr = await new Response(child.stderr).text();
      if ((await child.exited) !== 0) throw new Error(`could not make its audio for the voices: ${diag.gist(stderr)}`);
      key = `edit/transcribe/${crypto.randomUUID()}.ogg`;
      await cloud.uploadFile(audio, key);
    } finally {
      fs.rmSync(audio, { force: true });
    }
  }
  const turns = await ofKey(key, keep);
  writeAtomic(keep, JSON.stringify({ file: source, model: MODEL, turns }));
  return turns;
}

/**
 * Gives each word the voice pyannote heard over most of it (the nearest turn
 * within a second when none covers it, else the nearer word's), replacing
 * whatever voices it had.
 */
export function label(words: Word[], turns: readonly Turn[]): void {
  const voice: (string | undefined)[] = [];
  let from = 0;
  for (const word of words) {
    while (from < turns.length && turns[from]!.end < word.start - 1) from += 1;
    const said = new Map<string, number>();
    let near: { gap: number; speaker: string } | null = null;
    for (let at = from; at < turns.length && turns[at]!.start <= word.end + 1; at += 1) {
      const turn = turns[at]!;
      const overlap = Math.min(turn.end, word.end) - Math.max(turn.start, word.start);
      if (overlap > 0) said.set(turn.speaker, (said.get(turn.speaker) ?? 0) + overlap);
      const gap = Math.max(turn.start - word.end, word.start - turn.end, 0);
      if (near === null || gap < near.gap) near = { gap, speaker: turn.speaker };
    }
    const most = [...said].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    voice.push(most ?? (near !== null && near.gap <= 1 ? near.speaker : undefined));
  }
  // A word between turns: the voice of the nearer labelled word.
  words.forEach((word, index) => {
    if (voice[index] !== undefined) {
      word.speaker = voice[index];
      return;
    }
    let before = index - 1;
    while (before >= 0 && voice[before] === undefined) before -= 1;
    let after = index + 1;
    while (after < words.length && voice[after] === undefined) after += 1;
    const gapBefore = before >= 0 ? word.start - words[before]!.end : Infinity;
    const gapAfter = after < words.length ? words[after]!.start - word.end : Infinity;
    const chosen = gapAfter < gapBefore ? voice[after] : before >= 0 ? voice[before] : undefined;
    if (chosen !== undefined) word.speaker = chosen;
    else delete word.speaker;
  });
}

/** A cloud source's whole recording and where an excerpt of it starts and ends (seconds), when it has one. */
async function recordingOf(source: string): Promise<{ key: string; start: number; end: number } | null> {
  const match = /^([^#]+)(?:#(\d+)-(\d+))?$/u.exec(source);
  if (match === null) return null;
  const { getRecord, readyOriginal } = await import("./cloud_media.ts");
  const key = readyOriginal(await getRecord(match[1]!).catch(() => null));
  if (key === null) return null;
  return { key, start: match[2] === undefined ? 0 : Number(match[2]) / 1000, end: match[3] === undefined ? Infinity : Number(match[3]) / 1000 };
}

/**
 * Gives the transcript at `target` pyannote's voices, when the flag is on and
 * it hasn't them yet: a cloud recording's (`cloudSource`, `youtube:<id>#<ms>-<ms>`
 * or `drive:<id>`, heard whole and cut to the excerpt), else the file's own.
 * Its old names go (speakers.ts names the new voices), bodycams split again.
 * True when it changed. Never throws: without them, its voices stay.
 */
export async function revoice(cacheDir: string, source: string, target: string, cloudSource: string | null): Promise<boolean> {
  if (!(await on())) return false;
  let transcript: Transcript;
  try {
    transcript = JSON.parse(fs.readFileSync(target, "utf8")) as Transcript;
  } catch {
    return false;
  }
  if (transcript.voices === MODEL || !Array.isArray(transcript.words) || transcript.words.length === 0) return false;
  try {
    const began = Date.now();
    const recording = cloudSource === null ? null : await recordingOf(cloudSource);
    let turns: Turn[];
    if (recording !== null) {
      const whole = await ofKey(recording.key, join(cacheDir, "voices", `${new Bun.CryptoHasher("sha256").update(recording.key).digest("hex").slice(0, 32)}.json`));
      turns = whole
        .filter((turn) => turn.end > recording.start && turn.start < recording.end)
        .map((turn) => ({ start: Math.max(0, turn.start - recording.start), end: Math.min(turn.end, recording.end) - recording.start, speaker: turn.speaker }));
    } else {
      turns = await ofFile(source, `${target}.voices.json`);
    }
    // Read again: nothing written meanwhile is lost.
    const now = JSON.parse(fs.readFileSync(target, "utf8")) as Transcript;
    label(now.words, turns);
    now.voices = MODEL;
    for (const field of ["speakers", "roles", "colors", "looks", "cameras"] as const) delete now[field];
    await cameras.split(source, now).catch((error: unknown) => diag.warn("voices", `${source}: reading its bodycams: ${diag.messageOf(error)}`));
    writeAtomic(target, serialize(now));
    const voices = new Set(now.words.map((word) => word.speaker).filter(Boolean)).size;
    diag.info("voices", `${source}: pyannote's voices (${voices}) from ${recording !== null ? "its whole recording" : "its own audio"} in ${Math.round((Date.now() - began) / 1000)} s`);
    return true;
  } catch (error) {
    diag.warn("voices", `${source}: pyannote's voices: ${diag.messageOf(error)}; its voices stay as they were`);
    return false;
  }
}
