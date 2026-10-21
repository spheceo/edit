// The footage's own speech at the voice-overs' level. Interrogation footage
// is recorded quietly (a room mic, people far from it): in the Sabrina Limon
// A/B its clips played at -35 to -50 LUFS under voice-overs at -22, and the
// user asked "to increase the audio of the footage to try and have it match
// the sort of average volume for the voiceover". Each footage clip is
// measured over what's said in it (from its first word to its last, by its
// transcript), so the pauses between lines don't make a clip read quieter
// than its speech; a clip with nothing said takes the gain of the nearest
// clip of the same file, so a room's hum doesn't jump. The export's limiter
// takes the peaks a boost raises.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { isBug } from "./guard.ts";
import * as library from "./library.ts";
import type { AudioClip, Project } from "./model.ts";
import { native } from "./native/index.ts";
import { clipEnd, fps as fpsOf, isSoundEffect, mediaOf, trackOf } from "./project.ts";
import { f32 } from "./rust.ts";
import * as seams from "./seams.ts";

/** Footage speech this far (LU) under or over the voice-overs is flagged. */
export const OFF_LU = 6.0;
/**
 * Music under a narration sits this far (LU) under it; closer than
 * MUSIC_CLOSEST is `music_loud` (Helpful Wife's bridges played their beds
 * 9–10 LU under the voice: "we need to turn down the music here"; at 16 the
 * team still asked, round after round, to turn it down "significantly").
 */
export const MUSIC_UNDER = 20.0;
const MUSIC_CLOSEST = 16.0;
/** The most a clip is turned up (a near-silent room boosted further is only noise) and down. */
const MOST_UP = 24.0;
const MOST_DOWN = -12.0;

interface Stretch {
  path: string;
  from: number;
  seconds: number;
}

/** A footage clip and the stretch of it that's speech (null: nothing said in it). */
interface Footage {
  clip: AudioClip;
  speech: Stretch | null;
}

/** Speech loudness by stretch (null: silent), before any clip's gain. */
const heard = new Map<string, number | null>();
const measuring = new Set<string>();

const keyOf = (stretch: Stretch) => `${native().mediaKey(stretch.path)}|${stretch.from.toFixed(3)}|${stretch.seconds.toFixed(3)}`;

/** The words of a file's transcript, if it's been transcribed. */
function wordsOf(app: App, path: string): { start: number; end: number }[] | null {
  try {
    const value = JSON.parse(fs.readFileSync(app.media.paths(path).transcript, "utf8")) as { words?: unknown };
    if (!Array.isArray(value.words)) return null;
    return (value.words as { start?: unknown; end?: unknown }[]).flatMap((word) =>
      typeof word.start === "number" && typeof word.end === "number" ? [{ start: word.start, end: word.end }] : [],
    );
  } catch {
    return null;
  }
}

/** The footage's sound clips (sound from video, on tracks that play), in timeline order. */
function footage(app: App, project: Project): Footage[] {
  const fps = fpsOf(project);
  const words = new Map<string, { start: number; end: number }[] | null>();
  const out: Footage[] = [];
  for (const clip of project.clips) {
    if (clip.type !== "audio" || trackOf(project, clip.track)?.muted === true) continue;
    const media = mediaOf(project, clip.media);
    if (media === undefined || media.kind !== "video" || !media.has_audio) continue;
    if (!words.has(media.path)) words.set(media.path, wordsOf(app, media.path));
    const said = words.get(media.path) ?? null;
    const from = clip.source_in;
    const to = from + (clip.duration / fps) * clip.speed;
    let speech: Stretch | null;
    if (said === null) {
      // Not transcribed: the whole clip stands for its speech.
      speech = { path: media.path, from, seconds: to - from };
    } else {
      const inside = said.filter((word) => word.end > from && word.start < to);
      const first = inside[0];
      const last = inside.at(-1);
      speech =
        first === undefined || last === undefined
          ? null
          : { path: media.path, from: Math.max(first.start, from), seconds: Math.min(last.end, to) - Math.max(first.start, from) };
    }
    out.push({ clip, speech: speech !== null && speech.seconds > 0.05 ? speech : null });
  }
  return out.sort((a, b) => a.clip.start - b.clip.start);
}

async function measure(stretch: Stretch): Promise<number | null> {
  const key = keyOf(stretch);
  if (heard.has(key)) return heard.get(key) ?? null;
  let lufs: number | null;
  try {
    [lufs] = await library.levels(stretch.path, stretch.from, stretch.seconds);
  } catch (error) {
    if (isBug(error)) throw error;
    lufs = null;
  }
  heard.set(key, lufs);
  return lufs;
}

/** The voice-overs' clips as stretches with their gains and lengths on the timeline. */
function voiceovers(project: Project): [Stretch, number, number][] {
  const fps = fpsOf(project);
  const out: [Stretch, number, number][] = [];
  for (const clip of project.clips) {
    if (clip.type !== "audio" || !seams.voiceover.isVoiceover(project, clip)) continue;
    if (trackOf(project, clip.track)?.muted === true) continue;
    const media = mediaOf(project, clip.media);
    if (media === undefined || isSoundEffect(media)) continue;
    const length = clip.duration / fps;
    out.push([{ path: media.path, from: clip.source_in, seconds: length * clip.speed }, Math.fround(clip.volume_db), length]);
  }
  return out;
}

/** Energy average of (LUFS, seconds) pairs. */
function average(levels: [number, number][]): number | null {
  let energy = 0.0;
  let seconds = 0.0;
  for (const [lufs, length] of levels) {
    energy += length * 10 ** (lufs / 10.0);
    seconds += length;
  }
  return seconds > 0.0 ? 10.0 * Math.log10(energy / seconds) : null;
}

/** How loud the voice-overs are as heard, in LUFS (null: none). */
export async function voiceoverLevel(project: Project): Promise<number | null> {
  const levels: [number, number][] = [];
  for (const [stretch, gain, length] of voiceovers(project)) {
    const lufs = await measure(stretch);
    if (lufs !== null) levels.push([lufs + gain, length]);
  }
  return average(levels);
}

export interface Levelled {
  clip: string;
  /** The speech's loudness before the gain (null: nothing said in it). */
  speech: number | null;
  volume_db: number;
}

/**
 * The gain for each footage clip that brings its speech to `target` LUFS
 * (default: the voice-overs' level). `untouched`: only clips still at 0 dB
 * (what the user or agent set is kept).
 */
export async function levelFootage(app: App, project: Project, target?: number, untouched = false): Promise<{ target: number; levels: Levelled[] }> {
  const aim = target ?? (await voiceoverLevel(project));
  if (aim === null) throw new Error("no voice-overs to match: give loudness in LUFS");
  const clips = footage(app, project);
  await native().loudnessPrepare([...new Set(clips.flatMap((one) => (one.speech === null ? [] : [one.speech.path])))]);
  const levels: Levelled[] = [];
  for (const one of clips) {
    const speech = one.speech === null ? null : await measure(one.speech);
    const gain = speech === null ? null : Math.min(Math.max(Math.round((aim - speech) * 10) / 10, MOST_DOWN), MOST_UP);
    levels.push({ clip: one.clip.id, speech, volume_db: gain ?? NaN });
  }
  // Nothing said: the nearest clip of the same file's gain, else as it was.
  levels.forEach((level, index) => {
    if (!Number.isNaN(level.volume_db)) return;
    const own = clips[index]!.clip;
    let best: Levelled | undefined;
    let distance = Infinity;
    levels.forEach((other, at) => {
      const clip = clips[at]!.clip;
      if (other.speech === null || clip.media !== own.media) return;
      const away = Math.min(Math.abs(clip.start - clipEnd(own)), Math.abs(own.start - clipEnd(clip)));
      if (away < distance) [best, distance] = [other, away];
    });
    level.volume_db = best?.volume_db ?? own.volume_db;
  });
  const kept = untouched ? levels.filter((_, index) => clips[index]!.clip.volume_db === 0) : levels;
  return { target: aim, levels: kept.map((level) => ({ ...level, volume_db: f32(level.volume_db) })) };
}

/** Sets `levels` on the live project. */
export async function apply(app: App, projectId: string, levels: Levelled[], origin: string): Promise<void> {
  const gains = new Map(levels.map((level) => [level.clip, level.volume_db]));
  await app.store.update(projectId, origin, (edited) => {
    for (const clip of edited.clips) {
      const gain = gains.get(clip.id);
      if (gain !== undefined && clip.type === "audio") clip.volume_db = gain;
    }
  });
}

/**
 * The audit's footage_quiet / footage_loud: footage speech more than OFF_LU
 * under or over the voice-overs, from what's been measured; what hasn't been
 * yet is measured in the background and counted as pending.
 */
export function issues(app: App, project: Project): { issues: Record<string, unknown>[]; pending: number } {
  const wanted: Stretch[] = [];
  const known = (stretch: Stretch) => {
    const key = keyOf(stretch);
    if (heard.has(key)) return true;
    wanted.push(stretch);
    return false;
  };
  const vo: [number, number][] = [];
  for (const [stretch, gain, length] of voiceovers(project)) {
    if (known(stretch)) {
      const lufs = heard.get(keyOf(stretch));
      if (lufs !== null && lufs !== undefined) vo.push([lufs + gain, length]);
    }
  }
  const fps = fpsOf(project);
  const off: { clip: AudioClip; by: number }[] = [];
  const clips = footage(app, project);
  const level = average(vo);
  for (const one of clips) {
    if (one.speech === null || !known(one.speech) || level === null) continue;
    const lufs = heard.get(keyOf(one.speech));
    if (lufs === null || lufs === undefined) continue;
    off.push({ clip: one.clip, by: lufs + Math.fround(one.clip.volume_db) - level });
  }
  // Music under each narration, over the stretch the narration plays.
  const loud: Record<string, unknown>[] = [];
  const said = project.clips.filter((clip) => clip.type === "audio" && seams.voiceover.isVoiceover(project, clip) && trackOf(project, clip.track)?.muted !== true);
  for (const clip of project.clips) {
    if (clip.type !== "audio" || trackOf(project, clip.track)?.muted === true || seams.voiceover.isVoiceover(project, clip)) continue;
    const media = mediaOf(project, clip.media);
    // Music: the library's (whose folder isSoundEffect also counts) or any sound a song long.
    if (media === undefined || media.kind !== "audio") continue;
    if (!(media.path.includes("/library/music/") || media.duration >= 45)) continue;
    for (const over of said) {
      const [from, to] = [Math.max(clip.start, over.start), Math.min(clipEnd(clip), clipEnd(over))];
      if (to - from < 2 * fps) continue;
      const stretch = { path: media.path, from: clip.source_in + ((from - clip.start) / fps) * clip.speed, seconds: ((to - from) / fps) * clip.speed };
      if (!known(stretch) || level === null) continue;
      const lufs = heard.get(keyOf(stretch));
      if (lufs === null || lufs === undefined) continue;
      const under = level - (lufs + Math.fround(clip.volume_db));
      if (under < MUSIC_CLOSEST) {
        loud.push({
          kind: "music_loud",
          clip: clip.id,
          at: from,
          lu_under_voiceover: Math.round(under * 10) / 10,
          fix: `volume_db ${Math.round((Math.fround(clip.volume_db) - (MUSIC_UNDER - under)) * 10) / 10} (~${MUSIC_UNDER} LU under the narration)`,
        });
        break;
      }
    }
  }
  // An interrogation's bridges: the library's drones are for bodycam at a
  // scene ("this sounds like funeral music… right here, I don't feel it fits
  // in"), its pulsing and high-pace beds for intros.
  if (project.style === "interrogation") {
    // Categories come from the library's listing (read once, then cached).
    const lister = app.library as { list?: (refresh: boolean) => Promise<unknown> };
    void lister.list?.(false).catch(() => {});
    for (const clip of project.clips) {
      if (clip.type !== "audio" || trackOf(project, clip.track)?.muted === true) continue;
      const media = mediaOf(project, clip.media);
      const category = media === undefined ? null : library.categoryOf(media.path);
      if (category === null || !/drones|pulsing|high-pace/iu.test(category)) continue;
      if (!said.some((over) => Math.min(clipEnd(clip), clipEnd(over)) - Math.max(clip.start, over.start) >= 2 * fps)) continue;
      loud.push({
        kind: "music_mood",
        clip: clip.id,
        at: clip.start,
        category,
        fix: "under an interrogation's narration: Investigative (evidence, timelines, background), Low tones (regular narration), Building tension (the build-up before a turn) or Revelation (the reveal)",
      });
    }
  }
  const pending = [...new Set(wanted.map(keyOf))].length;
  if (wanted.length > 0) {
    for (const stretch of wanted) {
      const key = keyOf(stretch);
      if (measuring.has(key)) continue;
      measuring.add(key);
      void measure(stretch)
        .catch((error: unknown) => diag.warn("audio", `footage level: ${diag.messageOf(error)}`))
        .finally(() => measuring.delete(key));
    }
  }
  const found: Record<string, unknown>[] = [];
  for (const [kind, picked] of [
    ["footage_quiet", off.filter((one) => one.by < -OFF_LU)],
    ["footage_loud", off.filter((one) => one.by > OFF_LU)],
  ] as const) {
    if (picked.length === 0) continue;
    const seconds = picked.reduce((sum, one) => sum + one.clip.duration / fps, 0);
    // A stray clip is a moment; a run of them is the mix.
    if (picked.length < 3 && seconds < 10) continue;
    const by = picked.map((one) => one.by).sort((a, b) => a - b);
    found.push({
      kind,
      clips: picked.length,
      seconds: Math.round(seconds),
      typical_lu_from_voiceover: Math.round(by[Math.floor(by.length / 2)]! * 10) / 10,
      first: picked[0]!.clip.id,
      fix: "level_footage",
    });
  }
  return { issues: [...found, ...loud], pending };
}
