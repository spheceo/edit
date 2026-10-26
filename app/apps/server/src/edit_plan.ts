// A section-sized transaction: resolve references, apply all
// operations, validate once, commit once. Intermediate overlaps are allowed;
// invalid plans save nothing. Its `audit` is the mechanical review the agent
// gets back instead of rendering for everything.

import { clipFrom, keyframesFrom } from "./clips.ts";
import * as cutin from "./cutin.ts";
import * as desktop from "./desktop.ts";
import * as screen from "./desktop_screen.ts";
import * as framing from "./framing.ts";
import * as vignettes from "./vignettes.ts";
import * as looks from "./looks.ts";
import * as graphics from "./graphics.ts";
import * as commentaryGraphics from "./commentary_graphics.ts";
import * as commentaryAudit from "./commentary_audit.ts";
import * as intro from "./intro_graphics.ts";
import * as markBlurs from "./mark_blurs.ts";
import * as typing from "./typing_sounds.ts";
import * as markers from "./markers.ts";
import type { Clip, Keyframe, Media, Project } from "./model.ts";
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
  liftTextOverBlurs,
  mediaOf,
  mergeClip,
  separateOverlaps,
  tidyTracks,
  touchesPeople,
  trackOf,
} from "./project.ts";
import { isBug } from "./guard.ts";
import { asInt, compareStrings, f32Saved as f32, idiv, jsonForSerde, round, trim } from "./rust.ts";
import * as seams from "./seams.ts";
import { HIT } from "./sfx.ts";
import { readStruct, SerdeError, type Struct } from "./serde.ts";
import { compareKeys, stableStringify } from "./stable.ts";

type Args = Record<string, unknown>;
type Json = unknown;

/**
 * What the plan reaches in other packages (people and faces), through
 * their seams; tests put their own in.
 */
export const hooks = {
  oneColourPerPerson: (project: Project): Json => seams.people.oneColourPerPerson(project),
  textOnFaces: (project: Project): Json[] => seams.faces.textOnFaces(project),
  picturesOnFaces: (project: Project): Json[] => seams.faces.picturesOnFaces(project),
};

export interface Applied {
  results: Json[];
  smooth: string[];
  /** Clips the plan left overlapping another on its track, moved onto a track of their own. */
  separated: string[];
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
  /** The Windows screen's wallpaper and window frames (desktop ops, cover_cut_in desktop and picture shots). */
  screen?: screen.Art | null;
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
  /** Window frames the Windows screens need drawn ([app, width, height]); the wallpaper with them. */
  screens?: [screen.AppKind, number, number][];
}

export function needs(operations: Json[], project: Project | null = null): Needs {
  const out: Needs = { shutter: false, desktops: [] };
  const sizes: [screen.AppKind, number, number][] = [];
  const want = (given: Args, open: boolean) => {
    if (project === null) return;
    for (const size of screenSizes(project, given, open)) {
      if (!sizes.some(([app, w, h]) => app === size[0] && w === size[1] && h === size[2])) sizes.push(size);
    }
  };
  for (const raw of operations) {
    const operation = objectOf(raw);
    if (operation.op === "desktop") want(operation, operation.open !== false);
    if (operation.op === "cover_cut_in" && Array.isArray(operation.shots)) {
      for (const shot of operation.shots.map(objectOf)) {
        if (typeof shot.desktop === "object" && shot.desktop !== null) want(objectOf(shot.desktop), objectOf(shot.desktop).open !== false);
        else if (project !== null && typeof shot.media === "string" && mediaOf(project, shot.media)?.kind === "image") {
          want({ windows: [{ app: "photo_viewer", media: shot.media }] }, true);
        }
      }
    }
    if (operation.op === "file_viewer" && project !== null) {
      const drawn = looks.fileViewerFrames(project, operation);
      if (drawn !== null && !sizes.some(([app, w, h]) => app === "file_viewer" && w === drawn[0] && h === drawn[1])) sizes.push(["file_viewer", drawn[0], drawn[1]]);
    }
    if (operation.op === "evidence_board" && operation.shutters !== false) out.shutter = true;
    if (operation.op === "desktop_profile") {
      const titles = desktop.titles(operation);
      if (!out.desktops.some(([a, b]) => a === titles[0] && b === titles[1])) out.desktops.push(titles);
    }
  }
  if (sizes.length > 0) out.screens = sizes;
  return out;
}

/**
 * The window frames a desktop asks for (read leniently: a bad window is the
 * op's own error to give), with the opening Video Player's when it opens
 * from the footage before it.
 */
function screenSizes(project: Project, given: Args, open: boolean): [screen.AppKind, number, number][] {
  let spec: screen.Spec;
  try {
    const windows = (Array.isArray(given.windows) ? given.windows : []).map((window) => ({ ...objectOf(window), at: 1 }));
    spec = screen.readSpec(project, { ...given, windows }, 1, 1_000_000, "");
  } catch {
    return [];
  }
  if (open) spec = screen.openFrom(spec, { media: "", source_in: 0, speed: 1, zoom: 1 });
  return screen.frameSizes(project, spec);
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
  const placed = new Map(project.clips.map((clip) => [clip.id, `${clip.track}/${clip.start}/${clip.duration}`]));
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
  // Two clips left on one track at once (a sound moved into the next, a
  // shot lengthened over its neighbour) refused the whole plan: the one the
  // plan placed goes onto a track of its own just above instead.
  const separated = separateOverlaps(project, placed);
  // No words under a blur, whatever the plan added where.
  liftTextOverBlurs(project);
  // Typing sounds play exactly while their lines type (a desktop rebuilt moves its lines).
  typing.fitTypingSounds(project);
  // Every graphic op puts its layers on new tracks above everything; packed
  // down here, a plan never leaves the edit taller than what's on screen at
  // once needs (the interrogation intro's plans left 69 video tracks where 9 do).
  tidyTracks(project);
  const invalid = native().projectValidate(jsonForSerde(project));
  if (invalid !== null) throw new Error(`final plan is invalid: ${invalid}; nothing saved`);
  return { results, smooth, separated };
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
        keepLeftEdge(clip, next, patch);
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
      const [report, pending] = cutin.cover(project, args, assets.screen ?? null);
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
    case "desktop": {
      if (assets.screen === undefined || assets.screen === null) throw new Error("desktop's pictures weren't prepared (run it through apply_edit_plan)");
      const start = int(args.start);
      if (start === null) throw new Error("desktop needs start (frames)");
      const end = int(args.end) ?? (int(args.duration) === null ? null : start + int(args.duration)!);
      if (end === null) throw new Error("desktop needs end or duration (frames)");
      let spec = screen.readSpec(project, args, start, end, "Desktop · ");
      const skip = (name: string) => name.startsWith("Desktop · ");
      if (args.open !== false) spec = screen.openFrom(spec, screen.footageBefore(project, start, skip), screen.footageAt(project, end, false, skip));
      return screen.build(project, spec, assets.screen);
    }
    case "film_look":
      return looks.filmLook(project, args);
    case "fill_frame":
      return framing.fillFrame(project, args);
    case "ease_vignettes":
      return vignettes.ease(project, args);
    case "red_quote":
      return looks.redQuote(project, args);
    case "annotate":
      return looks.annotate(project, args);
    case "call":
      return looks.call(project, args);
    case "file_viewer": {
      if (assets.screen === undefined || assets.screen === null) throw new Error("file_viewer's frame wasn't prepared (run it through apply_edit_plan)");
      return looks.fileViewer(project, args, assets.screen.frames);
    }
    // Retired (the team, Oct 20: "abandon any sort of other way of displaying
    // images and evidence… lean toward this Windows-style thing"): pictures
    // go on the Windows screen, evidence on an evidence board.
    case "desktop_profile":
    case "evidence_card":
    case "photo_inset":
    case "map_pin":
    case "split_screen":
      throw new Error(`${op} is retired: show pictures on the Windows screen (op desktop, or a desktop shot or picture shot in cover_cut_in), evidence on an evidence board`);
    case "date_title":
      return graphics.dateTitle(project, args);
    case "commentary_text":
      return commentaryGraphics.text(project, args);
    case "commentary_card":
      return commentaryGraphics.card(project, args);
    case "commentary_chapter":
      return commentaryGraphics.chapter(project, args);
    case "commentary_look":
      return commentaryGraphics.narrationLook(project, args);
    case "commentary_profile":
      return commentaryGraphics.profile(project, args);
    case "commentary_youtube":
      return commentaryGraphics.youtube(project, args);
    case "commentary_youtube_list":
      return commentaryGraphics.youtubeList(project, args);
    case "commentary_label":
      return commentaryGraphics.label(project, args);
    case "commentary_bumper":
      return commentaryGraphics.bumper(project, args);
    case "commentary_punch":
      return commentaryGraphics.punch(project, args);
    case "commentary_leak":
      return commentaryGraphics.leak(project, args);
    case "intro_captions":
      return intro.introCaptions(project, args);
    case "countdown":
      return intro.countdown(project, args);
    case "fast_forward":
      return intro.fastForward(project, args);
    case "pause":
      return intro.pause(project, args);
    case "disclaimer":
      return intro.disclaimer(project, args);
    case "text_slam":
      return intro.textSlam(project, args);
    case "timeline_bar":
      return intro.timelineBar(project, args);
    case "title_collage":
      return graphics.titleCollage(project, args);
    case "place_label":
      return graphics.placeLabel(project, args);
    case "markers":
      return markers.edit(project, args);
    case "blur_marks":
      return markBlurs.blurMarks(project, args);
    default:
      // A transition's kind given as its own op ("red_flash" in the intro skill's words).
      if (["drop", "flash", "red_flash", "dip", "open", "light_leak", "burn"].includes(String(op))) {
        throw new Error(`unknown op ${op}: it's a transition, {"op": "transition", "kind": "${op}", "at": <frame>}`);
      }
      throw new Error(
        `unknown op ${op}; use add, update, delete, keyframes, cover_cut_in, desktop, file_viewer, film_look, fill_frame, ease_vignettes, red_quote, annotate, call, transition, evidence_board, evidence_card, date_title, place_label, title_collage, desktop_profile, intro_captions, photo_inset, countdown, map_pin, split_screen, fast_forward, disclaimer, text_slam, timeline_bar, markers, blur_marks, tidy_tracks`,
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
 * - light_leak: warm light sweeping across and burning to white on the cut,
 *   16 frames straddling it (the courtroom's flash).
 * - burn: the picture burning out warm to near white on the cut and back,
 *   12 frames straddling it (the interrogation's "Bridge flash").
 * The last two are a style's one transition, used on every bridge on purpose:
 * the audit's repetitive_transitions leaves them alone.
 */
function transition(project: Project, args: Args): Json {
  if (str(args.kind) === "dissolve") return dissolve(project, args);
  const kind = str(args.kind);
  if (kind === null) throw new Error("transition needs kind: drop, flash, red_flash, dip, open, light_leak, burn or dissolve");
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
  let keys: Record<string, Args[]> = {};
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
    case "red_flash":
      // Red Thread's: the picture flooding red for a few frames on the cut
      // (into a mugshot, out of the cold open into black).
      [name, start, length, content, opacity] = [
        "Red flash",
        cut() - 4,
        10,
        { type: "solid", fill: [0.82, 0.04, 0.06, 1] },
        [key(0, 0, "in"), key(4, 0.85, "out"), key(9, 0, "linear")],
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
    case "light_leak":
      [name, start, length, content, opacity] = ["Light leak", cut() - 8, 16, { type: "adjustment", grade: { temperature: 0.25 } }, null];
      keys = {
        leak: [key(0, 0, "in"), key(8, 3.2, "out"), key(15, 0, "linear")],
        leak_x: [key(0, -0.9, "linear"), key(15, 0.6, "linear")],
        exposure: [key(0, 0, "in"), key(8, 0.7, "out"), key(15, 0, "linear")],
      };
      break;
    case "burn":
      [name, start, length, content, opacity] = ["Bridge flash", cut() - 6, 12, { type: "adjustment", grade: { temperature: 0.35 } }, null];
      keys = {
        exposure: [key(0, 0, "in"), key(6, 2.6, "out"), key(11, 0, "linear")],
        leak: [key(0, 0, "in"), key(6, 1.2, "out"), key(11, 0, "linear")],
        leak_x: [key(0, -0.5, "linear"), key(11, 0.5, "linear")],
      };
      break;
    default:
      throw new Error(`unknown transition ${kind}; use drop, flash, red_flash, dip, open, light_leak or burn`);
  }
  // Never before the start of the video: what's cut off the front goes.
  const [from, frames] = [Math.max(start, 0), length - Math.max(-start, 0)];
  const id = freshId(project, "c");
  const track = addTrack(project, "video");
  const fields: Args = { ...content, id, name, track, start: from, duration: frames };
  if (opacity !== null) keys = { ...keys, opacity };
  const params = Object.keys(keys).sort(compareKeys);
  if (params.length > 0) fields.keyframes = Object.fromEntries(params.map((param) => [param, keys[param]!]));
  project.clips.push(clipOrSay(fields, `${kind}: `));
  return id;
}

/**
 * A clean cross-dissolve into the shot that starts at `at` (the team, N3on
 * v1: "either a clean cut without the morphing between, or we put a clean
 * cross-dissolve"): `frames` (12) of the incoming shot's lead-in, from just
 * before its first frame, fade in over the outgoing one, then the incoming
 * clip carries on from the same frame, so nothing else moves. Picture only;
 * the incoming shot needs that much footage before its in-point.
 */
function dissolve(project: Project, args: Args): Json {
  const at = int(args.at);
  if (at === null) throw new Error("a dissolve needs at (the cut's frame)");
  const fps = project.settings.fps;
  const index = (track: string) => project.tracks.findIndex((one) => one.id === track);
  const incoming = project.clips.filter((clip) => clip.type === "video" && clip.start === at && trackOf(project, clip.track)?.hidden !== true)
    .sort((a, b) => index(b.track) - index(a.track))[0];
  if (incoming === undefined || incoming.type !== "video") throw new Error(`no shot starts at frame ${at} to dissolve into`);
  const outgoing = project.clips.some((clip) => clip.type === "video" && clip.id !== incoming.id && clip.start < at && clip.start + clip.duration >= at);
  if (!outgoing) throw new Error(`nothing plays before frame ${at} to dissolve from`);
  // As long as asked, as far as the footage before its in-point allows.
  const room = Math.floor((incoming.source_in / incoming.speed) * fps);
  const frames = Math.min(int(args.frames) ?? 12, room, at);
  if (frames < 4) throw new Error(`the shot at ${at} starts at its footage's first frame: no lead-in to dissolve with (trim its in-point later, or cut)`);
  const id = freshId(project, "c");
  project.clips.push(clipOrSay({ id, type: "video", name: `Dissolve · ${incoming.id}`, media: incoming.media, track: addTrack(project, "video"),
    start: at - frames, duration: frames, source_in: incoming.source_in - (frames / fps) * incoming.speed, speed: incoming.speed,
    transform: incoming.transform, opacity: incoming.opacity, ...(incoming.crop ? { crop: incoming.crop } : {}), ...(incoming.frame ? { frame: incoming.frame } : {}),
    fade_in: frames, fade_out: 0 }, "dissolve: "));
  return id;
}

// ---------------------------------------------------------------------------
// The evidence board

/** The evidence board's glide between photos (frames) in the old `frames`/`pan` timing, unless told otherwise. */
const BOARD_PAN = 30;
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
 * a small "Illustrative images" in the corner; `title` a handwritten heading
 * over the first photo, written on as the board comes in. Each photo's moment is marked
 * on the timeline ("board photo", its label as the note) and gets a quiet
 * camera shutter whose click lands on it (`shutters: false` for none; a
 * shutter already within 8 frames, a transition's on the cut into the board,
 * stands in for it).
 */
function evidenceBoard(project: Project, args: Args, shutter: Shutter | null): Json {
  const given = int(args.start);
  if (given === null) throw new Error("evidence_board needs start (frames)");
  const start = Math.max(given, 0);
  // At most four: JJ on Mom & Teen's five-photo board, "far, far, far too rehearsed… a lot smoother".
  const items = Array.isArray(args.items) && args.items.length > 0 && args.items.length <= 4 ? (args.items as unknown[]).map(objectOf) : null;
  if (items === null) throw new Error("evidence_board needs items: 1 to 4 photos [{media, label, at}] (more is too busy to read: make two boards, or keep the ones that matter)");
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
  // Where each photo sits (its centre, project pixels): all of them on the
  // screen at once, side by side (two rows for three or four), never a camera
  // swinging from one to the next (JJ: "slower so we can actually see what is
  // going on", "This is simply not smooth enough").
  const columns = items.length === 1 ? 1 : 2;
  const rows = Math.ceil(items.length / columns);
  const spots: Point[] = items.map((_, index) => {
    const [row, column] = [Math.floor(index / columns), index % columns];
    const inRow = Math.min(columns, items.length - row * columns);
    const x = inRow === 1 ? 0 : (column === 0 ? -1 : 1) * 0.235 * width;
    const y = rows === 1 ? 0.04 * height : (row === 0 ? -0.17 : 0.25) * height;
    return [x, y];
  });
  const drift = BOARD_DRIFT * k;
  // The camera: one slow, even drift over the whole board.
  const path: Stretch[] = [Stretch.straight([0, total], [0, -drift * total * 0.5], [0, drift * total * 0.5], drift, drift)];
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
  const notesLater: (() => void)[] = [];
  items.forEach((item, index) => {
    const [x, y] = spots[index]!;
    const at = centred[index]!;
    const mediaId = str(item.media);
    if (mediaId === null) throw new Error(`item ${index + 1}: media (an image's media id) is required`);
    const media = mediaOf(project, mediaId);
    if (media === undefined) throw new Error(`item ${index + 1}: no media ${mediaId}`);
    // Half the frame's height alone, a third in two rows (no wider than its column).
    const [w, h] = [Math.max(media.width, 1), Math.max(media.height, 1)];
    const fit = Math.min(width / w, height / h);
    let scale = ((rows === 1 ? 0.5 : 0.33) * height) / (h * fit);
    const widest = (columns === 1 ? 0.62 : 0.42) * width;
    if (w * fit * scale > widest) scale = widest / (w * fit);
    const shown = h * fit * scale;
    // In a beat before it's named (fading in), then held to the board's end.
    const from = Math.max(at - 20, 0);
    const photo = addTrack(project, "video");
    add({
      type: "video",
      name: `Evidence board · photo ${index + 1}`,
      track: photo,
      media: mediaId,
      source_in: 0,
      start: start + from,
      duration: total - from,
      fade_in: from > 0 ? 10 : 0,
      transform: { x: x - cameraAt(from).x, y: y - cameraAt(from).y, scale },
      frame: { width: 12 * k, shadow: 0.5 },
      keyframes: keys(x, y, from),
    });
    const label = str(item.label);
    if (label !== null && trim(label) !== "") notesLater.push(() => {
      // Written as the photo comes in: starting a little before it's centred
      // (a third of the way from the last one, at most 12 frames).
      const gap = index > 0 && centred[index - 1] !== undefined ? at - centred[index - 1]! : at;
      const from = Math.max(at - Math.min(idiv(gap, 3), 12), 0);
      const [lx, ly] = [x, y + shown / 2 + 0.045 * height];
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
    });
  });
  // Every note above every photo: a photo never covers a note (the team's board, a photo over "from the b…").
  for (const note of notesLater) note();
  // A heading over the first photo, written on as the board comes in: whose
  // account or what record the board is ("Nevaeh's account", "Prior reports").
  const title = str(args.title);
  if (title !== null && trim(title) !== "") {
    const [tx, ty] = [0, -0.42 * height];
    const track = addTrack(project, "video");
    add({
      type: "text",
      name: "Evidence board · title",
      track,
      start,
      duration: total,
      text: trim(title),
      style: { font: "Reenie Beanie", weight: 400, size: 170 * k, color: [0.12, 0.12, 0.14, 1], glow: { enabled: false } },
      transform: { x: tx - opening.x, y: ty - opening.y, rotation: -2 },
      animation: { preset: "typewriter", stagger: 2, duration: 1 },
      keyframes: keys(tx, ty, 0),
    });
  }
  // The board's vignette, over all of it.
  const shade = addTrack(project, "video");
  add({ type: "adjustment", name: "Evidence board · vignette", track: shade, start, duration: total, fade_in: 12, fade_out: 12, grade: { vignette: 0.38 } });
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

/** Seconds a B-roll shot may hold before the audit asks for a new one (long_broll_shot). */
const LONGEST_BROLL_SHOT = 4.5;
/** Seconds of one song a bed may play before the audit asks for a change (music_bed_long). */
const LONGEST_BED = 25;
/**
 * An interrogation's bed runs a whole section (the prologue, a bridge): the
 * team, on Helpful Wife's prologue changing songs mid-sentence: "we only need
 * to change the music if there is some switch in what we hear".
 */
const LONGEST_SECTION_BED = 90;
/** A hit on the frame the tape rolls: its library names. */
const HIT_NAME = /boom|impact|hit|thud|stinger|bass|drop|slam|sub/iu;
/** A riser building into it. */
const RISER_NAME = /riser|rise|swell|build|reverse|whoosh/iu;

/** What a cut is missing to be heard as a section starting: "a hit" on it, "a riser" building into it. */
export function cutSounds(project: Project, at: number): string[] {
  const second = asInt(round(fpsOf(project)));
  const visible = (track: string) => trackOf(project, track)?.hidden === false;
  const sounds = project.clips.filter(
    (clip): clip is Extract<Clip, { type: "audio" }> =>
      clip.type === "audio" && visible(clip.track) && clip.name !== "Voice-over" && mediaOf(project, clip.media)?.kind === "audio" && !isMusic(clip, mediaOf(project, clip.media)),
  );
  const named = (clip: Extract<Clip, { type: "audio" }>) => `${clip.name ?? ""} ${mediaOf(project, clip.media)?.name ?? ""}`;
  const missing: string[] = [];
  if (!sounds.some((clip) => HIT_NAME.test(named(clip)) && clip.start <= at + 4 && clipEnd(clip) >= at && clip.start >= at - 2 * second)) missing.push("a hit");
  if (!sounds.some((clip) => RISER_NAME.test(named(clip)) && clip.start < at && clipEnd(clip) >= at - 6)) missing.push("a riser");
  return missing;
}

/**
 * Whether a clip plays music: the team's library's (`<home>/library/music/…`),
 * or on another machine's copy any sound file a song long that isn't narration.
 */
function isMusic(clip: Clip, media: Media | undefined): boolean {
  if (clip.type !== "audio" || media === undefined || media.kind !== "audio" || clip.name === "Voice-over") return false;
  return media.path.includes("/library/music/") || media.duration >= 45;
}

/**
 * Deterministic review catches mechanical issues without asking a model to
 * inspect dozens of pictures. Visual/factual judgment still needs a contact sheet.
 */
/** More video tracks than this (and than the most clips on screen at once) is `too_many_tracks`. */
const MOST_VIDEO_TRACKS = 12;

/** The smallest callout, tag or label in a courtroom video, px at 1080p (`small_text`). */
const SMALLEST_TEXT = 60;

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
  if (project.style === "commentary") {
    return { issues: sortIssues([...issues, ...commentaryAudit.issues(project)]), frames: total, clips: project.clips.length };
  }
  // The same picture shown in more than one place in the video (the team:
  // "the same images again and again and again… it's just annoying").
  // House pictures (the wallpaper, window frames) don't count, nor a
  // person's photo in their File Viewer or inset: each person keeps the one
  // photo they were introduced with ("I think we should stick to one
  // image… that'll make it a lot easier for the viewer").
  const faces = new Set(
    project.clips
      .filter((clip) => clip.type === "video" && /^(File Viewer|Photo inset)/u.test(clip.name ?? ""))
      .map((clip) => (clip as Extract<Clip, { type: "video" }>).media),
  );
  const shownAt = new Map<string, [number, number][]>();
  for (const clip of project.clips) {
    if (clip.type !== "video" || !visible(clip.track)) continue;
    const media = mediaOf(project, clip.media);
    if (media === undefined || media.kind !== "image" || /[\\/]graphics[\\/]/.test(media.path) || faces.has(media.id)) continue;
    const list = shownAt.get(media.id) ?? [];
    list.push([clip.start, clipEnd(clip)]);
    shownAt.set(media.id, list);
  }
  for (const [mediaId, spans] of shownAt) {
    spans.sort((a, b) => a[0] - b[0]);
    const places: [number, number][] = [];
    for (const [from, to] of spans) {
      const last = places[places.length - 1];
      if (last !== undefined && from <= last[1] + 2 * fps) last[1] = Math.max(last[1], to);
      else places.push([from, to]);
    }
    if (places.length > 1) issues.push({ kind: "repeated_picture", media: mediaId, at: places.map(([from]) => from) });
  }
  // The Windows screen on most cut-ins (the team: "every single cut-in is
  // now doing this. This is not good"): about half at most, footage first.
  const cutIns = (project.script?.blocks ?? []).filter((block) => block.kind === "narration").length;
  const desktops = project.clips.filter((clip) => (clip.name ?? "").endsWith("Desktop · wallpaper")).length;
  if (cutIns >= 4 && desktops > Math.max(2, Math.round(cutIns * 0.5))) issues.push({ kind: "windows_overused", desktops, cut_ins: cutIns });
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
    if (!["Drop", "Flash", "Dip", "Light leak", "Bridge flash"].includes(clip.name ?? "")) continue;
    const middle = clip.start + idiv(clip.duration, 2);
    const sounded = heard.some(
      ([start, stop]) => Math.abs(start - middle) <= near || (stop - start <= short && start <= middle && middle <= stop + near),
    );
    if (!sounded) issues.push({ kind: "silent_transition", clip: clip.id, at: middle });
  }
  // Every picture that pops up is heard (the team: "have a click effect
  // here"; "a file viewer image pop-up… with a subtle click effect"): a
  // File Viewer, photo inset, name box or pause with no short sound starting
  // from 0.7 s before it to 0.3 s after. One per moment (a viewer's frame,
  // picture and name open together).
  const before = asInt(round(0.7 * fps));
  const after = asInt(round(0.3 * fps));
  const popped: number[] = [];
  for (const clip of [...project.clips].sort((a, b) => a.start - b.start)) {
    const name = clip.name ?? "";
    if (!/^(File Viewer|Photo inset|Name callout|name box|Pause\b)/iu.test(name) || name.startsWith("Pause ·")) continue;
    if (popped.some((at) => Math.abs(at - clip.start) <= after)) continue;
    popped.push(clip.start);
    const sounded = heard.some(([start, stop]) => stop - start <= short && start >= clip.start - before && start <= clip.start + after);
    if (!sounded) issues.push({ kind: "silent_popup", clip: clip.id, at: clip.start, fix: "a soft click on it (add_from_library, ~8 LU under the speech)" });
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
  // B-roll that holds one shot too long: the team wants cut-ins alive, a new
  // shot on each thing the narration names (Mom Leaves 5 Kids: shots of 7–11 s
  // under narration, "we need more clips", "change clips more frequently").
  // Only what's seen of it counts: a photo, a File Viewer or words over part
  // of a shot break it up (the longest stretch with nothing over it).
  const longest = asInt(round(LONGEST_BROLL_SHOT * fps));
  const over = project.clips.filter(
    (clip) =>
      visible(clip.track) &&
      ((clip.type === "video" && !(clip.name ?? "").includes("B-roll:")) ||
        (clip.type === "text" && !/^(Subtitle|Caption|Countdown|Film look · tag)/u.test(clip.name ?? "") && trackOf(project, clip.track)?.subtitles !== true)),
  );
  for (const clip of project.clips) {
    if (clip.type !== "video" || clip.track === base || !(clip.name ?? "").includes("B-roll:")) continue;
    if (clip.duration <= longest) continue;
    const own = level(clip.track);
    const seen = new Uint8Array(clip.duration).fill(1);
    for (const other of over) {
      if (level(other.track) <= own) continue;
      for (let frame = Math.max(other.start, clip.start); frame < Math.min(clipEnd(other), clipEnd(clip)); frame++) seen[frame - clip.start] = 0;
    }
    let run = 0;
    let most = 0;
    for (const one of seen) {
      run = one === 1 ? run + 1 : 0;
      most = Math.max(most, run);
    }
    if (most > longest) {
      issues.push({
        kind: "long_broll_shot",
        clip: clip.id,
        start: clip.start,
        seconds: round((most / fps) * 10) / 10,
        fix: "a new shot every ~3–4 s (cover_cut_in again with more shots: other moments, a punch-in on a face), or a picture over the stretch",
      });
    }
  }
  // Music: a song's good part is usually its opening (often only the first
  // 10–20 s), so a bed that runs on past it, the same song under cut-in after
  // cut-in, and a bed that stops while the narration carries on all came
  // back from the team as "change the music".
  const music = project.clips.filter(
    (clip): clip is Extract<Clip, { type: "audio" }> =>
      visible(clip.track) && isMusic(clip, clip.type === "audio" ? mediaOf(project, clip.media) : undefined),
  );
  const longestBed = project.style === "interrogation" ? LONGEST_SECTION_BED : LONGEST_BED;
  // A bed that covers one narration longer than that and no more can't be
  // shorter without stopping under it (music_stops_mid_narration) or changing
  // in it (music_change_mid_narration): Mom & Teen's 26–31 s cut-ins.
  const narrations = project.clips.filter((clip) => clip.type === "audio" && clip.name === "Voice-over");
  const grace = 2.5 * fps;
  for (const clip of music) {
    const played = (clip.duration / fps) * (clip.speed ?? 1);
    const oneNarration = narrations.some((voice) => voice.start - grace <= clip.start && clipEnd(clip) <= clipEnd(voice) + grace);
    if (played > longestBed && !oneNarration) {
      issues.push({ kind: "music_bed_long", clip: clip.id, start: clip.start, seconds: round(played * 10) / 10 });
    }
  }
  const songs = new Map<string, Clip[]>();
  for (const clip of music) {
    if (clip.type !== "audio") continue;
    songs.set(clip.media, [...(songs.get(clip.media) ?? []), clip]);
  }
  // An interrogation keeps a bed's family across its bridges (the references
  // do); the same song again and again is a bodycam habit to break.
  const often = project.style === "interrogation" ? 6 : 3;
  for (const [media, clips] of songs) {
    if (clips.length < often) continue;
    issues.push({
      kind: "music_repeated",
      media,
      name: mediaOf(project, media)?.name ?? media,
      starts: clips.map((clip) => clip.start).sort((a, b) => a - b),
    });
  }
  const second = asInt(round(fps));
  for (const clip of music) {
    const stop = clipEnd(clip);
    const talking = voiceovers.find(([start, until]) => start < stop && until - stop > second);
    const carried = music.some((other) => other !== clip && other.start <= stop + idiv(second, 2) && clipEnd(other) > stop + idiv(second, 2));
    if (talking !== undefined && !carried) {
      issues.push({ kind: "music_stops_mid_narration", clip: clip.id, at: stop, narration_left: round(((talking[1] - stop) / fps) * 10) / 10 });
    }
  }
  // The music changes only where what we hear changes (a cut-in starting or
  // ending, the footage coming back, a new case, the outro), never in the
  // middle of a narration: Helpful Wife's prologue swapped songs under one
  // sentence ("We suddenly change the music right here. We need to do this in
  // a cleaner way, and we only need to change the music if there is some
  // switch in what we hear").
  for (const clip of music) {
    const under = voiceovers.find(([start, until]) => clip.start > start + second && clip.start < until - second);
    if (under === undefined) continue;
    issues.push({
      kind: "music_change_mid_narration",
      clip: clip.id,
      at: clip.start,
      narration: under,
      fix: "keep the bed that's playing to the narration's end (or start this one on the narration's first frame, with its transition); change music only where what we hear changes",
    });
  }
  // An interrogation's tape rolling is felt: a riser over the countdown's
  // last seconds, a hit on the first frame of the tape, the prologue's music
  // cut there, not faded on under the room ("we need to be able, as viewers,
  // to know and feel that, 'Okay, now the video starts.'").
  if (project.style === "interrogation") {
    const counts = project.clips.filter((clip) => clip.type === "text" && clip.name === "Countdown" && visible(clip.track));
    if (counts.length > 0) {
      const tape = Math.max(...counts.map(clipEnd));
      const missing: string[] = cutSounds(project, tape).map((one) => (one === "a hit" ? "a hit on the tape's first frame" : "a riser building into it"));
      const runsOn = music.find((clip) => clip.start < tape && clipEnd(clip) > tape + idiv(second, 2));
      if (runsOn !== undefined) missing.push(`the prologue's music (${runsOn.id}) cut on the tape's first frame`);
      if (missing.length > 0) issues.push({ kind: "tape_start_unmarked", at: tape, missing });
    }
  }
  // A found photo or still as plain B-roll (letterboxed, often): pictures go
  // on screen only inside a designed graphic (an evidence card or board).
  issues.push(...graphics.bareStills(project));
  // Footage or a photo with black bars round it.
  issues.push(...framing.letterboxedIssues(project));
  // A vignette snapping on or off.
  issues.push(...vignettes.issues(project));
  // An edit's subtitles off the bottom middle (moved to a face or a corner).
  if (project.script !== undefined && project.script !== null) {
    const moved = seams.subtitles.movedSubtitles(project);
    if (moved.length > 0) issues.push({ kind: "subtitle_moved", count: moved.length, clips: moved.slice(0, 12), fix: "place_subtitles puts them all back at the bottom middle (the rest of the video's subtitles never move)" });
  }
  // The date in a box or glowing: it's white with a drop shadow only.
  issues.push(...graphics.dateDrift(project));
  // A subtitle or intro caption on someone's face (faces found so far).
  issues.push(...(hooks.textOnFaces(project) as Record<string, unknown>[]));
  // A window or inset over a face.
  issues.push(...(hooks.picturesOnFaces(project) as Record<string, unknown>[]));
  // Words under a blur (a redaction or a title's blur on a track above
  // them) are blurred with the picture: text goes above every blur over it.
  const blurs = project.clips.filter(
    (clip) => clip.type === "adjustment" && visible(clip.track) && (clip.blur?.radius ?? 0) > 0 && (clip.opacity ?? 1) > 0,
  );
  // Any blur at all above them while they're up (the team: "all blurrings
  // must always be under the subtitles"), wherever its box is: a box that
  // missed the words by its estimate still sat over Mom & Teen's captions.
  for (const text of project.clips) {
    if (text.type !== "text" || !visible(text.track)) continue;
    const over = blurs.find(
      (blur) => level(blur.track) > level(text.track) && blur.start < clipEnd(text) && clipEnd(blur) > text.start,
    );
    if (over !== undefined) issues.push({ kind: "text_under_blur", clip: text.id, blur: over.id, start: Math.max(text.start, over.start) });
  }
  // An edit taller than it needs: plans pack their tracks down, but tools
  // that add their own can still pile them up (69 in an interrogation intro).
  // Only past what the edit needs: the most clips ever on screen at once (an
  // evidence board's photos and notes are a dozen at once, legitimately).
  const videoTracks = project.tracks.filter((track) => track.kind === "video");
  const videoIds = new Set(videoTracks.map((track) => track.id));
  // One sweep over starts (+1) and ends (-1), ends first at a tie.
  const edges = project.clips
    .filter((clip) => videoIds.has(clip.track))
    .flatMap((clip) => [[clip.start, 1], [clipEnd(clip), -1]] as [number, number][])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let peak = 0;
  let open = 0;
  for (const [, step] of edges) {
    open += step;
    peak = Math.max(peak, open);
  }
  const needed = Math.max(peak + 1, MOST_VIDEO_TRACKS);
  if (videoTracks.length > needed) issues.push({ kind: "too_many_tracks", video_tracks: videoTracks.length, needed, fix: "tidy_tracks" });
  // A line said under black: an opaque black solid over the picture while a
  // subtitle is up (the interrogation's cold open ended in a second of black
  // with "Stephanie, here's the situation." heard and subtitled over it; the
  // team: "this just black layer on top of the sort of teaser… I don't think
  // it quite works"). The black is silent: a last line plays in picture.
  for (const black of project.clips) {
    if (black.type !== "solid" || !visible(black.track) || black.opacity < 0.95 || black.keyframes?.opacity !== undefined) continue;
    if (Math.max(black.fill[0], black.fill[1], black.fill[2]) > 0.05 || black.fill[3] < 0.95 || black.duration < 10) continue;
    for (const line of project.clips) {
      if (line.type !== "text" || !visible(line.track)) continue;
      if (!((line.name ?? "").startsWith("Subtitle") || trackOf(project, line.track)?.subtitles === true)) continue;
      const shared = Math.min(clipEnd(black), clipEnd(line)) - Math.max(black.start, line.start);
      if (shared >= 6) {
        issues.push({ kind: "line_under_black", clip: black.id, subtitle: line.id, start: Math.max(black.start, line.start), end: Math.min(clipEnd(black), clipEnd(line)), text: line.text.slice(0, 40), fix: "the black is silent: play the line in picture before it (or end it before the black)" });
      }
    }
  }
  // A courtroom video's words on screen are read on a phone over a busy
  // hearing: callouts, tags and labels at least SMALLEST_TEXT at 1080p
  // (Corrupt Cop's 44 px name callout and "*UNDER OATH*" tag: "text is
  // really small here, it should be bigger"). Subtitles and the desktop
  // profile's own window text keep their sizes.
  if (project.style === "courtroom") {
    const scale = project.settings.height / 1080;
    for (const text of project.clips) {
      if (text.type !== "text" || !visible(text.track)) continue;
      const name = text.name ?? "";
      if (trackOf(project, text.track)?.subtitles === true || /^(Subtitle|Caption|Desktop profile)/u.test(name)) continue;
      const size = text.style.size / scale;
      if (size < SMALLEST_TEXT) issues.push({ kind: "small_text", clip: text.id, start: text.start, size: round(size), at_least: SMALLEST_TEXT, text: text.text.slice(0, 40) });
    }
  }
  // "actual image" / "actual footage" only on a picture filling the screen,
  // never over one in a window (the team: "remove actual image text on all
  // these photo / video viewers on the windows screen (throughout the entire
  // project)").
  const windows = project.clips.filter((clip) => visible(clip.track) && /Photo Viewer|Video Player|File Viewer/u.test(clip.name ?? ""));
  for (const text of project.clips) {
    if (text.type !== "text" || !visible(text.track) || !/\bactual (image|footage|photo|video)\b/iu.test(text.text)) continue;
    const over = windows.find((window) => window.start < clipEnd(text) && text.start < clipEnd(window));
    if (over !== undefined) issues.push({ kind: "actual_label_in_window", clip: text.id, start: text.start, text: text.text.slice(0, 40), window: over.name, fix: "delete it: the label is only for a picture filling the screen" });
  }
  // The house's subtitles have white words (who says them is the name label's
  // colour), and a courtroom video's, with no label, never change by speaker
  // (the team: "for courtroom videos we have the text for subtitles be white
  // and not change by subject"). A Repack-style line's words carry its colour.
  for (const text of project.clips) {
    if (text.type !== "text" || !visible(text.track) || !/^Subtitle/u.test(text.name ?? "")) continue;
    if (text.style.label == null && project.style !== "courtroom") continue;
    const [r, g, b] = text.style.color;
    if (Math.min(r, g, b) < 0.95) issues.push({ kind: "subtitle_coloured", clip: text.id, start: text.start, text: text.text.slice(0, 40), fix: "update_clips on the subtitles track: style.color [1,1,1,1]" });
  }
  return { issues: sortIssues(issues), frames: total, clips: project.clips.length };
}

/** Issues in the order Rust's `sort_by_key(Value::to_string)` left them: by their compact JSON. */
export function sortIssues<T>(issues: T[]): T[] {
  return issues
    .map((issue) => [stableStringify(issue), issue] as const)
    .sort((a, b) => compareStrings(a[0], b[0]))
    .map(([, issue]) => issue);
}

/**
 * A left-aligned text whose words change keeps its left edge (its x is its
 * box's centre): Helpful Wife's Notepad line "- Nothing more to add?",
 * reworded after the desktop was built, grew out of both sides and over the
 * window's left edge. Not when the patch places it itself.
 */
function keepLeftEdge(before: Clip, after: Clip, patch: Args): void {
  if (before.type !== "text" || after.type !== "text" || before.text === after.text) return;
  if (after.style?.align !== "left" || patch.transform !== undefined || (patch.keyframes as Args | undefined)?.x !== undefined) return;
  const style = after.style;
  const width = (text: string) => native().textBlock(text, style.size ?? 40, style.weight ?? 400, style.line_height ?? 1.15)[0];
  const grow = (width(after.text) - width(before.text)) / 2;
  if (!Number.isFinite(grow) || Math.abs(grow) < 0.5) return;
  const scaleAt = (frame: number) => after.keyframes?.scale?.find((key) => key.frame === frame)?.value ?? after.transform.scale ?? 1;
  after.transform = { ...after.transform, x: after.transform.x + grow * (after.transform.scale ?? 1) };
  const xs = after.keyframes?.x;
  if (xs !== undefined && xs !== null) {
    for (const key of xs) key.value += grow * scaleAt(key.frame);
  }
}
