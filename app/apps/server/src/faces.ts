// Subtitles never cover a face. Every subtitle sat bottom middle, and in
// bodycam footage (the camera often looks down at people) the box sat right
// on the speaker's face. Faces are found with Apple's Vision face detector
// on small frames of the light preview, two a second of source, kept per
// file in its cache dir (`faces-v1.json`) so a second run, another project
// using the same footage, or a re-run of add_subtitles reads them back; a
// 30-minute edit is analysed once, in a minute or two, for free. Then each
// subtitle keeps the house place (bottom middle) unless a face seen while
// it's up would be under it: it goes to the first of bottom left, bottom
// right, top middle, top left, top right that's clear of every face (the
// least covered when none is). A subtitle stays where the one just before
// it moved to while the bottom middle is still crowded, so a conversation's
// lines don't jump about. With no face found (none on screen, a redaction
// blur, a non-mac build) subtitles stay bottom middle.
//
// The detector and its cache file are native (`native.facesDetect` /
// `facesCached`, one analysis per file at a time); the placement is here.
// Its arithmetic is f32 (`f32` after every step), as edit-core's would be,
// since the places it picks are saved in the project.

import { captionSize } from "./captions_core.ts";
import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import type { Clip, Project, TextStyle, Transform } from "./model.ts";
import { native, type Box } from "./native/index.ts";
import { components } from "./paths.ts";
import { CAPTION_PREFIX, clipContains, clipEnd, clipOf, fps as fpsOf, mediaOf, sample } from "./project.ts";
import { f32, round, toI64 } from "./rust.ts";
import { boxSize } from "./subtitles.ts";

/** [x0, y0, x1, y1]: shares of the picture from its top left, or project pixels from the frame's centre. */
export type Face = Box;

/** The faces found at each sample index. */
export type Faces = Map<number, Face[]>;

/** Frames looked at per second of source. */
export const RATE = 2.0;
/** Clip names subtitles start with. */
const SUBTITLE = "Subtitle";

/**
 * The faces at `indexes` (source seconds × RATE) of the footage at `source`
 * (`size` its picture size): from its cache, the rest found now (native).
 */
export async function detect(source: string, size: [number, number], indexes: number[]): Promise<Faces> {
  const found = await native().facesDetect(source, size, indexes);
  return toFaces(found);
}

function toFaces(found: Record<number, Box[]>): Faces {
  return new Map(
    Object.entries(found)
      .map(([index, faces]) => [Number(index), faces] as [number, Face[]])
      .sort((a, b) => a[0] - b[0]),
  );
}

/** The faces found in `source` so far, without looking at anything new (the audit). */
export function cached(source: string): Faces | null {
  const found = native().facesCached(source);
  return found === null ? null : toFaces(found);
}

/** A subtitle's place: its centre, project pixels from the frame's centre. */
export interface Spot {
  x: number;
  y: number;
}

function sameSpot(a: Spot, b: Spot): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Room for the speaker's name above a subtitle's box, at 1080p. */
export const LABEL = 44.0;

/** How big a subtitle is: its box (wrapped at its style's width) and its label. */
export function subtitleSize(text: string, style: TextStyle, height: number): [number, number] {
  const k = f32(height / 1080.0);
  const wrap = style.max_width != null ? f32(style.max_width) : f32(1512.0 * k);
  const scale = f32(f32(style.size) / f32(48.0 * k));
  const [w, h] = boxSize(text, f32(wrap / Math.max(scale, f32(0.1))), k);
  const label = style.label != null ? f32(LABEL * k) : 0.0;
  return [f32(w * scale), f32(f32(h * scale) + label)];
}

/**
 * The places a subtitle may sit, in the order they're tried: bottom
 * middle (the house place), bottom left and right, then top middle, left
 * and right (below the band at the top where bodycam stamps sit).
 */
export function spots(size: [number, number], label: number, frame: [number, number]): Spot[] {
  return spotsFrom(size, label, frame, f32(f32(0.4) * frame[1]));
}

/**
 * `spots` with the bottom row's centre at `bottom` (project pixels below
 * the frame's centre): intro captions sit a little higher than subtitles.
 */
function spotsFrom(size: [number, number], label: number, frame: [number, number], bottom: number): Spot[] {
  const [w, h] = size;
  const margin = f32(f32(0.04) * frame[1]);
  const side = Math.max(f32(f32(f32(frame[0] / 2.0) - margin) - f32(w / 2.0)), 0.0);
  // Up top, the label's top sits just under the band where bodycam stamps
  // are; the box (whose centre the transform is) under the label.
  const top = f32(f32(f32(f32(-frame[1] / 2.0) + f32(f32(0.12) * frame[1])) + label) + f32(f32(h - label) / 2.0));
  return [
    { x: 0.0, y: bottom },
    { x: -side, y: bottom },
    { x: side, y: bottom },
    { x: 0.0, y: top },
    { x: -side, y: top },
    { x: side, y: top },
  ];
}

/** What a subtitle at `spot` covers ([x0, y0, x1, y1], its label included). */
export function rect(spot: Spot, [w, h]: [number, number], label: number): Face {
  // The transform is the box's centre; the label rides above it.
  const boxH = f32(h - label);
  return [
    f32(spot.x - f32(w / 2.0)),
    f32(f32(spot.y - f32(boxH / 2.0)) - label),
    f32(spot.x + f32(w / 2.0)),
    f32(spot.y + f32(boxH / 2.0)),
  ];
}

export function overlap(a: Face, b: Face): number {
  const w = Math.max(f32(Math.min(a[2], b[2]) - Math.max(a[0], b[0])), 0.0);
  const h = Math.max(f32(Math.min(a[3], b[3]) - Math.max(a[1], b[1])), 0.0);
  return f32(w * h);
}

/** A face grown to take in the hair, chin and a margin around it. */
export function grown(face: Face): Face {
  const w = f32(face[2] - face[0]);
  const h = f32(face[3] - face[1]);
  return [
    f32(face[0] - f32(f32(0.25) * w)),
    f32(face[1] - f32(f32(0.35) * h)),
    f32(face[2] + f32(f32(0.25) * w)),
    f32(face[3] + f32(f32(0.2) * h)),
  ];
}

/**
 * Where a subtitle of `size` goes, with `faces` ([x0, y0, x1, y1] project
 * pixels from the frame's centre) seen while it's up and `previous` where
 * the line just before it sat (null after a pause or a cut).
 */
export function place(
  size: [number, number],
  frame: [number, number],
  label: number,
  faces: Face[],
  previous: Spot | null,
): Spot {
  return placeAt(size, frame, label, faces, previous, f32(f32(0.4) * frame[1]));
}

/** `place` with no line before it and the house place's centre at `bottom` below the frame's centre (intro captions). */
export function placeFrom(
  size: [number, number],
  frame: [number, number],
  label: number,
  faces: Face[],
  bottom: number,
): [number, number] {
  const spot = placeAt(size, frame, label, faces, null, bottom);
  return [spot.x, spot.y];
}

/** `place` with the house place's centre at `bottom`. */
export function placeAt(
  size: [number, number],
  frame: [number, number],
  label: number,
  given: Face[],
  previous: Spot | null,
  bottom: number,
): Spot {
  const all = spotsFrom(size, label, frame, bottom);
  const faces = given.map(grown);
  const covered = (spot: Spot, slack: number): number => {
    const [x0, y0, x1, y1] = rect(spot, size, label);
    const area: Face = [f32(x0 - slack), f32(y0 - slack), f32(x1 + slack), f32(y1 + slack)];
    return faces.reduce((sum, face) => f32(sum + overlap(area, face)), 0);
  };
  const among = (spot: Spot) => all.some((one) => sameSpot(one, spot));
  const house = all[0]!;
  if (covered(house, 0.0) <= 0.0) {
    // Clear; but a line that follows one moved off a face stays with it
    // while the face is still close by, rather than jumping back and forth.
    const near = f32(f32(0.06) * frame[1]);
    if (
      previous !== null &&
      !sameSpot(previous, house) &&
      among(previous) &&
      covered(previous, 0.0) <= 0.0 &&
      covered(house, near) > 0.0
    ) {
      return previous;
    }
    return house;
  }
  if (previous !== null && !sameSpot(previous, house) && among(previous) && covered(previous, 0.0) <= 0.0) {
    return previous;
  }
  const clear = all.find((spot) => covered(spot, 0.0) <= 0.0);
  if (clear !== undefined) return clear;
  // The least covered; the first of equals (Rust's min_by).
  let best = house;
  let least = Number.POSITIVE_INFINITY;
  for (const spot of all) {
    const amount = covered(spot, 0.0);
    if (amount < least) {
      least = amount;
      best = spot;
    }
  }
  return best;
}

function sameTransform(a: Transform, b: Transform): boolean {
  return (
    f32(a.x) === f32(b.x) &&
    f32(a.y) === f32(b.y) &&
    f32(a.scale) === f32(b.scale) &&
    f32(a.rotation) === f32(b.rotation) &&
    f32(a.shake ?? 0) === f32(b.shake ?? 0)
  );
}

/** Whether a subtitle sits where Edit put it (one of its spots, no keyframes), not moved by hand. */
export function placedByEdit(text: string, style: TextStyle, transform: Transform, frame: [number, number]): boolean {
  const size = subtitleSize(text, style, frame[1]);
  const label = style.label != null ? f32(f32(LABEL * frame[1]) / 1080.0) : 0.0;
  const x = f32(transform.x);
  const y = f32(transform.y);
  return (
    f32(transform.scale) === 1.0 &&
    f32(transform.rotation) === 0.0 &&
    spots(size, label, frame).some((spot) => Math.abs(f32(spot.x - x)) < 0.5 && Math.abs(f32(spot.y - y)) < 0.5)
  );
}

/** The picture under a subtitle: media path, size, the clip's transform, and the sample indexes seen while it's up. */
type Under = [path: string, size: [number, number], transform: Transform, indexes: number[]];

/** One subtitle to place: its clip, size and the footage under it. */
interface Line {
  id: string;
  start: number;
  end: number;
  size: [number, number];
  label: number;
  at: Transform;
  under: Under | null;
}

/** The footage under frame `at`: the topmost visible video clip of a video file. */
export function pictureAt(project: Project, at: number): Clip | null {
  const level = (track: string) => {
    const index = project.tracks.findIndex((own) => own.id === track && !own.hidden && own.subtitles !== true);
    return index < 0 ? null : index;
  };
  let best: [number, Clip] | null = null;
  for (const clip of project.clips) {
    if (!clipContains(clip, at) || clip.type !== "video") continue;
    const here = level(clip.track);
    if (here === null) continue;
    // Rust's max_by_key: the last of equals.
    if (best === null || here >= best[0]) best = [here, clip];
  }
  return best?.[1] ?? null;
}

/** The whole numbers from `from` to `to`, both included. */
function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let index = from; index <= to; index++) out.push(index);
  return out;
}

function noKeyframes(clip: Clip): boolean {
  return Object.keys(clip.keyframes ?? {}).length === 0;
}

/**
 * Moves the edit's subtitles between `from` and `to` (frames) off the
 * faces under them (see the module notes); subtitles moved by hand stay
 * put. Returns how many it looked at and moved.
 */
export async function placeSubtitles(app: App, projectId: string, from: number, to: number): Promise<unknown> {
  const started = performance.now();
  const live = app.store.get(projectId);
  if (live === null) throw new Error("no such project");
  const project = live.project;
  const fps = fpsOf(project);
  const { width, height } = project.settings;
  const frame: [number, number] = [f32(width), f32(height)];
  const k = f32(height / 1080.0);
  const lines: Line[] = [];
  let byHand = 0;
  for (const clip of project.clips) {
    if (clip.type !== "text") continue;
    const { text, style, transform } = clip;
    // The edit's subtitles: speaker-labelled ones (a subtitled video's
    // keep Repack's places).
    if (
      !(clip.name ?? "").startsWith(SUBTITLE) ||
      style.label == null ||
      clip.start >= to ||
      clipEnd(clip) <= from
    ) {
      continue;
    }
    if (!noKeyframes(clip) || !placedByEdit(text, style, transform, [width, height])) {
      byHand += 1;
      continue;
    }
    const middle = clip.start + Math.trunc(clip.duration / 2);
    const picture = pictureAt(project, middle);
    let under: Under | null = null;
    if (picture !== null && picture.type === "video") {
      const media = mediaOf(project, picture.media);
      if (media !== undefined && media.kind === "video") {
        const first = Math.max(clip.start, picture.start);
        const last = Math.max(Math.min(clipEnd(clip), clipEnd(picture)), first + 1);
        const source = (at: number) => picture.source_in + ((at - picture.start) / fps) * picture.speed;
        const [a, b] = [source(first), source(last)];
        under = [media.path, [media.width, media.height], picture.transform, range(toI64(Math.floor(a * RATE)), toI64(Math.ceil(b * RATE)))];
      }
    }
    lines.push({
      id: clip.id,
      start: clip.start,
      end: clipEnd(clip),
      size: subtitleSize(text, style, height),
      label: f32(LABEL * k),
      at: transform,
      under,
    });
  }
  lines.sort((a, b) => a.start - b.start);
  // Each file's samples, found side by side with nothing else (one file at a time).
  const wanted = new Map<string, [[number, number], Set<number>]>();
  for (const line of lines) {
    if (line.under === null) continue;
    const [path, size, , indexes] = line.under;
    let entry = wanted.get(path);
    if (entry === undefined) wanted.set(path, (entry = [size, new Set()]));
    for (const index of indexes) entry[1].add(index);
  }
  const seen = new Map<string, Faces>();
  const failed: string[] = [];
  // In the order of the paths (a BTreeMap of PathBufs: component by component).
  const paths = [...wanted.keys()].sort(comparePaths);
  for (const path of paths) {
    const [size, indexes] = wanted.get(path)!;
    try {
      seen.set(path, await detect(path, size, [...indexes].sort((a, b) => a - b)));
    } catch (error) {
      diag.warn("subtitles", `faces in ${path}: ${diag.messageOf(error)}`);
      failed.push(path);
    }
  }
  // Where each goes, in order, each after the one before.
  const moves: [string, Transform, Spot][] = [];
  let previous: [number, Spot] | null = null;
  let withFaces = 0;
  for (const line of lines) {
    let faces: Face[] = [];
    const under = line.under;
    const found = under === null ? undefined : seen.get(under[0]);
    if (under !== null && found !== undefined) {
      const [, size, transform, indexes] = under;
      const [mw, mh] = [Math.max(size[0], 1), Math.max(size[1], 1)];
      const fit = Math.min(width / mw, height / mh) * f32(transform.scale);
      const toFrame = (x: number, y: number): [number, number] => [
        f32((f32(x) - 0.5) * mw * fit + f32(transform.x)),
        f32((f32(y) - 0.5) * mh * fit + f32(transform.y)),
      ];
      for (const index of indexes) {
        for (const [x0, y0, x1, y1] of found.get(index) ?? []) {
          const [a, b] = [toFrame(x0, y0), toFrame(x1, y1)];
          faces.push([a[0], a[1], b[0], b[1]]);
        }
      }
    }
    if (faces.length > 0) withFaces += 1;
    // The line before counts when it ended within a second of this one.
    const before = previous !== null && line.start - previous[0] <= round(fps) ? previous[1] : null;
    const spot = place(line.size, frame, line.label, faces, before);
    previous = [line.end, spot];
    if (Math.abs(f32(spot.x - f32(line.at.x))) >= 0.5 || Math.abs(f32(spot.y - f32(line.at.y))) >= 0.5) {
      moves.push([line.id, line.at, spot]);
    }
    faces = [];
  }
  const [after, moved] = await app.store.update(projectId, "agent", (edited) => {
    let count = 0;
    for (const [id, was, spot] of moves) {
      const clip = clipOf(edited, id);
      if (clip === undefined || clip.type !== "text") continue;
      // Moved meanwhile (by hand): theirs stands.
      if (sameTransform(clip.transform, was)) {
        clip.transform.x = spot.x;
        clip.transform.y = spot.y;
        count += 1;
      }
    }
    return count;
  });
  const house = f32(f32(0.4) * frame[1]);
  const offHouse = after.project.clips.filter(
    (clip) =>
      (clip.name ?? "").startsWith(SUBTITLE) &&
      clip.start < to &&
      clipEnd(clip) > from &&
      clip.type === "text" &&
      clip.style.label != null &&
      (f32(clip.transform.x) !== 0.0 || Math.abs(f32(f32(clip.transform.y) - house)) >= 0.5),
  ).length;
  diag.record("subtitles", "faces: placed", performance.now() - started, null);
  return {
    rev: after.rev,
    subtitles: lines.length,
    with_a_face_under_them: withFaces,
    moved,
    off_bottom_middle_now: offHouse,
    moved_by_hand_left_alone: byHand,
    footage_not_analysed: failed,
  };
}

/** PathBuf's order: component by component. */
function comparePaths(a: string, b: string): number {
  const [x, y] = [components(a), components(b)];
  for (let index = 0; index < Math.min(x.length, y.length); index++) {
    if (x[index] !== y[index]) return x[index]! < y[index]! ? -1 : 1;
  }
  return x.length - y.length;
}

/**
 * A face at least this tall (share of the picture's height) is clearly
 * visible: smaller ones are people across the room, or not faces at all.
 */
export const CLEAR = f32(0.07);

/** The sample indexes seen between source seconds `a` and `b`. */
export function indexesBetween(a: number, b: number): number[] {
  const [low, high] = [Math.min(a, b), Math.max(a, b)];
  return range(toI64(Math.floor(low * RATE)), toI64(Math.ceil(high * RATE)));
}

/**
 * A face (shares of the picture) in project pixels from the frame's centre,
 * through the footage clip's fit and `transform`.
 */
export function inFrame(media: [number, number], transform: Transform, frame: [number, number], face: Face): Face {
  const [mw, mh] = [Math.max(media[0], 1), Math.max(media[1], 1)];
  const fit = Math.min(frame[0] / mw, frame[1] / mh) * f32(transform.scale);
  const x = (share: number) => f32((f32(share) - 0.5) * mw * fit + f32(transform.x));
  const y = (share: number) => f32((f32(share) - 0.5) * mh * fit + f32(transform.y));
  return [x(face[0]), y(face[1]), x(face[2]), y(face[3])];
}

function centre(face: Face): [number, number] {
  return [f32(f32(face[0] + face[2]) / 2.0), f32(f32(face[1] + face[3]) / 2.0)];
}

function iou(a: Face, b: Face): number {
  const both = overlap(a, b);
  const area = (r: Face) => f32(Math.max(f32(r[2] - r[0]), 0) * Math.max(f32(r[3] - r[1]), 0));
  return f32(both / Math.max(f32(f32(area(a) + area(b)) - both), f32(1e-9)));
}

function distanceOf(a: [number, number], b: [number, number]): number {
  const dx = f32(a[0] - b[0]);
  const dy = f32(a[1] - b[1]);
  return f32(Math.sqrt(f32(f32(dx * dx) + f32(dy * dy))));
}

/**
 * The face in `faces` that `target` (a box drawn around someone) means: the
 * one it overlaps most, else the nearest whose centre is within a face's
 * size of the box's. Null when no face there: a hand, a car, an empty spot.
 */
export function pick(faces: Face[], target: Face): Face | null {
  // The most overlapped; the last of equals (Rust's max_by).
  let overlapping: [number, Face] | null = null;
  for (const face of faces) {
    const share = iou(face, target);
    if (share > 0 && (overlapping === null || share >= overlapping[0])) overlapping = [share, face];
  }
  if (overlapping !== null) return overlapping[1];
  const aim = centre(target);
  // The nearest; the first of equals (Rust's min_by).
  let nearest: [number, Face] | null = null;
  for (const face of faces) {
    const distance = distanceOf(centre(face), aim);
    const size = Math.max(f32(face[2] - face[0]), f32(face[3] - face[1]));
    if (distance <= size && (nearest === null || distance < nearest[0])) nearest = [distance, face];
  }
  return nearest?.[1] ?? null;
}

/**
 * One face followed through `indexes` (sorted) from sample `at`, where it is
 * `start`: at each sample, the face of a like size nearest where it last was
 * (within about its own height); a sample where it isn't found is left out,
 * and after two misses in a row (a second) it's lost that way. No template
 * matching: nothing drifts onto a hand or a wall.
 */
export function follow(found: Faces, indexes: number[], at: number, start: Face): [number, Face][] {
  const step = (from: Face, index: number): Face | null => {
    const here = centre(from);
    const size = Math.max(f32(from[3] - from[1]), f32(1e-3));
    let best: [number, Face] | null = null;
    for (const face of found.get(index) ?? []) {
      const ratio = f32(f32(face[3] - face[1]) / size);
      if (!(ratio >= f32(0.6) && ratio <= f32(1.6))) continue;
      const distance = distanceOf(centre(face), here);
      if (distance > f32(f32(0.9) * size)) continue;
      if (best === null || distance < best[0]) best = [distance, face];
    }
    return best?.[1] ?? null;
  };
  const walk = (order: number[]) => {
    let last = start;
    let misses = 0;
    const got: [number, Face][] = [];
    for (const index of order) {
      const face = step(last, index);
      if (face !== null) {
        last = face;
        misses = 0;
        got.push([index, face]);
      } else {
        misses += 1;
        if (misses > 2) break;
      }
    }
    return got;
  };
  let split = 0;
  while (split < indexes.length && indexes[split]! < at) split += 1;
  const out = [...walk(indexes.slice(0, split).reverse()), ...walk(indexes.slice(split))];
  return out.sort((a, b) => a[0] - b[0]);
}

/**
 * Whether a followed face is clearly visible through `samples` samples:
 * found in at least three in four, and big enough to be someone close by.
 */
export function clearlyVisible(track: [number, Face][], samples: number): boolean {
  if (track.length === 0 || samples === 0) return false;
  const heights = track.map(([, face]) => f32(face[3] - face[1])).sort((a, b) => a - b);
  const middle = heights[Math.floor(heights.length / 2)];
  return track.length * 4 >= samples * 3 && middle !== undefined && middle >= CLEAR;
}

/** Points smoothed (twice 1-2-1), so text pinned to a face glides rather than jitters. */
export function smooth(points: [number, number][]): [number, number][] {
  let out = points.map(([x, y]) => [x, y] as [number, number]);
  for (let pass = 0; pass < 2; pass++) {
    const was = out;
    out = was.map((here, index) => {
      const before = was[index - 1] ?? here;
      const after = was[index + 1] ?? here;
      return [(before[0] + 2.0 * here[0] + after[0]) / 4.0, (before[1] + 2.0 * here[1] + after[1]) / 4.0];
    });
  }
  return out;
}

/**
 * Subtitles and intro captions on someone's face (the audit): each at its
 * middle frame against the faces found there, from the cache only (footage
 * not analysed yet says nothing).
 */
export function textOnFaces(project: Project): unknown[] {
  const fps = fpsOf(project);
  const { width, height } = project.settings;
  const k = f32(height / 1080.0);
  const cache = new Map<string, Faces | null>();
  const out: unknown[] = [];
  for (const clip of project.clips) {
    if (clip.type !== "text") continue;
    const { text, style, transform } = clip;
    const name = clip.name ?? "";
    const subtitle = name.startsWith(SUBTITLE) && style.label != null;
    const caption = name.startsWith(CAPTION_PREFIX);
    if (!subtitle && !caption) continue;
    const middle = clip.start + Math.trunc(clip.duration / 2);
    const picture = pictureAt(project, middle);
    if (picture === null || picture.type !== "video") continue;
    const media = mediaOf(project, picture.media);
    if (media === undefined || media.kind !== "video") continue;
    if (!cache.has(media.path)) cache.set(media.path, cached(media.path));
    const found = cache.get(media.path);
    if (found === null || found === undefined) continue;
    const time = picture.source_in + ((middle - picture.start) / fps) * picture.speed;
    const faces = found.get(toI64(round(time * RATE)));
    if (faces === undefined) continue;
    const local = f32(middle - clip.start);
    const at = (param: string, base: number) => {
      const keys = clip.keyframes?.[param];
      const value = keys === undefined ? null : sample(keys, local);
      return value ?? f32(base);
    };
    const spot: Spot = { x: at("x", transform.x), y: at("y", transform.y) };
    let area: Face;
    if (subtitle) {
      area = rect(spot, subtitleSize(text, style, height), f32(LABEL * k));
    } else {
      const [w, h] = captionSize(text, style);
      area = rect(spot, [f32(w), f32(h)], 0.0);
    }
    const covered = faces.some((given) => {
      const face = inFrame([media.width, media.height], picture.transform, [width, height], given);
      const size = f32(f32(face[2] - face[0]) * f32(face[3] - face[1]));
      return overlap(area, face) > f32(f32(0.1) * size);
    });
    if (covered) {
      out.push({ kind: "text_on_face", clip: clip.id, start: clip.start, fix: caption ? "place_captions" : "place_subtitles" });
    }
  }
  return out;
}

/** How far (seconds of the same file) a face found may stand in for one not looked for: a room's fixed camera. */
const NEAR_FACE = 120;

/**
 * Windows and insets laid over a face (`picture_on_face`): a File Viewer or
 * a photo inset covering the person in the footage beneath it ("nothing
 * covering something else: a window over a face"). Faces come from what's
 * been found so far in that file, the nearest sample within NEAR_FACE
 * seconds (an interrogation room's camera doesn't move).
 */
export function picturesOnFaces(project: Project): unknown[] {
  const fps = fpsOf(project);
  const { width, height } = project.settings;
  const level = (track: string) => project.tracks.findIndex((own) => own.id === track && !own.hidden);
  const designed = (name: string) => name === "File Viewer" || /^Photo inset · /u.test(name);
  const keyAt = (clip: Clip, param: string, local: number, base: number) => {
    const keys = clip.keyframes?.[param];
    return (keys === undefined ? null : sample(keys, local)) ?? base;
  };
  const cache = new Map<string, Faces | null>();
  const out: unknown[] = [];
  for (const clip of project.clips) {
    if (clip.type !== "video" || !designed(clip.name ?? "") || /black and white|· name$/u.test(clip.name ?? "")) continue;
    const own = level(clip.track);
    const media = mediaOf(project, clip.media);
    if (own < 0 || media === undefined) continue;
    const middle = clip.start + Math.trunc(clip.duration / 2);
    const local = middle - clip.start;
    const scale = keyAt(clip, "scale", local, clip.transform.scale);
    const fit = Math.min(width / Math.max(media.width, 1), height / Math.max(media.height, 1)) * scale;
    const [x, y] = [keyAt(clip, "x", local, clip.transform.x), keyAt(clip, "y", local, clip.transform.y)];
    const [w, h] = [media.width * fit, media.height * fit];
    const area: Face = [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
    // The footage beneath it there.
    let under: Extract<Clip, { type: "video" }> | null = null;
    for (const other of project.clips) {
      if (other.type !== "video" || !clipContains(other, middle) || designed(other.name ?? "")) continue;
      const at = level(other.track);
      if (at < 0 || at >= own || mediaOf(project, other.media)?.kind !== "video") continue;
      if (under === null || at >= level(under.track)) under = other;
    }
    if (under === null) continue;
    const footage = mediaOf(project, under.media)!;
    if (!cache.has(footage.path)) cache.set(footage.path, cached(footage.path));
    const found = cache.get(footage.path);
    if (found === null || found === undefined || found.size === 0) continue;
    const time = under.source_in + ((middle - under.start) / fps) * under.speed;
    let best: number | null = null;
    for (const index of found.keys()) if (best === null || Math.abs(index - time * RATE) < Math.abs(best - time * RATE)) best = index;
    if (best === null || Math.abs(best / RATE - time) > NEAR_FACE) continue;
    const local2 = middle - under.start;
    const transform = { ...under.transform, x: keyAt(under, "x", local2, under.transform.x), y: keyAt(under, "y", local2, under.transform.y), scale: keyAt(under, "scale", local2, under.transform.scale) };
    const covered = (found.get(best) ?? []).some((given) => {
      const face = inFrame([footage.width, footage.height], transform, [width, height], given);
      const size = Math.max((face[2] - face[0]) * (face[3] - face[1]), 1);
      return overlap(area, face) > 0.25 * size;
    });
    if (covered) out.push({ kind: "picture_on_face", clip: clip.id, start: clip.start, fix: "move it to the side away from the face (the person questioned stays in view)" });
  }
  return out;
}
