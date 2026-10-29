// A Short's camera: 16:9 footage in a 9:16 frame, filled (cropped to the
// frame's height) and moved so whoever matters stays in the middle. The team
// (Oct 29): "making keyframes so we move around on the screen and always
// center what has to be centered". The subject is the face Apple's detector
// finds (faces.ts, two a second of source, cached per file): the biggest one
// at first, then the same person while they're there. The camera holds still
// while they stay in the middle of the frame and moves only when they'd leave
// it, eased, like an operator, never jittering after every step. Where no
// face is seen (a redaction blur, a car, someone with their back turned) the
// agent says where to look instead (`centres`, from looking at the frames).

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { RATE, smooth, type Face, type Faces } from "./faces.ts";
import { registerTool, text } from "./mcp/registry.ts";
import type { Keyframe, Media, Project, VideoClip } from "./model.ts";
import { clipEnd, fps as fpsOf, mediaOf, trackOf } from "./project.ts";
import * as seams from "./seams.ts";

/** How far the subject may drift from the middle before the camera follows: a share of the frame's width each side. */
const DEAD = 0.15;
/** The camera's pace (frame widths a second) and how long a move takes at least and at most (seconds). */
const PACE = 0.9;
const SHORTEST_MOVE = 0.35;
const LONGEST_MOVE = 1.0;
/** A face this much smaller than the biggest one there is someone in the background. */
const BACKGROUND = 0.6;

/** How much bigger than fitting a picture of `media` size is drawn to fill `frame` (cropping its sides or top). */
export function fillScale(media: [number, number], frame: [number, number]): number {
  const [mw, mh] = [Math.max(media[0], 1), Math.max(media[1], 1)];
  const fit = Math.min(frame[0] / mw, frame[1] / mh);
  const cover = Math.max(frame[0] / mw, frame[1] / mh);
  return cover / fit;
}

function centreOf(face: Face): number {
  return (face[0] + face[2]) / 2;
}

function heightOf(face: Face): number {
  return face[3] - face[1];
}

/**
 * The subject's centre (a share of the picture's width) at each of `indexes`,
 * null where no face is seen: the biggest face first, then whoever is nearest
 * where the subject was among the faces not far in the background.
 */
export function subjectPath(found: Faces, indexes: number[]): (number | null)[] {
  let last: number | null = null;
  return indexes.map((index) => {
    const faces = found.get(index) ?? [];
    if (faces.length === 0) return null;
    const biggest = Math.max(...faces.map(heightOf));
    const near = faces.filter((face) => heightOf(face) >= biggest * BACKGROUND);
    const chosen: Face =
      last === null
        ? near.reduce((a, b) => (heightOf(b) > heightOf(a) ? b : a))
        : near.reduce((a, b) => (Math.abs(centreOf(b) - last!) < Math.abs(centreOf(a) - last!) ? b : a));
    last = centreOf(chosen);
    return last;
  });
}

/**
 * The camera for one clip: its x keyframes (frames from the clip's start)
 * keeping the subject in the middle. `path` is the subject's centre (share of
 * the picture's width, null unseen) at `at` (clip frames); `picture` the
 * filled picture's width and `frame` the frame's, in project pixels. Holds
 * while the subject is within the middle, moves (eased) when they'd leave it.
 * Null keys: one place throughout (`x`).
 */
export function cameraKeys(path: (number | null)[], at: number[], picture: number, frame: number, fps: number): { x: number; keys: Keyframe[] | null; moves: number } {
  const limit = Math.max(0, (picture - frame) / 2);
  const seen = path.findIndex((share) => share !== null);
  if (seen < 0) return { x: 0, keys: null, moves: 0 };
  // Unseen samples keep where the subject was last (the first seen, before it).
  let carry = path[seen]!;
  const filled = path.map((share) => (carry = share ?? carry));
  const wanted = smooth(filled.map((share, index) => [at[index]!, Math.min(limit, Math.max(-limit, (0.5 - share) * picture))] as [number, number])).map(([, x]) => Math.round(x));
  let held = wanted[0]!;
  const keys: Keyframe[] = [{ frame: 0, value: held, ease: "hold" }];
  let busyUntil = -1;
  let moves = 0;
  for (let index = 1; index < wanted.length; index++) {
    const now = at[index]!;
    if (now <= busyUntil) continue;
    const off = (value: number) => Math.abs(value - held) > DEAD * frame;
    // Moved for a second (two samples), not a glance away.
    const next = wanted[Math.min(index + 1, wanted.length - 1)]!;
    if (!off(wanted[index]!) || !off(next)) continue;
    // Where they settle: the smoothing spreads a step over two samples each side.
    const target = wanted[Math.min(index + 2, wanted.length - 1)]!;
    const seconds = Math.min(LONGEST_MOVE, Math.max(SHORTEST_MOVE, Math.abs(target - held) / (PACE * frame)));
    const start = Math.max(keys.at(-1)!.frame + 1, Math.round(now - fps / 4));
    const end = start + Math.round(seconds * fps);
    keys.push({ frame: start, value: held, ease: "in_out" }, { frame: end, value: target, ease: "hold" });
    held = target;
    busyUntil = end;
    moves += 1;
  }
  return moves === 0 ? { x: held, keys: null, moves: 0 } : { x: keys[0]!.value, keys, moves };
}

/** Where the agent says to look in a clip: timeline seconds and a share of the source picture's width. */
export interface Centre {
  time: number;
  x: number;
}

/** What one clip got. */
export interface Framed {
  clip: string;
  scale: number;
  moves: number;
  /** Where the camera looked: faces found (a share of the samples), the agent's centres, or nothing (centred). */
  by: string;
}

/** The landscape footage clips a Short shows (video media wider than the frame, on visible tracks). */
function footageOf(project: Project, ids: string[] | null): VideoClip[] {
  const frame = project.settings;
  return project.clips.filter((clip): clip is VideoClip => {
    if (clip.type !== "video" || (ids !== null && !ids.includes(clip.id))) return false;
    if (ids === null && trackOf(project, clip.track)?.hidden === true) return false;
    const media = mediaOf(project, clip.media);
    return media !== undefined && media.kind === "video" && media.width / Math.max(media.height, 1) > frame.width / frame.height + 0.01;
  });
}

/** Sample indexes (source seconds × RATE) under a clip. */
function indexesOf(clip: VideoClip, fps: number): number[] {
  const from = Math.floor(clip.source_in * RATE);
  const to = Math.ceil((clip.source_in + (clip.duration / fps) * clip.speed) * RATE);
  const out: number[] = [];
  for (let index = from; index <= to; index++) out.push(index);
  return out;
}

/**
 * Fills a 9:16 project's footage and keyframes its x to follow the subject:
 * `ids` the clips (all landscape footage when null), `centres` the agent's
 * own places to look (they replace the faces in the clips they fall in).
 */
export async function reframe(app: App, projectId: string, ids: string[] | null, centres: Centre[]): Promise<Framed[]> {
  const live = app.store.get(projectId);
  if (live === null) throw new Error("no such project");
  const project = live.project;
  const { width, height } = project.settings;
  if (height <= width) throw new Error("reframe is for a 9:16 project (a Short): this one is landscape");
  const fps = fpsOf(project);
  const clips = footageOf(project, ids);
  if (clips.length === 0) throw new Error(ids === null ? "no landscape footage to reframe" : "none of those clips is landscape footage");
  // The faces each file shows, looked for once per file.
  const wanted = new Map<string, [Media, Set<number>]>();
  for (const clip of clips) {
    if (centres.some((centre) => inClip(clip, centre, fps))) continue;
    const media = mediaOf(project, clip.media)!;
    const entry = wanted.get(media.path) ?? [media, new Set<number>()];
    for (const index of indexesOf(clip, fps)) entry[1].add(index);
    wanted.set(media.path, entry);
  }
  const found = new Map<string, Faces>();
  for (const [path, [media, indexes]] of wanted) {
    try {
      found.set(path, await seams.faces.detect(path, [media.width, media.height], [...indexes].sort((a, b) => a - b)));
    } catch (error) {
      diag.warn("reframe", `faces in ${media.name}: ${diag.messageOf(error)}; centred`);
    }
  }
  const plans = clips.map((clip) => {
    const media = mediaOf(project, clip.media)!;
    const scale = fillScale([media.width, media.height], [width, height]);
    const fit = Math.min(width / media.width, height / media.height);
    const picture = media.width * fit * scale;
    const own = centres.filter((centre) => inClip(clip, centre, fps)).sort((a, b) => a.time - b.time);
    const indexes = indexesOf(clip, fps);
    const at = indexes.map((index) => ((index / RATE - clip.source_in) / clip.speed) * fps);
    let path: (number | null)[];
    let by: string;
    if (own.length > 0) {
      // The agent's places, each held from its time on (the first from the start).
      const times = own.map((centre) => (centre.time * fps - clip.start));
      path = at.map((frame) => {
        let chosen = own[0]!.x;
        times.forEach((time, index) => {
          if (time <= frame) chosen = own[index]!.x;
        });
        return chosen;
      });
      by = `your ${own.length} centre${own.length === 1 ? "" : "s"}`;
    } else {
      path = subjectPath(found.get(media.path) ?? new Map(), indexes);
      const share = path.filter((one) => one !== null).length / Math.max(path.length, 1);
      by = share === 0 ? "no face seen: centred (give centres where the subject is)" : `faces in ${Math.round(share * 100)}% of it`;
    }
    const camera = cameraKeys(path, at, picture, width, fps);
    const keys = camera.keys?.filter((key) => key.frame < clip.duration) ?? null;
    return { clip: clip.id, scale, camera, keys, by };
  });
  await app.store.update(projectId, "agent", (edited) => {
    for (const plan of plans) {
      const clip = edited.clips.find((one) => one.id === plan.clip);
      if (clip === undefined || clip.type !== "video") continue;
      clip.transform = { ...clip.transform, x: plan.camera.x, y: 0, scale: plan.scale };
      const keyframes = { ...(clip.keyframes ?? {}) };
      delete keyframes.x;
      delete keyframes.y;
      delete keyframes.scale;
      if (plan.keys !== null && plan.keys.length > 1) keyframes.x = plan.keys;
      clip.keyframes = keyframes;
    }
  });
  return plans.map((plan) => ({ clip: plan.clip, scale: Math.round(plan.scale * 1000) / 1000, moves: plan.camera.moves, by: plan.by }));
}

function inClip(clip: VideoClip, centre: Centre, fps: number): boolean {
  const frame = centre.time * fps;
  return frame >= clip.start && frame < clipEnd(clip);
}

registerTool("reframe", async ({ app, args, projectId }) => {
  const ids = Array.isArray(args.clip_ids) ? args.clip_ids.filter((id): id is string => typeof id === "string") : null;
  const centres: Centre[] = [];
  for (const one of Array.isArray(args.centres) ? (args.centres as unknown[]) : []) {
    const centre = (typeof one === "object" && one !== null ? one : {}) as Record<string, unknown>;
    if (typeof centre.time !== "number" || typeof centre.x !== "number" || !(centre.x >= 0 && centre.x <= 1)) {
      throw new Error("each of centres is {time: timeline seconds, x: 0–1 across the source picture}");
    }
    centres.push({ time: centre.time, x: centre.x });
  }
  const framed = await diag.timeAsync("reframe", "reframe", () => reframe(app, projectId, ids, centres));
  return text(framed.map((one) => `${one.clip}: filled ×${one.scale}, ${one.moves} move${one.moves === 1 ? "" : "s"}, ${one.by}`).join("\n"));
});
