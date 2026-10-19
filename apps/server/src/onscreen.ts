// What the audit reads off the footage's picture, from caches filled in the
// background: another channel's calls to action burned into a re-upload
// (`source_cta`: the engine's screen_text.rs, Vision's text recognition) and
// B-roll shots that run across a cut in their footage (`broll_crosses_cut`:
// seats.ts's cuts). Files not read yet start reading and are listed as
// pending, as the censor check's are.

import * as diag from "./diag.ts";
import type { Clip, Media, Project } from "./model.ts";
import { native, isReal } from "./native/index.ts";
import { clipEnd, fps as fpsOf, mediaOf, trackOf } from "./project.ts";
import { round } from "./rust.ts";
import * as seats from "./seats.ts";

/** A channel's call to action: "SUBSCRIBE", "SUBSCRIBED", the bell, "like and subscribe". */
export const CTA = /subscrib|notification|hit the bell|turn on the bell|like (and|&) share/iu;

/** Seconds of a shot at either end where a cut doesn't count (a frame or two of the next picture is the cut itself). */
const EDGE = 0.3;

type VideoClip = Extract<Clip, { type: "video" }>;

/** The source seconds a video clip plays, [from, to). */
function played(project: Project, clip: VideoClip): [number, number] {
  const fps = fpsOf(project);
  return [clip.source_in, clip.source_in + (clip.duration / fps) * clip.speed];
}

/** The video clips seen (visible tracks) of footage files (not pictures, not Edit's own graphics). */
function footageClips(project: Project): [VideoClip, Media][] {
  const out: [VideoClip, Media][] = [];
  for (const clip of project.clips) {
    if (clip.type !== "video" || trackOf(project, clip.track)?.hidden === true) continue;
    const media = mediaOf(project, clip.media);
    if (media === undefined || media.kind !== "video" || (media.duration ?? 0) < 2) continue;
    out.push([clip, media]);
  }
  return out;
}

/** Files being read now, so each is read once at a time. */
const reading = new Set<string>();

/** Reads in the background what isn't cached yet: the seconds of each file the timeline plays, then its cuts. */
function warm(media: Media, seconds: number[], cuts: boolean): void {
  if (!isReal() || reading.has(media.path)) return;
  reading.add(media.path);
  void (async () => {
    try {
      if (seconds.length > 0) await native().screenTextDetect(media.path, [media.width ?? 1920, media.height ?? 1080], seconds);
      if (cuts) await seats.cutsOf(media.path);
    } catch (error) {
      diag.warn("audit", `reading ${media.name}'s picture: ${diag.messageOf(error)}`);
    } finally {
      reading.delete(media.path);
    }
  })();
}

/** A call to action's box (shares of the media's picture) in project pixels from the frame centre: x, y, width, height. */
function onFrame(project: Project, clip: VideoClip, media: Media, [x0, y0, x1, y1]: [number, number, number, number]): [number, number, number, number] {
  const { width, height } = project.settings;
  const mw = media.width ?? width;
  const mh = media.height ?? height;
  const fit = Math.min(width / mw, height / mh) * (clip.transform.scale ?? 1);
  const cx = ((x0 + x1) / 2 - 0.5) * mw * fit + clip.transform.x;
  const cy = ((y0 + y1) / 2 - 0.5) * mh * fit + clip.transform.y;
  return [round(cx), round(cy), round((x1 - x0) * mw * fit), round((y1 - y0) * mh * fit)];
}

/** Whether a rect blur over the frame covers `box` (centre x, y, size) at `frame`. */
function blurred(project: Project, box: [number, number, number, number], frame: number): boolean {
  const [x, y, w, h] = box;
  return project.clips.some((clip) => {
    if (clip.type !== "adjustment" || trackOf(project, clip.track)?.hidden === true) return false;
    if (clip.start > frame || clipEnd(clip) <= frame) return false;
    const blur = clip.blur;
    if (blur === undefined || blur === null || (blur.radius ?? 0) < 15) return false;
    // A blur with no box blurs the whole frame.
    if (blur.width === undefined || blur.width === null || blur.width <= 0) return true;
    return Math.abs(x - (blur.x ?? 0)) + w / 2 <= blur.width / 2 + 8 && Math.abs(y - (blur.y ?? 0)) + h / 2 <= (blur.height ?? 0) / 2 + 8;
  });
}

/**
 * Calls to action on screen and B-roll across a cut: the issues, and the
 * files still being read (`pending`). Reads what isn't cached in the background.
 */
export function issues(project: Project): { issues: unknown[]; pending: string[] } {
  const fps = fpsOf(project);
  const out: unknown[] = [];
  const pending = new Set<string>();
  const clips = footageClips(project);
  // Per file: the seconds the timeline plays, and whether any B-roll uses it.
  const wanted = new Map<string, { media: Media; seconds: Set<number>; broll: boolean }>();
  for (const [clip, media] of clips) {
    const entry = wanted.get(media.id) ?? { media, seconds: new Set<number>(), broll: false };
    const [from, to] = played(project, clip);
    for (let second = Math.floor(from); second < to; second++) entry.seconds.add(second);
    if (/B-roll/u.test(clip.name ?? "")) entry.broll = true;
    wanted.set(media.id, entry);
  }
  for (const { media, seconds, broll } of wanted.values()) {
    const text = native().screenTextCached(media.path) ?? {};
    const missing = [...seconds].filter((second) => !Object.hasOwn(text, second)).sort((a, b) => a - b);
    const cuts = broll ? seats.cachedCuts(media.path) : [];
    if (missing.length > 0 || cuts === null) {
      pending.add(media.name);
      warm(media, missing, cuts === null);
    }
  }
  for (const [clip, media] of clips) {
    const [from, to] = played(project, clip);
    // Calls to action, as stretches of timeline frames with the box to blur.
    const text = native().screenTextCached(media.path) ?? {};
    type Run = { start: number; end: number; box: [number, number, number, number]; text: string };
    let open: Run | null = null as Run | null;
    const close = () => {
      if (open !== null) out.push({ kind: "source_cta", clip: clip.id, start: open.start, end: open.end, text: open.text, blur_box: open.box });
      open = null;
    };
    for (let second = Math.floor(from); second < to; second++) {
      const seen = (text[second] ?? []).find((one) => CTA.test(one.t));
      const frame = clip.start + Math.max(0, Math.round(((second - from) / clip.speed) * fps));
      if (seen === undefined || frame >= clipEnd(clip)) {
        close();
        continue;
      }
      const box = onFrame(project, clip, media, seen.b);
      if (blurred(project, box, frame)) {
        close();
        continue;
      }
      const end = Math.min(clipEnd(clip), frame + Math.round(fps / clip.speed));
      if (open === null) open = { start: frame, end, box, text: seen.t };
      else {
        const was: Run = open;
        const [ox, oy, ow, oh] = was.box;
        const [nx, ny, nw, nh] = box;
        const left = Math.min(ox - ow / 2, nx - nw / 2);
        const right = Math.max(ox + ow / 2, nx + nw / 2);
        const top = Math.min(oy - oh / 2, ny - nh / 2);
        const bottom = Math.max(oy + oh / 2, ny + nh / 2);
        open = { ...was, end, box: [round((left + right) / 2), round((top + bottom) / 2), round(right - left), round(bottom - top)] };
      }
    }
    close();
    // A B-roll shot is one picture: none of its footage's cuts inside it.
    if (!/B-roll/u.test(clip.name ?? "")) continue;
    for (const cut of seats.cachedCuts(media.path) ?? []) {
      if (cut <= from + EDGE || cut >= to - EDGE) continue;
      out.push({ kind: "broll_crosses_cut", clip: clip.id, at: clip.start + Math.round(((cut - from) / clip.speed) * fps), cut_seconds: cut });
      break;
    }
  }
  return { issues: out, pending: [...pending].sort() };
}
