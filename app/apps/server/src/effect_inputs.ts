// What a coded effect is given from the timeline, beyond its own folder
// (Sphe, Nov 11: "create this insane effect and then just track it onto
// footage"; a glass panel that bends and blurs what's behind it):
//
// - A tracked path: points (boxes) in the footage under the effect followed
//   through it by Edit's tracker (track.rs: template matching carried by the
//   camera's own move, as track_region does for the house's clips), written
//   into the effect's folder as a script, frame by frame in frame pixels, so
//   the effect's code draws wherever they are at any second. Several points
//   give it scale, turn or a surface's four corners to warp onto.
// - The picture beneath: whatever the tracks below the effect's clip show for
//   its span, rendered by the export into its folder as a video the page
//   draws (and blurs, bends, refracts) itself. Kept in step: when what's
//   beneath changes, it's made again before the effect's next render.
//
// Both land in the folder like effect_footage's video and levels: the page
// still has no network, and the same t is still the same picture.

import fs from "node:fs";

import type { App } from "./app.ts";
import { footageFraming, toProject, toSource } from "./captions.ts";
import * as diag from "./diag.ts";
import * as effects from "./effects.ts";
import { writeAtomic } from "./files.ts";
import { Semaphore } from "./media.ts";
import type { Media, Project } from "./model.ts";
import { native } from "./native/index.ts";
import { join } from "./paths.ts";
import { clipContains, clipEnd, fps as fpsOf, mediaOf } from "./project.ts";
import { jsonForSerde } from "./rust.ts";
import { stableStringify } from "./stable.ts";
import * as tools from "./tools.ts";

type Box = [number, number, number, number];

export interface Point {
  /** Its name in the data (a word: face, corner_tl). */
  name: string;
  /** Where it is at the moment given, project pixels from the top-left. */
  box: Box;
  /** The same thing at other moments of the same footage (timeline seconds): a long or fast stretch stays on it. */
  boxes?: { time: number; box: Box }[];
}

/** At most this long tracked in one go (the tracker's own limit). */
const MOST_TRACKED_S = 180;

const NAME = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * Tracks `points` (as they are at timeline `time`) through the footage there,
 * over timeline seconds `from`–`to` (the footage clip's span by default), and
 * writes `<as>.track.js` into effect `name`'s folder. Answers what the agent
 * needs to use it, and where it lost a point.
 */
export async function track(app: App, projectId: string, name: string, time: number, points: Point[], span: [number | null, number | null], as: string): Promise<string> {
  const live = app.store.get(projectId);
  if (live === null) throw new Error("no such project");
  const project = live.project;
  const dir = effects.folder(app.store, projectId, name);
  if (!fs.existsSync(join(dir, effects.ENTRY))) throw new Error(`no effect "${name}": write its ${effects.ENTRY} first`);
  if (!NAME.test(as)) throw new Error("as is a short lower-case word (letters, digits, _), starting with a letter");
  if (points.length === 0 || points.length > 8) throw new Error("points: one to eight, each {name, box}");
  for (const point of points) if (!NAME.test(point.name)) throw new Error(`point name "${point.name}": a short lower-case word (letters, digits, _)`);
  const fps = fpsOf(project);
  const [width, height] = [project.settings.width, project.settings.height];
  const frame = Math.floor(time * fps);
  const shot = footageAt(project, frame);
  if (shot === null) throw new Error(`no footage at ${time.toFixed(2)} s to track (a video clip that isn't an effect)`);
  const media = mediaOf(project, shot.media)!;
  const first = Math.max(shot.start, Math.round((span[0] ?? -Infinity) * fps));
  const last = Math.min(clipEnd(shot), Math.round((span[1] ?? Infinity) * fps));
  if (last - first < 2) throw new Error(`the footage there (${shot.id}) plays ${(shot.start / fps).toFixed(2)}–${(clipEnd(shot) / fps).toFixed(2)} s: give from and to inside it`);
  if ((last - first) / fps > MOST_TRACKED_S) throw new Error(`at most ${MOST_TRACKED_S} s tracked in one go: give from and to`);
  const toSourceTime = (at: number) => shot.source_in + ((at - shot.start) / fps) * shot.speed;
  const toTimelineFrame = (seconds: number) => shot.start + ((seconds - shot.source_in) / shot.speed) * fps;
  const centre = (x: number, y: number): [number, number] => [x - width / 2, y - height / 2];
  const toSourceBox = (at: number, box: Box): Box => {
    const fit = footageFraming(shot, shot.transform, at);
    const a = toSource(media, fit, [width, height], centre(box[0], box[1]));
    const b = toSource(media, fit, [width, height], centre(box[2], box[3]));
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  };
  const frames = last - first;
  const paths: Record<string, { x: number[]; y: number[]; w: number[]; h: number[] }> = {};
  const lost: Record<string, [number, number][]> = {};
  let cuts: number[] = [];
  for (const point of points) {
    const anchors = [{ at: toSourceTime(frame), region: toSourceBox(frame, point.box) }];
    for (const more of point.boxes ?? []) {
      const at = Math.floor(more.time * fps);
      if (!clipContains(shot, at)) throw new Error(`${point.name}'s box at ${more.time.toFixed(2)} s isn't on the footage tracked (${shot.id})`);
      anchors.push({ at: toSourceTime(at), region: toSourceBox(at, more.box) });
    }
    const tracked = await native().trackAnchors({ path: media.path, size: [media.width, media.height], fps: media.fps, from: toSourceTime(first), to: toSourceTime(last), anchors });
    if (tracked.samples.length < 2) throw new Error(`lost ${point.name} straight away: give a tighter box around something distinct`);
    const source = anchors[0]!.region;
    const [sw, sh] = [source[2] - source[0], source[3] - source[1]];
    // Each sample where it's seen on screen, at its timeline frame (the footage's framing then, its push-in and all).
    const seen = tracked.samples.map((sample) => {
      const at = toTimelineFrame(sample.time);
      const fit = footageFraming(shot, shot.transform, Math.round(at));
      const a = toProject(media, fit, [width, height], [sample.x - sw / 2, sample.y - sh / 2]);
      const b = toProject(media, fit, [width, height], [sample.x + sw / 2, sample.y + sh / 2]);
      return { at, x: (a[0] + b[0]) / 2 + width / 2, y: (a[1] + b[1]) / 2 + height / 2, w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
    });
    const path = { x: [] as number[], y: [] as number[], w: [] as number[], h: [] as number[] };
    let next = 0;
    for (let index = 0; index < frames; index++) {
      const at = first + index;
      while (next < seen.length - 1 && seen[next + 1]!.at <= at) next++;
      const a = seen[next]!;
      const b = seen[Math.min(next + 1, seen.length - 1)]!;
      const t = b.at > a.at ? Math.min(1, Math.max(0, (at - a.at) / (b.at - a.at))) : 0;
      const mix = (key: "x" | "y" | "w" | "h") => Math.round((a[key] + (b[key] - a[key]) * t) * 10) / 10;
      path.x.push(mix("x"));
      path.y.push(mix("y"));
      path.w.push(mix("w"));
      path.h.push(mix("h"));
    }
    paths[point.name] = path;
    const seconds = (source: number) => Math.round(((toTimelineFrame(source) - first) / fps) * 100) / 100;
    lost[point.name] = tracked.lost.map(([a, b]) => [seconds(a), seconds(b)]);
    cuts = tracked.cuts.map(seconds);
  }
  const data = { fps, start: Math.round((first / fps) * 1000) / 1000, frames, points: paths, lost, cuts };
  writeAtomic(
    join(dir, `${as}.track.js`),
    `// Tracked by Edit (effect_track): each point's centre (x, y) and size (w, h) in frame pixels from the top-left, one entry a frame from \`start\` (timeline seconds).\n` +
      `(window.tracks = window.tracks || {})[${JSON.stringify(as)}] = ${JSON.stringify(data)};\n` +
      `window.tracks[${JSON.stringify(as)}].at = function (name, t) {\n` +
      `  const p = this.points[name], f = Math.min(Math.max(t * this.fps, 0), this.frames - 1), i = Math.floor(f), j = Math.min(i + 1, this.frames - 1), k = f - i;\n` +
      `  const mix = (list) => list[i] + (list[j] - list[i]) * k;\n` +
      `  return { x: mix(p.x), y: mix(p.y), w: mix(p.w), h: mix(p.h) };\n` +
      `};\n`,
  );
  const lines = [
    `effects/${name}/${as}.track.js: ${points.map((point) => point.name).join(", ")} over ${(first / fps).toFixed(2)}–${(last / fps).toFixed(2)} s of ${shot.id} (${frames} frames). Load it with <script src="${as}.track.js"></script>; window.tracks.${as}.at(name, t) is {x, y, w, h} in frame pixels at second t of an effect whose clip starts at ${(first / fps).toFixed(2)} s (place it there).`,
  ];
  if (cuts.length > 0) lines.push(`The footage cuts at ${cuts.map((cut) => `${cut.toFixed(2)} s`).join(", ")} into it.`);
  for (const point of points) {
    const gone = lost[point.name]!;
    if (gone.length > 0) lines.push(`Lost ${point.name} at ${gone.map(([a, b]) => `${a.toFixed(2)}–${b.toFixed(2)} s`).join(", ")} (it rides with the camera there): look, and track again with its box there in boxes.`);
  }
  return lines.join("\n");
}

/** The topmost visible footage (a video that isn't an effect) at a timeline frame. */
function footageAt(project: Project, frame: number) {
  const order = project.tracks.filter((one) => one.kind === "video" && !one.hidden).map((one) => one.id);
  let found: Extract<Project["clips"][number], { type: "video" }> | null = null;
  let best = -1;
  for (const clip of project.clips) {
    if (clip.type !== "video" || !clipContains(clip, frame)) continue;
    const media = mediaOf(project, clip.media);
    if (media === undefined || media.kind !== "video" || typeof media.effect === "string") continue;
    const rank = order.indexOf(clip.track);
    if (rank >= best) {
      best = rank;
      found = clip;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// The picture beneath

/** What an effect's folder keeps of what's beneath it: the video, and what it was made from. */
export const BENEATH = "beneath.mp4";
const BENEATH_KEY = ".beneath.json";

const beneathSlot = new Semaphore(1);

/** The effect's clip, and the project as only the tracks below it: what it's laid over, or null when it isn't placed. */
function under(project: Project, name: string): { start: number; end: number; project: Project; key: string } | null {
  const media = project.media.find((one) => one.effect === name);
  if (media === undefined) return null;
  const clip = project.clips.find((one) => one.type === "video" && one.media === media.id);
  if (clip === undefined) return null;
  const order = project.tracks.filter((one) => one.kind === "video").map((one) => one.id);
  const below = new Set(order.slice(0, Math.max(0, order.indexOf(clip.track))));
  const [start, end] = [clip.start, clipEnd(clip)];
  const clips = project.clips.filter((one) => below.has(one.track) && one.start < end && clipEnd(one) > start);
  const used = new Set(clips.map((one) => ("media" in one ? one.media : null)).filter((one): one is string => typeof one === "string"));
  const media_ = project.media.filter((one) => used.has(one.id));
  const key = new Bun.CryptoHasher("sha256")
    .update(stableStringify({ version: 1, settings: project.settings, start, end, clips, media: media_.map((one: Media) => ({ id: one.id, path: one.path, effect_key: one.effect_key ?? null })) }))
    .digest("hex")
    .slice(0, 16);
  return { start, end, project: { ...project, clips, tracks: project.tracks.filter((one) => below.has(one.id)) }, key };
}

/**
 * Renders what's beneath effect `name`'s clip, for its span, into its folder
 * (`beneath.mp4`: no sound, a keyframe every third of a second for seeking),
 * unless it's already of what's there now. Answers whether it was made.
 */
export async function beneath(app: App, projectId: string, name: string): Promise<{ made: boolean; seconds: number }> {
  return beneathSlot.with(async () => {
    const live = app.store.get(projectId);
    if (live === null) throw new Error("no such project");
    const dir = effects.folder(app.store, projectId, name);
    if (!fs.existsSync(join(dir, effects.ENTRY))) throw new Error(`no effect "${name}"`);
    const found = under(live.project, name);
    if (found === null) throw new Error(`${name} isn't on the timeline: place it first (what's beneath it is what's on the tracks below its clip)`);
    const fps = fpsOf(live.project);
    const seconds = (found.end - found.start) / fps;
    const keyFile = join(dir, BENEATH_KEY);
    try {
      if ((JSON.parse(fs.readFileSync(keyFile, "utf8")) as { key?: string }).key === found.key && fs.existsSync(join(dir, BENEATH))) return { made: false, seconds };
    } catch {
      // Never made, or unreadable: made now.
    }
    const work = join(app.store.cacheDir(), "beneath");
    fs.mkdirSync(work, { recursive: true });
    const exported = join(work, `${projectId}-${name}-${found.key}.mp4`);
    const partial = join(dir, `${BENEATH}.partial.mp4`);
    try {
      const options = { ...native().exportDefaults(), format: "h264" as const, size: null, range: [found.start, found.end] as [number, number], quality: "high" as const, audio: false, loudness: null };
      const input = { json: jsonForSerde(found.project) };
      const { plan } = native().exportPlan(input, options);
      const job = native().ExportJob.start({ project: input, options, plan, output: exported, cacheDir: app.store.cacheDir() }, () => {});
      const timer = setTimeout(() => job.cancel(), 10 * 60_000);
      try {
        await job.wait();
      } finally {
        clearTimeout(timer);
      }
      // Seekable as the page plays it: a keyframe every third of a second, as effect_footage's.
      await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-i", exported, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-g", "10", "-pix_fmt", "yuv420p", "-movflags", "+faststart", partial]);
      fs.renameSync(partial, join(dir, BENEATH));
      writeAtomic(keyFile, JSON.stringify({ key: found.key }));
    } finally {
      fs.rmSync(exported, { force: true });
      fs.rmSync(partial, { force: true });
    }
    return { made: true, seconds };
  });
}

/** Before an HQ project's effects render: each one that draws what's beneath it gets it made again if that changed. */
async function keepBeneath(app: App, projectId: string): Promise<void> {
  const live = app.store.get(projectId);
  if (live === null) return;
  for (const name of effects.onTimeline(live.project)) {
    if (!fs.existsSync(join(effects.folder(app.store, projectId, name), BENEATH_KEY))) continue;
    try {
      await beneath(app, projectId, name);
    } catch (error) {
      diag.warn("effects", `${projectId}: what's beneath ${name}: ${diag.messageOf(error)}`);
    }
  }
}

/** Hooks keeping what's beneath in step into the effects' renders (once). */
export function start(): void {
  effects.beforeRenders.set("beneath", keepBeneath);
}
