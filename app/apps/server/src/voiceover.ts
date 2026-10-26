// Voice-overs for the script's cut-ins. The recordings read
// the cut-ins' text, so each cut-in's words are found in their transcripts and
// that stretch of audio is laid where the cut-in is. The cut-in is lengthened
// to it and everything after moves with it, so the timeline stays butted.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import { parseTranscript } from "./captions_core.ts";
import { clipFrom } from "./clips.ts";
import * as diag from "./diag.ts";
import { copyFile, ioMessage } from "./files.ts";
import * as footageLevels from "./footage_levels.ts";
import { isBug } from "./guard.ts";
import { importPaths } from "./import.ts";
import type { Clip, Media, Project } from "./model.ts";
import { native } from "./native/index.ts";
import { addTrack, clipEnd, clipMedia, clipOf, fps as fpsOf, freshId, isSoundEffect, marksCut, mediaOf, trackOf } from "./project.ts";
import { join } from "./paths.ts";
import { debugStrings, f32Saved, isAlphanumeric, isWhitespace, jsonForSerde, round, splitWhitespace, toI64, trim } from "./rust.ts";
import * as seams from "./seams.ts";
import type { Word } from "./transcribe.ts";

/** Lead-in kept before the first word and tail after the last (seconds). */
const LEAD = 0.12;
const TAIL = 0.3;
/** Share of a cut-in's words that must be heard for a stretch to count as reading it. */
const LEAST_MATCH = 0.5;

/** Waits (tests make them instant). */
export const timing = {
  sleep: (ms: number) => Bun.sleep(ms),
  now: () => performance.now(),
};

type Json = unknown;

/** The project as it is now (a copy to change in place). */
function replaceContents(target: Project, source: Project): void {
  for (const key of Object.keys(target) as (keyof Project)[]) delete target[key];
  Object.assign(target, source);
}

/**
 * Places voice-overs on the cut-ins: `media` (default: audio that isn't on the
 * timeline and isn't a sound effect). Placing again replaces what it placed.
 */
export async function place(app: App, id: string, given: string[] | null): Promise<Json> {
  const live = app.store.get(id);
  if (live === null) throw new Error("no such project");
  const project = live.project;
  let recordings: Media[];
  if (given !== null) {
    recordings = given.map((mediaId) => {
      const found = mediaOf(project, mediaId);
      if (found === undefined) throw new Error(`no media ${mediaId}`);
      return found;
    });
  } else {
    // Recordings not on the timeline yet, and the ones already placed (to place again).
    const placed = placedVoiceovers(project);
    recordings = project.media.filter(
      (media) =>
        media.kind === "audio" &&
        !isSoundEffect(media) &&
        (placed.includes(media.id) || !project.clips.some((clip) => clipMedia(clip) === media.id)),
    );
  }
  if (recordings.length === 0) throw new Error("no voice-over recordings: import the audio first");
  const heard: [string, Word[]][] = [];
  for (const media of recordings) heard.push([media.id, await transcript(app, media)]);

  const [, report] = await app.store.update(id, "agent", (project) => {
    const fps = fpsOf(project);
    const blocks = structuredClone(project.script?.blocks ?? []);
    // What it placed before goes where it places again; the cut-ins keep the
    // length they were given. Recordings named by hand (`given`) replace only
    // the cut-ins they read: the others keep their voice-overs.
    const previous = new Map<number, string>();
    blocks.forEach((block, index) => {
      if (block.kind === "narration" && block.voiceover !== undefined && block.voiceover !== null) previous.set(index, block.voiceover);
    });
    const before = project.clips.find((clip) => [...previous.values()].includes(clip.id))?.track;
    const track = before !== undefined && trackOf(project, before) !== undefined ? before : addTrack(project, "audio");
    const drop = (index: number) => {
      const old = previous.get(index);
      if (old !== undefined) project.clips = project.clips.filter((clip) => clip.id !== old);
    };

    const report: Json[] = [];
    const voiceovers = new Map<number, string>();
    blocks.forEach((block, index) => {
      if (block.kind !== "narration" || block.clip === undefined || block.clip === null) return;
      const found = clipOf(project, block.clip);
      if (found === undefined) return;
      const card = structuredClone(found);
      const wanted = wordsOf(block.text);
      let best: [string, Word[], Found] | null = null;
      for (const [media, words] of heard) {
        const spoken = words.map((word) => normalize(word.text));
        const match = find(wanted, spoken);
        // max_by_key keeps the last of equals.
        if (match !== null && (best === null || match.matched >= best[2].matched)) best = [media, words, match];
      }
      const preview = splitWhitespace(block.text).slice(0, 8).join(" ");
      const missing = { cut_in: preview, placed: false, why: "its words weren't found in the recordings" };
      const kept = given !== null ? previous.get(index) : undefined;
      const unread = () => {
        if (kept !== undefined && clipOf(project, kept) !== undefined) {
          voiceovers.set(index, kept);
          report.push({ cut_in: preview, kept, why: "the recordings given don't read it: its voice-over stays" });
        } else {
          drop(index);
          report.push(missing);
        }
      };
      if (best === null || !(best[2].matched >= wanted.length * LEAST_MATCH)) {
        unread();
        return;
      }
      const [media, words, aligned] = best;
      const match = widen(wanted, words.map((word) => normalize(word.text)), aligned);
      // Breathing room, without reaching into the words around it.
      const first = words[match.first];
      const last = words[match.last];
      if (first === undefined || last === undefined) {
        unread();
        return;
      }
      drop(index);
      const ending = match.first > 0 ? words[match.first - 1]?.end : undefined;
      const starting = words[match.last + 1]?.start;
      const from = Math.max(first.start - LEAD, ending === undefined ? 0 : (ending + first.start) / 2, 0);
      const to = Math.min(last.end + TAIL, starting === undefined ? Number.MAX_VALUE : (last.end + starting) / 2);
      const length = Math.trunc(Math.max(round((to - from) * fps), 1));

      // The cut-in (and its words) takes the voice-over's length; what follows moves.
      const delta = length - card.duration;
      const oldEnd = clipEnd(card);
      for (const other of project.clips) {
        const partner = other.id === card.id || (card.link !== undefined && card.link !== null && other.link === card.link);
        if (partner) other.duration = length;
        else if (other.start >= oldEnd || (other.start > card.start && marksCut(other, oldEnd))) other.start += delta;
      }
      const clipId = freshId(project, "c");
      project.clips.push(
        clipFrom({
          id: clipId,
          track,
          start: card.start,
          duration: length,
          color: "green",
          name: "Voice-over",
          type: "audio",
          media,
          source_in: from,
          speed: 1,
          volume_db: 0,
        }),
      );
      voiceovers.set(index, clipId);
      report.push({
        at_seconds: card.start / fps,
        clip: clipId,
        cut_in: preview,
        cut_in_frames_longer: delta,
        heard: `${first.text} … ${last.text}`,
        media,
        placed: true,
        seconds: round((length / fps) * 100) / 100,
        words_matched: `${match.matched}/${wanted.length}`,
      });
    });
    project.script?.blocks.forEach((block, index) => {
      if (block.kind !== "narration") return;
      const placedClip = voiceovers.get(index);
      if (placedClip === undefined) delete block.voiceover;
      else block.voiceover = placedClip;
    });
    return report;
  });
  // Voice-overs sit at the footage's loudness, so the narration is as loud as what's said on screen.
  const placedClips = (report as { clip?: unknown }[]).flatMap((entry) => (typeof entry.clip === "string" ? [entry.clip] : []));
  const now = app.store.get(id);
  if (now === null) throw new Error("project vanished");
  let gains: [string, number][] = [];
  try {
    const target = await seams.library.footageLoudness(now.project);
    for (const clipId of placedClips) {
      const clip = clipOf(now.project, clipId);
      if (clip === undefined) continue;
      try {
        gains.push([clipId, await seams.library.gainTo(now.project, clip, target)]);
      } catch (error) {
        if (isBug(error)) throw error;
      }
    }
  } catch (error) {
    if (isBug(error)) throw error;
    gains = [];
  }
  await app.store.update(id, "agent", (project) => {
    for (const [clipId, gain] of gains) {
      const clip = project.clips.find((own) => own.id === clipId);
      if (clip?.type === "audio") clip.volume_db = f32Saved(gain);
    }
  });
  // And the footage's speech at theirs: a quiet interrogation room played 15 LU
  // under the narration ("increase the audio of the footage to … match the
  // sort of average volume for the voiceover"). Gains already set are kept.
  try {
    const placed = app.store.get(id);
    if (placed !== null && gains.length > 0) {
      const { levels } = await footageLevels.levelFootage(app, placed.project, undefined, true);
      await footageLevels.apply(app, id, levels, "agent");
    }
  } catch (error) {
    if (isBug(error)) throw error;
    diag.warn("voiceover", `footage not levelled to the voice-overs: ${diag.messageOf(error)}`);
  }
  return report;
}

/**
 * Speaks the script's cut-ins with the house voice (ElevenLabs) and lays the
 * takes on them: the last step of a script import. A voice-over an earlier run
 * left half spoken carries on instead of starting again.
 */
export async function generate(app: App, id: string): Promise<Json> {
  const live = app.store.get(id);
  if (live === null) throw new Error("no such project");
  const lines = seams.voice.narrationLines(live.project);
  if (lines.length === 0) return { media: [] };
  const name = `${live.project.name} (voice-over)`;
  const project = app.voices.forProject(name, id, lines);
  // One at a time, in order: each line carries on from the one before.
  for (const line of project.lines) {
    if (line.chosen === null) await app.voices.generate(project.id, line.id);
  }
  return send(app, project.id, id);
}

/**
 * Puts a voice-over's chosen takes into video project `id` and lays them on its
 * cut-ins (matched by their words, as with any recorded voice-over).
 */
export async function send(app: App, voiceId: string, id: string): Promise<Json> {
  const voice = app.voices.get(voiceId);
  const takes = app.voices.chosenTakes(voiceId);
  if (takes.length === 0) throw new Error("No lines have a chosen take yet.");
  if (app.store.get(id) === null) throw new Error("no such project");
  const dir = join(app.store.uploadsDir(id), "voice-over");
  const paths: string[] = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const [number, label, take] of takes) {
      const name = label ?? `Line ${number}`;
      const file = join(dir, `${voice.name.replaceAll("/", "-")} - ${name}.mp3`);
      copyFile(take, file);
      paths.push(file);
    }
  } catch (error) {
    throw new Error(ioMessage(error));
  }
  const [, added, errors] = await importPaths(app, id, paths, false, "voice");
  if (added.length === 0) throw new Error(`Couldn't import the takes: ${debugStrings(errors)}`);
  const report = await diag.timeAsync("voice", "voice: place in a project", () => place(app, id, [...added]));
  return { media: added, report };
}

/** How far a new take may be sped or slowed to fit its cut-in (`revoice`). */
const REVOICE_SPEEDS: [number, number] = [0.85, 1.2];

/**
 * Speaks cut-in `cutIn` (1-based) again with the house voice, with `text`
 * when given (a word fixed: "himself" → "herself"; a house word reworded so
 * the narration needn't be muted), and puts the new take in place of its
 * voice-over, played at the speed that fits the cut-in as it is, so nothing
 * else on the timeline moves. The script's cut-in text follows.
 */
export async function revoice(app: App, id: string, cutIn: number, text: string | null): Promise<Json> {
  const live = app.store.get(id);
  if (live === null) throw new Error("no such project");
  const blocks = (live.project.script?.blocks ?? []).filter((block) => block.kind === "narration");
  const block = blocks[cutIn - 1];
  if (block === undefined || block.kind !== "narration") throw new Error(`there's no cut-in ${cutIn} (the script has ${blocks.length})`);
  const clipId = block.voiceover ?? null;
  const placed = clipId === null ? undefined : clipOf(live.project, clipId);
  if (placed === undefined || placed.type !== "audio") throw new Error(`cut-in ${cutIn} has no voice-over placed yet: place_voiceovers first`);
  const words = trim(text ?? block.text);
  if (words === "") throw new Error("text is empty");
  const label = `Cut-in ${cutIn}`;
  // This edit's voice-over (made on another machine, there's none here: one
  // is started from the script's lines, and only this line is spoken).
  const lines = seams.voice.narrationLines(live.project);
  let voice = app.voices
    .list()
    .map((summary) => app.voices.get((summary as { id: string }).id))
    .filter((own) => own.source === id && own.lines.some((line) => line.label === label))
    .sort((a, b) => b.modified_ms - a.modified_ms)[0];
  voice ??= app.voices.create(`${live.project.name} (voice-over)`, id, lines);
  const line = voice.lines.find((own) => own.label === label);
  if (line === undefined) throw new Error(`the voice-over has no line for ${label}`);
  line.text = words;
  app.voices.save(voice);
  const spoken = await diag.timeAsync("voice", "voice: revoice a cut-in", () => app.voices.generate(voice.id, line.id));
  const take = spoken.lines.find((own) => own.id === line.id)?.chosen ?? null;
  if (take === null) throw new Error("the line wasn't spoken");
  const file = join(app.store.uploadsDir(id), "voice-over", `${voice.name.replaceAll("/", "-")} - ${label} (${take}).mp3`);
  try {
    fs.mkdirSync(join(app.store.uploadsDir(id), "voice-over"), { recursive: true });
    copyFile(app.voices.takePath(voice.id, take), file);
  } catch (error) {
    throw new Error(ioMessage(error));
  }
  const [, added, errors] = await importPaths(app, id, [file], false, "voice");
  const mediaId = added[0];
  if (mediaId === undefined) throw new Error(`Couldn't import the take: ${debugStrings(errors)}`);
  const fps = fpsOf(live.project);
  const [saved, report] = await app.store.update(id, "agent", (project) => {
    const clip = clipOf(project, placed.id);
    const media = mediaOf(project, mediaId);
    if (clip === undefined || clip.type !== "audio" || media === undefined) throw new Error("the voice-over changed while the take was spoken");
    const seconds = clip.duration / fps;
    const speed = media.duration / seconds;
    if (speed < REVOICE_SPEEDS[0] || speed > REVOICE_SPEEDS[1]) {
      throw new Error(
        `the new take is ${round(media.duration * 10) / 10} s and the cut-in ${round(seconds * 10) / 10} s: too far apart to fit by speed; reword it nearer the old length (the take is media ${mediaId})`,
      );
    }
    clip.media = mediaId;
    clip.source_in = 0;
    clip.speed = f32Saved(speed);
    // Its house words are muted again by the next mute_house_words.
    clip.mutes = [];
    const own = (project.script?.blocks ?? []).filter((one) => one.kind === "narration")[cutIn - 1];
    if (own !== undefined && own.kind === "narration") own.text = words;
    return { cut_in: cutIn, clip: clip.id, media: mediaId, take_seconds: round(media.duration * 100) / 100, speed: round(speed * 1000) / 1000, text: words };
  });
  // Its words, for get_edit_context's cut-in timings and the mutes.
  const media = mediaOf(saved.project, mediaId);
  if (media !== undefined) await transcript(app, media);
  return { ...report, rev: saved.rev, then: "run mute_house_words over the whole timeline (its mutes were cleared)" };
}

/** Whether any cut-in already plays a voice-over. */
export function anyPlaced(project: Project): boolean {
  return placedVoiceovers(project).length > 0;
}

/** Media the script's narration already plays as voice-overs. */
function placedVoiceovers(project: Project): string[] {
  return (project.script?.blocks ?? []).flatMap((block) => {
    if (block.kind !== "narration" || block.voiceover === undefined || block.voiceover === null) return [];
    const clip = clipOf(project, block.voiceover);
    const media = clip === undefined ? null : clipMedia(clip);
    return media === null ? [] : [media];
  });
}

/** How long a recording's transcription is waited for. */
const TRANSCRIBE_LIMIT_MS = 15 * 60 * 1000;

/**
 * Whether a recording's transcript is too thin to be its speech: a few words
 * for a long take (the transcriber once answered 19 s of narration with
 * ". latest 卧"), so it's transcribed once more.
 */
export function garbled(words: Word[], seconds: number): boolean {
  return seconds >= 8 && words.length < seconds / 4;
}

/** A recording's words, transcribing it first if needed (and once more if it comes back garbled). */
async function transcript(app: App, media: Media): Promise<Word[]> {
  const words = await transcribed(app, media, false);
  if (!garbled(words, media.duration)) return words;
  diag.warn("voice", `${media.name}: ${words.length} words heard in ${round(media.duration)} s; transcribing it again`);
  return transcribed(app, media, true);
}

async function transcribed(app: App, media: Media, again: boolean): Promise<Word[]> {
  const path = media.path;
  if (again) app.media.retranscribe(path, media.has_audio);
  else app.media.transcribe(path, media.has_audio);
  const started = timing.now();
  for (;;) {
    const status = app.media.status(path);
    if (status.transcript === "ready") {
      let text: string;
      try {
        text = fs.readFileSync(app.media.paths(path).transcript, "utf8");
      } catch (error) {
        throw new Error(ioMessage(error));
      }
      return parseTranscript(text).words;
    }
    if (status.transcript === "failed") throw new Error(`couldn't transcribe ${media.name}: ${status.transcript_error ?? ""}`);
    if (timing.now() - started > TRANSCRIBE_LIMIT_MS) throw new Error(`transcribing ${media.name} is taking too long`);
    await timing.sleep(2000);
  }
}

/** A word as compared: lower case, letters and digits only. */
export function normalize(word: string): string {
  let out = "";
  for (const c of word) if (isAlphanumeric(c)) out += c.toLowerCase();
  return out;
}

export function wordsOf(text: string): string[] {
  const words: string[] = [];
  let current = "";
  for (const c of text) {
    if (isWhitespace(c) || c === "-" || c === "—" || c === "–") {
      words.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  words.push(current);
  return words.map(normalize).filter((word) => word !== "");
}

/** Whether a written and a heard word are the same, allowing a slip of one letter in longer words. */
export function same(a: string, b: string): boolean {
  if (a === b) return true;
  const x = [...a];
  const y = [...b];
  if (Math.min(x.length, y.length) < 4 || Math.abs(x.length - y.length) > 1) return false;
  // Edit distance of at most one.
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (x.length > y.length) i += 1;
    else if (x.length < y.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (x.length - i) + (y.length - j) <= 1;
}

/**
 * Where in `heard` the written words are read: the best local alignment
 * (Smith–Waterman: a word in common scores, a word missed or added costs).
 */
export interface Found {
  first: number;
  last: number;
  matched: number;
}

/**
 * A match widened over the block's edge words the alignment left out when
 * the recording says them a little differently: the script's "He's streamed
 * with Kanye West" read as "He streamed…" lost its "He" (the team, N3on v1:
 * "you have cut out 'he' in the voice over… It makes it sound really cheap").
 * An edge word comes back when it's one spoken word for one written one and
 * one starts the other ("he" in "hes").
 */
export function widen(written: string[], heard: string[], match: Found): Found {
  const near = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a !== "" && b !== "" && (a.startsWith(b) || b.startsWith(a) || same(a, b));
  const out = { ...match };
  // Which written words the ends were aligned to: the nearest matching ones.
  const firstWritten = written.findIndex((word) => same(word, heard[match.first] ?? ""));
  const lastWritten = written.length - 1 - [...written].reverse().findIndex((word) => same(word, heard[match.last] ?? ""));
  for (let i = firstWritten - 1; i >= 0 && out.first > 0 && near(written[i], heard[out.first - 1]); i--) out.first -= 1;
  if (lastWritten < written.length) for (let i = lastWritten + 1; i < written.length && out.last + 1 < heard.length && near(written[i], heard[out.last + 1]); i++) out.last += 1;
  return out;
}

export function find(written: string[], heard: string[]): Found | null {
  const rows = written.length;
  const cols = heard.length;
  if (rows === 0 || cols === 0) return null;
  const width = cols + 1;
  const score = new Int32Array((rows + 1) * width);
  // A cell outside the table is no alignment.
  const cell = (i: number, j: number) => (i < 0 || j < 0 ? 0 : (score[i * width + j] ?? 0));
  let best: [number, number, number] = [0, 0, 0];
  for (let i = 1; i <= rows; i++) {
    const said = written[i - 1]!;
    for (let j = 1; j <= cols; j++) {
      const read = heard[j - 1]!;
      const diagonal = cell(i - 1, j - 1) + (same(said, read) ? 2 : -1);
      const up = cell(i - 1, j) - 1;
      const left = cell(i, j - 1) - 1;
      const value = Math.max(diagonal, up, left, 0);
      score[i * width + j] = value;
      if (value > best[0]) best = [value, i, j];
    }
  }
  if (best[0] === 0) return null;
  // Walk back to where the alignment starts, counting the words in common.
  let [, i, j] = best;
  const last = j - 1;
  let first = last;
  let matched = 0;
  while (i > 0 && j > 0 && cell(i, j) > 0) {
    const said = written[i - 1];
    const read = heard[j - 1];
    if (said === undefined || read === undefined) break;
    const here = cell(i, j);
    const hit = same(said, read);
    if (here === cell(i - 1, j - 1) + (hit ? 2 : -1)) {
      if (hit) {
        matched += 1;
        first = j - 1;
      }
      i -= 1;
      j -= 1;
    } else if (here === cell(i - 1, j) - 1) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return { first, last, matched };
}

/**
 * Whether `clip` is a voice-over: one the script's narration plays, one
 * place_voiceovers laid ("Voice-over"), or a voice-over project's take
 * ("<voice-over> - Cut-in N").
 */
export function isVoiceover(project: Project, clip: Clip): boolean {
  if (clip.type !== "audio") return false;
  const narrated = (project.script?.blocks ?? []).some((block) => block.kind === "narration" && block.voiceover === clip.id);
  return (
    narrated ||
    (clip.name ?? "").startsWith("Voice-over") ||
    (mediaOf(project, clip.media)?.name.includes(" - Cut-in ") ?? false)
  );
}

/**
 * The sound of the script's source excerpts playing in frames `[from, to)`, in
 * order: the team (N3on v1): "the majority of the silence is cut out from the
 * video… word, word, word, word… unless the silence makes sense for dramatic
 * effect".
 */
export function excerptsIn(project: Project, from: number, to: number): Clip[] {
  const placed = new Set((project.script?.blocks ?? []).flatMap((block) => (block.kind === "footage" && block.clip != null ? [block.clip] : [])));
  const links = new Set(project.clips.filter((clip) => placed.has(clip.id) && clip.link != null).map((clip) => clip.link as string));
  return project.clips
    .filter((clip) => clip.type === "audio" && clip.start < to && clipEnd(clip) > from && (placed.has(clip.id) || (clip.link != null && links.has(clip.link))))
    .sort((a, b) => a.start - b.start);
}

/** The voice-over clips playing in frames `[from, to)`, in order. */
function voiceoversIn(project: Project, from: number, to: number): Clip[] {
  return project.clips
    .filter((clip) => clip.start < to && clipEnd(clip) > from && isVoiceover(project, clip))
    .sort((a, b) => a.start - b.start);
}

/**
 * The voice-overs heard in frames `[from, to)`: voice-over clips of sound files
 * on audio tracks that aren't muted (a video file's own sound is
 * `subtitles.footageSound`). Their house words are muted like the footage's.
 */
export function voiceoverSound(project: Project, from: number, to: number): Clip[] {
  return voiceoversIn(project, from, to).filter((clip) => {
    const track = trackOf(project, clip.track);
    if (track === undefined || track.kind !== "audio" || track.muted) return false;
    if (clip.type !== "audio") return false;
    const media = mediaOf(project, clip.media);
    return media !== undefined && media.kind !== "video";
  });
}

/**
 * A silence between two words of a voice-over, and the frames of the timeline
 * that shortening it takes out (`[from, to)`).
 */
export interface Pause {
  clip: string;
  /** The word before it and the one after. */
  between: [string, string];
  /** How long it is on the timeline (seconds). */
  seconds: number;
  from: number;
  to: number;
}

/**
 * The pauses in voice-over `clip` longer than `maxPause` seconds (on the
 * timeline) between two of its words, each shortened to about `keep`: what
 * stays is split evenly after the word before and before the word after, so no
 * word is touched, and the silence before its first word and after its last
 * are left alone.
 */
export function pauses(project: Project, clip: Clip, words: Word[], maxPause: number, keep: number): Pause[] {
  if (clip.type !== "audio") return [];
  const sourceIn = clip.source_in;
  const speed = clip.speed;
  const fps = fpsOf(project);
  const sourceOut = sourceIn + (clip.duration / fps) * speed;
  const heard = words
    .filter((word) => trim(word.text) !== "")
    .filter((word) => word.start >= sourceIn - 1e-6 && word.end <= sourceOut + 1e-6)
    .sort((a, b) => a.start - b.start);
  // Seconds of the source to frames of the timeline.
  const at = (seconds: number) => clip.start + ((seconds - sourceIn) / speed) * fps;
  const out: Pause[] = [];
  for (let index = 0; index + 1 < heard.length; index++) {
    const before = heard[index]!;
    const after = heard[index + 1]!;
    const seconds = (after.start - before.end) / speed;
    if (seconds <= maxPause) continue;
    const half = (keep / 2) * fps;
    const from = toI64(Math.ceil(at(before.end) + half));
    const to = toI64(Math.floor(at(after.start) - half));
    if (to > from) out.push({ clip: clip.id, between: [trim(before.text), trim(after.text)], seconds, from, to });
  }
  return out;
}

/**
 * The pauses to shorten in the voice-overs between frames `from` and `to`
 * (wholly inside it), and those left because someone in the footage is heard
 * over them.
 */
export function tightenPlan(
  project: Project,
  words: Map<string, Word[]>,
  from: number,
  to: number,
  maxPause: number,
  keep: number,
  footage = false,
): [Pause[], Pause[]] {
  const cut: Pause[] = [];
  const left: Pause[] = [];
  for (const clip of footage ? excerptsIn(project, from, to) : voiceoversIn(project, from, to)) {
    const media = clipMedia(clip);
    const heard = media === null ? undefined : words.get(media);
    if (heard === undefined) continue;
    for (const pause of pauses(project, clip, heard, maxPause, keep)) {
      if (pause.from < from || pause.to > to) continue;
      // A source excerpt's own gap is cut with its picture (a jump cut, word to word).
      if (footage || seams.subtitles.footageSound(project, pause.from, pause.to).length === 0) cut.push(pause);
      else left.push(pause);
    }
  }
  return [cut, left];
}

/** Takes `pauses` out of the timeline, latest first so each is where it was found; frames removed in all. */
export function removePauses(project: Project, found: Pause[]): number {
  const spans = found
    .map((pause): [number, number] => [pause.from, pause.to])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .filter((span, index, all) => index === 0 || span[0] !== all[index - 1]![0] || span[1] !== all[index - 1]![1]);
  let removed = 0;
  for (const [from, to] of spans.reverse()) {
    const cut = native().removeTime({ json: jsonForSerde(project) }, from, to);
    replaceContents(project, JSON.parse(cut.json) as Project);
    removed += cut.rippled.frames;
  }
  return removed;
}

/**
 * Shortens the long pauses in the voice-overs between `from` and `to`
 * (timeline frames) to `keep` seconds, rippling the timeline (B-roll and all
 * after it follow). `dryRun` only lists them.
 */
export async function tighten(
  app: App,
  id: string,
  span: [number, number],
  maxPause: number,
  keep: number,
  dryRun: boolean,
  footage = false,
): Promise<Json> {
  const live = app.store.get(id);
  if (live === null) throw new Error("no such project");
  const project = live.project;
  const fps = fpsOf(project);
  const [from, to] = span;
  const media = (footage ? excerptsIn(project, from, to) : voiceoversIn(project, from, to)).flatMap((clip) => {
    const own = clipMedia(clip);
    return own === null ? [] : [own];
  });
  if (media.length === 0) throw new Error(footage ? "no source excerpt plays in that span" : "no voice-over plays in that span");
  const words = new Map<string, Word[]>();
  for (const mediaId of media) {
    if (words.has(mediaId)) continue;
    const found = mediaOf(project, mediaId);
    if (found === undefined) continue;
    words.set(mediaId, await transcript(app, found));
  }
  const seconds = (frames: number) => round((frames / fps) * 100) / 100;
  const describe = (pause: Pause) => ({
    at: seconds(pause.from),
    between: `${pause.between[0]} … ${pause.between[1]}`,
    clip: pause.clip,
    pause: round(pause.seconds * 100) / 100,
    removed: seconds(pause.to - pause.from),
  });
  let cut: Pause[];
  let left: Pause[];
  let removed: number;
  if (dryRun) {
    [cut, left] = tightenPlan(project, words, from, to, maxPause, keep, footage);
    removed = cut.reduce((total, pause) => total + (pause.to - pause.from), 0);
  } else {
    [, [cut, left, removed]] = await app.store.update(id, "agent", (project): [Pause[], Pause[], number] => {
      const [cut, left] = tightenPlan(project, words, from, to, maxPause, keep, footage);
      return [cut, left, removePauses(project, cut)];
    });
  }
  return {
    dry_run: dryRun,
    left_alone: left.map(describe),
    note: "times are where each pause was before any was taken out",
    pauses: cut.map(describe),
    removed_seconds: seconds(removed),
  };
}

/**
 * Plays the voice-overs between frames `from` and `to` `speed` times faster
 * (pitch kept), with everything laid over them squeezed to match, and ripples
 * the rest: (the span actually sped, frames saved). Refuses a span with the
 * footage's own sound in it, which would speed up what people say.
 */
export function speedUp(project: Project, from: number, to: number, speed: number): [number, number, number] {
  if (!(speed >= 1.01 && speed <= 1.25)) throw new Error("speed must be between 1.01 and 1.25 (1.04–1.08 is usual)");
  const clips = voiceoversIn(project, from, to);
  if (clips.length === 0) throw new Error("no voice-over plays in that span");
  const first = Math.min(...clips.map((clip) => clip.start));
  const last = Math.max(...clips.map((clip) => clipEnd(clip)));
  const start = Math.max(from, first);
  const end = Math.min(to, last);
  const footage = seams.subtitles.footageSound(project, start, end).map((clip) => clip.id);
  if (footage.length > 0) {
    throw new Error(`the footage's own sound plays in that span (${footage.join(", ")}); speed only a stretch that's voice-over`);
  }
  // Music and sound effects over it keep their speed: only the narration (and
  // the picture laid over it) plays faster.
  const narration = new Set(voiceoversIn(project, start, end).map((clip) => clip.id));
  const hold = project.clips.filter((clip) => clip.type === "audio" && !narration.has(clip.id)).map((clip) => clip.id);
  const done = native().speedSpanHolding({ json: jsonForSerde(project) }, start, end, speed, hold);
  replaceContents(project, JSON.parse(done.json) as Project);
  return [start, end, done.rippled.frames];
}
