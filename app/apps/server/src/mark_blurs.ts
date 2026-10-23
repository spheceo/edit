// Blurs that stick to another outlet's mark (a channel's logo, a station's
// bug) on the shot that carries it, as After Effects' tracked masks do. The
// team (Marius, Judge EXPLODES): "Blur stays on the screen for no reason… I
// recommend for the bot to do something, where the blur is sticky on the logo,
// no matter if you zoom in specific places or switch frame to something else"
// and "everytime there's a transition in footage it happens". The agent's
// blurs were rectangles on the screen: each was laid over a run of shots, so
// it stayed on after its shot had gone, and big enough (690 × 680) to cover
// the logo while the push-in moved it.
//
// Here a blur belongs to one clip: it starts and ends with the clip, its box
// is the mark's (from watermarks.ts) moved and scaled with the clip's own
// framing as it pushes in, and it fades as the clip's picture shows through a
// dissolve: in with the clip's fade-in, out as the next shot on a higher
// track fades in over it, gone while a picture that fills the frame covers it.
// `blur_marks` (a plan op) lays them for every mark still showing on the
// timeline and takes away the hand-laid rectangles they replace; the audit's
// `blur_off_shot` names a still rectangle that outlives its shot.

import type { AdjustmentClip, Clip, Keyframe, Media, Project, VideoClip } from "./model.ts";
import { addTrack, clipEnd, freshId, mediaOf, sample, trackOf } from "./project.ts";
import { round } from "./rust.ts";
import * as watermarks from "./watermarks.ts";

/** The house blur: strong enough that a logo can't be read. */
const RADIUS = 35;
/** Frames between the keys of a moving blur (a push-in is smooth: linear between them is within a pixel). */
const STEP = 4;
/** The mark's box grown by this share each way, plus FEATHER, so a model's box a little off still covers it. */
const GROW = 0.15;
const FEATHER = 10;
/** Every blur this lays is named so; a re-run replaces them. */
export const NAME = "Mark blur";

/** A picture clip's framing at a frame of the clip (its own seconds from its start). */
function framingAt(clip: VideoClip, frame: number): { x: number; y: number; scale: number } {
  const at = (param: "x" | "y" | "scale", base: number) => {
    const keys = clip.keyframes?.[param];
    return keys !== undefined && keys.length > 0 ? (sample(keys, frame) ?? base) : base;
  };
  return { x: at("x", clip.transform.x), y: at("y", clip.transform.y), scale: at("scale", clip.transform.scale) };
}

/** A mark's box on the frame at a frame of the clip: centre x, y and size in project px. */
export function boxAt(project: Project, clip: VideoClip, media: Media, mark: watermarks.Mark["box"], frame: number): [number, number, number, number] {
  const { width, height } = project.settings;
  const [mw, mh] = [media.width || width, media.height || height];
  const { x, y, scale } = framingAt(clip, frame);
  const fit = Math.min(width / mw, height / mh) * scale;
  const [x0, y0, x1, y1] = mark;
  const w = (x1 - x0) * mw * fit;
  const h = (y1 - y0) * mh * fit;
  return [((x0 + x1) / 2 - 0.5) * mw * fit + x, ((y0 + y1) / 2 - 0.5) * mh * fit + y, w * (1 + 2 * GROW) + 2 * FEATHER, h * (1 + 2 * GROW) + 2 * FEATHER];
}

/** How much of a clip's own picture shows at a frame of the timeline (0–1): its fades and opacity. */
function ownAlpha(clip: Clip, frame: number): number {
  if (frame < clip.start || frame >= clipEnd(clip)) return 0;
  const into = frame - clip.start;
  const left = clipEnd(clip) - frame;
  let alpha = clip.type === "video" || clip.type === "solid" ? (clip.opacity ?? 1) : 1;
  const keys = clip.keyframes?.opacity;
  if (keys !== undefined && keys.length > 0) alpha = sample(keys, into) ?? alpha;
  if (clip.fade_in > 0 && into < clip.fade_in) alpha *= into / clip.fade_in;
  if (clip.fade_out > 0 && left < clip.fade_out) alpha *= left / clip.fade_out;
  return Math.min(Math.max(alpha, 0), 1);
}

/** Whether a picture clip covers the whole frame (footage or a photo filled, a solid): what's under it can't be seen. */
function fillsFrame(project: Project, clip: Clip): boolean {
  if (clip.type === "solid") return true;
  if (clip.type !== "video") return false;
  const media = mediaOf(project, clip.media);
  if (media === undefined || (media.kind !== "video" && media.kind !== "image")) return false;
  const { width, height } = project.settings;
  const [mw, mh] = [media.width || width, media.height || height];
  const { x, y, scale } = framingAt(clip, 0);
  const fit = Math.min(width / mw, height / mh) * scale;
  const crop = clip.crop ?? { left: 0, right: 0, top: 0, bottom: 0 };
  const left = x - mw * fit * (0.5 - (crop.left ?? 0));
  const right = x + mw * fit * (0.5 - (crop.right ?? 0));
  const top = y - mh * fit * (0.5 - (crop.top ?? 0));
  const bottom = y + mh * fit * (0.5 - (crop.bottom ?? 0));
  return left <= -width / 2 + 2 && right >= width / 2 - 2 && top <= -height / 2 + 2 && bottom >= height / 2 - 2;
}

/** How much of the clip shows at each frame of its span: its own alpha under every frame-filling picture above it. */
function visibility(project: Project, clip: VideoClip): number[] {
  const index = (track: string) => project.tracks.findIndex((one) => one.id === track);
  const mine = index(clip.track);
  const above = project.clips.filter(
    (other) =>
      other.id !== clip.id &&
      index(other.track) > mine &&
      trackOf(project, other.track)?.hidden !== true &&
      other.start < clipEnd(clip) &&
      clipEnd(other) > clip.start &&
      fillsFrame(project, other),
  );
  const out: number[] = [];
  for (let frame = clip.start; frame < clipEnd(clip); frame++) {
    let alpha = ownAlpha(clip, frame);
    for (const other of above) alpha *= 1 - ownAlpha(other, frame);
    out.push(alpha);
  }
  return out;
}

/** The runs of frames (clip's own) where it shows at all, with the alpha at each. */
function shownRuns(alpha: number[]): [number, number][] {
  const runs: [number, number][] = [];
  let from: number | null = null;
  alpha.forEach((value, frame) => {
    if (value > 0.02 && from === null) from = frame;
    if (value <= 0.02 && from !== null) {
      runs.push([from, frame]);
      from = null;
    }
  });
  if (from !== null) runs.push([from, alpha.length]);
  // Two frames or fewer is a dissolve's tail, not a shot.
  return runs.filter(([a, b]) => b - a > 2);
}

/** Keys every STEP frames over [from, to) of `values` (and its last frame), dropped when they never change. */
function keysOf(values: number[], from: number, to: number, offset: number): Keyframe[] | null {
  const frames: number[] = [];
  for (let frame = from; frame < to; frame += STEP) frames.push(frame);
  if (frames[frames.length - 1] !== to - 1) frames.push(to - 1);
  const keys = frames.map((frame) => ({ frame: frame - offset, value: round(values[frame]! * 1000) / 1000, ease: "linear" as const }));
  return keys.every((key) => Math.abs(key.value - keys[0]!.value) < 0.5) ? null : keys;
}

/** The sticky blurs for one clip and one mark: one adjustment per run of frames where the clip shows. */
export function blursFor(project: Project, clip: VideoClip, media: Media, mark: watermarks.Mark): AdjustmentClip[] {
  const alpha = visibility(project, clip);
  const out: AdjustmentClip[] = [];
  for (const [from, to] of shownRuns(alpha)) {
    const boxes = alpha.map((_, frame) => boxAt(project, clip, media, mark.box, frame));
    const [x, y, w, h] = boxes[from]!;
    const keyframes: Record<string, Keyframe[]> = {};
    const params = ["blur.x", "blur.y", "blur.width", "blur.height"] as const;
    params.forEach((param, at) => {
      const keys = keysOf(
        boxes.map((box) => box[at]!),
        from,
        to,
        from,
      );
      if (keys !== null) keyframes[param] = keys;
    });
    // Its strength follows the picture through a dissolve (an adjustment's
    // opacity mixes it in), so it fades exactly as the logo does.
    const fade = alpha.slice(from, to);
    if (fade.some((value) => value < 0.98)) {
      // A key where the fade turns (a ramp starts or ends) and every other frame on a ramp.
      const keys: Keyframe[] = [];
      fade.forEach((value, frame) => {
        const before = fade[frame - 1] ?? value;
        const after = fade[frame + 1] ?? value;
        const flat = Math.abs(before - value) < 0.001 && Math.abs(after - value) < 0.001;
        if (frame === 0 || frame === fade.length - 1 || (!flat && frame % 2 === 0) || (Math.abs(before - value) < 0.001) !== (Math.abs(after - value) < 0.001)) {
          keys.push({ frame, value: round(value * 1000) / 1000, ease: "linear" });
        }
      });
      keyframes.opacity = keys;
    }
    out.push({
      id: "",
      track: "",
      start: clip.start + from,
      duration: to - from,
      color: "blue",
      name: `${NAME} · ${mark.text || "mark"}`,
      fade_in: 0,
      fade_out: 0,
      ...(Object.keys(keyframes).length > 0 ? { keyframes } : {}),
      type: "adjustment",
      grade: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, vignette: 0 },
      blur: { radius: RADIUS, x: round(x), y: round(y), width: round(w), height: round(h), feather: FEATHER, shape: "rect" },
      opacity: 1,
    } as AdjustmentClip);
  }
  return out;
}

/** A still rect blur (not tracked, not a face's): what blur_marks replaces and blur_off_shot judges. */
function stillRect(clip: Clip): clip is AdjustmentClip {
  if (clip.type !== "adjustment" || (clip.blur?.radius ?? 0) <= 0 || clip.blur?.shape !== "rect") return false;
  const keys = clip.keyframes ?? {};
  return !["blur.x", "blur.y"].some((param) => (keys[param]?.length ?? 0) > 0);
}

/** Overlap (share of the smaller) of two centre/size boxes. */
function overlap(a: [number, number, number, number], b: [number, number, number, number]): number {
  const dx = Math.min(a[0] + a[2] / 2, b[0] + b[2] / 2) - Math.max(a[0] - a[2] / 2, b[0] - b[2] / 2);
  const dy = Math.min(a[1] + a[3] / 2, b[1] + b[3] / 2) - Math.max(a[1] - a[3] / 2, b[1] - b[3] / 2);
  if (dx <= 0 || dy <= 0) return 0;
  return (dx * dy) / Math.min(a[2] * a[3], b[2] * b[3]);
}

/** Tracks only Mark blurs are on, lowest first; a lane free over [start, end) of them, else a new one above every picture track. */
function laneFor(project: Project, start: number, end: number): string {
  const lanes = project.tracks.filter((track) => {
    const mine = project.clips.filter((clip) => clip.track === track.id);
    return track.kind === "video" && track.subtitles !== true && mine.length > 0 && mine.every((clip) => (clip.name ?? "").startsWith(NAME));
  });
  for (const lane of lanes) {
    if (!project.clips.some((clip) => clip.track === lane.id && clip.start < end && start < clipEnd(clip))) return lane.id;
  }
  // Above every picture (so the blur takes in the footage under it), under every text.
  const id = addTrack(project, "video");
  const track = project.tracks.find((one) => one.id === id)!;
  project.tracks.splice(project.tracks.indexOf(track), 1);
  const pictures = project.tracks.map((one, index) => [one, index] as const).filter(([one]) => project.clips.some((clip) => clip.track === one.id && clip.type !== "text" && clip.type !== "audio"));
  const top = pictures.length === 0 ? 0 : Math.max(...pictures.map(([, index]) => index)) + 1;
  project.tracks.splice(top, 0, track);
  return id;
}

/**
 * The `blur_marks` op: every mark of another outlet still showing on the
 * timeline (or on the clips given) blurred by a blur stuck to its clip; the
 * still rectangles laid by hand over the same marks go. Marks too big to blur
 * (a quarter of the picture) and files not looked at yet are reported.
 */
export function blurMarks(project: Project, args: Record<string, unknown>): Record<string, unknown> {
  const only = Array.isArray(args.clips) ? new Set(args.clips.map(String)) : null;
  // The old Mark blurs first: a re-run lays them again from the timeline as it is now.
  project.clips = project.clips.filter((clip) => !((clip.name ?? "").startsWith(NAME) && (only === null || overlapsAny(project, clip, only))));
  const made: AdjustmentClip[] = [];
  const pending: string[] = [];
  const skipped: string[] = [];
  const ours = new Set(watermarks.ours(project));
  for (const clip of project.clips) {
    if (clip.type !== "video" || (only !== null && !only.has(clip.id)) || trackOf(project, clip.track)?.hidden === true) continue;
    const media = mediaOf(project, clip.media);
    if (media === undefined || ours.has(media.id) || !watermarks.looksForMarks(media)) continue;
    const marks = watermarks.marksOf(project, media);
    if (marks === null) {
      if (!pending.includes(media.name)) pending.push(media.name);
      watermarks.lookSoon(media);
      continue;
    }
    for (const mark of marks) {
      const [x0, y0, x1, y1] = mark.box;
      if ((x1 - x0) * (y1 - y0) >= 0.25) {
        skipped.push(`${media.name}: ${mark.text || "a mark"} (too big to blur without hiding the picture)`);
        continue;
      }
      made.push(...blursFor(project, clip, media, mark));
    }
  }
  // The hand-laid still rectangles over the same marks: each goes once a
  // sticky blur covers its mark wherever it was up.
  const removed: string[] = [];
  project.clips = project.clips.filter((clip) => {
    if (!stillRect(clip) || (clip.name ?? "").startsWith(NAME)) return true;
    const box: [number, number, number, number] = [clip.blur!.x ?? 0, clip.blur!.y ?? 0, clip.blur!.width ?? 0, clip.blur!.height ?? 0];
    if (box[2] <= 0 || box[3] <= 0) return true;
    const replaced = made.some((blur) => blur.start < clipEnd(clip) && clip.start < clipEnd(blur) && overlap(box, [blur.blur!.x ?? 0, blur.blur!.y ?? 0, blur.blur!.width ?? 0, blur.blur!.height ?? 0]) >= 0.5);
    if (replaced) removed.push(clip.id);
    return !replaced;
  });
  for (const blur of made) {
    blur.id = freshId(project, "c");
    blur.track = laneFor(project, blur.start, clipEnd(blur));
    project.clips.push(blur);
  }
  return {
    blurs: made.length,
    removed_still_blurs: removed,
    ...(pending.length > 0 ? { not_looked_at_yet: pending, note: "these files are being looked at for marks now: run blur_marks again in a minute" } : {}),
    ...(skipped.length > 0 ? { too_big: skipped } : {}),
  };
}

function overlapsAny(project: Project, clip: Clip, ids: Set<string>): boolean {
  return project.clips.some((other) => ids.has(other.id) && other.start < clipEnd(clip) && clip.start < clipEnd(other));
}

/**
 * Still rect blurs that outlive their shot (`blur_off_shot`): up across a
 * cut to another picture filling the frame, or over a picture that moves
 * (a push-in) without moving with it. Face blurs that track are left alone.
 */
export function offShot(project: Project): unknown[] {
  const index = (track: string) => project.tracks.findIndex((one) => one.id === track);
  const issues: unknown[] = [];
  for (const blur of project.clips) {
    if (!stillRect(blur) || trackOf(project, blur.track)?.hidden === true || (blur.blur?.width ?? 0) <= 0) continue;
    const under = project.clips.filter(
      (clip) =>
        index(clip.track) < index(blur.track) &&
        trackOf(project, clip.track)?.hidden !== true &&
        clip.start < clipEnd(blur) &&
        blur.start < clipEnd(clip) &&
        fillsFrame(project, clip),
    );
    // The top picture filling the frame at each frame of the blur: more than one, past a dissolve's frames, is a cut it outlived.
    const tops = new Map<string, number>();
    for (let frame = blur.start; frame < clipEnd(blur); frame++) {
      const showing = under.filter((clip) => clip.start <= frame && frame < clipEnd(clip));
      const top = showing.sort((a, b) => index(b.track) - index(a.track))[0];
      if (top !== undefined) tops.set(top.id, (tops.get(top.id) ?? 0) + 1);
    }
    const shots = [...tops.entries()].filter(([, frames]) => frames > 14).map(([id]) => id);
    const moving = under.find((clip) => clip.type === "video" && ["x", "y", "scale"].some((param) => (clip.keyframes?.[param]?.length ?? 0) > 1));
    if (shots.length > 1 || moving !== undefined) {
      issues.push({
        kind: "blur_off_shot",
        clip: blur.id,
        start: blur.start,
        end: clipEnd(blur),
        ...(shots.length > 1 ? { shots } : { moving: moving!.id }),
        fix: "op blur_marks (no arguments): every logo or mark gets a blur stuck to its own shot (it follows the push-in and fades with the dissolve) and these still rectangles go; one left over a shot where no mark was found hides nothing that blur_marks knows of: look once and delete it if nothing there needs hiding; a face's blur is track_region's",
      });
    }
  }
  return issues;
}
