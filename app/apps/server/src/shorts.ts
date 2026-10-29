// YouTube Shorts (the `shorts` style): one video's highlights cut to 45–60
// seconds in a 9:16 frame, reframed on the subject (reframe.ts), with the
// house subtitles and a song under it. The team, Oct 29: "find the highlights
// and cut it down to around 45 to 60 seconds … make it a 9:16 format … the
// same subtitles as we do right now for the body cam. The music is a bit
// different." Here: the Short's music, fetched from a YouTube link the team
// gives (their picks aren't in the Drive library), and the audit's checks for
// a Short, which replace the police edits' (no teaser, map or outro here).

import * as fs from "node:fs";

import type { App } from "./app.ts";
import { subtitleStyle } from "./captions.ts";
import { clipFrom } from "./clips.ts";
import * as diag from "./diag.ts";
import { rgbaPng } from "./evidence_highlight.ts";
import { fillsFrame, framingAt } from "./frames_fill.ts";
import { importPaths } from "./import.ts";
import * as library from "./library.ts";
import { ORIGIN } from "./mcp/index.ts";
import { registerTool, text } from "./mcp/registry.ts";
import type { Clip, Keyframe, Project, TextStyle } from "./model.ts";
import { native } from "./native/index.ts";
import { join } from "./paths.ts";
import { addTrack, clipEnd, duration as durationOf, fps as fpsOf, freshId, mediaOf, trackOf } from "./project.ts";
import { f32 } from "./rust.ts";
import * as seams from "./seams.ts";
import * as faces from "./faces.ts";
import * as tools from "./tools.ts";
import * as youtube from "./youtube.ts";

/** A Short's length (seconds): the team's 45–60, with a little give either side. */
export const SHORTEST = 40;
export const LONGEST = 62;

/**
 * A song from a YouTube link as an audio media of the project (its sound
 * only, AAC), for the Short's music. Downloaded once per video on this Mac.
 */
export async function importMusic(app: App, projectId: string, url: string): Promise<{ media: string; name: string; seconds: number }> {
  const id = youtube.videoId(url);
  if (id === null) throw new Error("give the song as a YouTube link");
  const dir = join(app.store.cacheDir(), "music", id);
  const video = await youtube.download(app.store.home, id, dir, () => {});
  const name = video.name.replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N} ._-]+/gu, " ").trim().slice(0, 80) || id;
  const uploads = app.store.uploadsDir(projectId);
  fs.mkdirSync(uploads, { recursive: true });
  const out = join(uploads, `${name}.m4a`);
  if (!fs.existsSync(out)) {
    await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", video.path, "-vn", "-c:a", "aac", "-b:a", "192k", out]);
  }
  const [, added, errors] = await importPaths(app, projectId, [out], false, ORIGIN);
  const media = added[0];
  if (media === undefined) throw new Error(`couldn't import the song: ${errors.join("; ")}`);
  const found = app.store.get(projectId)?.project.media.find((one) => one.id === media);
  return { media, name, seconds: found?.duration ?? 0 };
}

/**
 * The song under the whole Short: from `from` seconds into it, `under` LU
 * under the footage's speech (a bed: 20), fading over the last second.
 */
async function placeUnder(app: App, projectId: string, media: string, name: string, from: number, under: number): Promise<string> {
  const project = app.store.get(projectId)?.project;
  if (project === undefined) throw new Error("no such project");
  const song = mediaOf(project, media)!;
  const seconds = durationOf(project) / fpsOf(project);
  if (seconds <= 0) throw new Error("the timeline is empty: cut the Short first, then place the song");
  const speech = await library.footageLoudness(project);
  const measured = await library.loudness(song.path, from, Math.min(seconds, song.duration - from));
  const volume = Math.min(Math.max(speech - under - measured, -40), 12);
  const placed = await seams.editing.placeSound(app.store, projectId, media, name, [], [0], { volume_db: f32(volume), seconds: Math.min(seconds, song.duration - from), lead: null, fade_out: 1, color: "green" });
  // From a later point in the song: its clip starts there.
  if (from > 0) {
    await app.store.update(projectId, ORIGIN, (edited) => {
      for (const clip of edited.clips) if (clip.type === "audio" && clip.media === media && clip.start === 0) clip.source_in = from;
    });
  }
  return `${placed}; the speech is ${speech.toFixed(1)} LUFS, the song ${measured.toFixed(1)}, so ${volume.toFixed(1)} dB puts it ${under} LU under`;
}

registerTool("import_music", async ({ app, args, projectId }) => {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (url === "") throw new Error("url is required: the song's YouTube link");
  const song = await diag.timeAsync("shorts", "import music", () => importMusic(app, projectId, url));
  if (args.place === false) return text(`imported ${song.name} as media ${song.media} (${Math.round(song.seconds)} s, sound only)`);
  const from = typeof args.from === "number" && args.from >= 0 ? args.from : 0;
  const under = typeof args.under_speech === "number" ? args.under_speech : 20;
  const placed = await placeUnder(app, projectId, song.media, song.name, from, under);
  return text(`imported ${song.name} (media ${song.media}) and laid it under the whole Short: ${placed}`);
});

function visibleClips(project: Project): Clip[] {
  return project.clips.filter((clip) => trackOf(project, clip.track)?.hidden !== true);
}

/** What the audit says about a Short (with its checks for every edit: gaps, footage run out). */
export function issues(project: Project): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const fps = fpsOf(project);
  const { width, height } = project.settings;
  const seconds = durationOf(project) / fps;
  if (height <= width) out.push({ kind: "short_not_vertical", fix: "a Short is 1080×1920: make a new Shorts project" });
  if (seconds < SHORTEST || seconds > LONGEST) {
    out.push({ kind: "short_length", seconds: Math.round(seconds * 10) / 10, fix: `cut it to 45–60 s of the video's highlights (it's ${Math.round(seconds)} s)` });
  }
  const clips = visibleClips(project);
  const footage = clips.filter((clip): clip is Extract<Clip, { type: "video" }> => clip.type === "video" && mediaOf(project, clip.media)?.kind === "video");
  for (const clip of footage) {
    if (!fillsFrame(project, clip)) {
      out.push({ kind: "short_unfilled", clip: clip.id, start: clip.start, fix: "reframe it (fills the 9:16 frame and follows the subject)" });
      continue;
    }
    // The subject at the clip's middle, from the faces already found: off the frame's middle third and a half, the camera missed them.
    const media = mediaOf(project, clip.media)!;
    const found = faces.cached(media.path);
    if (found === null) continue;
    const middle = Math.floor(clip.duration / 2);
    const index = Math.round((clip.source_in + (middle / fps) * clip.speed) * 2);
    // Someone in the background at the edge is fine: only when none of the
    // main faces there is in the middle (the vanilla Short's arrest shot,
    // flagged for the officer behind her).
    const here = found.get(index) ?? [];
    if (here.length === 0) continue;
    const biggest = Math.max(...here.map((face) => face[3] - face[1]));
    const { x, scale } = framingAt(clip, middle);
    const fit = Math.min(width / media.width, height / media.height) * scale;
    const placed = here.filter((face) => face[3] - face[1] >= biggest * 0.6).map((face) => ((face[0] + face[2]) / 2 - 0.5) * media.width * fit + x);
    if (placed.every((at) => Math.abs(at) > width * 0.35)) {
      out.push({ kind: "short_subject_off", clip: clip.id, start: clip.start, fix: "the face there is at the frame's edge: reframe it again, or with centres where the subject is" });
    }
  }
  if (!clips.some((clip) => (clip.name ?? "").startsWith("Subtitle"))) {
    out.push({ kind: "short_unsubtitled", fix: "add_subtitles over the whole Short (the house subtitles)" });
  }
  const music = clips.filter((clip) => clip.type === "audio" && mediaOf(project, clip.media)?.kind === "audio" && !(clip.name ?? "").startsWith("Voice"));
  if (music.length === 0) out.push({ kind: "short_no_music", fix: "import_music one of the Shorts songs and lay it under the whole Short, low" });
  else if (Math.max(...music.map(clipEnd)) < durationOf(project) - fps) {
    out.push({ kind: "short_music_stops", fix: "the music ends before the Short does: run it to the end and fade it out over the last second" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The callout, as the Shorts the team follows introduce someone (InOutNetwork's
// "WANTED SUSPECT", frame by frame): the picture freezes on them, cut in
// tighter and brighter, two lines of heavy white capitals with a deep shadow
// above them (the last word bigger) and a white hand-drawn arrow curving down
// to them; about a second, then the next shot. All of it at once, no
// animation in: it lands on the cut. (Their second line is italic; Edit's text
// has no italic yet, so it's upright.)

type Point = [number, number];

/** A white hand-drawn arrow from `tail` to `head` (px in its own box), bowing to one side, an open head. */
export function curvedArrowPng(width: number, height: number, tail: Point, head: Point, k: number): Uint8Array {
  const [dx, dy] = [head[0] - tail[0], head[1] - tail[1]];
  const length = Math.hypot(dx, dy) || 1;
  // The bow: a quarter of its length off the straight line, to the left of travel.
  const control: Point = [(tail[0] + head[0]) / 2 + (dy / length) * length * 0.25, (tail[1] + head[1]) / 2 - (dx / length) * length * 0.25];
  const points: Point[] = [];
  for (let i = 0; i <= 64; i++) {
    const t = i / 64;
    points.push([(1 - t) ** 2 * tail[0] + 2 * (1 - t) * t * control[0] + t ** 2 * head[0], (1 - t) ** 2 * tail[1] + 2 * (1 - t) * t * control[1] + t ** 2 * head[1]]);
  }
  // The head's two strokes, back from the tip along the curve's last direction.
  const [ex, ey] = [head[0] - points[60]![0], head[1] - points[60]![1]];
  const en = Math.hypot(ex, ey) || 1;
  const back: Point = [-ex / en, -ey / en];
  const barb = 34 * k;
  const turn = (v: Point, angle: number): Point => [v[0] * Math.cos(angle) - v[1] * Math.sin(angle), v[0] * Math.sin(angle) + v[1] * Math.cos(angle)];
  const strokes: [Point, Point][] = [];
  for (let i = 0; i < points.length - 1; i++) strokes.push([points[i]!, points[i + 1]!]);
  for (const angle of [0.55, -0.55]) {
    const v = turn(back, angle);
    strokes.push([head, [head[0] + v[0] * barb, head[1] + v[1] * barb]]);
  }
  const thick = 4.5 * k;
  const edge = 3 * k;
  const distance = (x: number, y: number, a: Point, b: Point) => {
    const [sx, sy] = [b[0] - a[0], b[1] - a[1]];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * sx + (y - a[1]) * sy) / (sx * sx + sy * sy || 1)));
    return Math.hypot(x - (a[0] + t * sx), y - (a[1] + t * sy));
  };
  return rgbaPng(width, height, (x, y) => {
    let near = Infinity;
    for (const [a, b] of strokes) near = Math.min(near, distance(x + 0.5, y + 0.5, a, b));
    if (near <= thick) return [255, 255, 255, 255];
    if (near <= thick + edge) return [0, 0, 0, Math.round(120 * (1 - (near - thick) / edge))];
    return null;
  });
}

/** The callout's words: heavy white capitals with a deep soft shadow, no box. */
function calloutStyle(width: number, height: number, size: number): TextStyle {
  const k = width / 1080;
  const base = subtitleStyle(width, height);
  const style: TextStyle = {
    ...base,
    font: "Geist",
    weight: 900,
    size: Math.round(size * k),
    color: [1, 1, 1, 1],
    uppercase: true,
    tracking: 0,
    line_height: 1,
    max_width: Math.round(width * 0.92),
    shadow: { color: [0, 0, 0, 1], opacity: 0.9, distance: Math.round(6 * k), angle: 120, size: 0, blur: Math.round(20 * k) },
  };
  delete style.background;
  delete style.label;
  return style;
}

/**
 * A callout over the Short at timeline frame `at`, `hold` frames: the footage
 * there frozen and cut in `zoom` times about `point` (the person's head,
 * project px from the frame's centre), brightened, `text` above them and an
 * arrow down to them. Its clips' ids.
 */
export async function callout(app: App, projectId: string, text: string, at: number, hold: number, point: Point, zoom: number): Promise<string[]> {
  const live = app.store.get(projectId);
  if (live === null) throw new Error("no such project");
  const project = live.project;
  const { width: W, height: H } = project.settings;
  const fps = fpsOf(project);
  const index = (track: string) => project.tracks.findIndex((one) => one.id === track);
  const under = project.clips
    .filter((clip): clip is Extract<Clip, { type: "video" }> => clip.type === "video" && clip.start <= at && at < clipEnd(clip) && mediaOf(project, clip.media)?.kind === "video" && trackOf(project, clip.track)?.hidden !== true)
    .sort((a, b) => index(b.track) - index(a.track))[0];
  if (under === undefined) throw new Error("no footage at that frame to freeze");
  const media = mediaOf(project, under.media)!;
  const seconds = under.source_in + ((at - under.start) / fps) * under.speed;
  const dir = app.store.uploadsDir(projectId);
  fs.mkdirSync(dir, { recursive: true });
  const still = join(dir, `callout ${media.id} ${seconds.toFixed(2)}s.png`);
  await native().saveStill(structuredClone(media), seconds, still);
  const [, stills, errors] = await importPaths(app, projectId, [still], false, ORIGIN);
  if (stills[0] === undefined) throw new Error(`couldn't freeze the frame: ${errors.join("; ")}`);
  // The frame as it was, then cut in about the person, still filling the frame.
  const { x, y, scale } = framingAt(under, at - under.start);
  const fit = Math.min(W / media.width, H / media.height);
  const framed = (z: number): [number, number, number] => {
    const s = scale * z;
    const [halfW, halfH] = [(media.width * fit * s) / 2, (media.height * fit * s) / 2];
    const clamp = (value: number, half: number, frame: number) => Math.max(frame / 2 - half, Math.min(half - frame / 2, value));
    return [clamp(point[0] - (point[0] - x) * z, halfW, W), clamp(point[1] - (point[1] - y) * z, halfH, H), s];
  };
  const [x0, y0, s0] = framed(zoom);
  const [x1, y1, s1] = framed(zoom * 1.05);
  const k = W / 1080;
  // Where the person is in the frozen, cut-in picture.
  const seen: Point = [x0 + (point[0] - x) * zoom, y0 + (point[1] - y) * zoom];
  const words = text.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) throw new Error("text is the callout's words (\"WANTED SUSPECT\")");
  const big = words.length === 1 ? words : words.slice(-1);
  const small = words.length === 1 ? [] : words.slice(0, -1);
  const bigY = Math.max(-H / 2 + 330 * k, seen[1] - 330 * k);
  const smallY = bigY - 128 * k;
  // The arrow: from under the words' left side, bowing down to just above the person.
  const tail: Point = [Math.max(-W / 2 + 120 * k, seen[0] - 200 * k), bigY + 95 * k];
  const head: Point = [seen[0] - 40 * k, Math.max(tail[1] + 60 * k, seen[1] - 70 * k)];
  const pad = 60 * k;
  const [bx0, by0] = [Math.min(tail[0], head[0]) - pad, Math.min(tail[1], head[1]) - pad];
  const [bw, bh] = [Math.ceil(Math.abs(head[0] - tail[0]) + 2 * pad), Math.ceil(Math.abs(head[1] - tail[1]) + 2 * pad)];
  const arrow = curvedArrowPng(bw, bh, [tail[0] - bx0, tail[1] - by0], [head[0] - bx0, head[1] - by0], k);
  const arrowPath = join(dir, `callout arrow ${Bun.hash(arrow).toString(16).slice(0, 12)}.png`);
  fs.writeFileSync(arrowPath, arrow);
  const [, arrows] = await importPaths(app, projectId, [arrowPath], false, ORIGIN);
  if (arrows[0] === undefined) throw new Error("couldn't draw the arrow");
  const linear = (frame: number, value: number): Keyframe => ({ frame, value, ease: "linear" });
  const [, made] = await app.store.update(projectId, ORIGIN, (edited) => {
    const out: string[] = [];
    const push = (fields: Record<string, unknown>) => {
      const id = freshId(edited, "c");
      edited.clips.push(clipFrom({ id, track: addTrack(edited, "video"), start: at, duration: hold, color: "blue", fade_in: 0, fade_out: 0, ...fields }));
      out.push(id);
    };
    push({
      type: "video", name: "Callout · frozen", media: stills[0], source_in: 0, speed: 1, opacity: 1,
      transform: { x: x0, y: y0, scale: s0, rotation: 0 },
      keyframes: { scale: [linear(0, s0), linear(hold - 1, s1)], x: [linear(0, x0), linear(hold - 1, x1)], y: [linear(0, y0), linear(hold - 1, y1)] },
    });
    push({ type: "adjustment", name: "Callout · brighter", opacity: 1, grade: { exposure: 0.3, contrast: 0.08, saturation: 0, temperature: 0, vignette: 0.3 } });
    if (small.length > 0) push({ type: "text", name: "Callout · words", text: small.join(" "), style: calloutStyle(W, H, 104), transform: { x: 0, y: smallY, scale: 1, rotation: 0 } });
    push({ type: "text", name: "Callout · words", text: big.join(" "), style: calloutStyle(W, H, 150), transform: { x: 0, y: bigY, scale: 1, rotation: 0 } });
    const art = mediaOf(edited, arrows[0]!)!;
    push({ type: "video", name: "Callout · arrow", media: arrows[0], source_in: 0, speed: 1, opacity: 1, transform: { x: bx0 + bw / 2, y: by0 + bh / 2, scale: 1 / Math.min(W / art.width, H / art.height), rotation: 0 } });
    return out;
  });
  return made;
}

registerTool("shorts_callout", async ({ app, args, projectId }) => {
  const words = typeof args.text === "string" ? args.text : "";
  const at = typeof args.at === "number" ? Math.round(args.at) : null;
  const point = Array.isArray(args.point) && args.point.length === 2 && args.point.every((v) => typeof v === "number") ? (args.point as Point) : null;
  if (at === null || point === null) throw new Error("at (the timeline frame to freeze) and point ([x, y]: the person's head, project px from the frame's centre) are required");
  const project = app.store.get(projectId)?.project;
  const fps = project === undefined ? 30 : fpsOf(project);
  const hold = typeof args.hold === "number" ? Math.round(args.hold) : Math.round(1.2 * fps);
  if (hold < 12) throw new Error("hold is frames, at least 12");
  const zoom = typeof args.zoom === "number" ? Math.min(2, Math.max(1, args.zoom)) : 1.25;
  const made = await callout(app, projectId, words, at, hold, point, zoom);
  return text(`callout clips ${made.join(", ")} at ${at}–${at + hold}: look at one frame that the arrow ends on them and the words are clear of their head`);
});
