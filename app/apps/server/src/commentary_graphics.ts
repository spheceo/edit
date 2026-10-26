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
  if (typeof a.duration === "string" && a.duration.trim()) {
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
    if (typeof one.duration === "string" && one.duration.trim()) {
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
export function tweetLayout(p: Project, a: Args): { rects: { x: number; y: number; width: number; height: number }[]; lines: string[]; size: number; left: number; textTop: number; lineH: number; cardW: number; top: number; mediaH: number } {
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
  return { rects, lines, size, left, textTop, lineH, cardW, top, mediaH };
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
  const words = push(p, { type: "text", name: "Janitor · post text", text: L.lines.join("\n"), start, duration: d, fade_in: 6, fade_out: 5,
    style: { font: UI, weight: 500, size: L.size, color: [0.95, 0.95, 0.95, 1], tracking: 0, line_height: 1.3, align: "left", glow: { enabled: false } },
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
  const x = right ? w / 2 - 36 * k - width / 2 : -w / 2 + 36 * k + width / 2;
  const id = push(p, { type: "text", name: "Janitor · corner label", text, start, duration: end - start, fade_in: 0, fade_out: 0,
    style: { font: UI, weight: 800, size, color: [1, 1, 1, 1], tracking: 0, line_height: 1.1, glow: { enabled: true, radius: 8 * k, strength: 0.3 },
      background: { color: [0, 0, 0, 1], opacity: 1, pad_x: 20 * k, pad_y: 10 * k } },
    transform: { x, y: -h / 2 + 34 * k + size * 0.6 } });
  return { clip: id, clips: [id] };
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
