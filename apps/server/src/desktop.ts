// The "desktop" profile screen (the engine's desktop.rs draws its pictures):
// a person's photo in a dark Photo Viewer window and a few lines about them
// typed into a Notepad window beside it, on a blue desktop with light beams,
// the whole screen slowly pushing in. It's how the team's videos show someone when the only
// picture is a mugshot or a still (a lone still never sits on black).
//
// The wallpaper and the two windows' frames are pictures the addon draws
// (`native.desktopFiles`, written once per size and title to
// `<home>/graphics/`); here is the layout and the clips over them, which
// are ordinary clips, so the preview and the export draw it alike.

import { clipFrom } from "./clips.ts";
import * as markers from "./markers.ts";
import type { Media, Project } from "./model.ts";
import { native } from "./native/index.ts";
import { addTrack, clipEnd, fps as fpsOf, freshId, mediaOf } from "./project.ts";
import { asInt, round, takeChars, trim } from "./rust.ts";
import { SerdeError } from "./serde.ts";

/** Where things sit at 1080p (pixels from the frame's top-left), measured off the team's reference frame. */
export const PHOTO_VIEWER: [number, number, number, number] = [190, 160, 575, 800];
export const NOTEPAD: [number, number, number, number] = [824, 230, 972, 658];
export const TITLE_BAR = 43;
const MENU_BAR = 31;
/** The content area's inset from the window's sides and bottom. */
const INSET = 10;
const LINE_SIZE = 42;
const LINE_STEP = 74;

export type Window = "photo_viewer" | "notepad";

function rectOf(window: Window): [number, number, number, number] {
  return window === "photo_viewer" ? PHOTO_VIEWER : NOTEPAD;
}

/** The 1080p layout on a frame of `width` × `height`: scaled to fit and centred. */
export class Layout {
  readonly width: number;
  readonly height: number;
  readonly k: number;
  private readonly left: number;
  private readonly top: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.k = Math.min(width / 1920, height / 1080);
    this.left = (width - 1920 * this.k) / 2;
    this.top = (height - 1080 * this.k) / 2;
  }

  /** A 1080p rect [x, y, w, h] in project pixels. */
  private place([x, y, w, h]: [number, number, number, number]): [number, number, number, number] {
    return [this.left + x * this.k, this.top + y * this.k, w * this.k, h * this.k];
  }

  /** The window's rect in project pixels. */
  window(window: Window): [number, number, number, number] {
    return this.place(rectOf(window));
  }

  /** The window's content area (under its menus) in project pixels. */
  content(window: Window): [number, number, number, number] {
    const [x, y, w, h] = rectOf(window);
    const top = TITLE_BAR + MENU_BAR + 2;
    return this.place([x + INSET, y + top, w - 2 * INSET, h - top - INSET]);
  }

  /** A point (project pixels from the top-left) as a transform offset from the centre. */
  centred(x: number, y: number): [number, number] {
    return [x - this.width / 2, y - this.height / 2];
  }
}

/** The laid-out size (width, height) of `text` in Geist at `px`, as the renderer lays it out (the addon measures). */
export function textBlock(text: string, px: number, weight: number, lineHeight: number): [number, number] {
  return native().textBlock(text, px, weight, lineHeight);
}

type Args = Record<string, unknown>;

/** The window titles a desktop_profile operation asks for (defaults filled in). */
export function titles(args: Args): [string, string] {
  const title = (key: string, fallback: string) => {
    const given = typeof args[key] === "string" ? trim(args[key] as string) : "";
    return takeChars(given === "" ? fallback : given, 60);
  };
  return [title("photo_title", "Photo Viewer"), title("title", "Notepad")];
}

/** One desktop's pictures, already the project's media. */
export interface Art {
  photo_title: string;
  notepad_title: string;
  wallpaper: string;
  photo_viewer: string;
  notepad: string;
}

/** Window pop-in: frames to scale up, and the scale it starts from. */
const POP = 12;
const POP_FROM = 0.96;
/** ...and the fade with it. */
const POP_FADE = 8;
/** The push-in over the whole screen. */
const PUSH = 0.035;
/** The windows leave over this many frames at the end. */
const EXIT = 8;

const int = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) ? value : null);

/**
 * The whole profile screen in one go:
 * `{"op":"desktop_profile","start":F,"duration":F,"media":"m1","lines":["36-year-old mother","Charged with …"]}`
 * (`end` instead of duration; `title` names the Notepad window ("Notepad"),
 * `photo_title` the Photo Viewer's; `line_at` the timeline frame each line
 * types on (default: one after another across the first ~60%); `exit: false`
 * keeps the windows to the last frame). The wallpaper fills the frame; the
 * Photo Viewer scales and fades up from 96% a few frames in, the Notepad a
 * few frames later; each line types on word by word; the whole screen pushes
 * in slowly; the windows shrink and fade away over the last 8 frames.
 */
export function profile(project: Project, args: Args, art: Art): Record<string, unknown> {
  const given = int(args.start);
  if (given === null) throw new Error("desktop_profile needs start (frames)");
  const start = Math.max(given, 0);
  let duration: number;
  const durationGiven = int(args.duration);
  const endGiven = int(args.end);
  if (durationGiven !== null) duration = durationGiven;
  else if (endGiven !== null) duration = endGiven - start;
  else throw new Error("desktop_profile needs duration or end (frames)");
  const fpsScale = fpsOf(project) / 30;
  if (duration < 60 * fpsScale) throw new Error("desktop_profile needs at least 2 seconds to read");
  if (typeof args.media !== "string") {
    throw new Error("desktop_profile needs media (the person's photo: an image or video media id)");
  }
  const photo = mediaOf(project, args.media);
  if (photo === undefined) throw new Error(`no media ${args.media}`);
  const lines = (Array.isArray(args.lines) ? (args.lines as unknown[]) : [])
    .filter((line): line is string => typeof line === "string")
    .map(trim)
    .filter((line) => line !== "")
    .map((line) => (line.startsWith("-") || line.startsWith("•") ? line : `- ${line}`));
  if (lines.length === 0 || lines.length > 6) {
    throw new Error("desktop_profile needs lines: 1 to 6 short lines about the person (as a source states them)");
  }
  // Running it again over a profile replaces that profile, so its lines are
  // retimed or reworded in one call. Corrupt Cop's agent, asked to sync the
  // lines, deleted the notes and typed each line as a clip of its own, and
  // every line came out centred on the same point.
  const replaced = project.clips.filter(
    (clip) => (clip.name ?? "").startsWith("Desktop profile ·") && clip.start < start + duration && clipEnd(clip) > start,
  );
  if (replaced.length > 0) {
    const gone = new Set(replaced.map((clip) => clip.id));
    project.clips = project.clips.filter((clip) => !gone.has(clip.id));
    project.markers = (project.markers ?? []).filter(
      (marker) => !((marker.name === "desktop line" || marker.name === "desktop window opens") && marker.frame >= start && marker.frame < start + duration),
    );
  }
  const layout = new Layout(project.settings.width, project.settings.height);
  const k = layout.k;
  const total = duration;
  const pop = POP * fpsScale;
  const fade = POP_FADE * fpsScale;
  const exit = (typeof args.exit === "boolean" ? args.exit : true) ? EXIT * fpsScale : 0;
  // When each window comes in (frames into the profile).
  const photoIn = round(4 * fpsScale);
  const notepadIn = round(10 * fpsScale);
  const firstLine = notepadIn + pop + 2 * fpsScale;
  let lineAt: number[];
  if (Array.isArray(args.line_at)) {
    const at = args.line_at as unknown[];
    if (at.length !== lines.length) {
      throw new Error(`desktop_profile: line_at needs one frame per line (${lines.length} lines)`);
    }
    lineAt = at.map((frame) => {
      const value = int(frame);
      if (value === null) throw new Error("desktop_profile: line_at must be frames");
      return clamp(value - start, firstLine, total - exit - 1);
    });
  } else {
    const last = Math.max(0.6 * total, firstLine);
    const step = lines.length > 1 ? Math.max((last - firstLine) / (lines.length - 1), 12 * fpsScale) : 0;
    lineAt = lines.map((_, index) => round(Math.min(firstLine + step * index, total - exit - 1)));
  }
  const push = (frame: number) => 1 + PUSH * Math.min(Math.max(frame / total, 0), 1);
  const easeOut = (t: number) => 1 - (1 - Math.min(Math.max(t, 0), 1)) ** 3;
  const easeIn = (t: number) => Math.min(Math.max(t, 0), 1) ** 3;
  // A window's scale and opacity at a frame of the profile.
  const windowState = (enter: number, leave: number, frame: number): [number, number] => {
    if (frame >= leave && exit > 0) {
      const t = (frame - leave) / exit;
      return [1 - (1 - 0.97) * easeIn(t), 1 - easeIn(t)];
    }
    const t = (frame - enter) / pop;
    return [POP_FROM + (1 - POP_FROM) * easeOut(t), easeOut((frame - enter) / fade)];
  };
  // The frames keys go on: every frame while a window moves, the ends of the steady push between.
  const keyFrames = (enter: number, leave: number): number[] => {
    const frames: number[] = [];
    for (let step = 0; step <= Math.ceil(pop); step++) frames.push(enter + step);
    if (exit > 0) for (let step = 0; step <= Math.ceil(exit); step++) frames.push(leave + step);
    frames.push(total - 1);
    const kept = frames.filter((frame) => frame >= enter && frame <= total - 1).sort((a, b) => a - b);
    return kept.filter((frame, index) => index === 0 || frame !== kept[index - 1]);
  };
  const key = (frame: number, value: number) => ({ frame, value, ease: "linear" });
  // Keyframes for an element at (ex, ey) (centre offsets) and base scale, in
  // a window whose centre is (gx, gy) and which enters/leaves then (on screen
  // from `from`: its clip's first frame).
  const animated = (
    [ex, ey]: [number, number],
    scale: number,
    [gx, gy]: [number, number],
    enter: number,
    leave: number,
    from: number,
  ) => {
    const [xs, ys, ss, os]: [Args[], Args[], Args[], Args[]] = [[], [], [], []];
    for (const frame of keyFrames(Math.max(enter, from), leave)) {
      const [s, o] = windowState(enter, leave, frame);
      const p = push(frame);
      const local = frame - from;
      xs.push(key(local, p * (gx + (ex - gx) * s)));
      ys.push(key(local, p * (gy + (ey - gy) * s)));
      ss.push(key(local, scale * p * s));
      os.push(key(local, o));
    }
    return { x: xs, y: ys, scale: ss, opacity: os };
  };
  const made: string[] = [];
  const add = (fields: Args): string => {
    const id = freshId(project, "c");
    const track = addTrack(project, "video");
    let clip;
    try {
      clip = clipFrom({ ...fields, id, track });
    } catch (error) {
      if (error instanceof SerdeError) throw new Error(`desktop_profile: ${error.message}`);
      throw error;
    }
    project.clips.push(clip);
    made.push(id);
    return id;
  };
  // An image shown at its own pixel size times `zoom`: its scale.
  const nativeScale = (media: Media, zoom: number) => {
    const [w, h] = [Math.max(media.width, 1), Math.max(media.height, 1)];
    return zoom / Math.min(layout.width / w, layout.height / h);
  };
  const mediaNamed = (id: string): Media => {
    const media = mediaOf(project, id);
    if (media === undefined) throw new Error(`desktop art ${id} is missing`);
    return media;
  };
  const wallpaper = mediaNamed(art.wallpaper);
  const photoViewer = mediaNamed(art.photo_viewer);
  const notepad = mediaNamed(art.notepad);
  // The wallpaper: the whole frame, pushing in.
  const [ww, wh] = [Math.max(wallpaper.width, 1), Math.max(wallpaper.height, 1)];
  const wallFit = Math.min(layout.width / ww, layout.height / wh);
  const cover = Math.max(layout.width / (ww * wallFit), layout.height / (wh * wallFit));
  add({
    type: "video",
    name: "Desktop profile · wallpaper",
    media: wallpaper.id,
    source_in: 0,
    start,
    duration,
    keyframes: { scale: [key(0, cover), key(total - 1, cover * push(total - 1))] },
  });
  // Gone on the last frame, the Notepad a few frames before the Photo Viewer.
  const leavePhoto = total - 1 - exit;
  const leaveNotepad = leavePhoto - Math.min(round(3 * fpsScale), exit);
  const notepadExit = exit > 0 ? leaveNotepad : total;
  const centreOf = ([x, y, w, h]: [number, number, number, number]) => layout.centred(x + w / 2, y + h / 2);
  // The Photo Viewer and the photo in it (cropped to fill its content area).
  const pvCentre = centreOf(layout.window("photo_viewer"));
  const clipFromFrame = (enter: number) => asInt(round(enter));
  add({
    type: "video",
    name: "Desktop profile · photo viewer",
    media: photoViewer.id,
    source_in: 0,
    start: start + clipFromFrame(photoIn),
    duration: duration - clipFromFrame(photoIn),
    frame: { width: 0, shadow: 0.6 },
    keyframes: animated(pvCentre, nativeScale(photoViewer, 1), pvCentre, photoIn, leavePhoto, photoIn),
  });
  const [cx, cy, cw, ch] = layout.content("photo_viewer");
  const [pw, ph] = [Math.max(photo.width, 1), Math.max(photo.height, 1)];
  const fit = Math.min(layout.width / pw, layout.height / ph);
  let crop: Args;
  let scale: number;
  if (pw / ph > cw / ch) {
    const side = (1 - cw / ch / (pw / ph)) / 2;
    crop = { left: side, right: side };
    scale = ch / (ph * fit);
  } else {
    const side = (1 - pw / ph / (cw / ch)) / 2;
    crop = { top: side, bottom: side };
    scale = cw / (pw * fit);
  }
  add({
    type: "video",
    name: "Desktop profile · photo",
    media: photo.id,
    source_in: 0,
    start: start + clipFromFrame(photoIn),
    duration: duration - clipFromFrame(photoIn),
    crop,
    keyframes: animated(layout.centred(cx + cw / 2, cy + ch / 2), scale, pvCentre, photoIn, leavePhoto, photoIn),
  });
  // The Notepad and its lines.
  const npCentre = centreOf(layout.window("notepad"));
  add({
    type: "video",
    name: "Desktop profile · notepad",
    media: notepad.id,
    source_in: 0,
    start: start + clipFromFrame(notepadIn),
    duration: duration - clipFromFrame(notepadIn),
    frame: { width: 0, shadow: 0.6 },
    keyframes: animated(npCentre, nativeScale(notepad, 1), npCentre, notepadIn, notepadExit, notepadIn),
  });
  const text = lines.join("\n");
  const size = LINE_SIZE * k;
  const lineHeight = LINE_STEP / LINE_SIZE;
  const [blockW, blockH] = textBlock(text, size, 400, lineHeight);
  const [nx, ny] = layout.content("notepad");
  const textCentre = layout.centred(nx + 12 * k + blockW / 2, ny + 22 * k + blockH / 2);
  const textFrom = Math.floor(lineAt[0] ?? firstLine);
  // Each line's words a couple of frames apart, from its frame.
  const wordTimes: number[] = [];
  lines.forEach((line, index) => {
    const at = lineAt[index]!;
    line
      .split(/\s+/u)
      .filter((word) => word !== "")
      .forEach((_, word) => wordTimes.push(at - textFrom + word * 2 * fpsScale));
  });
  add({
    type: "text",
    name: "Desktop profile · notes",
    text,
    start: start + asInt(textFrom),
    duration: duration - asInt(textFrom),
    style: {
      font: "Geist",
      weight: 400,
      size,
      color: [0.93, 0.93, 0.93, 1],
      line_height: lineHeight,
      align: "left",
      glow: { enabled: true, radius: 10 * k, strength: 0.3 },
    },
    transform: { x: textCentre[0], y: textCentre[1] },
    animation: { preset: "words", duration: 1, stagger: 2 },
    word_times: wordTimes,
    keyframes: animated(textCentre, 1, npCentre, notepadIn, notepadExit, textFrom),
  });
  // The film look over all of it: a vignette, a touch less colour.
  add({
    type: "adjustment",
    name: "Desktop profile · film",
    start,
    duration,
    grade: { vignette: 0.42, saturation: -0.12, contrast: 0.06 },
  });
  // Moments to put sounds on (a soft click as each window opens).
  for (const enter of [photoIn, notepadIn]) markers.addTimeline(project, start + asInt(enter), "desktop window opens", "");
  lines.forEach((line, index) => markers.addTimeline(project, start + asInt(lineAt[index]!), "desktop line", line));
  const linesAt = lineAt.map((at) => start + asInt(at));
  return {
    clips: made,
    ...(replaced.length > 0 ? { replaced: replaced.length } : {}),
    end: start + duration,
    lines_at: linesAt,
    windows_open: [start + asInt(photoIn), start + asInt(notepadIn)],
  };
}

/** Rust's `f64::clamp`, which panics (a bug: a RangeError here) when min > max. */
function clamp(x: number, low: number, high: number): number {
  if (!(low <= high)) throw new RangeError(`min > max, or either was NaN. min = ${low}, max = ${high}`);
  return Math.min(Math.max(x, low), high);
}
