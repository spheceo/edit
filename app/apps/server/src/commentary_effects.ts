// The Internet Janitor effects the team asked for by name on N3on's v1 (M,
// Oct 26), each built as the reference shows it:
// - commentary_arrow: a red arrow drawn in toward a person with their name at
//   its tail ("an red arrow with text towards Adin, which says 'Adin Ross'"),
//   following them as the camera moves ("the arrow and text tracks them").
// - commentary_web: the spider web of the people behind someone ("N3on in the
//   middle with a name tag under him… some of them blurred with their name tag
//   blurred as well so it looks kind of intriguing"), as in the reference M
//   linked (Dr Insanity's, youtu.be/ppBajdOW9DU?t=69), measured frame by
//   frame: one camera pulling back from the footage into the middle picture
//   to reveal the whole board, then glowing red strings growing out in waves.
// - commentary_reverb_out: a source clip's last words warping out in reverb
//   while the picture fades to black, a pause, then the narration ("This makes
//   it seem a bit more disturbing").
// Drawn pieces (arrows, lines, the web's ground) are PNGs made here, imported,
// then laid out in one store update; their motion is ordinary keyframes.

import * as fs from "node:fs";
import type { App } from "./app.ts";
import { clipFrom } from "./clips.ts";
import * as commentaryGraphics from "./commentary_graphics.ts";
import { rgbaPng } from "./evidence_highlight.ts";
import { importPaths } from "./import.ts";
import { handlerFor, registerTool, text } from "./mcp/registry.ts";
import type { Keyframe, Project } from "./model.ts";
import { addTrack, clipEnd, freshId, insertTime, mediaOf } from "./project.ts";
import { join } from "./paths.ts";
import { stableStringify } from "./stable.ts";
import * as tools from "./tools.ts";

type Args = Record<string, unknown>;
type Point = [number, number];
const RED: [number, number, number] = [235, 28, 28];
const key = (frame: number, value: number, ease = "linear"): Keyframe => ({ frame, value, ease } as Keyframe);
/** The guide's ease: fast, then a long settle. */
const arrival = (from: number, to: number, frames: number): Keyframe[] => [
  { ...key(0, from), handle_out: { speed: 0, influence: 0.12 } } as Keyframe,
  { ...key(frames, to), handle_in: { speed: 0, influence: 0.82 } } as Keyframe,
];

function push(p: Project, fields: Args): string {
  const id = freshId(p, "c");
  p.clips.push(clipFrom({ id, track: addTrack(p, "video"), ...fields }));
  return id;
}

/** Distance from point to segment. */
function toSegment(x: number, y: number, a: Point, b: Point): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}
function inTriangle(x: number, y: number, a: Point, b: Point, c: Point): boolean {
  const s = (p: Point, q: Point) => (x - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (y - q[1]);
  const [d1, d2, d3] = [s(a, b), s(b, c), s(c, a)];
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** Writes `bytes` under the project's graphics folder (named by content) and imports it once. */
async function imported(app: App, projectId: string, name: string, bytes: Uint8Array): Promise<string> {
  const dir = join(app.store.home, "graphics", "commentary"); fs.mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}-${Bun.hash(bytes).toString(16).slice(0, 12)}.png`);
  if (!fs.existsSync(path)) fs.writeFileSync(path, bytes);
  const [, ids, errors] = await importPaths(app, projectId, [path], false, "agent");
  if (ids[0] === undefined) throw new Error(errors.join("; "));
  return ids[0];
}

// ---------------------------------------------------------------------------
// The arrow.

export interface ArrowLayout { width: number; height: number; head: Point; tail: Point; centre: Point; text: Point; dir: Point }
/**
 * An arrow ending at `at` (project px from the frame's centre), coming from
 * the side its words sit on, `length` long; the PNG is the arrow's own box,
 * its centre `centre` on the frame.
 */
export function arrowLayout(p: Project, a: Args): ArrowLayout {
  const k = p.settings.height / 1080;
  if (!Array.isArray(a.at) || a.at.length !== 2 || !a.at.every((v) => typeof v === "number")) throw new Error("commentary_arrow needs at: [x, y], the person's point (project px from the centre), or track");
  const at = a.at as Point;
  const side = ["left", "right", "above", "below"].includes(String(a.side)) ? String(a.side) : at[0] > 0 ? "left" : "right";
  // The arrow slants a little, as a hand would draw it: mostly across, a quarter up or down.
  const dirs: Record<string, Point> = { left: [0.95, 0.31], right: [-0.95, 0.31], above: [0.31, 0.95], below: [0.31, -0.95] };
  const raw = dirs[side]!; const n = Math.hypot(raw[0], raw[1]); const dir: Point = [raw[0] / n, raw[1] / n];
  const length = (typeof a.length === "number" ? a.length : 230) * k;
  const tail: Point = [at[0] - dir[0] * length, at[1] - dir[1] * length];
  const pad = 40 * k;
  const x0 = Math.min(tail[0], at[0]) - pad; const y0 = Math.min(tail[1], at[1]) - pad;
  const width = Math.ceil(Math.abs(at[0] - tail[0]) + 2 * pad); const height = Math.ceil(Math.abs(at[1] - tail[1]) + 2 * pad);
  const centre: Point = [x0 + width / 2, y0 + height / 2];
  const size = typeof a.size === "number" ? a.size : 64;
  const words = typeof a.text === "string" ? a.text : "";
  const wide = commentaryGraphics.widthOf(words.toUpperCase(), "Akwe Pro", 700, size * k);
  // The words beyond the tail, along the arrow's main direction.
  const across = Math.abs(dir[0]) >= Math.abs(dir[1]);
  const gap = 18 * k;
  const textAt: Point = across ? [tail[0] - Math.sign(dir[0]) * (wide / 2 + gap), tail[1]] : [tail[0], tail[1] - Math.sign(dir[1]) * (size * k * 0.6 + gap)];
  return { width, height, head: [at[0] - x0, at[1] - y0], tail: [tail[0] - x0, tail[1] - y0], centre, text: textAt, dir };
}
export function arrowPng(layout: ArrowLayout, k: number): Uint8Array {
  const { head, tail, dir } = layout;
  const headLength = 46 * k; const headWidth = 30 * k; const thick = 7 * k; const edge = 2.5 * k;
  const neck: Point = [head[0] - dir[0] * headLength * 0.85, head[1] - dir[1] * headLength * 0.85];
  const perp: Point = [-dir[1], dir[0]];
  const tri: [Point, Point, Point] = [head, [head[0] - dir[0] * headLength + perp[0] * headWidth, head[1] - dir[1] * headLength + perp[1] * headWidth], [head[0] - dir[0] * headLength - perp[0] * headWidth, head[1] - dir[1] * headLength - perp[1] * headWidth]];
  // 3×3 samples a pixel: red inside, a thin dark edge around it, so it reads over any picture.
  return rgbaPng(layout.width, layout.height, (x, y) => {
    let core = 0; let rim = 0;
    for (const sx of [0.17, 0.5, 0.83]) for (const sy of [0.17, 0.5, 0.83]) {
      const [px, py] = [x + sx, y + sy];
      const d = toSegment(px, py, tail, neck);
      if (d <= thick || inTriangle(px, py, ...tri)) core++;
      else if (d <= thick + edge) rim++;
    }
    if (core + rim === 0) return null;
    const a = (core + rim) / 9; const red = core / (core + rim);
    return [Math.round(RED[0] * red), Math.round(RED[1] * red), Math.round(RED[2] * red), a * 255];
  });
}

registerTool("commentary_arrow", async ({ app, args, projectId }) => {
  const p = app.store.get(projectId)?.project; if (!p) throw new Error("no such project");
  const k = p.settings.height / 1080; const { width: W, height: H, fps } = p.settings;
  // A tracked arrow points at the box's centre at `track.time`.
  const track = args.track as { time?: unknown; box?: unknown; boxes?: unknown } | undefined;
  const given = { ...args };
  if (track && Array.isArray(track.box) && track.box.length === 4) {
    const b = track.box as number[];
    given.at = [(b[0]! + b[2]!) / 2 - W / 2, (b[1]! + b[3]!) / 2 - H / 2];
  }
  const L = arrowLayout(p, given);
  const ink = await imported(app, projectId, "arrow", arrowPng(L, k));
  const [start, end] = [args.start, args.end];
  if (typeof start !== "number" || typeof end !== "number" || end - start < 12) throw new Error("start/end are timeline frames, at least 12 apart");
  const draw = 8;
  const [, made] = await app.store.update(projectId, "agent", (project) => {
    const d = end - start; const out: string[] = [];
    // The words pop up first, then the arrow draws from them to the person.
    const words = typeof args.text === "string" && args.text.trim() ? args.text.trim().toUpperCase() : null;
    if (words) out.push(push(project, { type: "text", name: "Janitor · arrow text", text: words, start, duration: d, fade_in: 4, fade_out: 6,
      style: commentaryGraphics.textStyle(H, typeof args.size === "number" ? args.size : 64), transform: { x: L.text[0], y: L.text[1] }, keyframes: { scale: arrival(0.6, 1, 10) } }));
    // Drawn in by uncovering it from the tail's side toward the head.
    const m = mediaOf(project, ink)!;
    const fit = Math.min(W / m.width, H / m.height);
    const across = Math.abs(L.dir[0]) >= Math.abs(L.dir[1]);
    const side = across ? (L.dir[0] > 0 ? "crop.right" : "crop.left") : (L.dir[1] > 0 ? "crop.bottom" : "crop.top");
    out.push(push(project, { type: "video", name: "Janitor · arrow", media: ink, source_in: 0, start: start + 3, duration: d - 3, fade_out: 6,
      transform: { x: L.centre[0], y: L.centre[1], scale: 1 / fit }, crop: { left: 0, right: 0, top: 0, bottom: 0 },
      keyframes: { [side]: [{ ...key(0, 0.999), handle_out: { speed: 0, influence: 0.12 } } as Keyframe, { ...key(draw, 0), handle_in: { speed: 0, influence: 0.82 } } as Keyframe] } }));
    void fps;
    return out;
  });
  // Following the person: each layer keeps its place relative to the arrow's point.
  const followed: unknown[] = [];
  if (track && Array.isArray(track.box)) {
    const handler = handlerFor("track_region"); if (handler === undefined) throw new Error("track_region isn't available");
    const at = given.at as Point;
    const live = app.store.get(projectId)!.project;
    for (const id of made) {
      const c = live.clips.find((one) => one.id === id)!;
      const offset = [c.type === "text" || c.type === "video" ? c.transform.x - at[0] : 0, c.type === "text" || c.type === "video" ? c.transform.y - at[1] : 0];
      const answer = await handler.handler({ app, projectId, args: { follow: id, time: track.time, box: track.box, ...(Array.isArray(track.boxes) ? { boxes: track.boxes } : {}), place: "on", offset } } as never);
      followed.push({ clip: id, tracked: (answer[0] as { text?: string } | undefined)?.text?.slice(0, 300) });
    }
  }
  return text(stableStringify({ clips: made, ...(followed.length ? { followed } : {}), note: "Red arrow drawn from the words to the person. Check a frame that the head sits on them and the words read." }));
});

// ---------------------------------------------------------------------------
// The web, measured frame by frame off M's reference (Dr Insanity's, 25 fps,
// 1:12–1:20; docs/feedback/2026-10-26-n3on-v1.md, "The web, frame by frame"):
// one camera pulls back from the footage, which becomes the small middle
// picture, and the whole board is revealed at once, the other pictures flying
// in from the edges with the move. A beat after it settles, glowing red
// strings grow out of the middle to the inner ring together, then from there
// on out and round the outer ring. Black with a faint red haze in the middle,
// dust drifting over it. M's own asks on top: a name tag under each, some
// kept a blurred mystery, tag and all.

interface WebNode { media: string; source_in?: number; name?: string; blur?: boolean; at?: number; ring?: number; slot?: string }
interface Box { x: number; y: number; w: number; h: number }
/** Each picture's place on the reference's settled frame (1080p px from the middle). */
const SLOTS: Record<string, Box> = {
  centre: { x: 0, y: 0, w: 160, h: 148 },
  top: { x: 0, y: -258, w: 274, h: 151 }, bottom: { x: 0, y: 256, w: 272, h: 152 },
  ul: { x: -335, y: -166, w: 227, h: 127 }, ur: { x: 334, y: -166, w: 227, h: 127 },
  ll: { x: -335, y: 164, w: 227, h: 127 }, lr: { x: 334, y: 164, w: 227, h: 127 },
  tl: { x: -608, y: -375, w: 262, h: 147 }, tr: { x: 607, y: -375, w: 262, h: 147 },
  ml: { x: -682, y: 0, w: 286, h: 161 }, mr: { x: 680, y: 0, w: 286, h: 161 },
  bl: { x: -607, y: 374, w: 262, h: 147 }, br: { x: 607, y: 374, w: 262, h: 147 },
};
const INNER = ["top", "ul", "ur", "ll", "lr", "bottom"];
const OUTER = ["tl", "tr", "bl", "br", "ml", "mr"];
/** Fewer than six around the middle still sit symmetrically. */
const INNER_FOR: string[][] = [[], ["top"], ["ul", "ur"], ["top", "ll", "lr"], ["ul", "ur", "ll", "lr"], ["top", "ul", "ur", "ll", "lr"], ["top", "ur", "lr", "bottom", "ll", "ul"]];
/** The reference's strings, as they're drawn: the middle out, the inner ring's neighbours, out to the outer ring, and round it. */
const EDGES: [string, string][] = [
  ["centre", "top"], ["centre", "bottom"], ["centre", "ul"], ["centre", "ur"], ["centre", "ll"], ["centre", "lr"],
  ["top", "ul"], ["top", "ur"], ["bottom", "ll"], ["bottom", "lr"],
  ["top", "tl"], ["top", "tr"], ["ul", "tl"], ["ul", "ml"], ["ll", "ml"], ["ll", "bl"], ["bottom", "bl"], ["bottom", "br"], ["ur", "tr"], ["ur", "mr"], ["lr", "mr"], ["lr", "br"],
  ["tl", "ml"], ["ml", "bl"], ["tr", "mr"], ["mr", "br"],
];
/**
 * The pull-back, measured: seconds from its start → how far along it is in
 * log scale (0 the footage filling the frame, 1 settled). Barely moving for
 * five frames, most of the way in the next ten, then a long settle that is
 * still drifting out four seconds on.
 */
const PULL: Point[] = [[0, 0], [0.08, 0.01], [0.16, 0.03], [0.24, 0.064], [0.32, 0.115], [0.4, 0.19], [0.48, 0.31], [0.56, 0.48], [0.64, 0.63], [0.72, 0.7], [0.8, 0.75], [0.88, 0.79], [1.12, 0.86], [1.44, 0.91], [1.76, 0.94], [2.48, 0.966], [3.28, 0.983], [4.68, 1]];
/** The strings out of the middle start 1.44 s after the pull-back does; the next ring's 1.24 s after those. */
const WAVE_ONE = 1.44; const WAVE_GAP = 1.24;

function pulled(t: number): number {
  if (t <= 0) return 0;
  for (let i = 1; i < PULL.length; i++) {
    const [t1, p1] = PULL[i]!; const [t0, p0] = PULL[i - 1]!;
    if (t <= t1) return p0 + ((p1 - p0) * (t - t0)) / (t1 - t0);
  }
  return 1;
}
/** A string grows fast and slows into its picture (quartic, as measured). */
const grown = (u: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, u)), 4);

export interface WebLayout {
  /** The board's scale on the frame (the reference's places grown to fill it when fewer are used). */
  fit: number;
  /** Where the board's middle settles on the frame (it's framed on what's used, so a lopsided board sits off centre). */
  offset: Point;
  centre: Box;
  nodes: (Box & { slot: string; ring: number })[];
  edges: { from: number; to: number; a: Point; b: Point }[];
}

/** Where each node sits: by `slot` if given, else around the middle first (ring 2 ones outside, off the inner one just before them). */
export function webLayout(p: Project, nodes: WebNode[]): WebLayout {
  const k = p.settings.height / 1080;
  const slots: (string | undefined)[] = nodes.map((n) => (typeof n.slot === "string" && SLOTS[n.slot] && n.slot !== "centre" ? n.slot : undefined));
  const taken = new Set(slots.filter((s): s is string => s !== undefined));
  const inner = nodes.map((n, i) => (slots[i] === undefined && n.ring !== 2 ? i : -1)).filter((i) => i >= 0);
  // Past six, the rest go outside.
  inner.splice(Math.max(0, 6 - [...taken].filter((s) => INNER.includes(s)).length));
  const innerSlots = (INNER_FOR[inner.length] ?? INNER).filter((s) => !taken.has(s)).concat(INNER.filter((s) => !taken.has(s)));
  for (const i of inner) { const s = innerSlots.find((one) => !taken.has(one))!; slots[i] = s; taken.add(s); }
  nodes.forEach((_, i) => {
    if (slots[i] !== undefined) return;
    // Outside: next to the inner picture listed just before it, when there's room there.
    let before: string | undefined;
    for (let j = i - 1; j >= 0; j--) if (slots[j] !== undefined && INNER.includes(slots[j]!)) { before = slots[j]; break; }
    const near = OUTER.filter((s) => !taken.has(s) && EDGES.some(([a, b]) => (a === before && b === s) || (b === before && a === s)));
    const s = near[0] ?? OUTER.find((one) => !taken.has(one)) ?? INNER.find((one) => !taken.has(one));
    if (s === undefined) throw new Error("commentary_web holds at most 12 around the middle");
    slots[i] = s; taken.add(s);
  });
  // Fill the frame with what's used, with the reference's margins (its board spans 86% of the width, 84% of the height): grown to its pictures and their tags, never past 1.5×.
  const used = ["centre", ...(slots as string[])];
  const tag = 46;
  const x0 = Math.min(...used.map((s) => SLOTS[s]!.x - SLOTS[s]!.w / 2)); const x1 = Math.max(...used.map((s) => SLOTS[s]!.x + SLOTS[s]!.w / 2));
  const y0 = Math.min(...used.map((s) => SLOTS[s]!.y - SLOTS[s]!.h / 2)); const y1 = Math.max(...used.map((s) => SLOTS[s]!.y + SLOTS[s]!.h / 2 + tag));
  const fit = Math.min((0.86 * 1920) / (x1 - x0), (0.84 * 1080) / (y1 - y0), 1.5) * k;
  const offset: Point = [-((x0 + x1) / 2) * fit, -((y0 + y1) / 2) * fit];
  const placed = (s: string): Box => { const b = SLOTS[s]!; return { x: b.x * fit, y: b.y * fit, w: b.w * fit, h: b.h * fit }; };
  const out = (slots as string[]).map((s) => ({ ...placed(s), slot: s, ring: INNER.includes(s) ? 1 : 2 }));
  const index = new Map(used.map((s, i) => [s, i - 1]));
  const boxOf = (i: number) => (i < 0 ? placed("centre") : out[i]!);
  // A string leaves the middle of the side facing where it goes (never down through a name tag: then from the side) and lands on the nearest corner or side of the other.
  const tagged = (i: number) => i < 0 || (typeof nodes[i]!.name === "string" && nodes[i]!.name!.trim() !== "");
  const edges = EDGES.filter(([a, b]) => index.has(a) && index.has(b)).map(([a, b]) => {
    const from = index.get(a)!; const to = index.get(b)!;
    const A = boxOf(from); const B = boxOf(to);
    const [dx, dy] = [B.x - A.x, B.y - A.y];
    const sideways = Math.abs(dx) / (A.w / 2) >= Math.abs(dy) / (A.h / 2) || (dy > 0 && tagged(from) && Math.abs(dx) > A.w / 2);
    const start: Point = sideways ? [A.x + Math.sign(dx) * A.w / 2, A.y] : [A.x, A.y + Math.sign(dy) * A.h / 2];
    const marks: Point[] = [];
    for (const mx of [-1, 0, 1]) for (const my of [-1, 0, 1]) if (mx !== 0 || my !== 0) marks.push([B.x + mx * B.w / 2, B.y + my * B.h / 2]);
    const end = marks.sort((m, n) => Math.hypot(m[0] - start[0], m[1] - start[1]) - Math.hypot(n[0] - start[0], n[1] - start[1]))[0]!;
    return { from, to, a: start, b: end };
  });
  return { fit, offset, centre: placed("centre"), nodes: out, edges };
}

const gauss = (d: number, sigma: number) => Math.exp(-(d * d) / (2 * sigma * sigma));
/** A string on a frame-sized PNG (centred coordinates): a thin hot core in a red halo, as measured (core ~2.5 px, halo fading over ~25 px). */
function linePng(W: number, H: number, a: Point, b: Point, k: number): Uint8Array {
  const A: Point = [a[0] + W / 2, a[1] + H / 2]; const B: Point = [b[0] + W / 2, b[1] + H / 2];
  const pad = 40 * k;
  const x0 = Math.floor(Math.min(A[0], B[0]) - pad); const x1 = Math.ceil(Math.max(A[0], B[0]) + pad);
  const y0 = Math.floor(Math.min(A[1], B[1]) - pad); const y1 = Math.ceil(Math.max(A[1], B[1]) + pad);
  return rgbaPng(W, H, (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return null;
    const d = toSegment(x + 0.5, y + 0.5, A, B);
    const core = Math.max(0, Math.min(1, 1.25 * k + 0.5 - d));
    const glow = 0.55 * gauss(d, 3 * k) + 0.22 * gauss(d, 11 * k);
    const a = Math.min(1, core + glow * (1 - core)); if (a <= 0.01) return null;
    const hot = core / Math.max(a, 1e-3);
    return [255, Math.round(18 + 50 * hot), Math.round(26 + 50 * hot), a * 255];
  });
}
/** The light a picture throws: a red glow round its frame and a little way in. */
function haloPng(w: number, h: number, margin: number, k: number): Uint8Array {
  const [W, H] = [Math.round(w + 2 * margin), Math.round(h + 2 * margin)];
  return rgbaPng(W, H, (x, y) => {
    const px = x + 0.5 - W / 2; const py = y + 0.5 - H / 2;
    const ox = Math.abs(px) - w / 2; const oy = Math.abs(py) - h / 2;
    const outside = ox > 0 || oy > 0;
    const d = outside ? Math.hypot(Math.max(ox, 0), Math.max(oy, 0)) : -Math.max(ox, oy);
    const a = outside ? 0.5 * gauss(d, 5 * k) + 0.2 * gauss(d, 16 * k) : 0.3 * gauss(d, 4 * k);
    if (a <= 0.004) return null;
    return [235, 20, 30, a * 255];
  });
}
/** The ground: black, a faint pure-red haze behind the middle (≈40/255 there, ≈5 in the corners), as measured. */
function groundPng(W: number, H: number): Uint8Array {
  return rgbaPng(W, H, (x, y) => {
    const dx = (x - W / 2) / (W / 2) / 0.7; const dy = (y - H / 2) / (H / 2) / 0.6;
    const g = Math.exp(-(dx * dx + dy * dy));
    return [Math.round(4 + 36 * g), 0, Math.round(1 + 2 * g), 255];
  });
}
/** Dust: small soft orange-red specks, drifting over everything. */
function dustPng(W: number, H: number, k: number, seed: number): Uint8Array {
  let s = seed;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const specks = Array.from({ length: 150 }, () => ({ x: rand() * W, y: rand() * H, r: (0.7 + rand() * 1.6) * k, a: 0.25 + rand() * 0.55, g: 60 + rand() * 90 }));
  const grid = new Map<number, typeof specks>();
  const cell = 16;
  for (const one of specks) {
    const key0 = Math.floor(one.x / cell) * 100000 + Math.floor(one.y / cell);
    grid.set(key0, [...(grid.get(key0) ?? []), one]);
  }
  return rgbaPng(W, H, (x, y) => {
    let best: [number, number, number, number] | null = null;
    for (let gx = -1; gx <= 1; gx++) for (let gy = -1; gy <= 1; gy++) {
      for (const one of grid.get((Math.floor(x / cell) + gx) * 100000 + Math.floor(y / cell) + gy) ?? []) {
        const a = one.a * gauss(Math.hypot(x + 0.5 - one.x, y + 0.5 - one.y), one.r);
        if (a > 0.01 && (best === null || a * 255 > best[3])) best = [255, Math.round(one.g), 50, a * 255];
      }
    }
    return best;
  });
}
/** A name tag already blurred (words are never left under a blur, so a mystery's is drawn soft): a dark box with light smudges where its letters would be. */
function blurredTagPng(name: string, size: number, k: number): Uint8Array {
  const wide = commentaryGraphics.widthOf(name.toUpperCase(), "Geist", 700, size);
  const [padX, padY] = [10 * k, 5 * k];
  const [W, H] = [Math.ceil(wide + 2 * padX + 24 * k), Math.ceil(size * 1.3 + 2 * padY + 24 * k)];
  const letters = name.toUpperCase().split("").map((ch, i, all) => ({ x: W / 2 - wide / 2 + ((i + 0.5) / all.length) * wide, on: ch.trim() !== "" }));
  const sigma = 7 * k;
  return rgbaPng(W, H, (x, y) => {
    const bx = Math.max(0, Math.abs(x + 0.5 - W / 2) - (wide / 2 + padX)); const by = Math.max(0, Math.abs(y + 0.5 - H / 2) - (size * 0.65 + padY));
    const box = 0.92 * gauss(Math.hypot(bx, by), sigma * 0.8);
    let ink = 0;
    for (const l of letters) if (l.on) ink += 0.3 * gauss(x + 0.5 - l.x, sigma * 1.3) * gauss(y + 0.5 - H / 2, size * 0.36);
    ink = Math.min(0.62, ink);
    const a = Math.min(1, box + ink * (1 - box)); if (a <= 0.01) return null;
    const v = Math.round(255 * (ink / Math.max(a, 1e-3)));
    return [v, v, v, a * 255];
  });
}

registerTool("commentary_web", async ({ app, args, projectId }) => {
  const p = app.store.get(projectId)?.project; if (!p) throw new Error("no such project");
  const { width: W, height: H, fps } = p.settings; const k = H / 1080;
  const centre = args.centre as WebNode | undefined;
  if (centre === undefined || typeof centre.media !== "string" || mediaOf(p, centre.media) === undefined) throw new Error("commentary_web needs centre: {media, name, source_in?}");
  if (!Array.isArray(args.nodes) || args.nodes.length < 2 || args.nodes.length > 12) throw new Error("commentary_web needs 2–12 nodes [{media, name?, blur?, at?, ring?: 1|2, slot?}]");
  const nodes = args.nodes as WebNode[];
  for (const n of nodes) if (typeof n.media !== "string" || mediaOf(p, n.media) === undefined) throw new Error(`no media ${String(n.media)} for a web node`);
  const [start, end] = [args.start, args.end];
  if (typeof start !== "number" || typeof end !== "number" || end - start < Math.round(3 * fps)) throw new Error("start/end are timeline frames, at least 3 s apart (the pull-back and the first strings take 2.2 s)");
  const L = webLayout(p, nodes);
  const fromFull = args.from_full !== false;
  // The camera: the board's scale on screen, from the middle filling the frame down to 1.
  // The camera: the board's scale on screen, from the middle covering the frame (its own shape or the frame's, whichever is narrower) down to 1.
  const cm = mediaOf(p, centre.media)!; const startShape = Math.min(cm.width / Math.max(cm.height, 1), W / H);
  const B0 = fromFull ? Math.max(H / L.centre.h, W / (L.centre.h * startShape)) : 1.35;
  const cam = (frame: number) => Math.pow(B0, 1 - pulled((frame - start) / fps));
  // A point on the board on screen: scaled about the middle, drifting to where the board is framed as it settles.
  const sx = (frame: number, x: number) => x * cam(frame) + L.offset[0] * pulled((frame - start) / fps);
  const sy = (frame: number, y: number) => y * cam(frame) + L.offset[1] * pulled((frame - start) / fps);
  const tagSize = 22 * L.fit;
  // The pictures each draw: the strings, the glow round each picture size, the ground, the dust, the mystery tags.
  const ground = await imported(app, projectId, "web-ground-v2", groundPng(W, H));
  const lines: string[] = [];
  for (const [i, e] of L.edges.entries()) lines.push(await imported(app, projectId, `web-string-${i}`, linePng(W, H, e.a, e.b, k)));
  const margin = Math.round(40 * k);
  const halos = new Map<string, string>();
  for (const b of [L.centre, ...L.nodes]) {
    const name = `${Math.round(b.w)}x${Math.round(b.h)}`;
    if (!halos.has(name)) halos.set(name, await imported(app, projectId, `web-glow-${name}`, haloPng(b.w, b.h, margin, k)));
  }
  const dust = [await imported(app, projectId, "web-dust-a", dustPng(W, Math.round(H * 1.2), k, 7)), await imported(app, projectId, "web-dust-b", dustPng(W, Math.round(H * 1.2), k, 23))];
  const mysteryTags = new Map<number, string>();
  for (const [i, n] of nodes.entries()) if (n.blur === true && n.name?.trim()) mysteryTags.set(i, await imported(app, projectId, "web-mystery-tag", blurredTagPng(n.name.trim(), tagSize, k)));

  const [, made] = await app.store.update(projectId, "agent", (project) => {
    const out: string[] = [];
    const track = () => addTrack(project, "video");
    const put = (fields: Args, on = track()) => { const id = freshId(project, "c"); project.clips.push(clipFrom({ id, track: on, ...fields })); out.push(id); return id; };
    // Keyframes made from the camera, every frame while it moves fast, then every third.
    const bake = (from: number, to: number, value: (frame: number) => number): Keyframe[] => {
      const keys: Keyframe[] = [];
      for (let f = from; f <= to;) {
        keys.push(key(f - from, value(f)));
        const t = (f - start) / fps;
        f += t < 1.2 ? 1 : t < 4.8 ? 3 : Math.max(1, to - f);
      }
      if (keys.at(-1)!.frame !== to - from) keys.push(key(to - from, value(to)));
      return keys;
    };
    const fitOf = (m: { width: number; height: number }) => Math.min(W / Math.max(m.width, 1), H / Math.max(m.height, 1));
    // First frame a box on the board is on screen (the camera only pulls back, so it stays on).
    const onFrom = (b: Box) => {
      for (let f = start; f < end; f++) { const B = cam(f); if (Math.abs(sx(f, b.x)) - (b.w * B) / 2 < W / 2 && Math.abs(sy(f, b.y)) - (b.h * B) / 2 < H / 2) return f; }
      return end;
    };
    // The frame's border is in the picture's own pixels, so it would thicken with the camera: a few stretches, each its own width, keep it ~2.5 px on screen.
    const stretches = (from: number) => {
      const cuts = [from];
      for (const limit of [5, 3.4, 2.4, 1.75, 1.35, 1.12]) {
        for (let f = from + 1; f < end; f++) if (cam(f) < limit && cam(f - 1) >= limit) { if (f - cuts.at(-1)! >= 2) cuts.push(f); break; }
      }
      return cuts.map((s, i) => [s, cuts[i + 1] ?? end] as const);
    };
    const RED_FRAME = [0.93, 0.1, 0.13, 1];

    put({ type: "video", name: "Janitor · web ground", media: ground, source_in: 0, start, duration: end - start, fade_out: 8, transform: { x: 0, y: 0, scale: 1 } });

    // When each string grows: out of the middle at WAVE_ONE (or the word naming the person), on out WAVE_GAP after the picture it leaves.
    const ats: number[] = nodes.map((n, i) => {
      const inner = L.nodes[i]!.ring === 1;
      const wave = start + Math.round((inner ? WAVE_ONE : WAVE_ONE + WAVE_GAP) * fps);
      return typeof n.at === "number" ? Math.max(start + Math.round(0.9 * fps), Math.min(end - 20, Math.round(n.at))) : wave;
    });
    L.nodes.forEach((n, i) => {
      if (n.ring !== 2) return;
      const firsts = L.edges.filter((e) => (e.to === i && e.from >= 0 && L.nodes[e.from]!.ring === 1) || (e.from === i && e.to >= 0 && L.nodes[e.to]!.ring === 1)).map((e) => ats[e.to === i ? e.from : e.to]!);
      if (firsts.length) ats[i] = Math.max(ats[i]!, Math.min(...firsts) + Math.round(WAVE_GAP * fps));
    });
    const atOf = (i: number) => (i < 0 ? start : ats[i]!);
    const ringOf = (i: number) => (i < 0 ? 0 : L.nodes[i]!.ring);
    const arrived = new Map<number, number>();
    const strings = L.edges.map((e, i) => {
      // Drawn from whichever end was there first.
      const swap = atOf(e.to) < atOf(e.from) || (atOf(e.to) === atOf(e.from) && ringOf(e.to) < ringOf(e.from));
      const [from, to, a, b] = swap ? [e.to, e.from, e.b, e.a] : [e.from, e.to, e.a, e.b];
      const both = ringOf(from) === 1 && ringOf(to) === 1;
      const begin = Math.min(end - 12, Math.max(atOf(from), atOf(to)) + (both ? Math.round(WAVE_GAP * fps) : 0));
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]) / k;
      const frames = Math.max(8, Math.round((0.3 + length / 400) * fps));
      if (!arrived.has(to)) arrived.set(to, begin + Math.round(frames * 0.55));
      return { i, a, b, begin, frames };
    });

    // The strings, under every picture.
    for (const s of strings) {
      const across = Math.abs(s.b[0] - s.a[0]) >= Math.abs(s.b[1] - s.a[1]);
      const forward = across ? s.b[0] > s.a[0] : s.b[1] > s.a[1];
      const side = across ? (forward ? "crop.right" : "crop.left") : (forward ? "crop.bottom" : "crop.top");
      const along = (q: Point) => (across ? (q[0] + W / 2) / W : (q[1] + H / 2) / H);
      const cut = (v: number) => Math.max(0, Math.min(0.9999, forward ? 1 - v : v));
      const past = (across ? 30 / W : 30 / H) * k * (forward ? 1 : -1);
      const [c0, c1] = [cut(along(s.a)), cut(along(s.b) + past)];
      put({ type: "video", name: "Janitor · web string", media: lines[s.i]!, source_in: 0, start: s.begin, duration: end - s.begin, fade_out: 8, crop: { left: 0, right: 0, top: 0, bottom: 0 },
        transform: { x: 0, y: 0, scale: 1 },
        keyframes: { scale: bake(s.begin, end, cam), x: bake(s.begin, end, (fr) => sx(fr, 0)), y: bake(s.begin, end, (fr) => sy(fr, 0)), [side]: Array.from({ length: Math.ceil(s.frames / 2) + 1 }, (_, j) => key(Math.min(j * 2, s.frames), c0 + (c1 - c0) * grown(Math.min(j * 2, s.frames) / s.frames))) } });
    }

    // Each picture's glow, under the pictures, coming up as the board settles.
    const boxes = [{ box: L.centre, node: centre, i: -1 }, ...L.nodes.map((b, i) => ({ box: b as Box, node: nodes[i]!, i }))];
    for (const { box } of boxes) {
      const glowFrom = Math.max(onFrom(box), (() => { for (let f = start; f < end; f++) if (cam(f) < 2.2) return f; return end; })());
      if (glowFrom >= end - 8) continue;
      const media = halos.get(`${Math.round(box.w)}x${Math.round(box.h)}`)!;
      const m = mediaOf(project, media)!; const f = fitOf(m);
      put({ type: "video", name: "Janitor · web glow", media, source_in: 0, start: glowFrom, duration: end - glowFrom, fade_in: 8, fade_out: 8, transform: { x: box.x, y: box.y, scale: 1 / f },
        keyframes: { x: bake(glowFrom, end, (fr) => sx(fr, box.x)), y: bake(glowFrom, end, (fr) => sy(fr, box.y)), scale: bake(glowFrom, end, (fr) => cam(fr) / f) } });
    }

    // The pictures: the middle first (the footage itself, cropped from the full frame down to its shape as it shrinks), then the rest flying in with the camera.
    for (const { box, node, i } of boxes) {
      const m = mediaOf(project, node.media)!; const f = fitOf(m);
      const aspect = m.width / Math.max(m.height, 1); const want = box.w / box.h;
      const cropFor = (a: number) => (aspect > a ? { left: (1 - a / aspect) / 2, right: (1 - a / aspect) / 2, top: 0, bottom: 0 } : { left: 0, right: 0, top: (1 - aspect / a) / 2, bottom: (1 - aspect / a) / 2 });
      // The middle's shape: the frame's at first, its own once most of the way back.
      const shape = (fr: number) => {
        if (i >= 0 || !fromFull) return want;
        const u = Math.max(0, Math.min(1, (pulled((fr - start) / fps) - 0.05) / 0.7)); const s = u * u * (3 - 2 * u);
        return Math.min(aspect, W / H) + (want - Math.min(aspect, W / H)) * s;
      };
      // Its scale for the box's height (or width, when the picture is cropped top and bottom) at that shape.
      const scaleAt = (fr: number) => { const a = shape(fr); const c = cropFor(a); const B = cam(fr); return c.top > 0 ? (box.h * a * B) / (m.width * f) : (box.h * B) / (m.height * f * (1 - c.top - c.bottom)); };
      const from = i < 0 ? start : onFrom(box);
      if (from >= end - 8) continue;
      const lane = track();
      for (const [s, e] of stretches(from)) {
        const mid = Math.round((s + e) / 2); const shown = scaleAt(Math.min(mid, s + Math.round(1.5 * fps)));
        const crop = cropFor(want);
        const keyframes: Record<string, Keyframe[]> = { x: bake(s, e, (fr) => sx(fr, box.x)), y: bake(s, e, (fr) => sy(fr, box.y)), scale: bake(s, e, scaleAt) };
        if (i < 0 && fromFull && s - start < Math.round(1.2 * fps)) for (const side of ["left", "right", "top", "bottom"] as const) keyframes[`crop.${side}`] = bake(s, e, (fr) => cropFor(shape(fr))[side]);
        put({ type: "video", name: i < 0 ? "Janitor · web centre" : "Janitor · web picture", media: m.id, source_in: (node.source_in ?? 0) + (s - from) / fps, start: s, duration: e - s, fade_out: e === end ? 8 : 0,
          crop, frame: { color: RED_FRAME, width: (2.5 * k) / Math.max(shown, 1e-4), shadow: 0, glow: 0 }, transform: { x: sx(s, box.x), y: sy(s, box.y), scale: scaleAt(s) }, keyframes }, lane);
      }
    }

    // Name tags, popping up as each one's string reaches them; a mystery's drawn already blurred.
    const tagY = (b: Box) => b.y + b.h / 2 + 24 * L.fit;
    for (const { box, node, i } of boxes) {
      const name = typeof node.name === "string" ? node.name.trim() : "";
      if (!name) continue;
      const at = i < 0 ? Math.min(end - 12, start + Math.round(WAVE_ONE * fps) - 6) : Math.min(end - 12, arrived.get(i) ?? atOf(i));
      const pop = (fr: number) => { const u = Math.min(1, (fr - at) / 7); return 0.7 + 0.3 * grown(u); };
      const motion = { x: bake(at, end, (fr) => sx(fr, box.x)), y: bake(at, end, (fr) => sy(fr, tagY(box))) };
      const mystery = i >= 0 && mysteryTags.get(i);
      if (mystery) {
        const m = mediaOf(project, mystery)!; const f = fitOf(m);
        put({ type: "video", name: "Janitor · web mystery name", media: mystery, source_in: 0, start: at, duration: end - at, fade_in: 4, fade_out: 8, transform: { x: box.x, y: tagY(box), scale: 1 / f },
          keyframes: { ...motion, scale: bake(at, end, (fr) => (cam(fr) * pop(fr)) / f) } });
      } else {
        put({ type: "text", name: "Janitor · web name", text: name.toUpperCase(), start: at, duration: end - at, fade_in: 4, fade_out: 8,
          style: { font: "Geist", weight: 700, size: (i < 0 ? 1.15 : 1) * tagSize, color: [1, 1, 1, 1], tracking: 0, line_height: 1.1, glow: { enabled: false }, background: { color: [0, 0, 0, 1], opacity: 0.92, pad_x: 10 * k, pad_y: 5 * k } },
          transform: { x: box.x, y: tagY(box) }, keyframes: { ...motion, scale: bake(at, end, (fr) => cam(fr) * pop(fr)) } });
      }
    }

    // The mysteries' pictures, blurred where they sit as the camera moves.
    for (const { box, node, i } of boxes) {
      if (i < 0 || node.blur !== true) continue;
      const from = onFrom(box); if (from >= end - 8) continue;
      // Only the picture: its frame and glow stay sharp round the mystery.
      const pad = -2 * k;
      put({ type: "adjustment", name: "Janitor · web mystery", start: from, duration: end - from, fade_out: 8,
        blur: { radius: 22 * k, x: box.x, y: box.y, width: box.w + 2 * pad, height: box.h + 2 * pad, feather: 6 * k, shape: "rect" }, grade: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, vignette: 0 },
        keyframes: { "blur.x": bake(from, end, (fr) => sx(fr, box.x)), "blur.y": bake(from, end, (fr) => sy(fr, box.y)), "blur.width": bake(from, end, (fr) => (box.w + 2 * pad) * cam(fr)), "blur.height": bake(from, end, (fr) => (box.h + 2 * pad) * cam(fr)) } });
    }

    // The reference's motion blur through the fast part of the pull-back.
    if (fromFull) {
      const until = start + Math.round(1.1 * fps);
      const speed = (fr: number) => Math.abs(Math.log(cam(fr + 0.5)) - Math.log(cam(fr - 0.5))) * fps;
      put({ type: "adjustment", name: "Janitor · web motion blur", start, duration: until - start, blur: { radius: 0, x: 0, y: 0, width: W, height: H, feather: 0, shape: "rect" },
        grade: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, vignette: 0 }, keyframes: { blur: bake(start, until, (fr) => Math.min(14 * k, 2.2 * k * speed(fr))) } });
    }

    // Dust over it all, two layers drifting up at different speeds.
    dust.forEach((media, j) => {
      const m = mediaOf(project, media)!; const f = fitOf(m);
      const drift = (j === 0 ? 0.05 : 0.09) * H;
      put({ type: "video", name: "Janitor · web dust", media, source_in: 0, start, duration: end - start, fade_in: 6, fade_out: 8, opacity: j === 0 ? 0.55 : 0.35,
        transform: { x: 0, y: drift / 2, scale: (W / (m.width * f)) * 1 },
        keyframes: { y: [key(0, drift / 2), key(end - start, -drift / 2)], x: [key(0, j === 0 ? -6 * k : 8 * k), key(end - start, j === 0 ? 10 * k : -10 * k)] } });
    });
    return out;
  });
  return text(stableStringify({ clips: made, slots: L.nodes.map((n, i) => ({ name: nodes[i]!.name ?? null, slot: n.slot })),
    note: "The web as M's reference does it: the footage pulls back into the middle picture and reveals the whole board, then the strings grow out (at: the word naming that person). 8–12 pictures fill the board like the reference; extra ones can be pictures of the story without a name. Put whoosh-3 on its start. Check frames at 0.5 s, 2.5 s and the end." }));
});

// ---------------------------------------------------------------------------
// The reverb out.

registerTool("commentary_reverb_out", async ({ app, args, projectId }) => {
  const p = app.store.get(projectId)?.project; if (!p) throw new Error("no such project");
  const fps = p.settings.fps;
  const clip = p.clips.find((c) => c.id === args.clip);
  if (clip?.type !== "video" || !clip.link) throw new Error("commentary_reverb_out needs clip: a source excerpt playing its own sound (its picture clip)");
  const sound = p.clips.find((c) => c.id !== clip.id && c.link === clip.link && c.type === "audio");
  if (sound?.type !== "audio") throw new Error(`${clip.id} has no sound clip linked to it`);
  const from = typeof args.from === "number" ? Math.round(args.from) : NaN;
  if (!(from > clip.start && from < clipEnd(clip))) throw new Error("from is the timeline frame where the words to warp out begin, inside the clip");
  const tail = Math.min(Math.max(typeof args.tail === "number" ? args.tail : 2.2, 0.8), 5);
  const hold = Math.min(Math.max(typeof args.hold === "number" ? args.hold : 0.5, 0), 3);
  const media = mediaOf(p, sound.media)!;
  // Its last words from `from` to the clip's end, slowed and lowered a little and
  // sent into a long echo that fades: "warps out".
  const sourceFrom = sound.source_in + ((from - sound.start) / fps) * sound.speed;
  const seconds = ((clipEnd(sound) - from) / fps) * sound.speed;
  const dir = join(app.store.uploadsDir(projectId), "reverb"); fs.mkdirSync(dir, { recursive: true });
  const out = join(dir, `reverb-v2-${media.id}-${sourceFrom.toFixed(2)}-${seconds.toFixed(2)}-${tail}.wav`);
  if (!fs.existsSync(out)) {
    const remote = tools.isUrl(media.path) ? ["-protocol_whitelist", tools.protocols(media.path), ...tools.urlArgs(media.path)] : [];
    const total = seconds / 0.9 + tail;
    await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", ...remote, "-ss", sourceFrom.toFixed(3), "-t", seconds.toFixed(3), "-i", media.path, "-vn",
      // Close early reflections, then a long train of echoes into the pause, darkened, fading over its last 1.2 s.
      "-af", `aresample=48000,asetrate=48000*0.9,aresample=48000,apad=pad_dur=${tail},aecho=0.8:0.9:50|90|140|200:0.55|0.5|0.45|0.4,aecho=0.8:0.88:260|520|780|1040|1300|1560|1820:0.6|0.5|0.42|0.34|0.26|0.18|0.12,lowpass=f=5200,afade=t=out:st=${Math.max(0, total - 1.2).toFixed(2)}:d=1.2`,
      "-t", total.toFixed(3), "-ac", "2", out]);
  }
  const [, ids, errors] = await importPaths(app, projectId, [out], false, "agent");
  if (ids[0] === undefined) throw new Error(errors.join("; "));
  const [, done] = await app.store.update(projectId, "agent", (project) => {
    const pic = project.clips.find((c) => c.id === clip.id)!; const snd = project.clips.find((c) => c.id === sound.id)!;
    const cut = clipEnd(pic);
    // Room for the tail and the pause before what follows.
    const room = Math.round((tail + hold) * fps);
    insertTime(project, cut, room, new Set(), new Set());
    // The original sound stops where the warped words begin; the warped take plays on into the room.
    snd.duration = from - snd.start;
    const took = Math.round(((seconds / 0.9) + tail) * fps);
    const warped = freshId(project, "c");
    project.clips.push(clipFrom({ id: warped, type: "audio", name: "Janitor · reverb out", media: ids[0], track: snd.track, start: from, duration: took, source_in: 0, volume_db: (snd as { volume_db?: number }).volume_db ?? 0, fade_in: 0, fade_out: 0 }));
    // The picture fades to black from the words, and stays black through the pause.
    const black = push(project, { type: "solid", name: "Janitor · fade to black", fill: [0, 0, 0, 1], start: from, duration: cut + room - from, fade_in: Math.min(cut - from, Math.round(0.5 * fps)) });
    return { warped, black, inserted_frames: room };
  });
  return text(stableStringify({ ...done, note: "The words warp out into reverb over a fade to black, then a pause before the narration. Listen to it once." }));
});

export const forTests = { arrowLayout, webLayout };
