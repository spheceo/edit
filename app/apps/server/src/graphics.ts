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
// - `title_collage`: a compilation's title card (Judge Jester's "When cocky
//   attorneys taunted judges…"): the cases' photos framed in white, a row
//   above and a row below, the title in big glowing capitals between them,
//   over a darkened courtroom.

import * as fs from "node:fs";
import { clipFrom } from "./clips.ts";
import type { Clip, Project } from "./model.ts";
import { addTrack, CAPTION_PREFIX, clipEnd, clipOf, fps as fpsOf, freshId, mediaOf, trackOf } from "./project.ts";
import { withExtension } from "./paths.ts";
import { charCount, display, idiv, round, serdeParse, trim } from "./rust.ts";

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

/**
 * The map's label, as the team's map references have it: white Geist Mono in
 * a black box, no border, typed on ("Custer County Sheriff's Office",
 * "WILDERNESS AREA").
 */
export function mapLabelStyle(k: number): Record<string, unknown> {
  return {
    font: "Geist Mono",
    weight: 600,
    size: round(36 * k),
    color: [1, 1, 1, 1],
    glow: { enabled: true, color: null, radius: 10 * k, strength: 0.25 },
    background: { color: [0, 0, 0, 1], opacity: 0.88, pad_x: 14 * k, pad_y: 7 * k },
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
  const given = textOf(args);
  if (given === null) throw new Error('date_title needs text ("July 22, 2023")');
  const [start, end] = span(args, "date_title");
  const k = project.settings.height / 1080;
  // position "bottom": Red Thread's lower third over its top-down map, the
  // place ("Keller, Texas") over the date in white, smaller, no darkening.
  // An interrogation's dates go at the bottom unless asked to the middle (the
  // team: "We can't really have this text in the middle of the screen").
  const bottom = args.position === "bottom" || (args.position === undefined && project.style === "interrogation");
  const place = typeof args.place === "string" && trim(args.place) !== "" ? trim(args.place) : null;
  const text = place === null ? given : `${place}\n${given}`;
  const made: string[] = [];
  let darken: string | null = null;
  if (typeof args.darken === "boolean" ? args.darken : !bottom) {
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
      size: round((bottom ? 58 : 120) * k),
      color: [1, 1, 1, 1],
      glow: { enabled: false },
      background: null,
      shadow: dateShadow(k),
      ...(place === null ? {} : { line_height: 1.2 }),
    },
    transform: { x: 0, y: bottom ? 0.34 * project.settings.height : 0 },
    animation: { preset: "rise", duration: 14, stagger: 1.5 },
  });
  return { date, darken };
}

/**
 * Where a map's marked building is, from what its page measured: `building`
 * on the first frame and `track` every half second (frame = frames into the
 * footage), in timeline coordinates (pixels from the frame's centre, y down).
 * map_view's `building` and `building_track`.
 */
export function measuredTrack(info: unknown, width: number, height: number, fps: number): { building: Record<string, number> | null; track: Record<string, number>[] } {
  const record = (typeof info === "object" && info !== null ? info : {}) as Record<string, unknown>;
  const placeBox = (bounds: unknown): Record<string, number> | null => {
    if (!Array.isArray(bounds)) return null;
    const [left, top, right, bottom] = [0, 1, 2, 3].map((i) => num(bounds[i])) as (number | null)[];
    if (left == null || top == null || right == null || bottom == null) return null;
    const [halfW, halfH] = [width / 2.0, height / 2.0];
    return {
      x: round((left + right) / 2.0 - halfW),
      top: round(top - halfH),
      bottom: round(bottom - halfH),
      left: round(left - halfW),
      right: round(right - halfW),
    };
  };
  const track: Record<string, number>[] = [];
  if (Array.isArray(record.track)) {
    // Every half second, and the last frame.
    const step = Math.max(Math.floor(fps / 2), 1);
    const last = Math.max(record.track.length - 1, 0);
    (record.track as unknown[]).forEach((bounds, frame) => {
      if (frame % step !== 0 && frame !== last) return;
      const at = placeBox(bounds);
      if (at !== null) track.push({ ...at, frame });
    });
  }
  return { building: track[0] ?? placeBox(record.building), track };
}

/** What a map's page measured (its JSON), and how many of the media's frames each of the map's frames is (a slowed copy plays it longer). */
export interface Measured {
  info: unknown;
  stretch: number;
}

/** A map clip's measured track: from `lookup` (by the render's file name), else the JSON beside its footage (or beside its first frame while it renders); null when this Mac has neither. */
function mapMeasured(project: Project, mediaId: string | undefined, lookup?: (mediaId: string) => Measured | null): Record<string, number>[] | null {
  const media = mediaId === undefined ? undefined : mediaOf(project, mediaId);
  if (media === undefined) return null;
  let info: unknown;
  let stretch = 1;
  const found = lookup?.(media.id) ?? null;
  if (found !== null) [info, stretch] = [found.info, found.stretch];
  else {
    if (typeof media.path !== "string" || media.path === "") return null;
    try {
      info = serdeParse(fs.readFileSync(withExtension(media.path, "json"), "utf8"));
    } catch {
      return null;
    }
  }
  // A first frame (a still) has no rate of its own: the map renders at the project's.
  const { building, track } = measuredTrack(info, project.settings.width, project.settings.height, media.fps || fpsOf(project));
  const stretched = track.map((point) => ({ ...point, frame: Math.round(point.frame! * stretch) }));
  return stretched.length > 0 ? stretched : building !== null ? [building] : null;
}

/**
 * The map's place label, from `{"op":"place_label","text":"1091 Capitol
 * Avenue","start":F,"end":F,"map":"<the map's clip id>","building_track":[…]}`
 * (map_view's `building_track`, or `building` for a still): the house label
 * with its bottom ~30 px above the building, kept in frame, pinned to it (x
 * and y keyed at every tracked frame, linear), fading in with the marker's
 * reveal and out 8 frames before `end`.
 */
export function placeLabel(project: Project, args: Args, lookup?: (mediaId: string) => Measured | null): string {
  const text = textOf(args);
  if (text === null) throw new Error("place_label needs text (the street or place, no city or state)");
  const [start, end] = span(args, "place_label");
  const map = typeof args.map === "string" ? clipOf(project, args.map) : undefined;
  if (map === undefined) throw new Error("place_label needs map: the map's clip id");
  if (map.type !== "video") throw new Error("place_label: map must be the map's video clip");
  const trackGiven = Array.isArray(args.building_track) ? (args.building_track as unknown[]) : [];
  // Given none, the map's own: what its render measured (E2, Oct 31: a label from e-code was refused for want of the track map_view had answered with).
  const points: unknown[] = trackGiven.length > 0 ? trackGiven : args.building !== undefined ? [args.building] : (mapPoints(project, map.media, lookup) ?? []);
  const pinned = pin(project, map, start, end, text, points);
  if (pinned === null) throw new Error("place_label: this map's building track isn't on this Mac; give building_track (or building) from map_view");
  const k = project.settings.height / 1080;
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
    style: mapLabelStyle(k),
    transform: { x: pinned.x, y: pinned.y },
    keyframes: pinned.xs.length > 1 ? { x: pinned.xs, y: pinned.ys } : {},
    animation: { preset: "typewriter", duration: 1, stagger: 1 },
  });
}

/** A map still waiting for its first frame (a dark stand-in, `map-<key>-wait-first.jpg`): its building is taken as the middle of the frame, where the camera aims, until the map is in. */
const WAITING = /-wait-first\.jpg$/u;

/** The points a label on a map is pinned to: its measured track, or the middle while it's still waiting for its first frame; null when this Mac has neither. */
function mapPoints(project: Project, mediaId: string | undefined, lookup?: (mediaId: string) => Measured | null): unknown[] | null {
  const measured = mapMeasured(project, mediaId, lookup);
  if (measured !== null) return measured;
  const path = mediaId === undefined ? undefined : mediaOf(project, mediaId)?.path;
  return typeof path === "string" && WAITING.test(path) ? [{ x: 0, top: Math.round(-0.06 * project.settings.height), frame: 0 }] : null;
}

/**
 * A label's place over its map: just above the building (bottom ~30 px over
 * its top), kept in frame, keyed at every tracked point inside the label
 * (linear). Null when none of the points is usable.
 */
function pin(project: Project, map: Clip, start: number, end: number, text: string, points: unknown[]): { x: number; y: number; xs: Args[]; ys: Args[] } | null {
  if (map.type !== "video") return null;
  const [mapStart, sourceIn, speed] = [map.start, map.source_in ?? 0, map.speed ?? 1];
  const fps = fpsOf(project);
  const k = project.settings.height / 1080;
  const [width, height] = [project.settings.width, project.settings.height];
  // The box: one line of 36 px monospace (0.6 em a character), 7 px padding above and below.
  const boxW = charCount(text) * 36 * k * 0.6 + 28 * k;
  const boxH = 36 * k * 1.15 + 14 * k;
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
  if (keys.length === 0) return null;
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
  return { x: x0, y: y0, xs, ys };
}

/**
 * Pins again every place label over a map of `mediaId` to what its render
 * measured, now that it's in (labels placed while the map waited for its
 * first frame sat over the middle). Returns how many moved.
 */
export function repinPlaceLabels(project: Project, mediaId: string, lookup?: (mediaId: string) => Measured | null): number {
  const points = mapMeasured(project, mediaId, lookup);
  if (points === null) return 0;
  let moved = 0;
  for (const map of project.clips) {
    if (map.type !== "video" || map.media !== mediaId) continue;
    for (const label of project.clips) {
      if (label.type !== "text" || label.name !== "Place label") continue;
      if (label.start >= clipEnd(map) || clipEnd(label) <= map.start) continue;
      const pinned = pin(project, map, label.start, clipEnd(label), label.text, points);
      if (pinned === null) continue;
      label.transform.x = pinned.x;
      label.transform.y = pinned.y;
      label.keyframes = { ...(label.keyframes ?? {}), x: pinned.xs as never, y: pinned.ys as never };
      if (pinned.xs.length <= 1) { delete label.keyframes.x; delete label.keyframes.y; }
      moved++;
    }
  }
  return moved;
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
        // A blur over it, or the film look (grain): a designed graphic.
        return (other.blur?.radius ?? 0) > 0 || (other.grade?.grain ?? 0) > 0;
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
    // A moving map's stand-in (its first frame, or the dark frame before it) is footage on its way, never pushed into.
    if (media === undefined || media.kind !== "image" || /^map-\w+(-wait)?-first\.jpg$/u.test(media.name)) continue;
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

/**
 * A compilation's title card, from `{"op":"title_collage","title":"When…",
 * "photos":["m1",…],"start":F,"end":F,"backdrop":"m9","backdrop_at":12.5}`:
 * 2–6 photos (one per case: the people it's about), each cropped to the same
 * box (~25% of the width, ~37% of the height) and framed in white with a
 * shadow, half in a row above and the rest below, popping in one after
 * another; the title between the rows in white Geist 900 capitals with a
 * soft white glow, rising in after them; over `backdrop` (a courtroom shot:
 * footage from `backdrop_at` seconds, or a picture) darkened and softened
 * with a slow push-in, else a dark wood-brown. Each on a new track above
 * everything there.
 */
export function titleCollage(project: Project, args: Args): Record<string, unknown> {
  const [start, end] = span(args, "title_collage");
  const title = typeof args.title === "string" ? trim(args.title) : "";
  if (title === "") throw new Error("title_collage needs title (the video's title)");
  const photos = Array.isArray(args.photos) ? args.photos.filter((id): id is string => typeof id === "string") : [];
  if (photos.length < 2 || photos.length > 6) throw new Error("title_collage needs photos: 2 to 6 pictures' media ids (one per case)");
  const [width, height] = [project.settings.width, project.settings.height];
  const k = height / 1080;
  const duration = end - start;
  const last = Math.max(duration - 1, 1);
  const key = (frame: number, value: number, ease: string) => ({ frame, value, ease });
  const made: string[] = [];
  // The backdrop: a courtroom, darkened and softened, pushing in slowly.
  const backdrop = typeof args.backdrop === "string" ? args.backdrop : null;
  if (backdrop !== null) {
    const media = mediaOf(project, backdrop);
    if (media === undefined) throw new Error(`no media ${backdrop}`);
    const [w, h] = [Math.max(media.width, 1), Math.max(media.height, 1)];
    const fit = Math.min(width / w, height / h);
    const cover = Math.max(width / (w * fit), height / (h * fit)) * 1.04;
    push(project, made, {
      type: "video",
      name: "Title card · backdrop",
      track: addTrack(project, "video"),
      start,
      duration,
      media: backdrop,
      source_in: Math.max(num(args.backdrop_at) ?? 0, 0),
      speed: media.kind === "image" ? 1 : 0.5,
      transform: { scale: cover },
      keyframes: { scale: [key(0, cover, "linear"), key(last, cover * 1.05, "linear")] },
    });
    push(project, made, {
      type: "adjustment",
      name: "Title card · darken",
      track: addTrack(project, "video"),
      start,
      duration,
      blur: { radius: 6 * k },
      grade: { exposure: -1.5, saturation: -0.25, vignette: 0.55 },
    });
  } else {
    push(project, made, {
      type: "solid",
      name: "Title card · backdrop",
      track: addTrack(project, "video"),
      start,
      duration,
      fill: [0.13, 0.08, 0.06, 1],
    });
  }
  // The photos: the same box each, cropped to it, a row above and a row below.
  const [boxW, boxH] = [0.245 * width, 0.37 * height];
  const top = Math.ceil(photos.length / 2);
  const rows: [string[], number, number][] = [
    [photos.slice(0, top), -0.285 * height, 0.345 * width],
    [photos.slice(top), 0.262 * height, 0.352 * width],
  ];
  let index = 0;
  for (const [row, y, spacing] of rows) {
    row.forEach((mediaId, column) => {
      const media = mediaOf(project, mediaId);
      if (media === undefined) throw new Error(`no media ${mediaId}`);
      if (media.kind !== "image") throw new Error(`${mediaId} isn't a picture: title_collage's photos are pictures (a still_frame for a hearing)`);
      const [w, h] = [Math.max(media.width, 1), Math.max(media.height, 1)];
      const fit = Math.min(width / w, height / h);
      const [box, aspect] = [boxW / boxH, w / h];
      const side = aspect > box ? (1 - box / aspect) / 2 : 0;
      const ends = aspect > box ? 0 : (1 - aspect / box) / 2;
      const scale = boxW / (w * fit * (1 - 2 * side));
      const from = Math.min(index * 4, Math.max(duration - 12, 0));
      index += 1;
      push(project, made, {
        type: "video",
        name: `Title card · photo ${index}`,
        track: addTrack(project, "video"),
        start: start + from,
        duration: duration - from,
        media: mediaId,
        source_in: 0,
        fade_in: 6,
        crop: { left: side, right: side, top: ends, bottom: ends },
        transform: { x: (column - (row.length - 1) / 2) * spacing, y, scale },
        frame: { width: 5 * k, color: [1, 1, 1, 1], shadow: 0.55 },
        keyframes: { scale: [key(0, scale * 0.9, "out"), key(8, scale, "linear"), key(Math.max(last - from, 9), scale * 1.02, "linear")] },
      });
    });
  }
  // The title between the rows, after the photos.
  const from = Math.min(index * 4 + 4, Math.max(duration - 12, 0));
  push(project, made, {
    type: "text",
    name: "Title card · title",
    track: addTrack(project, "video"),
    start: start + from,
    duration: duration - from,
    fade_out: 8,
    text: title,
    style: {
      font: "Geist",
      weight: 900,
      size: round(62 * k),
      color: [1, 1, 1, 1],
      line_height: 1.12,
      max_width: 0.88 * width,
      uppercase: true,
      glow: { enabled: true, color: [1, 1, 1, 1], radius: 28 * k, strength: 0.55 },
    },
    transform: { x: 0, y: -0.012 * height },
    animation: { preset: "rise", duration: 12, stagger: 0.6 },
  });
  return { clips: made };
}
