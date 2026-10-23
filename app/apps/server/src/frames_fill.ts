// Small picture facts shared by the blur and pointer rules (mark_blurs.ts,
// pointers.ts), kept apart from them so the store can use the rules without
// importing everything they import.

import type { AdjustmentClip, Clip, Project, VideoClip } from "./model.ts";
import { mediaOf, sample } from "./project.ts";

/** A picture clip's framing (x, y, scale) at a frame of it, its keyframes applied. */
export function framingAt(clip: VideoClip, frame: number): { x: number; y: number; scale: number } {
  const at = (param: "x" | "y" | "scale", base: number) => {
    const keys = clip.keyframes?.[param];
    return keys !== undefined && keys.length > 0 ? (sample(keys, frame) ?? base) : base;
  };
  return { x: at("x", clip.transform.x), y: at("y", clip.transform.y), scale: at("scale", clip.transform.scale) };
}

/** Whether a picture clip covers the whole frame (footage or a photo filled, a solid): what's under it can't be seen. */
export function fillsFrame(project: Project, clip: Clip): boolean {
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

/** A still rect blur (not tracked, not a face's): what blur_marks replaces and blur_off_shot judges. */
export function stillRect(clip: Clip): clip is AdjustmentClip {
  if (clip.type !== "adjustment" || (clip.blur?.radius ?? 0) <= 0 || clip.blur?.shape !== "rect") return false;
  const keys = clip.keyframes ?? {};
  return !["blur.x", "blur.y"].some((param) => (keys[param]?.length ?? 0) > 0);
}

