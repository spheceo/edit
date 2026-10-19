// The small edit-core helpers the server calls per item, in TS rather than
// called across the native boundary (they run in tight loops), plus
// the edit primitives other packages use.
//
// edit-core keeps keyframes in f32; `sample` and its helpers round every step
// to f32 (Math.fround), so they give the same numbers the renderer does.

import type {
  Clip,
  Ease,
  Handle,
  Keyframe,
  Media,
  Mute,
  Project,
  Settings,
  Style,
  Track,
  TrackKind,
} from "./model.ts";

/** Project file format version (edit_core::PROJECT_VERSION). */
export const PROJECT_VERSION = 1;

/** JavaScript's largest safe integer: ids, frames and next_id stay under it. */
const SAFE = 9_007_199_254_740_991;

/** How every speaker caption's clip name starts ("Caption · <who>"). */
export const CAPTION_PREFIX = "Caption · ";

export const DEFAULT_SETTINGS: Settings = { width: 1920, height: 1080, fps: 30 };

/** A new project (Project::new): three video tracks, two audio tracks. */
export function newProject(id: string, name: string, settings: Settings, style: Style = "bodycam"): Project {
  const project: Project = {
    version: PROJECT_VERSION,
    id,
    name,
    style,
    settings: { ...settings },
    media: [],
    tracks: [],
    clips: [],
    next_id: 1,
  };
  for (const kind of ["video", "video", "video", "audio", "audio"] as const) addTrack(project, kind);
  return project;
}

/** An id no track, media, clip or link has yet, `prefix` first (Project::fresh_id). */
export function freshId(project: Project, prefix: string): string {
  for (;;) {
    const next = Math.min(Math.max(project.next_id, 1), SAFE);
    const id = `${prefix}${next}`;
    project.next_id = next === SAFE ? 1 : next + 1;
    if (
      !project.tracks.some((track) => track.id === id) &&
      !project.media.some((media) => media.id === id) &&
      !project.clips.some((clip) => clip.id === id || clip.link === id)
    ) {
      return id;
    }
  }
}

export function addTrack(project: Project, kind: TrackKind): string {
  const id = freshId(project, kind === "video" ? "v" : "a");
  const track: Track = { id, kind, hidden: false, muted: false, locked: false };
  // Video goes on top of the rest, but under the subtitles.
  const at = project.tracks.findIndex((other) => other.subtitles === true);
  if (at >= 0 && kind === "video") project.tracks.splice(at, 0, track);
  else project.tracks.push(track);
  return id;
}

/**
 * Words are never under a blur (the team: "all blurrings must always be
 * under the subtitles"; Mom & Teen's child-privacy blur sat above the intro's
 * captions): every text on screen while a blur on a higher track is up moves
 * onto a track of text just above the highest such blur (one free for its
 * span, else a new one there); a subtitles track moves up whole. Returns how
 * many texts moved.
 */
export function liftTextOverBlurs(project: Project): number {
  const at = (id: string) => project.tracks.findIndex((track) => track.id === id);
  const shown = (id: string) => project.tracks[at(id)]?.hidden !== true;
  const blurs = project.clips.filter(
    (clip) => clip.type === "adjustment" && (clip.blur?.radius ?? 0) > 0 && (clip.opacity ?? 1) > 0 && shown(clip.track),
  );
  if (blurs.length === 0) return 0;
  const overlaps = (a: Clip, b: Clip) => a.start < clipEnd(b) && b.start < clipEnd(a);
  let moved = 0;
  for (const text of project.clips) {
    if (text.type !== "text" || !shown(text.track)) continue;
    const over = blurs.filter((blur) => at(blur.track) > at(text.track) && overlaps(blur, text));
    if (over.length === 0) continue;
    const top = Math.max(...over.map((blur) => at(blur.track)));
    const own = project.tracks[at(text.track)]!;
    if (own.subtitles === true) {
      // The subtitles stay on their track, which goes above the blur.
      project.tracks.splice(at(own.id), 1);
      project.tracks.splice(top, 0, own);
      moved += 1;
      continue;
    }
    const free = project.tracks.slice(top + 1).find(
      (track) =>
        track.kind === "video" &&
        track.subtitles !== true &&
        project.clips.every((clip) => clip.track !== track.id || (clip.type === "text" && !overlaps(clip, text))),
    );
    let target = free?.id;
    if (target === undefined) {
      target = freshId(project, "v");
      project.tracks.splice(top + 1, 0, { id: target, kind: "video", hidden: false, muted: false, locked: false });
    }
    text.track = target;
    moved += 1;
  }
  return moved;
}

/** The subtitles' track, made (on top of every video track) if there isn't one. */
export function subtitlesTrack(project: Project): string {
  const existing = project.tracks.find((track) => track.subtitles === true);
  if (existing !== undefined) return existing.id;
  const id = freshId(project, "v");
  let after = 0;
  project.tracks.forEach((track, index) => {
    if (track.kind === "video") after = index + 1;
  });
  project.tracks.splice(after, 0, { id, kind: "video", hidden: false, muted: false, locked: false, subtitles: true });
  return id;
}

export function trackOf(project: Project, id: string): Track | undefined {
  return project.tracks.find((track) => track.id === id);
}

export function mediaOf(project: Project, id: string): Media | undefined {
  return project.media.find((media) => media.id === id);
}

export function clipOf(project: Project, id: string): Clip | undefined {
  return project.clips.find((clip) => clip.id === id);
}

/** Last frame covered by any clip. */
export function duration(project: Project): number {
  let end = 0;
  for (const clip of project.clips) end = Math.max(end, clipEnd(clip));
  return end;
}

/** Frames per second: `settings.fps`, ×1000/1001 when `settings.ntsc` (edit-core `Project::fps`). */
export function fps(project: Project): number {
  const whole = Math.max(project.settings.fps, 1);
  return project.settings.ntsc === true ? (whole * 1000) / 1001 : whole;
}

/** The rate as people say it: "30", "23.976". */
export function rateText(settings: { fps: number; ntsc?: boolean }): string {
  if (settings.ntsc !== true) return String(settings.fps);
  return (Math.round((settings.fps * 1000 * 1000) / 1001) / 1000).toString();
}

/** One-based display index for a track among tracks of its kind (V1, A2…). */
export function trackLabel(project: Project, id: string): string | null {
  const track = trackOf(project, id);
  if (track === undefined) return null;
  const index = project.tracks.filter((other) => other.kind === track.kind).findIndex((other) => other.id === id);
  if (index < 0) return null;
  return `${track.kind === "video" ? "V" : "A"}${index + 1}`;
}

/**
 * The span between the in and out points as frames [start, end), or null
 * when neither is set. A missing in is the start; a missing out, the end.
 */
export function inOut(project: Project): [number, number] | null {
  const markIn = project.mark_in ?? null;
  const markOut = project.mark_out ?? null;
  if (markIn === null && markOut === null) return null;
  const total = duration(project);
  const start = Math.min(markIn ?? 0, Math.max(total - 1, 0));
  const end = Math.min(markOut === null ? total : markOut + 1, total);
  return end > start ? [start, end] : null;
}

/**
 * Whether frames [start, end) hold anything to subtitle: all of it without
 * segments, else the frames inside footage segments.
 */
export function subtitledSpans(project: Project, start: number, end: number): [number, number][] {
  const segments = project.segments ?? [];
  if (segments.length === 0) return end > start ? [[start, end]] : [];
  return segments
    .filter((segment) => segment.kind === "footage")
    .map((segment): [number, number] => [Math.max(segment.start, start), Math.min(segment.end, end)])
    .filter(([from, to]) => to > from);
}

export function clipEnd(clip: Clip): number {
  return clip.start + clip.duration;
}

export function clipContains(clip: Clip, frame: number): boolean {
  return frame >= clip.start && frame < clipEnd(clip);
}

/**
 * An adjustment or solid that belongs to the cut at `frame` and moves with
 * it: one ending on it (a dip into it) or centred on it (a whip through it).
 */
export function marksCut(clip: Clip, frame: number): boolean {
  return (
    (clip.type === "adjustment" || clip.type === "solid") &&
    (clipEnd(clip) === frame || (clip.start < frame && clip.start + Math.trunc(clip.duration / 2) === frame))
  );
}

/** The media a video or audio clip plays. */
export function clipMedia(clip: Clip): string | null {
  return clip.type === "video" || clip.type === "audio" ? clip.media : null;
}

/** How long a mute takes to fade out and back in, outside its stretch (seconds). */
export const MUTE_FADE_SECONDS = 0.012;

/**
 * The gain a clip's mutes leave at `time` (seconds of the source): 1 away
 * from every mute, 0 inside one, a cosine ramp within MUTE_FADE_SECONDS of one.
 */
export function muteGain(mutes: Mute[], time: number): number {
  return mutes.reduce((gain, mute) => {
    const distance = Math.max(mute.from - time, time - mute.to, 0);
    const ramp = (1 - Math.cos(Math.PI * Math.min(distance / MUTE_FADE_SECONDS, 1))) / 2;
    return Math.min(gain, ramp);
  }, 1);
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** Narration that opens with a date: "On July 13, 2024, …", "In March 2021, …". */
export function isDateCard(text: string): boolean {
  const lower = text.trimStart().toLowerCase();
  let rest: string;
  if (lower.startsWith("on ")) rest = lower.slice(3);
  else if (lower.startsWith("in ")) rest = lower.slice(3);
  else return false;
  return rest
    .split(/\s+/)
    .filter((word) => word !== "")
    .slice(0, 5)
    .some((raw) => {
      const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      const year = word.length === 4 && /^[0-9]{4}$/.test(word) && (word.startsWith("19") || word.startsWith("20"));
      const month = [...word].length >= 3 && MONTHS.some((name) => name.startsWith(word));
      return year || month;
    });
}

/** Audio this short is a sound effect, wherever it came from (edit-core's sections.rs). */
const SOUND_EFFECT_SECONDS = 3.0;

/**
 * A sound effect (a bundled sound, one from the team's library, or any very
 * short audio): it's heard, never transcribed.
 */
export function isSoundEffect(media: Media): boolean {
  return media.kind === "audio" && (media.duration <= SOUND_EFFECT_SECONDS || inSfxFolder(media.path));
}

/**
 * Bundled sounds are written to `<Edit's home>/sfx/`, the team
 * library's sounds and music to `<Edit's home>/library/<music|sfx>/<checksum>/`.
 */
function inSfxFolder(path: string): boolean {
  const parts = path.split(/[/\\]/).reverse().slice(1);
  return parts[0] === "sfx" || parts[2] === "library";
}

// ---------------------------------------------------------------------------
// Keyframes (edit-core's eval.rs), in f32 as edit-core has them.

const f = Math.fround;
const F32_EPSILON = 1.1920929e-7;

/** Value of a keyframe track at `frame`. Holds the first/last value outside the keyed range. */
export function sample(keys: Keyframe[], frame: number): number | null {
  const first = keys[0];
  if (first === undefined) return null;
  const at = f(frame);
  if (keys.length === 1 || at <= f(first.frame)) return f(first.value);
  for (let index = 0; index + 1 < keys.length; index++) {
    const from = keys[index]!;
    const to = keys[index + 1]!;
    if (at < f(to.frame)) {
      if ((from.ease ?? "in_out") === "hold") return f(from.value);
      const [p1, p2] = segmentHandles(from, to);
      return bezierValue(from, to, p1, p2, at);
    }
  }
  return f(keys[keys.length - 1]!.value);
}

/**
 * The two inner control points of the segment `from`→`to` as (frame, value):
 * each end's explicit handle, else the one its `ease` preset implies.
 */
export function segmentHandles(from: Keyframe, to: Keyframe): [[number, number], [number, number]] {
  const span = Math.max(f(f(to.frame) - f(from.frame)), F32_EPSILON);
  const [presetOut, presetIn] = presetHandles(from.ease ?? "in_out", f(f(f(to.value) - f(from.value)) / span));
  const out = from.handle_out ?? presetOut;
  const inn = to.handle_in ?? presetIn;
  const a = Math.min(Math.max(f(out.influence), 0), 1);
  const b = Math.min(Math.max(f(inn.influence), 0), 1);
  return [
    [f(f(from.frame) + f(a * span)), f(f(from.value) + f(f(f(out.speed) * a) * span))],
    [f(f(to.frame) - f(b * span)), f(f(to.value) - f(f(f(inn.speed) * b) * span))],
  ];
}

/**
 * The handles a preset ease stands for, given the segment's average slope
 * (value per frame). Matches the CSS cubic easings.
 */
export function presetHandles(kind: Ease, slope: number): [Handle, Handle] {
  // cubic-bezier(x1, y1, x2, y2) on a unit segment.
  const [x1, y1, x2, y2] = (
    {
      linear: [1 / 3, 1 / 3, 2 / 3, 2 / 3],
      hold: [1 / 3, 1 / 3, 2 / 3, 2 / 3],
      in: [0.32, 0, 0.67, 0],
      out: [0.33, 1, 0.68, 1],
      in_out: [0.65, 0, 0.35, 1],
    } as const
  )[kind].map(f) as [number, number, number, number];
  const s = f(slope);
  return [
    { speed: f(f(s * y1) / x1), influence: x1 },
    { speed: f(f(s * f(1 - y2)) / f(1 - x2)), influence: f(1 - x2) },
  ];
}

/**
 * Value of the cubic through `from`, `p1`, `p2`, `to` at `frame`. Influences
 * in [0, 1] keep frame monotonic in the curve parameter, so solve for it.
 */
function bezierValue(from: Keyframe, to: Keyframe, p1: [number, number], p2: [number, number], frame: number): number {
  const cubic = (a: number, b: number, c: number, d: number, u: number) => {
    const v = f(1 - u);
    const t1 = f(f(f(v * v) * v) * a);
    const t2 = f(f(f(f(3 * v) * v) * u) * b);
    const t3 = f(f(f(f(3 * v) * u) * u) * c);
    const t4 = f(f(f(u * u) * u) * d);
    return f(f(f(t1 + t2) + t3) + t4);
  };
  const fromFrame = f(from.frame);
  const toFrame = f(to.frame);
  const x = (u: number) => cubic(fromFrame, p1[0], p2[0], toFrame, u);
  let lo = 0;
  let hi = 1;
  let u = Math.min(Math.max(f(f(frame - fromFrame) / Math.max(f(toFrame - fromFrame), F32_EPSILON)), 0), 1);
  for (let step = 0; step < 30; step++) {
    const at = x(u);
    if (Math.abs(f(at - frame)) < f(1e-4)) break;
    if (at < frame) lo = u;
    else hi = u;
    u = f(f(0.5) * f(lo + hi));
  }
  return cubic(f(from.value), p1[1], p2[1], f(to.value), u);
}

/** A preset's progress curve, for built-in motion (text animation). */
export function ease(kind: Ease, t: number): number {
  const x = f(t);
  switch (kind) {
    case "linear":
      return x;
    case "in":
      return f(f(x * x) * x);
    case "out": {
      const r = f(1 - x);
      return f(1 - f(f(r * r) * r));
    }
    case "in_out": {
      if (x < 0.5) return f(f(f(f(4 * x) * x) * x));
      const r = f(f(-2 * x) + 2);
      return f(1 - f(f(f(r * r) * r) / 2));
    }
    case "hold":
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Edit primitives other packages share.

/**
 * Moves clips down onto the track below wherever it's empty for the clip's
 * whole span, so nothing floats above a gap; clips that overlap in time keep
 * their order. The first track of each kind (the footage) is left as it is.
 * Then drops tracks left empty. Returns [clips moved, tracks removed].
 */
export function tidyTracks(project: Project): [number, number] {
  let moved = 0;
  for (;;) {
    let changed = false;
    for (const kind of ["video", "audio"] as const) {
      // The subtitles keep their own track: nothing moves onto it or off it.
      const tracks = project.tracks
        .filter((track) => track.kind === kind && track.subtitles !== true)
        .map((track) => [track.id, track.locked, `${track.hidden === true}/${track.muted === true}`] as const);
      // From the second track up, each onto the one below (never into the
      // first), only between tracks shown and heard alike.
      for (let index = 1; index + 1 < tracks.length; index++) {
        const [below, belowLocked, belowState] = tracks[index]!;
        const [here, hereLocked, hereState] = tracks[index + 1]!;
        if (belowLocked || hereLocked || belowState !== hereState) continue;
        const ids = project.clips.filter((clip) => clip.track === here).map((clip) => clip.id);
        for (const id of ids) {
          const clip = clipOf(project, id);
          if (clip === undefined) continue;
          const start = clip.start;
          const end = clipEnd(clip);
          const free = !project.clips.some(
            (other) => other.track === below && other.start < end && start < clipEnd(other),
          );
          if (free) {
            clip.track = below;
            moved += 1;
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }
  const before = project.tracks.length;
  const firsts = (["video", "audio"] as const)
    .map((kind) => project.tracks.find((track) => track.kind === kind)?.id)
    .filter((id): id is string => id !== undefined);
  const used = new Set(project.clips.map((clip) => clip.track));
  project.tracks = project.tracks.filter(
    (track) => firsts.includes(track.id) || used.has(track.id) || track.subtitles === true,
  );
  return [moved, before - project.tracks.length];
}

/**
 * Lowest track of `kind` free over [start, end); adds a track when none is.
 * Text and graphics prefer tracks above the main footage.
 */
export function freeTrack(project: Project, kind: TrackKind, start: number, end: number): string {
  return freeTrackFrom(project, kind, kind === "video" ? 1 : 0, start, end);
}

/** The lowest track of `kind` free for the span, after the first `skip` of them. */
export function freeTrackFrom(project: Project, kind: TrackKind, skip: number, start: number, end: number): string {
  const busy = (track: string) =>
    project.clips.some((clip) => clip.track === track && clip.start < end && start < clipEnd(clip));
  const candidates = project.tracks
    .filter((track) => track.kind === kind && track.subtitles !== true)
    .slice(skip)
    .map((track) => track.id);
  for (const track of candidates) {
    if (!busy(track)) return track;
  }
  return addTrack(project, kind);
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Whether a patch can change whose words a clip is or their colour (a label,
 * a colour, a clip name): then every person gets one colour again.
 */
export function touchesPeople(patch: Record<string, unknown>): boolean {
  if (patch.name !== undefined) return true;
  const style = patch.style;
  return (
    typeof style === "object" &&
    style !== null &&
    ((style as Record<string, unknown>).label !== undefined || (style as Record<string, unknown>).color !== undefined)
  );
}

/**
 * A clip (as JSON) changed by a merge patch. The intro's speaker captions
 * (`caption_speakers`) never carry a name label above them: that's for
 * subtitles only, so a patch giving one a label (a relabel across a speaker's
 * clips, say) leaves it off.
 */
export function mergeClip(clip: Record<string, unknown>, patch: unknown): Record<string, unknown> {
  const merged = merge(clip as Json, patch as Json) as Record<string, unknown>;
  const name = merged.name;
  if (typeof name === "string" && name.startsWith(CAPTION_PREFIX)) {
    const style = merged.style;
    if (typeof style === "object" && style !== null && !Array.isArray(style)) {
      delete (style as Record<string, unknown>).label;
    }
  }
  return merged;
}

/**
 * RFC 7386 JSON merge patch. Objects are changed in place (as serde_json's
 * merge changes its target); the result is returned because a patch that isn't
 * an object replaces the target outright.
 */
export function merge(target: Json, patch: Json): Json {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    return patch === null ? target : patch;
  }
  const object: { [key: string]: Json } =
    typeof target === "object" && target !== null && !Array.isArray(target) ? target : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete object[key];
    else object[key] = merge(object[key] ?? null, value);
  }
  return object;
}
