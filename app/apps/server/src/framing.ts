// What fills the frame. Footage and pictures sit on screen at "scale 1 = fit
// the frame", so a 720×480 interrogation tape (3:2), a 4:3 interview or a
// portrait photo showed black bars on a 16:9 edit, and many tapes carry a few
// black pixels of their own at an edge. The team, on Helpful Wife (Oct 20):
// "throughout this entire video, we need to do so that there are no black
// bars on the footage". So:
// - `fill`: the scale (and x/y) that fills the frame with a media's picture,
//   its own black borders cropped past; footage is placed that way.
// - `borders`: those borders, found by FFmpeg's cropdetect once per file
//   (`borders-v1.json` in its cache dir), in the background.
// - `letterboxed`: the audit's issue for a picture on screen with black round
//   it: it doesn't fill the frame and nothing beneath it does either.

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import type { Clip, Media, Project } from "./model.ts";
import { isReal } from "./native/index.ts";
import { join } from "./paths.ts";
import { clipEnd, mediaOf, trackOf } from "./project.ts";
import { round } from "./rust.ts";
import * as tools from "./tools.ts";

/** The analysis's file in the media's cache dir; a new method is a new file. */
const FILE = "borders-v1.json";

/** Shares of the picture that are black border on each side. */
export type Borders = { left: number; right: number; top: number; bottom: number };

const NONE: Borders = { left: 0, right: 0, top: 0, bottom: 0 };

/** A border thinner than this share is noise, not a border. */
const THIN = 0.004;
/** Past this share on a side it's not a border but a dark picture. */
const THICK = 0.3;

type VideoClip = Extract<Clip, { type: "video" }>;
/** What finding borders needs of a media (a probed file will do). */
type Picture = Pick<Media, "path" | "name" | "kind" | "duration" | "width" | "height">;

const known = new Map<string, Borders>();
const finding = new Set<string>();

function cacheFile(media: Pick<Media, "path">): string | null {
  if (!isReal() || tools.isUrl(media.path)) return null;
  const dir = tools.mediaCache(media.path);
  return dir === null ? null : join(dir, FILE);
}

/** A media's black borders when they've been found (null: not yet). */
export function cachedBorders(media: Pick<Media, "path">): Borders | null {
  const hit = known.get(media.path);
  if (hit !== undefined) return hit;
  const file = cacheFile(media);
  if (file === null) return null;
  try {
    const given = JSON.parse(fs.readFileSync(file, "utf8")) as Borders;
    const borders = { left: given.left ?? 0, right: given.right ?? 0, top: given.top ?? 0, bottom: given.bottom ?? 0 };
    known.set(media.path, borders);
    return borders;
  } catch {
    return null;
  }
}

/** cropdetect's last `crop=w:h:x:y` as borders of a `width` × `height` picture. */
export function parseCrop(stderr: string, width: number, height: number): Borders {
  const all = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/gu)];
  const last = all[all.length - 1];
  if (last === undefined || width <= 0 || height <= 0) return NONE;
  const [w, h, x, y] = [Number(last[1]), Number(last[2]), Number(last[3]), Number(last[4])];
  const side = (share: number) => (share < THIN || share > THICK ? 0 : round(share * 10000) / 10000);
  return {
    left: side(x / width),
    right: side((width - x - w) / width),
    top: side(y / height),
    bottom: side((height - y - h) / height),
  };
}

/** Finds a media's borders (FFmpeg reads a few seconds from its middle), cached. */
export async function findBorders(media: Picture): Promise<Borders> {
  const cached = cachedBorders(media);
  if (cached !== null) return cached;
  const file = cacheFile(media);
  if (file === null || (media.kind !== "video" && media.kind !== "image")) return NONE;
  const input =
    media.kind === "video"
      ? ["-ss", String(Math.max(0, (media.duration ?? 0) * 0.3)), "-t", "8", "-i", media.path]
      : ["-i", media.path];
  // reset=0 keeps the widest picture seen: a dark moment never reads as border.
  const command = [tools.ffmpeg(), "-hide_banner", "-nostdin", ...input, "-an", "-vf", "fps=2,cropdetect=limit=24:round=2:reset=0", "-f", "null", "-"];
  let stderr = "";
  try {
    const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    [stderr] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  } catch (error) {
    diag.warn("media", `finding ${media.name}'s borders: ${diag.messageOf(error)}`);
    return NONE;
  }
  const borders = parseCrop(stderr, media.width ?? 0, media.height ?? 0);
  known.set(media.path, borders);
  try {
    fs.writeFileSync(file, JSON.stringify(borders));
  } catch {
    // Found again next time.
  }
  return borders;
}

/** Starts finding a media's borders in the background (once at a time per file). */
export function warmBorders(media: Picture): void {
  if (cachedBorders(media) !== null || finding.has(media.path) || cacheFile(media) === null) return;
  finding.add(media.path);
  void findBorders(media).finally(() => finding.delete(media.path));
}

/**
 * The transform that fills the frame with `media`'s picture (its own black
 * borders cropped past), centred: scale relative to the renderer's fit, and
 * the x/y that centres what's left once the borders are gone.
 */
export function fill(project: Project, media: Media, borders: Borders | null = cachedBorders(media)): { scale: number; x: number; y: number } {
  const { width: W, height: H } = project.settings;
  const [w, h] = [Math.max(media.width ?? W, 1), Math.max(media.height ?? H, 1)];
  const b = borders ?? NONE;
  const fit = Math.min(W / w, H / h);
  const [cw, ch] = [w * (1 - b.left - b.right), h * (1 - b.top - b.bottom)];
  // A hair over, so a rounding pixel never shows at an edge.
  const scale = Math.max(W / (cw * fit), H / (ch * fit)) * 1.004;
  const x = -((b.left - b.right) / 2) * w * fit * scale;
  let y = -((b.top - b.bottom) / 2) * h * fit * scale;
  // A photo taller than the frame keeps its top, where the faces are (a
  // portrait cropped through its middle showed a man from the nose down).
  if (media.kind === "image") {
    const shown = ch * fit * scale;
    y += Math.min(shown * (0.5 - FACE_HEIGHT), Math.max((shown - H) / 2, 0));
  }
  return { scale: round(scale * 10000) / 10000, x: round(x * 10) / 10, y: round(y * 10) / 10 };
}

/** Where a photo's faces usually are: this share of its height from the top. */
const FACE_HEIGHT = 0.35;

/** The value of a keyframed parameter at `frame` (clip-relative), linear between keys. */
function at(keys: { frame: number; value: number }[] | undefined, frame: number, still: number): number {
  if (keys === undefined || keys.length === 0) return still;
  if (frame <= keys[0]!.frame) return keys[0]!.value;
  for (let index = 1; index < keys.length; index++) {
    const [a, b] = [keys[index - 1]!, keys[index]!];
    if (frame <= b.frame) return a.value + ((b.value - a.value) * (frame - a.frame)) / Math.max(b.frame - a.frame, 1);
  }
  return keys[keys.length - 1]!.value;
}

/** Whether a video clip's picture (its borders and crop cut away) covers the whole frame at every key. */
export function covers(project: Project, clip: VideoClip, media: Media): boolean {
  if (Math.abs(clip.transform?.rotation ?? 0) > 0.01) return true;
  const { width: W, height: H } = project.settings;
  const [w, h] = [Math.max(media.width ?? W, 1), Math.max(media.height ?? H, 1)];
  const b = cachedBorders(media) ?? NONE;
  const crop = clip.crop ?? { left: 0, right: 0, top: 0, bottom: 0 };
  const [l, r, t, bo] = [
    Math.max(b.left, crop.left ?? 0),
    Math.max(b.right, crop.right ?? 0),
    Math.max(b.top, crop.top ?? 0),
    Math.max(b.bottom, crop.bottom ?? 0),
  ];
  const fit = Math.min(W / w, H / h);
  const keys = clip.keyframes ?? {};
  const frames = new Set<number>([0, Math.max(clip.duration - 1, 0)]);
  for (const name of ["x", "y", "scale"] as const) for (const key of keys[name] ?? []) frames.add(key.frame);
  for (const frame of frames) {
    const scale = at(keys.scale, frame, clip.transform?.scale ?? 1) * fit;
    const x = at(keys.x, frame, clip.transform?.x ?? 0);
    const y = at(keys.y, frame, clip.transform?.y ?? 0);
    // The picture's kept part on screen, from the frame's centre.
    const left = x + (l - 0.5) * w * scale;
    const right = x + (0.5 - r) * w * scale;
    const top = y + (t - 0.5) * h * scale;
    const bottom = y + (0.5 - bo) * h * scale;
    if (left > -W / 2 + 1 || right < W / 2 - 1 || top > -H / 2 + 1 || bottom < H / 2 - 1) return false;
  }
  return true;
}

/** Black, or near it: a solid that's a backing or a dip, not a picture. */
function blackSolid(clip: Clip): boolean {
  return clip.type === "solid" && Math.max(clip.fill[0], clip.fill[1], clip.fill[2]) <= 0.08;
}

/**
 * Pictures on screen with black round them (the audit's `letterboxed`): a
 * video clip of footage or a photo that doesn't fill the frame while nothing
 * beneath it does (a black "backing" solid is no picture). Framed pictures
 * (evidence cards, windows) and a page with a gradient over it (an outro's
 * mugshot beside its words) are designed that way.
 */
export function letterboxed(project: Project): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const level = (track: string) => project.tracks.findIndex((own) => own.id === track);
  const shown = (clip: Clip) => {
    const track = trackOf(project, clip.track);
    return track !== undefined && !track.hidden;
  };
  const coverAt = new Map<string, boolean>();
  const fills = (clip: Clip): boolean => {
    if (clip.type === "solid") return !blackSolid(clip) && (clip.gradient === undefined || clip.gradient === null) && (clip.opacity ?? 1) >= 0.99;
    if (clip.type !== "video" || (clip.opacity ?? 1) < 0.99) return false;
    let hit = coverAt.get(clip.id);
    if (hit === undefined) {
      const media = mediaOf(project, clip.media);
      hit = media !== undefined && media.kind !== "audio" && covers(project, clip, media);
      coverAt.set(clip.id, hit);
    }
    return hit;
  };
  const pictures = project.clips.filter((clip) => shown(clip) && (clip.type === "video" || clip.type === "solid"));
  for (const clip of pictures) {
    if (clip.type !== "video" || (clip.frame !== undefined && clip.frame !== null)) continue;
    // The Windows screen's pieces sit in its windows, which are designed (and fill their screens themselves).
    if (/Desktop · /u.test(clip.name ?? "")) continue;
    const media = mediaOf(project, clip.media);
    if (media === undefined || (media.kind !== "video" && media.kind !== "image")) continue;
    if ((clip.opacity ?? 1) < 0.5 || fills(clip)) continue;
    const designed = project.clips.some(
      (other) => other.type === "solid" && other.gradient !== undefined && other.gradient !== null && shown(other) && other.start < clipEnd(clip) && clipEnd(other) > clip.start,
    );
    if (designed && media.kind === "image") continue;
    // Looked at a few times across it: is anything beneath it filling the frame?
    const own = level(clip.track);
    const samples = [0.1, 0.35, 0.65, 0.9].map((share) => clip.start + Math.floor(clip.duration * share));
    const bare = samples.filter(
      (frame) => !pictures.some((other) => other !== clip && level(other.track) < own && other.start <= frame && frame < clipEnd(other) && fills(other)),
    ).length;
    if (bare < 2) continue;
    out.push({ clip: clip.id, start: clip.start, media: media.id });
  }
  return out;
}

/** The audit's `letterboxed`: the clips with black round them, one issue per file (an edit's footage is hundreds of clips). */
export function letterboxedIssues(project: Project): Record<string, unknown>[] {
  const byMedia = new Map<string, { clip: string; start: number }[]>();
  for (const one of letterboxed(project)) {
    const list = byMedia.get(one.media as string) ?? [];
    list.push({ clip: one.clip as string, start: one.start as number });
    byMedia.set(one.media as string, list);
  }
  const out: Record<string, unknown>[] = [];
  for (const [id, clips] of byMedia) {
    const media = mediaOf(project, id)!;
    const want = fill(project, media);
    clips.sort((a, b) => a.start - b.start);
    out.push({
      kind: "letterboxed",
      media: id,
      name: media.name,
      clips: clips.length,
      first: clips.slice(0, 8).map((one) => one.clip),
      start: clips[0]!.start,
      fill_scale: want.scale,
      fix: "op fill_frame (every clip of it, keeping each push and punch-in), or put a photo in a designed graphic (film_look full frame; file_viewer, photo_inset over footage)",
    });
  }
  return out;
}

/**
 * `{"op":"fill_frame"}` (optionally `clips: [ids]`, or `start`/`end` frames):
 * every picture with black round it scaled up to fill the frame, its pushes
 * and punch-ins kept (every scale key times the same factor) and its x/y
 * kept inside the picture so no edge shows.
 */
export function fillFrame(project: Project, args: Record<string, unknown>): Record<string, unknown> {
  const only = Array.isArray(args.clips) ? new Set(args.clips.map(String)) : null;
  const from = typeof args.start === "number" ? args.start : null;
  const to = typeof args.end === "number" ? args.end : null;
  const { width: W, height: H } = project.settings;
  const changed: string[] = [];
  for (const one of letterboxed(project)) {
    const clip = project.clips.find((own) => own.id === one.clip);
    if (clip === undefined || clip.type !== "video") continue;
    if (only !== null && !only.has(clip.id)) continue;
    if ((from !== null && clipEnd(clip) <= from) || (to !== null && clip.start >= to)) continue;
    const media = mediaOf(project, clip.media)!;
    const want = fill(project, media);
    const keys = clip.keyframes?.scale;
    const smallest = keys !== undefined && keys.length > 0 ? Math.min(...keys.map((key) => key.value)) : (clip.transform.scale ?? 1);
    const factor = Math.max(want.scale / Math.max(smallest, 0.01), 1);
    clip.transform = { ...clip.transform, scale: round((clip.transform.scale ?? 1) * factor * 10000) / 10000 };
    if (keys !== undefined) for (const key of keys) key.value = round(key.value * factor * 10000) / 10000;
    // x/y inside the picture at each scale: its kept part's edges past the frame's.
    const [w, h] = [Math.max(media.width ?? W, 1), Math.max(media.height ?? H, 1)];
    const fit = Math.min(W / w, H / h);
    const b = cachedBorders(media) ?? NONE;
    const clamp = (value: number, scale: number, axis: "x" | "y") => {
      const [size, frame, lo, hi] = axis === "x" ? [w, W, b.left, b.right] : [h, H, b.top, b.bottom];
      const centre = ((lo - hi) / 2) * size * fit * scale;
      const room = Math.max(((1 - lo - hi) * size * fit * scale - frame) / 2, 0);
      return round(Math.min(Math.max(value, -centre - room), -centre + room) * 10) / 10;
    };
    const scaleAt = (frame: number) => at(clip.keyframes?.scale, frame, clip.transform.scale ?? 1);
    // A photo goes where fill puts it (its top kept); footage keeps its own framing, inside the picture.
    const y0 = media.kind === "image" && (clip.keyframes?.y ?? []).length === 0 ? want.y : (clip.transform.y ?? 0);
    clip.transform = { ...clip.transform, x: clamp(clip.transform.x ?? 0, smallestScale(clip), "x"), y: clamp(y0, smallestScale(clip), "y") };
    for (const axis of ["x", "y"] as const) {
      for (const key of clip.keyframes?.[axis] ?? []) key.value = clamp(key.value, scaleAt(key.frame), axis);
    }
    changed.push(clip.id);
  }
  return { filled: changed.length, clips: changed.slice(0, 40) };
}

/** A clip's smallest scale (its keys', else its own). */
function smallestScale(clip: VideoClip): number {
  const keys = clip.keyframes?.scale;
  return keys !== undefined && keys.length > 0 ? Math.min(...keys.map((key) => key.value)) : (clip.transform.scale ?? 1);
}

/** Starts finding the borders of every picture on the timeline not read yet; the files still being read. */
export function pending(project: Project): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const clip of project.clips) {
    if (clip.type !== "video") continue;
    const media = mediaOf(project, clip.media);
    if (media === undefined || seen.has(media.id) || (media.kind !== "video" && media.kind !== "image")) continue;
    seen.add(media.id);
    if (cachedBorders(media) === null && cacheFile(media) !== null) {
      warmBorders(media);
      out.push(media.name);
    }
  }
  return out;
}

/** A teaser closer than this (its smallest scale ÷ the filled frame's) is punched in. */
const TEASER_CLOSE = 1.5;
/** The room under a narration reaches at least this close (÷ the filled frame) somewhere in each shot. */
const ROOM_CLOSE = 1.25;
const ROOM_CLOSE_SHARE = 0.3;
/** A bridge at least this long shows pictures of what's said this share of its time. */
const BRIDGE_SECONDS = 8;
const BRIDGE_PICTURES = 0.4;

/**
 * An interrogation's opening and bridges, from its sections' parts: teasers
 * too wide or static (`teaser_wide`: "we must be more zoomed in", "we must
 * also utilize zooms more"), the first hook coming in unheard
 * (`hook_unmarked`: "a riser or something like that that suggests that we
 * are about to start our first cut"), and bridges that are the room again
 * instead of what's said (`bridge_unillustrated`: "we say a lot of things
 * right here in the voiceover that we could literally show").
 */
export function interrogationIssues(project: Project, parts: { start: number; end: number; kind: string }[], unmarked: (at: number) => string[]): Record<string, unknown>[] {
  if (project.style !== "interrogation") return [];
  const out: Record<string, unknown>[] = [];
  const fps = project.settings.fps;
  const base = project.tracks.find((track) => track.kind === "video")?.id;
  const intro = parts.filter((part) => part.kind === "intro");
  // Teasers.
  const teasers = project.clips.filter(
    (clip): clip is VideoClip =>
      clip.type === "video" && clip.track === base && mediaOf(project, clip.media)?.kind === "video" && intro.some((part) => clip.start >= part.start && clip.start < part.end),
  );
  const wide: { clip: string; close: number; still: boolean }[] = [];
  for (const clip of teasers) {
    const media = mediaOf(project, clip.media)!;
    const close = smallestScale(clip) / fill(project, media).scale;
    const values = new Set((clip.keyframes?.scale ?? []).map((key) => round(key.value * 1000)));
    const still = values.size < 2;
    if (close < TEASER_CLOSE || still) wide.push({ clip: clip.id, close, still });
  }
  if (wide.length > 0) {
    const closes = wide.map((one) => one.close).sort((a, b) => a - b);
    out.push({
      kind: "teaser_wide",
      clips: wide.length,
      of: teasers.length,
      first: wide.slice(0, 8).map((one) => one.clip),
      closeness_median: round(closes[Math.floor(closes.length / 2)]! * 100) / 100,
      static: wide.filter((one) => one.still).length,
      fix: "punch in close on the person questioned (1.8–2.5× the filled frame, x/y on their face, inside the picture) and move: a push across the teaser, or a harder punch-in on the line that lands",
    });
  }
  // The room under a narration, held wide: "we need to be more zoomed in
  // here" (on the prologue's room). Per bridge (its shots share one push):
  // at least ROOM_CLOSE_SHARE of its room time closer than ROOM_CLOSE.
  const rooms = new Map<string, { close: number; total: number; first: string }>();
  for (const clip of project.clips) {
    if (clip.type !== "video" || clip.track === base || !(clip.name ?? "").includes("B-roll:")) continue;
    const media = mediaOf(project, clip.media);
    if (media === undefined || media.kind !== "video") continue;
    const bridge = /^(Cut-in \d+)/u.exec(clip.name ?? "")?.[1] ?? clip.id;
    const own = rooms.get(bridge) ?? { close: 0, total: 0, first: clip.id };
    const want = ROOM_CLOSE * fill(project, media).scale;
    for (let frame = 0; frame < clip.duration; frame += 3) {
      own.total += 1;
      if (at(clip.keyframes?.scale, frame, clip.transform.scale ?? 1) >= want) own.close += 1;
    }
    rooms.set(bridge, own);
  }
  const wideRooms = [...rooms.entries()].filter(([, own]) => own.total > 0 && own.close / own.total < ROOM_CLOSE_SHARE);
  if (wideRooms.length > 0) {
    out.push({
      kind: "room_wide",
      bridges: wideRooms.map(([bridge]) => bridge),
      fix: `the room under a narration comes closer than the tape: at least ${Math.round(ROOM_CLOSE_SHARE * 100)}% of each bridge's room time at ${ROOM_CLOSE}× the filled frame or more (punch-ins on the person questioned, a push that gets there)`,
    });
  }
  // The first hook: the first narration after the first teaser.
  const firstIntro = intro[0];
  const hook = firstIntro === undefined ? undefined : parts.find((part) => part.kind === "broll" && part.start >= firstIntro.end);
  if (hook !== undefined) {
    const missing = unmarked(hook.start);
    if (missing.length > 0) out.push({ kind: "hook_unmarked", at: hook.start, missing });
  }
  // The person questioned introduced by THE NAME CALLOUT (a small boxed
  // name beside them), never big faint letters across the room ("we need to
  // add her name next to her in a different way").
  const k = project.settings.height / 1080;
  for (const person of project.people ?? []) {
    if (person.role !== "suspect") continue;
    const words = person.name.split(/\s+/u).filter((word) => word.length > 2).map((word) => word.toLowerCase());
    const naming = project.clips.filter(
      (clip): clip is Extract<Clip, { type: "text" }> =>
        clip.type === "text" && !/^(Subtitle|Caption)/u.test(clip.name ?? "") && trackOf(project, clip.track)?.subtitles !== true && words.some((word) => clip.text.toLowerCase().includes(word)),
    );
    const callout = naming.some((clip) => clip.style.size <= 44 * k && clip.style.background !== undefined && clip.style.background !== null);
    const faint = naming.filter((clip) => clip.style.size >= 70 * k && (clip.opacity ?? 1) < 0.85 && (clip.style.background === undefined || clip.style.background === null));
    if (!callout || faint.length > 0) {
      out.push({
        kind: "name_not_introduced",
        person: person.name,
        faint: faint.map((clip) => clip.id),
        fix: "THE NAME CALLOUT where the narration first names them over the room: full name and age small in a black box beside their head, a thin white line from their neck (leader; give its x/y by hand if track_region can't follow the face); no big faint name",
      });
    }
  }
  // Bridges (every narration from the first hook on).
  const level = (track: string) => project.tracks.findIndex((own) => own.id === track);
  const picture = (clip: Clip): boolean => {
    const track = trackOf(project, clip.track);
    if (track === undefined || track.hidden) return false;
    if (clip.type === "text") return !/^(Subtitle|Caption|Countdown|Film look · tag|Closing line)/u.test(clip.name ?? "");
    if (clip.type !== "video") return false;
    const media = mediaOf(project, clip.media);
    if (media === undefined) return false;
    return media.kind === "image" || /^map-/u.test(media.name) || /Desktop · |File Viewer/u.test(clip.name ?? "") || (clip.track !== base && level(clip.track) > 0 && media.kind === "video" && (clip.frame !== undefined && clip.frame !== null));
  };
  for (const part of parts) {
    if (part.kind !== "broll" || hook === undefined || part.start < hook.start || part.end - part.start < BRIDGE_SECONDS * fps) continue;
    const shown = new Uint8Array(part.end - part.start);
    for (const clip of project.clips) {
      if (!picture(clip)) continue;
      for (let frame = Math.max(clip.start, part.start); frame < Math.min(clipEnd(clip), part.end); frame++) shown[frame - part.start] = 1;
    }
    const share = shown.reduce((sum, one) => sum + one, 0) / shown.length;
    if (share < BRIDGE_PICTURES) {
      out.push({
        kind: "bridge_unillustrated",
        start: part.start,
        end: part.end,
        pictures_share: round(share * 100) / 100,
        fix: "show what it names as it's said: people (file_viewer with their name, photo_inset), places (map_view), records and articles, their words (red_quote); collect_images / use_found for what you don't have",
      });
    }
  }
  return out;
}
