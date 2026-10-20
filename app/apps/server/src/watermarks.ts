// Another outlet's mark on a found photo: a network's bug ("DATELINE" in a
// corner of Helpful Wife's couple photo: "we need to remove the previous
// watermark of 'Dateline'"), a stock site's watermark, a credit or a headline
// laid over the picture. Gemini looks at each photo on the timeline once
// (`marks-v1.json` in its cache dir, read in the background like the
// footage's words on screen) and the audit's `watermarked_picture` names
// those still on screen: not cropped past and not under a rect blur.

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import type { Clip, Media, Project } from "./model.ts";
import { isReal } from "./native/index.ts";
import { join } from "./paths.ts";
import { clipEnd, mediaOf, trackOf } from "./project.ts";
import { round } from "./rust.ts";
import * as tools from "./tools.ts";
import * as watch from "./watch.ts";

const FILE = "marks-v1.json";

/** A mark: what it says and its box (x0, y0, x1, y1 as shares of the picture from its top left). */
export type Mark = { text: string; box: [number, number, number, number] };

type VideoClip = Extract<Clip, { type: "video" }>;

const PROMPT =
  "This is a photo an editor found online for a true-crime video. List every mark added on top of it after it was taken: " +
  "a TV network's or show's logo or bug (DATELINE, NBC, ABC, CBS, FOX, 48 HOURS, Oxygen, a local station), a news outlet's or photographer's credit, " +
  "a stock site's watermark (Getty Images, Alamy, Shutterstock), a website address or social handle, a headline, caption or banner laid over the picture. " +
  "Not text that's part of the scene itself (signs, clothing, a truck's markings, papers held up). " +
  'Answer only JSON: {"marks": [{"text": what it says or shows, "box": [ymin, xmin, ymax, xmax] from 0 to 1000}]}, an empty list when there are none.';

const reading = new Set<string>();

function cacheFile(media: Media): string | null {
  if (!isReal() || tools.isUrl(media.path)) return null;
  const dir = tools.mediaCache(media.path);
  return dir === null ? null : join(dir, FILE);
}

/** A photo's marks once looked at (null: not yet). */
export function cachedMarks(media: Media): Mark[] | null {
  const file = cacheFile(media);
  if (file === null) return null;
  try {
    return (JSON.parse(fs.readFileSync(file, "utf8")) as { marks: Mark[] }).marks;
  } catch {
    return null;
  }
}

/** The model's answer as marks (boxes as shares of the picture). */
export function readMarks(answer: string): Mark[] {
  const given = JSON.parse(watch.unfence(answer)) as { marks?: { text?: unknown; box?: unknown }[] };
  const out: Mark[] = [];
  for (const mark of given.marks ?? []) {
    const box = Array.isArray(mark.box) ? mark.box.map(Number) : [];
    if (box.length !== 4 || box.some((value) => !Number.isFinite(value))) continue;
    const [ymin, xmin, ymax, xmax] = box.map((value) => Math.min(Math.max(value / 1000, 0), 1)) as [number, number, number, number];
    if (xmax <= xmin || ymax <= ymin) continue;
    out.push({ text: String(mark.text ?? ""), box: [xmin, ymin, xmax, ymax] });
  }
  return out;
}

/** Looks at one photo (a small JPEG of it) and caches its marks. */
async function look(media: Media, file: string): Promise<void> {
  const jpeg = await tools.run([
    tools.ffmpeg(),
    "-hide_banner",
    "-nostdin",
    "-i",
    media.path,
    "-vf",
    "scale='min(1024,iw)':-2",
    "-frames:v",
    "1",
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "-",
  ]);
  const request = {
    model: watch.MODEL,
    reasoning: { effort: "low" },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: PROMPT },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}` } },
        ],
      },
    ],
  };
  const scratch = `${file}.request`;
  fs.writeFileSync(scratch, JSON.stringify(request));
  let response: unknown;
  try {
    response = await watch.post(scratch);
  } finally {
    fs.rmSync(scratch, { force: true });
  }
  const content = (response as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("the model gave no answer");
  fs.writeFileSync(file, JSON.stringify({ marks: readMarks(content) }));
}

/** Starts looking at a photo in the background (once at a time per file). */
function warm(media: Media): void {
  const file = cacheFile(media);
  if (file === null || reading.has(media.path)) return;
  reading.add(media.path);
  void look(media, file)
    .catch((error: unknown) => diag.warn("audit", `looking for marks on ${media.name}: ${diag.messageOf(error)}`))
    .finally(() => reading.delete(media.path));
}

/** A mark's box on the frame (centre x, y, width, height in project pixels from the frame's centre) at the clip's first frame. */
function onFrame(project: Project, clip: VideoClip, media: Media, [x0, y0, x1, y1]: Mark["box"]): [number, number, number, number] {
  const { width, height } = project.settings;
  const [mw, mh] = [media.width ?? width, media.height ?? height];
  const scale = clip.keyframes?.scale?.[0]?.value ?? clip.transform?.scale ?? 1;
  const fit = Math.min(width / mw, height / mh) * scale;
  const x = clip.keyframes?.x?.[0]?.value ?? clip.transform?.x ?? 0;
  const y = clip.keyframes?.y?.[0]?.value ?? clip.transform?.y ?? 0;
  const cx = ((x0 + x1) / 2 - 0.5) * mw * fit + x;
  const cy = ((y0 + y1) / 2 - 0.5) * mh * fit + y;
  return [round(cx), round(cy), round((x1 - x0) * mw * fit), round((y1 - y0) * mh * fit)];
}

/** Whether a mark's box is on screen at all: inside the frame and not cropped away. */
function seen(project: Project, clip: VideoClip, box: Mark["box"], [cx, cy, w, h]: [number, number, number, number]): boolean {
  const { width, height } = project.settings;
  const crop = clip.crop ?? { left: 0, right: 0, top: 0, bottom: 0 };
  const [x0, y0, x1, y1] = box;
  if (x1 <= (crop.left ?? 0) || x0 >= 1 - (crop.right ?? 0) || y1 <= (crop.top ?? 0) || y0 >= 1 - (crop.bottom ?? 0)) return false;
  return cx + w / 2 > -width / 2 + 4 && cx - w / 2 < width / 2 - 4 && cy + h / 2 > -height / 2 + 4 && cy - h / 2 < height / 2 - 4;
}

/** Whether a rect blur above the clip covers the box while it's up. */
function blurred(project: Project, clip: VideoClip, [x, y, w, h]: [number, number, number, number]): boolean {
  return project.clips.some((other) => {
    if (other.type !== "adjustment" || trackOf(project, other.track)?.hidden === true) return false;
    if (other.start > clip.start + 2 || clipEnd(other) < clipEnd(clip) - 2) return false;
    const blur = other.blur;
    if (blur === undefined || blur === null || (blur.radius ?? 0) < 12) return false;
    if (blur.width === undefined || blur.width === null || blur.width <= 0) return true;
    return Math.abs(x - (blur.x ?? 0)) + w / 2 <= blur.width / 2 + 10 && Math.abs(y - (blur.y ?? 0)) + h / 2 <= (blur.height ?? 0) / 2 + 10;
  });
}

/** Marks still showing on photos on the timeline, and the photos not looked at yet (looked at in the background). */
export function issues(project: Project): { issues: unknown[]; pending: string[] } {
  const out: unknown[] = [];
  const pending = new Set<string>();
  for (const clip of project.clips) {
    if (clip.type !== "video" || trackOf(project, clip.track)?.hidden === true) continue;
    const media = mediaOf(project, clip.media);
    // Found photos only: Edit's own pictures (desktop windows, wallpaper, frames) carry no one's mark.
    if (media === undefined || media.kind !== "image" || /^(desktop|map|frame|board|paper)-/u.test(media.name)) continue;
    const marks = cachedMarks(media);
    if (marks === null) {
      if (cacheFile(media) !== null) {
        pending.add(media.name);
        warm(media);
      }
      continue;
    }
    for (const mark of marks) {
      const box = onFrame(project, clip, media, mark.box);
      if (!seen(project, clip, mark.box, box) || blurred(project, clip, box)) continue;
      out.push({
        kind: "watermarked_picture",
        clip: clip.id,
        start: clip.start,
        text: mark.text,
        blur_box: box,
        fix: "crop past it (scale, x/y or crop so it's off the frame) or a rect blur over blur_box under the texts; or another picture",
      });
    }
  }
  return { issues: out, pending: [...pending].sort() };
}
