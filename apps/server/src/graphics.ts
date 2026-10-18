// House graphics built in one plan operation, so their look is
// right by construction rather than rebuilt (and drifted) by hand each edit:
// - `date_title`: the date cut-in's date, white with only a drop shadow (an
//   edit came out with a 65% black box and a glow on it).
// - `place_label`: the map's place label, the house label pinned to the building.
// - `evidence_card`: a found photo on screen the house way, never as a bare
//   still (an edit letterboxed a news photo as plain B-roll): the photo framed
//   with a shadow over a dark blurred copy of itself filling the frame, easing
//   in and slowly pushing in, with a clean label under it. cover_cut_in lays
//   every picture shot out this way too.

import { clipFrom } from "./clips.ts";
import type { Clip, Project } from "./model.ts";
import { addTrack, CAPTION_PREFIX, clipEnd, clipOf, fps as fpsOf, freshId, mediaOf, trackOf } from "./project.ts";
import { charCount, display, idiv, round, trim } from "./rust.ts";

type Args = Record<string, unknown>;

const int = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);

/** The house drop shadow under white words on a picture (the date), at 1080p. */
function dateShadow(k: number): Record<string, unknown> {
  return { color: [0, 0, 0, 1], opacity: 1, distance: 6 * k, angle: 112, size: 10 * k, blur: 20 * k };
}

/**
 * The house label (the place label's look): white Geist 600 in an opaque
 * black box with a red border and a soft shadow.
 */
export function labelStyle(k: number): Record<string, unknown> {
  return {
    font: "Geist",
    weight: 600,
    size: round(44 * k),
    color: [1, 1, 1, 1],
    glow: { enabled: false },
    background: { color: [0, 0, 0, 1], opacity: 1, pad_x: 20 * k, pad_y: 12 * k, border: 2 * k, border_color: [1, 0.1, 0.1, 1] },
    shadow: { color: [0, 0, 0, 1], opacity: 0.85, distance: 8 * k, angle: 112, size: 2 * k, blur: 18 * k },
  };
}

function push(project: Project, made: string[], fields: Args): string {
  const id = freshId(project, "c");
  const clip = clipFrom({ ...fields, id });
  project.clips.push(clip);
  made.push(id);
  return id;
}

/** `start`/`end` (or `duration`) of a graphic, frames. */
function span(args: Args, what: string): [number, number] {
  const given = int(args.start);
  if (given === null) throw new Error(`${what} needs start (frames)`);
  const start = Math.max(given, 0);
  const endGiven = int(args.end);
  const duration = int(args.duration);
  let end: number;
  if (endGiven !== null) end = endGiven;
  else if (duration !== null) end = start + duration;
  else throw new Error(`${what} needs end or duration (frames)`);
  if (end - start < 6) throw new Error(`${what} needs at least 6 frames`);
  return [start, end];
}

function textOf(args: Args): string | null {
  if (typeof args.text !== "string") return null;
  const text = trim(args.text);
  return text === "" ? null : text;
}

/**
 * The date cut-in's date, from
 * `{"op":"date_title","text":"July 22, 2023","start":F,"end":F}`: large and
 * centred, white Geist 600 (~120 at 1080p) with only the house drop shadow
 * (no box, no glow), rising in letter by letter and fading out 8 frames
 * before `end`, over an adjustment that darkens the picture beneath it
 * heavily (fading in and out with it; `darken: false` leaves it out). Each on
 * a new track above everything there.
 */
export function dateTitle(project: Project, args: Args): Record<string, unknown> {
  const text = textOf(args);
  if (text === null) throw new Error('date_title needs text ("July 22, 2023")');
  const [start, end] = span(args, "date_title");
  const k = project.settings.height / 1080;
  const made: string[] = [];
  let darken: string | null = null;
  if (typeof args.darken === "boolean" ? args.darken : true) {
    const track = addTrack(project, "video");
    darken = push(project, made, {
      type: "adjustment",
      name: "Date · darken",
      track,
      start,
      duration: end - start,
      fade_in: 6,
      fade_out: 8,
      grade: { exposure: -1.4, saturation: -0.3, vignette: 0.5 },
    });
  }
  const track = addTrack(project, "video");
  const date = push(project, made, {
    type: "text",
    name: "Date",
    track,
    start,
    duration: end - start,
    fade_out: 8,
    text,
    style: {
      font: "Geist",
      weight: 600,
      size: round(120 * k),
      color: [1, 1, 1, 1],
      glow: { enabled: false },
      background: null,
      shadow: dateShadow(k),
    },
    transform: { x: 0, y: 0 },
    animation: { preset: "rise", duration: 14, stagger: 1.5 },
  });
  return { date, darken };
}

/**
 * The map's place label, from `{"op":"place_label","text":"1091 Capitol
 * Avenue","start":F,"end":F,"map":"<the map's clip id>","building_track":[…]}`
 * (map_view's `building_track`, or `building` for a still): the house label
 * with its bottom ~30 px above the building, kept in frame, pinned to it (x
 * and y keyed at every tracked frame, linear), fading in with the marker's
 * reveal and out 8 frames before `end`.
 */
export function placeLabel(project: Project, args: Args): string {
  const text = textOf(args);
  if (text === null) throw new Error("place_label needs text (the street or place, no city or state)");
  const [start, end] = span(args, "place_label");
  const map = typeof args.map === "string" ? clipOf(project, args.map) : undefined;
  if (map === undefined) throw new Error("place_label needs map: the map's clip id");
  if (map.type !== "video") throw new Error("place_label: map must be the map's video clip");
  const [mapStart, sourceIn, speed] = [map.start, map.source_in ?? 0, map.speed ?? 1];
  const fps = fpsOf(project);
  const k = project.settings.height / 1080;
  const [width, height] = [project.settings.width, project.settings.height];
  const trackGiven = Array.isArray(args.building_track) ? (args.building_track as unknown[]) : [];
  const points: unknown[] = trackGiven.length > 0 ? trackGiven : [args.building];
  // The box: one line of 44 px words, 12 px padding above and below.
  const boxW = charCount(text) * 44 * k * 0.56 + 40 * k;
  const boxH = 44 * k * 1.15 + 24 * k;
  const margin = 0.04 * height;
  const keys: [number, number, number][] = [];
  for (const raw of points) {
    const point = (typeof raw === "object" && raw !== null ? raw : {}) as Args;
    const x = num(point.x);
    const top = num(point.top);
    if (x === null || top === null) continue;
    // Footage frame → frames into the label.
    const footage = num(point.frame) ?? 0;
    const at = mapStart + ((footage / fps - sourceIn) / speed) * fps - start;
    const y = Math.max(top - 30 * k - boxH / 2, -height / 2 + margin + boxH / 2);
    const clamped = clamp(x, -width / 2 + margin + boxW / 2, width / 2 - margin - boxW / 2);
    keys.push([at, clamped, y]);
  }
  if (keys.length === 0) throw new Error("place_label needs building_track (or building) from map_view");
  keys.sort((a, b) => a[0] - b[0]);
  const last = end - start - 1;
  // Where it is on its first frame (between the tracked points around it).
  const at = (frame: number): [number, number] => {
    const after = keys.findIndex((key) => key[0] >= frame);
    if (after <= 0) {
      const key = after === -1 ? keys[keys.length - 1] : keys[0];
      return key === undefined ? [0, 0] : [key[1], key[2]];
    }
    const a = keys[after - 1]!;
    const b = keys[after]!;
    const t = (frame - a[0]) / Math.max(b[0] - a[0], 1e-6);
    return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  };
  const [x0, y0] = at(0);
  const xs: Args[] = [{ frame: 0, value: x0, ease: "linear" }];
  const ys: Args[] = [{ frame: 0, value: y0, ease: "linear" }];
  for (const [frame, x, y] of keys.filter((key) => key[0] > 0 && key[0] <= last)) {
    xs.push({ frame, value: x, ease: "linear" });
    ys.push({ frame, value: y, ease: "linear" });
  }
  const track = addTrack(project, "video");
  const made: string[] = [];
  return push(project, made, {
    type: "text",
    name: "Place label",
    track,
    start,
    duration: end - start,
    fade_out: 8,
    text,
    style: labelStyle(k),
    transform: { x: x0, y: y0 },
    keyframes: xs.length > 1 ? { x: xs, y: ys } : {},
    animation: { preset: "fade", duration: 12 },
  });
}

/** Rust's `f64::clamp`, which panics (a bug: a RangeError here) when min > max. */
function clamp(x: number, low: number, high: number): number {
  if (!(low <= high)) {
    throw new RangeError(`min > max, or either was NaN. min = ${debugFloat(low)}, max = ${debugFloat(high)}`);
  }
  return Math.min(Math.max(x, low), high);
}

/** Rust's `{:?}` of an f64 (a point on whole numbers). */
function debugFloat(x: number): string {
  const text = display(x);
  return /[.a-zN]/.test(text) ? text : `${text}.0`;
}

/** Where an evidence card's layers go: each layer's track. */
export interface CardTracks {
  backdrop: string;
  blur: string;
  photo: string;
  label: string;
}

/** Four new tracks on top of everything (tidy_tracks packs them down). */
export function cardTracksOnTop(project: Project): CardTracks {
  return {
    backdrop: addTrack(project, "video"),
    blur: addTrack(project, "video"),
    photo: addTrack(project, "video"),
    label: addTrack(project, "video"),
  };
}

/**
 * An evidence card (see the module notes) of image `mediaId` from `start` to
 * `end`, named "<prefix>…"; returns its clips (backdrop, blur, photo, label).
 */
export function card(
  project: Project,
  mediaId: string,
  [start, end]: [number, number],
  label: string | null,
  tracks: CardTracks,
  prefix: string,
): string[] {
  const media = mediaOf(project, mediaId);
  if (media === undefined) throw new Error(`no media ${mediaId}`);
  if (media.kind !== "image") {
    throw new Error(`${mediaId} isn't a picture: an evidence card is for found photos and stills`);
  }
  const [width, height] = [project.settings.width, project.settings.height];
  const k = height / 1080;
  const [w, h] = [Math.max(media.width, 1), Math.max(media.height, 1)];
  const fit = Math.min(width / w, height / h);
  // The backdrop fills the frame (and a little more, so the blur's edges never show).
  const cover = Math.max(width / (w * fit), height / (h * fit)) * 1.12;
  // The photo: as big as fits in ~68% of the height and ~70% of the width.
  const photo = Math.min((0.68 * height) / (h * fit), (0.7 * width) / (w * fit));
  const duration = end - start;
  const last = Math.max(duration - 1, 1);
  const labelled = label === null ? null : trim(label) === "" ? null : trim(label);
  // Room under the photo for its label.
  const y = labelled !== null ? -0.04 * height : 0;
  const key = (frame: number, value: number, ease: string) => ({ frame, value, ease });
  const settle = Math.min(10, last / 2);
  const made: string[] = [];
  push(project, made, {
    type: "video",
    name: `${prefix}backdrop`,
    track: tracks.backdrop,
    start,
    duration,
    media: mediaId,
    source_in: 0,
    transform: { scale: cover },
    keyframes: { scale: [key(0, cover, "linear"), key(last, cover * 1.04, "linear")] },
  });
  push(project, made, {
    type: "adjustment",
    name: `${prefix}blur`,
    track: tracks.blur,
    start,
    duration,
    blur: { radius: 38 * k },
    grade: { exposure: -1.3, saturation: -0.5, vignette: 0.6 },
  });
  // The photo eases in (a little larger and fading up), then pushes in slowly.
  push(project, made, {
    type: "video",
    name: `${prefix}photo`,
    track: tracks.photo,
    start,
    duration,
    media: mediaId,
    source_in: 0,
    fade_in: 8,
    transform: { scale: photo, y, rotation: -1.2 },
    frame: { width: 14 * k, color: [0.96, 0.96, 0.94, 1], shadow: 0.65 },
    keyframes: {
      scale: [key(0, photo * 0.94, "out"), key(settle, photo, "linear"), key(last, photo * 1.04, "linear")],
    },
  });
  if (labelled !== null) {
    const shown = h * fit * photo;
    const from = Math.min(8, idiv(duration, 3));
    push(project, made, {
      type: "text",
      name: `${prefix}label`,
      track: tracks.label,
      start: start + from,
      duration: duration - from,
      fade_out: 6,
      text: labelled,
      style: labelStyle(k),
      transform: { x: 0, y: y + shown / 2 + 64 * k },
      animation: { preset: "rise", duration: 10, stagger: 1.5 },
    });
  }
  return made;
}

/** `{"op":"evidence_card","media":"m4","start":F,"end":F,"label":"The building"}` on new tracks above everything there. */
export function evidenceCard(project: Project, args: Args): Record<string, unknown> {
  if (typeof args.media !== "string") throw new Error("evidence_card needs media (a picture's media id)");
  const media = args.media;
  const range = span(args, "evidence_card");
  const tracks = cardTracksOnTop(project);
  const made = card(project, media, range, typeof args.label === "string" ? args.label : null, tracks, "Evidence card · ");
  return { clips: made };
}

/**
 * Whether some clip above `clip` (a higher track) on screen with it makes a
 * picture part of a designed graphic: a framed photo (a card or a board), a
 * gradient (the outro's charges, a quote's layout) or a blur.
 */
function designedOver(project: Project, clip: Clip): boolean {
  const level = (track: string) => project.tracks.findIndex((own) => own.id === track);
  const own = level(clip.track);
  return project.clips.some((other) => {
    if (other.id === clip.id || !(level(other.track) > own)) return false;
    if (!(other.start < clipEnd(clip) && clip.start < clipEnd(other))) return false;
    switch (other.type) {
      case "video":
        return other.frame !== undefined && other.frame !== null;
      case "solid":
        return other.gradient !== undefined && other.gradient !== null;
      case "adjustment":
        return (other.blur?.radius ?? 0) > 0;
      default:
        return false;
    }
  });
}

/**
 * Pictures on screen as bare stills (the plan's audit): a found photo or a
 * still with no frame of its own and nothing designed over it, as plain
 * B-roll; `letterboxed` when it doesn't even fill the frame.
 */
export function bareStills(project: Project): Record<string, unknown>[] {
  const [width, height] = [project.settings.width, project.settings.height];
  const out: Record<string, unknown>[] = [];
  for (const clip of project.clips) {
    if (clip.type !== "video" || (clip.frame !== undefined && clip.frame !== null)) continue;
    const media = mediaOf(project, clip.media);
    if (media === undefined || media.kind !== "image") continue;
    const track = trackOf(project, clip.track);
    if (track === undefined || track.hidden || designedOver(project, clip)) continue;
    const [w, h] = [Math.max(media.width, 1), Math.max(media.height, 1)];
    const transform = clip.transform ?? { x: 0, y: 0, scale: 1, rotation: 0 };
    const keys = clip.keyframes?.scale;
    const smallest =
      keys !== undefined && keys.length > 0
        ? keys.map((key) => Math.fround(key.value)).reduce((a, b) => Math.min(a, b))
        : Math.fround(transform.scale ?? 1);
    const scale = smallest * Math.min(width / w, height / h);
    const [halfW, halfH] = [(w * scale) / 2, (h * scale) / 2];
    const letterboxed =
      Math.abs(Math.fround(transform.x ?? 0)) + width / 2 > halfW + 1 ||
      Math.abs(Math.fround(transform.y ?? 0)) + height / 2 > halfH + 1;
    out.push({ kind: "bare_still", clip: clip.id, start: clip.start, media: media.id, letterboxed });
  }
  return out;
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

/**
 * A date shown with a box or a glow (the date cut-in's date is white with
 * only a drop shadow): "July 22, 2023", "March 3rd, 2021".
 */
export function dateDrift(project: Project): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const clip of project.clips) {
    if (clip.type !== "text") continue;
    const style = clip.style;
    const name = clip.name;
    if (
      (style?.label !== undefined && style.label !== null) ||
      (typeof name === "string" && (name.startsWith("Subtitle") || name.startsWith(CAPTION_PREFIX))) ||
      charCount(clip.text) > 32
    ) {
      continue;
    }
    const words = clip.text
      .toLowerCase()
      .split(/[^\p{Alphabetic}\p{N}]/u)
      .filter((word) => word !== "");
    const dated = words.some((word) => MONTHS.includes(word)) && words.some((word) => /^[0-9]{4}$/.test(word));
    const background = style?.background;
    const boxed = background !== undefined && background !== null && (background.opacity ?? 0.75) > 0;
    const glow = style?.glow?.enabled ?? true;
    if (dated && (boxed || glow)) {
      out.push({
        kind: "date_style",
        clip: clip.id,
        start: clip.start,
        boxed,
        glow,
        fix: "white text, drop shadow only: rebuild it with the date_title op",
      });
    }
  }
  return out;
}
