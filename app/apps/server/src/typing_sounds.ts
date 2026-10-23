// Typing sounds under a Notepad's typed lines, cut to the typing: the team
// asked for a typewriter "that starts exactly when the animation starts and
// ends exactly when the animation stops, because with a lot of this, the
// sound effect continues on afterwards" (Oct 23, Judge EXPLODES). A line's
// letters come one every `stagger` frames from its clip's start (edit-render's
// typed_glyphs: spaces aren't typed), so its typing is known exactly; a
// typing sound placed near a line's start is fitted to it, and the audit's
// `typing_sound_off` names one that isn't.

import type { Clip, Project } from "./model.ts";
import { clipEnd, fps as fpsOf } from "./project.ts";
import { asInt } from "./rust.ts";

/** A typing sound (a typewriter, a keyboard): it plays exactly while its line types. */
export const TYPING = /typ(ing|ewriter)/iu;

/** Each typewriter line's typing: [first frame, frame after its last letter appears] (glyph i at `stagger * i`, spaces not typed). */
export function typedLines(project: Project): [number, number][] {
  const out: [number, number][] = [];
  for (const clip of project.clips) {
    if (clip.type !== "text" || clip.animation?.preset !== "typewriter") continue;
    const glyphs = [...clip.text].filter((ch) => ch.trim() !== "").length;
    const stagger = Math.max(clip.animation.stagger ?? 1, 0);
    out.push([clip.start, clip.start + Math.max(Math.ceil(stagger * Math.max(glyphs - 1, 0)) + 1, 1)]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** The typewriter line a typing sound belongs to: the one starting nearest it, within half a second. */
function lineFor(project: Project, lines: [number, number][], clip: Clip): [number, number] | null {
  const near = Math.round(fpsOf(project) / 2);
  let best: [number, number] | null = null;
  for (const line of lines) {
    if (Math.abs(line[0] - clip.start) > near) continue;
    if (best === null || Math.abs(line[0] - clip.start) < Math.abs(best[0] - clip.start)) best = line;
  }
  return best;
}

/**
 * Typing sounds cut to their line: from its first letter to its last, the
 * sound from its own start (the team: "the sound effect… starts exactly when
 * the animation starts and ends exactly when the animation stops, because…
 * the sound effect continues on afterwards"). Returns how many changed.
 */
export function fitTypingSounds(project: Project): number {
  const fps = fpsOf(project);
  const lines = typedLines(project);
  let changed = 0;
  for (const clip of project.clips) {
    if (clip.type !== "audio") continue;
    const media = project.media.find((one) => one.id === clip.media);
    if (media === undefined || !TYPING.test(`${clip.name ?? ""} ${media.name}`)) continue;
    const line = lineFor(project, lines, clip);
    if (line === null) continue;
    const most = Math.max(asInt(Math.floor(media.duration * fps)), 1);
    const want = { start: line[0], duration: Math.min(line[1] - line[0], most), source_in: 0, fade_in: 0, fade_out: Math.min(2, line[1] - line[0]) };
    if (clip.start === want.start && clip.duration === want.duration && clip.source_in === 0 && clip.fade_out === want.fade_out) continue;
    Object.assign(clip, want);
    changed += 1;
  }
  return changed;
}

/** Typing sounds that start before or after their line, or play on once it's typed (`typing_sound_off`). */
export function typingSoundsOff(project: Project): Record<string, unknown>[] {
  const lines = typedLines(project);
  const out: Record<string, unknown>[] = [];
  for (const clip of project.clips) {
    if (clip.type !== "audio") continue;
    const media = project.media.find((one) => one.id === clip.media);
    if (media === undefined || !TYPING.test(`${clip.name ?? ""} ${media.name}`)) continue;
    const line = lineFor(project, lines, clip);
    if (line === null) continue;
    if (Math.abs(clip.start - line[0]) > 1 || clipEnd(clip) > line[1] + 2) {
      out.push({ kind: "typing_sound_off", clip: clip.id, start: clip.start, line: line, fix: `start ${line[0]}, duration ${line[1] - line[0]}, source_in 0 (from the line's first letter to its last; add_from_library on the line's "desktop line" marker does this itself)` });
    }
  }
  return out;
}

