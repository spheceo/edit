// The team's reference effects (their "For Sphe" folder, Oct 20), one plan
// op each, copied as closely as the renderer allows and moving smoothly:
//
// - `film_look`: pictures and footage under a film look: grain, faint scan
//   lines, a faded print, a heavy vignette, soft edges, and a tag in the
//   corner: "[ACTUAL PHOTO]", "[REENACTMENT]" (their "Overlay" folder).
// - `red_quote`: what someone said, in red glowing words with a short red
//   line to them, over the footage darkened and greyed with the light kept on
//   them ("Text on screen").
// - `annotate`: red handwritten notes with lines pointing at what's in a
//   picture ("mapping out what we see").
// - `call`: a 911 call or voicemail: a glowing waveform over the picture
//   darkened, the caller's words under it ("911 call").
// - `file_viewer`: the references' floating window ("File Viewer", a thin
//   dark frame) holding a photo or footage over a map or a scene, a name in
//   monospace on it, popping in and drifting slowly ("Map").

import { clipFrom } from "./clips.ts";
import { FRAME_SCALE, frameKey } from "./desktop_screen.ts";
import * as markers from "./markers.ts";
import type { Media, Project } from "./model.ts";
import { native } from "./native/index.ts";
import { addTrack, clipEnd, fps as fpsOf, freshId, mediaOf, trackOf } from "./project.ts";
import { trim } from "./rust.ts";
import { SerdeError } from "./serde.ts";

type Args = Record<string, unknown>;

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const int = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === "string" && trim(value) !== "" ? trim(value) : null);

function span(args: Args, what: string, least = 15): [number, number] {
  const start = int(args.start);
  if (start === null) throw new Error(`${what} needs start (frames)`);
  const end = int(args.end) ?? (int(args.duration) === null ? null : start + int(args.duration)!);
  if (end === null) throw new Error(`${what} needs end or duration (frames)`);
  if (end - start < least) throw new Error(`${what} needs at least ${least} frames`);
  return [Math.max(start, 0), end];
}

function adder(project: Project, made: string[], what: string) {
  return (fields: Args): string => {
    const id = freshId(project, "c");
    let clip;
    try {
      clip = clipFrom({ track: addTrack(project, "video"), ...fields, id });
    } catch (error) {
      if (error instanceof SerdeError) throw new Error(`${what}: ${error.message}`);
      throw error;
    }
    project.clips.push(clip);
    made.push(id);
    return id;
  };
}

const point = (value: unknown, what: string): [number, number] => {
  if (Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number" && Number.isFinite(n))) return [value[0] as number, value[1] as number];
  throw new Error(`${what} is [x, y] in project pixels from the frame's centre (y down)`);
};

/** The corner tag ("[ACTUAL PHOTO]"): small Geist Mono bottom left, softly glowing. */
function tag(project: Project, add: (fields: Args) => string, text: string, start: number, end: number, name: string): void {
  const { width: W, height: H } = project.settings;
  const k = H / 1080;
  const shown = `[${text.replace(/^\[|\]$/g, "").toUpperCase()}]`;
  const [bw, bh] = native().textBlock(shown, 22 * k, 500, 1.2);
  add({
    type: "text",
    name,
    text: shown,
    start,
    duration: end - start,
    fade_in: 8,
    fade_out: 8,
    style: { font: "Geist Mono", weight: 500, size: 22 * k, color: [1, 1, 1, 0.92], align: "left", glow: { enabled: true, color: null, radius: 12 * k, strength: 0.35 } },
    transform: { x: -W / 2 + 0.045 * W + bw / 2, y: H / 2 - 0.075 * H - bh / 2 },
  });
}

/**
 * `{"op":"film_look","start":F,"end":F,"tag":"actual photo","soft_edges":true}`:
 * the references' overlay over whatever plays beneath (a photo full frame, a
 * B-roll shot): grain, faint scan lines, a faded print, a heavy vignette and
 * a little less colour; soft_edges blurs the top and bottom like a tilt
 * shift; tag puts "[ACTUAL PHOTO]" (or "[REENACTMENT]", "[ILLUSTRATIVE]")
 * small in the bottom-left corner. strength "light" for footage that should
 * still read clearly.
 */
export function filmLook(project: Project, args: Args): Record<string, unknown> {
  const [start, end] = span(args, "film_look");
  const H = project.settings.height;
  const light = args.strength === "light";
  const made: string[] = [];
  const add = adder(project, made, "film_look");
  if (args.soft_edges === true) {
    for (const side of [-1, 1]) {
      add({
        type: "adjustment",
        name: "Film look · soft edge",
        start,
        duration: end - start,
        fade_in: 6,
        fade_out: 6,
        blur: { radius: 16 * (H / 1080), x: 0, y: side * 0.42 * H, width: project.settings.width, height: 0.2 * H, feather: 0.16 * H, shape: "rect" },
      });
    }
  }
  add({
    type: "adjustment",
    name: "Film look",
    start,
    duration: end - start,
    fade_in: 6,
    fade_out: 6,
    grade: light
      ? { contrast: 0.04, saturation: -0.15, vignette: 0.45, grain: 0.35, scanlines: 0.2, fade: 0.12 }
      : { contrast: 0.06, saturation: -0.28, vignette: 0.62, grain: 0.55, scanlines: 0.35, fade: 0.22 },
  });
  const text = str(args.tag);
  if (text !== null) tag(project, add, text, start, end, "Film look · tag");
  return { clips: made };
}

/**
 * `{"op":"red_quote","text":"Nobody's seen her","start":F,"end":F,"face":[x,y]}`:
 * the references' quote: the exact words in red glowing type with curly
 * quotes, set above and beside the speaker (at, or up and to the side of
 * their face), a short red line from near their head to the words, over the
 * footage darkened and greyed with the light kept on them (face: a point on
 * their head, project pixels from the centre; pin it with track_region target
 * "leader" and "vignette" when they move). Several lines stack ("lines"
 * instead of text: each rising in at its own frame, `line_at`).
 */
export function redQuote(project: Project, args: Args): Record<string, unknown> {
  const [start, end] = span(args, "red_quote", 30);
  const { width: W, height: H } = project.settings;
  const k = H / 1080;
  const face = point(args.face, "face");
  const lines = Array.isArray(args.lines) ? args.lines.map(str).filter((line): line is string => line !== null) : [];
  const single = str(args.text);
  const quotes = lines.length > 0 ? lines : single !== null ? [single] : [];
  if (quotes.length === 0 || quotes.length > 3) throw new Error("red_quote needs text (their exact words) or lines (2–3 of them)");
  const lineAt = Array.isArray(args.line_at) ? args.line_at.map(int) : null;
  const made: string[] = [];
  const add = adder(project, made, "red_quote");
  // The footage darkened and greyed, the light kept on the speaker.
  add({
    type: "adjustment",
    name: "Red quote · light on them",
    start,
    duration: end - start,
    fade_in: 10,
    fade_out: 10,
    grade: { exposure: -0.35, saturation: -0.7, vignette: 0.85, vignette_x: face[0], vignette_y: face[1], vignette_size: 0.55, vignette_aspect: 0.8, focus_exposure: 0.35 },
  });
  const size = (quotes.length > 1 ? 52 : 60) * k;
  const style = (leader: boolean) => ({
    font: "Geist",
    weight: 600,
    size,
    color: [1, 0.09, 0.09, 1],
    line_height: 1.15,
    align: "center",
    max_width: 0.62 * W,
    glow: { enabled: true, color: null, radius: 30 * k, strength: 0.9 },
    ...(leader ? { leader: { x: face[0] + (face[0] > 0 ? -40 : 40) * k, y: face[1] - 70 * k, width: 3 * k, color: [1, 0.09, 0.09, 1], attach: "nearest", draw: 8, fade: 8 } } : {}),
  });
  // Above and beside the head, on the side with more room.
  const given = Array.isArray(args.at) ? point(args.at, "at") : null;
  const side = face[0] > 0 ? -1 : 1;
  const base: [number, number] = given ?? [Math.max(Math.min(face[0] + side * 0.12 * W, 0.3 * W), -0.3 * W), Math.max(face[1] - 0.2 * H, -0.32 * H)];
  quotes.forEach((quote, index) => {
    const at = lineAt?.[index] ?? start + index * Math.round(fpsOf(project) * 0.8);
    const words = `“${quote.replace(/^["“]|["”]$/g, "")}”`;
    add({
      type: "text",
      name: "Red quote",
      text: words,
      start: Math.min(Math.max(at, start), end - 10),
      duration: end - Math.min(Math.max(at, start), end - 10),
      fade_out: 10,
      style: style(index === quotes.length - 1),
      transform: { x: base[0], y: base[1] + index * size * 1.6 },
      animation: { preset: "rise", duration: 12, stagger: 1 },
    });
  });
  return { clips: made };
}

/**
 * `{"op":"annotate","start":F,"end":F,"notes":[{"text":"strangulation marks","at":F,"point":[x,y]}],"tag":"actual photo"}`:
 * red handwritten notes (Reenie Beanie) with a red line each to what they
 * name in the picture beneath (point, project pixels from the centre),
 * written on one by one at their frames; `from` [x, y] places a note (else
 * up and away from its point, alternating sides). A film look and its tag
 * go under them unless `look: false`.
 */
export function annotate(project: Project, args: Args): Record<string, unknown> {
  const [start, end] = span(args, "annotate", 30);
  const { width: W, height: H } = project.settings;
  const k = H / 1080;
  const notes = Array.isArray(args.notes) ? args.notes : [];
  if (notes.length === 0 || notes.length > 5) throw new Error("annotate needs notes: 1 to 5 of {text, at, point}");
  const made: string[] = [];
  const add = adder(project, made, "annotate");
  if (args.look !== false) {
    const look = filmLook(project, { start, end, tag: args.tag ?? null, strength: "light" });
    made.push(...(look.clips as string[]));
  }
  notes.forEach((raw, index) => {
    const note = (typeof raw === "object" && raw !== null ? raw : {}) as Args;
    const text = str(note.text);
    if (text === null) throw new Error(`annotate note ${index + 1}: text`);
    const target = point(note.point, `annotate note ${index + 1}: point`);
    const at = Math.min(Math.max(int(note.at) ?? start + index * Math.round(fpsOf(project)), start), end - 10);
    const side = index % 2 === 0 ? 1 : -1;
    const from = Array.isArray(note.from)
      ? point(note.from, `annotate note ${index + 1}: from`)
      : ([Math.max(Math.min(target[0] + side * 0.16 * W, 0.4 * W), -0.4 * W), Math.max(Math.min(target[1] - 0.16 * H, 0.4 * H), -0.4 * H)] as [number, number]);
    add({
      type: "text",
      name: `Annotation · ${text}`,
      text,
      start: at,
      duration: end - at,
      fade_out: 10,
      style: {
        font: "Reenie Beanie",
        weight: 400,
        size: 84 * k,
        color: [0.9, 0.06, 0.1, 1],
        glow: { enabled: false },
        leader: { x: target[0], y: target[1], width: 3.5 * k, color: [0.9, 0.06, 0.1, 1], attach: "nearest", draw: 12, fade: 6 },
      },
      transform: { x: from[0], y: from[1], rotation: side * -3 },
      animation: { preset: "typewriter", duration: 1, stagger: 2 },
    });
    markers.addTimeline(project, at, "annotation", text);
  });
  return { clips: made };
}

/**
 * `{"op":"call","start":F,"end":F,"color":"blue"}`: a 911 call or voicemail
 * the references' way: the picture beneath darkened and greyed, a glowing
 * waveform (blue or red) across it a little above the middle, and the
 * subtitles said in the span turned into the call's words just under it
 * (white bold with a soft dark glow, coming up word by word); add the
 * subtitles first.
 */
export function call(project: Project, args: Args): Record<string, unknown> {
  const [start, end] = span(args, "call", 30);
  const { width: W, height: H } = project.settings;
  const k = H / 1080;
  const color = args.color === "red" ? [1, 0.08, 0.08, 1] : [0.1, 0.72, 1, 1];
  const made: string[] = [];
  const add = adder(project, made, "call");
  add({
    type: "adjustment",
    name: "Call · darkened",
    start,
    duration: end - start,
    fade_in: 10,
    fade_out: 10,
    grade: { exposure: -1.1, saturation: -0.55, vignette: 0.75, temperature: -0.15 },
  });
  add({
    type: "waveform",
    name: "Call · waveform",
    start,
    duration: end - start,
    fade_in: 8,
    fade_out: 8,
    style: { kind: "line", color, strands: 2, width: 0.62 * W, height: 0.16 * H, window: 1.6, gain: 1, glow: { enabled: true, color: null, radius: 26 * k, strength: 0.85 } },
    transform: { x: 0, y: -0.12 * H },
  });
  // The words under the waveform.
  const words: string[] = [];
  project.clips.forEach((clip, index) => {
    if (clip.type !== "text" || clip.start < start || clip.start >= end) return;
    const track = trackOf(project, clip.track);
    if (!((clip.name ?? "").startsWith("Subtitle") || track?.subtitles === true)) return;
    project.clips[index] = clipFrom({
      ...clip,
      name: "Call words",
      style: {
        ...clip.style,
        font: "Montserrat",
        weight: 600,
        size: 54 * k,
        color: [1, 1, 1, 1],
        label: null,
        background: null,
        glow: { enabled: true, color: [0, 0, 0, 1], radius: 30 * k, strength: 0.8 },
        max_width: 0.7 * W,
      },
      transform: { ...clip.transform, x: 0, y: 0.02 * H },
      animation: { preset: "words", duration: 1, stagger: 2 },
    });
    words.push(clip.id);
  });
  return { clips: made, call_words: words };
}

/** The File Viewer's frame at 1080p: its top strip and border (desktop.rs). */
const FILE_STRIP = 22;
const FILE_BORDER = 3;

/** A File Viewer's size on screen (w, h) and its content area, for a picture or footage `media` `width` (share of the frame) wide. */
export function fileViewerSize(project: Project, media: Media, width: number): { w: number; h: number; content: [number, number] } {
  const { width: W, height: H } = project.settings;
  const k = H / 1080;
  const w = Math.round(width * W);
  const cw = w - 2 * FILE_BORDER * k;
  const aspect = Math.min(Math.max(media.width / Math.max(media.height, 1), 0.62), 1.9);
  const ch = cw / aspect;
  return { w, h: Math.round(ch + (FILE_STRIP + FILE_BORDER) * k), content: [cw, ch] };
}

/** The frames file_viewer ops need drawn ([w, h] as drawn). */
export function fileViewerFrames(project: Project, args: Args): [number, number] | null {
  const media = typeof args.media === "string" ? mediaOf(project, args.media) : undefined;
  if (media === undefined) return null;
  const { w, h } = fileViewerSize(project, media, Math.min(Math.max(num(args.width) ?? 0.28, 0.12), 0.6));
  return [Math.round(w * FRAME_SCALE), Math.round(h * FRAME_SCALE)];
}

/**
 * `{"op":"file_viewer","media":"m4","start":F,"end":F,"x":X,"y":Y,"width":0.28,"name":"LARRY SCOTT"}`:
 * the references' floating window over a map or a scene: a photo (or footage
 * from source_in) in a thin dark "File Viewer" frame centred at x, y
 * (project pixels from the centre), `width` a share of the frame, the name
 * in white monospace on its bottom edge; it eases in from a little smaller
 * and drifts slowly upward while it's up, then fades.
 */
export function fileViewer(project: Project, args: Args, frames: Record<string, string>): Record<string, unknown> {
  const [start, end] = span(args, "file_viewer", 30);
  const { width: W, height: H } = project.settings;
  const k = H / 1080;
  const media = typeof args.media === "string" ? mediaOf(project, args.media) : undefined;
  if (media === undefined || media.kind === "audio") throw new Error("file_viewer needs media: a picture or footage");
  const width = Math.min(Math.max(num(args.width) ?? 0.28, 0.12), 0.6);
  const { w, h, content } = fileViewerSize(project, media, width);
  const drawn = [Math.round(w * FRAME_SCALE), Math.round(h * FRAME_SCALE)] as const;
  const frameMedia = mediaOf(project, frames[frameKey("file_viewer", drawn[0], drawn[1])] ?? "");
  if (frameMedia === undefined) throw new Error("file_viewer's frame wasn't prepared (run it through apply_edit_plan)");
  const cx = num(args.x) ?? 0.18 * W;
  const cy = num(args.y) ?? -0.18 * H;
  const total = end - start;
  const made: string[] = [];
  const add = adder(project, made, "file_viewer");
  const fit = (m: Media) => Math.min(W / Math.max(m.width, 1), H / Math.max(m.height, 1)) * Math.max(m.width, 1);
  // Easing in from 92% over 16 frames, drifting up 1.5% of the height across it.
  const keys = (x: number, y: number, scale: number) => {
    const pop = Math.min(16, total - 1);
    const rise = 0.015 * H;
    return {
      transform: { x: cx + (x - cx) * 0.92, y: cy + (y - cy) * 0.92, scale: scale * 0.92 },
      keyframes: {
        x: [{ frame: 0, value: cx + (x - cx) * 0.92, ease: "out" }, { frame: pop, value: x, ease: "linear" }],
        y: [{ frame: 0, value: cy + (y - cy) * 0.92, ease: "out" }, { frame: pop, value: y, ease: "linear" }, { frame: total - 1, value: y - rise, ease: "linear" }],
        scale: [{ frame: 0, value: scale * 0.92, ease: "out" }, { frame: pop, value: scale, ease: "linear" }],
      },
    };
  };
  const common = { start, duration: total, fade_in: 10, fade_out: 8 };
  add({ type: "video", name: "File Viewer", media: frameMedia.id, source_in: 0, frame: { width: 0, shadow: 0.6 }, ...common, ...keys(cx, cy, w / fit(frameMedia)) });
  // The picture fills the content area (a little cropped at most).
  const [cw, ch] = content;
  const contentY = cy - h / 2 + FILE_STRIP * k + ch / 2;
  const aspect = media.width / Math.max(media.height, 1);
  let crop: Args = {};
  let shownW = cw;
  if (aspect > cw / ch) {
    const side = (1 - cw / ch / aspect) / 2;
    crop = { left: side, right: side };
    shownW = ch * aspect;
  } else {
    const side = (1 - aspect / (cw / ch)) / 2;
    crop = { top: side, bottom: side };
  }
  add({
    type: "video",
    name: `File Viewer · ${media.name}`,
    media: media.id,
    source_in: media.kind === "video" ? Math.max(num(args.source_in) ?? 0, 0) : 0,
    crop,
    ...(media.kind === "image" ? { frame: { width: 0, shadow: 0 } } : {}),
    ...common,
    ...keys(cx, contentY, shownW / fit(media)),
  });
  const name = str(args.name);
  if (name !== null) {
    const size = 24 * k;
    const [bw, bh] = native().textBlock(name.toUpperCase(), size, 600, 1.2);
    const nx = cx + cw / 2 - 14 * k - bw / 2;
    const ny = cy + h / 2 - FILE_BORDER * k - 14 * k - bh / 2;
    add({
      type: "text",
      name: `File Viewer name · ${name}`,
      text: name.toUpperCase(),
      ...common,
      style: { font: "Geist Mono", weight: 600, size, color: [1, 1, 1, 1], align: "left", glow: { enabled: true, color: [0, 0, 0, 1], radius: 14 * k, strength: 0.7 } },
      ...keys(nx, ny, 1),
    });
  }
  markers.addTimeline(project, start, "desktop window opens", "File Viewer");
  return { clips: made, until: clipEnd(project.clips.find((clip) => clip.id === made[0])!) };
}
