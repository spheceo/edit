// What points at someone ends with the shot of them. Marc, Judge EXPLODES v2:
// "Text is still visible here despite not pointing to Timothy" (a name callout
// up past the cut to the next shot); the same family as Marius's sticky blurs
// ("blur stays for too long, gets moved to other places"). A pointer is a
// callout (text with a leader line, `style.leader`) or its spotlight (an
// adjustment named "Spotlight …"). The store, on every write
// (`enforcePointers`), ends a pointer that's new or changed, or whose picture
// changed under it, at the first cut beneath it; the audit (`pointerIssues`)
// flags any still across a cut, and blurs that track but stay put across one.

import { fillsFrame, stillRect } from "./frames_fill.ts";
import type { Clip, Project } from "./model.ts";
import { clipEnd, trackOf } from "./project.ts";

/** A shot shorter than this (frames, ~0.5 s) is a dissolve's frames or a flash, not a shot. */
const MIN_SHOT = 15;

export function isPointer(clip: Clip): boolean {
  if (clip.type === "text") return clip.style.leader !== undefined && clip.style.leader !== null;
  return clip.type === "adjustment" && (clip.name ?? "").startsWith("Spotlight ");
}

/**
 * The first frame (after `clip`'s start) where the picture filling the frame
 * under it becomes another shot that lasts: a cut it outlives. Two pieces of
 * one take back to back (a split, its source running on) are one shot. Null
 * when it stays on one shot (or there's no picture under it).
 */
export function firstCut(project: Project, clip: Clip): number | null {
  const index = (track: string) => project.tracks.findIndex((one) => one.id === track);
  const mine = index(clip.track);
  const fps = project.settings.fps;
  const under = project.clips.filter(
    (other) => index(other.track) < mine && trackOf(project, other.track)?.hidden !== true && other.start < clipEnd(clip) && clip.start < clipEnd(other) && fillsFrame(project, other),
  );
  // Which shot each picture belongs to: a piece continuing the one before it (same media, its source running on) is the same.
  const shot = new Map<string, string>();
  const sorted = [...under].sort((a, b) => a.start - b.start);
  for (const other of sorted) {
    const before = sorted.find((one) => {
      if (one === other || clipEnd(one) !== other.start || one.type !== "video" || other.type !== "video" || one.media !== other.media) return false;
      const runsOn = one.source_in + (one.duration / fps) * one.speed;
      return Math.abs(runsOn - other.source_in) * fps <= 2;
    });
    shot.set(other.id, before !== undefined ? (shot.get(before.id) ?? before.id) : other.id);
  }
  let current: string | null = null;
  let since = clip.start;
  let candidate: [string, number] | null = null;
  for (let frame = clip.start; frame < clipEnd(clip); frame++) {
    const showing = under.filter((other) => other.start <= frame && frame < clipEnd(other)).sort((a, b) => index(b.track) - index(a.track))[0];
    const now = showing === undefined ? null : (shot.get(showing.id) ?? showing.id);
    if (current === null) {
      current = now;
      since = frame;
      continue;
    }
    if (now === current || now === null) {
      candidate = null;
      continue;
    }
    // Another shot: a cut once it lasts.
    if (candidate === null || candidate[0] !== now) candidate = [now, frame];
    if (frame - candidate[1] + 1 >= MIN_SHOT && candidate[1] - since >= 1) return candidate[1];
  }
  return null;
}

/**
 * The store's rule on every write: a pointer in `after` that's new or changed
 * since `before` (null: all), or whose first cut moved (its picture changed),
 * ends at that cut, when at least MIN_SHOT frames of it are left (else it's
 * left for the audit). Pointers left as they were over pictures left as they
 * were aren't touched. How many were ended.
 */
export function enforcePointers(before: Project | null, after: Project): number {
  const was = new Map<string, [string, number | null]>();
  for (const clip of before?.clips ?? []) if (isPointer(clip)) was.set(clip.id, [JSON.stringify([clip.start, clip.duration]), firstCut(before!, clip)]);
  let ended = 0;
  for (const clip of after.clips) {
    if (!isPointer(clip)) continue;
    const cut = firstCut(after, clip);
    if (cut === null) continue;
    const old = was.get(clip.id);
    if (before !== null && old !== undefined && old[0] === JSON.stringify([clip.start, clip.duration]) && old[1] === cut) continue;
    if (cut - clip.start < MIN_SHOT) continue;
    clip.duration = cut - clip.start;
    clip.fade_out = Math.min(clip.fade_out, clip.duration);
    if (clip.fade_in + clip.fade_out > clip.duration) clip.fade_in = Math.max(clip.duration - clip.fade_out, 0);
    ended += 1;
  }
  return ended;
}

/** The audit: pointers still across a cut, and blurs that track but keep still across one (they stick where the last shot's target was). */
export function pointerIssues(project: Project): unknown[] {
  const issues: unknown[] = [];
  for (const clip of project.clips) {
    if (trackOf(project, clip.track)?.hidden === true) continue;
    if (isPointer(clip)) {
      const cut = firstCut(project, clip);
      if (cut !== null) issues.push({ kind: "pointer_off_target", clip: clip.id, start: clip.start, cut, name: clip.name ?? "", fix: `end it at ${cut} (its shot's cut), or move it onto its person in the next shot` });
      continue;
    }
    // Still blurs are blur_off_shot's own (mark_blurs.offShot).
    const still: (one: Clip) => boolean = stillRect;
    if (clip.type !== "adjustment" || (clip.blur?.radius ?? 0) <= 0 || still(clip)) continue;
    const cut = firstCut(project, clip);
    if (cut === null) continue;
    // A tracked blur moves where its target goes: a key at the cut (within 2 frames) is one that followed it.
    const into = cut - clip.start;
    const keys = [...(clip.keyframes?.["blur.x"] ?? []), ...(clip.keyframes?.["blur.y"] ?? [])];
    if (keys.some((key) => Math.abs(key.frame - into) <= 2)) continue;
    issues.push({ kind: "blur_off_shot", clip: clip.id, start: clip.start, cut, fix: `end it at ${cut}, or key it onto its target in the next shot` });
  }
  return issues;
}
