// A section-sized transaction (edit_plan.rs): resolve references, apply all
// operations, validate once, commit once. Intermediate overlaps are allowed;
// invalid plans save nothing. Its `audit` is the mechanical review the agent
// gets back instead of rendering for everything.

import { clipFrom, keyframesFrom } from "./clips.ts";
import * as cutin from "./cutin.ts";
import * as desktop from "./desktop.ts";
import * as graphics from "./graphics.ts";
import * as markers from "./markers.ts";
import type { Clip, Keyframe, Project } from "./model.ts";
import { native } from "./native/index.ts";
import {
  addTrack,
  clipEnd,
  clipMedia,
  clipOf,
  duration as durationOf,
  fps as fpsOf,
  freeTrack,
  freeTrackFrom,
  freshId,
  mediaOf,
  mergeClip,
  tidyTracks,
  touchesPeople,
  trackOf,
} from "./project.ts";
import { isBug } from "./guard.ts";
import { asInt, compareStrings, f32, idiv, remEuclid, round, trim } from "./rust.ts";
import * as seams from "./seams.ts";
import { HIT } from "./sfx.ts";
import { readStruct, SerdeError, type Struct } from "./serde.ts";
import { compareKeys, stableStringify } from "./stable.ts";

type Args = Record<string, unknown>;
type Json = unknown;

/**
 * What the plan reaches in other packages (WP5's people and faces), through
 * their seams; tests put their own in.
 */
export const hooks = {
  oneColourPerPerson: (project: Project): Json => seams.people.oneColourPerPerson(project),
  textOnFaces: (project: Project): Json[] => seams.faces.textOnFaces(project),
};

export interface Applied {
  results: Json[];
  smooth: string[];
}

/**
 * House pictures and sounds a plan's graphics use, already in the project's
 * media (the caller brings them in before the plan runs, so the plan still
 * saves once): see `needs`.
 */
export interface Assets {
  /** The bundled camera shutter, for evidence boards. */
  shutter: Shutter | null;
  /** The desktop profile's pictures, one set per pair of window titles. */
  desktops: desktop.Art[];
}

export interface Shutter {
  media: string;
  /** Seconds into the file of its click. */
  hit: number;
  /** Puts it ~8 LU under the edit's speech: a texture on each photo, not a hit. */
  volume_db: number;
}

/** What a plan's operations need brought in first. */
export interface Needs {
  shutter: boolean;
  /** [photo viewer title, notepad title] per desktop profile. */
  desktops: [string, string][];
}

export function needs(operations: Json[]): Needs {
  const out: Needs = { shutter: false, desktops: [] };
  for (const raw of operations) {
    const operation = objectOf(raw);
    if (operation.op === "evidence_board" && operation.shutters !== false) out.shutter = true;
    if (operation.op === "desktop_profile") {
      const titles = desktop.titles(operation);
      if (!out.desktops.some(([a, b]) => a === titles[0] && b === titles[1])) out.desktops.push(titles);
    }
  }
  return out;
}

const objectOf = (value: unknown): Args =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Args) : {};
const int = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** A plan with no house assets (tests). */
export function apply(project: Project, operations: Json[]): Applied {
  return applyWith(project, operations, { shutter: null, desktops: [] });
}

/** Applies every operation to `project` (changed in place), then validates it once. Throws what failed. */
export function applyWith(project: Project, operations: Json[], assets: Assets): Applied {
  if (operations.length === 0 || operations.length > 2000) throw new Error("give 1 to 2000 operations");
  const refs = new Map<string, Json>();
  const results: Json[] = [];
  const smooth: string[] = [];
  operations.forEach((original, index) => {
    let result: Json;
    try {
      // Only operation arguments are references: literal caption text such as
      // "$100" is never interpreted as a reference. Use {"$ref":"hero"}.
      const operation = resolve(structuredClone(original), refs);
      result = operationOn(project, objectOf(operation), smooth, assets);
      const alias = objectOf(operation).as;
      if (typeof alias === "string") {
        if (alias === "" || refs.has(alias)) throw new Error(`duplicate or empty alias ${alias}`);
        refs.set(alias, result);
      }
    } catch (error) {
      if (isBug(error)) throw error;
      throw new Error(`operation ${index + 1}: ${messageOf(error)}; nothing saved`);
    }
    results.push(result);
  });
  // Text placed or relabelled (a quote, a caption's speaker): one colour per
  // person across the video, as add_subtitles leaves it.
  if (
    operations.some((raw) => {
      const operation = objectOf(raw);
      return (
        (operation.op === "add" && objectOf(operation.clip).type === "text") ||
        (operation.op === "update" && touchesPeople(objectOf(operation.patch)))
      );
    })
  ) {
    hooks.oneColourPerPerson(project);
  }
  const invalid = native().projectValidate(JSON.stringify(project));
  if (invalid !== null) throw new Error(`final plan is invalid: ${invalid}; nothing saved`);
  return { results, smooth };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `{"$ref":"name/pointer"}` replaced by what that alias's operation returned. */
function resolve(value: Json, refs: Map<string, Json>): Json {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const fields = value as Args;
    const keys = Object.keys(fields);
    if (keys.length === 1 && typeof fields.$ref === "string") {
      const reference = fields.$ref;
      const slash = reference.indexOf("/");
      const [name, pointer] = slash < 0 ? [reference, ""] : [reference.slice(0, slash), `/${reference.slice(slash + 1)}`];
      const found = refs.has(name) ? pointerOf(refs.get(name), pointer) : undefined;
      if (found === undefined) throw new Error(`unknown reference ${reference}; use an earlier operation's alias`);
      return structuredClone(found);
    }
    for (const key of keys) fields[key] = resolve(fields[key], refs);
    return fields;
  }
  if (Array.isArray(value)) return value.map((item) => resolve(item, refs));
  return value;
}

/** serde_json's `Value::pointer` (RFC 6901). */
export function pointerOf(value: Json, pointer: string): Json | undefined {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) return undefined;
  let here: Json = value;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(here)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
      here = here[Number(token)];
    } else if (typeof here === "object" && here !== null) {
      here = Object.prototype.hasOwnProperty.call(here, token) ? (here as Args)[token] : undefined;
    } else {
      return undefined;
    }
    if (here === undefined) return undefined;
  }
  return here;
}

function clipOrSay(fields: Args, prefix: string): Clip {
  try {
    return clipFrom(fields);
  } catch (error) {
    if (error instanceof SerdeError) throw new Error(`${prefix}${error.message}`);
    throw error;
  }
}

function operationOn(project: Project, args: Args, smooth: string[], assets: Assets): Json {
  const op = str(args.op);
  if (op === null) throw new Error("op is required");
  switch (op) {
    case "add": {
      const given = args.clip;
      if (typeof given !== "object" || given === null || Array.isArray(given)) throw new Error("clip must be an object");
      const fields = { ...(given as Args) };
      const id = str(fields.id) ?? freshId(project, "c");
      if (clipOf(project, id) !== undefined) throw new Error(`clip ${id} already exists; use update`);
      fields.id = id;
      const kind = fields.type === "audio" ? "audio" : "video";
      // No silent defaults: a clip at frame 0 for one frame is never meant.
      const start = int(fields.start);
      if (start === null) throw new Error("clip.start is required (frames)");
      const length = int(fields.duration);
      if (length === null) throw new Error("clip.duration is required (frames)");
      const end = start + length;
      const track = str(fields.track);
      if (track === "new") fields.track = addTrack(project, kind);
      else if (track === null) fields.track = freeTrack(project, kind, start, end);
      project.clips.push(clipOrSay(fields, "clip: "));
      return id;
    }
    case "update": {
      const ids = selected(project, args.select);
      const given = args.patch;
      if (typeof given !== "object" || given === null || Array.isArray(given)) throw new Error("patch must be an object");
      const patch = { ...(given as Args) };
      // {track: "new"} moves the clips onto a new track of their kind, as add does.
      if (patch.track === "new") {
        const audio = project.clips.find((clip) => ids.includes(clip.id))?.type === "audio";
        patch.track = addTrack(project, audio ? "audio" : "video");
      }
      // Moving or trimming one half of a linked pair moves the other half
      // with it (unless both are selected), as in the timeline.
      const moved: [string, number, number, number][] = [];
      project.clips = project.clips.map((clip) => {
        if (!ids.includes(clip.id)) return clip;
        const [start, duration] = [clip.start, clip.duration];
        const value = mergeClip(structuredClone(clip) as unknown as Args, structuredClone(patch));
        value.id = clip.id;
        const next = clipOrSay(value, "clip: ");
        if (next.link !== undefined && next.link !== null && (next.start !== start || next.duration !== duration)) {
          moved.push([next.link, next.start - start, duration, next.duration]);
        }
        return next;
      });
      const partners: string[] = [];
      if (args.unlinked !== true) {
        for (const [link, shift, before, after] of moved) {
          for (const clip of project.clips) {
            if (clip.link !== link || ids.includes(clip.id)) continue;
            clip.start += shift;
            if (clip.duration === before) clip.duration = after;
            partners.push(clip.id);
          }
        }
      }
      return { clips: ids, linked_moved: partners };
    }
    case "delete": {
      const ids = new Set(selected(project, args.select));
      // A linked pair goes together unless asked otherwise.
      if (args.unlinked !== true) {
        const links = new Set(
          project.clips.filter((clip) => ids.has(clip.id) && typeof clip.link === "string").map((clip) => clip.link!),
        );
        for (const clip of project.clips) if (typeof clip.link === "string" && links.has(clip.link)) ids.add(clip.id);
      }
      project.clips = project.clips.filter((clip) => !ids.has(clip.id));
      return { clips: [...ids].sort(compareStrings) };
    }
    case "keyframes": {
      const ids = selected(project, args.select);
      const param = str(args.param);
      if (param === null) throw new Error("param is required");
      let keys: Keyframe[];
      try {
        keys = keyframesFrom(args.keyframes ?? null);
      } catch (error) {
        if (error instanceof SerdeError) throw new Error(`keyframes: ${error.message}`);
        throw error;
      }
      keys = [...keys].sort((a, b) => a.frame - b.frame);
      // Two keys on one frame: the later one given wins.
      keys.reverse();
      keys = keys.filter((key, index) => index === 0 || key.frame !== keys[index - 1]!.frame);
      keys.reverse();
      const params = native().animatableParams();
      for (const clip of project.clips) {
        if (!ids.includes(clip.id)) continue;
        if (!(params[clip.type] ?? []).includes(param)) throw new Error(`${param} is not animatable on ${clip.id}`);
        const own = { ...(clip.keyframes ?? {}) };
        if (keys.length === 0) delete own[param];
        else own[param] = structuredClone(keys);
        setKeyframes(clip, own);
      }
      return { clips: ids };
    }
    case "cover_cut_in": {
      const [report, pending] = cutin.cover(project, args);
      smooth.push(...pending);
      return report;
    }
    case "tidy_tracks": {
      const [moved, removed] = tidyTracks(project);
      return { moved, removed_tracks: removed };
    }
    case "transition":
      return transition(project, args);
    case "evidence_board":
      return evidenceBoard(project, args, assets.shutter);
    case "desktop_profile": {
      const [photoTitle, notepadTitle] = desktop.titles(args);
      const art = assets.desktops.find((art) => art.photo_title === photoTitle && art.notepad_title === notepadTitle);
      if (art === undefined) {
        throw new Error("desktop_profile's pictures weren't prepared (run it through apply_edit_plan)");
      }
      return desktop.profile(project, args, art);
    }
    case "evidence_card":
      return graphics.evidenceCard(project, args);
    case "date_title":
      return graphics.dateTitle(project, args);
    case "place_label":
      return graphics.placeLabel(project, args);
    case "markers":
      return markers.edit(project, args);
    default:
      throw new Error(
        `unknown op ${op}; use add, update, delete, keyframes, cover_cut_in, transition, evidence_board, evidence_card, date_title, place_label, desktop_profile, markers, tidy_tracks`,
      );
  }
}

/** A clip's keyframes, in serde's shape: sorted by param, left out when there are none. */
export function setKeyframes(clip: Clip, keyframes: Record<string, Keyframe[]>): void {
  const sorted = Object.keys(keyframes).sort(compareKeys);
  if (sorted.length === 0) {
    delete clip.keyframes;
    return;
  }
  clip.keyframes = Object.fromEntries(sorted.map((param) => [param, keyframes[param]!]));
}

/**
 * A house transition at a cut, built the way the house style describes it,
 * so a plan says `{"op":"transition","kind":"dip","at":1234}` instead of a
 * clip and its keyframes for every cut. On a new track above everything
 * there; tidy_tracks packs them down afterwards.
 * - drop: the vertical slam, an adjustment 6 frames straddling the cut.
 * - flash: white, 6 frames centred on the cut, fading out (with a shutter).
 * - dip: to black and straight back, `frames` long (12) centred on the cut.
 * - open: the reverse dip that opens the video, black fading out over ~0.5 s.
 */
function transition(project: Project, args: Args): Json {
  const kind = str(args.kind);
  if (kind === null) throw new Error("transition needs kind: drop, flash, dip or open");
  const at = int(args.at);
  const cut = () => {
    if (at === null) throw new Error(`a ${kind} needs at (the cut's frame)`);
    return at;
  };
  const key = (frame: number, value: number, ease: string) => ({ frame, value, ease });
  let name: string;
  let start: number;
  let length: number;
  let content: Args;
  let opacity: Args[] | null;
  switch (kind) {
    case "drop":
      [name, start, length, content, opacity] = ["Drop", cut() - 3, 6, { type: "adjustment", shake: { preset: "vertical" } }, null];
      break;
    case "flash":
      [name, start, length, content, opacity] = [
        "Flash",
        cut() - 3,
        6,
        { type: "solid", fill: [1, 1, 1, 1] },
        [key(0, 1, "out"), key(5, 0, "linear")],
      ];
      break;
    case "dip": {
      const frames = Math.min(Math.max(int(args.frames) ?? 12, 4), 60);
      [name, start, length, content, opacity] = [
        "Dip",
        cut() - idiv(frames, 2),
        frames,
        { type: "solid", fill: [0, 0, 0, 1] },
        [key(0, 0, "in_out"), key(idiv(frames, 2), 1, "in_out"), key(frames - 1, 0, "linear")],
      ];
      break;
    }
    case "open": {
      const frames = Math.max(asInt(round(fpsOf(project) * 0.5)), 2);
      [name, start, length, content, opacity] = [
        "Opening dip",
        0,
        frames,
        { type: "solid", fill: [0, 0, 0, 1] },
        [key(0, 1, "linear"), key(frames - 1, 0, "linear")],
      ];
      break;
    }
    default:
      throw new Error(`unknown transition ${kind}; use drop, flash, dip or open`);
  }
  // Never before the start of the video: what's cut off the front goes.
  const [from, frames] = [Math.max(start, 0), length - Math.max(-start, 0)];
  const id = freshId(project, "c");
  const track = addTrack(project, "video");
  const fields: Args = { ...content, id, name, track, start: from, duration: frames };
  if (opacity !== null) fields.keyframes = { opacity };
  project.clips.push(clipOrSay(fields, `${kind}: `));
  return id;
}

// ---------------------------------------------------------------------------
// The evidence board

/** The evidence board's glide between photos (frames) in the old `frames`/`pan` timing, unless told otherwise. */
const BOARD_PAN = 30;
/**
 * How fast the camera passes each photo: this share of its average speed on
 * the way in and out. It eases a little to show each photo and picks up
 * between them (peaking ~1.25x the average); it never stops.
 */
const BOARD_PASS = 0.7;
/** The camera picks up speed into the first photo over the whole way in (at most this many frames, a slow drift before that)... */
const BOARD_LEAD = 45;
/**
 * ...from at most this share of the frame's height before it, so the photo is
 * rising into the picture from the board's first frame (on a short way in it
 * arrives a little slower than BOARD_PASS would have it).
 */
const BOARD_LEAD_REACH = 0.4;
/** After the last photo it settles into the slow drift within this many frames... */
const BOARD_SETTLE = 36;
/** ...and this share of the frame's height, so the last photo stays in the picture to the board's end. */
const BOARD_SETTLE_REACH = 0.17;
/** That slow drift (px a frame at 1080p): slow, but still visibly moving. */
const BOARD_DRIFT = 1;
/**
 * The camera path is written as keyframes this many frames apart where it
 * curves past the photos (close enough that each key-to-key cubic follows it
 * to a fraction of a pixel), and this far apart on the straight ramps.
 */
const BOARD_KEY_SPACING: [number, number] = [2, 6];
/** A Bezier handle reaching a third of its segment: with every key's speed set, each segment is the cubic Hermite through its ends. */
const HERMITE_INFLUENCE = 1 / 3;

/** The timeline marker an evidence board leaves on each photo's moment. */
export const BOARD_MARKER = "board photo";
/** The name of an evidence board's own shutters. */
export const BOARD_SHUTTER = "Evidence board · shutter";

/** A camera keyframe on an evidence board (board pixels; velocity in px a frame). */
interface CameraKey {
  frame: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

type Point = [number, number];

/**
 * One stretch of an evidence board's camera path (board pixels and frames):
 * the cubic curve from `p0` to `p1` leaving along `t0` and arriving along
 * `t1`, travelled from `from` to `to` with the speed easing from `enter` to
 * `leave` (flat at both ends, so the speed is smooth where stretches meet)
 * and rising in the middle by just enough to cover the curve's length.
 */
class Stretch {
  enter = 0;
  leave = 0;
  /** Frames between its keyframes (a steady drift in a straight line needs only its two ends). */
  spacing = BOARD_KEY_SPACING[0];
  /** Length along the curve at u = i / (len - 1). */
  readonly lengths: number[] = [];

  constructor(
    readonly from: number,
    readonly to: number,
    readonly p0: Point,
    readonly t0: Point,
    readonly p1: Point,
    readonly t1: Point,
  ) {
    const steps = 256;
    let total = 0;
    let last = p0;
    this.lengths.push(0);
    for (let step = 1; step <= steps; step++) {
      const here = this.point(step / steps);
      total += Math.hypot(here[0] - last[0], here[1] - last[1]);
      this.lengths.push(total);
      last = here;
    }
  }

  /** Straight from `p0` to `p1`, the speed easing from `enter` to `leave`. */
  static straight([from, to]: Point, p0: Point, p1: Point, enter: number, leave: number): Stretch {
    const chord: Point = [p1[0] - p0[0], p1[1] - p0[1]];
    const stretch = new Stretch(from, to, p0, chord, p1, chord);
    stretch.enter = enter;
    stretch.leave = leave;
    stretch.spacing = Math.abs(enter - leave) < 1e-9 ? Number.POSITIVE_INFINITY : BOARD_KEY_SPACING[1];
    return stretch;
  }

  point(u: number): Point {
    const [u2, u3] = [u * u, u * u * u];
    const [a, b, c, d] = [2 * u3 - 3 * u2 + 1, u3 - 2 * u2 + u, 3 * u2 - 2 * u3, u3 - u2];
    return [
      a * this.p0[0] + b * this.t0[0] + c * this.p1[0] + d * this.t1[0],
      a * this.p0[1] + b * this.t0[1] + c * this.p1[1] + d * this.t1[1],
    ];
  }

  tangent(u: number): Point {
    const u2 = u * u;
    const [a, b, c, d] = [6 * u2 - 6 * u, 3 * u2 - 4 * u + 1, 6 * u - 6 * u2, 3 * u2 - 2 * u];
    return [
      a * this.p0[0] + b * this.t0[0] + c * this.p1[0] + d * this.t1[0],
      a * this.p0[1] + b * this.t0[1] + c * this.p1[1] + d * this.t1[1],
    ];
  }

  length(): number {
    return this.lengths[this.lengths.length - 1] ?? 0;
  }

  /** Where on the curve (u) the camera is once it has come `distance` along. */
  uAt(distance: number): number {
    const last = Math.max(this.lengths.length - 1, 1);
    // partition_point: the first length not below `distance`.
    let lo = 0;
    let hi = this.lengths.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.lengths[mid]! < distance) lo = mid + 1;
      else hi = mid;
    }
    const index = lo;
    if (index === 0) return 0;
    const below = this.lengths[index - 1];
    const above = this.lengths[index];
    if (below === undefined || above === undefined) return 1;
    const share = above > below ? (distance - below) / (above - below) : 0;
    return (index - 1 + share) / last;
  }

  /**
   * The camera at `frame`: speed `enter` + (`leave` - `enter`) smoothstep + a
   * bump 16 t^2 (1 - t)^2 (flat at both ends) sized so the stretch ends
   * exactly at `p1`; position from the distance that speed covers.
   */
  at(frame: number): CameraKey {
    const span = Math.max(this.to - this.from, Number.EPSILON);
    const t = Math.min(Math.max((frame - this.from) / span, 0), 1);
    const [t2, t3] = [t * t, t * t * t];
    const [t4, t5] = [t3 * t, t3 * t2];
    const bump = Math.max(((this.length() / span - (this.enter + this.leave) / 2) * 15) / 8, 0);
    const change = this.leave - this.enter;
    const speed = this.enter + change * (3 * t2 - 2 * t3) + bump * 16 * t2 * (1 - t) * (1 - t);
    const distance = span * (this.enter * t + change * (t3 - t4 / 2) + bump * 16 * (t3 / 3 - t4 / 2 + t5 / 5));
    const u = this.uAt(distance);
    const [x, y] = this.point(u);
    const [dx, dy] = this.tangent(u);
    const norm = Math.max(Math.hypot(dx, dy), Number.EPSILON);
    return { frame, x, y, vx: (speed * dx) / norm, vy: (speed * dy) / norm };
  }
}

/**
 * An evidence board: photos laid out on paper like prints on a desk, each in
 * a dark frame with a soft shadow and a red handwritten note under it,
 * zig-zagging down the board. The camera glides down it in ONE continuous
 * movement: each photo is centred at its moment (`at`, the frame of the word
 * that names it), the camera easing a little as it passes a photo (to ~70% of
 * its average speed) and picking up between them, smooth in position and
 * speed everywhere (never a hold, a stop or a jolt). Before the first photo
 * it picks up from a slow drift; after the last it settles back into one
 * until the board ends. Each note writes itself on, a letter every 2 frames,
 * as its photo arrives. Built in one go from
 * `{"op":"evidence_board","start":F,"end":F,"items":[{"media":"m1","label":"arson?","at":F}]}`
 * (all frames on the timeline; `end` defaults to 45 frames after the last
 * photo). The older timing still works: without `at`, `frames` is the time
 * around each photo (default 75), centred in its middle, and `pan` the frames
 * between (for the board or per photo, default 30). `illustrative: true` adds
 * a small "Illustrative images" in the corner. Each photo's moment is marked
 * on the timeline ("board photo", its label as the note) and gets a quiet
 * camera shutter whose click lands on it (`shutters: false` for none; a
 * shutter already within 8 frames, a transition's on the cut into the board,
 * stands in for it).
 */
function evidenceBoard(project: Project, args: Args, shutter: Shutter | null): Json {
  const given = int(args.start);
  if (given === null) throw new Error("evidence_board needs start (frames)");
  const start = Math.max(given, 0);
  const items = Array.isArray(args.items) && args.items.length > 0 && args.items.length <= 8 ? (args.items as unknown[]).map(objectOf) : null;
  if (items === null) throw new Error("evidence_board needs items: 1 to 8 photos [{media, label, at}]");
  const [width, height] = [project.settings.width, project.settings.height];
  const k = height / 1080;
  // When each photo is centred (board frames) and how long the board lasts.
  let centred: number[];
  let total: number;
  if (items.some((item) => item.at !== undefined && item.at !== null)) {
    centred = items.map((item, index) => {
      const at = int(item.at);
      if (at === null) throw new Error(`item ${index + 1}: at (frames) is required when any item has at`);
      return at - start;
    });
    if ((centred[0] ?? 0) < 0) throw new Error("evidence_board: the first photo's at is before start");
    if (centred.some((at, index) => index > 0 && at - centred[index - 1]! < 4)) {
      throw new Error("evidence_board: items' at must increase, at least 4 frames apart");
    }
    const last = centred[centred.length - 1] ?? 0;
    const end = int(args.end);
    const length = int(args.duration);
    total = end !== null ? end - start : length !== null ? length : last + 45;
    if (total <= last) throw new Error("evidence_board: end must come after the last photo's at");
  } else {
    const pan = Math.min(Math.max(int(args.pan) ?? BOARD_PAN, 8), 60);
    centred = [];
    let at = 0;
    let lastPan = pan;
    for (const item of items) {
      const hold = Math.min(Math.max(int(item.frames) ?? 75, 4), 600);
      const own = int(item.pan);
      lastPan = own === null ? pan : Math.min(Math.max(own, 6), 60);
      centred.push(at + idiv(hold, 2));
      at += hold + lastPan;
    }
    total = at - lastPan;
  }
  // Where each photo sits on the board (its centre, project pixels): down the
  // board, alternately straight under and off to the right.
  const spot = (index: number): Point => [remEuclid(index, 2) === 0 ? 0 : 0.42 * width, index * 0.5 * height];
  const spots: Point[] = items.map((_, index) => spot(index));
  const drift = BOARD_DRIFT * k;
  // The camera's path: through every photo heading down the board's way (from
  // the photo before to the one after, as if the zig-zag carried on past the
  // ends), so it turns as it passes each photo and swings across between
  // them, one smooth S down the board.
  const headings: Point[] = spots.map((_, index) => {
    const [[ax, ay], [bx, by]] = [spot(index - 1), spot(index + 1)];
    const length = Math.max(Math.hypot(bx - ax, by - ay), 1);
    return [(bx - ax) / length, (by - ay) / length];
  });
  // How hard the curve leaves each photo: how far the neighbours are along
  // the heading (straight down the board, the curve's y moves evenly).
  const pulls = headings.map(([hx, hy], index) => {
    const around: number[] = [];
    for (const from of [index - 1, index]) {
      const a = spots[from];
      const b = spots[from + 1];
      if (from < 0 || a === undefined || b === undefined) continue;
      around.push(Math.abs((b[0] - a[0]) * hx + (b[1] - a[1]) * hy));
    }
    return Math.max(around.reduce((sum, value) => sum + value, 0) / Math.max(around.length, 1), 1);
  });
  const scaled = (index: number): Point => {
    const [hx, hy] = headings[index] ?? [0, 1];
    const pull = pulls[index] ?? 1;
    return [hx * pull, hy * pull];
  };
  const glides: Stretch[] = [];
  for (let index = 0; index + 1 < spots.length; index++) {
    const from = centred[index];
    const to = centred[index + 1];
    if (from === undefined || to === undefined) continue;
    glides.push(new Stretch(from, to, spots[index]!, scaled(index), spots[index + 1]!, scaled(index + 1)));
  }
  // Passing each photo at BOARD_PASS of the average speed either side (no
  // faster than the slower side's average, so each stretch's speed rises in
  // its middle and never dips below its ends).
  const averages = glides.map((glide) => glide.length() / Math.max(glide.to - glide.from, 1));
  const passes = spots.map((_, index) => {
    const around = [index > 0 ? averages[index - 1] : undefined, averages[index]].filter(
      (value): value is number => value !== undefined,
    );
    if (around.length === 0) return drift;
    const mean = around.reduce((sum, value) => sum + value, 0) / around.length;
    const slowest = around.reduce((low, value) => Math.min(low, value), Number.POSITIVE_INFINITY);
    return Math.min(Math.max(BOARD_PASS * mean, drift), slowest);
  });
  // The way in: picking up speed evenly over the last BOARD_LEAD frames
  // before the first photo, from no further than BOARD_LEAD_REACH.
  const firstAt = centred[0] ?? 0;
  const lead = Math.min(firstAt, BOARD_LEAD);
  if (passes.length > 0 && lead > 0) {
    passes[0] = Math.max(Math.min(passes[0]!, (2 * BOARD_LEAD_REACH * height) / lead - drift), drift);
  }
  glides.forEach((glide, index) => {
    glide.enter = passes[index] ?? drift;
    glide.leave = passes[index + 1] ?? drift;
  });
  const along = ([x, y]: Point, [hx, hy]: Point, distance: number): Point => [x + hx * distance, y + hy * distance];
  const path: Stretch[] = [];
  const [spot0, heading0, pass0] = [spots[0], headings[0], passes[0]];
  if (spot0 !== undefined && heading0 !== undefined && pass0 !== undefined && lead > 0) {
    const begins = along(spot0, heading0, (-lead * (pass0 + drift)) / 2);
    if (firstAt > lead) {
      const drifts = along(begins, heading0, -drift * (firstAt - lead));
      path.push(Stretch.straight([0, firstAt - lead], drifts, begins, drift, drift));
    }
    path.push(Stretch.straight([firstAt - lead, firstAt], begins, spot0, drift, pass0));
  }
  path.push(...glides);
  // The way out: easing from the last photo into the drift within
  // BOARD_SETTLE frames and BOARD_SETTLE_REACH, then drifting to the end.
  const [lastAt, spotN, headingN, passN] = [
    centred[centred.length - 1],
    spots[spots.length - 1],
    headings[headings.length - 1],
    passes[passes.length - 1],
  ];
  if (lastAt !== undefined && spotN !== undefined && headingN !== undefined && passN !== undefined) {
    const [last, end] = [lastAt, total];
    const frames = Math.min(end - last, BOARD_SETTLE, (2 * BOARD_SETTLE_REACH * height) / (passN + drift));
    const settles = along(spotN, headingN, (frames * (passN + drift)) / 2);
    path.push(Stretch.straight([last, last + frames], spotN, settles, passN, drift));
    if (end > last + frames) {
      const ends = along(settles, headingN, drift * (end - last - frames));
      path.push(Stretch.straight([last + frames, end], settles, ends, drift, drift));
    }
  }
  // Where the camera is at `frame` (and how fast it's going).
  const cameraAt = (frame: number): CameraKey => {
    const stretch = path.find((own) => frame <= own.to) ?? path[path.length - 1];
    return stretch === undefined ? { frame, x: 0, y: 0, vx: 0, vy: 0 } : stretch.at(frame);
  };
  // Its keyframes: every stretch's ends and, on a moving one, every few frames.
  const camera: CameraKey[] = [];
  for (const stretch of path) {
    const span = stretch.to - stretch.from;
    const steps = Math.max(Math.ceil(span / stretch.spacing), 1);
    for (let step = 0; step < steps; step++) camera.push(stretch.at(stretch.from + (span * step) / steps));
  }
  const lastStretch = path[path.length - 1];
  if (lastStretch !== undefined) camera.push(lastStretch.at(lastStretch.to));
  // An element at board position (bx, by), on screen from `from` (board
  // frames): it moves against the camera, so its keys are the camera's turned
  // round, each with the camera's speed on both sides.
  const keys = (bx: number, by: number, from: number) => {
    const xs: Args[] = [];
    const ys: Args[] = [];
    const here = cameraAt(from);
    const later = camera.filter((key) => key.frame > from + 0.01);
    for (const key of [here, ...later]) {
      for (const [list, value, speed] of [
        [xs, bx - key.x, -key.vx],
        [ys, by - key.y, -key.vy],
      ] as const) {
        const handle = { speed, influence: HERMITE_INFLUENCE };
        list.push({ frame: key.frame - from, value, ease: "linear", handle_in: { ...handle }, handle_out: handle });
      }
    }
    return { x: xs, y: ys };
  };
  const made: string[] = [];
  const add = (fields: Args): string => {
    const id = freshId(project, "c");
    project.clips.push(clipOrSay({ ...fields, id }, "evidence_board: "));
    made.push(id);
    return id;
  };
  // The paper, under everything on the board.
  const paper = addTrack(project, "video");
  add({ type: "solid", name: "Evidence board · paper", track: paper, start, duration: total, fill: [0.93, 0.93, 0.915, 1] });
  const opening = cameraAt(0);
  items.forEach((item, index) => {
    const [x, y] = spots[index]!;
    const at = centred[index]!;
    const mediaId = str(item.media);
    if (mediaId === null) throw new Error(`item ${index + 1}: media (an image's media id) is required`);
    const media = mediaOf(project, mediaId);
    if (media === undefined) throw new Error(`item ${index + 1}: no media ${mediaId}`);
    // About half the frame's height (no wider than ~60% of it).
    const [w, h] = [Math.max(media.width, 1), Math.max(media.height, 1)];
    const fit = Math.min(width / w, height / h);
    let scale = (0.56 * height) / (h * fit);
    if (w * fit * scale > 0.62 * width) scale = (0.62 * width) / (w * fit);
    const shown = h * fit * scale;
    const photo = addTrack(project, "video");
    add({
      type: "video",
      name: `Evidence board · photo ${index + 1}`,
      track: photo,
      media: mediaId,
      source_in: 0,
      start,
      duration: total,
      transform: { x: x - opening.x, y: y - opening.y, scale },
      frame: { width: 16 * k, shadow: 0.5 },
      keyframes: keys(x, y, 0),
    });
    const label = str(item.label);
    if (label !== null && trim(label) !== "") {
      // Written as the photo comes in: starting a little before it's centred
      // (a third of the way from the last one, at most 12 frames).
      const gap = index > 0 && centred[index - 1] !== undefined ? at - centred[index - 1]! : at;
      const from = at - Math.min(idiv(gap, 3), 12);
      const [lx, ly] = [x + (index % 2 === 0 ? 0.02 : -0.02) * width, y + shown / 2 + 0.06 * height];
      const track = addTrack(project, "video");
      const here = cameraAt(from);
      add({
        type: "text",
        name: `Evidence board · note ${index + 1}`,
        track,
        start: start + from,
        duration: total - from,
        text: label,
        style: { font: "Reenie Beanie", weight: 400, size: 128 * k, color: [0.8, 0.07, 0.15, 1], glow: { enabled: false } },
        transform: { x: lx - here.x, y: ly - here.y, rotation: -4 },
        animation: { preset: "typewriter", stagger: 2, duration: 1 },
        keyframes: keys(lx, ly, from),
      });
    }
  });
  // The board's vignette, over all of it.
  const shade = addTrack(project, "video");
  add({ type: "adjustment", name: "Evidence board · vignette", track: shade, start, duration: total, grade: { vignette: 0.38 } });
  // Photos that aren't the case's own say so, small, in the corner, still.
  if (args.illustrative === true) {
    const track = addTrack(project, "video");
    add({
      type: "text",
      name: "Evidence board · illustrative",
      track,
      start,
      duration: total,
      text: "Illustrative images",
      style: {
        size: 30 * k,
        weight: 500,
        color: [1, 1, 1, 1],
        glow: { enabled: false },
        background: { opacity: 0.45, pad_x: 12 * k, pad_y: 6 * k },
      },
      transform: { x: 0.5 * width - 190 * k, y: 0.5 * height - 50 * k },
    });
  }
  const moments = centred.map((at) => start + at);
  // Each photo's moment, marked: a rebuilt board replaces its old marks.
  project.markers = (project.markers ?? []).filter(
    (marker) => !(marker.name === BOARD_MARKER && marker.frame >= start && marker.frame < start + total),
  );
  items.forEach((item, index) => {
    const label = str(item.label) ?? "";
    markers.addTimeline(project, moments[index]!, BOARD_MARKER, trim(label));
  });
  const shutters: number[] = [];
  if (shutter !== null && args.shutters !== false) {
    const fps = fpsOf(project);
    const hit = asInt(round(shutter.hit * fps));
    const shutterMedia = mediaOf(project, shutter.media);
    const length = shutterMedia === undefined ? 6 : Math.max(asInt(Math.floor(shutterMedia.duration * fps)), 1);
    // A rebuilt board's own shutters go; anyone else's shutter near a photo
    // (the cut's, with its flash) stands in for that photo's.
    project.clips = project.clips.filter(
      (clip) => !(clip.name === BOARD_SHUTTER && clip.start + hit >= start && clip.start + hit < start + total),
    );
    const shutterAt: number[] = [];
    for (const clip of project.clips) {
      if (clip.type !== "audio") continue;
      const named = (name: string) => name.toLowerCase().includes("shutter");
      const media = mediaOf(project, clip.media);
      if (media === undefined) continue;
      if (!((typeof clip.name === "string" && named(clip.name)) || named(media.name))) continue;
      // Where its click is heard: the hit, as trimmed and sped.
      const sourceIn = clip.source_in ?? 0;
      const own = (media.markers ?? []).find((marker) => marker.name === HIT)?.time ?? sourceIn;
      shutterAt.push(clip.start + asInt(round(((own - sourceIn) / Math.max(clip.speed ?? 1, 0.05)) * fps)));
    }
    for (const at of moments) {
      if (shutterAt.some((other) => Math.abs(other - at) <= 8)) continue;
      const [from, frames, sourceIn] = at - hit < 0 ? [0, length - (hit - at), (hit - at) / fps] : [at - hit, length, 0];
      if (frames < 1) continue;
      const track = freeTrackFrom(project, "audio", 1, from, from + frames);
      const id = freshId(project, "c");
      project.clips.push({
        id,
        track,
        start: from,
        duration: frames,
        color: "yellow",
        name: BOARD_SHUTTER,
        fade_in: Math.min(1, frames),
        fade_out: Math.min(2, frames),
        type: "audio",
        media: shutter.media,
        source_in: sourceIn,
        speed: 1,
        volume_db: f32(shutter.volume_db),
      });
      shutters.push(at);
    }
  }
  return { clips: made, end: start + total, centred: moments, shutters };
}

// ---------------------------------------------------------------------------
// Selecting clips

const SELECTOR: Struct = {
  name: "Selector",
  denyUnknown: true,
  fields: [
    { name: "ids", kind: { option: { vec: "string" } }, default: () => null },
    { name: "track", kind: { option: "string" }, default: () => null },
    { name: "label", kind: { option: "string" }, default: () => null },
    { name: "media", kind: { option: "string" }, default: () => null },
    { name: "name_prefix", kind: { option: "string" }, default: () => null },
    { name: "type", kind: { option: "string" }, default: () => null },
    { name: "start", kind: { option: "i64" }, default: () => null },
    { name: "end", kind: { option: "i64" }, default: () => null },
  ],
};

interface Selector {
  ids: string[] | null;
  track: string | null;
  label: string | null;
  media: string | null;
  name_prefix: string | null;
  type: string | null;
  start: number | null;
  end: number | null;
}

/**
 * Selects many clips without having to enumerate hundreds of subtitle IDs.
 * Times are frames, as in the project model. All supplied filters intersect.
 * The ids come out sorted (a BTreeSet in the Rust).
 */
export function selected(project: Project, select: unknown): string[] {
  let picked: Selector;
  try {
    picked = readStruct(SELECTOR, select ?? null) as unknown as Selector;
  } catch (error) {
    if (error instanceof SerdeError) throw new Error(`select: ${error.message}`);
    throw error;
  }
  if (Object.values(picked).every((value) => value === null)) throw new Error("select needs at least one filter");
  const ids = picked.ids;
  if (ids !== null) {
    const missing = ids.find((id) => clipOf(project, id) === undefined);
    if (missing !== undefined) throw new Error(`no clip ${missing}`);
  }
  const result = new Set<string>();
  for (const clip of project.clips) {
    if (ids !== null && !ids.includes(clip.id)) continue;
    if (picked.track !== null && clip.track !== picked.track) continue;
    if (picked.label !== null && !(clip.type === "text" && clip.style?.label?.text === picked.label)) continue;
    if (picked.media !== null && clipMedia(clip) !== picked.media) continue;
    if (picked.name_prefix !== null && !(typeof clip.name === "string" && clip.name.startsWith(picked.name_prefix))) continue;
    if (picked.start !== null && clip.start < picked.start) continue;
    if (picked.end !== null && clip.start >= picked.end) continue;
    if (picked.type !== null && clip.type !== picked.type) continue;
    result.add(clip.id);
  }
  if (result.size === 0) throw new Error("no clips matched; check the selector in get_edit_context");
  return [...result].sort(compareStrings);
}

// ---------------------------------------------------------------------------
// The audit

/**
 * Deterministic review catches mechanical issues without asking a model to
 * inspect dozens of pictures. Visual/factual judgment still needs a contact sheet.
 */
export function audit(project: Project): { issues: Json[]; frames: number; clips: number; [field: string]: unknown } {
  const fps = fpsOf(project);
  const issues: Record<string, unknown>[] = [];
  const total = durationOf(project);
  const visible = (track: string) => {
    const own = trackOf(project, track);
    return own !== undefined && !own.hidden;
  };
  const picture = project.clips
    .filter((clip) => visible(clip.track) && (clip.type === "video" || clip.type === "solid"))
    .map((clip): [number, number] => [clip.start, clipEnd(clip)])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let end = 0;
  for (const [start, to] of picture) {
    if (start > end) issues.push({ kind: "picture_gap", start: end, end: start });
    end = Math.max(end, to);
  }
  if (end < total) issues.push({ kind: "picture_gap", start: end, end: total });
  for (const clip of project.clips) {
    if (clip.type !== "video" && clip.type !== "audio") continue;
    const media = mediaOf(project, clip.media);
    if (media === undefined || media.kind === "image") continue;
    if ((clip.source_in ?? 0) + (clip.duration / fps) * (clip.speed ?? 1) > media.duration + 1 / fps) {
      issues.push({ kind: "source_exhausted", clip: clip.id });
    }
  }
  const links = new Map<string, Clip[]>();
  for (const clip of project.clips) {
    if (typeof clip.link !== "string") continue;
    const list = links.get(clip.link) ?? [];
    list.push(clip);
    links.set(clip.link, list);
  }
  for (const [link, clips] of links) {
    for (const video of clips.filter((clip) => clip.type === "video")) {
      for (const audio of clips.filter((clip) => clip.type === "audio")) {
        if (video.start !== audio.start || video.duration !== audio.duration) {
          issues.push({ kind: "linked_audio_misaligned", link, video: video.id, audio: audio.id });
        }
      }
    }
  }
  // Slivers: a picture or text clip too short to read is left over from a
  // trim; footage under a quarter of a second reads as a stutter (the team
  // caught a 5-frame fragment; emphasis runs are 12 frames or more).
  for (const clip of project.clips) {
    const shortest = clip.type === "video" ? 8 : 3;
    if (clip.duration < shortest && clip.type !== "audio" && clip.type !== "adjustment") {
      issues.push({ kind: "sliver", clip: clip.id, start: clip.start, frames: clip.duration });
    }
  }
  // The same moment of footage shown as B-roll in two places (more than a
  // couple of seconds apart: cuts of one moment butted together are one shot).
  const base = project.tracks.find((track) => track.kind === "video")?.id ?? null;
  const broll: [Clip, string, number, number][] = [];
  for (const clip of project.clips) {
    if (clip.track === base || clip.type !== "video") continue;
    const from = clip.source_in ?? 0;
    broll.push([clip, clip.media, from, from + (clip.duration / fps) * (clip.speed ?? 1)]);
  }
  const apart = asInt(round(2 * fps));
  broll.forEach(([one, media, from, to], index) => {
    for (const [other, otherMedia, otherFrom, otherTo] of broll.slice(index + 1)) {
      const overlap = Math.min(to, otherTo) - Math.max(from, otherFrom);
      const gap = Math.max(other.start - clipEnd(one), one.start - clipEnd(other));
      if (media === otherMedia && overlap >= 1 && gap > apart) {
        issues.push({ kind: "repeated_broll", clips: [one.id, other.id], media, seconds_shared: round(overlap * 10) / 10 });
      }
    }
  });
  // Every transition is heard: one of the plan's transitions with no sound
  // from an audio file (not footage or voice-over) starting within half a
  // second of its middle, or a short one (a riser, a hit) across it.
  const heard: [number, number][] = [];
  for (const clip of project.clips) {
    if (clip.name === "Voice-over" || clip.type !== "audio") continue;
    if (mediaOf(project, clip.media)?.kind === "audio") heard.push([clip.start, clipEnd(clip)]);
  }
  const near = asInt(round(0.5 * fps));
  const short = asInt(round(4 * fps));
  for (const clip of project.clips) {
    if (clip.name !== "Drop" && clip.name !== "Flash" && clip.name !== "Dip") continue;
    const middle = clip.start + idiv(clip.duration, 2);
    const sounded = heard.some(
      ([start, stop]) => Math.abs(start - middle) <= near || (stop - start <= short && start <= middle && middle <= stop + near),
    );
    if (!sounded) issues.push({ kind: "silent_transition", clip: clip.id, at: middle });
  }
  // A subtitle runs past the cut it's said before: into a cut-in's
  // voice-over, or over the cut into another moment of footage.
  const voiceovers = project.clips.filter((clip) => clip.name === "Voice-over").map((clip): [number, number] => [clip.start, clipEnd(clip)]);
  const footage: [Clip, string, number, number][] = [];
  for (const clip of project.clips) {
    if (clip.track !== base || clip.type !== "video") continue;
    footage.push([clip, clip.media, clip.source_in ?? 0, clip.speed ?? 1]);
  }
  for (const clip of project.clips) {
    if (!(typeof clip.name === "string" && clip.name.startsWith("Subtitle"))) continue;
    const intoVoiceover = voiceovers.some(([start, stop]) => clip.start < stop && start < clipEnd(clip));
    const under = footage.find(([own]) => own.start <= clip.start && clip.start < clipEnd(own));
    let overCut = false;
    if (under !== undefined && clipEnd(clip) > clipEnd(under[0])) {
      const [own, media, sourceIn, speed] = under;
      // Carrying on in the same moment (a split, not a cut) is fine.
      const nextIn = sourceIn + (own.duration / fps) * speed;
      overCut = !footage.some(
        ([next, nextMedia, nextSource]) => next.start === clipEnd(own) && nextMedia === media && Math.abs(nextSource - nextIn) * fps < 2,
      );
    }
    if (intoVoiceover || overCut) {
      issues.push({ kind: "subtitle_past_cut", clip: clip.id, start: clip.start, into: intoVoiceover ? "cut-in" : "next shot" });
    }
  }
  // A review note left in on-screen text would be burned into the video.
  for (const clip of project.clips) {
    if (clip.type !== "text") continue;
    const lower = clip.text.toLowerCase();
    if (["[unclear", "[inaudible", "[crosstalk", "[?]", "???", "[unintelligible"].some((note) => lower.includes(note))) {
      issues.push({ kind: "placeholder_text", clip: clip.id, start: clip.start, text: clip.text });
    }
  }
  // A narration card with nothing over it is a black screen with words.
  const level = (track: string) => project.tracks.findIndex((own) => own.id === track);
  if (project.script !== undefined && project.script !== null) {
    let number = 0;
    for (const block of project.script.blocks) {
      if (block.kind !== "narration") continue;
      number += 1;
      const card = typeof block.clip === "string" ? clipOf(project, block.clip) : undefined;
      if (card === undefined) continue;
      const bottom = level(card.track);
      const cover = project.clips
        .filter((clip) => clip.type === "video" && level(clip.track) > bottom && visible(clip.track))
        .map((clip): [number, number] => [Math.max(clip.start, card.start), Math.min(clipEnd(clip), clipEnd(card))])
        .filter(([start, stop]) => stop > start)
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let at = card.start;
      let bare = 0;
      for (const [start, stop] of cover) {
        bare += Math.max(start - at, 0);
        at = Math.max(at, stop);
      }
      bare += Math.max(clipEnd(card) - at, 0);
      if (bare >= 6) issues.push({ kind: "bare_card", cut_in: number, card: card.id, uncovered_frames: bare });
    }
  }
  // The same transitions over and over (an edit went drop in, dip out on
  // every one of fourteen cut-ins): a run of four alike, or of eight
  // alternating between two, reads as a template.
  const cuts: [number, string][] = [];
  for (const clip of project.clips) {
    const name = clip.name;
    if (typeof name !== "string") continue;
    let kind: string | null = null;
    if (name === "Dip") kind = "dip";
    else if (name === "Flash") kind = "flash";
    else if (name === "Drop") kind = "drop";
    else if (name.endsWith("vertical drop")) kind = "drop";
    else if (name.toLowerCase().includes("glitch")) kind = "glitch";
    if (kind !== null) cuts.push([clip.start + idiv(clip.duration, 2), kind]);
  }
  cuts.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  let at = 0;
  while (at < cuts.length) {
    const alike = (period: number) => {
      let stop = at + period;
      while (stop < cuts.length && cuts[stop]?.[1] === cuts[stop - period]?.[1]) stop += 1;
      return stop;
    };
    const [same, alternating] = [alike(1), alike(2)];
    let stop: number;
    if (same - at >= 4) stop = same;
    else if (alternating - at >= 8) stop = alternating;
    else {
      at += 1;
      continue;
    }
    const run = cuts.slice(at, stop);
    issues.push({
      kind: "repetitive_transitions",
      start: run[0]?.[0] ?? null,
      end: run[run.length - 1]?.[0] ?? null,
      count: run.length,
      pattern: run
        .slice(0, 2)
        .map((cut) => cut[1])
        .join(", "),
      fix: "vary them for their moments: flash or shutter, crossfade, dip, drop (TRANSITIONS)",
    });
    at = stop;
  }
  // A found photo or still as plain B-roll (letterboxed, often): pictures go
  // on screen only inside a designed graphic (an evidence card or board).
  issues.push(...graphics.bareStills(project));
  // The date in a box or glowing: it's white with a drop shadow only.
  issues.push(...graphics.dateDrift(project));
  // A subtitle or intro caption on someone's face (faces found so far).
  issues.push(...(hooks.textOnFaces(project) as Record<string, unknown>[]));
  return { issues: sortIssues(issues), frames: total, clips: project.clips.length };
}

/** Issues in the order Rust's `sort_by_key(Value::to_string)` left them: by their compact JSON. */
export function sortIssues<T>(issues: T[]): T[] {
  return issues
    .map((issue) => [stableStringify(issue), issue] as const)
    .sort((a, b) => compareStrings(a[0], b[0]))
    .map(([, issue]) => issue);
}
