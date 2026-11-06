// Horror's analog look (its guide, "Horror High Quality - Editing Rules &
// Processes"): "Always use grain and vignette on all footage, it's extremely
// important for the atmosphere we create", with the reference channels'
// chromatic aberration, an unsharp mask on people and saturated colour; and
// "Screenshots, whether from Reddit, Google, news articles, or anywhere else,
// should never look modern… they should always have a retro look", with a
// subtle grid and roughened edges (Sirius, Styks). B-roll never gets the grid.
//
// Both are Edit's call, not the agent's: the footage look is one grade
// (`GRADE`, commentary_look in a horror project covers every frame), and
// every screenshot a horror card shows is swapped for its retro copy, made
// here before the plan applies. The copy keeps the screenshot's exact size,
// so highlight_evidence's rectangles (original image pixels) still land on
// its words.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import { clipFrom } from "./clips.ts";
import { iconFile } from "./horror_graphics.ts";
import { rgbaPng } from "./evidence_highlight.ts";
import { houseMedia } from "./import.ts";
import type { Media, Project, VideoClip } from "./model.ts";
import { join } from "./paths.ts";
import { freshId } from "./project.ts";
import type * as seams from "./seams.ts";
import * as tools from "./tools.ts";

/** The footage look over the whole video: grain, vignette, colour fringes, crisp faces, saturated colour. */
export const GRADE = { grain: 0.16, vignette: 0.42, chromatic: 0.35, sharpen: 0.35, saturation: 0.12, contrast: 0.04 } as const;

/** The name the look's adjustment clips carry (the audit counts frames without it). */
export const LOOK_NAME = "Horror · analog look";

type Json = Record<string, unknown>;

/** A card op showing a screenshot (not `photo: true`, a picture of a person or place). */
function screenshotOf(project: Project, op: Json): Media | null {
  if (op.op !== "commentary_card" || op.photo === true || typeof op.media !== "string") return null;
  const media = project.media.find((m) => m.id === op.media);
  return media !== undefined && media.kind === "image" && !media.name.startsWith(RETRO) ? media : null;
}

const RETRO = "retro-";

/**
 * The FFmpeg filter that ages a w×h screenshot: softened as if captured
 * small, a touch more colour and contrast, still grain, red and blue a pixel
 * or two apart, a faint dark grid, and roughened (torn) edges in its alpha.
 */
export function retroFilter(width: number, height: number): string {
  const short = Math.min(width, height);
  const fringe = Math.max(1, Math.round(short / 600));
  const cell = Math.max(3, Math.round(short / 240));
  const edge = Math.max(4, Math.round(short * 0.014));
  // Distance in from the nearest side; inside a wavy, speckled threshold it's cut away.
  const inset = "min(min(X,W-1-X),min(Y,H-1-Y))";
  const threshold = `${edge}*(0.55+0.3*sin(X*0.19+Y*0.07)*cos(Y*0.23-X*0.03)+0.3*random(1))`;
  return [
    "format=rgba",
    `scale=${Math.max(2, Math.round(width * 0.6))}:${Math.max(2, Math.round(height * 0.6))}:flags=area`,
    `scale=${width}:${height}:flags=bicubic`,
    "eq=saturation=1.12:contrast=1.06:brightness=-0.015",
    "noise=c0s=7:c1s=7:c2s=7:allf=0",
    `rgbashift=rh=-${fringe}:bh=${fringe}`,
    // Sirius' scan lines across, Threadbare's fainter grid down.
    `drawgrid=w=iw:h=${cell}:t=1:c=black@0.24`,
    `drawgrid=w=${cell * 2}:h=ih:t=1:c=black@0.08`,
    `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(${inset},${threshold}),0,alpha(X,Y))'`,
  ].join(",");
}

/**
 * Retro copies of the screenshots a plan's horror cards show, imported into
 * the project: the original media id → its copy's. Nothing for other styles.
 */
export async function retroScreenshots(app: App, project: Project, operations: Json[]): Promise<[Record<string, string>, seams.Made[]]> {
  const swaps: Record<string, string> = {};
  const made: seams.Made[] = [];
  if (project.style !== "horror") return [swaps, made];
  const dir = join(app.store.home, "graphics", "horror");
  for (const op of operations) {
    const shot = screenshotOf(project, op);
    if (shot === null || swaps[shot.id] !== undefined) continue;
    const name = `${RETRO}${shot.id}-${shot.width}x${shot.height}.png`;
    const had = project.media.find((m) => m.name === name);
    if (had !== undefined) {
      swaps[shot.id] = had.id;
      continue;
    }
    fs.mkdirSync(dir, { recursive: true });
    const out = join(dir, `${project.id}-${name}`);
    if (!fs.existsSync(out)) {
      const remote = tools.isUrl(shot.path) ? ["-protocol_whitelist", tools.protocols(shot.path), ...tools.urlArgs(shot.path)] : [];
      const partial = `${out}.partial.png`;
      await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", ...remote, "-i", shot.path,
        "-vf", retroFilter(shot.width, shot.height), "-frames:v", "1", "-pix_fmt", "rgba", partial]);
      fs.renameSync(partial, out);
    }
    const [ids, fresh] = await houseMedia(app, project, [out]);
    const id = ids[0];
    if (id === undefined) throw new Error(`the retro copy of ${shot.name} didn't import`);
    const copy = project.media.find((m) => m.id === id);
    if (copy !== undefined) copy.name = name;
    swaps[shot.id] = id;
    made.push(...fresh);
  }
  return [swaps, made];
}

/**
 * Animation 11's icons a plan asks for by name (commentary_icon's `icon`),
 * drawn and brought into the project: each op's `media` set to its icon.
 */
export async function drawnIcons(app: App, project: Project, operations: Json[]): Promise<seams.Made[]> {
  const made: seams.Made[] = [];
  if (project.style !== "horror") return made;
  for (const op of operations) {
    if (op.op !== "commentary_icon" || op.media !== undefined) continue;
    const path = iconFile(app.store.home, op);
    if (path === null) continue;
    const name = path.split("/").pop()!;
    const had = project.media.find((m) => m.name === name);
    if (had !== undefined) { op.media = had.id; continue; }
    const [ids, fresh] = await houseMedia(app, project, [path]);
    if (ids[0] === undefined) throw new Error(`the ${String(op.icon)} icon didn't import`);
    const media = project.media.find((m) => m.id === ids[0]);
    if (media !== undefined) media.name = name;
    op.media = ids[0];
    made.push(...fresh);
  }
  return made;
}

const REEL_BACKDROP = "Horror · reel backdrop";
const REEL_BLUR = "Horror · reel blur";

/**
 * A tall picture (an Instagram reel, a phone video) shown full frame in a
 * horror project stands over a blurred, darkened copy of itself filling the
 * frame, never black bars (the user, Nov 4: "A blurred, darkened copy of the
 * reel behind it… yeah i think this"). Edit's call, not the agent's: after
 * every plan the copies are made again from what's placed, so a reel
 * trimmed, moved or cut keeps its backdrop exactly under it.
 */
export function fillReels(project: Project): void {
  const fresh = (prefix: string) => freshId(project, prefix);
  if (project.style !== "horror") return;
  const { width: w, height: h } = project.settings;
  const old = new Set(project.clips.filter((c) => c.name === REEL_BACKDROP || c.name === REEL_BLUR).map((c) => c.track));
  project.clips = project.clips.filter((c) => c.name !== REEL_BACKDROP && c.name !== REEL_BLUR);
  project.tracks = project.tracks.filter((t) => !old.has(t.id) || project.clips.some((c) => c.track === t.id));
  // A tall video zoomed in to fill the frame is shown whole instead, over its
  // blurred copy (the team, Nov 6: "for all the 9:16 videos it's better to
  // have the full height and then blur… in the background, instead of fully
  // zooming in till we reach the 16:9 ratio"). A move of its own (a push-in) stays.
  for (const c of project.clips) {
    if (c.type !== "video" || (c.name ?? "").includes("Horror ·") || (c.name ?? "").includes("Desktop ·") || c.frame != null) continue;
    const m = project.media.find((x) => x.id === c.media);
    if (m === undefined || m.kind !== "video" || m.height < m.width * 1.1) continue;
    const t = c.transform ?? {};
    const moved = ["scale", "x", "y"].some((key) => (c.keyframes?.[key as "scale"]?.length ?? 0) > 0);
    if (!moved && (t.scale ?? 1) > 1.6 && Math.abs(t.x ?? 0) < w * 0.25 && Math.abs(t.y ?? 0) < h * 0.5) c.transform = { ...t, scale: 1, x: 0, y: 0 };
  }
  const reels = project.clips.filter((c): c is VideoClip => {
    if (c.type !== "video" || (c.name ?? "").startsWith("Horror ·") || (c.name ?? "").startsWith("Janitor ·")) return false;
    const m = project.media.find((x) => x.id === c.media);
    if (m === undefined || m.kind !== "video" || m.height < m.width * 1.1) return false;
    const t = c.transform ?? {};
    // Full frame: as placed (fitted to the frame's height), not a small inset or a card.
    return (t.scale ?? 1) >= 0.95 && (t.scale ?? 1) <= 1.6 && Math.abs(t.x ?? 0) < w * 0.05 && Math.abs(t.y ?? 0) < h * 0.05 && c.frame == null;
  });
  if (reels.length === 0) return;
  // One pair of tracks under each track holding reels: the copy, then the blur over it.
  const pairs = new Map<string, [string, string]>();
  for (const track of [...new Set(reels.map((r) => r.track))]) {
    const at = project.tracks.findIndex((t) => t.id === track);
    const copy = { id: fresh("v"), kind: "video" as const, hidden: false, muted: false, locked: false };
    const blur = { id: fresh("v"), kind: "video" as const, hidden: false, muted: false, locked: false };
    project.tracks.splice(at, 0, copy, blur);
    pairs.set(track, [copy.id, blur.id]);
  }
  for (const reel of reels) {
    const m = project.media.find((x) => x.id === reel.media)!;
    const fit = Math.min(w / m.width, h / m.height);
    const cover = Math.max(w / (m.width * fit), h / (m.height * fit)) * 1.06;
    const [copyTrack, blurTrack] = pairs.get(reel.track)!;
    const base = { start: reel.start, duration: reel.duration, fade_in: reel.fade_in ?? 0, fade_out: reel.fade_out ?? 0, keyframes: {} };
    project.clips.push({ ...structuredClone(reel), ...base, id: fresh("c"), track: copyTrack, name: REEL_BACKDROP, link: undefined, transform: { ...(reel.transform ?? {}), x: 0, y: 0, scale: cover, rotation: 0 } } as typeof reel);
    project.clips.push({ id: fresh("c"), type: "adjustment", track: blurTrack, name: REEL_BLUR, ...base,
      blur: { radius: 38 * h / 1080 }, grade: { exposure: -0.85, vignette: 0.3, saturation: -0.15 } } as unknown as typeof reel);
  }
}

/**
 * A face or anything graphic hidden in a horror video is a mosaic, coarse
 * square blocks, never a smooth blur (the guide's reference: a child's face
 * in blocks beside the named man; "If it shows gore, bodies or graphic
 * injuries, censor it"). Edit's call: every region blur over the footage
 * becomes one, its blocks about an eighth of the region across. Edit's own
 * blurs (backdrops, motion, another channel's marks) stay smooth.
 */
export function mosaicCensors(project: Project): void {
  if (project.style !== "horror") return;
  const k = project.settings.height / 1080;
  for (const clip of project.clips) {
    if (clip.type !== "adjustment" || /^(Horror|Janitor|Desktop) · |^Mark blur/u.test(clip.name ?? "")) continue;
    const blur = (clip as { blur?: { radius: number; width?: number; height?: number; mosaic?: number } }).blur;
    if (blur === undefined || !(blur.radius > 0) || !((blur.width ?? 0) > 0) || !((blur.height ?? 0) > 0) || (blur.mosaic ?? 0) > 0) continue;
    blur.mosaic = Math.round(Math.min(Math.max(Math.min(blur.width!, blur.height!) / 8, 12 * k), 48 * k));
  }
}

/**
 * Horror's desktop wallpaper (its guide's Animation 1, an XP-era desktop):
 * a green hill rolling under a blue sky with soft clouds, drawn here, Edit's
 * own picture (nothing of Microsoft's), once per size into `<home>/graphics/`.
 */
export function xpWallpaper(home: string, width = 2400, height = 1350): string {
  const dir = join(home, "graphics", "horror"); fs.mkdirSync(dir, { recursive: true });
  const path = join(dir, `wallpaper-hill-v1-${width}x${height}.png`);
  if (fs.existsSync(path)) return path;
  const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i]! - v) * Math.min(1, Math.max(0, t)));
  const hash = (x: number, y: number) => { const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return v - Math.floor(v); };
  const blobs = [[0.18, 0.2, 0.16, 0.05], [0.42, 0.13, 0.2, 0.045], [0.75, 0.24, 0.18, 0.05], [0.9, 0.12, 0.12, 0.035], [0.6, 0.33, 0.22, 0.04], [0.08, 0.38, 0.16, 0.035]];
  fs.writeFileSync(path, rgbaPng(width, height, (px, py) => {
    const x = px / width; const y = py / height;
    // The hill's top: a long gentle rise to the right of the middle and a lower shoulder on the left.
    const crest = 0.6 - 0.14 * Math.exp(-((x - 0.62) ** 2) / 0.09) - 0.05 * Math.exp(-((x - 0.12) ** 2) / 0.03) + 0.01 * Math.sin(x * 9);
    if (y < crest) {
      let sky = mix([0.13, 0.4, 0.85], [0.62, 0.82, 0.98], (y / crest) ** 1.3);
      let cloud = 0;
      for (const [cx, cy, rx, ry] of blobs) {
        const d = ((x - cx!) / rx!) ** 2 + ((y - cy!) / ry!) ** 2;
        cloud += Math.exp(-d * 1.6) * (0.75 + 0.25 * Math.sin(x * 60 + y * 40) * Math.sin(x * 23 - y * 31));
      }
      sky = mix(sky, [0.97, 0.98, 1], Math.min(0.85, cloud));
      return [sky[0]! * 255, sky[1]! * 255, sky[2]! * 255, 255];
    }
    const depth = (y - crest) / (1 - crest);
    let grass = mix([0.48, 0.78, 0.2], [0.16, 0.45, 0.08], depth ** 0.8);
    // Lit along the crest, a little texture of grass all over.
    grass = mix(grass, [0.66, 0.88, 0.3], Math.max(0, 0.35 - depth * 3));
    const n = (hash(Math.floor(px / 2), Math.floor(py / 2)) - 0.5) * 0.06;
    return [(grass[0]! + n) * 255, (grass[1]! + n) * 255, (grass[2]! + n * 0.5) * 255, 255];
  }));
  return path;
}

/** Faint scan lines over an XP desktop (Animation 1: "with the same grid-like overlay and old YouTube look"). */
export function desktopLines(project: Project, start: number, end: number): void {
  const track = { id: freshId(project, "v"), kind: "video" as const, hidden: false, muted: false, locked: false };
  project.tracks.push(track);
  project.clips.push(clipFrom({ id: freshId(project, "c"), type: "adjustment", track: track.id, name: "Horror · desktop lines", start, duration: end - start,
    grade: { scanlines: 0.4 }, fade_in: 6, fade_out: 6 }));
}

/**
 * Horror's words always over its pictures: a title, a quote or a profile's
 * lines (and the blur that moves with it) lifted above every picture it
 * overlaps (v2, Nov 6: two quotes sat behind the photos placed after them).
 */
export function textOnTop(project: Project): void {
  if (project.style !== "horror") return;
  const order = () => new Map(project.tracks.map((t, i) => [t.id, i]));
  const words = project.clips.filter((c) => c.type === "text" && /^(Cut-in \d+ · )?Horror · /u.test(c.name ?? ""));
  for (const text of words) {
    const at = order();
    const end = text.start + text.duration;
    const above = project.clips.some((c) => c.type === "video" && c.start < end && c.start + c.duration > text.start && (at.get(c.track) ?? 0) > (at.get(text.track) ?? 0));
    if (!above) continue;
    const lift = (clip: Project["clips"][number]) => {
      const track = { id: freshId(project, "v"), kind: "video" as const, hidden: false, muted: false, locked: false };
      project.tracks.push(track);
      clip.track = track.id;
    };
    lift(text);
    for (const blur of project.clips.filter((c) => c.type === "adjustment" && c.parent === text.id)) lift(blur);
  }
}
