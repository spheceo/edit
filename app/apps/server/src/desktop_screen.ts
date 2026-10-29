// The Windows screen: one of the team's motion graphics (their Cut-In Guide
// and the Oct 20 notes). A desktop on the team's wallpaper, bigger than the
// frame, holding three kinds of window, each by its own name: "Video
// Player" (footage), "Photo Viewer" (a picture) and "Notepad" (short notes
// typed on as the narration says them). The camera moves over it like an
// After Effects camera over a still desktop, slowly and smoothly: it opens
// zoomed into a Video Player playing the footage the viewer was just
// watching (the footage zooms out into the desktop), glides to each window
// as it opens and drifts between, and at the end comes back to that same
// Video Player and zooms into it; while it was off screen its footage
// changed to what plays next, so the zoom in is the cut back to the footage
// (the team: "move things around in such a way that the video player is out
// of screen, and then we change the footage… and then we zoom back in").
// Windows never overlap, and one desktop never shows the same footage or
// picture twice ("you literally have basically two of roughly the same
// footage overlapping here"). The agent places the windows or leaves it to
// Edit; every desktop comes out different.
//
// It's all ordinary clips (the wallpaper, each window's frame drawn by the
// engine at twice its size so it stays crisp under the camera's zoom, the
// picture or footage in it, the notes), each moved against the camera by
// keyframes thinned to what the curve needs, so the preview and the export
// draw it alike.

import { clipFrom } from "./clips.ts";
import * as markers from "./markers.ts";
import type { Media, Project } from "./model.ts";
import type { Mark } from "./watermarks.ts";
import { native } from "./native/index.ts";
import { addTrack, clipEnd, fps as fpsOf, freshId, mediaOf } from "./project.ts";
import { round, trim } from "./rust.ts";
import { SerdeError } from "./serde.ts";

type Args = Record<string, unknown>;

export type AppKind = "video_player" | "photo_viewer" | "notepad" | "file_viewer";
const APPS: AppKind[] = ["video_player", "photo_viewer", "notepad"];

/** The engine's window chrome at 1080p (desktop.rs): title + menu bar, inset, the Video Player's controls. */
const TOP = 43 + 31 + 2;
const INSET = 10;
const CONTROLS = 46;
/** Window frames are drawn this many times their size on screen, so the camera's zoom keeps them crisp. */
export const FRAME_SCALE = 2;
/** The desktop is this many frames wide and tall: room for the camera to travel. */
const DESKTOP = 1.5;
/** Room kept between windows and round the desktop's edge (a share of the frame's width). */
const GAP = 0.025;
/** Notes in the Notepad (1080p pixels). */
const NOTE_SIZE = 40;
const NOTE_LINE = 1.4;
const NOTE_PAD = 18;
const NOTE_GAP = 10;

/** Footage on the timeline: what a desktop opens from or closes into. */
export interface Footage {
  media: string;
  source_in: number;
  speed: number;
  /** Its scale there (a B-roll shot's zoom, the footage's framing). */
  zoom: number;
}

/** One window as asked for. `at` is the timeline frame it opens. */
export interface WindowSpec {
  app: AppKind;
  media: string | null;
  source_in: number;
  speed: number;
  lines: string[];
  line_at: number[] | null;
  at: number;
  /** Whether `at` or line_at was given (or found from the words): a time to keep, not a default. */
  timed?: boolean;
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
  /** The footage after the desktop: the opening Video Player changes to it while off screen and the camera ends zoomed into it. */
  next: Footage | null;
  /** Whether to end zoomed into the Video Player (default true when it opened from footage and there's footage after). */
  exit: boolean;
  /** Clip names start with this. */
  prefix: string;
}

/** A window laid out on the desktop (desktop pixels: the frame is W × H, the desktop DESKTOP times that). */
export interface Laid {
  spec: WindowSpec;
  /** Its size on the desktop and its centre. */
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
  /** Another channel's marks found on footage (watermarks.ts), by media id: blurred in a Video Player too. */
  marks?: Record<string, Mark[]>;
}

/** A frame's key: its kind and its pixel size as drawn (FRAME_SCALE times its size on the desktop). */
export function frameKey(app: AppKind, w: number, h: number): string {
  return `${app}:${w}x${h}`;
}

/** The pixel size a window `w` × `h` on the desktop is drawn at. */
export function drawnSize(w: number, h: number): [number, number] {
  return [Math.round(w * FRAME_SCALE), Math.round(h * FRAME_SCALE)];
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
  if (width !== null && (width < 0.12 || width > 0.6)) throw new Error(`${where}window ${index + 1}: width is a share of the frame's width, 0.12 to 0.6`);
  const label = str(given.label);
  return {
    app: kind,
    media,
    source_in: Math.max(num(given.source_in) ?? 0, 0),
    speed: Math.min(Math.max(num(given.speed) ?? 1, 0.05), 4),
    lines,
    line_at: lineAt as number[] | null,
    at,
    timed: int(given.at) !== null || lineAt !== null,
    x: share("x"),
    y: share("y"),
    width,
    z: num(given.z) ?? index,
    // "actual image" is only for a picture filling the screen, never one in a
    // window (the team: "remove actual image text on all these photo / video
    // viewers on the windows screen"); other labels ("illustrative image") stay.
    label: label === null || trim(label) === "" || /\bactual\b/iu.test(label) ? null : trim(label),
  };
}

/** Reads a desktop's windows (`desktop` op or a cover_cut_in desktop shot). */
export function readSpec(project: Project, given: Args, start: number, end: number, prefix: string, where = ""): Spec {
  const fps = fpsOf(project);
  if (end - start < Math.round(3 * fps)) throw new Error(`${where}a desktop needs at least 3 s (its camera moves slowly)`);
  const raw = Array.isArray(given.windows) ? given.windows : [];
  if (raw.length === 0 || raw.length > 6) throw new Error(`${where}windows: 1 to 6 (video_player, photo_viewer, notepad)`);
  const windows: WindowSpec[] = [];
  raw.forEach((window, index) => {
    const read = readWindow(project, window, index, start, where, windows[index - 1]?.at ?? start);
    // Kept inside the desktop (a guessed frame past its end opens near the end).
    if (read.at >= end) read.at = Math.max(end - Math.round(fps), start);
    if (read.at < start) throw new Error(`${where}window ${index + 1} opens at ${read.at}, before the desktop starts (${start})`);
    windows.push(read);
  });
  // The same footage or picture twice in one desktop reads as a mistake.
  const seen = new Set<string>();
  for (const window of windows) {
    if (window.media === null) continue;
    if (seen.has(window.media)) throw new Error(`${where}${window.media} is in two windows: one desktop shows a picture or footage once`);
    seen.add(window.media);
  }
  return { start, end, windows, open: null, next: null, exit: given.exit !== false, prefix };
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
  [0.3, 0.32],
  [0.72, 0.3],
  [0.3, 0.72],
  [0.72, 0.7],
  [0.52, 0.52],
  [0.18, 0.52],
];

/** Lays the windows out (sizes from their content, places as asked or spread over the desktop), then moves them apart so none overlaps another. */
export function layout(project: Project, spec: Spec): { laid: Laid[]; desktop: [number, number] } {
  const { width: W, height: H } = project.settings;
  const k = Math.min(W / 1920, H / 1080);
  const [DW, DH] = [W * DESKTOP, H * DESKTOP];
  const gap = GAP * W;
  // A different turn through the slots per desktop, so they don't all look alike.
  const turn = Math.abs(spec.start) % 4;
  const sized = spec.windows.map((window, index) => {
    const media = window.media === null ? undefined : mediaOf(project, window.media);
    const fallback = window.app === "notepad" ? 0.36 : window.app === "video_player" ? 0.4 : 0.24;
    const w = Math.round((window.width ?? fallback) * W);
    const contentW = w - 2 * INSET * k;
    let contentH: number;
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
      contentH = Math.max(total + 2 * NOTE_PAD * k, 0.14 * H);
    } else if (window.app === "video_player") {
      contentH = (contentW * 9) / 16;
    } else {
      const aspect = media === undefined ? 4 / 3 : Math.min(Math.max(media.width / Math.max(media.height, 1), 0.62), 1.9);
      contentH = contentW / aspect;
    }
    const bottom = (window.app === "video_player" ? CONTROLS + INSET : INSET) * k;
    const h = Math.round(contentH + TOP * k + bottom);
    const slot = SLOTS[(index + turn) % SLOTS.length]!;
    return { window, w, h, contentW, contentH, notes, cx: (window.x ?? slot[0]) * DW, cy: (window.y ?? slot[1]) * DH };
  });
  const keepInside = (one: (typeof sized)[number]) => {
    one.cx = Math.min(Math.max(one.cx, one.w / 2 + gap), DW - one.w / 2 - gap);
    one.cy = Math.min(Math.max(one.cy, one.h / 2 + gap), DH - one.h / 2 - gap);
  };
  sized.forEach(keepInside);
  // Apart: each overlapping pair pushed away from each other along the
  // axis that needs the least, the opening Video Player held still.
  const fixed = spec.open?.index ?? -1;
  for (let pass = 0; pass < 200; pass++) {
    let moved = false;
    for (let a = 0; a < sized.length; a++) {
      for (let b = a + 1; b < sized.length; b++) {
        const [p, q] = [sized[a]!, sized[b]!];
        const ox = (p.w + q.w) / 2 + gap - Math.abs(p.cx - q.cx);
        const oy = (p.h + q.h) / 2 + gap - Math.abs(p.cy - q.cy);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        const [share, other] = a === fixed ? [0, 1] : b === fixed ? [1, 0] : [0.5, 0.5];
        if (ox < oy) {
          const sign = p.cx <= q.cx ? -1 : 1;
          p.cx += sign * ox * share;
          q.cx -= sign * ox * other;
        } else {
          const sign = p.cy <= q.cy ? -1 : 1;
          p.cy += sign * oy * share;
          q.cy -= sign * oy * other;
        }
        keepInside(p);
        keepInside(q);
      }
    }
    if (!moved) break;
  }
  const laid = sized.map(
    (one): Laid => ({
      spec: one.window,
      w: one.w,
      h: one.h,
      cx: one.cx,
      cy: one.cy,
      content: [one.cx - one.w / 2 + INSET * k, one.cy - one.h / 2 + TOP * k, one.contentW, one.contentH],
      notes: one.notes,
    }),
  );
  return { laid, desktop: [DW, DH] };
}

/** The window frames (app, width, height as drawn) a desktop needs. */
export function frameSizes(project: Project, spec: Spec): [AppKind, number, number][] {
  return layout(project, spec).laid.map((window) => [window.spec.app, ...drawnSize(window.w, window.h)]);
}

interface Pose {
  x: number;
  y: number;
  z: number;
}

/** Smootherstep: no jolt at either end of a move. */
const ease = (t: number) => {
  const u = Math.min(Math.max(t, 0), 1);
  return u * u * u * (u * (u * 6 - 15) + 10);
};
const easeOut = (t: number) => 1 - (1 - Math.min(Math.max(t, 0), 1)) ** 3;

/** The camera drifts in this much a second, so the desktop never sits still. */
const DRIFT = 0.008;
/** Frames at 30 fps: the opening hold, the zoom out of the footage, a glide to a window, the zoom back in. */
const HOLD = 10;
const ZOOM_OUT = 60;
const GLIDE = 54;
const ZOOM_IN = 54;
/** The zoom out at its quickest (it hurries for a note said as the screen starts). */
const QUICKEST_ZOOM_OUT = 30;
/** A window pops in over this many frames, fading over this many. */
const POP = 16;
const FADE = 12;

/**
 * Builds a desktop: its clips on new tracks (on top), its markers. `art` has
 * the wallpaper and every frame `frameSizes` asked for.
 */
export function build(project: Project, spec: Spec, art: Art): Record<string, unknown> {
  const fps = fpsOf(project);
  const s = fps / 30;
  const { width: W, height: H } = project.settings;
  const k = Math.min(W / 1920, H / 1080);
  const total = spec.end - spec.start;
  const rel = (frame: number) => frame - spec.start;
  // No window opens while the camera is still zoomed into the opening Video
  // Player: it would pop up huge over the footage. They wait until the zoom
  // out is mostly done, so when the narration names the first note as the
  // screen starts, the zoom out is quicker, or there's none and the screen
  // opens on its windows (Mom & Teen's notes came 1–3 s after their words:
  // "we need to have it visually in front of us a second before").
  let zoomOut = Math.round(ZOOM_OUT * s);
  if (spec.open !== null) {
    const timed = spec.windows.filter((window, index) => index !== spec.open!.index && window.timed === true);
    const room = (windows: WindowSpec[]) => Math.min(...windows.map((window) => Math.min(window.at, ...(window.line_at ?? [])))) - spec.start - Math.round(HOLD * s);
    const quickest = Math.round(QUICKEST_ZOOM_OUT * s);
    // Notes are read: they never wait. A picture waits for the quickest zoom out.
    if (room(timed.filter((window) => window.app === "notepad")) < Math.round(quickest * 0.75)) spec = withoutOpen(spec);
    else zoomOut = Math.min(zoomOut, Math.max(Math.round(room(timed) / 0.75), quickest));
  }
  const openIndex = spec.open?.index ?? null;
  if (openIndex !== null) {
    const earliest = spec.start + Math.round(HOLD * s + zoomOut * 0.75);
    spec.windows.forEach((window, index) => {
      if (index !== openIndex && window.at < earliest) window.at = Math.min(earliest, spec.end - 1);
    });
  }
  // Never two windows at once, as words named close together (or the wait
  // above) would have them: each opens at least a second after the one
  // before (JJ: "dangerous to have two things appear at the same time when
  // they are across the screen").
  const opening = spec.windows.filter((_, index) => index !== openIndex).sort((a, b) => a.at - b.at);
  for (let i = 1; i < opening.length; i++) {
    const after = opening[i - 1]!.at + Math.round(fps);
    if (opening[i]!.at < after) opening[i]!.at = Math.min(after, spec.end - 1);
  }
  const { laid, desktop } = layout(project, spec);
  const [DW, DH] = desktop;
  const player = openIndex === null ? null : laid[openIndex]!;
  const exits = player !== null && spec.exit && spec.next !== null;

  // A footage's picture shown inside a content area (contain): [x, y, w, h] on the desktop.
  // A player's footage fills its screen, cropped to it, as footage fills the frame full screen
  // (the team: "remove the black bars on the interrogation footage", in a Video Player too).
  const shownIn = (window: Laid, _media: Media | undefined): [number, number, number, number] => window.content;
  const keep = (pose: Pose): Pose => {
    const [hw, hh] = [W / 2 / pose.z, H / 2 / pose.z];
    const x = DW > 2 * hw ? Math.min(Math.max(pose.x, hw), DW - hw) : DW / 2;
    const y = DH > 2 * hh ? Math.min(Math.max(pose.y, hh), DH - hh) : DH / 2;
    return { x, y, z: pose.z };
  };
  // The pose framing some windows with a margin, kept over the desktop.
  const framing = (windows: Laid[]): Pose => {
    const left = Math.min(...windows.map((w) => w.cx - w.w / 2));
    const right = Math.max(...windows.map((w) => w.cx + w.w / 2));
    const top = Math.min(...windows.map((w) => w.cy - w.h / 2));
    const bottom = Math.max(...windows.map((w) => w.cy + w.h / 2));
    const z = Math.min(Math.max(Math.min((W * 0.78) / (right - left), (H * 0.76) / (bottom - top)), 0.62), 1.2);
    return keep({ x: (left + right) / 2, y: (top + bottom) / 2, z });
  };
  // Zoomed into a Video Player so `media` fills the frame as it does full
  // frame at `zoom` (the footage fitted to the frame, times its scale there).
  const into = (window: Laid, media: Media | undefined, zoom: number): Pose => {
    const [x, y, w, h] = shownIn(window, media);
    const fitted = media === undefined ? W : Math.min(W / media.width, H / media.height) * media.width;
    return { x: x + w / 2, y: y + h / 2, z: (fitted * zoom) / w };
  };
  const openMedia = player === null ? undefined : mediaOf(project, player.spec.media ?? "");
  const nextMedia = spec.next === null ? undefined : mediaOf(project, spec.next.media);

  // The camera: poses at frames (relative), eased between, zoom on a log scale.
  const order = laid.map((_, index) => index).sort((a, b) => laid[a]!.spec.at - laid[b]!.spec.at || a - b);
  const stops: { from: number; to: number; pose: Pose }[] = [];
  let free = 0;
  const others = order.filter((index) => index !== openIndex).map((index) => laid[index]!);
  if (player !== null) {
    stops.push({ from: 0, to: 0, pose: into(player, openMedia, spec.open!.zoom) });
    const hold = Math.round(HOLD * s);
    const out = Math.min(zoomOut, Math.max(total - hold - 1, 1));
    // Out to the player with room round it and the first window beside it.
    const first = others[0];
    const wide = first === undefined ? framing([player]) : framing([player, first]);
    stops.push({ from: hold, to: hold + out, pose: { ...wide, z: Math.min(wide.z, framing([player]).z * 0.8) } });
    free = hold + out;
  } else if (others[0] !== undefined) {
    const first = framing([others[0]]);
    stops.push({ from: 0, to: 0, pose: { ...first, z: first.z * 0.92 } });
  }
  const back = exits ? Math.round(ZOOM_IN * s) : 0;
  const exitAt = exits ? Math.max(total - back, free) : total;
  // To each window as it opens, with everything else open so far when it
  // fits (so a Notepad still typing stays in view), the opening player left
  // behind once the camera has moved on.
  const opened: Laid[] = [];
  for (const window of others) {
    opened.push(window);
    if (player === null && window === others[0]) continue;
    const opens = rel(window.spec.at);
    const from = Math.max(free, opens - Math.round(12 * s));
    if (from >= exitAt - Math.round(12 * s)) break;
    const to = Math.min(from + Math.round(GLIDE * s), exitAt - 1);
    const all = framing(opened);
    const pose = all.z > 0.62 ? all : framing(opened.slice(-2)).z > 0.66 ? framing(opened.slice(-2)) : framing([window]);
    stops.push({ from, to, pose });
    free = to;
  }
  // One zoom while it travels between windows: it pans, never zooming in on
  // one and back out for the next (the team: "I don't feel it looks too good
  // that we zoom in and then zoom out again"). The widest the windows need.
  const travel = stops.slice(player !== null ? 1 : 0);
  if (travel.length > 1) {
    const z = Math.min(...travel.map((stop) => stop.pose.z));
    for (const stop of travel) stop.pose = { ...stop.pose, z };
  }
  const drift = (frame: number) => 1 + (DRIFT * frame) / fps;
  if (exits) {
    const target = into(player!, nextMedia, spec.next!.zoom);
    stops.push({ from: exitAt, to: total - 1, pose: { ...target, z: target.z / drift(total - 1) } });
  }
  const camera = (frame: number): Pose => {
    let pose = stops[0]?.pose ?? { x: DW / 2, y: DH / 2, z: 0.7 };
    for (let index = 1; index < stops.length; index++) {
      const stop = stops[index]!;
      if (frame <= stop.from) break;
      const t = stop.to > stop.from ? ease((frame - stop.from) / (stop.to - stop.from)) : 1;
      pose = {
        x: pose.x + (stop.pose.x - pose.x) * t,
        y: pose.y + (stop.pose.y - pose.y) * t,
        z: Math.exp(Math.log(pose.z) + (Math.log(stop.pose.z) - Math.log(pose.z)) * t),
      };
      if (frame < stop.to) break;
    }
    return { ...pose, z: pose.z * drift(frame) };
  };

  // When the opening player's footage changes to what plays next: in the
  // longest stretch it's wholly off screen, else where least of it shows
  // (crossfaded there).
  let swap: { at: number; fade: number } | null = null;
  if (exits) {
    const visible = (frame: number) => {
      const pose = camera(frame);
      const [hw, hh] = [W / 2 / pose.z, H / 2 / pose.z];
      const ox = Math.max(0, Math.min(player!.cx + player!.w / 2, pose.x + hw) - Math.max(player!.cx - player!.w / 2, pose.x - hw));
      const oy = Math.max(0, Math.min(player!.cy + player!.h / 2, pose.y + hh) - Math.max(player!.cy - player!.h / 2, pose.y - hh));
      return (ox * oy) / (player!.w * player!.h);
    };
    const from = Math.min(Math.round(HOLD * s) + zoomOut, exitAt - 1);
    let best: [number, number] | null = null;
    let run: number | null = null;
    let least: [number, number] = [from, Infinity];
    for (let frame = from; frame < exitAt; frame++) {
      const seen = visible(frame);
      if (seen < least[1]) least = [frame, seen];
      if (seen <= 0) {
        run ??= frame;
        if (best === null || frame - run > best[1] - best[0]) best = [run, frame];
      } else run = null;
    }
    swap = best !== null ? { at: Math.round((best[0] + best[1]) / 2), fade: 0 } : { at: least[0], fade: Math.round(12 * s) };
  }

  // A window's own motion: popping in (scale about its centre, opacity) and, for a picture or notes, a slow float.
  const pop = Math.round(POP * s);
  const fadeIn = Math.round(FADE * s);
  const motion = (window: Laid, index: number, frame: number): { s: number; o: number; dy: number } => {
    if (index === openIndex) return { s: 1, o: 1, dy: 0 };
    const t = frame - rel(window.spec.at);
    return {
      s: 0.9 + 0.1 * easeOut(t / pop),
      o: easeOut(t / fadeIn),
      dy: window.spec.app === "video_player" ? 0 : 2 * k * Math.sin((2 * Math.PI * frame) / (6 * fps) + index * 1.7),
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
  const HANDLE = 1 / 3;
  // Keys for an element centred at (px, py) on the desktop with `base` scale,
  // in window `index` (null: the wallpaper), on screen from `from`: sampled
  // every other frame with exact speeds, then thinned.
  const keysFor = (px: number, py: number, base: number, index: number | null, from: number, until = total) => {
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
    const frames = new Set<number>([from, until - 1]);
    for (let frame = from; frame < until; frame += Math.max(Math.round(2 * s), 1)) frames.add(frame);
    if (opens !== null) for (let frame = opens; frame <= opens + pop + 2; frame++) if (frame >= from && frame < until) frames.add(frame);
    for (const frame of [...frames].sort((a, b) => a - b)) {
      const here = at(frame);
      const [before, after] = [at(frame - 0.5), at(frame + 0.5)];
      for (const key of ["x", "y", "scale"] as const) {
        const handle = { speed: after[key] - before[key], influence: HANDLE };
        lists[key].push({ frame: frame - from, value: here[key], ease: "linear", handle_in: { ...handle }, handle_out: handle });
      }
      if (opens !== null && frame <= opens + fadeIn) opacity.push({ frame: frame - from, value: here.o, ease: "linear" });
    }
    const first = at(from);
    const thinned = { x: thinKeys(lists.x, 0.3), y: thinKeys(lists.y, 0.3), scale: thinKeys(lists.scale, 0.3 / Math.max(W, 1)) };
    return {
      transform: { x: first.x, y: first.y, scale: first.scale },
      keyframes: opacity.length > 0 ? { ...thinned, opacity } : thinned,
    };
  };
  // A picture's scale so it's `width` desktop pixels wide (the renderer fits media to the frame at scale 1).
  const scaleFor = (media: Media, width: number) => width / (Math.max(media.width, 1) * Math.min(W / Math.max(media.width, 1), H / Math.max(media.height, 1)));

  // The wallpaper, filling the frame and still: only the windows move with
  // the camera. It moved with them over a desktop the camera could pull back
  // past, and its edge came into view with black beyond (the user, Oct 29:
  // "Why is the background moving along with the elements? This is not
  // supposed to be happening at all").
  const wallpaper = mediaOf(project, art.wallpaper);
  if (wallpaper === undefined) throw new Error("desktop: the wallpaper wasn't prepared (run it through apply_edit_plan)");
  const cover = Math.max(W / Math.max(wallpaper.width, 1), H / Math.max(wallpaper.height, 1)) * wallpaper.width;
  add({
    type: "video",
    name: `${spec.prefix}wallpaper`,
    media: wallpaper.id,
    source_in: 0,
    // A designed graphic, not a bare still (the audit): no border, no shadow.
    frame: { width: 0, shadow: 0 },
    start: spec.start,
    duration: total,
    transform: { x: 0, y: 0, scale: scaleFor(wallpaper, cover) * 1.01, rotation: 0 },
  });

  const zOrder = laid.map((_, index) => index).sort((a, b) => laid[a]!.spec.z - laid[b]!.spec.z || a - b);
  const linesAt: number[] = [];
  const windowsAt: number[] = [];
  for (const index of zOrder) {
    const window = laid[index]!;
    const name = window.spec.app === "video_player" ? "Video Player" : window.spec.app === "photo_viewer" ? "Photo Viewer" : "Notepad";
    const from = index === openIndex ? 0 : rel(window.spec.at);
    const [fw, fh] = drawnSize(window.w, window.h);
    const frameMedia = art.frames[frameKey(window.spec.app, fw, fh)];
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
      // Never two lines at once ("this text doesn't appear at the same time in
      // the Notepad"), and never late for their words: a line named right
      // after another moves the one before it earlier (as far as the window's
      // opening allows), so each finishes typing before the next starts.
      const typing = (line: number) => Math.min((window.spec.lines[line] ?? "").length, 36) * Math.max(Math.round(s), 1) + Math.round(6 * s);
      const opens = window.spec.at + Math.round(8 * s);
      const wanted = window.notes.map((_, line) => Math.max(window.spec.line_at?.[line] ?? window.spec.at + Math.round((14 + 40 * line) * s), opens));
      const starts = [...wanted];
      for (let line = starts.length - 2; line >= 0; line--) starts[line] = Math.min(starts[line]!, starts[line + 1]! - typing(line));
      for (let line = 0; line < starts.length; line++) starts[line] = Math.max(starts[line]!, line === 0 ? opens : starts[line - 1]! + typing(line - 1));
      window.notes.forEach((note, line) => {
        const at = starts[line]!;
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
    // The picture or footage in its window. The opening player's footage
    // changes to what plays next at the swap (ending exactly where the
    // footage after the desktop starts, so the zoom in is seamless).
    const pieces: { media: Media; source_in: number; speed: number; from: number; until: number; fade: number }[] = [];
    if (index === openIndex && exits && swap !== null && nextMedia !== undefined) {
      const changeAt = Math.min(Math.max(swap.at, 1), total - 2);
      const nextFrom = Math.max(spec.next!.source_in - ((total - changeAt) / fps) * spec.next!.speed, 0);
      pieces.push({ media, source_in: window.spec.source_in, speed: window.spec.speed, from: 0, until: Math.min(changeAt + swap.fade, total), fade: 0 });
      pieces.push({ media: nextMedia, source_in: nextFrom, speed: spec.next!.speed, from: changeAt, until: total, fade: swap.fade });
    } else {
      pieces.push({ media, source_in: window.spec.source_in, speed: window.spec.speed, from, until: total, fade: 0 });
    }
    for (const piece of pieces) {
      const [x, y, w, h] = shownIn(window, piece.media);
      let crop: Args = {};
      let width = w;
      // Filling the content area: a photo's (its shape is the picture's, kept within limits) a little
      // cropped at most, a player's footage cropped to the player (no black bars inside it either).
      if (window.spec.app === "photo_viewer" || window.spec.app === "video_player") {
        const aspect = piece.media.width / Math.max(piece.media.height, 1);
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
        name: `${spec.prefix}${name} · ${piece.media.name}`,
        media: piece.media.id,
        source_in: piece.media.kind === "video" ? piece.source_in : 0,
        ...(piece.media.kind === "video" ? { speed: piece.speed } : {}),
        start: spec.start + piece.from,
        duration: piece.until - piece.from,
        fade_in: piece.fade,
        crop,
        ...(piece.media.kind === "image" ? { frame: { width: 0, shadow: 0 } } : {}),
        ...keysFor(x + w / 2, y + h / 2, scaleFor(piece.media, width), index, piece.from, piece.until),
      });
      // The uploader's logo on the footage, blurred where it plays in the
      // window and moving with the camera (Mom Leaves 5 Kids' Code Blue Cam
      // logo was blurred on the tapes but showed in the desktop's player).
      const height = (width * piece.media.height) / Math.max(piece.media.width, 1);
      for (const mark of art.marks?.[piece.media.id] ?? []) {
        const [x0, y0, x1, y1] = mark.box;
        if ((x1 - x0) * (y1 - y0) >= 0.25) continue;
        const left = Math.max(x + w / 2 + (x0 - 0.5) * width, x);
        const right = Math.min(x + w / 2 + (x1 - 0.5) * width, x + w);
        const top = Math.max(y + h / 2 + (y0 - 0.5) * height, y);
        const bottom = Math.min(y + h / 2 + (y1 - 0.5) * height, y + h);
        if (right - left < 2 || bottom - top < 2) continue;
        const pad = 1.2;
        const keyed = keysFor((left + right) / 2, (top + bottom) / 2, 1, index, piece.from, piece.until);
        const keys = keyed.keyframes as Record<string, Args[]>;
        // The window's scale keys as a size: values and handle speeds times it.
        const times = (handle: unknown, size: number) => ({ ...(handle as Args), speed: ((handle as Args).speed as number) * size });
        const sized = (size: number) => (keys.scale ?? []).map((key) => ({ ...key, value: (key.value as number) * size, handle_in: times(key.handle_in, size), handle_out: times(key.handle_out, size) }));
        add({
          type: "adjustment",
          name: `${spec.prefix}${name} · mark blur`,
          start: spec.start + piece.from,
          duration: piece.until - piece.from,
          blur: { radius: 18 * k, x: keyed.transform.x, y: keyed.transform.y, width: (right - left) * pad * keyed.transform.scale, height: (bottom - top) * pad * keyed.transform.scale, feather: 4 * k, shape: "rect" },
          keyframes: { "blur.x": keys.x, "blur.y": keys.y, "blur.width": sized((right - left) * pad), "blur.height": sized((bottom - top) * pad), ...(keys.opacity !== undefined ? { opacity: keys.opacity } : {}) },
        });
      }
    }
    if (window.spec.label !== null) {
      const text = window.spec.label.startsWith("(") ? window.spec.label : `(${window.spec.label})`;
      const size = 20 * k;
      const [lw, lh] = measure(text, size);
      const [x, y, , h] = window.content;
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
  add({ type: "adjustment", name: `${spec.prefix}look`, start: spec.start, duration: total, grade: { vignette: 0.3, contrast: 0.04, grain: 0.15 } });
  for (const at of windowsAt) markers.addTimeline(project, at, "desktop window opens", "");
  return {
    clips: made,
    span: [spec.start, spec.end],
    windows: laid.map((window, index) => ({
      app: window.spec.app,
      at: index === openIndex ? spec.start : window.spec.at,
      centre: [round((window.cx / DW) * 1000) / 1000, round((window.cy / DH) * 1000) / 1000],
      width: round((window.w / W) * 1000) / 1000,
    })),
    ...(linesAt.length > 0 ? { lines_at: linesAt } : {}),
    camera: { opens_from_footage: openIndex !== null, ends_in_footage: exits, ...(swap !== null ? { footage_changes_at: spec.start + swap.at } : {}), moves: stops.length - 1 },
  };
}

/**
 * The footage playing on the timeline at `frame` (`before`: just before it):
 * the topmost video clip on a picture track there, not a still; its media,
 * the source second it's at, its speed and its scale then.
 */
export function footageAt(project: Project, frame: number, before: boolean, skip: (name: string) => boolean = () => false): Footage | null {
  const fps = fpsOf(project);
  const at = before ? frame - 1 : frame;
  const order = project.tracks.filter((track) => track.kind === "video" && track.subtitles !== true).map((track) => track.id);
  const candidates = project.clips.filter(
    (clip) => clip.type === "video" && clip.start <= at && clipEnd(clip) > at && !skip(clip.name ?? "") && mediaOf(project, clip.media)?.kind === "video",
  );
  candidates.sort((a, b) => order.indexOf(b.track) - order.indexOf(a.track));
  const clip = candidates[0];
  if (clip === undefined || clip.type !== "video") return null;
  const local = (before ? frame : frame) - clip.start;
  const scaleKeys = clip.keyframes?.scale ?? [];
  let zoom = clip.transform?.scale ?? 1;
  if (scaleKeys.length > 0) {
    const last = [...scaleKeys].reverse().find((key) => key.frame <= local) ?? scaleKeys[0]!;
    const next = scaleKeys.find((key) => key.frame > local);
    zoom = next === undefined || next.frame === last.frame ? last.value : last.value + ((next.value - last.value) * (local - last.frame)) / (next.frame - last.frame);
  }
  return { media: clip.media, source_in: (clip.source_in ?? 0) + (local / fps) * (clip.speed ?? 1), speed: clip.speed ?? 1, zoom };
}

/** The footage playing just before `frame` (a desktop opens from it). */
export function footageBefore(project: Project, frame: number, skip: (name: string) => boolean = () => false): Footage | null {
  return footageAt(project, frame, true, skip);
}

/**
 * Adds the opening Video Player to a spec: the footage before it carries on
 * in a window the camera starts zoomed into (one of the agent's own
 * video_player windows when it plays that footage), and the footage after
 * it, which that player changes to before the camera zooms back in.
 */
export function openFrom(spec: Spec, footage: Footage | null, next: Footage | null = null): Spec {
  if (footage === null) return spec;
  const own = spec.windows.findIndex((window) => window.app === "video_player" && window.media === footage.media);
  if (own >= 0) {
    const windows = spec.windows.map((window, index) => (index === own ? { ...window, at: spec.start, source_in: footage.source_in, speed: footage.speed } : window));
    return { ...spec, windows, open: { index: own, zoom: footage.zoom }, next };
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
  return { ...spec, windows: [window, ...spec.windows], open: { index: 0, zoom: footage.zoom }, next };
}

/** A spec with no opening Video Player: the one openFrom added goes, the agent's own stays a window. */
function withoutOpen(spec: Spec): Spec {
  const index = spec.open?.index ?? null;
  if (index === null) return spec;
  const added = spec.windows[index]?.z === -1;
  return { ...spec, windows: added ? spec.windows.filter((_, own) => own !== index) : spec.windows, open: null, next: null };
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
