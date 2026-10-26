import * as fs from "node:fs";
import { deflateSync } from "node:zlib";
import { clipFrom } from "./clips.ts";
import * as commentaryGraphics from "./commentary_graphics.ts";
import { importPaths } from "./import.ts";
import { registerTool, text } from "./mcp/registry.ts";
import type { Keyframe, Project, VideoClip } from "./model.ts";
import { addTrack, clipEnd, freshId, mediaOf, sample } from "./project.ts";
import { join } from "./paths.ts";
import { stableStringify } from "./stable.ts";
import * as tools from "./tools.ts";
import "./commentary_effects.ts";

export interface Rect { x: number; y: number; width: number; height: number; }
export function rectOf(value: unknown, width: number, height: number): Rect {
  const r = value as Partial<Rect> | null;
  if (r == null || ![r.x, r.y, r.width, r.height].every((v) => typeof v === "number" && Number.isFinite(v)) || r.x! < 0 || r.y! < 0 || r.width! < 2 || r.height! < 2 || r.x! + r.width! > width || r.y! + r.height! > height) throw new Error("highlight rectangles must fit inside the original screenshot (x/y/width/height in image pixels)");
  return r as Rect;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name: string, bytes: Uint8Array): Buffer {
  const data = Buffer.concat([Buffer.from(name), bytes]); const prefix = Buffer.alloc(4); prefix.writeUInt32BE(bytes.length);
  const suffix = Buffer.alloc(4); suffix.writeUInt32BE(crc32(data)); return Buffer.concat([prefix, data, suffix]);
}
/** An annotation, not evidence: transparent red ink with slightly irregular
 * edges. Multiply in the compositor leaves the real source's black type black. */
export function markerPng(width: number, height: number, rect: Rect): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 12_000_000) throw new Error("screenshot too large for a highlight");
  rectOf(rect, width, height);
  const stride = width * 4 + 1; const raw = Buffer.alloc(stride * height);
  for (let y = Math.floor(rect.y); y < Math.ceil(rect.y + rect.height); y++) for (let x = Math.floor(rect.x); x < Math.ceil(rect.x + rect.width); x++) {
    const wave = Math.sin((x - rect.x) / 23) * 0.65;
    const alpha = Math.min(1, Math.max(0, Math.min(y - rect.y + 1 - wave, rect.y + rect.height - y + wave)));
    const at = y * stride + 1 + x * 4; raw[at] = 255; raw[at + 3] = Math.round(245 * alpha);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** An RGBA picture as PNG bytes, from a pixel function (0–255 each). */
export function rgbaPng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number] | null): Uint8Array {
  const stride = width * 4 + 1; const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = pixel(x, y); if (v === null || v[3] <= 0) continue;
    const at = y * stride + 1 + x * 4; raw[at] = v[0]; raw[at + 1] = v[1]; raw[at + 2] = v[2]; raw[at + 3] = Math.min(255, Math.round(v[3]));
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A rounded panel (our own graphic's ground: a channel card), antialiased at its corners. */
export function panelPng(width: number, height: number, radius: number, rgba: [number, number, number, number]): Uint8Array {
  const stride = width * 4 + 1; const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    // Distance outside the rounded rectangle (negative inside).
    const dx = Math.max(radius - x - 0.5, x + 0.5 - (width - radius), 0); const dy = Math.max(radius - y - 0.5, y + 0.5 - (height - radius), 0);
    const outside = Math.hypot(dx, dy) - radius;
    const alpha = Math.min(1, Math.max(0, 0.5 - outside));
    const at = y * stride + 1 + x * 4; raw[at] = rgba[0]; raw[at + 1] = rgba[1]; raw[at + 2] = rgba[2]; raw[at + 3] = Math.round(rgba[3] * alpha);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function on(p: Project, id: string): VideoClip {
  const c = p.clips.find((c) => c.id === id);
  if (c?.type !== "video" || mediaOf(p, c.media)?.kind !== "image") throw new Error("on must be an image clip (commentary_card returns photo)");
  if (Object.values(c.crop ?? {}).some((v) => v !== 0)) throw new Error("highlight a clean captured card before cropping it; rectangles use its original image pixels");
  return c;
}

registerTool("highlight_evidence", async ({ app, args, projectId }) => {
  const p = app.store.get(projectId)?.project; if (!p || typeof args.on !== "string") throw new Error("on is the screenshot card clip id");
  const parent = on(p, args.on); const media = mediaOf(p, parent.media)!;
  if (!Array.isArray(args.rects) || args.rects.length < 1 || args.rects.length > 8) throw new Error("rects must contain 1–8 highlight rectangles");
  const rects = args.rects.map((v) => rectOf(v, media.width, media.height));
  const start = typeof args.start === "number" && Number.isInteger(args.start) ? args.start : parent.start;
  const end = typeof args.end === "number" && Number.isInteger(args.end) ? args.end : clipEnd(parent);
  // A dark post (X, a dark-mode page) keeps its white words white over the red
  // with Screen, as the reference's tweet highlight does; Multiply would turn
  // them red and leave the black ground black.
  const dark = args.dark === true;
  const draw = typeof args.draw_frames === "number" ? Math.max(2, Math.min(60, Math.round(args.draw_frames))) : 14;
  if (start < parent.start || end > clipEnd(parent) || end <= start) throw new Error("the highlight must stay within its source card's frames");
  const dir = join(app.store.home, "research", projectId, "highlights"); fs.mkdirSync(dir, { recursive: true });
  const paths = rects.map((r, i) => { const path = join(dir, `ink-${Date.now()}-${i}.png`); fs.writeFileSync(path, markerPng(media.width, media.height, r)); return path; });
  const [, ids, errors] = await importPaths(app, projectId, paths, false, "agent"); if (ids.length !== paths.length) throw new Error(errors.join("; "));
  const [, made] = await app.store.update(projectId, "agent", (project) => {
    const original = on(project, args.on as string); const made: string[] = [];
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i]!; const at = start + i * draw; if (at >= end) break;
      const offset = at - original.start; const duration = end - at; const keyframes: Record<string, Keyframe[]> = {};
      // Bake the parent's Bezier move at timeline frames, so the mark sticks
      // to the source throughout its slide/push and never outlives that shot.
      for (const param of ["x", "y", "scale", "rotation"] as const) {
        const keys = original.keyframes?.[param]; if (!keys?.length) continue;
        keyframes[param] = Array.from({ length: duration }, (_, frame) => ({ frame, value: sample(keys, frame + offset) ?? original.transform[param], ease: "linear" as const }));
      }
      keyframes["crop.right"] = [{ frame: 0, value: Math.min(0.9999, 1 - r.x / media.width), ease: "linear" }, { frame: Math.min(draw, duration - 1), value: Math.max(0, 1 - (r.x + r.width) / media.width), ease: "linear" }];
      const id = freshId(project, "c");
      project.clips.push(clipFrom({ id, type: "video", name: "Janitor · evidence marker", media: ids[i], track: addTrack(project, "video"), start: at, duration,
        source_in: 0, blend: dark ? "screen" : "multiply", transform: original.transform, opacity: original.opacity, fade_out: Math.min(original.fade_out, duration - 1), keyframes }));
      made.push(id);
    }
    return made;
  });
  return text(stableStringify({ clips: made, on: args.on, note: "Editable Multiply ink over the original screenshot; reveal follows source coordinates and inherits its motion. Confirm the rectangles cover the exact quoted words." }));
});

registerTool("commentary_tweet", async ({ app, args, projectId }) => {
  const p = app.store.get(projectId)?.project; if (!p) throw new Error("no such project");
  // Measured on the live project; the bars are drawn as images first, so the whole post saves once.
  const layout = commentaryGraphics.tweetLayout(p, args);
  const { width, height } = p.settings;
  const dir = join(app.store.home, "research", projectId, "highlights"); fs.mkdirSync(dir, { recursive: true });
  const paths = layout.rects.map((r, i) => {
    const path = join(dir, `post-${Date.now()}-${i}.png`);
    fs.writeFileSync(path, markerPng(width, height, { x: r.x, y: r.y, width: Math.min(r.width, width - r.x), height: Math.min(r.height, height - r.y) }));
    return path;
  });
  const [, ids, errors] = paths.length ? await importPaths(app, projectId, paths, false, "agent") : [null, [] as string[], [] as string[]];
  if (ids.length !== paths.length) throw new Error(errors.join("; "));
  const [, made] = await app.store.update(projectId, "agent", (project) => commentaryGraphics.tweet(project, args, ids));
  return text(stableStringify({ ...made, highlights: layout.rects.length, note: "Our own rebuild of a real post: its words exactly as posted (stars over the house words), never reworded. Check a frame: the bars should sit behind the highlighted words." }));
});

/** Plain text of an oEmbed post's paragraph. */
export function postText(html: string): string {
  const para = /<p[^>]*>([\s\S]*?)<\/p>/u.exec(html)?.[1] ?? "";
  return para.replace(/<br\s*\/?>/gu, "\n").replace(/<a[^>]*>(pic\.twitter\.com[^<]*)<\/a>/gu, "").replace(/<[^>]+>/gu, "")
    .replace(/&amp;/gu, "&").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, "\"").replace(/&#39;/gu, "'").replace(/&mdash;/gu, "—").trim();
}

registerTool("tweet_reference", async ({ app, args, projectId }) => {
  if (typeof args.url !== "string" || !/^https:\/\/(x|twitter)\.com\/[^/]+\/status\/\d+/u.test(args.url)) throw new Error("url must be a post on x.com or twitter.com");
  const answer = await fetch(`https://publish.twitter.com/oembed?omit_script=1&url=${encodeURIComponent(args.url)}`, { signal: AbortSignal.timeout(20_000) });
  if (!answer.ok) throw new Error(`X wouldn't show that post (${answer.status}): it may be deleted or private; read its details off a screenshot instead`);
  const post = await answer.json() as { author_name?: string; author_url?: string; html?: string };
  const handle = post.author_url?.split("/").pop() ?? null;
  const date = /<a [^>]*>([A-Z][a-z]+ \d{1,2}, \d{4})<\/a>\s*<\/blockquote>/u.exec(post.html ?? "")?.[1] ?? null;
  let avatar: string | null = null;
  if (handle !== null) {
    const dir = join(app.store.home, "research", projectId, "posts"); fs.mkdirSync(dir, { recursive: true });
    try {
      const got = await fetch(`https://unavatar.io/x/${handle}?fallback=false`, { signal: AbortSignal.timeout(20_000) });
      if (got.ok) { const path = join(dir, `avatar-${handle}.jpg`); fs.writeFileSync(path, new Uint8Array(await got.arrayBuffer())); avatar = (await importPaths(app, projectId, [path], false, "agent"))[1][0] ?? null; }
    } catch { /* the post shows without its avatar */ }
  }
  return text(stableStringify({ url: args.url, name: post.author_name ?? null, handle, date, text: postText(post.html ?? ""), avatar,
    note: "For commentary_tweet: name, handle, time (the date, or as the screenshot shows it), text exactly as posted, avatar; its picture from capture_evidence or a still_frame crop. highlight the phrase the narration is about." }));
});

registerTool("commentary_channel", async ({ app, args, projectId }) => {
  const p = app.store.get(projectId)?.project; if (!p) throw new Error("no such project");
  const layout = commentaryGraphics.channelLayout(p, args);
  const dir = join(app.store.home, "graphics", "commentary"); fs.mkdirSync(dir, { recursive: true });
  const path = join(dir, `channel-panel-${layout.width}x${layout.height}.png`);
  if (!fs.existsSync(path)) fs.writeFileSync(path, panelPng(layout.width, layout.height, layout.radius, [33, 33, 33, 255]));
  const [, ids, errors] = await importPaths(app, projectId, [path], false, "agent");
  if (ids[0] === undefined) throw new Error(errors.join("; "));
  const [, made] = await app.store.update(projectId, "agent", (project) => commentaryGraphics.channel(project, args, ids[0]!));
  return text(stableStringify({ ...made, note: "A channel as its page header shows it, rising in over the footage; the caption below is the editorial line." }));
});

/**
 * The guide's Animation 2 ("Rotate"): a channel's page, screenshotted in dark
 * mode, held on the YouTube ground with a slight 3D tilt that slowly turns
 * (the user, Oct 26: "a slight 3D tilt (perspective) that slowly turns… yes
 * exactly this") and a slow push. The renderer moves pictures in 2D, so the
 * turn is rendered as a short video: the screenshot on a plane, rotated about
 * its vertical axis in perspective, frame by frame (FFmpeg's perspective
 * filter maps the plane's corners); the plane is larger than the frame and
 * cropped, so its edge never shows. Degrees: negative turns the right side away.
 */
export function rotateFilter(width: number, height: number, fps: number, seconds: number, from: number, to: number, push: number, share: number): string {
  // The plane: 1.4x the frame, the screenshot `share` of the frame's width in its middle.
  const [W, H] = [Math.round(width * 1.4 / 2) * 2, Math.round(height * 1.4 / 2) * 2];
  const focal = 1.6 * width;
  const progress = `min((in/${fps})/${seconds.toFixed(3)},1)`;
  const angle = `((${from})+((${to})-(${from}))*${progress})*PI/180`;
  const zoom = `(1+(${push - 1})*${progress})`;
  const x = (sx: number) => `(${W / 2}+(${sx})*${zoom}*cos(${angle})*${focal}/(${focal}+(${sx})*${zoom}*sin(${angle})))`;
  const y = (sx: number, sy: number) => `(${H / 2}+(${sy})*${zoom}*${focal}/(${focal}+(${sx})*${zoom}*sin(${angle})))`;
  const corners = [[-W / 2, -H / 2], [W / 2, -H / 2], [-W / 2, H / 2], [W / 2, H / 2]] as const;
  const points = corners.flatMap(([sx, sy], i) => [`x${i}='${x(sx)}'`, `y${i}='${y(sx, sy)}'`]).join(":");
  const shot = Math.round(width * share / 2) * 2;
  return `scale=${shot}:-2,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x1B1B1C,perspective=${points}:sense=destination:eval=frame,crop=${width}:${height},format=yuv420p`;
}

registerTool("commentary_rotate", async ({ app, args, projectId }) => {
  const p = app.store.get(projectId)?.project; if (!p) throw new Error("no such project");
  const m = typeof args.media === "string" ? mediaOf(p, args.media) : undefined;
  if (m === undefined || m.kind !== "image") throw new Error("commentary_rotate needs media: the channel page's screenshot (an image; still_frame crop or capture_evidence)");
  const [start, end] = [args.start, args.end];
  if (typeof start !== "number" || typeof end !== "number" || !Number.isInteger(start) || !Number.isInteger(end) || end - start < 12) throw new Error("start/end are timeline frames, at least 12 apart");
  const { width, height, fps } = p.settings; const seconds = (end - start) / fps;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const filter = rotateFilter(width, height, fps, seconds, num(args.from, -14), num(args.to, -6), Math.min(Math.max(num(args.push, 1.04), 1), 1.3), Math.min(Math.max(num(args.width, 0.82), 0.3), 1));
  const dir = join(app.store.uploadsDir(projectId), "rotate"); fs.mkdirSync(dir, { recursive: true });
  const out = join(dir, `rotate-${m.id}-${Bun.hash(filter).toString(16).slice(0, 10)}.mp4`);
  if (!fs.existsSync(out)) {
    const remote = tools.isUrl(m.path) ? ["-protocol_whitelist", tools.protocols(m.path), ...tools.urlArgs(m.path)] : [];
    await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", ...remote, "-loop", "1", "-framerate", String(fps), "-t", seconds.toFixed(3), "-i", m.path,
      "-vf", filter, "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-r", String(fps), "-movflags", "+faststart", out]);
  }
  const [, ids, errors] = await importPaths(app, projectId, [out], false, "agent");
  if (ids[0] === undefined) throw new Error(errors.join("; "));
  const [, made] = await app.store.update(projectId, "agent", (project) => {
    const id = freshId(project, "c");
    project.clips.push(clipFrom({ id, type: "video", name: "Janitor · rotate", media: ids[0], track: addTrack(project, "video"), start, duration: end - start, source_in: 0, fade_in: 3, fade_out: 4 }));
    return id;
  });
  return text(stableStringify({ clip: made, media: ids[0], note: "Rendered as a video (the turn is 3D); once per channel in a video. Put it on a cut, a light leak or flash before it if the beat wants one." }));
});
