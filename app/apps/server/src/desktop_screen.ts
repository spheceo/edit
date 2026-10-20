// The Windows screen: the team's main motion graphic (their Cut-In Guide and
// the Oct 20 notes). A desktop on the team's wallpaper, bigger than the
// frame, holding three kinds of window, each by its own name: "Video
// Player" (footage), "Photo Viewer" (a picture) and "Notepad" (short notes
// typed on as the narration says them). The camera moves over it like an
// After Effects camera over a still desktop: it can open zoomed into a
// Video Player playing the footage the viewer was just watching (so the
// footage zooms out into the desktop), glide to each window as it opens,
// drift slowly in between, and end zoomed into a Video Player whose footage
// then plays full frame. The agent places the windows (where, how big,
// which on top) or leaves it to Edit; every desktop comes out different.
//
// It's all ordinary clips (the wallpaper, each window's frame drawn by the
// engine at its size, the picture or footage in it, the notes), each moved
// against the camera by keyframes, so the preview and the export draw it
// alike.

import { clipFrom } from "./clips.ts";
import * as markers from "./markers.ts";
import type { Media, Project } from "./model.ts";
import { native } from "./native/index.ts";
import { addTrack, clipEnd, fps as fpsOf, freshId, mediaOf } from "./project.ts";
import { round, trim } from "./rust.ts";
import { SerdeError } from "./serde.ts";

type Args = Record<string, unknown>;

export type AppKind = "video_player" | "photo_viewer" | "notepad";
const APPS: AppKind[] = ["video_player", "photo_viewer", "notepad"];

/** The engine's window chrome at 1080p (desktop.rs): title + menu bar, inset, the Video Player's controls. */
const TOP = 43 + 31 + 2;
const INSET = 10;
const CONTROLS = 46;
/** The desktop is this many frames wide and tall: room for the camera to travel. */
const DESKTOP = 1.5;
/** Notes in the Notepad (1080p pixels). */
const NOTE_SIZE = 40;
const NOTE_LINE = 1.4;
const NOTE_PAD = 18;
const NOTE_GAP = 10;

/** One window as asked for. `at` is the timeline frame it opens. */
export interface WindowSpec {
  app: AppKind;
  media: string | null;
  source_in: number;
  speed: number;
  lines: string[];
  line_at: number[] | null;
  at: number;
  x: number | null;
  y: number | null;
  width: number | null;
  z: number;
  label: string | null;
}

/** A whole desktop as asked for (timeline frames). */
export interface Spec {
  start: number;
  end: number;
  windows: WindowSpec[];
  /** The Video Player the camera opens zoomed into (its index), and the scale the footage before it ended at. */
  open: { index: number; zoom: number } | null;
  /** The Video Player the camera ends zoomed into (its index), so its footage carries on full frame. */
  exit_into: number | null;
  /** Clip names start with this. */
  prefix: string;
}

/** A window laid out on the desktop (desktop pixels: the frame is W × H, the desktop DESKTOP times that). */
export interface Laid {
  spec: WindowSpec;
  /** Its frame's size in pixels (what the engine draws) and its centre on the desktop. */
  w: number;
  h: number;
  cx: number;
  cy: number;
  /** Its content area (desktop pixels: x, y of the top-left, w, h). */
  content: [number, number, number, number];
  /** Notepad: each note wrapped to the window, and its block's size. */
  notes: { text: string; w: number; h: number }[];
}

/** The engine's drawn pictures a desktop uses, as the project's media: the wallpaper and each window frame by `frameKey`. */
export interface Art {
  wallpaper: string;
  frames: Record<string, string>;
}

export function frameKey(app: AppKind, w: number, h: number): string {
  return `${app}:${w}x${h}`;
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const int = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Reads one window. `start` is where the desktop starts (the default `at` of the first). */
function readWindow(project: Project, raw: unknown, index: number, start: number, where: string, after: number): WindowSpec {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${where}window ${index + 1}: an object`);
  const given = raw as Args;
  const app = str(given.app);
  if (app === null || !APPS.includes(app as AppKind)) {
    throw new Error(`${where}window ${index + 1}: app is video_player, photo_viewer or notepad`);
  }
  const kind = app as AppKind;
  const media = str(given.media);
  if (kind !== "notepad") {
    if (media === null) throw new Error(`${where}window ${index + 1}: ${kind} needs media`);
    const found = mediaOf(project, media);
    if (found === undefined) throw new Error(`${where}window ${index + 1}: no media ${media}`);
    if (kind === "video_player" && found.kind !== "video") throw new Error(`${where}window ${index + 1}: a video_player plays a video (${media} is ${found.kind})`);
    if (found.kind === "audio") throw new Error(`${where}window ${index + 1}: ${media} is audio`);
  }
  const lines = (Array.isArray(given.lines) ? given.lines : [])
    .filter((line): line is string => typeof line === "string")
    .map((line) => trim(line).replace(/^[-•]\s*/u, ""))
    .filter((line) => line !== "");
  if (kind === "notepad" && (lines.length === 0 || lines.length > 6)) {
    throw new Error(`${where}window ${index + 1}: a notepad needs lines: 1 to 6 short notes, as the narration says them`);
  }
  const lineAt = Array.isArray(given.line_at) ? given.line_at.map((frame) => int(frame)) : null;
  if (lineAt !== null && (lineAt.length !== lines.length || lineAt.some((frame) => frame === null))) {
    throw new Error(`${where}window ${index + 1}: line_at needs one frame per line (${lines.length})`);
  }
  // No frame (its said words weren't found): a second after the window before it.
  const at = int(given.at) ?? (index === 0 ? start : after + Math.round(fpsOf(project)));
  const share = (key: string): number | null => {
    const value = num(given[key]);
    if (value === null) return null;
    if (value < 0 || value > 1) throw new Error(`${where}window ${index + 1}: ${key} is a share of the desktop, 0 to 1`);
    return value;
  };
  const width = num(given.width);
  if (width !== null && (width < 0.12 || width > 0.9)) throw new Error(`${where}window ${index + 1}: width is a share of the frame's width, 0.12 to 0.9`);
  const label = str(given.label);
  return {
    app: kind,
    media,
    source_in: Math.max(num(given.source_in) ?? 0, 0),
    speed: Math.min(Math.max(num(given.speed) ?? 1, 0.05), 4),
    lines,
    line_at: lineAt as number[] | null,
    at,
    x: share("x"),
    y: share("y"),
    width,
    z: num(given.z) ?? index,
    label: label === null || trim(label) === "" ? null : trim(label),
  };
}

/** Reads a desktop's windows (`desktop` op or a cover_cut_in desktop shot). */
export function readSpec(project: Project, given: Args, start: number, end: number, prefix: string, where = ""): Spec {
  if (end - start < Math.round(1.5 * fpsOf(project))) throw new Error(`${where}a desktop needs at least 1.5 s`);
  const raw = Array.isArray(given.windows) ? given.windows : [];
  if (raw.length === 0 || raw.length > 8) throw new Error(`${where}windows: 1 to 8 (video_player, photo_viewer, notepad)`);
  const windows: WindowSpec[] = [];
  raw.forEach((window, index) => {
    const read = readWindow(project, window, index, start, where, windows[index - 1]?.at ?? start);
    // Kept inside the desktop (a guessed frame past its end opens near the end).
    if (read.at >= end) read.at = Math.max(end - Math.round(fpsOf(project)), start);
    if (read.at < start) throw new Error(`${where}window ${index + 1} opens at ${read.at}, before the desktop starts (${start})`);
    windows.push(read);
  });
  const exit = int(given.exit_into);
  if (exit !== null && windows[exit]?.app !== "video_player") throw new Error(`${where}exit_into is the index (from 0) of a video_player window`);
  return { start, end, windows, open: null, exit_into: exit, prefix };
}

/** The laid-out size [width, height] of `text` at `px` (the addon measures; Geist 400). */
function measure(text: string, px: number): [number, number] {
  return native().textBlock(text, px, 400, NOTE_LINE);
}

/** A note wrapped to `width`: words onto lines, the lines after the first indented under its text. */
function wrap(note: string, px: number, width: number): string {
  const words = note.split(/\s+/u).filter((word) => word !== "");
  const lines: string[] = [];
  let line = "-";
  for (const word of words) {
    const tried = `${line} ${word}`;
    if (line !== "-" && line !== "  " && measure(tried, px)[0] > width) {
      lines.push(line);
      line = `  ${word}`;
    } else {
      line = line === "  " ? `  ${word}` : tried;
    }
  }
  lines.push(line);
  return lines.join("\n");
}

/** Where windows go when the agent doesn't say: spread over the desktop so the camera travels. */
const SLOTS: [number, number][] = [
  [0.4, 0.42],
  [0.66, 0.36],
  [0.38, 0.68],
  [0.68, 0.66],
  [0.52, 0.5],
  [0.26, 0.56],
  [0.76, 0.5],
  [0.5, 0.3],
];

/** Lays the windows out (sizes from their content, places as asked or spread over the desktop). */
export function layout(project: Project, spec: Spec): { laid: Laid[]; desktop: [number, number] } {
  const { width: W, height: H } = project.settings;
  const k = Math.min(W / 1920, H / 1080);
  const [DW, DH] = [W * DESKTOP, H * DESKTOP];
  // A different turn through the slots per desktop, so they don't all look alike.
  const turn = Math.abs(spec.start) % 3;
  const laid = spec.windows.map((window, index): Laid => {
    const media = window.media === null ? undefined : mediaOf(project, window.media);
    const fallback = window.app === "notepad" ? 0.4 : window.app === "video_player" ? 0.42 : 0.26;
    const w = Math.round((window.width ?? fallback) * W);
    let contentH: number;
    const contentW = w - 2 * INSET * k;
    const notes: Laid["notes"] = [];
    if (window.app === "notepad") {
      const px = NOTE_SIZE * k;
      let total = 0;
      for (const line of window.lines) {
        const text = wrap(line, px, contentW - 2 * NOTE_PAD * k);
        const [bw, bh] = measure(text, px);
        notes.push({ text, w: bw, h: bh });
        total += bh + NOTE_GAP * k;
      }
      contentH = Math.max(total + 2 * NOTE_PAD * k, 0.16 * H);
    } else if (window.app === "video_player") {
      contentH = (contentW * 9) / 16;
    } else {
      const aspect = media === undefined ? 4 / 3 : Math.min(Math.max(media.width / Math.max(media.height, 1), 0.62), 1.9);
      contentH = contentW / aspect;
    }
    const bottom = (window.app === "video_player" ? CONTROLS + INSET : INSET) * k;
    const h = Math.round(contentH + TOP * k + bottom);
    const slot = SLOTS[(index + turn) % SLOTS.length]!;
    const [fx, fy] = [window.x ?? slot[0], window.y ?? slot[1]];
    // Kept inside the desktop.
    const cx = Math.min(Math.max(fx * DW, w / 2 + 20 * k), DW - w / 2 - 20 * k);
    const cy = Math.min(Math.max(fy * DH, h / 2 + 20 * k), DH - h / 2 - 20 * k);
    const left = cx - w / 2;
    const top = cy - h / 2;
    return {
      spec: window,
      w,
      h,
      cx,
      cy,
      content: [left + INSET * k, top + TOP * k, contentW, contentH],
      notes,
    };
  });
  return { laid, desktop: [DW, DH] };
}

/** The window frames (app, width, height) a desktop needs drawn. */
export function frameSizes(project: Project, spec: Spec): [AppKind, number, number][] {
  return layout(project, spec).laid.map((window) => [window.spec.app, window.w, window.h]);
}

interface Pose {
  x: number;
  y: number;
  z: number;
}

const smooth = (t: number) => {
  const u = Math.min(Math.max(t, 0), 1);
  return u * u * (3 - 2 * u);
};
const easeOut = (t: number) => 1 - (1 - Math.min(Math.max(t, 0), 1)) ** 3;

/** The camera drifts in this much a second, so the desktop never sits still. */
const DRIFT = 0.012;

/**
 * Builds a desktop: its clips on new tracks (on top), its markers. `art` has
 * the wallpaper and every frame `frameSizes` asked for.
 */
export function build(project: Project, spec: Spec, art: Art): Record<string, unknown> {
  const fps = fpsOf(project);
  const s = fps / 30;
  const { width: W, height: H } = project.settings;
  const k = Math.min(W / 1920, H / 1080);
  const { laid, desktop } = layout(project, spec);
  const [DW, DH] = desktop;
  const total = spec.end - spec.start;
  const rel = (frame: number) => frame - spec.start;
  // No window opens while the camera is still zoomed into the opening Video
  // Player: it would pop up huge over the footage. They wait until the zoom
  // out is mostly done.
  if (spec.open !== null) {
    const earliest = spec.start + Math.round(28 * s);
    for (const window of laid) if (window !== laid[spec.open.index] && window.spec.at < earliest) window.spec.at = Math.min(earliest, spec.end - 1);
  }

  // A window's picture shown inside its content area (contain): [x, y, w, h] on the desktop.
  const shown = (window: Laid): [number, number, number, number] => {
    const [x, y, w, h] = window.content;
    const media = window.spec.media === null ? undefined : mediaOf(project, window.spec.media);
    if (media === undefined || window.spec.app === "notepad") return window.content;
    const aspect = media.width / Math.max(media.height, 1);
    if (window.spec.app === "photo_viewer") return window.content;
    const [vw, vh] = aspect > w / h ? [w, w / aspect] : [h * aspect, h];
    return [x + (w - vw) / 2, y + (h - vh) / 2, vw, vh];
  };
  // The pose framing some windows (with a margin), kept over the desktop.
  const framing = (windows: Laid[]): Pose => {
    const left = Math.min(...windows.map((w) => w.cx - w.w / 2));
    const right = Math.max(...windows.map((w) => w.cx + w.w / 2));
    const top = Math.min(...windows.map((w) => w.cy - w.h / 2));
    const bottom = Math.max(...windows.map((w) => w.cy + w.h / 2));
    const z = Math.min(Math.max(Math.min((W * 0.8) / (right - left), (H * 0.78) / (bottom - top)), 0.62), 1.25);
    return keep({ x: (left + right) / 2, y: (top + bottom) / 2, z });
  };
  const keep = (pose: Pose): Pose => {
    const [hw, hh] = [W / 2 / pose.z, H / 2 / pose.z];
    const x = DW > 2 * hw ? Math.min(Math.max(pose.x, hw), DW - hw) : DW / 2;
    const y = DH > 2 * hh ? Math.min(Math.max(pose.y, hh), DH - hh) : DH / 2;
    return { x, y, z: pose.z };
  };
  // Zoomed into a Video Player so its footage fills the frame as it would full
  // frame at `zoom` (the footage fitted to the frame, times the scale it had).
  const into = (window: Laid, zoom: number): Pose => {
    const media = window.spec.media === null ? undefined : mediaOf(project, window.spec.media);
    const [x, y, w, h] = shown(window);
    const fit = media === undefined ? W / w : Math.min(W / media.width, H / media.height) * media.width;
    return { x: x + w / 2, y: y + h / 2, z: (fit * zoom) / w };
  };

  // The camera: poses at frames (relative), smoothstep between, log zoom.
  const order = laid.map((_, index) => index).sort((a, b) => laid[a]!.spec.at - laid[b]!.spec.at || a - b);
  const stops: { from: number; to: number; pose: Pose }[] = [];
  let current: Pose;
  let free = 0;
  const openIndex = spec.open?.index ?? null;
  if (openIndex !== null && laid[openIndex] !== undefined) {
    current = into(laid[openIndex]!, spec.open!.zoom);
    stops.push({ from: 0, to: 0, pose: current });
    const hold = Math.round(6 * s);
    const zoomOut = Math.round(34 * s);
    const next = framing([laid[openIndex]!]);
    stops.push({ from: hold, to: Math.min(hold + zoomOut, total - 1), pose: { ...next, z: next.z * 0.92 } });
    free = hold + zoomOut;
  } else {
    const first = laid[order[0]!]!;
    current = framing([first]);
    current = { ...current, z: current.z * 0.94 };
    stops.push({ from: 0, to: 0, pose: current });
  }
  const exitIndex = spec.exit_into;
  const exitAt = exitIndex === null ? total : Math.max(total - Math.round(30 * s), free);
  let previous: Laid | null = openIndex !== null ? laid[openIndex]! : laid[order[0]!]!;
  const opened: Laid[] = previous === null ? [] : [previous];
  for (const index of order) {
    const window = laid[index]!;
    if (index === openIndex || (openIndex === null && index === order[0])) continue;
    const opens = rel(window.spec.at);
    const from = Math.max(free, opens - Math.round(8 * s));
    if (from >= exitAt - Math.round(6 * s)) break;
    const to = Math.min(from + Math.round(26 * s), exitAt - 1);
    // Everything open so far when it fits (so a Notepad still typing stays in
    // view), else the window with the one before it, else on its own.
    opened.push(window);
    const all = framing(opened);
    const pair = previous === null ? null : framing([previous, window]);
    const pose = all.z > 0.6 ? all : pair !== null && pair.z > 0.66 ? pair : framing([window]);
    stops.push({ from, to, pose });
    free = to;
    previous = window;
  }
  const drift = (frame: number) => 1 + (DRIFT * frame) / fps;
  if (exitIndex !== null) {
    const target = into(laid[exitIndex]!, 1);
    stops.push({ from: exitAt, to: total - 1, pose: { ...target, z: target.z / drift(total - 1) } });
  }
  const camera = (frame: number): Pose => {
    let pose = stops[0]!.pose;
    for (let index = 1; index < stops.length; index++) {
      const stop = stops[index]!;
      if (frame <= stop.from) break;
      const t = stop.to > stop.from ? smooth((frame - stop.from) / (stop.to - stop.from)) : 1;
      pose = {
        x: pose.x + (stop.pose.x - pose.x) * t,
        y: pose.y + (stop.pose.y - pose.y) * t,
        z: Math.exp(Math.log(pose.z) + (Math.log(stop.pose.z) - Math.log(pose.z)) * t),
      };
      if (frame < stop.to) break;
    }
    return { ...pose, z: pose.z * drift(frame) };
  };

  // A window's own motion: popping in (scale about its centre, opacity) and, for a picture or notes, a slow float.
  const pop = Math.round(10 * s);
  const fadeIn = Math.round(7 * s);
  const motion = (window: Laid, index: number, frame: number): { s: number; o: number; dy: number } => {
    const opens = index === openIndex ? -1e9 : rel(window.spec.at);
    const t = frame - opens;
    const floats = window.spec.app !== "video_player";
    return {
      s: index === openIndex ? 1 : 0.94 + 0.06 * easeOut(t / pop),
      o: index === openIndex ? 1 : easeOut(t / fadeIn),
      dy: floats ? 2.5 * k * Math.sin((2 * Math.PI * frame) / (5 * fps) + index * 1.7) : 0,
    };
  };

  const made: string[] = [];
  const add = (fields: Args): string => {
    const id = freshId(project, "c");
    let clip;
    try {
      clip = clipFrom({ ...fields, id, track: addTrack(project, "video") });
    } catch (error) {
      if (error instanceof SerdeError) throw new Error(`desktop: ${error.message}`);
      throw error;
    }
    project.clips.push(clip);
    made.push(id);
    return id;
  };
  // The frames an element's keys go on (relative to the desktop): every few
  // frames, every other one while its window pops in or the camera turns.
  const keyFrames = (from: number, opens: number | null): number[] => {
    const frames = new Set<number>([from, total - 1]);
    for (let frame = from; frame < total; frame += Math.max(Math.round(2 * s), 1)) frames.add(frame);
    if (opens !== null) for (let frame = opens; frame <= opens + pop + 2; frame++) if (frame >= from && frame < total) frames.add(frame);
    for (const stop of stops) for (const frame of [stop.from, stop.to]) if (frame >= from && frame < total) frames.add(frame);
    return [...frames].sort((a, b) => a - b);
  };
  const HANDLE = 1 / 3;
  // Keys for an element centred at (px, py) on the desktop with `base` scale, in window `index` (null: the wallpaper).
  const keysFor = (px: number, py: number, base: number, index: number | null, from: number) => {
    const window = index === null ? null : laid[index]!;
    const at = (frame: number) => {
      const pose = camera(frame);
      if (window === null) return { x: (px - pose.x) * pose.z, y: (py - pose.y) * pose.z, scale: base * pose.z, o: 1 };
      const own = motion(window, index!, frame);
      const wx = window.cx + (px - window.cx) * own.s;
      const wy = window.cy + (py - window.cy) * own.s + own.dy;
      return { x: (wx - pose.x) * pose.z, y: (wy - pose.y) * pose.z, scale: base * own.s * pose.z, o: own.o };
    };
    const opens = window === null || index === openIndex ? null : rel(window.spec.at);
    const lists: Record<"x" | "y" | "scale", Args[]> = { x: [], y: [], scale: [] };
    const opacity: Args[] = [];
    for (const frame of keyFrames(from, opens)) {
      const here = at(frame);
      const [before, after] = [at(frame - 0.5), at(frame + 0.5)];
      for (const key of ["x", "y", "scale"] as const) {
        const handle = { speed: after[key] - before[key], influence: HANDLE };
        lists[key].push({ frame: frame - from, value: here[key], ease: "linear", handle_in: { ...handle }, handle_out: handle });
      }
      if (opens !== null && frame <= opens + fadeIn) opacity.push({ frame: frame - from, value: here.o, ease: "linear" });
    }
    const first = at(from);
    // Only the keys the curve needs (each segment a Hermite cubic through its
    // ends' values and speeds): sampled densely, then thinned to within a
    // fraction of a pixel. Sabrina's first desktops kept every fifth frame:
    // 43,000 keyframes in a 9 MB project.
    const thinned = {
      x: thinKeys(lists.x, 0.3),
      y: thinKeys(lists.y, 0.3),
      scale: thinKeys(lists.scale, 0.3 / Math.max(W, 1)),
    };
    return {
      transform: { x: first.x, y: first.y, scale: first.scale },
      keyframes: opacity.length > 0 ? { ...thinned, opacity } : thinned,
    };
  };
  // A picture's scale so it's `width` desktop pixels wide (the renderer fits media to the frame at scale 1).
  const scaleFor = (media: Media, width: number) => width / (Math.max(media.width, 1) * Math.min(W / Math.max(media.width, 1), H / Math.max(media.height, 1)));

  // The wallpaper, covering the desktop.
  const wallpaper = mediaOf(project, art.wallpaper);
  if (wallpaper === undefined) throw new Error("desktop: the wallpaper wasn't prepared (run it through apply_edit_plan)");
  const cover = Math.max(DW / Math.max(wallpaper.width, 1), DH / Math.max(wallpaper.height, 1)) * wallpaper.width;
  add({
    type: "video",
    name: `${spec.prefix}wallpaper`,
    media: wallpaper.id,
    source_in: 0,
    // A designed graphic, not a bare still (the audit): no border, no shadow.
    frame: { width: 0, shadow: 0 },
    start: spec.start,
    duration: total,
    ...keysFor(DW / 2, DH / 2, scaleFor(wallpaper, cover), null, 0),
  });

  const zOrder = laid.map((_, index) => index).sort((a, b) => laid[a]!.spec.z - laid[b]!.spec.z || a - b);
  const linesAt: number[] = [];
  const windowsAt: number[] = [];
  for (const index of zOrder) {
    const window = laid[index]!;
    const name = window.spec.app === "video_player" ? "Video Player" : window.spec.app === "photo_viewer" ? "Photo Viewer" : "Notepad";
    const from = index === openIndex ? 0 : rel(window.spec.at);
    const frameMedia = art.frames[frameKey(window.spec.app, window.w, window.h)];
    const chrome = frameMedia === undefined ? undefined : mediaOf(project, frameMedia);
    if (chrome === undefined) throw new Error(`desktop: the ${name} frame wasn't prepared`);
    add({
      type: "video",
      name: `${spec.prefix}${name}`,
      media: chrome.id,
      source_in: 0,
      start: spec.start + from,
      duration: total - from,
      frame: { width: 0, shadow: 0.55 },
      ...keysFor(window.cx, window.cy, scaleFor(chrome, window.w), index, from),
    });
    if (index !== openIndex) windowsAt.push(spec.start + from);
    if (window.spec.app === "notepad") {
      const [cx, cy] = window.content;
      let y = cy + NOTE_PAD * k;
      const px = NOTE_SIZE * k;
      window.notes.forEach((note, line) => {
        const given = window.spec.line_at?.[line];
        const at = Math.max(given ?? window.spec.at + Math.round((10 + 36 * line) * s), window.spec.at + Math.round(6 * s));
        const textFrom = Math.min(rel(at), total - 2);
        const centre: [number, number] = [cx + NOTE_PAD * k + note.w / 2, y + note.h / 2];
        add({
          type: "text",
          name: `${spec.prefix}Notepad note ${line + 1}`,
          text: note.text,
          start: spec.start + textFrom,
          duration: total - textFrom,
          style: { font: "Geist", weight: 400, size: px, color: [0.94, 0.94, 0.94, 1], line_height: NOTE_LINE, align: "left", glow: { enabled: true, radius: 8 * k, strength: 0.25 } },
          animation: { preset: "typewriter", duration: 1, stagger: Math.max(Math.round(s), 1) },
          ...keysFor(centre[0], centre[1], 1, index, textFrom),
        });
        linesAt.push(spec.start + textFrom);
        markers.addTimeline(project, spec.start + textFrom, "desktop line", window.spec.lines[line] ?? "");
        y += note.h + NOTE_GAP * k;
      });
      continue;
    }
    const media = mediaOf(project, window.spec.media!);
    if (media === undefined) continue;
    const [x, y, w, h] = shown(window);
    let crop: Args = {};
    let width = w;
    if (window.spec.app === "photo_viewer") {
      // Filling the content area (its shape is the picture's, kept within limits): a little cropped at most.
      const aspect = media.width / Math.max(media.height, 1);
      if (aspect > w / h) {
        const side = (1 - w / h / aspect) / 2;
        crop = { left: side, right: side };
        width = h * aspect;
      } else {
        const side = (1 - aspect / (w / h)) / 2;
        crop = { top: side, bottom: side };
      }
    }
    add({
      type: "video",
      name: `${spec.prefix}${name} · ${media.name}`,
      media: media.id,
      source_in: media.kind === "video" ? window.spec.source_in : 0,
      ...(media.kind === "video" ? { speed: window.spec.speed } : {}),
      start: spec.start + from,
      duration: total - from,
      crop,
      ...(media.kind === "image" ? { frame: { width: 0, shadow: 0 } } : {}),
      ...keysFor(x + w / 2, y + h / 2, scaleFor(media, width), index, from),
    });
    if (window.spec.label !== null) {
      const text = window.spec.label.startsWith("(") ? window.spec.label : `(${window.spec.label})`;
      const size = 20 * k;
      const [lw, lh] = measure(text, size);
      add({
        type: "text",
        name: `${spec.prefix}${name} label`,
        text,
        start: spec.start + from,
        duration: total - from,
        style: { font: "Geist", weight: 500, size, color: [1, 1, 1, 1], align: "left", glow: { enabled: false }, background: { color: [0, 0, 0, 1], opacity: 0.6, pad_x: 8 * k, pad_y: 4 * k } },
        ...keysFor(x + 14 * k + lw / 2, y + h - 12 * k - lh / 2, 1, index, from),
      });
    }
  }
  // A light look over the whole screen.
  add({ type: "adjustment", name: `${spec.prefix}look`, start: spec.start, duration: total, grade: { vignette: 0.3, contrast: 0.04 } });
  for (const at of windowsAt) markers.addTimeline(project, at, "desktop window opens", "");
  return {
    clips: made,
    span: [spec.start, spec.end],
    windows: laid.map((window, index) => ({
      app: window.spec.app,
      at: index === openIndex ? spec.start : window.spec.at,
      centre: [round(window.cx / DW * 1000) / 1000, round(window.cy / DH * 1000) / 1000],
      width: round((window.w / W) * 1000) / 1000,
    })),
    ...(linesAt.length > 0 ? { lines_at: linesAt } : {}),
    camera: { opens_into: openIndex, exits_into: exitIndex, moves: stops.length - 1 },
  };
}

/**
 * The footage playing on the timeline just before `frame` (the topmost video
 * clip on a picture track there, not a still): its media, the source second
 * it reached, its speed and its scale then. A desktop opens from it.
 */
export function footageBefore(project: Project, frame: number, skip: (name: string) => boolean = () => false): { media: string; source_in: number; speed: number; zoom: number } | null {
  const fps = fpsOf(project);
  const order = project.tracks.filter((track) => track.kind === "video" && track.subtitles !== true).map((track) => track.id);
  const candidates = project.clips.filter(
    (clip) => clip.type === "video" && clip.start <= frame - 1 && clipEnd(clip) >= frame && !skip(clip.name ?? "") && mediaOf(project, clip.media)?.kind === "video",
  );
  candidates.sort((a, b) => order.indexOf(b.track) - order.indexOf(a.track));
  const clip = candidates[0];
  if (clip === undefined || clip.type !== "video") return null;
  const local = frame - clip.start;
  const scaleKeys = clip.keyframes?.scale ?? [];
  let zoom = clip.transform?.scale ?? 1;
  if (scaleKeys.length > 0) {
    const last = [...scaleKeys].reverse().find((key) => key.frame <= local) ?? scaleKeys[0]!;
    const next = scaleKeys.find((key) => key.frame > local);
    zoom = next === undefined || next.frame === last.frame ? last.value : last.value + ((next.value - last.value) * (local - last.frame)) / (next.frame - last.frame);
  }
  return { media: clip.media, source_in: (clip.source_in ?? 0) + (local / fps) * (clip.speed ?? 1), speed: clip.speed ?? 1, zoom };
}

/**
 * Adds the opening Video Player to a spec: the footage before it carries on
 * in a window the camera starts zoomed into (unless its first window already
 * is a video_player opening at the start).
 */
export function openFrom(spec: Spec, footage: { media: string; source_in: number; speed: number; zoom: number } | null): Spec {
  if (footage === null) return spec;
  const first = spec.windows[0];
  if (first !== undefined && first.app === "video_player" && first.at === spec.start) {
    return { ...spec, open: { index: 0, zoom: footage.zoom } };
  }
  const window: WindowSpec = {
    app: "video_player",
    media: footage.media,
    source_in: footage.source_in,
    speed: footage.speed,
    lines: [],
    line_at: null,
    at: spec.start,
    x: null,
    y: null,
    width: null,
    z: -1,
    label: null,
  };
  return {
    ...spec,
    windows: [window, ...spec.windows],
    open: { index: 0, zoom: footage.zoom },
    exit_into: spec.exit_into === null ? null : spec.exit_into + 1,
  };
}

/** A Hermite segment's value at `frame` between keys `a` and `b` (each with its speed, value units a frame). */
function hermite(a: Args, b: Args, frame: number): number {
  const [fa, fb] = [a.frame as number, b.frame as number];
  const length = fb - fa;
  const t = (frame - fa) / length;
  const [pa, pb] = [a.value as number, b.value as number];
  const ma = ((a.handle_out as { speed: number } | undefined)?.speed ?? 0) * length;
  const mb = ((b.handle_in as { speed: number } | undefined)?.speed ?? 0) * length;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * pa + (t3 - 2 * t2 + t) * ma + (-2 * t3 + 3 * t2) * pb + (t3 - t2) * mb;
}

/**
 * Drops the keys a curve doesn't need: each key with a value and its speed
 * (handles of influence 1/3 make every segment the Hermite cubic through its
 * ends), kept only where leaving it out would move a dropped key by more than
 * `tolerance`. The keys' handles stay exact, so the curve still passes through
 * every kept key with the right speed.
 */
export function thinKeys(keys: Args[], tolerance: number): Args[] {
  if (keys.length <= 2) return keys;
  const kept: Args[] = [keys[0]!];
  let anchor = 0;
  let index = 2;
  while (index < keys.length) {
    const from = keys[anchor]!;
    const to = keys[index]!;
    let fits = true;
    for (let inner = anchor + 1; inner < index; inner++) {
      const key = keys[inner]!;
      if (Math.abs(hermite(from, to, key.frame as number) - (key.value as number)) > tolerance) {
        fits = false;
        break;
      }
    }
    if (fits) {
      index++;
      continue;
    }
    anchor = index - 1;
    kept.push(keys[anchor]!);
    index = anchor + 2;
  }
  kept.push(keys[keys.length - 1]!);
  return kept;
}
