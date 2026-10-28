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
    glow: { enabled: true, radius: 9 * k, strength: 0.3 },
    // The guide's look: a crisp dark shadow down and to the right, the text
    // grown a little under it like a slight outer stroke, over a soft glow.
    shadow: { color: [0, 0, 0, 1], opacity: 0.9, distance: 5 * k, angle: 135, size: 2.5 * k, blur: 2.5 * k }, max_width: 1560 * k };
}

/** Pure red, the reference's colour for the critical words ("EXAMPLES OF BAD VIDEOS"). */
const RED = [1, 0, 0, 1];

/**
 * Selective emphasis. By default the phrase pops up whole, scaling from small
 * with the guide's ease, over the picture already blurred behind it (the
 * team, N3on v1: "We can make the text pop up seem a lot more clean. It
 * looks really cheaply made now": the words had been up over sharp footage
 * before the blur came in, and a phrase with red words swept in as separate
 * pieces). A short phrase is bigger. soft/typewriter sweep the letters in.
 */
export function text(p: Project, a: Args): Args {
  const [start, end] = span(a); const d = end - start; const h = p.settings.height;
  if (typeof a.text !== "string" || a.text.trim() === "") throw new Error("commentary_text needs text");
  const made: string[] = [];
  // Opt-in: blurring by default put 58% of the N3on trial's narration under a
  // dimmed blur, hiding the B-roll the phrase was meant to sit on.
  const blurred = a.blur === true;
  if (blurred) made.push(push(p, { type: "adjustment", name: "Janitor · text backdrop", start, duration: d,
    blur: { radius: 16 * h / 1080 }, grade: { exposure: -0.45, vignette: 0.3 }, fade_in: 6, fade_out: 8 }));
  // The words arrive once the picture behind them has gone soft.
  const from = blurred ? Math.min(start + 5, end - 12) : start; const dd = end - from;
  const preset = ["soft", "typewriter", "slide", "pop"].includes(String(a.motion)) ? String(a.motion) : "pop";
  // Big, as the guide's emphasis is; a short phrase bigger still.
  const size = number(a, "size", a.text.trim().length <= 16 ? 120 : 96); const y = number(a, "y", 0); const k = h / 1080;
  const settle = Math.min(14, Math.floor(dd / 3));
  // gx: the group's middle, which pieces of one phrase scale about together.
  const gx = number(a, "x", 0);
  const layer = (words: string, x: number, color: number[] | undefined, delay: number) => push(p, { type: "text", name: "Janitor · emphasis", text: words, start: from + delay, duration: dd - delay,
    fade_out: Math.min(9, dd / 4), style: { ...textStyle(h, size), ...(color ? { color } : {}), ...(a.align === "left" ? { align: "left" } : {}),
      ...(a.box === true ? { background: { color: [0, 0, 0, 1], opacity: 1, pad_x: 18, pad_y: 10 } } : {}) },
    transform: { x, y },
    animation: { preset: preset === "slide" || preset === "pop" ? "none" : preset, duration: 9, stagger: preset === "typewriter" ? 0.8 : 0.7 },
    keyframes: preset === "slide" ? { y: [...arrival(y + 120 * k, y, settle), key(dd - 1, y - 8 * k)] } :
      preset === "pop" ? { scale: [...arrival(0.55, 1, settle), key(dd - 1, 1.03)], x: [...arrival(gx + (x - gx) * 0.55, x, settle), key(dd - 1, gx + (x - gx) * 1.03)] }
        : { y: [key(0, y + 9), key(dd - 1 - delay, y - 9)] },
    fade_in: preset === "slide" || preset === "pop" ? 5 : 0 });
  // Red for the critical words: the phrase in pieces side by side, laid out as one centred line.
  const red = Array.isArray(a.red) ? a.red.filter((v): v is string => typeof v === "string" && v.trim() !== "") : [];
  const pieces: [string, boolean][] = [];
  let rest = a.text;
  for (const want of red) {
    const at = rest.toUpperCase().indexOf(want.toUpperCase());
    if (at < 0) throw new Error(`red "${want}" isn't in the text`);
    if (at > 0) pieces.push([rest.slice(0, at), false]);
    pieces.push([rest.slice(at, at + want.length), true]); rest = rest.slice(at + want.length);
  }
  if (rest) pieces.push([rest, false]);
  const kept = pieces.filter(([words]) => words.trim() !== "");
  const space = red.length ? widthOf("A A", "Akwe Pro", 700, size * k) - widthOf("AA", "Akwe Pro", 700, size * k) : 0;
  const widths = kept.map(([words]) => widthOf(words.trim(), "Akwe Pro", 700, size * k));
  // A space between pieces where the phrase had one.
  const gaps = kept.map(([words], i) => (i > 0 && (/^\s/u.test(words) || /\s$/u.test(kept[i - 1]![0])) ? space : 0));
  const total = widths.reduce((sum, v) => sum + v, 0) + gaps.reduce((sum, v) => sum + v, 0);
  if (red.length === 0 || total > 1560 * k) {
    made.push(layer(a.text, gx, undefined, 0));
  } else {
    // A letter sweep carries on from one piece into the next; a pop or slide moves them together.
    let left = gx - total / 2; let delay = 0;
    kept.forEach(([words, isRed], i) => {
      left += gaps[i]!; made.push(layer(words.trim(), left + widths[i]! / 2, isRed ? RED : undefined, preset === "soft" || preset === "typewriter" ? delay : 0));
      left += widths[i]!; delay += Math.round(words.trim().length * 0.7);
    });
  }
  return { text: made[made.length - 1], clips: made };
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
    // push: the guide's variant that zooms into the picture while it's highlighted ("to keep the composition a bit more dynamic").
    keyframes: { y: [...arrival(h * 0.65, y, settle), key(d - 1, y - 6 * h / 1080)], scale: [key(0, scale), key(d - 1, scale * Math.min(Math.max(number(a, "push", 1.035), 1), 1.4))] } });
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
    return { text: `- ${line.text.trim().toUpperCase()}`, at: line.at };
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

// Compositions anchored at a left edge are laid out with measured text (a
// centred block can't be lined up otherwise): Geist directly, any font by
// finding the narrowest width it stays on one line, as the renderer wraps it.
const UI = "Geist";
const GUIDE = "Akwe Pro";
export function widthOf(text: string, font: string, weight: number, size: number): number {
  if (text === "") return 0;
  if (font === UI) return native().textBlock(text, size, weight, 1.2)[0];
  let [low, high] = [1, size * text.length + 8];
  while (high - low > 0.5) {
    const mid = (low + high) / 2;
    if (native().textLines(text, font, weight, size, 0, mid).length <= 1) high = mid; else low = mid;
  }
  return high;
}
function measured(text: string, size: number, weight: number): number {
  return widthOf(text, UI, weight, size);
}
type Line = { text: string; start: number; end: number; left: number; y: number; size: number; weight?: number; font?: string; color?: number[]; name: string; fade?: number; glow?: boolean; box?: boolean; enter?: number };
/** A left-aligned line whose left edge is at `left` (project px from centre), sliding in `enter` px with a strong ease-out. */
function uiLine(p: Project, a: Line): string {
  const weight = a.weight ?? 600; const font = a.font ?? UI; const width = widthOf(a.text, font, weight, a.size);
  const k = p.settings.height / 1080; const x = a.left + width / 2; const d = a.end - a.start;
  const enter = a.enter ?? 0; const settle = Math.min(16, Math.floor(d / 3));
  return push(p, { type: "text", name: a.name, text: a.text, start: a.start, duration: d, fade_in: a.fade ?? 6, fade_out: 6,
    style: { font, weight, size: a.size, color: a.color ?? [1, 1, 1, 1], tracking: 0, line_height: 1.2, align: "left",
      glow: a.glow ? { enabled: true, radius: 9 * k, strength: 0.3 } : { enabled: false },
      shadow: { color: [0, 0, 0, 1], opacity: 0.6, distance: 3 * k, angle: 90, size: 1 * k, blur: 6 * k },
      ...(a.box ? { background: { color: [0, 0, 0, 1], opacity: 1, pad_x: 18 * k, pad_y: 8 * k } } : {}) },
    transform: { x, y: a.y }, ...(enter !== 0 ? { keyframes: { x: arrival(x + enter * k, x, settle) } } : {}) });
}
function dark(p: Project, start: number, end: number, name: string): string[] {
  // The channel's grey page: lighter in the middle, the vignette darkening its edges.
  return [push(p, { type: "solid", name: `${name} backdrop`, start, duration: end - start, fill: [0.11, 0.11, 0.115, 1] }),
    push(p, { type: "adjustment", name: `${name} texture`, start, duration: end - start, grade: { grain: 0.08, vignette: 0.55 } })];
}
/** A picture fitted into a w×h box at (x, y), rounded, sliding in from the left. */
function framed(p: Project, a: { media: string; source_in?: number; start: number; end: number; x: number; y: number; width: number; height: number; name: string; radius: number; enter?: number }): string {
  const m = mediaOf(p, a.media)!; const w = p.settings.width; const h = p.settings.height; const k = h / 1080; const d = a.end - a.start;
  const fit = Math.min(w / Math.max(m.width, 1), h / Math.max(m.height, 1));
  const scale = Math.min(a.width / (m.width * fit), a.height / (m.height * fit));
  const settle = Math.min(18, Math.floor(d / 3)); const from = a.x - (a.enter ?? 90) * k;
  return push(p, { type: "video", media: m.id, source_in: a.source_in ?? 0, start: a.start, duration: d, name: a.name, fade_in: 6, fade_out: 5,
    // A frame's radius is in the picture's own fitted pixels, before its scale.
    frame: { color: [1, 1, 1, 1], width: 0, shadow: 0, radius: a.radius / scale }, transform: { x: a.x, y: a.y, scale },
    keyframes: { x: arrival(from, a.x, settle), scale: [key(0, scale), key(d - 1, scale * 1.02)] } });
}
/** A region cut from a screenshot (still_frame crop): a video's frame cut that way already shows its own length. */
function screenshotCut(p: Project, id: unknown): boolean {
  return typeof id === "string" && / \d+-\d+-\d+x\d+\.png$/u.test(mediaOf(p, id)?.name ?? "");
}
function picture(p: Project, id: unknown, what: string): NonNullable<ReturnType<typeof mediaOf>> {
  const m = typeof id === "string" ? mediaOf(p, id) : undefined;
  if (m === undefined || m.kind === "audio") throw new Error(`${what} needs picture media`);
  return m;
}

/**
 * A referenced YouTube video as the channel shows one (the team, N3on v1:
 * "a 'screenshot' of the video… some relevant point on the left… pull all the
 * other details from the YouTube API"; v1 revision: "we would like this
 * centered… change the fonts to match the guide… having the video frame on
 * the left animate in"): the video's frame, its length, title, views and age,
 * the channel's avatar and name, centred as one group over the dark channel
 * background. The details come from youtube_reference, or are read off a
 * screenshot when the original is gone (still_frame crop gives its frame).
 */
export function youtube(p: Project, a: Args): Args {
  const [start, end] = span(a); const d = end - start; const h = p.settings.height; const w = p.settings.width; const k = h / 1080;
  if (typeof a.title !== "string" || typeof a.channel !== "string") throw new Error("commentary_youtube needs media (the video's frame or thumbnail), title and channel (youtube_reference gives them)");
  const m = picture(p, a.media, "commentary_youtube");
  const made = dark(p, start, end, "Janitor · YouTube");
  const thumbW = 0.5 * w; const thumbH = thumbW * 9 / 16; const gap = 44 * k;
  const titleSize = 50 * k; const metaSize = 30 * k; const chanSize = 32 * k; const avatarSize = 58 * k;
  const lines = native().textLines(a.title, GUIDE, 700, titleSize, 0, 0.36 * w).slice(0, 3);
  const meta = typeof a.meta === "string" && a.meta.trim() ? a.meta.trim() : null;
  const avatar = typeof a.avatar === "string" ? mediaOf(p, a.avatar) : undefined;
  const chanLeftPad = avatar?.kind === "image" ? avatarSize + 18 * k : 0;
  const textW = Math.max(...lines.map((one) => widthOf(one, GUIDE, 700, titleSize)), meta ? measured(meta, metaSize, 400) : 0, chanLeftPad + widthOf(a.channel, GUIDE, 700, chanSize));
  const left = -(thumbW + gap + textW) / 2; const cx = left + thumbW / 2; const col = left + thumbW + gap; const cy = number(a, "y", -h * 0.06);
  const thumb = framed(p, { media: m.id, source_in: number(a, "source_in", 0), start, end, x: cx, y: cy, width: thumbW, height: thumbH, name: "Janitor · YouTube frame", radius: 22 * k });
  made.push(thumb);
  // "On these image thumbnails, there already is a time, and now we're adding the time ourselves."
  if (typeof a.duration === "string" && a.duration.trim() && !screenshotCut(p, a.media)) {
    const size = 26 * k; const width = measured(a.duration, size, 600);
    made.push(push(p, { type: "text", name: "Janitor · YouTube length", text: a.duration, start: start + 10, duration: d - 10, fade_in: 6, fade_out: 5,
      style: { font: UI, weight: 600, size, color: [1, 1, 1, 1], tracking: 0, line_height: 1.2, glow: { enabled: false }, background: { color: [0, 0, 0, 1], opacity: 0.8, pad_x: 9 * k, pad_y: 5 * k } },
      transform: { x: cx + thumbW / 2 - 24 * k - width / 2, y: cy + thumbH / 2 - 34 * k } }));
  }
  let y = cy - thumbH / 2 + 34 * k;
  lines.forEach((one, i) => { made.push(uiLine(p, { text: one, font: GUIDE, weight: 700, start: start + 5 + 2 * i, end, left: col, y, size: titleSize, name: "Janitor · YouTube title", enter: 36 })); y += titleSize * 1.22; });
  if (meta) { y += 8 * k; made.push(uiLine(p, { text: meta, start: start + 9, end, left: col, y, size: metaSize, weight: 400, color: [0.68, 0.68, 0.68, 1], name: "Janitor · YouTube views", enter: 36 })); y += metaSize * 1.3; }
  y += 36 * k;
  if (avatar !== undefined && avatar.kind === "image") made.push(framed(p, { media: avatar.id, start: start + 12, end, x: col + avatarSize / 2, y, width: avatarSize, height: avatarSize, name: "Janitor · YouTube avatar", radius: avatarSize / 2, enter: 36 }));
  made.push(uiLine(p, { text: a.channel, font: GUIDE, weight: 700, start: start + 12, end, left: col + chanLeftPad, y, size: chanSize, color: [0.88, 0.88, 0.88, 1], name: "Janitor · YouTube channel", enter: 36 }));
  return { frame: thumb, clips: made };
}

/**
 * Several of a channel's videos as its page lists them (the fake-death
 * uploads: "He's Gone… (R.I.P)", "YOU GUYS WILL NOT BE SEEING N3ON
 * ANYMORE…", "I'm Alive…"), rebuilt from a screenshot in the channel style:
 * each row's frame, title and "1 month ago · 384K views", rows arriving one
 * after another.
 */
export function youtubeList(p: Project, a: Args): Args {
  const [start, end] = span(a); const h = p.settings.height; const w = p.settings.width; const k = h / 1080;
  if (!Array.isArray(a.items) || a.items.length < 2 || a.items.length > 4) throw new Error("commentary_youtube_list needs 2–4 items [{media,source_in?,title,meta?,duration?}]");
  const items = a.items.map((v) => { const one = v as Args; if (typeof one.title !== "string") throw new Error("each list item needs a title"); picture(p, one.media, "each list item"); return one; });
  const made = dark(p, start, end, "Janitor · YouTube list");
  const rowH = Math.min(250 * k, (h * 0.86) / items.length); const thumbH = rowH - 34 * k; const thumbW = thumbH * 16 / 9;
  const titleSize = 44 * k; const metaSize = 28 * k; const gap = 36 * k;
  const laid = items.map((one) => ({ one, lines: native().textLines(one.title as string, GUIDE, 700, titleSize, 0, 0.4 * w).slice(0, 2) }));
  const textW = Math.max(...laid.flatMap(({ one, lines }) => [...lines.map((l) => widthOf(l, GUIDE, 700, titleSize)), typeof one.meta === "string" ? measured(one.meta, metaSize, 400) : 0]));
  const left = -(thumbW + gap + textW) / 2; const top = -(rowH * items.length) / 2;
  laid.forEach(({ one, lines }, i) => {
    const at = start + 6 * i; const cy = top + rowH * i + rowH / 2; const cx = left + thumbW / 2;
    made.push(framed(p, { media: one.media as string, source_in: typeof one.source_in === "number" ? one.source_in : 0, start: at, end, x: cx, y: cy, width: thumbW, height: thumbH, name: "Janitor · YouTube frame", radius: 18 * k }));
    if (typeof one.duration === "string" && one.duration.trim() && !screenshotCut(p, one.media)) {
      const size = 22 * k; const width = measured(one.duration, size, 600);
      made.push(push(p, { type: "text", name: "Janitor · YouTube length", text: one.duration, start: at + 8, duration: end - at - 8, fade_in: 6, fade_out: 5,
        style: { font: UI, weight: 600, size, color: [1, 1, 1, 1], tracking: 0, line_height: 1.2, glow: { enabled: false }, background: { color: [0, 0, 0, 1], opacity: 0.8, pad_x: 8 * k, pad_y: 4 * k } },
        transform: { x: cx + thumbW / 2 - 18 * k - width / 2, y: cy + thumbH / 2 - 26 * k } }));
    }
    let y = cy - thumbH / 2 + 28 * k;
    lines.forEach((l) => { made.push(uiLine(p, { text: l, font: GUIDE, weight: 700, start: at + 4, end, left: left + thumbW + gap, y, size: titleSize, name: "Janitor · YouTube title", enter: 30 })); y += titleSize * 1.2; });
    if (typeof one.meta === "string" && one.meta.trim()) made.push(uiLine(p, { text: one.meta.trim(), start: at + 7, end, left: left + thumbW + gap, y: y + 6 * k, size: metaSize, weight: 400, color: [0.68, 0.68, 0.68, 1], name: "Janitor · YouTube views", enter: 30 }));
  });
  return { clips: made };
}

/**
 * A post on X rebuilt as our own graphic (the team, N3on v1 revision: "recreate
 * the sort of Twitter UI here ourselves and maybe have a tiny bit of an
 * animation… because it would be our own, the text would be much higher
 * quality"): avatar, name, handle and time, the post's words and its picture,
 * rising in together over the dark background. `highlight` phrases get a red
 * bar sweeping in behind them ("from threatening to … a fan"); the bars are
 * images the commentary_tweet tool draws from `inkRects`.
 */
export function tweetLayout(p: Project, a: Args): { rects: { x: number; y: number; width: number; height: number }[]; lines: string[]; size: number; left: number; textTop: number; lineH: number; cardW: number; top: number; mediaH: number; room: number } {
  const h = p.settings.height; const w = p.settings.width; const k = h / 1080;
  if (typeof a.text !== "string" || a.text.trim() === "" || typeof a.name !== "string") throw new Error("commentary_tweet needs name and text (tweet_reference gives them, or read them off the screenshot)");
  const media = typeof a.media === "string" ? mediaOf(p, a.media) : undefined;
  const size = 50 * k; const room = 0.62 * w;
  const lines = native().textLines(a.text.trim(), UI, 500, size, 0, room);
  const block = native().textBlock(lines.join("\n"), size, 500, 1.3); const lineH = block[1] / Math.max(lines.length, 1);
  let mediaH = 0; let mediaW = 0;
  if (media !== undefined && media.kind !== "audio") {
    const aspect = Math.max(media.width, 1) / Math.max(media.height, 1);
    mediaH = Math.min(0.4 * h, room / aspect); mediaW = mediaH * aspect;
  }
  // The card is as wide as what's in it, centred.
  const cardW = Math.max(block[0], mediaW, 88 * k + 22 * k + measured(a.name, 40 * k, 700)); const left = -cardW / 2;
  const headH = 90 * k; const gap = 28 * k;
  const total = headH + gap + block[1] + (mediaH > 0 ? gap + mediaH : 0);
  const top = -total / 2; const textTop = top + headH + gap;
  // Each phrase's bar, line by line, in canvas pixels from the top left.
  const rects: { x: number; y: number; width: number; height: number }[] = [];
  const phrases = Array.isArray(a.highlight) ? a.highlight.filter((v): v is string => typeof v === "string" && v.trim() !== "") : [];
  const starts: number[] = []; let at = 0; for (const one of lines) { starts.push(at); at += one.length + 1; }
  const joined = lines.join(" ");
  for (const phrase of phrases) {
    const found = joined.toLowerCase().indexOf(phrase.trim().toLowerCase());
    if (found < 0) throw new Error(`highlight "${phrase}" isn't in the post's text as written`);
    const stop = found + phrase.trim().length;
    lines.forEach((one, i) => {
      const from = Math.max(found, starts[i]!) - starts[i]!; const to = Math.min(stop, starts[i]! + one.length) - starts[i]!;
      if (to <= from) return;
      const x0 = left + measured(one.slice(0, from), size, 500); const x1 = left + measured(one.slice(0, to), size, 500);
      const pad = 8 * k;
      rects.push({ x: Math.max(0, Math.round(w / 2 + x0 - pad)), y: Math.max(0, Math.round(h / 2 + textTop + i * lineH + (lineH - size * 1.2) / 2)), width: Math.round(x1 - x0 + 2 * pad), height: Math.round(size * 1.2) });
    });
  }
  return { rects, lines, size, left, textTop, lineH, cardW, top, mediaH, room };
}

export function tweet(p: Project, a: Args, inks: string[]): Args {
  const [start, end] = span(a); const d = end - start; const h = p.settings.height; const w = p.settings.width; const k = h / 1080;
  const L = tweetLayout(p, a);
  const made = dark(p, start, end, "Janitor · post");
  const settle = Math.min(16, Math.floor(d / 3));
  // Everything rises the same 40 px together, so the post arrives as one card.
  const rise = (y: number) => ({ y: arrival(y + 40 * k, y, settle) });
  const avatarSize = 88 * k; const headY = L.top + 45 * k;
  const avatar = typeof a.avatar === "string" ? mediaOf(p, a.avatar) : undefined;
  let nameLeft = L.left;
  if (avatar !== undefined && avatar.kind === "image") {
    const fit = Math.min(w / Math.max(avatar.width, 1), h / Math.max(avatar.height, 1)); const scale = avatarSize / (Math.max(avatar.width, avatar.height) * fit);
    made.push(push(p, { type: "video", media: avatar.id, source_in: 0, start, duration: d, name: "Janitor · post avatar", fade_in: 6, fade_out: 5,
      frame: { color: [1, 1, 1, 1], width: 0, shadow: 0, radius: avatarSize / 2 / scale }, transform: { x: L.left + avatarSize / 2, y: headY, scale }, keyframes: rise(headY) }));
    nameLeft = L.left + avatarSize + 22 * k;
  }
  const text = (t: string, left: number, y: number, size: number, weight: number, color: number[], name: string) => {
    const x = left + measured(t, size, weight) / 2;
    return push(p, { type: "text", name, text: t, start, duration: d, fade_in: 6, fade_out: 5,
      style: { font: UI, weight, size, color, tracking: 0, line_height: 1.3, align: "left", glow: { enabled: false } }, transform: { x, y }, keyframes: rise(y) });
  };
  made.push(text(a.name as string, nameLeft, headY - 20 * k, 40 * k, 700, [1, 1, 1, 1], "Janitor · post name"));
  const handle = [typeof a.handle === "string" ? `@${a.handle.replace(/^@/u, "")}` : null, typeof a.time === "string" ? a.time : null].filter(Boolean).join(" · ");
  if (handle) made.push(text(handle, nameLeft, headY + 24 * k, 32 * k, 400, [0.55, 0.57, 0.6, 1], "Janitor · post handle"));
  // The words as one left-aligned block, laid out exactly as tweetLayout measured them.
  const blockW = Math.max(...L.lines.map((one) => measured(one, L.size, 500)));
  const blockY = L.textTop + (L.lineH * L.lines.length) / 2;
  // The renderer wraps the post's own words at the width they were measured at, so the
  // lines (and the bars on them) hold even when a word is starred later; words joined
  // with newlines lost them when the house words were starred (Duke Dennis's post).
  const words = push(p, { type: "text", name: "Janitor · post text", text: (a.text as string).trim(), start, duration: d, fade_in: 6, fade_out: 5,
    style: { font: UI, weight: 500, size: L.size, color: [0.95, 0.95, 0.95, 1], tracking: 0, line_height: 1.3, align: "left", glow: { enabled: false }, max_width: L.room },
    transform: { x: L.left + blockW / 2, y: blockY }, keyframes: rise(blockY) });
  made.push(words);
  if (L.mediaH > 0 && typeof a.media === "string") {
    const y = L.textTop + L.lineH * L.lines.length + 28 * k + L.mediaH / 2;
    const m = mediaOf(p, a.media)!; const fit = Math.min(w / Math.max(m.width, 1), h / Math.max(m.height, 1));
    const scale = Math.min(L.cardW / (m.width * fit), L.mediaH / (m.height * fit));
    made.push(push(p, { type: "video", media: m.id, source_in: number(a, "source_in", 0), start, duration: d, name: "Janitor · post picture", fade_in: 6, fade_out: 5,
      frame: { color: [1, 1, 1, 1], width: 0, shadow: 0, radius: 24 * k / scale }, transform: { x: L.left + (m.width * fit * scale) / 2, y, scale }, keyframes: rise(y) }));
  }
  // The red bars: drawn in over 12 frames each, one after another, once the post has settled; Screen keeps the white words white over them.
  const draw = 12;
  inks.forEach((ink, i) => {
    const r = L.rects[i]!; const at = start + settle + 4 + i * draw; if (at >= end - 2) return;
    made.push(push(p, { type: "video", media: ink, source_in: 0, start: at, duration: end - at, name: "Janitor · post highlight", blend: "screen", fade_out: 5,
      transform: { x: 0, y: 0, scale: 1 }, crop: { left: 0, top: 0, bottom: 0, right: 1 - r.x / w },
      keyframes: { "crop.right": [key(0, Math.min(0.9999, 1 - r.x / w)), key(draw, Math.max(0, 1 - (r.x + r.width) / w))] } }));
  });
  return { text: words, clips: made };
}

/**
 * Punch-ins for emphasis: the shot cuts to a closer framing at each word
 * that earns it and holds there, no animated zoom (the team, N3on v1: "it
 * just cuts it and zooms in… punch-in, punch-in, and punch-in again. It is
 * chosen so carefully based on what is being said"). Always into the person
 * being talked about (v1 revision: "N3on is on the bottom-left corner. It
 * should be punching into him"): `x`/`y` are that point (project px from
 * centre); `focus: "centre"` only when they're in the middle. `at` are
 * timeline frames inside the clip; `scales` the framing after each (default
 * +15% a step).
 */
export function punch(p: Project, a: Args): Args {
  const c = p.clips.find((one) => one.id === a.clip);
  if (c?.type !== "video") throw new Error("commentary_punch needs clip: a video clip id");
  if (!Array.isArray(a.at) || a.at.length < 1 || a.at.length > 4 || a.at.some((f) => typeof f !== "number" || !Number.isInteger(f) || f <= c.start || f >= clipEnd(c))) throw new Error("commentary_punch needs at: 1–4 timeline frames inside the clip");
  const centred = a.focus === "centre" || a.focus === "center";
  if (!centred && (typeof a.x !== "number" || typeof a.y !== "number")) throw new Error("commentary_punch needs x and y: the person being talked about, in project px from the frame's centre (look at the frame first); focus: \"centre\" only when they're in the middle");
  const at = [...(a.at as number[])].sort((x, y) => x - y);
  if (at.some((f, i) => i > 0 && f - at[i - 1]! < 12)) throw new Error("punch-ins need at least 12 frames between them");
  const s0 = c.transform.scale; const fx = centred ? 0 : (a.x as number) - c.transform.x; const fy = centred ? 0 : (a.y as number) - c.transform.y;
  const scales = Array.isArray(a.scales) && a.scales.length === at.length && a.scales.every((v) => typeof v === "number" && v >= 1 && v <= 2.5) ? a.scales as number[] : at.map((_, i) => 1 + 0.15 * (i + 1));
  const w = p.settings.width; const h = p.settings.height;
  // Hold keys: the framing jumps on the frame, as a cut does. The point
  // closed in on moves toward the centre as far as the picture's edges allow.
  const keys = (pick: (s: number) => number, base: number) => [key(0, base, "hold"), ...at.map((f, i) => key(f - c.start, pick(scales[i]!), "hold"))];
  // The point is brought to the centre (it lands at f·s + shift), as far as the enlarged picture still fills the frame.
  const shift = (s: number, f: number, half: number) => Math.max(-half * (s * s0 - 1), Math.min(half * (s * s0 - 1), -f * s));
  const kf = { ...(c.keyframes ?? {}) } as Record<string, unknown>;
  kf.scale = keys((s) => s0 * s, s0);
  kf.x = keys((s) => c.transform.x + shift(s, fx, w / 2), c.transform.x);
  kf.y = keys((s) => c.transform.y + shift(s, fy, h / 2), c.transform.y);
  (c as { keyframes?: unknown }).keyframes = kf;
  return { clip: c.id, punches: at.length };
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
  // The guide's Animation 8: "*Worked two jobs*" sits close to the person it's
  // about (near: [x, y], project px from centre); else a top corner.
  const near = Array.isArray(a.near) && a.near.length === 2 && a.near.every((v) => typeof v === "number") ? a.near as [number, number] : null;
  const x = near ? Math.max(-w / 2 + 36 * k + width / 2, Math.min(w / 2 - 36 * k - width / 2, near[0])) : right ? w / 2 - 36 * k - width / 2 : -w / 2 + 36 * k + width / 2;
  const y = near ? Math.max(-h / 2 + 40 * k, Math.min(h / 2 - 40 * k, near[1])) : -h / 2 + 34 * k + size * 0.6;
  // Animation 8.1: typed in quickly over its black box.
  const typed = a.typewriter === true;
  const id = push(p, { type: "text", name: "Janitor · corner label", text, start, duration: end - start, fade_in: 0, fade_out: 0,
    style: { font: UI, weight: 800, size, color: [1, 1, 1, 1], tracking: 0, line_height: 1.1, glow: { enabled: true, radius: 8 * k, strength: 0.3 },
      background: { color: [0, 0, 0, 1], opacity: 1, pad_x: 20 * k, pad_y: 10 * k } },
    transform: { x, y }, ...(typed ? { animation: { preset: "typewriter", duration: 6, stagger: 0.6 } } : {}) });
  return { clip: id, clips: [id] };
}

/**
 * A location in the house text style in the bottom left corner, as the guide's
 * Animation 6 has it ("LUTON, ENGLAND"): rising in, then fading.
 */
export function location(p: Project, a: Args): Args {
  const [start, end] = span(a); const h = p.settings.height; const w = p.settings.width; const k = h / 1080; const d = end - start;
  if (typeof a.text !== "string" || a.text.trim() === "") throw new Error("commentary_location needs text");
  const words = a.text.trim().toUpperCase(); const size = number(a, "size", 58) * k;
  const width = widthOf(words, GUIDE, 700, size); const x = -w / 2 + 34 * k + width / 2; const y = h / 2 - 34 * k - size * 0.55;
  const id = push(p, { type: "text", name: "Janitor · location", text: words, start, duration: d, fade_in: 6, fade_out: 8,
    style: { ...textStyle(h, size / k), align: "left" }, transform: { x, y }, keyframes: { y: arrival(y + 30 * k, y, Math.min(16, Math.floor(d / 3))) } });
  return { clip: id, clips: [id] };
}

/**
 * A flat icon (a platform's logo, a person silhouette) popping up over the
 * blurred picture, with glow and shadow, and a name and role under it, as the
 * guide's Animation 9 ("JAMES WARREN / FORMER CEO, BEAST INDUSTRIES").
 */
export function icon(p: Project, a: Args): Args {
  const [start, end] = span(a); const h = p.settings.height; const w = p.settings.width; const k = h / 1080; const d = end - start;
  const m = picture(p, a.media, "commentary_icon");
  const made: string[] = [];
  if (a.blur !== false) made.push(push(p, { type: "adjustment", name: "Janitor · icon backdrop", start, duration: d, blur: { radius: 30 * k }, grade: { exposure: -0.3, vignette: 0.3 }, fade_in: 6, fade_out: 6 }));
  const size = number(a, "size", 420) * k; const fit = Math.min(w / Math.max(m.width, 1), h / Math.max(m.height, 1));
  const scale = size / (Math.max(m.width, m.height) * fit); const y = number(a, "y", (typeof a.name === "string" ? -70 : 0) * k);
  const settle = Math.min(16, Math.floor(d / 3));
  made.push(push(p, { type: "video", media: m.id, source_in: 0, start, duration: d, name: "Janitor · icon", fade_in: 3, fade_out: 6,
    frame: { color: [1, 1, 1, 1], width: 0, shadow: 0.8, glow: 0.4 }, transform: { x: 0, y, scale }, keyframes: { scale: [...arrival(scale * 0.2, scale, settle), key(d - 1, scale * 1.03)] } }));
  const below = y + (m.height * fit * scale) / 2 + 60 * k;
  if (typeof a.name === "string" && a.name.trim()) made.push(push(p, { type: "text", name: "Janitor · icon name", text: a.name.trim().toUpperCase(), start: start + 6, duration: d - 6, fade_out: 6,
    style: { ...textStyle(h, 76), font: UI, weight: 400 }, transform: { x: 0, y: below }, animation: { preset: "typewriter", duration: 6, stagger: 0.6 } }));
  if (typeof a.role === "string" && a.role.trim()) made.push(push(p, { type: "text", name: "Janitor · icon role", text: a.role.trim().toUpperCase(), start: start + 12, duration: d - 12, fade_out: 6,
    style: { ...textStyle(h, 40), font: UI, weight: 400 }, transform: { x: 0, y: below + 64 * k }, animation: { preset: "typewriter", duration: 6, stagger: 0.6 } }));
  return { clips: made };
}

/**
 * The guide's Animation 7: the next composition slides down from the very top
 * on a cut, a smooth deliberate transition (the guide's speed curve: fast,
 * then a long settle). `at` is the cut; the clip starting there (the top
 * picture) slides in over `frames` (14). Put the bundled whoosh-3 on it with
 * add_sound_effect: its loudest moment lands as the slide begins.
 */
export function slide(p: Project, a: Args): Args {
  const at = a.at; const h = p.settings.height;
  if (typeof at !== "number" || !Number.isInteger(at)) throw new Error("commentary_slide needs at: the cut's frame");
  const index = (track: string) => p.tracks.findIndex((one) => one.id === track);
  const incoming = p.clips.filter((c) => c.type === "video" && c.start === at).sort((x, y) => index(y.track) - index(x.track))[0];
  if (incoming === undefined || incoming.type !== "video") throw new Error(`no picture starts at frame ${at} to slide in`);
  const frames = Math.min(number(a, "frames", 14), Math.floor(incoming.duration / 2));
  const y = incoming.transform.y;
  const kf = { ...(incoming.keyframes ?? {}) } as Record<string, unknown>;
  kf.y = [...arrival(y - h, y, frames)];
  (incoming as { keyframes?: unknown }).keyframes = kf;
  return { clip: incoming.id, frames };
}

/**
 * The channel bumper: the Internet Janitor avatar, name, tagline and a
 * Subscribe button, centred as one group over the dark channel page, with the
 * episode's line under it ("CLEANING UP THE BIGGEST STREAM ON TWITCH" /
 * "(among many other charges)"). Only where the narrator introduces himself
 * or the channel, never as a chapter card ("we just showed the internet
 * janitor branding. That made absolutely no sense"). Brand media come from
 * search_broll {queries:[]}.
 */
export function bumper(p: Project, a: Args): Args {
  const [start, end] = span(a); const d = end - start; const h = p.settings.height; const w = p.settings.width; const k = h / 1080;
  const avatar = typeof a.avatar === "string" ? mediaOf(p, a.avatar) : undefined;
  if (avatar === undefined || avatar.kind !== "image") throw new Error("commentary_bumper needs avatar: search_broll {queries:[]}'s brand_avatar");
  const made = dark(p, start, end, "Janitor · bumper");
  const name = typeof a.name === "string" ? a.name : "InternetJanitor";
  const tagline = typeof a.tagline === "string" ? a.tagline : "Cleaning up the internet, one disaster at a time.";
  const size = 300 * k; const gap = 60 * k; const nameSize = 112 * k; const tagSize = 34 * k;
  const groupW = size + gap + Math.max(measured(name, nameSize, 700), measured(tagline, tagSize, 400), 230 * k);
  const cy = -h * 0.12; const ax = -groupW / 2 + size / 2; const left = -groupW / 2 + size + gap;
  const af = Math.min(w / Math.max(avatar.width, 1), h / Math.max(avatar.height, 1)); const base = size / (Math.max(avatar.width, avatar.height) * af);
  const settle = Math.min(18, Math.floor(d / 3));
  made.push(push(p, { type: "video", media: avatar.id, source_in: 0, start, duration: d, name: "Janitor · bumper avatar", fade_in: 4, fade_out: 6,
    frame: { color: [1, 1, 1, 1], width: 0, shadow: 0, radius: size / 2 / base }, transform: { x: ax, y: cy, scale: base },
    keyframes: { scale: [...arrival(base * 0.85, base, settle), key(d - 1, base * 1.03)] } }));
  made.push(uiLine(p, { text: name, start: start + 3, end, left, y: cy - 70 * k, size: nameSize, weight: 700, name: "Janitor · bumper name", glow: true, enter: 40 }));
  made.push(uiLine(p, { text: tagline, start: start + 6, end, left, y: cy + 22 * k, size: tagSize, weight: 400, color: [0.75, 0.75, 0.75, 1], name: "Janitor · bumper tagline", enter: 40 }));
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


/**
 * A YouTube channel's header as a small dark panel over the footage, its
 * caption below (the guide's Animation 3: CjTheseDays "faded in with a slide
 * up animation, with the relevant text below 'MrBeast's Brother'"): avatar,
 * name, "@handle · 4.1m subscribers", the description and Subscribe.
 */
export function channelLayout(p: Project, a: Args): { width: number; height: number; radius: number } {
  if (typeof a.name !== "string" || a.name.trim() === "") throw new Error("commentary_channel needs name (youtube_reference with channel: true gives it)");
  const k = p.settings.height / 1080;
  return { width: Math.round(800 * k), height: Math.round(270 * k), radius: Math.round(24 * k) };
}
export function channel(p: Project, a: Args, panel: string): Args {
  const [start, end] = span(a); const h = p.settings.height; const w = p.settings.width; const k = h / 1080; const d = end - start;
  const L = channelLayout(p, a);
  const settle = Math.min(16, Math.floor(d / 3));
  const cy = number(a, "y", h * 0.2); const left = -L.width / 2;
  const rise = (y: number) => ({ y: arrival(y + 60 * k, y, settle) });
  const made: string[] = [];
  const pm = mediaOf(p, panel)!; const pf = Math.min(w / Math.max(pm.width, 1), h / Math.max(pm.height, 1));
  made.push(push(p, { type: "video", media: panel, source_in: 0, start, duration: d, name: "Janitor · channel panel", fade_in: 6, fade_out: 6,
    frame: { color: [1, 1, 1, 1], width: 0, shadow: 0.6 }, transform: { x: 0, y: cy, scale: L.width / (pm.width * pf) }, keyframes: rise(cy) }));
  const avatar = typeof a.avatar === "string" ? mediaOf(p, a.avatar) : undefined; const as = 190 * k;
  let col = left + 40 * k;
  if (avatar !== undefined && avatar.kind === "image") {
    const af = Math.min(w / Math.max(avatar.width, 1), h / Math.max(avatar.height, 1)); const sc = as / (Math.max(avatar.width, avatar.height) * af);
    made.push(push(p, { type: "video", media: avatar.id, source_in: 0, start, duration: d, name: "Janitor · channel avatar", fade_in: 6, fade_out: 6,
      frame: { color: [1, 1, 1, 1], width: 0, shadow: 0, radius: as / 2 / sc }, transform: { x: col + as / 2, y: cy, scale: sc }, keyframes: rise(cy) }));
    col += as + 30 * k;
  }
  const line = (t: string, y: number, size: number, weight: number, color: number[], name: string) => {
    const x = col + measured(t, size, weight) / 2;
    made.push(push(p, { type: "text", name, text: t, start, duration: d, fade_in: 6, fade_out: 6,
      style: { font: UI, weight, size, color, tracking: 0, line_height: 1.2, align: "left", glow: { enabled: false } }, transform: { x, y }, keyframes: rise(y) }));
  };
  line(String(a.name).trim(), cy - 80 * k, 50 * k, 700, [1, 1, 1, 1], "Janitor · channel name");
  const stats = [typeof a.handle === "string" ? `@${a.handle.replace(/^@/u, "")}` : null, typeof a.subscribers === "string" ? `${a.subscribers} subscribers` : null, typeof a.videos === "string" ? `${a.videos} videos` : null].filter(Boolean).join(" · ");
  if (stats) line(stats, cy - 26 * k, 24 * k, 400, [0.7, 0.7, 0.7, 1], "Janitor · channel stats");
  if (typeof a.description === "string" && a.description.trim()) {
    const room = L.width / 2 - 30 * k - col; const said = native().textLines(a.description.trim(), UI, 400, 24 * k, 0, room)[0] ?? "";
    line(said === a.description.trim() ? said : `${said.replace(/\s+\S*$/u, "")} …more`, cy + 14 * k, 24 * k, 400, [0.82, 0.82, 0.82, 1], "Janitor · channel description");
  }
  const button = typeof a.subscribe === "string" ? mediaOf(p, a.subscribe) : undefined;
  if (button !== undefined && button.kind === "image") {
    const bw = 150 * k; const bf = Math.min(w / Math.max(button.width, 1), h / Math.max(button.height, 1)); const bs = bw / (button.width * bf); const by = cy + 72 * k;
    made.push(push(p, { type: "video", media: button.id, source_in: 0, start, duration: d, name: "Janitor · channel subscribe", fade_in: 6, fade_out: 6,
      frame: { color: [1, 1, 1, 1], width: 0, shadow: 0, radius: (bw * button.height / button.width) / 2 / bs }, transform: { x: col + bw / 2, y: by, scale: bs }, keyframes: rise(by) }));
  }
  if (typeof a.caption === "string" && a.caption.trim()) made.push(...(text(p, { text: a.caption.trim().toUpperCase(), start: start + 6, end, size: 52, motion: "soft", y: cy + L.height / 2 + 50 * k }).clips as string[]));
  return { clips: made };
}

/**
 * The video playing full screen pulls back, smoothly and still playing, into
 * the YouTube watch page around it: title, channel, subscribe (the team,
 * N3on v1: "a zoom out effect where it turns into like you are watching the
 * video from YouTube in not full screen… This should not be a cut, but a
 * smooth zoom out where it all looks smooth and the video keeps running").
 * `clip` is the full-screen video; `at` the frame the pull-back starts;
 * every layer of the page moves as one camera.
 */
export function player(p: Project, a: Args): Args {
  const c = p.clips.find((one) => one.id === a.clip);
  if (c?.type !== "video") throw new Error("commentary_player needs clip: the full-screen video clip");
  const at = typeof a.at === "number" ? Math.round(a.at) : c.start;
  const end = typeof a.end === "number" ? Math.round(a.end) : clipEnd(c);
  if (at < c.start || at >= end - 12 || end > clipEnd(c)) throw new Error("at…end must sit inside the clip, at least 12 frames");
  if (typeof a.title !== "string" || typeof a.channel !== "string") throw new Error("commentary_player needs title and channel (youtube_reference gives them)");
  const w = p.settings.width; const h = p.settings.height; const k = h / 1080;
  const d = end - at;
  // Out, a slow drift while it holds, and back to full screen by `end` (the
  // team, N3on v2: "make the zoom out a bit more smooth… when you then have to
  // zoom in again, you just cut it right back… When doing a transition one
  // way, a lot of the times you need to do the same thing back"); back: false holds to the cut.
  const frames = Math.min(Math.max(number(a, "frames", 36), 10), Math.floor(d / 2));
  const back = a.back === false ? 0 : Math.min(Math.max(number(a, "back", 22), 8), Math.floor((d - frames) / 2));
  // The page as YouTube lays it out at 1080p (theatre-like: the player wide, the details under it).
  const pw = 0.66 * w; const ph = pw * 9 / 16; const left = -pw / 2 - 0.12 * w; const top = -h / 2 + 0.05 * h;
  const pc: [number, number] = [left + pw / 2, top + ph / 2];
  // Camera: S from "the player fills the frame" to 1, the player's centre from the frame's to its own.
  const S0 = Math.max(w / pw, h / ph);
  // Smootherstep: eased in and out, no snap at either end.
  const ease = (t: number) => { const u = Math.min(Math.max(t, 0), 1); return u * u * u * (u * (6 * u - 15) + 10); };
  const last = d - 1; const turn = last - back; const drift = 0.035;
  const camera = (f: number) => {
    if (f <= frames) { const e = ease(f / frames); return { S: S0 + (1 - S0) * e, cx: pc[0] * e, cy: pc[1] * e }; }
    const held = 1 - drift * ease((f - frames) / Math.max(turn - frames, 1));
    if (back === 0 || f <= turn) return { S: held, cx: pc[0], cy: pc[1] };
    const e = ease((f - turn) / back); const Sh = 1 - drift;
    return { S: Sh + (S0 - Sh) * e, cx: pc[0] * (1 - e), cy: pc[1] * (1 - e) };
  };
  const steps = [...new Set([...Array.from({ length: Math.ceil(d / 2) }, (_, i) => i * 2), frames, turn, last].filter((f) => f >= 0 && f <= last))].sort((p, q) => p - q);
  const bake = (from: number, base: (S: number, cx: number, cy: number) => { x: number; y: number; scale: number }) => {
    const keys: Record<string, ReturnType<typeof key>[]> = { x: [], y: [], scale: [] };
    for (const f of steps) { const { S, cx, cy } = camera(f); const v = base(S, cx, cy); keys.x!.push(key(from + f, v.x)); keys.y!.push(key(from + f, v.y)); keys.scale!.push(key(from + f, v.scale)); }
    return keys;
  };
  const made: string[] = [];
  const page = push(p, { type: "solid", name: "Janitor · player page", start: at, duration: end - at, fill: [0.059, 0.059, 0.059, 1] });
  made.push(page);
  // The video: its own framing scaled by the camera, its centre carried to the player's.
  const m = mediaOf(p, c.media)!; const fit = Math.min(w / Math.max(m.width, 1), h / Math.max(m.height, 1));
  const coverNow = c.transform.scale; const inPlayer = Math.min(pw / (m.width * fit), ph / (m.height * fit));
  // Sized so the camera's full-screen ends match the clip's own framing exactly (no jump on or off it).
  const fitted = coverNow / (inPlayer * S0);
  const vkeys = bake(at - c.start, (S, cx, cy) => ({ x: cx, y: cy, scale: inPlayer * S * fitted }));
  // Full-screen until `at`, on its own framing, and back on it at the end.
  for (const name of ["x", "y", "scale"] as const) {
    const own = name === "scale" ? coverNow : c.transform[name];
    vkeys[name]!.unshift(key(0, own), key(Math.max(0, at - c.start - 1), own));
    if (back > 0) vkeys[name]!.at(-1)!.value = own;
  }
  // Rounded like YouTube's player once it's small.
  (c as { keyframes?: unknown }).keyframes = { ...(c.keyframes ?? {}), ...vkeys };
  (c as { frame?: unknown }).frame = { color: [1, 1, 1, 1], width: 0, shadow: 0, radius: 14 * k / inPlayer };
  // A layer of the page at (x, y) with its own scale, moving with the camera.
  const onPage = (fields: Args, x: number, y: number, scale = 1) => {
    const id = push(p, { ...fields, start: at, duration: end - at, transform: { x, y, scale } });
    const clip = p.clips.find((one) => one.id === id)!;
    (clip as { keyframes?: unknown }).keyframes = bake(0, (S, cx, cy) => ({ x: cx + (x - pc[0]) * S, y: cy + (y - pc[1]) * S, scale: scale * S }));
    made.push(id); return id;
  };
  const textOn = (t: string, x: number, y: number, size: number, weight: number, color: number[], name: string) =>
    onPage({ type: "text", name, text: t, style: { font: "Geist", weight, size, color, tracking: 0, line_height: 1.2, align: "left", glow: { enabled: false } } }, x + widthOf(t, "Geist", weight, size) / 2, y);
  const titleSize = 34 * k; let y = top + ph + 40 * k;
  const lines = native().textLines(a.title, "Geist", 700, titleSize, 0, pw).slice(0, 2);
  for (const line of lines) { textOn(line, left, y, titleSize, 700, [0.95, 0.95, 0.95, 1], "Janitor · player title"); y += titleSize * 1.3; }
  y += 30 * k; const avatarSize = 64 * k; let col = left;
  const avatar = typeof a.avatar === "string" ? mediaOf(p, a.avatar) : undefined;
  if (avatar !== undefined && avatar.kind === "image") {
    const af = Math.min(w / Math.max(avatar.width, 1), h / Math.max(avatar.height, 1)); const as = avatarSize / (Math.max(avatar.width, avatar.height) * af);
    onPage({ type: "video", name: "Janitor · player avatar", media: avatar.id, source_in: 0, frame: { color: [1, 1, 1, 1], width: 0, shadow: 0, radius: avatarSize / 2 / as } }, col + avatarSize / 2, y, as);
    col += avatarSize + 18 * k;
  }
  textOn(a.channel, col, y - 12 * k, 28 * k, 700, [0.95, 0.95, 0.95, 1], "Janitor · player channel");
  if (typeof a.subscribers === "string") textOn(`${a.subscribers} subscribers`, col, y + 20 * k, 22 * k, 400, [0.67, 0.67, 0.67, 1], "Janitor · player subscribers");
  const button = typeof a.subscribe === "string" ? mediaOf(p, a.subscribe) : undefined;
  if (button !== undefined && button.kind === "image") {
    const bw = 150 * k; const bf = Math.min(w / Math.max(button.width, 1), h / Math.max(button.height, 1)); const bs = bw / (button.width * bf);
    const bx = col + Math.max(widthOf(a.channel, "Geist", 700, 28 * k), typeof a.subscribers === "string" ? widthOf(`${a.subscribers} subscribers`, "Geist", 400, 22 * k) : 0) + 40 * k + bw / 2;
    onPage({ type: "video", name: "Janitor · player subscribe", media: button.id, source_in: 0, frame: { color: [1, 1, 1, 1], width: 0, shadow: 0, radius: (bw * button.height / button.width) / 2 / bs } }, bx, y, bs);
  }
  if (typeof a.meta === "string" && a.meta.trim()) textOn(a.meta.trim(), left, y + avatarSize / 2 + 42 * k, 24 * k, 500, [0.85, 0.85, 0.85, 1], "Janitor · player views");
  // The video stays above the page.
  const order = (id: string) => p.tracks.findIndex((t) => t.id === p.clips.find((one) => one.id === id)?.track);
  if (order(c.id) < order(page)) { (c as { track: string }).track = addTrack(p, "video"); }
  return { clip: c.id, clips: made };
}

/**
 * A number counting up fast, as a live viewer count climbing (the team, N3on
 * v1: "his live kick viewer count, where you make it so it's 57 and then make
 * an effect where it rapidly increases… up to like 35632"): `x`/`y` over the
 * number in a screenshot, in its own type, easing out as it nears the end.
 */
export function counter(p: Project, a: Args): Args {
  const [start, end] = span(a); const h = p.settings.height; const k = h / 1080;
  const from = number(a, "from", 0); const to = number(a, "to", 1000);
  const frames = Math.min(Math.max(number(a, "frames", 40), 6), end - start);
  const step = 2; const size = number(a, "size", 56) * k;
  const style = { font: typeof a.font === "string" ? a.font : "Geist", weight: number(a, "weight", 700), size, color: Array.isArray(a.color) ? a.color : [1, 1, 1, 1], tracking: 0, line_height: 1.1,
    glow: { enabled: false }, ...(a.box !== false ? { background: { color: Array.isArray(a.background) ? a.background : [0.09, 0.09, 0.1, 1], opacity: 1, pad_x: 10 * k, pad_y: 4 * k } } : {}) };
  const fmt = (v: number) => `${typeof a.prefix === "string" ? a.prefix : ""}${a.separator === false ? String(v) : v.toLocaleString("en-US")}${typeof a.suffix === "string" ? a.suffix : ""}`;
  const made: string[] = [];
  const x = number(a, "x", 0); const y = number(a, "y", 0);
  for (let f = 0; f < frames; f += step) {
    const u = f / frames; const v = Math.round(from + (to - from) * (1 - Math.pow(1 - u, 2.4)));
    made.push(push(p, { type: "text", name: "Janitor · counter", text: fmt(v), start: start + f, duration: step, style, transform: { x, y } }));
  }
  made.push(push(p, { type: "text", name: "Janitor · counter", text: fmt(Math.round(to)), start: start + frames, duration: end - start - frames, fade_out: 6, style, transform: { x, y }, keyframes: { scale: [key(0, 1.12), key(8, 1)] } }));
  return { clips: made };
}
