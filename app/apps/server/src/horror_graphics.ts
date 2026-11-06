// Horror's on-screen graphics, after its guide ("Horror High Quality -
// Editing Rules & Processes") and the frames of the reference moments it
// links (Styks, Sirius, Nightmare Movies, Nbody, Threadbare), studied frame
// by frame, Nov 5. The commentary plan operations keep their names; in a
// horror project they draw these instead:
//
// - commentary_text: a title (Animations 2, 7, 9, 13): one of the guide's
//   looks, rising in slowly out of a blur as the words land ("Text slide up
//   example, gaussian blur keyframes on the background"), typed (13), or word
//   by word on the voice (9, "a Sirius-like style").
// - commentary_chapter: a chapter title over the picture blurred behind it
//   (Animation 7: "Whenever we switch to a new topic or introduce a new
//   chapter"; Styks' "case 2: / Bye /R9K/").
// - commentary_location: a place name in a soft serif (Sirius' "Fort Myers,
//   Florida"); commentary_label: a name tag in VHS lettering on a black box
//   ("CLIFFORD WALLACH").
// - commentary_profile: a picture on one side, words typed on the other
//   (Animation 10: "perfect for quoting someone or adding short bullet
//   points that describe a person").
// - commentary_icon: an icon with a word under it (Animation 11: a red
//   person over "STALKER", an old phone over "Leaked messages", a folder over
//   "Court documents"), the icons drawn by Edit.
// - commentary_lens: After Effects' CC Lens, "from time to time".
//
// All of it is ordinary clips, so the preview and the export draw it alike.

import * as fs from "node:fs";

import { clipFrom } from "./clips.ts";
import { card, textStyle, widthOf } from "./commentary_graphics.ts";
import { rgbaPng } from "./evidence_highlight.ts";
import type { Project } from "./model.ts";
import { native } from "./native/index.ts";
import { join } from "./paths.ts";
import { addTrack, freshId, mediaOf } from "./project.ts";

type Args = Record<string, unknown>;
const number = (a: Args, key: string, fallback: number) => (typeof a[key] === "number" && Number.isFinite(a[key]) ? (a[key] as number) : fallback);
const key = (frame: number, value: number, ease = "linear") => ({ frame, value, ease });
/** The guide's speed curve (Animation 3): a sharp spike of speed, then a long tail. */
const arrival = (from: number, to: number, frames: number) => [
  { ...key(0, from), handle_out: { speed: 0, influence: 0.12 } },
  { ...key(frames, to), handle_in: { speed: 0, influence: 0.82 } },
];
function push(p: Project, fields: Args): string {
  const id = freshId(p, "c");
  p.clips.push(clipFrom({ id, track: addTrack(p, "video"), ...fields }));
  return id;
}
function span(a: Args, what: string): [number, number] {
  if (typeof a.start !== "number" || !Number.isInteger(a.start) || a.start < 0 || typeof a.end !== "number" || !Number.isInteger(a.end) || a.end - a.start < 12) {
    throw new Error(`${what} needs start/end in frames, at least 12 frames apart`);
  }
  return [a.start, a.end];
}

const WHITE = [1, 1, 1, 1];
/** Sirius' quote yellow ("he's fine; he's having fun"). */
const YELLOW = [1, 0.93, 0.12, 1];

/**
 * The guide's text looks, each from its reference frame (1080p sizes):
 * bold, condensed caps with a heavy shadow (Styks, Nightmare Movies:
 * "SOME STILL DO…", "BANNED FROM BROADCAST"); sans, a bold Arial with a
 * drop shadow (Sirius' dates, "April, 2006"); serif, a soft Times (Sirius'
 * places); vhs, an old camcorder's lettering on a black box (Sirius' name
 * tags); caption, small plain Arial (Sirius' words on the voice); quote,
 * yellow Arial (Sirius' quotes).
 */
export const LOOKS = ["bold", "sans", "serif", "vhs", "caption", "quote"] as const;
export type Look = (typeof LOOKS)[number];

function look(name: Look, h: number, size: number | null): Args {
  const k = h / 1080;
  const shadow = (opacity: number, distance: number, blur: number) => ({ color: [0, 0, 0, 1], opacity, distance: distance * k, angle: 135, size: 1.5 * k, blur: blur * k });
  switch (name) {
    case "bold":
      return { ...textStyle(h, size ?? 124), line_height: 1.05 };
    case "sans":
      return { font: "Arimo", weight: 700, size: (size ?? 76) * k, color: WHITE, tracking: 0, line_height: 1.1, glow: { enabled: true, radius: 8 * k, strength: 0.22 }, shadow: shadow(0.9, 4, 6), max_width: 1600 * k };
    case "serif":
      return { font: "Tinos", weight: 400, size: (size ?? 66) * k, color: WHITE, tracking: 0, line_height: 1.1, glow: { enabled: true, radius: 10 * k, strength: 0.35 }, shadow: shadow(0.65, 2, 6), max_width: 1600 * k };
    case "vhs":
      return { font: "VT323", weight: 400, size: (size ?? 84) * k, color: WHITE, tracking: 5 * k, line_height: 0.9, align: "left", glow: { enabled: true, radius: 4 * k, strength: 0.2 },
        background: { color: [0, 0, 0, 1], opacity: 1, pad_x: 16 * k, pad_y: 6 * k } };
    case "caption":
      return { font: "Arimo", weight: 400, size: (size ?? 44) * k, color: WHITE, tracking: 0, line_height: 1.15, glow: { enabled: false }, shadow: shadow(0.85, 2, 3), max_width: 1500 * k };
    case "quote":
      return { font: "Arimo", weight: 400, size: (size ?? 58) * k, color: YELLOW, tracking: 0, line_height: 1.15, glow: { enabled: false }, shadow: shadow(0.9, 3, 4), max_width: 900 * k };
  }
}

const lookOf = (value: unknown, fallback: Look): Look => (LOOKS as readonly string[]).includes(String(value)) ? (value as Look) : fallback;

/** A block's size as the renderer lays it out (one line per newline, wrapped at max_width). */
function blockSize(text: string, style: Args): [number, number] {
  const size = style.size as number; const font = style.font as string; const weight = style.weight as number;
  const max = typeof style.max_width === "number" ? style.max_width : Infinity;
  const lines = text.split("\n").flatMap((line) => (Number.isFinite(max) ? native().textLines(line, font, weight, size, (style.tracking as number) ?? 0, max) : [line]));
  const width = Math.max(...lines.map((line) => widthOf(line, font, weight, size) + Math.max(0, line.length - 1) * ((style.tracking as number) ?? 0)));
  return [width, lines.length * size * ((style.line_height as number) ?? 1.2)];
}

/** The picture behind a title, blurred and darkened as it comes in and clearing as it goes (Animation 2's "gaussian blur keyframes on the background"). */
function backdropBlur(p: Project, start: number, d: number): string {
  const k = p.settings.height / 1080;
  return push(p, { type: "adjustment", name: "Horror · title backdrop", start, duration: d, blur: { radius: 22 * k }, grade: { exposure: -0.4, vignette: 0.25 },
    fade_in: Math.min(10, Math.floor(d / 4)), fade_out: Math.min(12, Math.floor(d / 4)) });
}

/** The words' own blur on the move: a region carried with them, clearing as they land and coming back as they leave. */
function motionBlur(p: Project, parent: string, start: number, d: number, x: number, y: number, w: number, h: number, settle: number): string {
  const k = p.settings.height / 1080; const out = Math.min(9, Math.floor(d / 4));
  return push(p, { type: "adjustment", name: "Horror · title motion blur", start, duration: d, parent,
    blur: { radius: 0, x, y, width: w + 60 * k, height: h + 60 * k, shape: "rect", feather: 18 * k },
    keyframes: { blur: [{ ...key(0, 14 * k), handle_out: { speed: 0, influence: 0.2 } }, { ...key(settle, 0), handle_in: { speed: 0, influence: 0.7 } }, key(d - 1 - out, 0), key(d - 1, 10 * k)] } });
}

/**
 * A title in one of the guide's looks. `motion`: rise (default: up out of a
 * blur on the guide's curve), type (Animation 13, typed), words (Animation
 * 9: each word at its frame in `words_at`, on the voice). `at`: center,
 * top, bottom (a date) or lower_left (a name tag); or x/y. `background_blur`
 * blurs and darkens the picture behind it (default: a centred bold title).
 * `sub`: a small line above (Styks' "case 2:"). `color: "red"` for a word
 * the story turns on ("STALKER HELL").
 */
export function title(p: Project, a: Args, fallback: Look = "bold"): Args {
  const [start, end] = span(a, "a horror title"); const d = end - start;
  const w = p.settings.width; const h = p.settings.height; const k = h / 1080;
  if (typeof a.text !== "string" || a.text.trim() === "") throw new Error("a horror title needs text");
  const kind = lookOf(a.look, fallback);
  // White: the team (Nov 6), of red titles over footage, "Text should be white, looks cleaner".
  const style: Args = { ...look(kind, h, typeof a.size === "number" ? a.size : null), ...(a.color === "yellow" ? { color: YELLOW } : {}) };
  // As written: Styks keeps "Bye /R9K/", Nightmare Movies writes "BANNED FROM BROADCAST"; a name tag is always capitals.
  const words = kind === "vhs" ? a.text.trim().toUpperCase() : a.text.trim();
  const [bw, bh] = blockSize(words, style);
  const where = typeof a.at === "string" ? a.at : kind === "vhs" ? "lower_left" : "center";
  let x = number(a, "x", 0); let y = number(a, "y", 0);
  if (a.x === undefined && where === "lower_left") x = -w / 2 + 70 * k + bw / 2;
  if (a.y === undefined) y = where === "bottom" ? h / 2 - 150 * k - bh / 2 : where === "top" ? -h / 2 + 140 * k + bh / 2 : where === "lower_left" ? h / 2 - 120 * k - bh / 2 : 0;
  const motion = ["rise", "type", "words"].includes(String(a.motion)) ? String(a.motion) : kind === "quote" || kind === "vhs" ? "type" : "rise";
  const made: string[] = [];
  const blurBehind = typeof a.background_blur === "boolean" ? a.background_blur : kind === "bold" && where === "center";
  if (blurBehind) made.push(backdropBlur(p, start, d));
  // Over a blurring picture the words come once it has gone soft.
  const from = blurBehind ? Math.min(start + 6, end - 12) : start; const dd = end - from;
  const settle = Math.min(18, Math.floor(dd / 3));
  let animation: Args | undefined; let wordTimes: number[] | undefined;
  if (motion === "type") animation = { preset: "typewriter", duration: 4, stagger: number(a, "stagger", 1.2) };
  if (motion === "words") {
    const at = Array.isArray(a.words_at) ? a.words_at.filter((f): f is number => typeof f === "number") : [];
    const count = words.split(/\s+/u).filter(Boolean).length;
    if (at.length !== count || at.some((f, i) => f < from || f >= end || (i > 0 && f < at[i - 1]!))) throw new Error(`motion "words" needs words_at: one timeline frame per word (${count}), in order, inside the title's frames (the voice's word times from get_edit_context)`);
    return phrases(p, words, at, end, kind, typeof a.size === "number" ? a.size : null, x, y, made);
  }
  const rise = motion === "rise";
  const id = push(p, { type: "text", name: `Horror · ${kind} title`, text: words, start: from, duration: dd, fade_in: rise ? 8 : 0, fade_out: Math.min(9, Math.floor(dd / 4)),
    style, transform: { x, y }, ...(animation ? { animation } : {}), ...(wordTimes ? { word_times: wordTimes } : {}),
    ...(rise ? { keyframes: { y: [...arrival(y + 46 * k, y, settle), key(dd - 1, y - 6 * k)] } } : {}) });
  made.push(id);
  if (rise) made.push(motionBlur(p, id, from, dd, x, y, bw, bh, settle));
  if (typeof a.sub === "string" && a.sub.trim()) {
    const subStyle = { ...style, size: (style.size as number) * 0.5, glow: { enabled: true, radius: 6 * k, strength: 0.2 } };
    made.push(push(p, { type: "text", name: `Horror · ${kind} title line`, text: a.sub.trim(), start: from, duration: dd, fade_in: 8, fade_out: Math.min(9, Math.floor(dd / 4)),
      style: subStyle, transform: { x, y: y - bh / 2 - (subStyle.size as number) * 0.35 },
      keyframes: { y: [...arrival(y - bh / 2 - (subStyle.size as number) * 0.35 + 46 * k, y - bh / 2 - (subStyle.size as number) * 0.35, settle)] } }));
  }
  return { text: id, clips: made, look: kind };
}

/**
 * Words on the voice (Animation 9), as Sirius does them: the line in short
 * phrases ("go to the back of car", "open the door", "lift out 5 year old
 * son"), each typed on alone at its first word and replacing the last, so
 * each can be big (the team, Nov 6: "the words should appear like this, one
 * after another instead of all of them. It allows us to make each word
 * bigger"). A phrase is up to four words, broken after punctuation first.
 */
function phrases(p: Project, words: string, at: number[], end: number, kind: Look, size: number | null, x: number, y: number, made: string[]): Args {
  const h = p.settings.height;
  const list = words.split(/\s+/u).filter(Boolean);
  const groups: number[][] = [];
  let current: number[] = [];
  list.forEach((word, i) => {
    current.push(i);
    const pause = i + 1 < list.length ? at[i + 1]! - at[i]! : 0;
    if (current.length >= 4 || /[,.;:!?"”]$/u.test(word) || pause > 18) { groups.push(current); current = []; }
  });
  if (current.length > 0) groups.push(current);
  const style = { ...look(kind, h, size ?? (kind === "caption" ? 72 : null)) };
  const ids: string[] = [];
  groups.forEach((group, n) => {
    const start = at[group[0]!]!;
    const until = n + 1 < groups.length ? at[groups[n + 1]![0]!]! : end;
    if (until - start < 2) return;
    const text = group.map((i) => list[i]).join(" ");
    const id = push(p, { type: "text", name: `Horror · ${kind} title`, text, start, duration: until - start, fade_out: n + 1 === groups.length ? Math.min(6, Math.floor((until - start) / 3)) : 0,
      style, transform: { x, y }, animation: { preset: "typewriter", duration: 2, stagger: 0.7 } });
    ids.push(id);
  });
  made.push(...ids);
  return { text: ids[0] ?? null, clips: made, look: kind, phrases: groups.length };
}

/** A chapter title (Animation 7): bold over the picture blurred behind it, a small line above when given. */
export function chapter(p: Project, a: Args): Args {
  const sub = typeof a.sub === "string" ? a.sub : typeof a.number === "string" || typeof a.number === "number" ? `case ${String(a.number)}:` : undefined;
  return title(p, { ...a, look: a.look ?? "bold", at: "center", background_blur: a.background_blur ?? true, sub }, "bold");
}

/** A place name (Sirius' "Fort Myers, Florida"): the soft serif, centred, no blur behind. */
export function location(p: Project, a: Args): Args {
  return title(p, { ...a, look: a.look ?? "serif", background_blur: a.background_blur ?? false }, "serif");
}

/** A name tag (Sirius' "CLIFFORD WALLACH"): VHS lettering on a black box, lower left, typed. */
export function label(p: Project, a: Args): Args {
  return title(p, { ...a, look: a.look ?? "vhs", at: a.at ?? "lower_left", background_blur: false }, "vhs");
}

/**
 * Animation 10: a picture on one side in its white outline, sliding up, and
 * on the other the words typed: a quote (yellow, in quotation marks) or up to
 * five short lines about the person, each at its frame on the voice.
 */
export function profile(p: Project, a: Args): Args {
  const [start, end] = span(a, "commentary_profile"); const d = end - start;
  const w = p.settings.width; const h = p.settings.height;
  if (typeof a.media !== "string") throw new Error("commentary_profile needs media: the person's picture");
  const right = a.side === "right";
  const shown = card(p, { media: a.media, start, end, photo: true, x: (right ? 1 : -1) * w * 0.245, y: 0, width: 0.4, height: 0.82, backdrop: a.backdrop ?? false });
  const made = [...(shown.clips as string[])];
  const textX = (right ? -1 : 1) * w * 0.2;
  if (typeof a.quote === "string" && a.quote.trim()) {
    const quoted = /^["“]/u.test(a.quote.trim()) ? a.quote.trim() : `"${a.quote.trim()}"`;
    const said = title(p, { text: quoted, start: Math.min(start + 14, end - 12), end, look: "quote", motion: "type", x: textX, y: 0, background_blur: false }, "quote");
    made.push(...(said.clips as string[]));
    return { portrait: shown.photo, clips: made };
  }
  if (!Array.isArray(a.lines) || a.lines.length < 1 || a.lines.length > 5) throw new Error("commentary_profile needs quote, or 1–5 lines ([{text, at}] at absolute frames, or plain strings)");
  const lines = a.lines.map((v, i) => {
    const line = (typeof v === "string" ? { text: v } : v) as Args;
    if (typeof line.text !== "string" || line.text.trim() === "") throw new Error("each profile line needs text");
    const at = typeof line.at === "number" ? Math.round(line.at) : start + 14 + i * 30;
    if (at < start || at >= end) throw new Error("each profile line's at must sit inside the graphic's frames");
    return { text: `- ${line.text.trim()}`, at };
  });
  const style = { ...look("caption", h, number(a, "size", 50)), align: "left", line_height: 1.35, max_width: w * 0.42 };
  const block = lines.map((l) => l.text).join("\n");
  const times = lines.flatMap((line) => line.text.split(/\s+/u).filter(Boolean).map((_, i) => Math.min(d - 1, line.at - start + i * 2)));
  made.push(push(p, { type: "text", name: "Horror · profile lines", text: block, start, duration: d, fade_out: 8, style, transform: { x: textX, y: 0 },
    animation: { preset: "words", duration: 1, stagger: 1 }, word_times: times }));
  return { portrait: shown.photo, clips: made };
}

// --- Animation 11's icons, drawn by Edit -----------------------------------

export const ICONS = ["person", "phone", "folder", "document", "camera"] as const;
export type Icon = (typeof ICONS)[number];

const smooth = (edge0: number, edge1: number, v: number) => { const t = Math.min(1, Math.max(0, (v - edge0) / (edge1 - edge0))); return t * t * (3 - 2 * t); };
/** Signed distance to a rounded box centred at (cx, cy), half size (hx, hy), corner r. */
function box(x: number, y: number, cx: number, cy: number, hx: number, hy: number, r: number): number {
  const qx = Math.abs(x - cx) - hx + r; const qy = Math.abs(y - cy) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

type Part = { d: (x: number, y: number) => number; fill: [number, number, number] };

/** Each icon as filled parts (unit square, y down), drawn in order with a dark, slightly rough outline round the whole. */
function partsOf(icon: Icon, color: [number, number, number]): Part[] {
  switch (icon) {
    case "person":
      return [
        { d: (x, y) => Math.hypot(x - 0.5, y - 0.3) - 0.165, fill: color },
        { d: (x, y) => box(x, y, 0.5, 0.775, 0.3, 0.2, 0.19), fill: color },
      ];
    case "phone":
      return [
        { d: (x, y) => box(x, y, 0.5, 0.52, 0.2, 0.42, 0.06), fill: [0.2, 0.22, 0.25] },
        { d: (x, y) => box(x, y, 0.5, 0.31, 0.14, 0.12, 0.015), fill: [0.62, 0.78, 0.55] },
        ...[0, 1, 2].flatMap((row) => [0, 1, 2].map((col): Part => ({ d: (x, y) => box(x, y, 0.4 + col * 0.1, 0.56 + row * 0.1, 0.038, 0.03, 0.012), fill: [0.82, 0.83, 0.85] }))),
        { d: (x, y) => box(x, y, 0.42, 0.08, 0.025, 0.06, 0.02), fill: [0.2, 0.22, 0.25] },
      ];
    case "folder":
      return [
        { d: (x, y) => Math.min(box(x, y, 0.5, 0.56, 0.42, 0.28, 0.04), box(x, y, 0.27, 0.27, 0.18, 0.06, 0.03)), fill: [0.86, 0.66, 0.2] },
        { d: (x, y) => box(x, y, 0.52, 0.62, 0.42, 0.23, 0.04), fill: [0.99, 0.84, 0.38] },
      ];
    case "document":
      return [
        { d: (x, y) => box(x, y, 0.5, 0.5, 0.3, 0.4, 0.03), fill: [0.97, 0.97, 0.95] },
        ...[0, 1, 2, 3, 4].map((row): Part => ({ d: (x, y) => box(x, y, 0.5, 0.3 + row * 0.1, 0.2, 0.014, 0.01), fill: [0.45, 0.47, 0.52] })),
      ];
    case "camera":
      return [
        { d: (x, y) => Math.min(box(x, y, 0.5, 0.57, 0.4, 0.25, 0.06), box(x, y, 0.5, 0.3, 0.14, 0.06, 0.03)), fill: [0.18, 0.19, 0.21] },
        { d: (x, y) => Math.hypot(x - 0.5, y - 0.57) - 0.16, fill: [0.55, 0.6, 0.68] },
        { d: (x, y) => Math.hypot(x - 0.5, y - 0.57) - 0.09, fill: [0.12, 0.14, 0.2] },
      ];
  }
}

/** An icon as a PNG `size` px square: its parts with soft edges and a rough dark outline. */
export function iconPng(icon: Icon, color: [number, number, number] = [0.86, 0, 0], size = 512): Uint8Array {
  const parts = partsOf(icon, color);
  const px = 1 / size; const outline = 0.034;
  return rgbaPng(size, size, (ix, iy) => {
    const x = (ix + 0.5) * px; const y = (iy + 0.5) * px;
    // A hand-drawn wobble on the outline.
    const wobble = 0.004 * Math.sin(x * 61 + y * 23) + 0.003 * Math.sin(y * 97 - x * 41);
    let union = Infinity; let fill: [number, number, number] | null = null; let cover = 0;
    for (const part of parts) {
      const d = part.d(x, y); union = Math.min(union, d);
      const c = 1 - smooth(-px, px, d);
      if (c > 0) { fill = fill === null ? part.fill : fill.map((v, i) => v + (part.fill[i]! - v) * c) as [number, number, number]; cover = Math.max(cover, c); }
    }
    const ring = 1 - smooth(outline + wobble - px, outline + wobble + px, union);
    if (ring <= 0) return null;
    const ink: [number, number, number] = [0.05, 0.04, 0.04];
    const rgb = fill === null ? ink : ink.map((v, i) => v + (fill![i]! - v) * cover * (1 - smooth(-outline * 0.35, 0, union))) as [number, number, number];
    return [rgb[0] * 255, rgb[1] * 255, rgb[2] * 255, ring * 255];
  });
}

const COLORS: Record<string, [number, number, number]> = { red: [0.86, 0, 0], white: [0.95, 0.95, 0.95], yellow: [0.98, 0.82, 0.2], blue: [0.18, 0.42, 0.85], green: [0.2, 0.65, 0.3], grey: [0.55, 0.56, 0.58] };

/** The icon a commentary_icon op asks for by name, drawn once into `<home>/graphics/horror/`: its path, else null. */
export function iconFile(home: string, op: Args): string | null {
  if (typeof op.icon !== "string" || !(ICONS as readonly string[]).includes(op.icon)) return null;
  const colour = typeof op.color === "string" && COLORS[op.color] !== undefined ? op.color : "red";
  const dir = join(home, "graphics", "horror"); fs.mkdirSync(dir, { recursive: true });
  const path = join(dir, `icon-${op.icon}-${colour}-v1.png`);
  if (!fs.existsSync(path)) fs.writeFileSync(path, iconPng(op.icon as Icon, COLORS[colour]));
  return path;
}

/** Animation 11: the icon popping up on the guide's curve, the word under it (Sirius' "STALKER"). */
export function icon(p: Project, a: Args): Args {
  const [start, end] = span(a, "commentary_icon"); const d = end - start;
  const w = p.settings.width; const h = p.settings.height; const k = h / 1080;
  const m = typeof a.media === "string" ? mediaOf(p, a.media) : undefined;
  if (m === undefined || m.kind !== "image") throw new Error(`commentary_icon needs icon (${ICONS.join(", ")}; color red, white, yellow, blue, green or grey) or media: a picture`);
  const made: string[] = [];
  if (a.blur === true) made.push(backdropBlur(p, start, d));
  const size = number(a, "size", 330) * k; const fit = Math.min(w / Math.max(m.width, 1), h / Math.max(m.height, 1));
  const scale = size / (Math.max(m.width, m.height) * fit);
  const label = typeof a.name === "string" && a.name.trim() ? a.name.trim().toUpperCase() : null;
  const x = number(a, "x", 0); const y = number(a, "y", label ? -60 * k : 0);
  const settle = Math.min(14, Math.floor(d / 3));
  made.push(push(p, { type: "video", media: m.id, source_in: 0, start, duration: d, name: "Horror · icon", fade_in: 3, fade_out: 7,
    transform: { x, y, scale },
    keyframes: { scale: [...arrival(scale * 0.3, scale, settle), key(d - 1, scale * 1.03)] } }));
  if (label) {
    const style = { font: "Arimo", weight: 700, size: number(a, "label_size", 68) * k, color: WHITE, tracking: 1 * k, line_height: 1.1, glow: { enabled: false },
      shadow: { color: [0, 0, 0, 1], opacity: 0.95, distance: 3 * k, angle: 135, size: 3 * k, blur: 4 * k } };
    made.push(push(p, { type: "text", name: "Horror · icon word", text: label, start: start + 5, duration: d - 5, fade_in: 6, fade_out: 7, style,
      transform: { x, y: y + size / 2 + 70 * k } }));
  }
  return { clips: made };
}

/**
 * After Effects' CC Lens over a stretch (the guide: "From time to time, we
 * want to use a CC Lens effect"): the picture bulging toward the viewer as
 * through a sphere, swelling in and easing back out. `strength` 0.2–1.
 */
export function lens(p: Project, a: Args): Args {
  const [start, end] = span(a, "commentary_lens"); const d = end - start;
  const strength = Math.min(Math.max(number(a, "strength", 0.6), 0.1), 1);
  const ramp = Math.min(Math.max(number(a, "frames", 14), 4), Math.floor(d / 2));
  const id = push(p, { type: "adjustment", name: "Horror · CC Lens", start, duration: d, grade: { lens: 0 },
    keyframes: { lens: [{ ...key(0, 0), handle_out: { speed: 0, influence: 0.3 } }, { ...key(ramp, strength), handle_in: { speed: 0, influence: 0.6 } }, key(d - 1 - ramp, strength), { ...key(d - 1, 0), handle_in: { speed: 0, influence: 0.5 } }] } });
  return { clip: id, clips: [id] };
}

/** Whether a clip is one of these graphics (the audit's "own graphic" test). */
export function isHorrorGraphic(name: string | undefined): boolean {
  return (name ?? "").startsWith("Horror · ");
}

