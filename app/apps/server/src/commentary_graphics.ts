// Internet Janitor's compositions as editable layers. Shared core Bezier
// evaluation means these moves match in the browser and native/cloud export.
import { clipFrom } from "./clips.ts";
import type { Project } from "./model.ts";
import { addTrack, clipEnd, freshId, mediaOf } from "./project.ts";

type Args = Record<string, unknown>;
const number = (a: Args, key: string, fallback: number) => typeof a[key] === "number" ? a[key] as number : fallback;
const key = (frame: number, value: number, ease = "linear") => ({ frame, value, ease });
// Strong ease-out: fast arrival, long deceleration; no floating linear slide.
const arrival = (from: number, to: number, frames: number) => [
  { ...key(0, from), handle_out: { speed: 0, influence: 0.12 } },
  { ...key(frames, to), handle_in: { speed: 0, influence: 0.82 } },
];
function push(p: Project, fields: Args): string {
  const id = freshId(p, "c");
  p.clips.push(clipFrom({ id, track: addTrack(p, "video"), ...fields }));
  return id;
}
function span(a: Args): [number, number] {
  if (typeof a.start !== "number" || !Number.isInteger(a.start) || a.start < 0 || typeof a.end !== "number" || !Number.isInteger(a.end) || a.end - a.start < 12) throw new Error("commentary graphic needs start/end in frames, at least 12 frames apart");
  return [a.start, a.end];
}
export function textStyle(height: number, size = 72): Args {
  const k = height / 1080;
  return { font: "Akwe Pro", weight: 700, size: size * k, color: [1, 1, 1, 1],
    glow: { enabled: true, radius: 9 * k, strength: 0.28 },
    shadow: { color: [0, 0, 0, 1], opacity: 0.85, distance: 5 * k, angle: 90, size: 2 * k, blur: 8 * k }, max_width: 1560 * k };
}

/** Selective emphasis. Full phrase geometry is stable during the soft sweep. */
export function text(p: Project, a: Args): Args {
  const [start, end] = span(a); const d = end - start; const h = p.settings.height;
  if (typeof a.text !== "string" || a.text.trim() === "") throw new Error("commentary_text needs text");
  const made: string[] = [];
  // Opt-in: blurring by default put 58% of the N3on trial's narration under a
  // dimmed blur, hiding the B-roll the phrase was meant to sit on.
  if (a.blur === true) made.push(push(p, { type: "adjustment", name: "Janitor · text backdrop", start, duration: d,
    blur: { radius: 22 * h / 1080 }, grade: { exposure: -0.7, vignette: 0.35 }, fade_in: 8, fade_out: 8 }));
  const preset = ["soft", "typewriter", "slide", "pop"].includes(String(a.motion)) ? String(a.motion) : "soft";
  const y = number(a, "y", 0); const size = number(a, "size", 76);
  const settle = Math.min(22, Math.floor(d / 3));
  const id = push(p, { type: "text", name: "Janitor · emphasis", text: a.text, start, duration: d,
    fade_out: Math.min(9, d / 4), style: { ...textStyle(h, size), ...(a.align === "left" ? { align: "left" } : {}),
      ...(a.box === true ? { background: { color: [0, 0, 0, 1], opacity: 1, pad_x: 18, pad_y: 10 } } : {}) },
    transform: { x: number(a, "x", 0), y },
    animation: { preset: preset === "slide" || preset === "pop" ? "none" : preset, duration: 9, stagger: preset === "typewriter" ? 0.8 : 0.7 },
    keyframes: preset === "slide" ? { y: [...arrival(y + 120 * h / 1080, y, settle), key(d - 1, y - 8 * h / 1080)] } :
      preset === "pop" ? { scale: arrival(0.72, 1, settle) } : { y: [key(0, y + 9), key(d - 1, y - 9)] },
    fade_in: preset === "slide" || preset === "pop" ? 4 : 0 });
  made.push(id); return { text: id, clips: made };
}

/** A source still/video in a white frame, sharp over a blurred copy or brand
 * wallpaper. Source audio is deliberately not added under the narrator. */
export function card(p: Project, a: Args): Args {
  const [start, end] = span(a); const d = end - start; const h = p.settings.height; const w = p.settings.width;
  if (typeof a.media !== "string") throw new Error("commentary_card needs media");
  const m = mediaOf(p, a.media); if (m === undefined || m.kind === "audio") throw new Error("commentary_card needs picture media");
  const source = number(a, "source_in", 0);
  const fit = Math.min(w / Math.max(m.width, 1), h / Math.max(m.height, 1));
  const cover = Math.max(w / (m.width * fit), h / (m.height * fit)) * 1.08;
  const scale = Math.min(number(a, "width", 0.82) * w / (m.width * fit), number(a, "height", 0.77) * h / (m.height * fit));
  const common = { type: "video", media: m.id, source_in: source, start, duration: d };
  const made: string[] = [];
  const bg = typeof a.background === "string" ? mediaOf(p, a.background) : undefined;
  if (a.backdrop !== false) {
    made.push(push(p, { ...common, name: "Janitor · card backdrop", ...(bg ? { media: bg.id, source_in: 0 } : {}), transform: { scale: bg ? 1.06 : cover } }));
    made.push(push(p, { type: "adjustment", name: "Janitor · card backdrop blur", start, duration: d,
      blur: { radius: bg ? 0 : 32 * h / 1080 }, grade: { exposure: -0.65, vignette: 0.35 } }));
  }
  const settle = Math.min(24, Math.floor(d / 3)); const y = number(a, "y", -15 * h / 1080);
  const photo = push(p, { ...common, name: "Janitor · source card", fade_in: 4, fade_out: 5,
    frame: { color: [1, 1, 1, 1], width: 8 * h / 1080, shadow: 0.8, radius: 14 * h / 1080, glow: 0.4 }, transform: { scale, y, x: number(a, "x", 0) },
    keyframes: { y: [...arrival(h * 0.65, y, settle), key(d - 1, y - 6 * h / 1080)], scale: [key(0, scale), key(d - 1, scale * 1.035)] } });
  made.push(photo);
  if (typeof a.label === "string" && a.label.trim()) made.push(push(p, { type: "text", name: "Janitor · source credit", text: a.label,
    start, duration: d, fade_in: 8, fade_out: 6, style: { ...textStyle(h, 27), glow: { enabled: false }, align: "left", max_width: w * 0.87 },
    transform: { x: -w * 0.025, y: h * 0.43 } }));
  return { photo, clips: made };
}

/** Clean chapter slate: no baked-in name from a reference episode. */
export function chapter(p: Project, a: Args): Args {
  const [start, end] = span(a); const h = p.settings.height; const d = end - start;
  if (typeof a.text !== "string" || a.text.trim() === "") throw new Error("commentary_chapter needs text");
  const made = [push(p, { type: "solid", name: "Janitor · chapter backdrop", start, duration: d, fill: [0.025, 0.028, 0.035, 1] })];
  made.push(push(p, { type: "adjustment", name: "Janitor · chapter texture", start, duration: d, grade: { grain: 0.1, vignette: 0.4 } }));
  if (typeof a.number === "string" || typeof a.number === "number") made.push(push(p, { type: "text", name: "Janitor · chapter number", text: `CHAPTER ${String(a.number).padStart(2, "0")}`, start, duration: d,
    style: { ...textStyle(h, 27), color: [0.72, 0.62, 0.43, 1], tracking: 5 }, transform: { y: -h * 0.12 }, animation: { preset: "soft", duration: 8, stagger: 0.5 }, fade_out: 7 }));
  const title = text(p, { ...a, blur: false, size: 86, motion: "slide", y: h * 0.025 });
  return { clips: [...made, ...(title.clips as string[])] };
}

export function narrationLook(p: Project, a: Args): Args {
  const [start, end] = span(a);
  const voices = new Set((p.script?.blocks ?? []).flatMap((b) => b.kind === "narration" && b.voiceover ? [b.voiceover] : []));
  let ranges: [number, number][] = p.clips.filter((c) => voices.has(c.id) && c.start < end && clipEnd(c) > start).map((c) => [Math.max(start, c.start), Math.min(end, clipEnd(c))]);
  if (!ranges.length) throw new Error("commentary_look needs placed narration in this span");
  for (const c of p.clips.filter((c) => c.name === "Janitor · chapter texture" || c.name === "Janitor · narration look")) {
    ranges = ranges.flatMap(([from, to]) => c.start >= to || clipEnd(c) <= from ? [[from, to]] : [
      ...(c.start > from ? [[from, c.start] as [number, number]] : []), ...(clipEnd(c) < to ? [[clipEnd(c), to] as [number, number]] : []),
    ]);
  }
  const clips = ranges.filter(([from, to]) => to > from).map(([from, to]) => push(p, { type: "adjustment", name: "Janitor · narration look", start: from, duration: to - from,
    grade: { grain: 0.1, vignette: 0.25, saturation: -0.04 }, fade_in: 4, fade_out: 4 }));
  return { clips, clip: clips[0] ?? null };
}

/** A portrait and genuinely left-aligned list. Lay out the complete final
 * list from the outset; timed words reveal each bullet without recentering. */
export function profile(p: Project, a: Args): Args {
  const [start, end] = span(a); const h = p.settings.height; const w = p.settings.width;
  if (!Array.isArray(a.lines) || a.lines.length < 1 || a.lines.length > 5) throw new Error("commentary_profile needs 1–5 lines [{text,at}] (absolute frames)");
  const lines = a.lines.map((v) => {
    const line = v as Args;
    if (typeof line.text !== "string" || line.text.trim() === "" || typeof line.at !== "number" || !Number.isInteger(line.at) || line.at < start || line.at >= end) throw new Error("each profile line needs text and at inside the graphic's frames");
    return { text: `• ${line.text.trim()}`, at: line.at };
  });
  if (lines.some((v, i) => i > 0 && v.at <= lines[i - 1]!.at)) throw new Error("profile lines must be in increasing cue order");
  const portrait = card(p, { ...a, label: undefined, x: -w * 0.275, y: 0, width: 0.32, height: 0.72 });
  const words = lines.flatMap((line) => line.text.split(/\s+/).map((_, i) => Math.min(end - start - 1, line.at - start + i * 2)));
  const id = push(p, { type: "text", name: "Janitor · profile facts", text: lines.map((l) => l.text).join("\n\n"), start, duration: end - start, fade_out: 8,
    style: { ...textStyle(h, number(a, "size", 56)), align: "left", line_height: 1.25, max_width: w * 0.47 },
    transform: { x: w * 0.2, y: 0 }, animation: { preset: "words", duration: 1, stagger: 1 }, word_times: words });
  const clips = [...portrait.clips as string[], id];
  if (typeof a.name === "string" && a.name.trim()) clips.push(push(p, { type: "text", name: "Janitor · profile name", text: a.name, start, duration: end - start,
    style: { ...textStyle(h, 38), max_width: w * 0.34 }, transform: { x: -w * 0.275, y: h * 0.42 }, animation: { preset: "soft", duration: 8, stagger: 0.7 }, fade_out: 8 }));
  return { portrait: portrait.photo, facts: id, clips };
}
