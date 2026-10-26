// The Internet Janitor effects the team asked for by name on N3on's v1 (M,
// Oct 26), each built as the reference shows it:
// - commentary_arrow: a red arrow drawn in toward a person with their name at
//   its tail ("an red arrow with text towards Adin, which says 'Adin Ross'"),
//   following them as the camera moves ("the arrow and text tracks them").
// - commentary_web: the spider web of the people behind someone ("N3on in the
//   middle with a name tag under him… some of them blurred with their name tag
//   blurred as well so it looks kind of intriguing"), as in the reference M
//   linked (Dr Insanity's, youtu.be/ppBajdOW9DU?t=69): footage shrinking into
//   the middle picture, red-framed pictures in rings on black with a red edge
//   glow, red lines drawing out from the middle as each person arrives.
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
// The web.

interface WebNode { media: string; source_in?: number; name?: string; blur?: boolean; at?: number; ring?: number }
export interface WebLayout { nodes: { x: number; y: number; w: number; h: number; ring: number; parent: number }[]; centre: { w: number; h: number } }

/** The middle and two rings around it, each on an ellipse, the outer ring offset half a step. */
export function webLayout(p: Project, nodes: WebNode[]): WebLayout {
  const { width: W, height: H } = p.settings; const k = H / 1080;
  const rings = [nodes.filter((n) => (n.ring ?? 1) !== 2), nodes.filter((n) => n.ring === 2)];
  const out: WebLayout["nodes"] = [];
  const inner = Math.max(rings[0]!.length, 1);
  rings.forEach((ring, r) => {
    const [rx, ry] = r === 0 ? [0.27 * W, 0.29 * H] : [0.41 * W, 0.34 * H];
    const [w, h] = r === 0 ? [260 * k, 170 * k] : [220 * k, 140 * k];
    ring.forEach((_, i) => {
      // The outer ring sits in the gaps between the inner one, spread round
      // them, never straight above or below the middle where tags would stack.
      const gap = ring.length <= inner ? Math.floor(((i + 0.5) * inner) / ring.length) : i;
      const angle = r === 0 ? (-Math.PI / 2) + (2 * Math.PI * i) / ring.length
        : (-Math.PI / 2) + (2 * Math.PI * (gap + 0.5)) / (ring.length <= inner ? inner : ring.length);
      const x = Math.cos(angle) * rx; const y = Math.sin(angle) * ry;
      // An outer picture hangs off the nearest inner one.
      let parent = -1;
      if (r === 1 && out.length > 0) parent = out.map((n, j) => [Math.hypot(n.x - x, n.y - y), j] as const).sort((a, b) => a[0] - b[0])[0]![1];
      out.push({ x, y, w, h, ring: r + 1, parent });
    });
  });
  return { nodes: out, centre: { w: 300 * k, h: 200 * k } };
}
/** A glowing red line on a frame-sized PNG, from a to b (centred coordinates). */
function linePng(W: number, H: number, a: Point, b: Point, k: number): Uint8Array {
  const A: Point = [a[0] + W / 2, a[1] + H / 2]; const B: Point = [b[0] + W / 2, b[1] + H / 2];
  const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0]) - 20)); const x1 = Math.min(W, Math.ceil(Math.max(A[0], B[0]) + 20));
  const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1]) - 20)); const y1 = Math.min(H, Math.ceil(Math.max(A[1], B[1]) + 20));
  return rgbaPng(W, H, (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return null;
    const d = toSegment(x + 0.5, y + 0.5, A, B);
    const core = Math.max(0, Math.min(1, 1.6 * k + 0.5 - d));
    const glow = Math.max(0, 1 - d / (9 * k)) * 0.45;
    const a = Math.max(core, glow); if (a <= 0.01) return null;
    return [255, Math.round(40 + 120 * core), Math.round(40 + 120 * core), a * 255];
  });
}
/** Black with a dark red glow at the edges, as the reference's web sits on. */
function groundPng(W: number, H: number): Uint8Array {
  // Mostly black; a deep red only toward the corners.
  return rgbaPng(W, H, (x, y) => {
    const dx = (x - W / 2) / (W / 2); const dy = (y - H / 2) / (H / 2);
    const r = Math.min(1.2, Math.hypot(dx * 0.85, dy * 0.95));
    const glow = Math.pow(Math.max(0, r - 0.6) / 0.6, 2.2);
    return [Math.round(5 + 70 * glow), Math.round(2 + 3 * glow), Math.round(3 + 4 * glow), 255];
  });
}

registerTool("commentary_web", async ({ app, args, projectId }) => {
  const p = app.store.get(projectId)?.project; if (!p) throw new Error("no such project");
  const { width: W, height: H } = p.settings; const k = H / 1080;
  const centre = args.centre as WebNode | undefined;
  if (centre === undefined || typeof centre.media !== "string" || mediaOf(p, centre.media) === undefined) throw new Error("commentary_web needs centre: {media, name, source_in?}");
  if (!Array.isArray(args.nodes) || args.nodes.length < 2 || args.nodes.length > 12) throw new Error("commentary_web needs 2–12 nodes [{media, name?, blur?, at?, ring?: 1|2}]");
  const nodes = args.nodes as WebNode[];
  for (const n of nodes) if (typeof n.media !== "string" || mediaOf(p, n.media) === undefined) throw new Error(`no media ${String(n.media)} for a web node`);
  const [start, end] = [args.start, args.end];
  if (typeof start !== "number" || typeof end !== "number" || end - start < 60) throw new Error("start/end are timeline frames, at least 2 s apart");
  const L = webLayout(p, nodes);
  // The lines, each its own picture so it can draw out when its person arrives.
  const ground = await imported(app, projectId, "web-ground", groundPng(W, H));
  const lines: string[] = [];
  for (const [i, n] of L.nodes.entries()) {
    const from: Point = n.parent < 0 ? [0, 0] : [L.nodes[n.parent]!.x, L.nodes[n.parent]!.y];
    lines.push(await imported(app, projectId, `web-line-${i}`, linePng(W, H, from, [n.x, n.y], k)));
  }
  const fromFull = args.from_full !== false;
  const [, made] = await app.store.update(projectId, "agent", (project) => {
    const d = end - start; const out: string[] = [];
    out.push(push(project, { type: "video", name: "Janitor · web ground", media: ground, source_in: 0, start, duration: d, fade_out: 8, transform: { x: 0, y: 0, scale: 1 } }));
    // A picture cropped to its box's shape, filling it, red-framed.
    const framed = (n: WebNode, w: number, h: number, x: number, y: number, at: number, entrance: Keyframe[] | null, name: string) => {
      const m = mediaOf(project, n.media)!; const fit = Math.min(W / Math.max(m.width, 1), H / Math.max(m.height, 1));
      const aspect = m.width / Math.max(m.height, 1); const want = w / h;
      const crop = aspect > want ? { left: (1 - want / aspect) / 2, right: (1 - want / aspect) / 2, top: 0, bottom: 0 } : { left: 0, right: 0, top: (1 - aspect / want) / 2, bottom: (1 - aspect / want) / 2 };
      const scale = w / (m.width * fit * (1 - crop.left - crop.right));
      return push(project, { type: "video", name, media: m.id, source_in: n.source_in ?? 0, start: at, duration: end - at, fade_in: entrance ? 0 : 4, fade_out: 8, crop,
        frame: { color: [1, 0.12, 0.12, 1], width: 3 * k, shadow: 0.7, glow: 0.6 }, transform: { x, y, scale },
        keyframes: { scale: entrance ? entrance.map((one) => ({ ...one, value: one.value * scale })) : arrival(scale * 0.7, scale, 10) } });
    };
    // The middle: the footage shrinking into its picture, or popping up.
    const c = L.centre; const cm = mediaOf(project, centre.media)!; const cfit = Math.min(W / cm.width, H / cm.height);
    const coverFrom = Math.max(W / c.w, H / c.h) * Math.max(c.w / (cm.width * cfit), 1);
    out.push(framed(centre, c.w, c.h, 0, 0, start, fromFull ? arrival(coverFrom, 1, 18) : null, "Janitor · web centre"));
    const tag = (name: string, x: number, y: number, at: number, big = false) => push(project, { type: "text", name: "Janitor · web name", text: name.toUpperCase(), start: at, duration: end - at, fade_in: 5, fade_out: 8,
      style: { font: "Geist", weight: 700, size: (big ? 30 : 24) * k, color: [1, 1, 1, 1], tracking: 0, line_height: 1.1, glow: { enabled: false }, background: { color: [0, 0, 0, 1], opacity: 0.92, pad_x: 10 * k, pad_y: 5 * k } },
      transform: { x, y } });
    if (typeof centre.name === "string" && centre.name.trim()) out.push(tag(centre.name.trim(), 0, c.h / 2 + 30 * k, start + 14, true));
    // Each person arrives at their `at` (the word naming them), else one after another; their line draws out to them first.
    let next = start + 22;
    const blurs: { x: number; y: number; w: number; h: number; at: number }[] = [];
    const arrived: number[] = [];
    L.nodes.forEach((n, i) => {
      const node = nodes.filter((one) => (one.ring ?? 1) !== 2).concat(nodes.filter((one) => one.ring === 2))[i]!;
      let at = typeof node.at === "number" ? Math.max(start + 18, Math.min(end - 20, node.at)) : next; next = at + 8;
      // An outer person comes after the one they hang off, so their line never starts from empty space.
      if (n.parent >= 0) at = Math.min(end - 20, Math.max(at, (arrived[n.parent] ?? at) + 10));
      arrived[i] = at;
      const parent = n.parent < 0 ? { x: 0, y: 0 } : L.nodes[n.parent]!;
      const across = Math.abs(n.x - parent.x) >= Math.abs(n.y - parent.y);
      const side = across ? (n.x > parent.x ? "crop.right" : "crop.left") : (n.y > parent.y ? "crop.bottom" : "crop.top");
      const lineStart = Math.max(start, at - 8);
      // The line's own picture is frame-sized: it's uncovered from its inner end to its outer one.
      const inner = across ? (parent.x + W / 2) / W : (parent.y + H / 2) / H; const outer = across ? (n.x + W / 2) / W : (n.y + H / 2) / H;
      const cut = (v: number) => (side === "crop.right" || side === "crop.bottom" ? 1 - v : v);
      out.push(push(project, { type: "video", name: "Janitor · web line", media: lines[i]!, source_in: 0, start: lineStart, duration: end - lineStart, fade_out: 8, transform: { x: 0, y: 0, scale: 1 },
        crop: { left: 0, right: 0, top: 0, bottom: 0 }, keyframes: { [side]: [key(0, Math.min(cut(inner), 0.9999)), key(8, 0)] } }));
      void outer;
      out.push(framed(node, n.w, n.h, n.x, n.y, at, null, "Janitor · web picture"));
      if (node.name) out.push(tag(node.name, n.x, n.y + n.h / 2 + 24 * k, at + 4));
      // The picture and its tag under one blur, with room past both for its feather.
      if (node.blur === true) blurs.push({ x: n.x, y: n.y + 22 * k, w: n.w + 50 * k, h: n.h + 110 * k, at });
    });
    // The lines run under every picture: their tracks go down just above the ground's.
    const groundTrack = project.clips.find((one) => one.id === out[0])!.track;
    const lineTracks = project.clips.filter((one) => out.includes(one.id) && one.name === "Janitor · web line").map((one) => one.track);
    const moved = project.tracks.filter((t) => lineTracks.includes(t.id));
    project.tracks = project.tracks.filter((t) => !lineTracks.includes(t.id));
    project.tracks.splice(project.tracks.findIndex((t) => t.id === groundTrack) + 1, 0, ...moved);
    // The ones kept a mystery: their picture and name blurred, above both.
    for (const b of blurs) out.push(push(project, { type: "adjustment", name: "Janitor · web mystery", start: b.at, duration: end - b.at, fade_out: 8,
      blur: { radius: 26 * k, x: b.x, y: b.y, width: b.w, height: b.h, feather: 8 * k, shape: "rect" }, grade: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, vignette: 0 } }));
    return out;
  });
  return text(stableStringify({ clips: made, note: "The web: the middle shrinks in from full frame, each person's line draws out as they arrive (at: the word naming them), the blurred ones stay a mystery. Check frames at its start, middle and end." }));
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
