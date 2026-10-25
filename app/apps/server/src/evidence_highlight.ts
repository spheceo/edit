import * as fs from "node:fs";
import { deflateSync } from "node:zlib";
import { clipFrom } from "./clips.ts";
import { importPaths } from "./import.ts";
import { registerTool, text } from "./mcp/registry.ts";
import type { Keyframe, Project, VideoClip } from "./model.ts";
import { addTrack, clipEnd, freshId, mediaOf, sample } from "./project.ts";
import { join } from "./paths.ts";
import { stableStringify } from "./stable.ts";

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
        source_in: 0, blend: "multiply", transform: original.transform, opacity: original.opacity, fade_out: Math.min(original.fade_out, duration - 1), keyframes }));
      made.push(id);
    }
    return made;
  });
  return text(stableStringify({ clips: made, on: args.on, note: "Editable Multiply ink over the original screenshot; reveal follows source coordinates and inherits its motion. Confirm the rectangles cover the exact quoted words." }));
});
