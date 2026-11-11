// The crossfade at each cut between footage sounds, as edit-core's
// `audio_segments` makes it for the export and Edit.app's player
// (crates/edit-core/src/eval.rs), for the page's own player
// (apps/web/src/lib/playback.ts). JJ, Nov 10: "the two sounds overlapping and
// blended" at a cut, not one fading down and the next fading up. Each step
// here is that function's; a change to one is a change to both, and the tests
// on each side (eval.rs, apps/web/src/lib/crossfades.test.ts) pin the same cuts.

import type { Clip, Media, Project } from "./generated";

/** The most a cut's crossfade reaches either side of it (seconds): edit-core's CROSSFADE_REACH. */
export const CROSSFADE_REACH = 0.12;
/** Shorter than this in all, a cut stays as it was: edit-core's CROSSFADE_LEAST. */
export const CROSSFADE_LEAST = 0.01;

/** The equal-power curve `x` of the way through a crossfade (edit-core's `crossfade_gain`). */
export function crossfadeGain(x: number): number {
  return Math.sin(Math.min(1, Math.max(0, x)) * (Math.PI / 2));
}

/** How a clip's sound plays past its own edges, in seconds: early (`lead`), on (`tail`), and its crossfades' lengths at each end. */
export interface SoundEdges {
  lead: number;
  tail: number;
  crossIn: number;
  crossOut: number;
}

/** edit-core's `Crossfade`: the incoming sound from `lead` before the cut rising until `fadeIn` after it; the outgoing falling from `fadeOut` before it on to `tail` past it. */
interface Cut {
  lead: number;
  fadeIn: number;
  fadeOut: number;
  tail: number;
}

type AudioClip = Extract<Clip, { type: "audio" }>;

const fpsOf = (project: Project): number => {
  const whole = Math.max(project.settings.fps, 1);
  return project.settings.ntsc === true ? (whole * 1000) / 1001 : whole;
};

/** Every heard audio clip whose sound a cut's crossfade carries past its edges, by id. */
export function crossfades(project: Project): Map<string, SoundEdges> {
  const fps = fpsOf(project);
  const audioTracks = new Set(project.tracks.filter((track) => track.kind === "audio" && track.muted !== true).map((track) => track.id));
  const heard = project.clips
    .filter((clip): clip is AudioClip => clip.type === "audio" && audioTracks.has(clip.track))
    .sort((a, b) => (a.track < b.track ? -1 : a.track > b.track ? 1 : a.start - b.start));
  const media = new Map(project.media.map((one) => [one.id, one]));
  const out = new Map<string, SoundEdges>();
  const edges = (id: string) => {
    let found = out.get(id);
    if (found === undefined) out.set(id, (found = { lead: 0, tail: 0, crossIn: 0, crossOut: 0 }));
    return found;
  };
  for (let index = 1; index < heard.length; index++) {
    const before = heard[index - 1]!;
    const after = heard[index]!;
    const cut = crossfade(media, fps, before, after);
    if (cut === null) continue;
    const out = edges(before.id);
    out.tail = cut.tail;
    out.crossOut = cut.fadeOut + cut.tail;
    const into = edges(after.id);
    into.lead = cut.lead;
    into.crossIn = cut.lead + cut.fadeIn;
  }
  return out;
}

/** edit-core's `crossfade`: the cut from `before` to `after`, or null. */
function crossfade(media: Map<string, Media>, fps: number, before: AudioClip, after: AudioClip): Cut | null {
  if (before.track !== after.track || before.start + before.duration !== after.start) return null;
  const footage = (id: string) => {
    const file = media.get(id);
    return file !== undefined && (file.library === undefined || file.library === null) && file.has_audio ? file : null;
  };
  const from = footage(before.media);
  if (from === null || footage(after.media) === null) return null;
  const fromSpeed = before.speed ?? 1;
  const toSpeed = after.speed ?? 1;
  const fromIn = before.source_in ?? 0;
  const toIn = after.source_in ?? 0;
  const fromOut = fromIn + (before.duration / fps) * fromSpeed;
  if (before.media === after.media && Math.abs(toIn - fromOut) < 0.5 / fps && Math.abs(toSpeed - fromSpeed) < 1e-9) return null;
  if (before.room == null || after.room == null) return null;
  const fromLength = before.duration / fps;
  const toLength = after.duration / fps;
  // Seconds of quiet each way, on the timeline: what the edit cut out either side, and each clip's own edge.
  const quiet = (seconds: number, speed: number, most: number) => Math.min(Math.max(0, seconds) / speed, CROSSFADE_REACH, most);
  const cut: Cut = {
    lead: quiet(toIn - Math.max(0, after.room.from), toSpeed, fromLength),
    fadeIn: quiet(after.room.words_from - toIn, toSpeed, toLength / 2),
    fadeOut: quiet(fromOut - before.room.words_to, fromSpeed, fromLength / 2),
    tail: quiet(Math.min(before.room.to, from.duration) - fromOut, fromSpeed, toLength),
  };
  return cut.lead + cut.fadeIn >= CROSSFADE_LEAST || cut.fadeOut + cut.tail >= CROSSFADE_LEAST ? cut : null;
}
