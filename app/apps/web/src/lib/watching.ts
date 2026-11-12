// Watching on while the agent works (Sphe, Nov 12: "it would probably be
// great if we put together a pretty good system here where we're still able
// to watch videos quite normally while the agent builds its thing out until
// it's done… it just gets added to wherever we are in the video and doesn't
// interrupt us"). A Bodycam HQ viewer pins the version it was playing when a
// turn began (its smooth render, the edit as it was), and the agent's saves
// build up out of view; once the turn is over and the new version's render is
// in, the viewer moves to it where the picture cuts anyway (or at once if it's
// paused), on the same moment of the same shot. The server keeps the pinned
// render playable meanwhile (playback_stream.ts keepPrevious).

import { create } from "zustand";

import type { PlaybackStatus } from "./store";
import { rate, type Clip, type Project } from "./types";

export interface Pinned {
  /** The edit as it was when the turn began, and its revision. */
  project: Project;
  rev: number;
  /** Its render's status then (ready, this revision). */
  playback: PlaybackStatus;
}

export const useWatching = create<{ pinned: Pinned | null }>(() => ({ pinned: null }));

/** The pin that holds for the project open: one left from another counts for nothing (its revision isn't this one's). */
export function pinFor(pinned: Pinned | null, project: string | null): Pinned | null {
  return pinned !== null && pinned.project.id === project ? pinned : null;
}

const end = (clip: Clip) => clip.start + clip.duration;

type Shot = Extract<Clip, { type: "video" }>;
const isShot = (clip: Clip): clip is Shot => clip.type === "video";

/** The shots under `frame`, the footage's first: picture clips, the bottom track's first. */
function under(project: Project, frame: number): Shot[] {
  const order = new Map(project.tracks.map((track, index) => [track.id, index]));
  return project.clips
    .filter(isShot)
    .filter((clip) => clip.start <= frame && frame < end(clip))
    .sort((a, b) => (order.get(a.track) ?? 0) - (order.get(b.track) ?? 0));
}

/**
 * Where `frame` of `from` is in `to`: the same moment of the same shot (a cut
 * or a cut-in made before it moves it), else the same frame, inside `to`.
 */
export function mapFrame(from: Project, to: Project, frame: number): number {
  const fps = rate(from.settings);
  const last = Math.max(0, to.clips.reduce((most, clip) => Math.max(most, end(clip)), 0) - 1);
  for (const was of under(from, frame)) {
    const now = to.clips.filter(isShot).find((clip) => clip.id === was.id && clip.media === was.media);
    if (now === undefined) continue;
    // The second of its source on screen, then where that second is now.
    const second = was.source_in + ((frame - was.start) / fps) * was.speed;
    const at = now.start + ((second - now.source_in) / now.speed) * fps;
    if (at >= now.start && at < end(now)) return Math.round(at);
  }
  return Math.min(Math.round(frame), last);
}

/** The frames a pinned version cuts at after `frame`: where swapping to the new one shows least. */
export function cutsAfter(project: Project, frame: number): number[] {
  return [...new Set(project.clips.filter((clip) => clip.type === "video" && clip.start > frame).map((clip) => clip.start))].sort((a, b) => a - b);
}
