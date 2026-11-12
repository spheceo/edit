// Smooth playback by chunk (off Modal, step 4f; Sphe, Nov 2): the viewer
// plays the render a chunk at a time as each lands, instead of waiting for the
// whole file, and an edit swaps only the chunks it changed.
//
// The render is a chunked export (crates/edit-engine/src/chunks.rs) into the
// project's own chunk folder (`export-chunks/<project>_playback/`): it writes
// the chunks it will make as it starts (`plan-v1.json`), makes the one at the
// viewer's playhead first (`Plan.focus`), then the rest on from there, then
// those before, each to `<key>.mp4` as it's done, and once joined remembers
// where each sits in the file (`manifest-v1.json`). Here, `GET
// /api/projects/{id}/playback/stream` says which chunks there are and which
// are ready, `…/playback/segment/{key}` gives one as a fragmented MP4 the
// page's MediaSource takes (picture only, remuxed from its chunk file or the
// joined file as it's asked for: a key is what's in it, so it never
// changes), and `…/playback/sound` the render's sound (the mix the export
// made first, then the joined file's), which the page plays beside the
// picture.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { ApiError, json, notFound } from "./http/errors.ts";
import { serveFile } from "./http/files.ts";
import type { Router } from "./http/router.ts";
import { isFile, join } from "./paths.ts";
import * as tools from "./tools.ts";

/** One chunk of the render: frames `[start, end)` of the edit, and whether it can be played. */
export interface Segment {
  start: number;
  end: number;
  key: string;
  ready: boolean;
}

export interface Stream {
  /** The render's chunks, in timeline order. */
  segments: Segment[];
  /** The MediaSource type of the picture (`avc1.640028`), once a chunk is there to read it from. */
  codec: string | null;
  /** The sound: there to play, still being mixed, or none (nothing heard). */
  sound: "ready" | "pending" | "none";
  /** Where it plays from now (`soundUrl`), when it's ready. */
  soundUrl: string | null;
}

interface Planned {
  extension: string;
  chunks: { start: number; end: number; key: string }[];
}

interface Manifest {
  output: string;
  size: number;
  fps: number;
  chunks: { key: string; at: number; frames: number }[];
  sound: string | null;
}

/** The render's chunk folder: the engine's `chunks::folder` for `<project>.playback`. */
export function chunkDir(app: App, id: string): string {
  return join(app.store.cacheDir(), "export-chunks", `${id}.playback`.replace(/[^A-Za-z0-9_-]/g, "_"));
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** The render kept from before the one at `output` (keepPrevious), beside it, played until the viewer moves on. */
export function previousOf(output: string): string {
  return output.replace(/\.mp4$/u, ".previous.mp4");
}

/** The kept render's manifest, beside its file: the chunk folder is the engine's, and its tidy keeps nothing of a render before. */
function previousManifest(previous: string): string {
  return previous.replace(/\.mp4$/u, ".manifest.json");
}

/** The last joined render's manifest (`manifest-v1.json` in `dir`), or the one at `path`, when its file is still as it was written. */
function manifestOf(dir: string, path = join(dir, "manifest-v1.json")): Manifest | null {
  const manifest = readJson<Manifest>(path);
  if (manifest === null) return null;
  try {
    return fs.statSync(manifest.output).size === manifest.size ? manifest : null;
  } catch {
    return null;
  }
}

/** A finished render's chunks, by its manifest. */
function plannedBy(manifest: Manifest): Planned {
  return { extension: "mp4", chunks: manifest.chunks.map((one) => ({ start: one.at, end: one.at + one.frames, key: one.key })) };
}

/** Where chunk `key`'s picture is: its own file, or a stretch of the joined render. */
function sourceOf(dir: string, planned: Planned, manifest: Manifest | null, key: string): { path: string; at: number; frames: number } | null {
  const chunk = planned.chunks.find((one) => one.key === key);
  if (chunk === undefined) return null;
  const own = join(dir, `${key}.${planned.extension}`);
  if (isFile(own)) return { path: own, at: 0, frames: chunk.end - chunk.start };
  const saved = manifest?.chunks.find((one) => one.key === key);
  if (manifest === null || saved === undefined) return null;
  return { path: manifest.output, at: saved.at, frames: saved.frames };
}

const codecs = new Map<string, string>();

/** A picture's MediaSource codec (`avc1.<profile><constraints><level>`), read from the file. */
async function codecOf(path: string): Promise<string | null> {
  const known = codecs.get(path);
  if (known !== undefined) return known;
  try {
    const text = new TextDecoder().decode(await tools.run([tools.ffprobe(), "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,profile,level", "-of", "json", path], { timeoutMs: 30_000 }));
    const stream = (JSON.parse(text) as { streams?: { codec_name?: string; profile?: string; level?: number }[] }).streams?.[0];
    if (stream?.codec_name !== "h264" || typeof stream.level !== "number") return null;
    const [profile, constraints] = ({ Baseline: [0x42, 0x00], "Constrained Baseline": [0x42, 0x40], Main: [0x4d, 0x00], High: [0x64, 0x00] } as Record<string, [number, number]>)[stream.profile ?? ""] ?? [0x64, 0x00];
    const hex = (value: number) => value.toString(16).padStart(2, "0");
    const codec = `avc1.${hex(profile)}${hex(constraints)}${hex(stream.level)}`;
    codecs.set(path, codec);
    return codec;
  } catch {
    return null;
  }
}

/** The render's sound file now: the joined render's once it's there, else the mix beside the render being made. */
function soundOf(id: string, output: string, manifest: Manifest | null): string | null {
  if (manifest !== null && manifest.sound !== null && isFile(manifest.output)) return manifest.output;
  const folder = output.slice(0, output.lastIndexOf("/"));
  const stem = output.slice(output.lastIndexOf("/") + 1);
  let names: string[] = [];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return null;
  }
  // The export's partial file is `<output>.<pid>-<project>.partial.mp4` (this server's pid: the engine runs in it),
  // its mix beside it with `.sound.m4a`; one another process left is never this render's.
  const mix = names.find((name) => name === `${stem}.${process.pid}-${id}.playback.partial.mp4.sound.m4a`);
  return mix === undefined ? null : join(folder, mix);
}

/**
 * What the render of one revision has to play now: a render under way
 * (`since`: when it started) by the plan it wrote then, a finished one by its
 * manifest. A plan older than the render is another render's (the one before,
 * or one stopped part-way), and its chunks are never served as this one's
 * (JJ, Nov 2: "on the screen, it still shows the paper thing").
 */
export async function stream(app: App, id: string, output: string, heard: boolean, since: number | null, previous = false): Promise<Stream> {
  const dir = chunkDir(app, id);
  const manifest = previous ? manifestOf(dir, previousManifest(output)) : manifestOf(dir);
  let planned: Planned | null = null;
  if (since !== null) {
    try {
      if (fs.statSync(join(dir, "plan-v1.json")).mtimeMs >= since) planned = readJson<Planned>(join(dir, "plan-v1.json"));
    } catch {
      // Not written yet.
    }
  } else if (manifest !== null) {
    planned = plannedBy(manifest);
  }
  if (planned === null) return { segments: [], codec: null, sound: heard ? "pending" : "none", soundUrl: null };
  const segments = planned.chunks.map((chunk) => ({ ...chunk, ready: sourceOf(dir, planned, manifest, chunk.key) !== null }));
  const first = segments.find((one) => one.ready);
  const source = first === undefined ? null : sourceOf(dir, planned, manifest, first.key);
  const codec = source === null ? null : await codecOf(source.path);
  // The kept render's sound is in its joined file, when it has any.
  const url = !heard ? null : previous ? addressOf(id, manifest?.sound != null ? manifest.output : null) : soundUrl(app, id, output);
  return { segments, codec, sound: !heard ? "none" : url !== null ? "ready" : "pending", soundUrl: url };
}

/**
 * Chunk `key` as a fragmented MP4 (picture only, its time 0 the chunk's first
 * frame), remuxed as it's asked for (a chunk's copy, ~0.1 s): nothing more is
 * kept on disk than the render's own chunks.
 */
export function segment(app: App, id: string, key: string, fps: number, output: string): Response {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new ApiError(400, "not a chunk");
  const dir = chunkDir(app, id);
  const manifest = manifestOf(dir);
  // The render under way's plan, else the finished one's manifest (a render from before plans were written has only that),
  // else the previous render's, still played by a viewer that hasn't moved to the new one.
  const previous = manifestOf(dir, previousManifest(previousOf(output)));
  const plans: [Planned | null, Manifest | null][] = [[readJson<Planned>(join(dir, "plan-v1.json")), manifest], [manifest === null ? null : plannedBy(manifest), manifest], [previous === null ? null : plannedBy(previous), previous]];
  const source = plans.map(([planned, from]) => (planned === null ? null : sourceOf(dir, planned, from, key))).find((one) => one !== null) ?? null;
  if (source === null) throw notFound("that chunk isn't made yet");
  // A stretch of the joined file starts on its chunk's keyframe: half a frame in keeps the seek on it.
  const seek = source.at > 0 ? ["-ss", ((source.at + 0.5) / fps).toFixed(6)] : [];
  const child = Bun.spawn([tools.ffmpeg(), "-v", "error", "-nostdin", ...seek, "-i", source.path, "-frames:v", String(source.frames), "-map", "0:v:0", "-c", "copy",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  void child.exited.then((code) => {
    if (code !== 0) diag.warn("playback", `${id}: chunk ${key} for the viewer: FFmpeg ended with ${code}`);
  });
  return new Response(child.stdout, { headers: { "content-type": "video/mp4", "cache-control": "private, max-age=31536000, immutable" } });
}

/** The sound's address now, versioned by the file it reads (the mix, then the joined render): a new one is a new address. */
export function soundUrl(app: App, id: string, output: string): string | null {
  return addressOf(id, soundOf(id, output, manifestOf(chunkDir(app, id))));
}

/** A sound file's version: its size and when it was written (a hard link keeps both). */
function versionOf(path: string): string | null {
  try {
    const stat = fs.statSync(path);
    return `${stat.size}-${Math.floor(stat.mtimeMs)}`;
  } catch {
    return null;
  }
}

function addressOf(id: string, path: string | null): string | null {
  const version = path === null ? null : versionOf(path);
  return version === null ? null : `/api/projects/${encodeURIComponent(id)}/playback/sound?v=${version}`;
}

/** The sound file to serve for version `asked`: the kept render's when that's the one it names (a viewer still on it), else the render's now. */
export function soundPath(app: App, id: string, output: string, asked: string | null): string | null {
  const before = manifestOf(chunkDir(app, id), previousManifest(previousOf(output)));
  if (asked !== null && before !== null && before.sound !== null && versionOf(before.output) === asked) return before.output;
  return soundOf(id, output, manifestOf(chunkDir(app, id)));
}

/**
 * Keeps the render about to be replaced playable until the viewer moves to
 * the new one (Sphe, Nov 12: watching on while the agent works, its changes
 * swapped in ahead of the playhead): its joined file is hard-linked to
 * `previous` (no copy: the new render's rename leaves it the old file) and its
 * manifest kept beside it pointing there. One render back is all that's kept.
 */
export function keepPrevious(app: App, id: string, output: string, previous: string): boolean {
  const manifest = manifestOf(chunkDir(app, id));
  fs.rmSync(previous, { force: true });
  fs.rmSync(previousManifest(previous), { force: true });
  if (manifest === null || manifest.output !== output) return false;
  try {
    fs.linkSync(output, previous);
  } catch {
    return false;
  }
  fs.writeFileSync(previousManifest(previous), JSON.stringify({ ...manifest, output: previous }));
  return true;
}

/** What playback_render.ts knows of a project's render of revision `rev`: its file, whether it's heard, its rate, and when it started if it's under way; null when there's none of that revision here. */
export type Lookup = (app: App, id: string, rev: number) => { output: string; heard: boolean; fps: number; since: number | null; previous?: boolean } | null;

export function routes(router: Router<App>, lookup: Lookup, fpsOf: (app: App, id: string) => number, output: (app: App, id: string) => string): void {
  router
    .get("/api/projects/{id}/playback/stream", async ({ app, params, url }) => {
      const id = params.id ?? "";
      const found = lookup(app, id, Number(url.searchParams.get("rev")));
      if (found === null) return json({ segments: [], codec: null, sound: "pending", soundUrl: null } satisfies Stream);
      return json(await stream(app, id, found.output, found.heard, found.since, found.previous === true));
    })
    .get("/api/projects/{id}/playback/segment/{key}", ({ app, params }) => segment(app, params.id ?? "", params.key ?? "", fpsOf(app, params.id ?? ""), output(app, params.id ?? "")))
    .get("/api/projects/{id}/playback/sound", ({ app, params, request, url }) => {
      const id = params.id ?? "";
      const path = soundPath(app, id, output(app, id), url.searchParams.get("v"));
      if (path === null) throw notFound("the sound isn't mixed yet");
      const response = serveFile(request, path);
      // Each file is its own address (`soundUrl`'s `v`).
      response.headers.set("cache-control", "private, max-age=86400");
      return response;
    });
}
