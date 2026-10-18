// Marked moments the agent plans sounds on: a moment of a source
// (a door slamming at 12.4 s of the bodycam) is a media marker, so it stays on
// the moment however the clips showing it move; a moment of the edit itself (a
// photo landing on an evidence board) is a timeline marker. Sounds are then
// placed on the marks by name (add_sound_effect / add_from_library `markers`).

import type { Marker, Media, Project, TimelineMarker } from "./model.ts";
import { clipContains, clipEnd, clipOf, fps as fpsOf } from "./project.ts";
import { compareStrings, fixed, round, trim } from "./rust.ts";

/** The marker a placed sound lines up on the cut. */
export const HIT = "hit";

type Args = Record<string, unknown>;

/** A sound effect's own markers ("hit") are part of the file, not plans. */
function isSoundHit(media: Media, marker: Marker): boolean {
  return media.kind === "audio" && marker.name === HIT;
}

/** Names match whatever their case and surrounding space (Rust's eq_ignore_ascii_case on trimmed). */
function same(a: string, b: string): boolean {
  return asciiLower(trim(a)) === asciiLower(trim(b));
}

function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const int = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);

/**
 * Adds and removes markers: `{add: [...], remove: [...]}`.
 * - add `{name, note?, frame}`: on the timeline at that frame;
 * - add `{name, note?, media, time}`: on a media at source seconds;
 * - add `{name, note?, clip, frame}`: on that clip's media, at the source
 *   moment the clip shows at timeline `frame` (it moves with that moment).
 *
 * A marker of the same name within a frame (or 1/30 s) of a new one is
 * replaced. remove `{name?, media?, frame?}` (at least one) removes every
 * marker matching all given. Returns what changed and the markers now set.
 */
export function edit(project: Project, args: Args): Record<string, unknown> {
  const fps = fpsOf(project);
  const added: Record<string, unknown>[] = [];
  let removed = 0;
  const removes = Array.isArray(args.remove) ? (args.remove as unknown[]) : [];
  removes.forEach((raw, index) => {
    const item = (typeof raw === "object" && raw !== null ? raw : {}) as Args;
    const name = str(item.name);
    const media = str(item.media);
    const frame = int(item.frame);
    if (name === null && media === null && frame === null) {
      throw new Error(`remove ${index + 1}: give name, media or frame`);
    }
    const wanted = (own: string) => name === null || same(name, own);
    if (media === null) {
      const before = (project.markers ?? []).length;
      project.markers = (project.markers ?? []).filter(
        (marker) => !(wanted(marker.name) && (frame === null || frame === marker.frame)),
      );
      removed += before - project.markers.length;
    }
    if (frame === null) {
      for (const own of project.media.filter((own) => media === null || own.id === media)) {
        const markers = own.markers ?? [];
        const before = markers.length;
        const sound = own.kind === "audio";
        own.markers = markers.filter((marker) => {
          // A sound's hit goes only when asked for by its media.
          const hit = sound && marker.name === HIT && media === null;
          return hit || !wanted(marker.name);
        });
        removed += before - own.markers.length;
      }
    }
  });
  const adds = Array.isArray(args.add) ? (args.add as unknown[]) : [];
  adds.forEach((raw, index) => {
    const item = (typeof raw === "object" && raw !== null ? raw : {}) as Args;
    const fail = (what: string) => new Error(`add ${index + 1}: ${what}`);
    const given = str(item.name);
    const name = given === null ? "" : trim(given);
    if (name === "") throw fail('name is required ("door slam")');
    const note = trim(str(item.note) ?? "");
    let onMedia: [string, number] | null = null;
    const mediaId = str(item.media);
    const clipId = str(item.clip);
    if (mediaId !== null) {
      const time = num(item.time);
      if (time === null || !Number.isFinite(time) || time < 0) throw fail("time (source seconds) is required with media");
      onMedia = [mediaId, time];
    } else if (clipId !== null) {
      const frame = int(item.frame);
      if (frame === null) throw fail("frame (timeline) is required with clip");
      const clip = clipOf(project, clipId);
      if (clip === undefined) throw fail(`no clip ${clipId}`);
      if (clip.type !== "video" && clip.type !== "audio") throw fail("clip must be a video, image or audio clip");
      if (!clipContains(clip, frame)) {
        throw fail(`frame ${frame} is outside clip ${clip.id} [${clip.start}, ${clipEnd(clip)})`);
      }
      onMedia = [clip.media, (clip.source_in ?? 0) + ((frame - clip.start) / fps) * (clip.speed ?? 1)];
    }
    if (onMedia !== null) {
      const [id, time] = onMedia;
      const media = project.media.find((media) => media.id === id);
      if (media === undefined) throw fail(`no media ${id}`);
      if (media.kind !== "image" && time > media.duration + 0.05) {
        throw fail(`time ${fixed(time, 2)} is past the end of ${id} (${fixed(media.duration, 2)} s)`);
      }
      const markers = (media.markers ?? []).filter(
        (marker) => !(same(marker.name, name) && Math.abs(marker.time - time) < 1 / 30),
      );
      markers.push(markerOf(time, name, note));
      media.markers = stableSort(markers, (a, b) => a.time - b.time);
      added.push({ name, media: id, time: round(time * 100) / 100 });
    } else {
      const frame = int(item.frame);
      if (frame === null || frame < 0) throw fail("frame (timeline, from 0) is required, or media and time");
      addTimeline(project, frame, name, note);
      added.push({ name, frame });
    }
  });
  const none = (value: unknown) => value === undefined || value === null;
  if (added.length === 0 && removed === 0 && none(args.add) && none(args.remove)) {
    throw new Error("give add and/or remove");
  }
  return { added, removed, markers: listing(project, null) };
}

function markerOf(time: number, name: string, note: string): Marker {
  const marker: Marker = { time, name };
  if (note !== "") marker.note = note;
  return marker;
}

function stableSort<T>(items: T[], compare: (a: T, b: T) => number): T[] {
  return items
    .map((item, index) => [item, index] as const)
    .sort((a, b) => compare(a[0], b[0]) || a[1] - b[1])
    .map(([item]) => item);
}

/** Sets a timeline marker (one of the same name within a frame is replaced). */
export function addTimeline(project: Project, frame: number, name: string, note: string): void {
  const markers = (project.markers ?? []).filter(
    (marker) => !(same(marker.name, name) && Math.abs(marker.frame - frame) <= 1),
  );
  const marker: TimelineMarker = { frame, name };
  if (note !== "") marker.note = note;
  markers.push(marker);
  project.markers = stableSort(markers, (a, b) => a.frame - b.frame);
}

/**
 * Where a media's moment at `time` shows on the timeline: one frame per
 * clip of it playing that moment (picture and its sound count once).
 */
function shownAt(project: Project, mediaId: string, time: number): number[] {
  const fps = fpsOf(project);
  const frames: number[] = [];
  for (const clip of project.clips) {
    if (clip.type !== "video" && clip.type !== "audio") continue;
    const speed = clip.speed ?? 1;
    if (clip.media !== mediaId || !(speed > 0)) continue;
    const frame = clip.start + Math.trunc(round(((time - (clip.source_in ?? 0)) / speed) * fps));
    if (clipContains(clip, frame)) frames.push(frame);
  }
  return dedupSorted(frames);
}

function dedupSorted(frames: number[]): number[] {
  frames.sort((a, b) => a - b);
  return frames.filter((frame, index) => index === 0 || frame !== frames[index - 1]);
}

/**
 * The timeline frames a marker name stands for: its timeline markers, and
 * every place a clip shows a media marker of that name.
 */
export function frames(project: Project, name: string): number[] {
  const out = (project.markers ?? []).filter((marker) => same(marker.name, name)).map((marker) => marker.frame);
  for (const media of project.media) {
    for (const marker of media.markers ?? []) {
      if (same(marker.name, name) && !isSoundHit(media, marker)) out.push(...shownAt(project, media.id, marker.time));
    }
  }
  return dedupSorted(out);
}

/**
 * Timeline seconds for each marker name (for placing sounds on them); an
 * unknown name is an error listing the names there are.
 */
export function times(project: Project, names: string[]): number[] {
  const out: number[] = [];
  for (const name of names) {
    const found = frames(project, name);
    if (found.length === 0) {
      const known = (project.markers ?? []).map((marker) => marker.name);
      for (const media of project.media) {
        for (const marker of media.markers ?? []) if (!isSoundHit(media, marker)) known.push(marker.name);
      }
      known.sort(compareStrings);
      const unique = known.filter((item, index) => index === 0 || item !== known[index - 1]);
      throw new Error(
        `no marker named "${name}" on the timeline or shown by a clip; markers: ${
          unique.length === 0 ? "none (set them with markers add)" : unique.join(", ")
        }`,
      );
    }
    out.push(...found.map((frame) => frame / fpsOf(project)));
  }
  return out;
}

const I64_MAX = Number.MAX_VALUE;

/**
 * Every marker in one line each: `name@frame` (timeline) and
 * `name media@seconds → frames` (a source's, where clips show it), notes in
 * brackets, within `span` (frames) when given.
 */
export function listing(project: Project, span: [number, number] | null): string[] {
  const inside = (frame: number) => span === null || (frame >= span[0] && frame < span[1]);
  const note = (text: string | undefined) => (text === undefined || text === "" ? "" : ` (${text})`);
  const rows: [number, string][] = (project.markers ?? [])
    .filter((marker) => inside(marker.frame))
    .map((marker) => [marker.frame, `${marker.name}@${marker.frame}${note(marker.note)}`]);
  for (const media of project.media) {
    for (const marker of media.markers ?? []) {
      if (isSoundHit(media, marker)) continue;
      const shown = shownAt(project, media.id, marker.time).filter(inside);
      if (span !== null && shown.length === 0) continue;
      const at = shown[0] ?? I64_MAX;
      const where = shown.length === 0 ? "not on the timeline" : shown.join(",");
      rows.push([at, `${marker.name} ${media.id}@${fixed(marker.time, 2)}s → ${where}${note(marker.note)}`]);
    }
  }
  return stableSort(rows, (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, row]) => row);
}
