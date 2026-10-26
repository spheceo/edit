// Internet Janitor's compositions as editable layers. Shared core Bezier
// evaluation means these moves match in the browser and native/cloud export.
import { clipFrom } from "./clips.ts";
import type { Project } from "./model.ts";
import { native } from "./native/index.ts";
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

// Geist, which the renderer lets us measure, for compositions anchored at a
// left edge (a centred text block can't be lined up otherwise).
const UI = "Geist";
function measured(text: string, size: number, weight: number): number {
  return native().textBlock(text, size, weight, 1.2)[0];
}
/** A left-aligned Geist line whose left edge is at `left` (project px from centre). */
function uiLine(p: Project, a: { text: string; start: number; end: number; left: number; y: number; size: number; weight?: number; color?: number[]; name: string; fade?: number; glow?: boolean; box?: boolean }): string {
  const weight = a.weight ?? 600; const width = measured(a.text, a.size, weight);
  const k = p.settings.height / 1080;
  return push(p, { type: "text", name: a.name, text: a.text, start: a.start, duration: a.end - a.start, fade_in: a.fade ?? 6, fade_out: 6,
    style: { font: UI, weight, size: a.size, color: a.color ?? [1, 1, 1, 1], tracking: 0, line_height: 1.2, align: "left",
      glow: a.glow ? { enabled: true, radius: 9 * k, strength: 0.3 } : { enabled: false },
      ...(a.box ? { background: { color: [0, 0, 0, 1], opacity: 1, pad_x: 18 * k, pad_y: 8 * k } } : {}) },
    transform: { x: a.left + width / 2, y: a.y } });
}
function dark(p: Project, start: number, end: number, name: string): string[] {
  return [push(p, { type: "solid", name: `${name} backdrop`, start, duration: end - start, fill: [0.075, 0.075, 0.08, 1] }),
    push(p, { type: "adjustment", name: `${name} texture`, start, duration: end - start, grade: { grain: 0.08, vignette: 0.45 } })];
}

/**
 * A referenced YouTube video, as the channel shows one (the team, N3on v1:
 * "a 'screenshot' of the video… some relevant point on the left… pull all the
 * other details from the YouTube API"): the video's frame or thumbnail on the
 * left with its length, its title, views and age, the channel's avatar and
 * name on the right, over the dark channel background. Editorial text below
 * is a separate commentary_text.
 */
export function youtube(p: Project, a: Args): Args {
  const [start, end] = span(a); const d = end - start; const h = p.settings.height; const w = p.settings.width; const k = h / 1080;
  if (typeof a.media !== "string" || typeof a.title !== "string" || typeof a.channel !== "string") throw new Error("commentary_youtube needs media (the video's frame or thumbnail), title and channel (youtube_reference gives them)");
  const m = mediaOf(p, a.media); if (m === undefined || m.kind === "audio") throw new Error("commentary_youtube needs picture media");
  const made = dark(p, start, end, "Janitor · YouTube");
  const fit = Math.min(w / Math.max(m.width, 1), h / Math.max(m.height, 1));
  const thumbW = 0.555 * w; const thumbH = thumbW * 9 / 16;
  const scale = Math.min(thumbW / (m.width * fit), thumbH / (m.height * fit));
  const left = -w / 2 + 50 * k; const cx = left + thumbW / 2; const cy = number(a, "y", -h * 0.08);
  const settle = Math.min(18, Math.floor(d / 3));
  const thumb = push(p, { type: "video", media: m.id, source_in: number(a, "source_in", 0), start, duration: d, name: "Janitor · YouTube frame", fade_in: 5, fade_out: 5,
    frame: { color: [1, 1, 1, 1], width: 0, shadow: 0, radius: 22 * k / scale }, transform: { x: cx, y: cy, scale },
    keyframes: { scale: [...arrival(scale * 0.94, scale, settle), key(d - 1, scale * 1.02)] } });
  made.push(thumb);
  if (typeof a.duration === "string" && a.duration.trim()) {
    const size = 26 * k; const width = measured(a.duration, size, 600);
    made.push(push(p, { type: "text", name: "Janitor · YouTube length", text: a.duration, start, duration: d, fade_in: 8, fade_out: 5,
      style: { font: UI, weight: 600, size, color: [1, 1, 1, 1], tracking: 0, line_height: 1.2, glow: { enabled: false }, background: { color: [0, 0, 0, 1], opacity: 0.8, pad_x: 9 * k, pad_y: 5 * k } },
      transform: { x: cx + thumbW / 2 - 24 * k - width / 2, y: cy + thumbH / 2 - 34 * k } }));
  }
  const col = cx + thumbW / 2 + 40 * k; const room = w / 2 - 40 * k - col;
  const titleSize = 44 * k;
  const lines = native().textLines(a.title, UI, 600, titleSize, 0, room).slice(0, 3);
  let y = cy - thumbH / 2 + 30 * k;
  const step = (size: number) => size * 1.25;
  for (const line of lines) { made.push(uiLine(p, { text: line, start: start + 4, end, left: col, y, size: titleSize, name: "Janitor · YouTube title" })); y += step(titleSize); }
  const meta = typeof a.meta === "string" && a.meta.trim() ? a.meta : null;
  if (meta) { y += 6 * k; made.push(uiLine(p, { text: meta, start: start + 6, end, left: col, y, size: 30 * k, weight: 400, color: [0.67, 0.67, 0.67, 1], name: "Janitor · YouTube views" })); y += step(30 * k); }
  y += 34 * k;
  const avatar = typeof a.avatar === "string" ? mediaOf(p, a.avatar) : undefined; const size = 58 * k;
  let nameLeft = col;
  if (avatar !== undefined && avatar.kind === "image") {
    const af = Math.min(w / Math.max(avatar.width, 1), h / Math.max(avatar.height, 1)); const as = size / (Math.max(avatar.width, avatar.height) * af);
    made.push(push(p, { type: "video", media: avatar.id, source_in: 0, start: start + 8, duration: d - 8, name: "Janitor · YouTube avatar", fade_in: 6, fade_out: 5,
      // A frame's radius is in the picture's own fitted pixels, before its scale.
      frame: { color: [1, 1, 1, 1], width: 0, shadow: 0, radius: size / 2 / as }, transform: { x: col + size / 2, y, scale: as } }));
    nameLeft = col + size + 18 * k;
  }
  made.push(uiLine(p, { text: a.channel, start: start + 8, end, left: nameLeft, y, size: 30 * k, weight: 500, color: [0.85, 0.85, 0.85, 1], name: "Janitor · YouTube channel" }));
  return { frame: thumb, clips: made };
}

/**
 * A corner label pointing out what's on screen, white on a black box (the
 * reference's "*COMPLETE CRASHOUT*" over Kai Cenat sped up 2x): comedy by
 * stating the obvious, used where a beat earns it, never as a caption.
 */
export function label(p: Project, a: Args): Args {
  const [start, end] = span(a); const h = p.settings.height; const w = p.settings.width; const k = h / 1080;
  if (typeof a.text !== "string" || a.text.trim() === "") throw new Error("commentary_label needs text");
  const size = number(a, "size", 74) * k; const text = a.text.trim();
  const right = a.corner === "top_right";
  const width = measured(text, size, 800);
  const x = right ? w / 2 - 36 * k - width / 2 : -w / 2 + 36 * k + width / 2;
  const id = push(p, { type: "text", name: "Janitor · corner label", text, start, duration: end - start, fade_in: 0, fade_out: 0,
    style: { font: UI, weight: 800, size, color: [1, 1, 1, 1], tracking: 0, line_height: 1.1, glow: { enabled: true, radius: 8 * k, strength: 0.3 },
      background: { color: [0, 0, 0, 1], opacity: 1, pad_x: 20 * k, pad_y: 10 * k } },
    transform: { x, y: -h / 2 + 34 * k + size * 0.6 } });
  return { clip: id, clips: [id] };
}

/**
 * The channel bumper: the Internet Janitor avatar, name, tagline and a
 * Subscribe button over the dark channel page, with the intro's line under
 * it ("CLEANING UP THE BIGGEST STREAM ON TWITCH" / "(among many other
 * charges)"). Brand media come from search_broll {queries:[]}.
 */
export function bumper(p: Project, a: Args): Args {
  const [start, end] = span(a); const d = end - start; const h = p.settings.height; const w = p.settings.width; const k = h / 1080;
  const avatar = typeof a.avatar === "string" ? mediaOf(p, a.avatar) : undefined;
  if (avatar === undefined || avatar.kind !== "image") throw new Error("commentary_bumper needs avatar: search_broll {queries:[]}'s brand_avatar");
  const made = dark(p, start, end, "Janitor · bumper");
  const size = 300 * k; const cy = -h * 0.12; const ax = -w * 0.3;
  const af = Math.min(w / Math.max(avatar.width, 1), h / Math.max(avatar.height, 1)); const base = size / (Math.max(avatar.width, avatar.height) * af);
  const settle = Math.min(18, Math.floor(d / 3));
  made.push(push(p, { type: "video", media: avatar.id, source_in: 0, start, duration: d, name: "Janitor · bumper avatar", fade_in: 4, fade_out: 6,
    frame: { color: [1, 1, 1, 1], width: 0, shadow: 0, radius: size / 2 / base }, transform: { x: ax, y: cy, scale: base },
    keyframes: { scale: [...arrival(base * 0.85, base, settle), key(d - 1, base * 1.03)] } }));
  const left = ax + size / 2 + 60 * k;
  made.push(uiLine(p, { text: typeof a.name === "string" ? a.name : "InternetJanitor", start: start + 3, end, left, y: cy - 70 * k, size: 112 * k, weight: 700, name: "Janitor · bumper name", glow: true }));
  made.push(uiLine(p, { text: typeof a.tagline === "string" ? a.tagline : "Cleaning up the internet, one disaster at a time.", start: start + 6, end, left, y: cy + 22 * k, size: 34 * k, weight: 400, color: [0.75, 0.75, 0.75, 1], name: "Janitor · bumper tagline" }));
  const button = typeof a.subscribe === "string" ? mediaOf(p, a.subscribe) : undefined;
  if (button !== undefined && button.kind === "image") {
    const bw = 230 * k; const bf = Math.min(w / Math.max(button.width, 1), h / Math.max(button.height, 1)); const bs = bw / (button.width * bf);
    made.push(push(p, { type: "video", media: button.id, source_in: 0, start: start + 9, duration: d - 9, name: "Janitor · bumper subscribe", fade_in: 4, fade_out: 6,
      frame: { color: [1, 1, 1, 1], width: 0, shadow: 0, radius: (bw * button.height / button.width) / 2 / bs }, transform: { x: left + bw / 2, y: cy + 110 * k, scale: bs } }));
  }
  if (typeof a.line === "string" && a.line.trim()) made.push(...(text(p, { text: a.line.trim().toUpperCase(), start: start + 6, end, size: 64, motion: "soft", y: h * 0.32 }).clips as string[]));
  if (typeof a.subline === "string" && a.subline.trim()) made.push(...(text(p, { text: a.subline.trim(), start: start + 18, end, size: 42, motion: "soft", y: h * 0.4 }).clips as string[]));
  return { clips: made };
}

/**
 * Punch-ins for emphasis: the shot cuts to a closer framing at each word
 * that earns it and holds there, no animated zoom (the team, N3on v1: "it
 * just cuts it and zooms in… punch-in, punch-in, and punch-in again. It is
 * chosen so carefully based on what is being said"). `at` are timeline
 * frames inside the clip; `scales` the framing after each (default +12% a
 * step); `x`/`y` the point to close in on (project px from centre).
 */
export function punch(p: Project, a: Args): Args {
  const c = p.clips.find((one) => one.id === a.clip);
  if (c?.type !== "video") throw new Error("commentary_punch needs clip: a video clip id");
  if (!Array.isArray(a.at) || a.at.length < 1 || a.at.length > 4 || a.at.some((f) => typeof f !== "number" || !Number.isInteger(f) || f <= c.start || f >= clipEnd(c))) throw new Error("commentary_punch needs at: 1–4 timeline frames inside the clip");
  const at = [...(a.at as number[])].sort((x, y) => x - y);
  if (at.some((f, i) => i > 0 && f - at[i - 1]! < 12)) throw new Error("punch-ins need at least 12 frames between them");
  const s0 = c.transform.scale; const fx = number(a, "x", 0); const fy = number(a, "y", 0);
  const scales = Array.isArray(a.scales) && a.scales.length === at.length && a.scales.every((v) => typeof v === "number" && v >= 1 && v <= 2.5) ? a.scales as number[] : at.map((_, i) => 1 + 0.12 * (i + 1));
  // Hold keys: the framing jumps on the frame, as a cut does. The point
  // closed in on stays where it was.
  const keys = (pick: (s: number) => number, base: number) => [key(0, base, "hold"), ...at.map((f, i) => key(f - c.start, pick(scales[i]!), "hold"))];
  const kf = { ...(c.keyframes ?? {}) } as Record<string, unknown>;
  kf.scale = keys((s) => s0 * s, s0);
  kf.x = keys((s) => c.transform.x - fx * (s - 1), c.transform.x);
  kf.y = keys((s) => c.transform.y - fy * (s - 1), c.transform.y);
  (c as { keyframes?: unknown }).keyframes = kf;
  return { clip: c.id, punches: at.length };
}

/**
 * The reference's light leak: the real stock film burn the channel uses
 * (58 in one Evil Design episode), rotated to landscape, Screen-blended, at
 * 350%, 10 frames into the cut and 12 after it (assets/ae-forensics.md).
 * `media` is search_broll {queries:[]}'s brand_light_leak; put a soft
 * whoosh or shutter on the cut with it.
 */
export function leak(p: Project, a: Args): Args {
  const at = a.at; const fps = p.settings.fps; const w = p.settings.width; const h = p.settings.height;
  if (typeof at !== "number" || !Number.isInteger(at) || at < 10) throw new Error("commentary_leak needs at: the cut's timeline frame");
  const m = typeof a.media === "string" ? mediaOf(p, a.media) : undefined;
  if (m === undefined || m.kind !== "video") throw new Error("commentary_leak needs media: search_broll {queries:[]}'s brand_light_leak");
  // Portrait stock turned 90°: its height becomes the frame's width.
  const fit = Math.min(w / Math.max(m.width, 1), h / Math.max(m.height, 1));
  const scale = Math.max(w / (m.height * fit), h / (m.width * fit));
  const before = Math.round(10 * fps / 29.97); const after = Math.round(12 * fps / 29.97);
  const id = push(p, { type: "video", media: m.id, name: "Janitor · light leak", source_in: 77 / 24, speed: 3.5, start: at - before, duration: before + after,
    blend: "screen", transform: { x: 0, y: 0, scale, rotation: 90 } });
  return { clip: id, clips: [id] };
}
