// A vignette (an adjustment's grade darkening the edges: the teasers' look,
// the film look, a bridge's treated room, a date's darkening) that snaps on
// or off: the user, Oct 21, on both interrogation edits: "it just abruptly
// cuts out the vignette and then one minute the vignette is there, the other
// it's not". Where no other vignette carries on across its edge, the edge
// fades (`vignette_snaps`; op ease_vignettes fades them all).

import type { AdjustmentClip, Project } from "./model.ts";
import { clipEnd, duration as durationOf, trackOf } from "./project.ts";

/** A grade's vignette at least this strong is seen. */
const LEAST = 0.2;
/** The fade an edge gets (frames), at most a quarter of the clip. */
const FADE = 12;
/** Clips shorter than this are flashes and slivers, not looks. */
const SHORTEST = 8;

type Edge = { clip: string; side: "in" | "out"; at: number };

function vignetted(project: Project, clip: Project["clips"][number]): clip is AdjustmentClip {
  if (clip.type !== "adjustment" || trackOf(project, clip.track)?.hidden === true) return false;
  return (clip.grade?.vignette ?? 0) >= LEAST && clip.duration >= SHORTEST;
}

/** Vignettes laid twice over the same stretch, the same grade (Helpful Wife's teasers had two of each): the later copies. */
export function doubled(project: Project): string[] {
  const looks = project.clips.filter((clip): clip is AdjustmentClip => vignetted(project, clip));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const clip of looks) {
    const key = `${clip.start}|${clip.duration}|${JSON.stringify(clip.grade)}|${JSON.stringify(clip.blur ?? null)}`;
    if (seen.has(key)) out.push(clip.id);
    else seen.add(key);
  }
  return out;
}

/** The edges of vignettes that snap: no fade there and no other vignette carrying on across it. */
export function snaps(project: Project): Edge[] {
  const twice = new Set(doubled(project));
  const looks = project.clips.filter((clip): clip is AdjustmentClip => vignetted(project, clip) && !twice.has(clip.id));
  const end = durationOf(project);
  const covered = (frame: number, self: string) => looks.some((other) => other.id !== self && other.start <= frame && clipEnd(other) > frame);
  const out: Edge[] = [];
  for (const clip of looks) {
    if (clip.start > 0 && (clip.fade_in ?? 0) <= 1 && !covered(clip.start - 1, clip.id)) out.push({ clip: clip.id, side: "in", at: clip.start });
    const last = clipEnd(clip);
    if (last < end && (clip.fade_out ?? 0) <= 1 && !covered(last, clip.id)) out.push({ clip: clip.id, side: "out", at: last });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The audit's issue: every snapping edge in one, with op ease_vignettes to fade them all. */
export function issues(project: Project): Record<string, unknown>[] {
  const found = snaps(project);
  const twice = doubled(project);
  if (found.length === 0 && twice.length === 0) return [];
  return [
    {
      kind: "vignette_snaps",
      count: found.length,
      at: found.slice(0, 12).map((edge) => edge.at),
      ...(twice.length > 0 ? { doubled: twice } : {}),
      fix: "op ease_vignettes fades each in or out (12 frames, a quarter of a short clip) where no other vignette carries on, and removes a vignette laid twice",
    },
  ];
}

/** Op ease_vignettes: fades every snapping edge (or those in start..end). */
export function ease(project: Project, args: Record<string, unknown>): Record<string, unknown> {
  const from = typeof args.start === "number" ? args.start : null;
  const to = typeof args.end === "number" ? args.end : null;
  const twice = new Set(doubled(project));
  project.clips = project.clips.filter((clip) => !twice.has(clip.id));
  let eased = 0;
  for (const edge of snaps(project)) {
    if ((from !== null && edge.at < from) || (to !== null && edge.at > to)) continue;
    const clip = project.clips.find((one) => one.id === edge.clip) as AdjustmentClip | undefined;
    if (clip === undefined) continue;
    const frames = Math.max(2, Math.min(FADE, Math.floor(clip.duration / 4)));
    if (edge.side === "in") clip.fade_in = frames;
    else clip.fade_out = frames;
    eased += 1;
  }
  return { eased, removed: [...twice] };
}
