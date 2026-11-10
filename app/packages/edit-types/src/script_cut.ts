// A script's cut as the small edit Edit.app's window player takes
// (docs/plans/2026-11-10-script-player.md; Sphe, Nov 10: "When one is
// improved, the other should be improved as well"). Script mode had a player
// of its own in the page, so every improvement to the editor's player (the
// Mac's decoder, the speaker's clock, cuts decoded ahead) passed it by. Here
// the cut becomes a project that player draws: one picture track and one
// sound track, a clip of each per footage item, and black where a card is (the
// monitor draws the card over it). Pure, so the page and the server's tests
// read the same thing; the engine's own rules (`Project::validate`) are
// checked against it in apps/server/test/script_cut.test.ts.

import type { Clip, Media, Project } from "./generated";

/** The cut's frame rate: script proxies are conformed to 30 fps when they're made (writer/media.ts). */
export const CUT_FPS = 30;

/** An item of the cut: a stretch `[startMs, endMs)` of the recording `src`, or a card with no picture. */
export interface CutItem {
  startMs: number;
  endMs: number;
  card: boolean;
  /** The recording it plays from ("" for a card, or one that isn't known yet). */
  src: string;
}

/** A recording as the window reads it: a file on this Mac, and what's in it. */
export interface CutSource {
  path: string;
  width: number;
  height: number;
  durationMs: number;
  fps: number;
  sound: boolean;
}

/** The cut as an edit, and the frame each item starts at (the cut's length last). */
export interface Cut {
  project: Project;
  starts: number[];
}

/** The frame an edited moment falls in. */
export const frameAt = (ms: number): number => Math.max(0, Math.floor((ms * CUT_FPS) / 1000 + 1e-6));
/** The edited moment a frame (and a fraction) is. */
export const msAt = (frame: number): number => (frame * 1000) / CUT_FPS;
/** A boundary between items, on the frame grid: the nearest frame, so lengths never drift from the edited clock. */
const edge = (ms: number): number => Math.max(0, Math.round((ms * CUT_FPS) / 1000));

const media = (src: string, source: CutSource): Media => ({
  id: src,
  name: src,
  path: source.path,
  kind: source.width > 0 && source.height > 0 ? "video" : "audio",
  duration: Math.max(source.durationMs / 1000, 1 / CUT_FPS),
  width: source.width,
  height: source.height,
  fps: source.fps > 0 ? source.fps : CUT_FPS,
  has_audio: source.sound,
});

const pair = (at: number, source: Media, start: number, duration: number, sourceIn: number): Clip[] => {
  const base = { start, duration, color: "blue" as const, fade_in: 0, fade_out: 0, link: `l${at}`, media: source.id, source_in: sourceIn, speed: 1 };
  const out: Clip[] = [];
  if (source.kind === "video") out.push({ ...base, id: `v${at}`, track: "v1", type: "video", transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 });
  if (source.has_audio || source.kind === "audio") out.push({ ...base, id: `a${at}`, track: "a1", type: "audio", volume_db: 0 });
  return out;
};

const shell = (id: string, used: Media[], clips: Clip[], length: number): Project => {
  // The picture's shape is the first recording's: a script's one proxy, a commentary's first clip; the rest are fitted into it.
  const first = used.find((one) => one.kind === "video");
  // Black under everything, the cut's whole length: a cut that ends on a card plays to the card's end
  // (the player stops at the last clip's), and a card is black under the monitor's words.
  if (length > 0) clips = [{ id: "base", track: "v0", start: 0, duration: length, color: "blue", fade_in: 0, fade_out: 0, type: "solid", fill: [0, 0, 0, 1], opacity: 1 }, ...clips];
  return {
    version: 1,
    id,
    name: "Script preview",
    style: "bodycam",
    settings: { width: first?.width ?? 1920, height: first?.height ?? 1080, fps: CUT_FPS },
    media: used,
    tracks: [
      { id: "v0", kind: "video", hidden: false, muted: false, locked: false },
      { id: "v1", kind: "video", hidden: false, muted: false, locked: false },
      { id: "a1", kind: "audio", hidden: false, muted: false, locked: false },
    ],
    clips,
    next_id: 1,
  };
};

/**
 * The cut as an edit: each footage item whose recording is in `sources` a
 * linked picture and sound clip from its `startMs`, each card (and an item
 * with no recording here) a gap as long. Item boundaries land on the nearest
 * frame of the edited clock, so frame `f` is edited moment `msAt(f)` wherever
 * it is in the cut; an item shorter than a frame has no clip.
 */
export function cutProject(id: string, items: CutItem[], sources: Record<string, CutSource>): Cut {
  const starts: number[] = [];
  const used = new Map<string, Media>();
  const clips: Clip[] = [];
  let ms = 0;
  items.forEach((item, at) => {
    const start = edge(ms);
    starts.push(start);
    ms += Math.max(0, item.endMs - item.startMs);
    const duration = edge(ms) - start;
    const source = item.card || item.src === "" ? undefined : sources[item.src];
    if (source === undefined || duration <= 0) return;
    let known = used.get(item.src);
    if (known === undefined) {
      known = media(item.src, source);
      used.set(item.src, known);
    }
    clips.push(...pair(at, known, start, duration, Math.max(0, item.startMs) / 1000));
  });
  starts.push(edge(ms));
  return { project: shell(id, [...used.values()], clips, edge(ms)), starts };
}

/**
 * A recording straight through, outside the cut (a word double-clicked in the
 * transcript, a found moment): the same edit with one clip, the whole of
 * `src`, so frame `f` is the footage's own moment `msAt(f)`.
 */
export function auditionProject(id: string, src: string, source: CutSource): Cut {
  const one = media(src, source);
  const duration = Math.max(1, edge(source.durationMs));
  return { project: shell(id, [one], pair(0, one, 0, duration, 0), duration), starts: [0, duration] };
}
