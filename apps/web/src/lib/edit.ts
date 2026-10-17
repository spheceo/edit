// Pure timeline operations on an (immer) draft project. They keep the same
// invariants edit-core validates: clips on a track never overlap.

import { current, isDraft } from "immer";

import { isSubtitled } from "./drive";
import { HOUSE_BOX, HOUSE_GLOW, resolvedShake, type Clip, type ClipColor, type Handle, type Keyframe, type Media, type Project, type TextStyle, type Track, type TrackKind } from "./types";

export const freshId = (project: Project, prefix: string) => {
  for (;;) {
    const next = Number.isSafeInteger(project.next_id) && project.next_id > 0 ? project.next_id : 1;
    const id = `${prefix}${next}`;
    project.next_id = next === Number.MAX_SAFE_INTEGER ? 1 : next + 1;
    if (!project.tracks.some(track => track.id === id) && !project.media.some(media => media.id === id) && !project.clips.some(clip => clip.id === id || clip.link === id)) return id;
  }
};

export const clipEnd = (clip: Clip) => clip.start + clip.duration;

/** Deep copy that works on immer drafts too (structuredClone can't clone a Proxy). */
const copyClip = (clip: Clip): Clip => structuredClone(isDraft(clip) ? current(clip) : clip);

export const trackOf = (project: Project, id: string) => project.tracks.find((track) => track.id === id);

export const mediaOf = (project: Project, id: string): Media | undefined => project.media.find((media) => media.id === id);

export const projectDuration = (project: Project) => project.clips.reduce((end, clip) => Math.max(end, clipEnd(clip)), 0);

export function trackLabel(project: Project, track: Track) {
  if (track.subtitles) return "Subs";
  const index = project.tracks.filter((other) => other.kind === track.kind && !other.subtitles).findIndex((other) => other.id === track.id);
  return `${track.kind === "video" ? "V" : "A"}${index + 1}`;
}

/** Adds a track: video on top of the rest, but under the subtitles (as edit-core add_track). */
export function addTrack(project: Project, kind: TrackKind) {
  const id = freshId(project, kind === "video" ? "v" : "a");
  const track: Track = { id, kind, hidden: false, muted: false, locked: false };
  const subtitles = project.tracks.findIndex((candidate) => candidate.subtitles);
  if (kind === "video" && subtitles >= 0) project.tracks.splice(subtitles, 0, track);
  else project.tracks.push(track);
  return id;
}

/** The subtitles' track, made on top of every video track if there isn't one (as edit-core subtitles_track). */
function subtitlesTrack(project: Project) {
  const existing = project.tracks.find((track) => track.subtitles);
  if (existing) return existing.id;
  const id = freshId(project, "v");
  const lastVideo = project.tracks.map((track) => track.kind).lastIndexOf("video");
  project.tracks.splice(lastVideo + 1, 0, { id, kind: "video", hidden: false, muted: false, locked: false, subtitles: true });
  return id;
}

const busy = (project: Project, track: string, start: number, end: number, except?: Set<string>) =>
  project.clips.some((clip) => clip.track === track && !except?.has(clip.id) && clip.start < end && start < clipEnd(clip));

/** The free track `freeTrack` would pick, without adding one (undefined = it would add a track). */
export function peekFreeTrack(project: Project, kind: TrackKind, start: number, end: number, aboveFootage = false) {
  const tracks = project.tracks.filter((track) => track.kind === kind && !track.locked && !track.subtitles).slice(aboveFootage ? 1 : 0);
  return tracks.find((track) => !busy(project, track.id, start, end))?.id;
}

/** Lowest free track of `kind`; graphics skip V1 so they land above footage. Adds a track if needed. */
function freeTrack(project: Project, kind: TrackKind, start: number, end: number, aboveFootage = false) {
  return peekFreeTrack(project, kind, start, end, aboveFootage) ?? addTrack(project, kind);
}

const sourceSpeed = (clip: Clip) => (clip.type === "video" || clip.type === "audio" ? clip.speed : 1);

function shiftKeyframes(clip: Clip, by: number) {
  if (!clip.keyframes || by === 0) return;
  for (const keys of Object.values(clip.keyframes)) for (const key of keys) key.frame -= by;
}

/** Moves a clip's in point by `delta` frames (positive = later), keeping content in place. */
export function trimStart(project: Project, clip: Clip, delta: number) {
  delta = Math.min(delta, clip.duration - 1);
  if (clip.type === "video" || clip.type === "audio") {
    const fps = project.settings.fps;
    const maxBack = Math.floor((clip.source_in * fps) / clip.speed);
    delta = Math.max(delta, -maxBack);
    clip.source_in = Math.max(0, clip.source_in + (delta / fps) * clip.speed);
  }
  delta = Math.max(delta, -clip.start);
  clip.start += delta;
  clip.duration -= delta;
  shiftKeyframes(clip, delta);
}

/** Longest the clip may be given its source. */
export function maxDuration(project: Project, clip: Clip) {
  if (clip.type !== "video" && clip.type !== "audio") return Number.POSITIVE_INFINITY;
  const media = mediaOf(project, clip.media);
  if (!media) return clip.duration;
  return Math.max(1, Math.floor(((media.duration - clip.source_in) / clip.speed) * project.settings.fps));
}

/** Splits `clip` at absolute `frame`; returns the new right-hand clip. */
function splitClip(project: Project, clip: Clip, frame: number, link?: string): Clip | null {
  if (frame <= clip.start || frame >= clipEnd(clip)) return null;
  const offset = frame - clip.start;
  const right = copyClip(clip);
  right.id = freshId(project, "c");
  right.start = frame;
  right.duration = clip.duration - offset;
  right.fade_in = 0;
  if (link !== undefined) right.link = link;
  if (right.type === "video" || right.type === "audio") right.source_in += (offset / project.settings.fps) * sourceSpeed(clip);
  shiftKeyframes(right, offset);
  clip.duration = offset;
  clip.fade_out = 0;
  project.clips.push(right);
  return right;
}

/** Clears [start, end) on `track` (Premiere-style overwrite), except `keep`. */
export function clearRange(project: Project, track: string, start: number, end: number, keep: Set<string>) {
  for (const clip of [...project.clips]) {
    if (clip.track !== track || keep.has(clip.id)) continue;
    const clipStart = clip.start;
    const clipStop = clipEnd(clip);
    if (clipStop <= start || clipStart >= end) continue;
    if (clipStart >= start && clipStop <= end) {
      project.clips = project.clips.filter((other) => other.id !== clip.id);
    } else if (clipStart < start && clipStop > end) {
      const right = splitClip(project, clip, end);
      if (right) clip.duration = start - clipStart;
    } else if (clipStart < start) {
      clip.duration = start - clipStart;
      clip.fade_out = Math.min(clip.fade_out, clip.duration);
    } else {
      trimStart(project, clip, end - clipStart);
    }
  }
}

/** All clip ids in the selection plus their linked partners. */
export function withLinked(project: Project, ids: Iterable<string>) {
  const set = new Set(ids);
  const links = new Set(project.clips.filter((clip) => set.has(clip.id) && clip.link).map((clip) => clip.link!));
  for (const clip of project.clips) if (clip.link && links.has(clip.link)) set.add(clip.id);
  return set;
}

export function deleteClips(project: Project, ids: Iterable<string>) {
  const set = withLinked(project, ids);
  project.clips = project.clips.filter((clip) => !set.has(clip.id));
}

/** Splits every clip under `frame` (or just `only`, with partners). */
export function splitAt(project: Project, frame: number, only?: string[]) {
  const scope = only?.length ? withLinked(project, only) : null;
  const newLinks = new Map<string, string>();
  for (const clip of [...project.clips]) {
    if (scope && !scope.has(clip.id)) continue;
    const track = trackOf(project, clip.track);
    if (track?.locked) continue;
    let link: string | undefined;
    if (clip.link) {
      if (!newLinks.has(clip.link)) newLinks.set(clip.link, freshId(project, "l"));
      link = newLinks.get(clip.link);
    }
    splitClip(project, clip, frame, link);
  }
}

const colorCycle: ClipColor[] = ["blue", "purple", "cyan", "green", "orange", "pink"];

/** Drops a media item at `frame`, overwriting what's under it. Returns the new clip ids. */
export function placeMedia(project: Project, mediaId: string, frame: number, videoTrack?: string): string[] {
  const media = mediaOf(project, mediaId);
  if (!media) return [];
  const fps = project.settings.fps;
  const duration = Math.max(1, Math.floor(media.duration * fps));
  const start = Math.max(0, Math.round(frame));
  const end = start + duration;
  const color = colorCycle[project.clips.length % colorCycle.length];
  const link = media.kind === "video" && media.has_audio ? freshId(project, "l") : undefined;
  const ids: string[] = [];
  const firstOfKind = (kind: TrackKind) => project.tracks.find((track) => track.kind === kind && !track.locked)?.id ?? addTrack(project, kind);
  if (media.kind === "video") {
    const track = videoTrack && trackOf(project, videoTrack)?.kind === "video" ? videoTrack : firstOfKind("video");
    clearRange(project, track, start, end, new Set());
    const id = freshId(project, "c");
    project.clips.push({
      id,
      track,
      start,
      duration,
      color,
      link,
      fade_in: 0,
      fade_out: 0,
      type: "video",
      media: media.id,
      source_in: 0,
      speed: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
      opacity: 1,
    });
    ids.push(id);
  }
  if (media.has_audio) {
    const track = firstOfKind("audio");
    clearRange(project, track, start, end, new Set());
    const id = freshId(project, "c");
    project.clips.push({
      id,
      track,
      start,
      duration,
      color: media.kind === "audio" ? "green" : color,
      link,
      fade_in: 0,
      fade_out: 0,
      type: "audio",
      media: media.id,
      source_in: 0,
      speed: 1,
      volume_db: 0,
    });
    ids.push(id);
  }
  return ids;
}

export type Element = "title" | "caption" | "subtitle" | "cutin" | "adjustment" | "shake" | "flash" | "black" | "waveform";

/** Default length of each element, in seconds. */
export const ELEMENT_SECONDS: Record<Element, number> = {
  title: 4,
  caption: 3,
  subtitle: 3,
  cutin: 3,
  adjustment: 5,
  shake: 0.2,
  flash: 0.4,
  black: 1,
  waveform: 5,
};

/** The cut-in card's words: sized so long narration still fits (edit script.rs `cut_in_style`). */
function cutInStyle(width: number, height: number, text: string): TextStyle {
  const k = height / 1080;
  const maxWidth = width * 0.62;
  const fit = Math.sqrt((0.75 * height * maxWidth) / Math.max(1, [...text].length));
  return {
    font: "Geist",
    weight: 500,
    size: Math.round(Math.min(46 * k, Math.max(22 * k, fit))),
    color: [1, 1, 1, 1],
    tracking: 0,
    line_height: 1.4,
    glow: { ...HOUSE_GLOW, enabled: false },
    max_width: Math.round(maxWidth),
  };
}

/** Adds a generated element at `frame`: on `onTrack` (overwriting), else a free track above the footage. */
export function addElement(project: Project, element: Element, frame: number, onTrack?: string): string {
  const subtitleProject = element === "subtitle" && isSubtitled(project);
  const fps = project.settings.fps;
  const duration = Math.max(1, Math.round(ELEMENT_SECONDS[element] * fps));
  const start = Math.max(0, Math.round(frame));
  let track: string;
  if (element === "subtitle") {
    // Subtitles live on their own track, over everything.
    track = subtitlesTrack(project);
    clearRange(project, track, start, start + duration, new Set());
  } else if (onTrack && trackOf(project, onTrack)?.kind === "video" && !trackOf(project, onTrack)?.subtitles) {
    track = onTrack;
    clearRange(project, track, start, start + duration, new Set());
  } else {
    track = freeTrack(project, "video", start, start + duration, true);
  }
  const id = freshId(project, "c");
  const base = { id, track, start, duration, fade_in: 0, fade_out: 0 };
  const transform = { x: 0, y: 0, scale: 1, rotation: 0 };
  let clip: Clip;
  switch (element) {
    case "title":
      clip = {
        ...base,
        color: "pink",
        type: "text",
        text: "Your title",
        style: {
          font: "Geist",
          weight: 900,
          size: 140,
          color: [1, 1, 1, 1],
          tracking: -2,
          line_height: 1.1,
          glow: { ...HOUSE_GLOW },
        },
        transform,
        animation: { preset: "rise", duration: 14, stagger: 2 },
        opacity: 1,
      };
      break;
    case "caption":
      clip = {
        ...base,
        color: "yellow",
        type: "text",
        text: "Caption",
        style: {
          font: "Geist",
          weight: 700,
          size: 64,
          color: [1, 1, 1, 1],
          tracking: 0,
          line_height: 1.15,
          glow: { ...HOUSE_GLOW },
        },
        transform: { ...transform, y: project.settings.height * 0.32 },
        animation: { preset: "pop", duration: 8, stagger: 1 },
        opacity: 1,
      };
      break;
    case "subtitle": {
      // The subtitle look after the intro (crates/edit/src/captions.rs subtitle_style), authored at 1080p:
      // Edits use a first-name label without glow; subtitle projects use glow without a label.
      const subtitled = subtitleProject;
      const { width, height } = project.settings;
      const k = height / 1080;
      const scaled = <T extends object>(value: T, keys: (keyof T)[]) =>
        Object.fromEntries(Object.entries(value).map(([key, v]) => [key, keys.includes(key as keyof T) ? (v as number) * k : v])) as T;
      const background = { ...scaled(HOUSE_BOX, ["pad_x", "pad_y"]), color: [0, 0, 0, 1] as [number, number, number, number], opacity: subtitled ? 0.75 : 1 };
      clip = {
        ...base,
        color: "cyan",
        type: "text",
        name: "Subtitle · Speaker",
        text: "Subtitle",
        style: {
          font: "Montserrat",
          weight: 600,
          size: 48 * k,
          color: [1, 1, 1, 1],
          tracking: 0,
          line_height: 1.15,
          glow: { ...HOUSE_GLOW, enabled: subtitled, radius: HOUSE_GLOW.radius * k },
          max_width: width * 0.8 - background.pad_x * 2,
          background,
          label: subtitled ? undefined : { text: "Speaker:", color: [1, 0.86, 0.2, 1], size: Math.round(26 * k) },
          shadow: subtitled ? { color: [0, 0, 0, 1], opacity: 0.65, distance: 3 * k, angle: 112, size: 6 * k, blur: 8 * k } : undefined,
        },
        transform: { ...transform, y: height * 0.4 },
        animation: { preset: "none", duration: 0, stagger: 0 },
        opacity: 1,
      };
      break;
    }
    case "cutin": {
      // Repack's cut-in: a black card with the narration on it (crates/edit/src/script.rs lays out the same).
      const { width, height } = project.settings;
      const text = "cut in";
      const link = freshId(project, "l");
      const cardTrack = project.tracks.findIndex((candidate) => candidate.id === track);
      const above = project.tracks.filter((candidate, index) => candidate.kind === "video" && !candidate.locked && index > cardTrack);
      const wordsTrack = above.find((candidate) => !busy(project, candidate.id, start, start + duration))?.id ?? addTrack(project, "video");
      project.clips.push({
        ...base,
        id: freshId(project, "c"),
        track: wordsTrack,
        color: "purple",
        link,
        type: "text",
        text,
        style: cutInStyle(width, height, text),
        transform,
        animation: { preset: "none", duration: 0, stagger: 0 },
        opacity: 1,
      });
      clip = { ...base, color: "purple", name: "Cut-in", link, type: "solid", fill: [0, 0, 0, 1], opacity: 1 };
      break;
    }
    case "adjustment":
      clip = {
        ...base,
        color: "purple",
        type: "adjustment",
        grade: {
          exposure: 0,
          contrast: 0.1,
          saturation: 0.1,
          temperature: 0,
          vignette: 0.25,
        },
        opacity: 1,
      };
      break;
    case "shake":
      clip = {
        ...base,
        color: "orange",
        name: "Shake",
        type: "adjustment",
        grade: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, vignette: 0 },
        shake: { preset: "vertical" },
        opacity: 1,
      };
      break;
    case "flash":
      clip = {
        ...base,
        color: "yellow",
        type: "solid",
        fill: [1, 1, 1, 1],
        opacity: 1,
        fade_out: Math.max(1, duration - 2),
      };
      break;
    case "waveform": {
      // A phone call's look: a dark vignette over the footage (see-through, darker at the edges),
      // the waveform glowing on top (linked).
      const k = project.settings.height / 1080;
      const link = freshId(project, "l");
      const tintTrack = project.tracks.findIndex((candidate) => candidate.id === track);
      const above = project.tracks.filter((candidate, index) => candidate.kind === "video" && !candidate.locked && index > tintTrack);
      const waveTrack = above.find((candidate) => !busy(project, candidate.id, start, start + duration))?.id ?? addTrack(project, "video");
      project.clips.push({
        ...base,
        id: freshId(project, "c"),
        track: waveTrack,
        color: "cyan",
        link,
        type: "waveform",
        style: {
          kind: "line",
          color: [1, 0.03, 0.03, 1],
          bars: 48,
          strands: 2,
          width: 1400 * k,
          height: 360 * k,
          fill: 0.5,
          window: 1.6,
          gain: 1,
          glow: { ...HOUSE_GLOW, radius: HOUSE_GLOW.radius * k },
        },
        transform,
        opacity: 1,
      });
      clip = {
        ...base,
        color: "cyan",
        name: "Dark vignette",
        link,
        type: "adjustment",
        grade: { exposure: -1.9, contrast: 0, saturation: 0, temperature: 0, vignette: 0.9 },
        opacity: 1,
      };
      break;
    }
    case "black":
      clip = {
        ...base,
        color: "red",
        type: "solid",
        fill: [0, 0, 0, 1],
        opacity: 1,
        fade_in: Math.round(duration / 2),
      };
      break;
  }
  project.clips.push(clip);
  return id;
}

// ---------------------------------------------------------------------------
// Parameters and keyframes. Paths match edit-core (e.g. "x", "glow.radius").

type Getter = (clip: Clip) => number;
type Setter = (clip: Clip, value: number) => void;

const params: Record<string, [Getter, Setter]> = {
  opacity: [(c) => ("opacity" in c ? c.opacity : 1), (c, v) => "opacity" in c && (c.opacity = v)],
  x: [(c) => ("transform" in c ? c.transform.x : 0), (c, v) => "transform" in c && (c.transform.x = v)],
  y: [(c) => ("transform" in c ? c.transform.y : 0), (c, v) => "transform" in c && (c.transform.y = v)],
  scale: [(c) => ("transform" in c ? c.transform.scale : 1), (c, v) => "transform" in c && (c.transform.scale = v)],
  rotation: [(c) => ("transform" in c ? c.transform.rotation : 0), (c, v) => "transform" in c && (c.transform.rotation = v)],
  shake: [
    (c) => ("transform" in c ? (c.transform.shake ?? 0) : c.type === "adjustment" ? resolvedShake(c.shake).amount : 0),
    (c, v) => {
      if ("transform" in c) c.transform.shake = v;
      else if (c.type === "adjustment") c.shake = { ...c.shake, amount: v };
    },
  ],
  size: [(c) => (c.type === "text" ? c.style.size : 0), (c, v) => c.type === "text" && (c.style.size = v)],
  tracking: [(c) => (c.type === "text" ? c.style.tracking : 0), (c, v) => c.type === "text" && (c.style.tracking = v)],
  "glow.radius": [
    (c) => (c.type === "text" || c.type === "waveform" ? c.style.glow.radius : 0),
    (c, v) => (c.type === "text" || c.type === "waveform") && (c.style.glow.radius = v),
  ],
  "glow.strength": [
    (c) => (c.type === "text" || c.type === "waveform" ? c.style.glow.strength : 0),
    (c, v) => (c.type === "text" || c.type === "waveform") && (c.style.glow.strength = v),
  ],
  gain: [(c) => (c.type === "waveform" ? c.style.gain : 1), (c, v) => c.type === "waveform" && (c.style.gain = v)],
  volume_db: [(c) => (c.type === "audio" ? c.volume_db : 0), (c, v) => c.type === "audio" && (c.volume_db = v)],
  exposure: [(c) => (c.type === "adjustment" ? c.grade.exposure : 0), (c, v) => c.type === "adjustment" && (c.grade.exposure = v)],
  contrast: [(c) => (c.type === "adjustment" ? c.grade.contrast : 0), (c, v) => c.type === "adjustment" && (c.grade.contrast = v)],
  saturation: [(c) => (c.type === "adjustment" ? c.grade.saturation : 0), (c, v) => c.type === "adjustment" && (c.grade.saturation = v)],
  temperature: [(c) => (c.type === "adjustment" ? c.grade.temperature : 0), (c, v) => c.type === "adjustment" && (c.grade.temperature = v)],
  vignette: [(c) => (c.type === "adjustment" ? c.grade.vignette : 0), (c, v) => c.type === "adjustment" && (c.grade.vignette = v)],
  vignette_x: [(c) => (c.type === "adjustment" ? (c.grade.vignette_x ?? 0) : 0), (c, v) => c.type === "adjustment" && (c.grade.vignette_x = v)],
  vignette_y: [(c) => (c.type === "adjustment" ? (c.grade.vignette_y ?? 0) : 0), (c, v) => c.type === "adjustment" && (c.grade.vignette_y = v)],
  vignette_size: [(c) => (c.type === "adjustment" ? (c.grade.vignette_size ?? 1) : 1), (c, v) => c.type === "adjustment" && (c.grade.vignette_size = v)],
  glitch: [
    (c) => (c.type === "adjustment" ? (c.glitch?.amount ?? 0) : 0),
    (c, v) => c.type === "adjustment" && (c.glitch = { ...c.glitch, amount: v }),
  ],
  blur: [
    (c) => (c.type === "adjustment" ? (c.blur?.radius ?? 0) : 0),
    (c, v) => c.type === "adjustment" && (c.blur = { ...c.blur, radius: v }),
  ],
  "blur.x": [(c) => (c.type === "adjustment" ? (c.blur?.x ?? 0) : 0), (c, v) => c.type === "adjustment" && (c.blur = { radius: 0, ...c.blur, x: v })],
  "blur.y": [(c) => (c.type === "adjustment" ? (c.blur?.y ?? 0) : 0), (c, v) => c.type === "adjustment" && (c.blur = { radius: 0, ...c.blur, y: v })],
  "blur.width": [(c) => (c.type === "adjustment" ? (c.blur?.width ?? 0) : 0), (c, v) => c.type === "adjustment" && (c.blur = { radius: 0, ...c.blur, width: v })],
  "blur.height": [(c) => (c.type === "adjustment" ? (c.blur?.height ?? 0) : 0), (c, v) => c.type === "adjustment" && (c.blur = { radius: 0, ...c.blur, height: v })],
  "leader.x": [(c) => (c.type === "text" ? (c.style.leader?.x ?? 0) : 0), (c, v) => c.type === "text" && c.style.leader && (c.style.leader.x = v)],
  "leader.y": [(c) => (c.type === "text" ? (c.style.leader?.y ?? 0) : 0), (c, v) => c.type === "text" && c.style.leader && (c.style.leader.y = v)],
};

/** Mirrors edit-core::animatable_params. */
function animatableParams(clip: Clip): string[] {
  switch (clip.type) {
    case "video": return ["x", "y", "scale", "rotation", "shake", "opacity"];
    case "text": return ["x", "y", "scale", "rotation", "shake", "opacity", "size", "tracking", "glow.radius", "glow.strength", "leader.x", "leader.y"];
    case "adjustment": return ["shake", "glitch", "exposure", "contrast", "saturation", "temperature", "vignette", "vignette_x", "vignette_y", "vignette_size", "blur", "blur.x", "blur.y", "blur.width", "blur.height", "opacity"];
    case "solid": return ["opacity"];
    case "waveform": return ["x", "y", "scale", "rotation", "opacity", "gain", "glow.radius", "glow.strength"];
    case "audio": return ["volume_db"];
  }
}

type Ease = Keyframe["ease"];

// Keyframe segments are cubic beziers in (frame, value), as in edit-core eval.rs.

/** cubic-bezier(x1, y1, x2, y2) each preset stands for. */
const PRESET_BEZIER: Record<Ease, [number, number, number, number]> = {
  linear: [1 / 3, 1 / 3, 2 / 3, 2 / 3],
  hold: [1 / 3, 1 / 3, 2 / 3, 2 / 3],
  in: [0.32, 0, 0.67, 0],
  out: [0.33, 1, 0.68, 1],
  in_out: [0.65, 0, 0.35, 1],
};

/** The [out, in] handles a preset implies for a segment with this average slope (value per frame). */
export function presetHandles(ease: Ease, slope: number): [Handle, Handle] {
  const [x1, y1, x2, y2] = PRESET_BEZIER[ease];
  return [
    { speed: (slope * y1) / x1, influence: x1 },
    { speed: (slope * (1 - y2)) / (1 - x2), influence: 1 - x2 },
  ];
}

/** The segment's effective [out of `from`, into `to`] handles: explicit, else from `from.ease`. */
export function effectiveHandles(from: Keyframe, to: Keyframe): [Handle, Handle] {
  const span = Math.max(1e-6, to.frame - from.frame);
  const [out, inn] = presetHandles(from.ease, (to.value - from.value) / span);
  return [from.handle_out ?? out, to.handle_in ?? inn];
}

/** The two inner control points as [frame, value] pairs. */
export function controlPoints(from: Keyframe, to: Keyframe): [[number, number], [number, number]] {
  const span = Math.max(1e-6, to.frame - from.frame);
  const [out, inn] = effectiveHandles(from, to);
  const a = Math.min(1, Math.max(0, out.influence));
  const b = Math.min(1, Math.max(0, inn.influence));
  return [
    [from.frame + a * span, from.value + out.speed * a * span],
    [to.frame - b * span, to.value - inn.speed * b * span],
  ];
}

const cubic = (a: number, b: number, c: number, d: number, u: number) => {
  const v = 1 - u;
  return v * v * v * a + 3 * v * v * u * b + 3 * v * u * u * c + u * u * u * d;
};
const cubicSlope = (a: number, b: number, c: number, d: number, u: number) => {
  const v = 1 - u;
  return 3 * v * v * (b - a) + 6 * v * u * (c - b) + 3 * u * u * (d - c);
};

/** Curve parameter at `frame` (frame is monotonic in it); same bisection as edit-core. */
function solve(from: Keyframe, to: Keyframe, p1: number[], p2: number[], frame: number) {
  let lo = 0;
  let hi = 1;
  let u = Math.min(1, Math.max(0, (frame - from.frame) / Math.max(1e-6, to.frame - from.frame)));
  for (let i = 0; i < 30; i++) {
    const at = cubic(from.frame, p1[0], p2[0], to.frame, u);
    if (Math.abs(at - frame) < 1e-4) break;
    if (at < frame) lo = u;
    else hi = u;
    u = 0.5 * (lo + hi);
  }
  return u;
}

/** Speed (value per frame) inside the segment at `frame`. */
export function segmentSpeed(from: Keyframe, to: Keyframe, frame: number): number {
  if (from.ease === "hold") return 0;
  const [p1, p2] = controlPoints(from, to);
  const u = solve(from, to, p1, p2, frame);
  const dx = cubicSlope(from.frame, p1[0], p2[0], to.frame, u);
  const dv = cubicSlope(from.value, p1[1], p2[1], to.value, u);
  // At a zero-influence end dx vanishes; fall back to that end's handle speed.
  if (Math.abs(dx) < 1e-6) return effectiveHandles(from, to)[u < 0.5 ? 0 : 1].speed;
  return dv / dx;
}

/** Same as edit-core `sample`. */
export function sample(keys: Keyframe[], frame: number): number | undefined {
  if (!keys.length) return undefined;
  if (keys.length === 1 || frame <= keys[0].frame) return keys[0].value;
  for (let i = 0; i < keys.length - 1; i++) {
    const from = keys[i];
    const to = keys[i + 1];
    if (frame < to.frame) {
      if (from.ease === "hold") return from.value;
      const [p1, p2] = controlPoints(from, to);
      return cubic(from.value, p1[1], p2[1], to.value, solve(from, to, p1, p2, frame));
    }
  }
  return keys[keys.length - 1].value;
}

export const isAnimated = (clip: Clip, param: string) => (clip.keyframes?.[param]?.length ?? 0) > 0;

/** Value at absolute `frame`, honouring keyframes. */
export function paramAt(clip: Clip, param: string, frame: number) {
  const keys = clip.keyframes?.[param];
  const animated = keys?.length ? sample(keys, frame - clip.start) : undefined;
  return animated ?? params[param]?.[0](clip) ?? 0;
}

/** Writes a value: a keyframe at `frame` when animated, else the base value. */
export function setParam(clip: Clip, param: string, value: number, frame: number) {
  const keys = clip.keyframes?.[param];
  if (keys?.length) {
    const local = Math.round(frame - clip.start);
    const existing = keys.find((key) => Math.abs(key.frame - local) < 0.5);
    if (existing) existing.value = value;
    else {
      keys.push({ frame: local, value, ease: "in_out" });
      keys.sort((a, b) => a.frame - b.frame);
    }
  } else {
    params[param]?.[1](clip, value);
  }
}

/** Toggles animation: on adds a keyframe at `frame`; off bakes the current value. */
export function toggleAnimated(clip: Clip, param: string, frame: number) {
  const current = paramAt(clip, param, frame);
  clip.keyframes ??= {};
  if (isAnimated(clip, param)) {
    delete clip.keyframes[param];
    params[param]?.[1](clip, current);
  } else {
    clip.keyframes[param] = [{ frame: Math.round(frame - clip.start), value: current, ease: "in_out" }];
  }
}

export function keyframeAt(clip: Clip, param: string, frame: number) {
  const local = Math.round(frame - clip.start);
  return clip.keyframes?.[param]?.some((key) => Math.abs(key.frame - local) < 0.5) ?? false;
}

export function toggleKeyframe(clip: Clip, param: string, frame: number) {
  const keys = clip.keyframes?.[param];
  if (!keys) return;
  const local = Math.round(frame - clip.start);
  const index = keys.findIndex((key) => Math.abs(key.frame - local) < 0.5);
  if (index >= 0) {
    if (keys.length > 1) keys.splice(index, 1);
  } else {
    keys.push({
      frame: local,
      value: paramAt(clip, param, frame),
      ease: "in_out",
    });
    keys.sort((a, b) => a.frame - b.frame);
  }
}

// ---------------------------------------------------------------------------
// Context-menu operations.

/** Copies clips (with partners) to just after the selection, overwriting what's there. Returns new ids. */
export function duplicateClips(project: Project, ids: Iterable<string>): string[] {
  const set = withLinked(project, ids);
  const originals = project.clips.filter((clip) => set.has(clip.id));
  if (!originals.length) return [];
  const from = Math.min(...originals.map((clip) => clip.start));
  const to = Math.max(...originals.map(clipEnd));
  const shift = to - from;
  const links = new Map<string, string>();
  const created: Clip[] = [];
  for (const clip of originals) {
    const copy = copyClip(clip);
    copy.id = freshId(project, "c");
    copy.start += shift;
    if (clip.link) {
      if (!links.has(clip.link)) links.set(clip.link, freshId(project, "l"));
      copy.link = links.get(clip.link);
    }
    created.push(copy);
  }
  const keep = new Set(created.map((clip) => clip.id));
  for (const copy of created) clearRange(project, copy.track, copy.start, clipEnd(copy), keep);
  project.clips.push(...created);
  return created.map((clip) => clip.id);
}

/** Deletes clips and closes the gap on their tracks (later clips slide left). */
export function rippleDelete(project: Project, ids: Iterable<string>) {
  const set = withLinked(project, ids);
  const removed = project.clips.filter((clip) => set.has(clip.id));
  project.clips = project.clips.filter((clip) => !set.has(clip.id));
  // Tracks never overlap, so a removed clip leaves an empty span: everything
  // after it on that track slides back by its length. Latest first, so one
  // shift never moves another gap.
  for (const gone of [...removed].sort((a, b) => b.start - a.start)) {
    for (const clip of project.clips) {
      if (clip.track === gone.track && clip.start >= clipEnd(gone)) clip.start -= gone.duration;
    }
  }
}

export const isLinked = (project: Project, ids: Iterable<string>) => project.clips.some((clip) => [...ids].includes(clip.id) && clip.link);

export function unlinkClips(project: Project, ids: Iterable<string>) {
  for (const id of withLinked(project, ids)) {
    const clip = project.clips.find((candidate) => candidate.id === id);
    if (clip) delete clip.link;
  }
}

/** Links picture and sound clips into one group (moves, trims and deletes together). */
export function linkClips(project: Project, ids: Iterable<string>) {
  const set = new Set(ids);
  const link = freshId(project, "l");
  for (const clip of project.clips) if (set.has(clip.id)) clip.link = link;
}

/** Frames from the clip's start to the next clip on its track (Infinity when it's the last). */
function roomAfter(project: Project, clip: Clip) {
  const next = project.clips
    .filter((other) => other.track === clip.track && other.id !== clip.id && other.start >= clip.start)
    .reduce((nearest, other) => Math.min(nearest, other.start), Number.POSITIVE_INFINITY);
  return next - clip.start;
}

/** Longest a clip can be right now: its source, and the next clip on its track. */
export const longest = (project: Project, clip: Clip) => Math.max(1, Math.min(maxDuration(project, clip), roomAfter(project, clip)));

/** Sets the length of clips (and their linked partners), never past a neighbour or the source. */
export function setDuration(project: Project, ids: Iterable<string>, frames: number) {
  for (const id of withLinked(project, ids)) {
    const clip = project.clips.find((candidate) => candidate.id === id);
    if (!clip) continue;
    clip.duration = Math.max(1, Math.min(Math.round(frames), longest(project, clip)));
    clip.fade_in = Math.min(clip.fade_in, clip.duration);
    clip.fade_out = Math.min(clip.fade_out, clip.duration);
  }
}

/**
 * Sets speed on video/audio clips (and partners), keeping the same source
 * span. A slowed clip only grows into empty space; it stops at the next clip.
 */
export function setSpeed(project: Project, ids: Iterable<string>, speed: number) {
  for (const id of withLinked(project, ids)) {
    const clip = project.clips.find((candidate) => candidate.id === id);
    if (!clip || (clip.type !== "video" && clip.type !== "audio")) continue;
    const span = clip.duration * clip.speed;
    clip.speed = speed;
    clip.duration = Math.max(1, Math.min(Math.round(span / speed), longest(project, clip)));
  }
}

/** The checks edit-core's `Project::validate` runs, so a change the server would refuse is never shown. */
export function validateProject(project: Project): string | null {
  const finite = (value: unknown): boolean => typeof value === "number" ? Number.isFinite(value) : value !== null && typeof value === "object" ? Object.values(value).every(finite) : true;
  if (!finite(project)) return `project numbers must be finite`;
  if (!Number.isSafeInteger(project.next_id) || project.next_id < 0) return `next_id must be a nonnegative safe integer`;
  if (![project.settings.width, project.settings.height, project.settings.fps].every((value) => Number.isSafeInteger(value) && value > 0)) return `settings must be positive integers`;
  if (project.settings.width > 8192 || project.settings.height > 8192) return `dimensions must be at most 8192`;
  const marks = [project.mark_in, project.mark_out].filter((mark): mark is number => mark != null);
  if (!marks.every((mark) => Number.isSafeInteger(mark) && mark >= 0)) return `in and out points must be frames from 0`;
  if (project.mark_in != null && project.mark_out != null && project.mark_in > project.mark_out) return `the in point must not come after the out point`;
  const unique = (items: { id: string }[]) => items.every((item) => item.id.length > 0) && new Set(items.map((item) => item.id)).size === items.length;
  if (!unique(project.tracks) || !unique(project.media) || !unique(project.clips)) return `IDs must be nonempty and unique within each collection`;
  if (project.media.some((media) => media.duration < 0 || media.fps < 0 || media.markers?.some((marker) => marker.time < 0))) return `media timing must be nonnegative`;
  if (project.script?.blocks.some((block) => block.kind === "footage" && (!/^[a-zA-Z0-9_-]{1,200}$/.test(block.file) || block.start < 0 || block.end <= block.start))) return `script footage needs a Drive ID and positive source range`;
  const tracks = new Map(project.tracks.map((track) => [track.id, track]));
  const byTrack = new Map<string, Clip[]>();
  for (const clip of project.clips) {
    const track = tracks.get(clip.track);
    if (!track) return `a clip is on a track that no longer exists`;
    if (clip.duration <= 0) return `a clip would have no length`;
    if (![clip.start, clip.duration, clipEnd(clip)].every(Number.isSafeInteger)) return `clip times must be safe integer frames`;
    if (clip.start < 0) return `a clip would start before the beginning`;
    if ((clip.type === "audio") !== (track.kind === "audio")) return `a clip is on the wrong kind of track`;
    if ((clip.type === "video" || clip.type === "audio") && !mediaOf(project, clip.media)) return `a clip's media is missing`;
    if ((clip.type === "video" || clip.type === "audio") && (clip.source_in < 0 || clip.speed < 0.05 || clip.speed > 20)) return `source timing or speed is invalid`;
    if (clip.type === "video" && clip.crop) {
      const { left = 0, right = 0, top = 0, bottom = 0 } = clip.crop;
      if ([left, right, top, bottom].some((side) => !(side >= 0 && side < 1)) || left + right >= 0.99 || top + bottom >= 0.99) return `a crop must leave some of the picture`;
    }
    if (clip.type === "audio" && clip.mutes?.some((mute) => !(Number.isFinite(mute.from) && Number.isFinite(mute.to) && mute.from < mute.to))) return `a mute must run from before it ends`;
    if (clip.type === "solid" && clip.gradient && Math.abs(clip.gradient.from - clip.gradient.to) < 1e-3) return `a gradient's from and to must differ`;
    if (clip.fade_in < 0 || clip.fade_out < 0 || !Number.isSafeInteger(clip.fade_in) || !Number.isSafeInteger(clip.fade_out)) return `fades must be nonnegative integer frames`;
    for (const [param, keys] of Object.entries(clip.keyframes ?? {})) {
      if (!animatableParams(clip).includes(param)) return `a clip cannot animate ${param}`;
      if (!keys.length || keys.some((key, index) => index > 0 && key.frame <= keys[index - 1].frame)) return `keyframes must be in strictly increasing order`;
      if (keys.some((key) => [key.handle_in, key.handle_out].some((handle) => handle && (handle.influence <= 0 || handle.influence > 1)))) return `keyframe handle influence must be in (0, 1]`;
    }
    const clips = byTrack.get(clip.track) ?? [];
    clips.push(clip);
    byTrack.set(clip.track, clips);
  }
  for (const [track, clips] of byTrack) {
    const sorted = [...clips].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start < clipEnd(sorted[i - 1])) return `clips would overlap on ${trackLabel(project, tracks.get(track)!)}`;
    }
  }
  return null;
}

/** Gives each clip a fade in and out of `frames` (0 removes them). */
export function setFades(project: Project, ids: Iterable<string>, frames: number) {
  for (const id of withLinked(project, ids)) {
    const clip = project.clips.find((candidate) => candidate.id === id);
    if (!clip) continue;
    const length = Math.min(frames, Math.floor(clip.duration / 2));
    clip.fade_in = length;
    clip.fade_out = length;
  }
}

/** Marks the source of each selected clip under `frame`; the mark shows on every clip of that media. */
export function addMarker(project: Project, ids: Iterable<string>, frame: number) {
  const fps = project.settings.fps;
  const done = new Set<string>();
  for (const id of ids) {
    const clip = project.clips.find((candidate) => candidate.id === id);
    if (!clip || (clip.type !== "video" && clip.type !== "audio") || frame < clip.start || frame >= clipEnd(clip)) continue;
    const media = project.media.find((candidate) => candidate.id === clip.media);
    if (!media || done.has(media.id)) continue;
    done.add(media.id);
    const time = clip.source_in + ((frame - clip.start) / fps) * clip.speed;
    media.markers = [...(media.markers ?? []).filter((marker) => Math.abs(marker.time - time) > 0.5 / fps), { time, name: "marker" }].sort(
      (a, b) => a.time - b.time,
    );
  }
}

export function clearMarkers(project: Project, ids: Iterable<string>) {
  for (const id of ids) {
    const clip = project.clips.find((candidate) => candidate.id === id);
    if (!clip || (clip.type !== "video" && clip.type !== "audio")) continue;
    const media = project.media.find((candidate) => candidate.id === clip.media);
    if (media) delete media.markers;
  }
}

/** Removes a track when nothing is on it and another of its kind remains. */
export function removeTrack(project: Project, id: string) {
  const track = trackOf(project, id);
  if (!track || project.clips.some((clip) => clip.track === id)) return false;
  if (project.tracks.filter((other) => other.kind === track.kind).length <= 1) return false;
  project.tracks = project.tracks.filter((other) => other.id !== id);
  return true;
}

/** Removes media from the project along with every clip that uses it. */
export function removeMedia(project: Project, id: string) {
  project.clips = project.clips.filter((clip) => !((clip.type === "video" || clip.type === "audio") && clip.media === id));
  project.media = project.media.filter((media) => media.id !== id);
}

/** How the edit uses a media file: clips that play it, and whether the script plays from it. */
export interface MediaUse {
  clips: number;
  script: boolean;
}

export function mediaUses(project: Project): Map<string, MediaUse> {
  const uses = new Map(project.media.map((media) => [media.id, { clips: 0, script: false }]));
  for (const clip of project.clips) {
    if (clip.type === "video" || clip.type === "audio") {
      const use = uses.get(clip.media);
      if (use) use.clips++;
    }
  }
  for (const block of project.script?.blocks ?? []) {
    const use = block.kind === "footage" && block.media ? uses.get(block.media) : undefined;
    if (use) use.script = true;
  }
  return uses;
}

export const isUsed = (use: MediaUse | undefined) => Boolean(use && (use.clips || use.script));

/** Removes media nothing plays (no clips, not linked from the script); returns how many. */
export function removeUnusedMedia(project: Project) {
  const uses = mediaUses(project);
  const before = project.media.length;
  project.media = project.media.filter((media) => isUsed(uses.get(media.id)));
  return before - project.media.length;
}

/** The media bin's folders. Files sort into them by kind; nothing is moved on disk. */
export const MEDIA_FOLDERS = [
  { id: "footage", label: "Footage" },
  { id: "audio", label: "Audio" },
  { id: "sfx", label: "Sound effects" },
  { id: "images", label: "Images" },
] as const;

export type MediaFolder = (typeof MEDIA_FOLDERS)[number]["id"];

export function folderOf(media: Media): MediaFolder {
  if (media.kind === "image") return "images";
  if (media.kind === "audio") return isSoundEffect(media) && !/[\\/]library[\\/]music[\\/]/.test(media.path) ? "sfx" : "audio";
  return "footage";
}

/** Audio this short is a sound effect, not something said (seconds); as Media::is_sound_effect. */
const SOUND_EFFECT_SECONDS = 3;

/** A sound effect (a bundled sound, one from the team's library, or any very short audio): heard, never transcribed. */
export function isSoundEffect(media: Media) {
  // Bundled sounds live in <Edit's home>/sfx (crates/edit/src/sfx.rs), the
  // library's in <Edit's home>/library/<music|sfx>/<checksum> (library.rs).
  return (
    media.kind === "audio" &&
    (media.duration <= SOUND_EFFECT_SECONDS || /[\\/]sfx[\\/][^\\/]+$/.test(media.path) || /[\\/]library[\\/][^\\/]+[\\/][^\\/]+[\\/][^\\/]+$/.test(media.path))
  );
}
