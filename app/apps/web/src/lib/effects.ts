// Coded effects in the open project (Edit V2; the server's effects.ts): the
// graphics the agent writes as web pages. The viewer plays one by loading its
// page in a frame over the picture and telling it the playhead's moment
// (components/EffectLayer.tsx), so it plays the instant it's written. This is
// what the layer needs to know: which effects there are and when each last
// changed (a changed page is loaded again), and which one the playhead is on.

import { create } from "zustand";

import { request } from "./api";
import type { Project } from "./types";

export interface Effect {
  name: string;
  /** When its newest file changed (ms): part of its page's address, so a save loads it again. */
  changed: number;
  /** Its page's address on the server: it holds a key made anew each time Edit starts, so the list is asked for again then. */
  page: string;
}

export const useEffects = create<{ project: string | null; effects: Effect[] }>(() => ({ project: null, effects: [] }));

/** The project's effects from the server, which watches them from this ask on and says when one changes. */
export async function loadEffects(project: string): Promise<void> {
  useEffects.setState({ project, effects: [] });
  const { effects } = await request<{ effects: Effect[] }>("GET", `/api/projects/${project}/effects`);
  if (useEffects.getState().project === project) useEffects.setState({ effects });
}

if (typeof window !== "undefined") {
  // A new connection may be a new server (Edit restarted, a new build): its pages' addresses are new, so the list is asked for again.
  window.addEventListener("edit:connected", () => {
    const project = useEffects.getState().project;
    if (project === null) return;
    void request<{ effects: Effect[] }>("GET", `/api/projects/${project}/effects`)
      .then(({ effects }) => useEffects.getState().project === project && useEffects.setState({ effects }))
      // Noted by api.ts; the next connection asks again.
      .catch(() => {});
  });
  window.addEventListener("edit:effects", (event) => {
    const { id, effects } = (event as CustomEvent<{ id: string; effects: Effect[] }>).detail;
    if (useEffects.getState().project === id) useEffects.setState({ effects });
  });
}

/** An effect's page as the frame loads it. */
export function effectAddress(effect: Pick<Effect, "page" | "changed">): string {
  return `${effect.page}?v=${effect.changed}`;
}

export interface Playing {
  name: string;
  /** The second of the effect the playhead is on. */
  seconds: number;
}

/** A showing of an effect on the timeline: what the layer needs of its clip. */
export interface Showing {
  name: string;
  /** Frames. */
  start: number;
  end: number;
  /** The second of the effect its first frame shows, and how fast it plays. */
  from: number;
  speed: number;
  /** Its track's place among the tracks (the higher is drawn over the lower). */
  track: number;
}

/** Every showing of an effect in the project: found once a change, not once a frame (most projects have none). */
export function showings(project: Project): Showing[] {
  const effects = new Map<string, string>();
  for (const media of project.media) if (media.effect !== undefined && media.effect !== null) effects.set(media.id, media.effect);
  if (effects.size === 0) return [];
  const found: Showing[] = [];
  for (const clip of project.clips) {
    if (clip.type !== "video") continue;
    const name = effects.get(clip.media);
    if (name === undefined) continue;
    found.push({ name, start: clip.start, end: clip.start + clip.duration, from: clip.source_in, speed: clip.speed, track: project.tracks.findIndex((one) => one.id === clip.track) });
  }
  return found;
}

/** How far ahead of the playhead an effect's page is loaded, so it's drawn by the time its clip starts. */
const AHEAD_SECONDS = 3;

/**
 * The effects at `frame`: the one whose clip the playhead is on (the topmost
 * track's, when two overlap) with the second of it to draw, and `near`, every
 * effect on the playhead or starting within three seconds, whose pages are
 * kept loaded.
 */
export function effectsAt(shown: Showing[], fps: number, frame: number): { playing: Playing | null; near: string[] } {
  let playing: Playing | null = null;
  let top = -1;
  const near: string[] = [];
  for (const showing of shown) {
    if (frame >= showing.end || frame + AHEAD_SECONDS * fps < showing.start) continue;
    if (!near.includes(showing.name)) near.push(showing.name);
    if (frame < showing.start || showing.track <= top) continue;
    top = showing.track;
    playing = { name: showing.name, seconds: showing.from + ((frame - showing.start) / fps) * showing.speed };
  }
  return { playing, near };
}
