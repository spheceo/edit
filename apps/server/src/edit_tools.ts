// The editing tools : reading the edit
// (get_project, get_edit_context, review_edit), changing it (apply_edit_plan,
// add_text, add_clip, update_clip(s), delete_clips, set_keyframes, set_in_out,
// markers, remove_time, tidy_tracks, cover_cut_in), media (import_media,
// still_frame, add_sound_effect), looking (render_frame, contact_sheet,
// look_at_media), export, skills, and batch. Every mutation goes through the
// store, so the open UI updates live. Agents read their text: change it
// with care.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import { clipColorFrom, clipFrom, defaultTextAnimation, defaultTextStyle, defaultTransform, keyframesFrom, textAnimationFrom, textStyleFrom, transformFrom } from "./clips.ts";
import * as cutin from "./cutin.ts";
import * as diag from "./diag.ts";
import * as editPlan from "./edit_plan.ts";
import { ioMessage } from "./files.ts";
import { isBug } from "./guard.ts";
import { houseMedia, houseMediaSaved, importPaths } from "./import.ts";
import * as markers from "./markers.ts";
import { call, ORIGIN } from "./mcp/index.ts";
import { handlerFor, image, registerTool, text, type Content, type ToolCall } from "./mcp/registry.ts";
import type { Clip, ExportOptions, Marker, Media, Project } from "./model.ts";
import { native, withProject, withProjectAsync, type EncodedImage, type ProjectInput } from "./native/index.ts";
import { expandHome, join } from "./paths.ts";
import {
  addTrack,
  clipEnd,
  clipOf,
  duration as durationOf,
  fps as fpsOf,
  freeTrack,
  freeTrackFrom,
  freshId,
  inOut,
  merge,
  mergeClip,
  tidyTracks,
  touchesPeople,
  trackLabel,
  trackOf,
} from "./project.ts";
import { asInt, byteLength, debugInts, debugStr, debugStrings, f32Saved as f32, fixed, isAlphanumeric, jsonForSerde, round, serdeParse, signed32, takeChars, trim } from "./rust.ts";
import * as seams from "./seams.ts";
import { read, readStruct, SerdeError, type Field, type Struct } from "./serde.ts";
import * as sfx from "./sfx.ts";
import { compareKeys, stableStringify } from "./stable.ts";
import { isSubtitled, UpdateError, type Live, type Store } from "./store.ts";
import * as styles from "./styles.ts";
import type { Transcript } from "./transcribe.ts";

type Args = Record<string, unknown>;
type Json = unknown;

/**
 * What these tools reach in other packages, through their seams (the
 * exports path, people, review, B-roll and library, the watcher). Tests put
 * their own in.
 */
export const hooks = {
  peopleSummary: (project: Project): Record<string, string> => seams.people.summary(project),
  calloutTiming: (project: Project, transcripts: Map<string, Transcript>): Json[] =>
    seams.editReview.calloutTiming(project, transcripts),
  subtitleCoverage: (project: Project, transcripts: Map<string, Transcript>): Json =>
    seams.editReview.subtitleCoverage(project, transcripts),
  smoothingPending: (projectId: string): string[] => seams.broll.smoothingPending(projectId),
  // Nothing to smooth starts nothing, so a plan or cover without slowed
  // shots never reaches for B-roll after it saved.
  smoothInBackground: (app: App, projectId: string, clipIds: string[]): string[] =>
    clipIds.length === 0 ? [] : seams.broll.smoothInBackground(app, projectId, clipIds),
  waitForSmoothing: (projectId: string, limitMs: number): Promise<boolean> =>
    seams.broll.waitForSmoothing(projectId, limitMs),
  waitForMaps: (app: App, projectId: string, limitMs: number): Promise<void> =>
    seams.broll.waitForMaps(app, projectId, limitMs),
  mapExportWait: (): number => seams.broll.MAP_EXPORT_WAIT,
  watchInBackground: (app: App, projectId: string): void => seams.watch.watchInBackground(app, projectId),
  defaultExportPath: (store: Store, project: Project): string => seams.server.defaultExportPath(store, project),
  footageLoudness: (project: Project): Promise<number> => seams.library.footageLoudness(project),
  loudness: (path: string, from: number, seconds: number): Promise<number> => seams.library.loudness(path, from, seconds),
};

// ---------------------------------------------------------------------------
// Small readers of the arguments (serde_json's `as_*`)

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);
const int = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) ? value : null);
const uint = (value: unknown): number | null => {
  const given = int(value);
  return given !== null && given >= 0 ? given : null;
};
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const isNull = (value: unknown) => value === undefined || value === null;
const clamp = (x: number, low: number, high: number) => Math.min(Math.max(x, low), high);

/** `serde_json::from_value::<Vec<String>>`, its error as serde words it. */
function strings(value: unknown, prefix = ""): string[] {
  try {
    return read({ vec: "string" }, value ?? null) as string[];
  } catch (error) {
    if (error instanceof SerdeError) throw new Error(`${prefix}${error.message}`);
    throw error;
  }
}

function serde<T>(prefix: string, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof SerdeError) throw new Error(`${prefix}${error.message}`);
    throw error;
  }
}

function live(app: App, id: string, missing = "project vanished"): Live {
  const found = app.store.get(id);
  if (found === null) throw new Error(missing);
  return found;
}

/** Native work on a live project, by reference (re-sent as JSON when the addon no longer holds it). */
function onLive<T>(found: Live, work: (input: ProjectInput) => T): T {
  return withProject(found.project.id, found.rev, () => JSON.stringify(found.project), work);
}

function onLiveAsync<T>(found: Live, work: (input: ProjectInput) => Promise<T>): Promise<T> {
  return withProjectAsync(found.project.id, found.rev, () => JSON.stringify(found.project), work);
}

/** An image as MCP content: the picture, then its caption. */
function imageContent(picture: EncodedImage, caption: string): Content[] {
  return image(picture.data, caption, picture.mime);
}

/** Replaces `target`'s fields with `source`'s (a project changed by the addon, in a store update). */
function replaceContents(target: Project, source: Project): void {
  for (const key of Object.keys(target)) delete (target as unknown as Args)[key];
  Object.assign(target, source);
}

// ---------------------------------------------------------------------------
// Registration

const TOOLS: [string, (call: ToolCall) => Promise<Content[]> | Content[]][] = [
  ["skill", skill],
  ["get_edit_context", getEditContext],
  ["apply_edit_plan", applyEditPlan],
  ["review_edit", reviewEdit],
  ["get_project", getProject],
  ["add_text", addText],
  ["add_clip", addClip],
  ["update_clip", updateClip],
  ["update_clips", updateClips],
  ["batch", ({ app, args, scope }) => runBatch(app, args, scope)],
  ["cover_cut_in", coverCutIn],
  ["set_in_out", setInOut],
  ["delete_clips", deleteClips],
  ["set_keyframes", setKeyframes],
  ["import_media", importMedia],
  ["still_frame", stillFrame],
  ["markers", markersTool],
  ["add_sound_effect", addSoundEffect],
  ["remove_time", removeTime],
  ["tidy_tracks", tidyTracksTool],
  ["render_frame", renderFrame],
  ["contact_sheet", contactSheet],
  ["look_at_media", lookAtMedia],
  ["export", exportTool],
];

/** Registers the editing tools with the MCP server (once; later calls do nothing). */
export function registerEditingTools(): void {
  for (const [name, handler] of TOOLS) {
    if (handlerFor(name)?.handler === handler) continue;
    registerTool(name, handler);
  }
}

/** The names of the tools this package answers. */
export const EDITING_TOOLS = TOOLS.map(([name]) => name);

// ---------------------------------------------------------------------------
// The tools

function skill({ app, args, projectId }: ToolCall): Content[] {
  const name = str(args.name);
  if (name === null) throw new Error("name is required");
  const style = live(app, projectId).project.style;
  const found = styles.skill(style, name);
  if (found === undefined) throw new Error(`no skill ${name}; there are ${styles.skillNames(style).join(", ")}`);
  if (found.name === "edit-workflow") {
    // Who says each line takes the watcher a minute or two: by the subtitles stage it's cached.
    try {
      hooks.watchInBackground(app, projectId);
    } catch (error) {
      diag.warn("watch", `${projectId}: ${diag.messageOf(error)}`);
    }
  }
  return text(found.body);
}

function getEditContext({ app, args, projectId }: ToolCall): Content[] {
  return text(stableStringify(editContext(app, live(app, projectId), args)));
}

async function applyEditPlan({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const base = uint(args.base_rev);
  if (base === null) throw new Error("base_rev is required");
  if (!Array.isArray(args.operations)) throw new Error("operations must be a list");
  const operations = args.operations as Json[];
  const frames = reviewFrames(args.review_frames);
  const current = app.store.checkout(projectId);
  if (current === null) throw new Error("project vanished");
  if (current.rev !== base) {
    throw new Error(`revision conflict: expected ${base}, current ${current.rev}; nothing saved; refresh get_edit_context`);
  }
  const project = current.project;
  const [assets, house] = await planAssets(app, project, operations);
  const applied = diag.timeOn("agent", "plan: apply and validate", projectId, () =>
    editPlan.applyWith(project, operations, assets),
  );
  const dryRun = bool(args.dry_run) ?? false;
  const audit = audited(app, project, null);
  let saved: { rev: number; project: Project };
  if (dryRun) {
    saved = { rev: base, project };
  } else {
    try {
      saved = await app.store.replace(projectId, base, project, ORIGIN);
    } catch (error) {
      if (!(error instanceof UpdateError)) throw error;
      switch (error.kind) {
        case "not_found":
          throw new Error("project was deleted; nothing saved");
        case "conflict":
          throw new Error(`revision conflict: current ${error.live?.rev ?? "?"}; nothing saved`);
        default:
          throw new Error(error.message);
      }
    }
  }
  let smoothing: string[] = [];
  if (!dryRun) {
    houseMediaSaved(app, house);
    smoothing = hooks.smoothInBackground(app, projectId, applied.smooth);
  }
  const report = {
    rev: saved.rev,
    saved: !dryRun,
    results: applied.results,
    audit,
    smoothing_started: smoothing,
  };
  const input: ProjectInput = dryRun ? { json: jsonForSerde(saved.project) } : { ref: { id: projectId, rev: saved.rev } };
  return withReview(saved.project, input, frames, report);
}

async function reviewEdit({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const frames = reviewFrames(args.frames);
  const found = live(app, projectId);
  const report = {
    rev: found.rev,
    audit: audited(app, found.project, found.rev),
    subtitle_coverage: hooks.subtitleCoverage(found.project, cachedTranscripts(app, found.project, true)),
    smoothing: hooks.smoothingPending(projectId),
  };
  return withReview(found.project, { ref: { id: projectId, rev: found.rev } }, frames, report);
}

/**
 * The project as JSON, compact and within the context budget: a project too
 * big to send whole (1–2 MB on a long edit, cut off by the model's client
 * long before the end) gives its clips in timeline order up to the budget and
 * says where to carry on. `start` / `end` (seconds) narrow the clips to a span.
 */
function getProject({ app, args, projectId }: ToolCall): Content[] {
  const found = live(app, projectId);
  const project = found.project;
  const labels: Record<string, string | null> = {};
  for (const track of project.tracks) labels[track.id] = trackLabel(project, track.id);
  const total = durationOf(project);
  const fps = fpsOf(project);
  const from = num(args.start);
  const to = num(args.end);
  const first = from === null ? -Infinity : round(from * fps);
  const last = to === null ? Infinity : round(to * fps);
  const clips = project.clips.filter((clip) => clip.start < last && clip.start + clip.duration > first);
  const head: Record<string, unknown> = {
    rev: found.rev,
    duration_frames: total,
    duration_seconds: total / fps,
    track_labels: labels,
    sections: onLive(found, (input) => native().sections(input)),
    smoothing: hooks.smoothingPending(projectId),
  };
  const whole = stableStringify({ ...head, project: { ...project, clips } });
  if (whole.length <= BUDGET) return text(whole);
  // Clips in timeline order while they fit beside everything else.
  let room = BUDGET - stableStringify({ ...head, project: { ...project, clips: [] } }).length;
  const ordered = [...clips].sort((a, b) => a.start - b.start);
  const shown: typeof clips = [];
  for (const clip of ordered) {
    room -= stableStringify(clip).length + 1;
    if (room < 0 && shown.length > 0) break;
    shown.push(clip);
  }
  const next = ordered[shown.length];
  head.clips_shown = {
    shown: shown.length,
    of: clips.length,
    next_start_seconds: next === undefined ? null : next.start / fps,
    note: "The project is too big to send whole: call again with start (seconds) for the clips after these, or use get_edit_context.",
  };
  return text(stableStringify({ ...head, project: { ...project, clips: shown } }));
}

async function addText({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const fps = fpsOf(live(app, projectId).project);
  const startGiven = num(args.start);
  if (startGiven === null) throw new Error("start is required");
  const start = asInt(round(startGiven * fps));
  const durationGiven = num(args.duration);
  if (durationGiven === null) throw new Error("duration is required");
  const length = Math.max(asInt(round(durationGiven * fps)), 1);
  const style = serde("style: ", () => textStyleFrom(merge(defaultTextStyle() as never, (args.style ?? null) as never)));
  const animation = serde("animation: ", () =>
    textAnimationFrom(merge(defaultTextAnimation() as never, (args.animation ?? null) as never)),
  );
  const transform = serde("transform: ", () => transformFrom(merge(defaultTransform() as never, (args.transform ?? null) as never)));
  const color = isNull(args.color) ? "pink" : serde("color: ", () => clipColorFrom(args.color));
  const content = str(args.text);
  if (content === null) throw new Error("text is required");
  const track = str(args.track);
  const [, clipId] = await app.store.update(projectId, ORIGIN, (project) => {
    const on = track ?? freeTrack(project, "video", start, start + length);
    const id = freshId(project, "c");
    project.clips.push({
      id,
      track: on,
      start,
      duration: length,
      color: color as Clip["color"],
      fade_in: 0,
      fade_out: 0,
      type: "text",
      text: content,
      style,
      transform,
      animation,
      opacity: 1,
    });
    return id;
  });
  return text(`added text clip ${clipId}`);
}

async function addClip({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const given = args.clip;
  if (typeof given !== "object" || given === null || Array.isArray(given)) throw new Error("clip must be an object");
  const [, clipId] = await app.store.update(projectId, ORIGIN, (project) => {
    const fields = { ...(given as Args) };
    const id = freshId(project, "c");
    fields.id = id;
    const kind = fields.type === "audio" ? "audio" : "video";
    const number = (key: string, fallback: number) => int(fields[key]) ?? fallback;
    const track = str(fields.track);
    if (track === "new") {
      fields.track = addTrack(project, kind);
    } else if (track === null) {
      const start = number("start", 0);
      fields.track = freeTrack(project, kind, start, start + number("duration", 1));
    }
    project.clips.push(serde("clip: ", () => clipFrom(fields)));
    return id;
  });
  return text(`added clip ${clipId}`);
}

async function updateClip({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const clipId = str(args.clip_id);
  if (clipId === null) throw new Error("clip_id is required");
  const patch = args.patch ?? null;
  await app.store.update(projectId, ORIGIN, (project) => {
    const index = project.clips.findIndex((clip) => clip.id === clipId);
    if (index < 0) throw new Error(`no clip ${clipId}`);
    const value = mergeClip(structuredClone(project.clips[index]!) as unknown as Args, structuredClone(patch));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) value.id = clipId;
    project.clips[index] = serde("patched clip is invalid: ", () => clipFrom(value));
    if (touchesPeople(objectOf(patch))) editPlan.hooks.oneColourPerPerson(project);
  });
  const clip = app.store.get(projectId)?.project.clips.find((own) => own.id === clipId) ?? null;
  // serde_json::to_string of the clip: its fields in their own order.
  return text(`updated ${clipId}: ${JSON.stringify(clip)}`);
}

const objectOf = (value: unknown): Args =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Args) : {};

async function updateClips({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const patch = args.patch;
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new Error("patch must be an object");
  const ids = isNull(args.clip_ids) ? null : strings(args.clip_ids);
  const label = str(args.label);
  const track = str(args.track);
  if (ids === null && label === null && track === null) throw new Error("pick the clips: clip_ids, label or track");
  const [, [changed, people]] = await app.store.update(projectId, ORIGIN, (project) => {
    const fps = fpsOf(project);
    const fromGiven = num(args.start);
    const toGiven = num(args.end);
    const from = fromGiven === null ? null : asInt(round(fromGiven * fps));
    const to = toGiven === null ? null : asInt(round(toGiven * fps));
    if (ids !== null) {
      const missing = ids.find((id) => clipOf(project, id) === undefined);
      if (missing !== undefined) throw new Error(`no clip ${missing}`);
    }
    const changed: string[] = [];
    project.clips = project.clips.map((clip) => {
      const picked =
        (ids === null || ids.includes(clip.id)) &&
        (track === null || clip.track === track) &&
        (from === null || clip.start >= from) &&
        (to === null || clip.start < to) &&
        (label === null || (clip.type === "text" && clip.style?.label?.text === label));
      if (!picked) return clip;
      const value = mergeClip(structuredClone(clip) as unknown as Args, structuredClone(patch));
      value.id = clip.id;
      const next = serde(`patched ${clip.id} is invalid: `, () => clipFrom(value));
      changed.push(clip.id);
      return next;
    });
    // A relabel or recolour: one colour per person, everywhere.
    const people = touchesPeople(patch as Args) && changed.length > 0 ? editPlan.hooks.oneColourPerPerson(project) : null;
    return [changed, people] as const;
  });
  if (changed.length === 0) return text("no clips matched; nothing changed");
  const said =
    people === null
      ? ""
      : `\npeople (one colour each, kept apart; a colour too near someone else's was changed): ${stableStringify(people)}`;
  return text(`updated ${changed.length} clip(s): ${changed.join(", ")}${said}`);
}

async function coverCutIn({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const [, [report, smooth]] = await app.store.update(projectId, ORIGIN, (project) => cutin.cover(project, args));
  report.smoothing_started = hooks.smoothInBackground(app, projectId, smooth);
  return text(stableStringify(report, 2));
}

async function setInOut({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const fps = fpsOf(live(app, projectId).project);
  // Absent: left as it is; given but not a number (null): cleared.
  const frame = (key: string): number | null | undefined => {
    if (!(key in args)) return undefined;
    const seconds = num(args[key]);
    return seconds === null ? null : asInt(Math.max(round(seconds * fps), 0));
  };
  const [start, end] = [frame("in"), frame("out")];
  const [, span] = await app.store.update(projectId, ORIGIN, (project) => {
    if (start !== undefined) {
      if (start === null) delete project.mark_in;
      else project.mark_in = start;
    }
    if (end !== undefined) {
      if (end === null) delete project.mark_out;
      else project.mark_out = end;
    }
    return inOut(project);
  });
  if (span === null) return text("in and out points cleared");
  const [from, to] = span;
  return text(`in/out: ${fixed(from / fps, 2)}s to ${fixed(to / fps, 2)}s (${to - from} frames)`);
}

async function deleteClips({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const ids = strings(args.clip_ids);
  const closeGap = bool(args.close_gap) ?? false;
  const dropFromScript = bool(args.drop_from_script) ?? false;
  const [, [removed, closed]] = await app.store.update(projectId, ORIGIN, (project) => {
    const gone = project.clips.filter((clip) => ids.includes(clip.id));
    project.clips = project.clips.filter((clip) => !ids.includes(clip.id));
    if (dropFromScript && project.script !== undefined && project.script !== null) {
      project.script.blocks = project.script.blocks.filter(
        (block) => !(block.kind === "narration" && typeof block.clip === "string" && ids.includes(block.clip)),
      );
    }
    return [gone.length, closeGap ? closeGaps(project, gone) : 0] as const;
  });
  return text(closed > 0 ? `deleted ${removed} clip(s); closed ${closed} frame(s) of gap` : `deleted ${removed} clip(s)`);
}

async function setKeyframes({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const clipId = str(args.clip_id);
  if (clipId === null) throw new Error("clip_id is required");
  const param = str(args.param);
  if (param === null) throw new Error("param is required");
  const keys = serde("keyframes: ", () => keyframesFrom(args.keyframes ?? null)).sort((a, b) => a.frame - b.frame);
  const params = native().animatableParams();
  await app.store.update(projectId, ORIGIN, (project) => {
    const clip = clipOf(project, clipId);
    if (clip === undefined) throw new Error(`no clip ${clipId}`);
    const allowed = params[clip.type] ?? [];
    if (!allowed.includes(param)) throw new Error(`${param} is not animatable here; use one of ${allowed.join(", ")}`);
    const own = { ...(clip.keyframes ?? {}) };
    if (keys.length === 0) delete own[param];
    else own[param] = keys;
    editPlan.setKeyframes(clip, own);
  });
  return text(`set ${param} keyframes on ${clipId}`);
}

async function importMedia({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const paths = strings(args.paths);
  const place = bool(args.place) ?? false;
  const [, added, errors] = await importPaths(app, projectId, paths, place, ORIGIN);
  return text(`imported media ${debugStrings(added)}${errors.length === 0 ? "" : `; errors: ${debugStrings(errors)}`}`);
}

async function stillFrame({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const mediaId = str(args.media_id);
  if (mediaId === null) throw new Error("media_id is required");
  const time = num(args.time);
  if (time === null) throw new Error("time is required");
  const found = live(app, projectId, "no such project");
  const media = found.project.media.find((own) => own.id === mediaId);
  if (media === undefined) throw new Error(`no media ${mediaId}`);
  if (!(time >= 0 && time <= media.duration)) throw new Error(`time must be 0 to ${fixed(media.duration, 2)} s`);
  const name = str(args.name) ?? "still";
  const label = takeChars(
    [...name].map((char) => (isAlphanumeric(char) || char === " " || char === "-" ? char : "_")).join(""),
    60,
  );
  const dir = app.store.uploadsDir(projectId);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new Error(ioMessage(error));
  }
  const out = join(dir, `${trim(label)} ${fixed(time, 2)}s.png`);
  await native().saveStill(structuredClone(media), time, out);
  const [, added, errors] = await importPaths(app, projectId, [out], false, ORIGIN);
  const still = added[0];
  if (still === undefined) throw new Error(`couldn't import the frame: ${debugStrings(errors)}`);
  return text(`saved the frame at ${fixed(time, 2)} s as image media ${still}`);
}

async function markersTool({ app, args, projectId }: ToolCall): Promise<Content[]> {
  if (isNull(args.add) && isNull(args.remove)) {
    return text(stableStringify({ markers: markers.listing(live(app, projectId).project, null) }));
  }
  const [, report] = await app.store.update(projectId, ORIGIN, (project) => markers.edit(project, args));
  return text(stableStringify(report));
}

async function addSoundEffect({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const name = str(args.sound);
  if (name === null) throw new Error("sound is required");
  const sound = sfx.find(name);
  if (sound === undefined) throw new Error(`no sound ${name}; use one of ${sfx.names().join(", ")}`);
  const times = soundTimes(app.store, projectId, args);
  const volumeDb = f32(num(args.volume_db) ?? 0);
  const path = sfx.path(app.store.home, sound);
  const [, added, errors] = await importPaths(app, projectId, [path], false, ORIGIN);
  const mediaId = added[0];
  if (mediaId === undefined) throw new Error(`couldn't import ${name}: ${debugStrings(errors)}`);
  const placed = await placeSound(app.store, projectId, mediaId, name, sfx.markers(sound), times, {
    volume_db: volumeDb,
    seconds: null,
    lead: null,
    fade_out: 0,
    color: "yellow",
  });
  return text(placed);
}

async function removeTime({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const fps = fpsOf(live(app, projectId).project);
  const frame = (key: string) => {
    const seconds = num(args[key]);
    if (seconds === null || !Number.isFinite(seconds) || seconds < 0) throw new Error(`${key} is required (seconds)`);
    return asInt(round(seconds * fps));
  };
  const [start, end] = [frame("start"), frame("end")];
  if (end <= start) throw new Error("end must come after start");
  const [, done] = await app.store.update(projectId, ORIGIN, (project) => {
    const cut = native().removeTime({ json: jsonForSerde(project) }, start, end);
    replaceContents(project, JSON.parse(cut.json) as Project);
    return cut.rippled;
  });
  return text(
    `removed ${fixed(done.frames / fps, 2)}s at ${fixed(start / fps, 2)}s: ${done.cut} clip(s) cut, ${done.deleted} deleted, ${done.moved} moved`,
  );
}

async function tidyTracksTool({ app, projectId }: ToolCall): Promise<Content[]> {
  const [, [moved, removed]] = await app.store.update(projectId, ORIGIN, (project) => tidyTracks(project));
  return text(`moved ${moved} clip(s) down, removed ${removed} empty track(s)`);
}

async function renderFrame({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const found = live(app, projectId);
  const fps = fpsOf(found.project);
  const given = int(args.frame);
  const time = num(args.time);
  const frame = given ?? (time !== null ? asInt(Math.floor(time * fps)) : 0);
  const max = uint(args.max_size) ?? 960;
  const images = await onLiveAsync(found, (project) =>
    native().renderFrames({ project, frames: [frame], maxSide: max, priority: "agent", encode: "agent" }),
  );
  const rendered = images[0];
  if (rendered === undefined) throw new Error("nothing was rendered");
  return imageContent(rendered, `frame ${frame} (${fixed(frame / fps, 2)}s)`);
}

async function contactSheet({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const found = live(app, projectId);
  const fps = fpsOf(found.project);
  const start = num(args.start);
  if (start === null) throw new Error("start is required");
  const endGiven = num(args.end);
  if (endGiven === null) throw new Error("end is required");
  const end = Math.max(endGiven, start);
  const count = clamp(uint(args.count) ?? 12, 1, 24);
  const columns = clamp(uint(args.columns) ?? 4, 1, 8);
  const frames = Array.from({ length: count }, (_, index) => {
    const t = count === 1 ? start : start + ((end - start) * index) / (count - 1);
    return asInt(Math.floor(t * fps));
  });
  const sheet = await onLiveAsync(found, (project) =>
    native().renderFrames({
      project,
      frames,
      maxSide: native().SHEET_CELL,
      priority: "agent",
      encode: "agent",
      sheetColumns: columns,
    }),
  );
  const rendered = sheet[0];
  if (rendered === undefined) throw new Error("nothing was rendered");
  const times = frames.map((frame) => `${fixed(frame / fps, 2)}s`);
  return imageContent(rendered, `${count} frames, left-to-right then down: ${times.join(", ")}`);
}

async function lookAtMedia({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const found = live(app, projectId);
  const mediaId = str(args.media_id);
  if (mediaId === null) throw new Error("media_id is required");
  const media = found.project.media.find((own) => own.id === mediaId);
  if (media === undefined) throw new Error(`no media ${mediaId}`);
  const start = Math.max(num(args.start) ?? 0, 0);
  const end = num(args.end) ?? media.duration;
  const count = clamp(uint(args.count) ?? 12, 1, 24);
  const columns = clamp(uint(args.columns) ?? 4, 1, 8);
  const { image: sheet, times } = await native().mediaFrames({
    media: structuredClone(media),
    start,
    end,
    count,
    maxSide: 480,
    sheetColumns: columns,
    encode: "agent",
  });
  const said = times.map((time) => `${fixed(time, 2)}s`);
  return imageContent(sheet, `${mediaId}: ${said.length} frames, left-to-right then down, at ${said.join(", ")}`);
}

/** The export dialog's options as `serde_json::from_value::<ExportOptions>` reads them (every field defaults). */
function exportOptions(value: unknown): ExportOptions {
  const defaults = native().exportDefaults() as unknown as Args;
  const option = (name: string, kind: Field["kind"]): Field => ({ name, kind: { option: kind }, default: () => defaults[name] ?? null });
  const choice = (name: string, rust: string, variants: string[]): Field => ({
    name,
    kind: { enum: rust, variants },
    default: () => defaults[name],
  });
  const flag = (name: string): Field => ({ name, kind: "bool", default: () => defaults[name] });
  const spec: Struct = {
    name: "ExportOptions",
    fields: [
      choice("format", "Format", ["h264", "hevc", "prores", "gif", "wav", "mp3", "png"]),
      option("range", { array: "i64", length: 2 }),
      choice("shape", "Shape", ["original", "vertical", "square", "portrait"]),
      choice("fill", "Fill", ["blur", "crop", "black"]),
      option("size", "u32"),
      option("fps", "u32"),
      choice("quality", "Quality", ["high", "balanced", "small"]),
      option("target_mb", "f64"),
      flag("hardware"),
      flag("wait_for_smoothing"),
      flag("audio"),
      option("loudness", "f64"),
      {
        name: "chapters",
        kind: {
          vec: {
            struct: {
              name: "Chapter",
              fields: [
                { name: "start", kind: "i64" },
                { name: "title", kind: "string" },
              ],
            },
          },
        },
        default: () => structuredClone(defaults.chapters ?? []),
      },
    ],
  };
  return serde("export options: ", () => readStruct(spec, value)) as unknown as ExportOptions;
}

async function exportTool({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const options = isNull(args.options) ? native().exportDefaults() : exportOptions(args.options);
  if (options.wait_for_smoothing && !(await hooks.waitForSmoothing(projectId, 120_000))) {
    throw new Error(
      "optional optical flow is still running; export the current timeline with wait_for_smoothing false or wait for it to finish",
    );
  }
  // A map shot still rendering would export as its first frame.
  await hooks.waitForMaps(app, projectId, hooks.mapExportWait());
  const found = live(app, projectId);
  const given = str(args.path);
  const path = given !== null && trim(given) !== "" ? expandHome(given) : hooks.defaultExportPath(app.store, found.project);
  const subtitled = isSubtitled(found.project);
  const started = await app.exports.start(
    app.store,
    app.library,
    structuredClone(found.project) as Project,
    options,
    path,
  );
  let said = `export started → ${started}`;
  if (subtitled) {
    said +=
      ". A whole subtitled video is uploaded to the team's Subtitles folder on Google Drive when it's done; the link is then the project's drive.url (get_edit_context).";
  }
  return text(said);
}

// ---------------------------------------------------------------------------
// Reviewing

function reviewFrames(value: unknown): number[] {
  const frames = isNull(value) ? [] : (serde("frames: ", () => read({ vec: "i64" }, value)) as number[]);
  if (frames.length > 24 || frames.some((frame) => frame < 0)) throw new Error("give at most 24 nonnegative integer frames");
  return frames;
}

/** The report as text, then (asked for) one sheet of the review frames; a render that fails says so in the report. */
async function withReview(project: Project, input: ProjectInput, frames: number[], report: Args): Promise<Content[]> {
  const content: Content[] = [];
  if (frames.length > 0) {
    try {
      if (frames.some((frame) => frame >= durationOf(project))) throw new Error("a review frame is past the timeline's end");
      const work = (on: ProjectInput) =>
        native().renderFrames({
          project: on,
          frames,
          maxSide: native().SHEET_CELL,
          priority: "agent",
          encode: "agent",
          sheetColumns: 4,
        });
      const sheet =
        "ref" in input
          ? await withProjectAsync(input.ref.id, input.ref.rev, () => jsonForSerde(project), work)
          : await work(input);
      const rendered = sheet[0];
      if (rendered === undefined) throw new Error("nothing was rendered");
      content.push(...imageContent(rendered, `Review frames, left to right then down: ${debugInts(frames)}`));
    } catch (error) {
      if (isBug(error)) throw error;
      report.review_error = diag.messageOf(error);
    }
  }
  content.unshift({ type: "text", text: stableStringify(report) });
  return content;
}

/**
 * The plan's mechanical audit, plus what it needs the media cache for: B-roll
 * that's mostly pixelated or blurred (files not read yet start reading and
 * are listed as pending) and quote callouts away from the words that point
 * to them. `rev`: the live revision `project` is (null: a copy not saved).
 */
export function audited(app: App, project: Project, rev: number | null): Args {
  const audit = editPlan.audit(project) as Args & { issues: Json[] };
  const extra = hooks.calloutTiming(project, cachedTranscripts(app, project, false));
  const censor = (input: ProjectInput) => native().censorIssues(input, true);
  const { issues: censored, pending } =
    rev === null
      ? censor({ json: jsonForSerde(project) })
      : withProject(project.id, rev, () => jsonForSerde(project), censor);
  audit.issues = editPlan.sortIssues([...audit.issues, ...extra, ...censored]);
  if (pending.length > 0) audit.censor_check_pending = pending;
  return audit;
}

/** A transcript file as it reads, or null. */
function readTranscript(path: string): Transcript | null {
  let value: unknown;
  try {
    value = serdeParse(fs.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const given = objectOf(value);
  if (typeof given.model !== "string" || !Array.isArray(given.words)) return null;
  for (const word of given.words as unknown[]) {
    const own = objectOf(word);
    if (typeof own.text !== "string" || typeof own.start !== "number" || typeof own.end !== "number") return null;
    if (!isNull(own.speaker) && typeof own.speaker !== "string") return null;
  }
  return value as Transcript;
}

/** The transcripts already made for the project's media (footage only, or every file with sound: voice-overs too). */
export function cachedTranscripts(app: App, project: Project, footageOnly: boolean): Map<string, Transcript> {
  const out = new Map<string, Transcript>();
  for (const media of project.media) {
    if (!media.has_audio || (footageOnly && media.kind !== "video")) continue;
    const transcript = readTranscript(app.media.paths(media.path).transcript);
    if (transcript !== null) out.set(media.id, transcript);
  }
  return out;
}

// ---------------------------------------------------------------------------
// get_edit_context

/** Sized for a model's context: Codex cuts a tool's output at ~10k tokens, and every token here is read again on each later request of the turn. */
const BUDGET = 36_000;

export function editContext(app: App, found: Live, args: Args): Args {
  const p = found.project;
  const fps = fpsOf(p);
  const total = durationOf(p);
  const sections = onLive(found, (input) => native().sections(input));
  const ids = Array.isArray(args.clip_ids) ? (args.clip_ids as unknown[]) : null;
  let span: [number, number] | null = null;
  switch (args.section) {
    case "intro":
      span = sections.intro;
      break;
    case "outro":
      span = sections.outro;
      break;
    case "story":
      span = [sections.intro?.[1] ?? 0, sections.outro?.[0] ?? total];
      break;
  }
  const startGiven = num(args.start);
  const endGiven = num(args.end);
  const from = startGiven !== null ? asInt(round(startGiven * fps)) : (span?.[0] ?? null);
  const to = endGiven !== null ? asInt(round(endGiven * fps)) : (span?.[1] ?? null);
  const inside = (start: number, end: number) => !(from !== null && end <= from) && !(to !== null && start >= to);
  const clips: Json[] = [];
  let subtitles = 0;
  for (const clip of p.clips) {
    if ((ids !== null && !ids.some((id) => id === clip.id)) || !inside(clip.start, clipEnd(clip))) continue;
    if (ids !== null) {
      // Asked for by id: the whole clip, keyframes too.
      clips.push(clip);
    } else if (trackOf(p, clip.track)?.subtitles === true) {
      subtitles += 1;
    } else {
      clips.push(clipRow(p, clip));
    }
  }
  if (ids !== null) {
    // A revision's lookup: just those clips, and where things stand.
    return { rev: found.rev, duration_frames: total, clips, audit: audited(app, p, found.rev) };
  }
  // Each label: its lines, colour and the transcript voices it covers.
  const speakers = hooks.peopleSummary(p);
  const cutIns: Json[] = [];
  const footage: Json[] = [];
  (p.script?.blocks ?? []).forEach((block, index) => {
    if (block.kind === "narration") {
      const number = cutIns.length + 1;
      const card = typeof block.clip === "string" ? clipOf(p, block.clip) : undefined;
      const voiceover = typeof block.voiceover === "string" ? clipOf(p, block.voiceover) : undefined;
      const placed = card ?? voiceover;
      // Keep cut-in numbers stable when a span hides some.
      if (placed !== undefined && !inside(placed.start, clipEnd(placed))) {
        cutIns.push(null);
        return;
      }
      cutIns.push({
        cut_in: number,
        text: block.text,
        notes: block.notes ?? [],
        card: block.clip ?? null,
        voiceover: block.voiceover ?? null,
        start: placed?.start ?? null,
        end: placed === undefined ? null : clipEnd(placed),
        words: voiceover === undefined ? null : cutInWords(app, p, voiceover),
      });
    } else {
      const placed = typeof block.clip === "string" ? clipOf(p, block.clip) : undefined;
      if (placed !== undefined && inside(placed.start, clipEnd(placed))) {
        footage.push({
          block: index,
          label: block.label,
          notes: block.notes ?? [],
          clip: block.clip ?? null,
          start: placed.start,
          end: clipEnd(placed),
        });
      }
    }
  });
  const tracks = p.tracks.map((track) => {
    let row = `${track.id} ${trackLabel(p, track.id) ?? ""}`;
    for (const [on, word] of [
      [track.subtitles === true, "subtitles"],
      [track.hidden, "hidden"],
      [track.muted, "muted"],
      [track.locked, "locked"],
    ] as const) {
      if (on) row += ` ${word}`;
    }
    return row;
  });
  const media = p.media.map(
    (own) =>
      `${own.id} ${debugKind(own)} ${fixed(own.duration, 1)}s${own.has_audio ? " sound" : ""} "${takeChars(own.name, 60)}"`,
  );
  const context: Args = {
    rev: found.rev,
    id: p.id,
    style: p.style,
    settings: p.settings,
    duration_frames: total,
    times: "clip rows are `id track type [start,end) frames …`; cut-in words are word@timeline-seconds",
    tracks,
    sections,
    media,
    speaker_line_counts: speakers,
    subtitles_in_span: subtitles,
    footage_blocks: footage,
    cut_ins: cutIns.filter((cutIn) => cutIn !== null),
    audit: audited(app, p, found.rev),
    smoothing: hooks.smoothingPending(p.id),
  };
  const markerSpan: [number, number] | null =
    from !== null || to !== null ? [from ?? 0, to ?? Number.MAX_SAFE_INTEGER] : null;
  const marked = markers.listing(p, markerSpan);
  if (marked.length > 0) context.markers = marked;
  if (args.include_transcript === true) {
    let heard = timelineTranscript(app, p);
    if (from !== null || to !== null) {
      heard = lines(heard)
        .filter((line) => {
          const at = lineSeconds(line);
          return at === null || inside(asInt(at * fps), asInt(at * fps) + 1);
        })
        .join("\n");
    }
    // Half the budget at most, so the clips still fit beside it.
    const room = BUDGET / 2;
    if (byteLength(heard) > room) {
      const cut = takeChars(heard, room);
      const newline = cut.lastIndexOf("\n");
      context.transcript = `${newline < 0 ? cut : cut.slice(0, newline)}\n[cut here: narrow with start/end for the rest]`;
    } else {
      context.transcript = heard;
    }
  }
  // Clips last, cut to what fits.
  let room = Math.max(BUDGET - byteLength(stableStringify(context)), 0);
  const kept: Json[] = [];
  for (const clip of clips) {
    const size = byteLength(stableStringify(clip)) + 1;
    if (size > room) break;
    room = Math.max(room - size, 0);
    kept.push(clip);
  }
  if (kept.length < clips.length) {
    context.clips_cut = `${kept.length} of ${clips.length} clips shown; narrow with section, start/end or clip_ids`;
  }
  context.clips = kept;
  return context;
}

/** Rust's `{:?}` of a MediaKind. */
function debugKind(media: Media): string {
  return media.kind === "video" ? "Video" : media.kind === "audio" ? "Audio" : "Image";
}

/** Rust's `str::lines`: split on \n, a trailing \r dropped, no last empty line. */
function lines(text: string): string[] {
  if (text === "") return [];
  const out = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (text.endsWith("\n")) out.pop();
  return out;
}

/** A cut-in voice-over's words as `word@timeline-seconds`, from its transcript (null without one). */
function cutInWords(app: App, p: Project, clip: Clip): string | null {
  if (clip.type !== "audio") return null;
  const media = p.media.find((own) => own.id === clip.media);
  if (media === undefined) return null;
  const transcript = readTranscript(app.media.paths(media.path).transcript);
  if (transcript === null) return null;
  const fps = fpsOf(p);
  const sourceIn = clip.source_in ?? 0;
  const speed = clip.speed ?? 1;
  const to = sourceIn + (clip.duration / fps) * speed;
  return transcript.words
    .filter((word) => word.end > sourceIn && word.start < to)
    .map((word) => `${trim(word.text)}@${fixed(clip.start / fps + (word.start - sourceIn) / speed, 2)}`)
    .join(" ");
}

/** The start of a transcript line ("[12.3] …" / "12.30 …"), in seconds. */
export function lineSeconds(line: string): number | null {
  const rest = line.replace(/^[[ ]+/, "");
  const at = /^[0-9.:]*/.exec(rest)?.[0] ?? "";
  let total = 0;
  for (const part of at.split(":")) {
    if (!/^(?:[0-9]+\.?[0-9]*|\.[0-9]+)$/.test(part)) return null;
    total = total * 60 + Number(part);
  }
  return total;
}

/**
 * One clip as a line a model reads quickly: id, track, type, frames, what it
 * shows or plays, and which params are keyframed (not the keys).
 */
export function clipRow(p: Project, clip: Clip): string {
  let row = `${clip.id} ${trackLabel(p, clip.track) ?? clip.track} ${clip.type} [${clip.start},${clipEnd(clip)})`;
  if (typeof clip.name === "string") row += ` "${clip.name}"`;
  switch (clip.type) {
    case "video": {
      const speed = clip.speed ?? 1;
      row += ` ${clip.media}@${fixed(clip.source_in ?? 0, 2)}s`;
      if (Math.abs(speed - 1) > 1e-6) row += ` x${fixed(speed, 2)}`;
      break;
    }
    case "audio": {
      const speed = clip.speed ?? 1;
      row += ` ${clip.media}@${fixed(clip.source_in ?? 0, 2)}s ${signed32(clip.volume_db ?? 0, 1)}dB`;
      if (Math.abs(speed - 1) > 1e-6) row += ` x${fixed(speed, 2)}`;
      break;
    }
    case "text": {
      row += ` ${debugStr(takeChars(clip.text, 70).replaceAll("\n", " / "))}`;
      const label = clip.style?.label;
      if (label !== undefined && label !== null) row += ` label ${debugStr(label.text)}`;
      break;
    }
    default:
      break;
  }
  if (typeof clip.link === "string") row += ` link ${clip.link}`;
  const params = Object.keys(clip.keyframes ?? {});
  if (params.length > 0) row += ` kf ${params.sort(compareKeys).join(",")}`;
  return row;
}

// ---------------------------------------------------------------------------
// batch

/** Tools that can't go in a batch: they take long, or run batches themselves. */
const SLOW = [
  "batch",
  "caption_speakers",
  "add_subtitles",
  "place_subtitles",
  "place_captions",
  "repack_subtitles",
  "watch_footage",
  "map_view",
  "place_voiceovers",
  "collect_images",
  "transcribe",
  "export",
];

/** Tools that only look (or each touch just their own clip) and take a while: a run of these with no "$N" references goes side by side. */
const SIDE_BY_SIDE = [
  "render_frame",
  "contact_sheet",
  "look_at_media",
  "measure_audio",
  "media_transcript",
  "find_in_footage",
  "read_transcript",
  "still_frame",
  "track_region",
  "case_articles",
  "read_page",
  "list_library",
];

type Outcome = { ok: Content[] } | { error: string };

/** Runs tool calls one after another for `batch`: "$N" arguments become the id of the clip call N added. */
export async function runBatch(app: App, args: Args, scope: string | null): Promise<Content[]> {
  if (!Array.isArray(args.calls)) throw new Error("calls must be a list");
  const calls = args.calls as unknown[];
  const keepGoing = bool(args.keep_going) ?? false;
  const added: (string | null)[] = [];
  const content: Content[] = [];
  let failures = 0;
  const specOf = (index: number) => objectOf(calls[index]);
  const toolOf = (index: number) => str(specOf(index).tool) ?? "";
  const runOne = (index: number, refs: (string | null)[]): Promise<Outcome> => {
    const spec = specOf(index);
    const name = toolOf(index);
    let callArgs: Json = spec.args === undefined ? {} : structuredClone(spec.args);
    let ready: string | null = null;
    if (SLOW.includes(name)) {
      ready = `${name} can't run in a batch; call it on its own`;
    } else {
      try {
        callArgs = resolveRefs(callArgs, refs);
      } catch (error) {
        if (isBug(error)) throw error;
        ready = diag.messageOf(error);
      }
    }
    return (async (): Promise<Outcome> => {
      if (ready !== null) return { error: ready };
      try {
        return { ok: await diag.timeAsync("agent", `tool ${name}`, () => call(app, name, objectOf(callArgs), scope)) };
      } catch (error) {
        if (isBug(error)) throw error;
        return { error: diag.messageOf(error) };
      }
    })();
  };
  const independent = (index: number) =>
    SIDE_BY_SIDE.includes(toolOf(index)) && !hasRefs(specOf(index).args ?? null);
  const ready: [number, Outcome][] = [];
  let index = 0;
  while (index < calls.length) {
    const name = toolOf(index);
    let result: Outcome;
    const waiting = ready.shift();
    if (waiting !== undefined) {
      result = waiting[1];
    } else if (independent(index)) {
      // This call and the independent ones right after it, three at a time.
      let end = index;
      while (end < calls.length && independent(end)) end += 1;
      const snapshot = [...added];
      const results = await buffered(
        Array.from({ length: end - index }, (_, offset) => () => runOne(index + offset, snapshot)),
        3,
      );
      results.forEach((outcome, offset) => ready.push([index + offset, outcome]));
      result = ready.shift()?.[1] ?? { error: "lost" };
    } else {
      result = await runOne(index, added);
    }
    const label = `[${index + 1}] ${name}: `;
    index += 1;
    if ("ok" in result) {
      added.push(result.ok.map(addedClip).find((clip) => clip !== null) ?? null);
      for (const item of result.ok) content.push(item.type === "text" ? { ...item, text: `${label}${item.text}` } : item);
    } else {
      added.push(null);
      failures += 1;
      content.push({ type: "text", text: `${label}FAILED: ${result.error}` });
      if (!keepGoing) {
        // Calls that already ran beside this one still report.
        for (let waiting = ready.shift(); waiting !== undefined; waiting = ready.shift()) {
          const [at, outcome] = waiting;
          const said =
            "ok" in outcome
              ? outcome.ok
                  .filter((item): item is { type: "text"; text: string } => item.type === "text")
                  .map((item) => item.text)
                  .join(" ")
              : `FAILED: ${outcome.error}`;
          content.push({ type: "text", text: `[${at + 1}] ${toolOf(at)}: ${said}` });
          index = at + 1;
        }
        if (index < calls.length) {
          content.push({ type: "text", text: `stopped; calls ${index + 1} to ${calls.length} didn't run` });
        }
        break;
      }
    }
  }
  if (failures > 0 && failures === calls.length) {
    throw new Error(
      content
        .filter((item): item is { type: "text"; text: string } => item.type === "text")
        .map((item) => item.text)
        .join("\n"),
    );
  }
  return content;
}

/** Runs `work` at most `limit` at a time, results in order (futures' `buffered`). */
async function buffered<T>(work: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results = new Array<T>(work.length);
  let next = 0;
  const lane = async () => {
    while (next < work.length) {
      const at = next++;
      results[at] = await work[at]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, work.length) }, lane));
  return results;
}

/** The clip an add_clip / add_text result names ("added clip c12"). */
export function addedClip(item: Content | Json): string | null {
  const said = objectOf(item).text;
  if (typeof said !== "string") return null;
  let rest: string | null = null;
  if (said.startsWith("added clip ")) rest = said.slice("added clip ".length);
  else if (said.startsWith("added text clip ")) rest = said.slice("added text clip ".length);
  if (rest === null) return null;
  return rest.split(/\s+/u).find((word) => word !== "") ?? null;
}

/** "$N" with N a number (Rust's usize parse, which takes a leading "+"). */
function refNumber(said: string): number | null {
  if (!said.startsWith("$")) return null;
  const digits = said.slice(1);
  if (!/^\+?[0-9]+$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

/** Whether `value` holds a "$N" reference to an earlier call's clip. */
export function hasRefs(value: Json): boolean {
  if (typeof value === "string") return refNumber(value) !== null;
  if (Array.isArray(value)) return value.some(hasRefs);
  if (typeof value === "object" && value !== null) return Object.values(value).some(hasRefs);
  return false;
}

/** `value` with "$N" strings replaced by the clip call N added. */
export function resolveRefs(value: Json, added: (string | null)[]): Json {
  if (typeof value === "string") {
    const number = refNumber(value);
    if (number === null) return value;
    if (number < 1 || number - 1 >= added.length) throw new Error(`$${number}: there's no earlier call ${number}`);
    const clip = added[number - 1];
    if (clip === null || clip === undefined) throw new Error(`$${number}: call ${number} added no clip`);
    return clip;
  }
  if (Array.isArray(value)) return value.map((item) => resolveRefs(item, added));
  if (typeof value === "object" && value !== null) {
    const out: Args = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolveRefs(item, added);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// The words on the timeline

/** Words heard on the timeline (audio clips on unmuted tracks), as phrases with timeline times. A phrase breaks on a pause or a change of voice. */
export function timelineTranscript(app: App, project: Project): string {
  const fps = fpsOf(project);
  const words: [number, string, string | null][] = [];
  const missing: string[] = [];
  for (const clip of project.clips) {
    if (clip.type !== "audio") continue;
    if (trackOf(project, clip.track)?.muted === true) continue;
    const source = project.media.find((own) => own.id === clip.media);
    if (source === undefined) continue;
    const transcript = readTranscript(app.media.paths(source.path).transcript);
    if (transcript === null) {
      if (!missing.includes(source.name)) missing.push(source.name);
      continue;
    }
    const from = clip.source_in ?? 0;
    const speed = clip.speed ?? 1;
    const to = from + (clip.duration / fps) * speed;
    for (const word of transcript.words) {
      if (!(word.start >= from && word.start < to)) continue;
      const at = clip.start / fps + (word.start - from) / speed;
      // Named voices ("Officer") read better than Scribe's numbers.
      const voice = word.speaker ?? null;
      const speaker = voice === null ? null : (transcript.speakers?.[voice] ?? voice);
      words.push([at, word.text, speaker]);
    }
  }
  words.sort((a, b) => a[0] - b[0]);
  let out = "";
  let last: [number, string | null] | null = null;
  for (const [at, word, speaker] of words) {
    const breaks = last === null || at - last[0] > 0.8 || last[1] !== speaker;
    if (breaks) {
      if (out !== "") out += "\n";
      out += `[${fixed(at, 2)}s]`;
      if (speaker !== null) out += ` (${speaker})`;
    }
    out += ` ${word}`;
    last = [at, speaker];
  }
  if (out === "") out = "No transcribed speech on the timeline.";
  if (missing.length > 0) out += `\n\nNot transcribed yet: ${missing.join(", ")}.`;
  return out;
}

// ---------------------------------------------------------------------------
// House assets for plans

/**
 * Brings in the house pictures and sounds a plan's graphics use (evidence
 * boards' shutter, desktop profiles' wallpaper and windows) as media of the
 * plan's own copy of the project, so it all saves once or not at all.
 */
export async function planAssets(app: App, project: Project, operations: Json[]): Promise<[editPlan.Assets, seams.Made[]]> {
  const needs = editPlan.needs(operations);
  const assets: editPlan.Assets = { shutter: null, desktops: [] };
  const made: seams.Made[] = [];
  const home = app.store.home;
  if (needs.shutter) {
    const sound = sfx.find("shutter");
    if (sound === undefined) throw new Error("the shutter sound is missing");
    const path = sfx.path(home, sound);
    const [ids, fresh] = await houseMedia(app, project, [path]);
    made.push(...fresh);
    const mediaId = ids[0];
    if (mediaId === undefined) throw new Error("shutter media");
    const media = project.media.find((own) => own.id === mediaId);
    if (media !== undefined && (media.markers ?? []).length === 0) media.markers = sfx.markers(sound);
    // About 8 LU under the speech: a texture on each photo, not a hit.
    let volume: number;
    try {
      const speech = await hooks.footageLoudness(structuredClone(project));
      const own = await hooks.loudness(path, 0, 1);
      volume = clamp(speech - 8 - own, -40, 6);
    } catch (error) {
      if (isBug(error)) throw error;
      // Nothing to measure yet (no speech): about where it sits on a typical edit.
      volume = -14;
    }
    assets.shutter = { media: mediaId, hit: sound.hit, volume_db: f32(volume) };
  }
  for (const [photoTitle, notepadTitle] of needs.desktops) {
    const { width, height } = project.settings;
    const paths = await diag.timeOnAsync("agent", "desktop profile: draw", "", () =>
      native().desktopFiles(width, height, photoTitle, notepadTitle),
    );
    const [ids, fresh] = await houseMedia(app, project, paths);
    made.push(...fresh);
    const [wallpaper, photoViewer, notepad] = ids;
    if (ids.length !== 3 || wallpaper === undefined || photoViewer === undefined || notepad === undefined) {
      throw new Error("desktop pictures");
    }
    assets.desktops.push({ photo_title: photoTitle, notepad_title: notepadTitle, wallpaper, photo_viewer: photoViewer, notepad });
  }
  return [assets, made];
}

// ---------------------------------------------------------------------------
// Placing sounds (add_sound_effect here, add_from_library in media_tools.ts)

/** Where a sound goes: its `times` (timeline seconds) and every place each of its `markers` (names) is. */
export function soundTimes(store: Store, id: string, args: Args): number[] {
  const times = isNull(args.times) ? [] : (serde("times: ", () => read({ vec: "f64" }, args.times)) as number[]);
  if (!isNull(args.markers)) {
    const names = strings(args.markers, "markers: ");
    const project = store.get(id)?.project;
    if (project === undefined) throw new Error("project vanished");
    times.push(...markers.times(project, names));
  }
  if (times.length === 0) throw new Error("give times (timeline seconds) or markers (names)");
  return times;
}

export type { PlacedSound } from "./seams.ts";
type PlacedSound = seams.PlacedSound;

/**
 * Places a sound already in the project's media at timeline times (seconds)
 * on a free audio track, its "hit" marker (else its start) on each time. The
 * same sound already within 0.5 s of a time gives way. `given` markers are
 * given to the media if it has none yet.
 */
export async function placeSound(
  store: Store,
  id: string,
  mediaId: string,
  name: string,
  given: Marker[],
  times: number[],
  sound: PlacedSound,
): Promise<string> {
  const [, [placed, replaced]] = await store.update(id, ORIGIN, (project) => {
    const fps = fpsOf(project);
    const media = project.media.find((own) => own.id === mediaId);
    if (media === undefined) throw new Error("sound media vanished");
    // The sound's markers come with it (kept if the user has moved them).
    if ((media.markers ?? []).length === 0) media.markers = structuredClone(given);
    const own = media.markers ?? [];
    const hit = (own.find((marker) => marker.name === sfx.HIT) ?? own[0])?.time ?? 0;
    // Trimmed, a sound with a hit keeps the stretch around it.
    const from = sound.seconds !== null && hit > 0 ? Math.max(hit - (sound.lead ?? sound.seconds / 2), 0) : 0;
    let length = Math.max(asInt(Math.floor((media.duration - from) * fps)), 1);
    if (sound.seconds !== null) length = Math.min(length, Math.max(asInt(round(sound.seconds * fps)), 1));
    const placed: string[] = [];
    let replaced = 0;
    for (const time of times) {
      // This sound already near the time (any version of it) gives way to the new one.
      const [near0, near1] = [asInt((time - 0.5) * fps), asInt((time + 0.5) * fps)];
      const before = project.clips.length;
      project.clips = project.clips.filter(
        (clip) => !(clip.name === name && clip.type === "audio" && clip.start < near1 && clipEnd(clip) > near0),
      );
      replaced += before - project.clips.length;
      // Its hit marker lands on the time given.
      let start = asInt(round((time - (hit - from)) * fps));
      let length2 = length;
      let sourceIn = from;
      // A hit on frame 0: drop the bit before it.
      if (start < 0) {
        sourceIn = from - start / fps;
        length2 += start;
        start = 0;
      }
      if (length2 < 1) continue;
      // Never on A1: that's the footage's own sound.
      const track = freeTrackFrom(project, "audio", 1, start, start + length2);
      const clipId = freshId(project, "c");
      project.clips.push({
        id: clipId,
        track,
        start,
        duration: length2,
        color: sound.color,
        name,
        fade_in: 0,
        fade_out: Math.min(asInt(round(sound.fade_out * fps)), length2),
        type: "audio",
        media: mediaId,
        source_in: sourceIn,
        speed: 1,
        volume_db: f32(sound.volume_db),
      });
      placed.push(`${fixed(time, 2)}s`);
    }
    return [placed, replaced] as const;
  });
  return `placed ${name} at ${placed.join(", ")} (replacing ${replaced} already near those times)`;
}

// ---------------------------------------------------------------------------
// Closing gaps

/** Closes the spans `gone` left where nothing else plays: everything after each slides back by its length, all tracks together. Returns frames closed. */
export function closeGaps(project: Project, gone: Clip[]): number {
  const spans = gone.map((clip): [number, number] => [clip.start, clipEnd(clip)]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let closed = 0;
  // Latest first, so closing one never moves another.
  for (const [start, end] of merged.reverse()) {
    if (project.clips.some((clip) => clip.start < end && clipEnd(clip) > start)) continue;
    const length = end - start;
    for (const clip of project.clips) if (clip.start >= end) clip.start -= length;
    for (const key of ["mark_in", "mark_out"] as const) {
      const mark = project[key];
      if (mark === undefined || mark === null) continue;
      if (mark >= end) project[key] = mark - length;
      else if (mark > start) project[key] = start;
    }
    closed += length;
  }
  return closed;
}
