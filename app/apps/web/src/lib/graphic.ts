// A house graphic as one thing to nudge by hand (Sphe's Nov 2 list, item 6,
// from Diffusion Studio's `@inspect` knobs). The agent builds a graphic as
// several clips laid together under one name: "Date" and "Date · darken",
// "Cut-in 3 · Desktop · Notepad" and its "… note 1"…, a red quote's words
// and its line. Each clip has its own knobs in the Inspector already; these
// move, size and time the whole graphic at once, writing the same values the
// agent reads back (transform x/y and their keyframes, text sizes, starts and
// lengths), so JJ's nudge is what the agent sees next.

import type { Clip, Project } from "./types";

/** The graphic a clip's name says it's part of: "Date" of "Date · darken"; a cut-in's "Desktop" of "Cut-in 3 · Desktop · Notepad note 1". */
export function graphicKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const parts = name.split(" · ").map((part) => part.trim());
  if (/^Cut-in \d+$/u.test(parts[0] ?? "")) parts.shift();
  const key = parts[0] ?? "";
  // Footage and the people's own words are never part of a graphic.
  if (key === "" || key.startsWith("B-roll") || key === "Subtitle" || key === "Caption" || key === "Voice-over") return null;
  return key;
}

/** Whether a clip can be part of a graphic: anything seen (its name says which graphic), never sound. */
function drawn(_project: Project, clip: Clip): boolean {
  return clip.type !== "audio";
}

/**
 * A picture filling the frame where it is: a Pause's room held still, a
 * desktop's wallpaper. It stays put when the graphic moves (moving it would
 * show black at an edge); the windows and words on it move.
 */
export function fillsFrame(clip: Clip): boolean {
  return clip.type === "video" && Math.abs(clip.transform.x) < 1 && Math.abs(clip.transform.y) < 1 && clip.transform.scale >= 0.99;
}

/**
 * The clips of the graphic `clip` is part of: drawn clips under the same
 * name whose time overlaps its own (so a graphic used twice is two). Null
 * when it's alone: one clip has its own knobs already.
 */
export function graphicOf(project: Project, clip: Clip): Clip[] | null {
  const key = graphicKey(clip.name);
  if (key === null || !drawn(project, clip)) return null;
  const from = clip.start;
  const to = clip.start + clip.duration;
  const group = project.clips.filter(
    (other) => drawn(project, other) && graphicKey(other.name) === key && other.start < to && other.start + other.duration > from,
  );
  return group.length >= 2 ? group : null;
}

/** Moves every clip that has a place by (dx, dy) px, its keyframed x and y too; a full-frame picture stays. */
export function moveGraphic(clips: Clip[], dx: number, dy: number): void {
  for (const clip of clips) {
    if (!("transform" in clip) || fillsFrame(clip)) continue;
    clip.transform.x += dx;
    clip.transform.y += dy;
    for (const key of clip.keyframes?.x ?? []) key.value += dx;
    for (const key of clip.keyframes?.y ?? []) key.value += dy;
  }
}

/** Scales every text's size (and its keyframed size) by `factor`, rounded to a pixel. */
export function resizeGraphic(clips: Clip[], factor: number): void {
  if (!(factor > 0) || !Number.isFinite(factor)) return;
  for (const clip of clips) {
    if (clip.type !== "text") continue;
    clip.style.size = Math.max(4, Math.round(clip.style.size * factor));
    for (const key of clip.keyframes?.size ?? []) key.value = Math.max(4, Math.round(key.value * factor));
  }
}

/** Moves the whole graphic in time by `frames` (never before 0); its keyframes go with it, being clip-relative. */
export function shiftGraphic(clips: Clip[], frames: number): void {
  const earliest = Math.min(...clips.map((clip) => clip.start));
  const by = Math.max(Math.round(frames), -earliest);
  for (const clip of clips) clip.start += by;
}

/**
 * Lengthens or shortens the graphic's hold by `frames`: every clip ending
 * where the longest ends ends with it, so the pieces that leave together
 * still do (at least a frame each).
 */
export function holdGraphic(clips: Clip[], frames: number): void {
  const end = Math.max(...clips.map((clip) => clip.start + clip.duration));
  for (const clip of clips) {
    if (clip.start + clip.duration !== end) continue;
    clip.duration = Math.max(1, clip.duration + Math.round(frames));
  }
}
