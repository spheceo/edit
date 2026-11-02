// A channel's watermark on the final video (Sphe, Nov 2: "once we do the
// FINAL export and are happy we have a checkbox to include the watermark and
// we pick the channel. so the opacity is like 20% and the logo moves around
// the screen like the dvd player"). The channels are the pictures in the
// team's Watermarks folder on Drive, one per channel (`SI_watermark.png` is
// Sams Interrogations), so a new channel is a new picture there, nothing here.
//
// The logo goes on the timeline being exported, not into the project: a
// locked top track over everything (subtitles too) with one picture clip
// across the export, at 20%, its x and y keyframed in straight lines from
// wall to wall, so this Mac, Modal and an export started again after a
// restart (its snapshot) all draw the same thing. In the cloud the picture
// goes up first like any other (cloud_media `importLocal`), so an edit whose
// footage is all in the cloud can still export on Modal.
//
//   GET /api/watermarks    {channels: [{id, code, name}]}: the folder's pictures

import * as fs from "node:fs";

import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";
import type { App } from "./app.ts";
import { json } from "./http/errors.ts";
import type { Router } from "./http/router.ts";
import { curl, driveError, encode, quote } from "./library.ts";
import type { Clip, Keyframe, Media, Plan, Project, Track } from "./model.ts";
import { native } from "./native/index.ts";
import { join } from "./paths.ts";
import { serdeParse } from "./rust.ts";
import * as seams from "./seams.ts";

const API = "https://www.googleapis.com/drive/v3";

/** The team's Watermarks folder (Drive): one picture per channel. */
export const FOLDER = process.env.EDIT_WATERMARKS_FOLDER ?? "1E1I0ykeqXFqrjIcU8P6fQEXgNBwdS6OU";

/** What a channel's short name in its file stands for, when the team has said. */
const NAMES: Record<string, string> = { SI: "Sams Interrogations" };

/** How the logo looks and moves, as the team asked: 20%, a DVD player's bounce. */
export const LOOK = {
  opacity: 0.2,
  /** The logo's height, a share of the frame's. */
  height: 0.14,
  /** Its speed along each axis, frame heights a second (a 1080p frame: 108 px/s, about 16 s across). */
  speed: 0.1,
  /** Kept off the frame's edge, a share of its height. */
  margin: 0.02,
};

/** The track and clip the watermark is, on the exported timeline only. */
export const TRACK = "watermark";

export interface Channel {
  /** The picture's Drive file id. */
  id: string;
  /** Its short name, from the file's ("SI"). */
  code: string;
  /** What the menu says ("Sams Interrogations"). */
  name: string;
  /** Drive's checksum: a changed picture is fetched again. */
  md5?: string;
}

/** A Watermarks folder picture as a channel: `SI_watermark.png` → SI, Sams Interrogations; `InspectorTed_watermark_under.png` → Inspector Ted. */
export function channelOf(file: { id: string; name: string; md5Checksum?: string }): Channel {
  const code = file.name.replace(/\.[a-z0-9]+$/iu, "").replace(/[_ -]*watermark.*$/iu, "").trim() || file.name;
  const name = NAMES[code] ?? code.replace(/([a-z])([A-Z])/gu, "$1 $2");
  return { id: file.id, code, name, ...(file.md5Checksum ? { md5: file.md5Checksum } : {}) };
}

let listed: { at: number; channels: Channel[] } | null = null;

/** The channels, by name; looked up again after five minutes, so a picture added to the folder shows soon. */
export async function channels(library: seams.Library, fresh = false): Promise<Channel[]> {
  if (!fresh && listed !== null && Date.now() - listed.at < 5 * 60_000) return listed.channels;
  const files: { id: string; name: string; mimeType: string; md5Checksum?: string }[] = [];
  let page = "";
  for (;;) {
    const query = `'${FOLDER}' in parents and trashed = false`;
    let url = `${API}/files?q=${encode(query)}&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=nextPageToken,files(id,name,mimeType,md5Checksum)`;
    if (page !== "") url += `&pageToken=${encode(page)}`;
    const [code, body] = await curl(`header = ${quote(`Authorization: Bearer ${await library.accessToken()}`)}\n`, ["--max-time", "30", url]);
    const text = new TextDecoder().decode(body);
    if (code !== 200) throw new Error(driveError(code, text));
    const value = serdeParse(text) as { files?: unknown; nextPageToken?: unknown } | null;
    if (Array.isArray(value?.files)) files.push(...(value.files as typeof files));
    if (typeof value?.nextPageToken === "string") page = value.nextPageToken;
    else break;
  }
  const found = files
    .filter((file) => typeof file.mimeType === "string" && file.mimeType.startsWith("image/"))
    .map(channelOf)
    .sort((a, b) => a.name.localeCompare(b.name));
  listed = { at: Date.now(), channels: found };
  return found;
}

/** The channel's picture on this Mac (`<cache>/watermarks/`), fetched from Drive when it's missing or changed. */
export async function logoFile(library: seams.Library, cacheDir: string, channel: Channel): Promise<string> {
  const dir = join(cacheDir, "watermarks");
  fs.mkdirSync(dir, { recursive: true });
  const path = join(dir, `${channel.id}-${channel.md5 ?? "x"}.png`);
  if (fs.existsSync(path) && fs.statSync(path).size > 0) return path;
  const partial = `${path}.part`;
  const url = `${API}/files/${encode(channel.id)}?alt=media&supportsAllDrives=true`;
  const [code, body] = await curl(`header = ${quote(`Authorization: Bearer ${await library.accessToken()}`)}\n`, ["--max-time", "60", "--output", partial, url]);
  if (code !== 200) {
    fs.rmSync(partial, { force: true });
    throw new Error(`couldn't fetch ${channel.name}'s watermark: ${driveError(code, new TextDecoder().decode(body))}`);
  }
  fs.renameSync(partial, path);
  return path;
}

/** A number in [0, 1) from `seed`, so each video starts the logo somewhere of its own, the same every time it's exported. */
function unit(seed: string, salt: number): number {
  let hash = 2166136261 ^ salt;
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
  return ((hash >>> 0) % 100_000) / 100_000;
}

/**
 * One axis of the bounce: from `from` towards `+1` or `-1` at `speed` px a
 * frame, turning at ±`reach`, over `frames` frames. Keyframes at the start,
 * at every wall and at the end, straight lines between: the path exactly.
 */
export function bounce(from: number, direction: 1 | -1, reach: number, speed: number, frames: number): Keyframe[] {
  const at = (frame: number, value: number): Keyframe => ({ frame, value, ease: "linear" });
  if (reach <= 0 || speed <= 0 || frames <= 0) return [at(0, 0)];
  const keys = [at(0, from)];
  let position = Math.max(-reach, Math.min(reach, from));
  let heading = direction;
  let frame = 0;
  for (;;) {
    const wall = heading * reach;
    const next = frame + Math.abs(wall - position) / speed;
    if (next >= frames) {
      keys.push(at(frames, position + heading * speed * (frames - frame)));
      return keys;
    }
    if (next > frame) keys.push(at(next, wall));
    position = wall;
    heading = heading === 1 ? -1 : 1;
    frame = next;
  }
}

/**
 * `project` with `logo` (a picture's media) bouncing across `plan`'s frames
 * at `LOOK`: a new top track, locked, with the one clip. Pure: the project
 * given is left as it was.
 */
export function withWatermark(project: Project, plan: Pick<Plan, "start" | "end">, logo: Media): Project {
  const frames = plan.end - plan.start;
  if (frames <= 0) return project;
  const { width: W, height: H } = project.settings;
  const fps = project.settings.fps * (project.settings.ntsc ? 1000 / 1001 : 1);
  const fit = Math.min(W / Math.max(logo.width, 1), H / Math.max(logo.height, 1));
  const scale = (LOOK.height * H) / Math.max(logo.height * fit, 1);
  const [w, h] = [logo.width * fit * scale, logo.height * fit * scale];
  const margin = LOOK.margin * H;
  const reach = [Math.max(0, W / 2 - margin - w / 2), Math.max(0, H / 2 - margin - h / 2)] as const;
  const speed = (LOOK.speed * H) / fps;
  const seed = project.id;
  const x = bounce((unit(seed, 1) * 2 - 1) * reach[0], unit(seed, 3) < 0.5 ? 1 : -1, reach[0], speed, frames);
  const y = bounce((unit(seed, 2) * 2 - 1) * reach[1], unit(seed, 4) < 0.5 ? 1 : -1, reach[1], speed, frames);
  const out = structuredClone(project);
  const ids = new Set([...out.tracks.map((one) => one.id), ...out.clips.map((one) => one.id), ...out.media.map((one) => one.id)]);
  const fresh = (base: string) => {
    let id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
    return id;
  };
  const media: Media = { ...logo, id: fresh(logo.id) };
  const track: Track = { id: fresh(TRACK), kind: "video", hidden: false, muted: false, locked: true };
  const clip: Clip = {
    id: fresh(TRACK),
    track: track.id,
    type: "video",
    name: `Watermark: ${logo.name}`,
    color: "purple",
    start: plan.start,
    duration: frames,
    fade_in: 0,
    fade_out: 0,
    media: media.id,
    source_in: 0,
    speed: 1,
    transform: { x: x[0]!.value, y: y[0]!.value, scale, rotation: 0 },
    opacity: LOOK.opacity,
    keyframes: { x, y },
  };
  out.media.push(media);
  out.tracks.push(track);
  out.clips.push(clip);
  return out;
}

/**
 * The export's timeline with channel `id`'s watermark on it: the picture
 * fetched, put in the cloud when Edit's cloud is on (so Modal can take the
 * export), and laid over `plan`.
 */
export async function addWatermark(app: Pick<App, "library">, cacheDir: string, project: Project, plan: Pick<Plan, "start" | "end">, id: string): Promise<Project> {
  let channel = (await channels(app.library)).find((one) => one.id === id);
  channel ??= (await channels(app.library, true)).find((one) => one.id === id);
  if (channel === undefined) throw new Error("that channel's watermark isn't in the Watermarks folder any more: pick it again");
  const path = await logoFile(app.library, cacheDir, channel);
  const probe = await native().probe(path);
  if (probe.kind !== "image") throw new Error(`${channel.name}'s watermark isn't a picture`);
  let made: seams.Made = { path, name: `${channel.code} watermark`, probe, cloud: null };
  if (cloud.enabled()) {
    try {
      made = await seams.cloudMedia.importLocal(cacheDir, path, probe, made.name);
    } catch (error) {
      // Exported here then: Modal refuses a timeline with a picture only on this Mac.
      diag.warn("watermark", `${channel.name}'s watermark couldn't go to the cloud: ${diag.messageOf(error)}`);
    }
  }
  const logo: Media = { id: `watermark-${channel.code.toLowerCase()}`, name: made.name, path: made.path, kind: "image", duration: probe.duration, width: probe.width, height: probe.height, fps: probe.fps, has_audio: false, ...(made.cloud === null ? {} : { cloud: made.cloud }) };
  diag.info("watermark", `${project.name}: ${channel.name}'s watermark at ${Math.round(LOOK.opacity * 100)}%`);
  return withWatermark(project, plan, logo);
}

export function routes(router: Router<App>): void {
  router.get("/api/watermarks", async ({ app }) => json({ channels: (await channels(app.library)).map(({ id, code, name }) => ({ id, code, name })) }));
}
