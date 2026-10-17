// STUB: an in-memory stand-in for the native addon, with the contract's exact
// signatures (index.ts), for tests and for running the TS server before WP0's
// addon lands. It is not the engine:
// - projectLoad / projectValidate / projectCommit check only the structure
//   and the commonest rules of Project::validate (same messages), and don't
//   fill serde defaults or round f32 fields; `pretty` is JSON.stringify's.
// - mediaKey / keyOf are a stable hash of the same inputs, NOT edit-engine's
//   SipHash: keys made here never match the real cache.
// - probe and imageSize ask ffprobe (when there is one); preview making writes
//   placeholder files; rendering, export, loudness and analysis say they
//   aren't in the stub.
// Never ship it: `isReal()` says which one is loaded.

import * as fs from "node:fs";

import { ANIMATABLE, type ClipType, type ExportOptions, type Format, type Probe, type Project } from "../model.ts";
import { extension, join, stripPrefix, withExtension as replaceExtension } from "../paths.ts";
import { clipEnd, clipMedia, sample, trackLabel } from "../project.ts";
import {
  STALE,
  type CachePaths,
  type ExportJob,
  type ExportStart,
  type InitConfig,
  type Native,
  type ProjectInput,
} from "./index.ts";

const SAFE = 9_007_199_254_740_991;

function notInStub(what: string): never {
  throw new Error(`${what} isn't in the native stub (build crates/edit-native)`);
}

/** The structure serde insists on before Project::validate runs ("it can't be read"). */
function shapeProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "expected a project object";
  const project = value as Record<string, unknown>;
  for (const field of ["version", "id", "name", "settings"]) {
    if (!(field in project)) return `missing field \`${field}\``;
  }
  if (typeof project.version !== "number") return "invalid type: `version` must be a number";
  if (typeof project.id !== "string" || typeof project.name !== "string") return "invalid type: id and name must be strings";
  const settings = project.settings as Record<string, unknown> | null;
  if (typeof settings !== "object" || settings === null) return "invalid type: `settings` must be an object";
  for (const field of ["width", "height", "fps"]) {
    if (typeof settings[field] !== "number" || !Number.isInteger(settings[field]) || (settings[field] as number) < 0) {
      return `invalid value: settings.${field} must be an unsigned integer`;
    }
  }
  for (const field of ["media", "tracks", "clips", "segments", "markers"]) {
    if (field in project && !Array.isArray(project[field])) return `invalid type: \`${field}\` must be a sequence`;
  }
  for (const clip of (project.clips as unknown[] | undefined) ?? []) {
    const c = clip as Record<string, unknown>;
    if (typeof c !== "object" || c === null) return "invalid type: a clip must be an object";
    if (typeof c.id !== "string" || typeof c.track !== "string") return "invalid type: clip id and track must be strings";
    if (!Number.isInteger(c.start) || !Number.isInteger(c.duration)) return `invalid type: clip ${String(c.id)} frames must be integers`;
    if (!["video", "audio", "text", "adjustment", "solid", "waveform"].includes(c.type as string)) {
      return `unknown variant \`${String(c.type)}\` for clip ${String(c.id)}`;
    }
  }
  return null;
}

/** Fills the defaults the stub's own checks rely on (serde's #[serde(default)]). */
function withDefaults(value: Record<string, unknown>): Project {
  const project = value as unknown as Project;
  project.style ??= "bodycam";
  project.media ??= [];
  project.tracks ??= [];
  project.clips ??= [];
  project.next_id ??= 0;
  return project;
}

/** The commonest of Project::validate's rules, with its messages. */
export function stubValidate(project: Project): string | null {
  const segments = project.segments ?? [];
  if (
    segments.some((segment) => segment.start < 0 || segment.end <= segment.start) ||
    segments.some((segment, index) => index > 0 && segment.start < segments[index - 1]!.end)
  ) {
    return "segments must be sorted, from frame 0, non-empty and never overlap";
  }
  if ((project.markers ?? []).some((marker) => marker.frame < 0)) return "timeline markers must be frames from 0";
  const markIn = project.mark_in ?? null;
  const markOut = project.mark_out ?? null;
  if ((markIn !== null && markIn < 0) || (markOut !== null && markOut < 0)) {
    return "mark_in and mark_out must be frames from 0";
  }
  if (markIn !== null && markOut !== null && markIn > markOut) return "mark_in must not come after mark_out";
  if (project.drive && !project.drive.url.startsWith("https://drive.google.com/")) {
    return "drive.url must be a https://drive.google.com/ link";
  }
  if (project.next_id > SAFE) return "next_id must fit in a JavaScript safe integer";
  const { width, height, fps } = project.settings;
  if (width === 0 || height === 0 || fps === 0) return "settings width, height and fps must be positive";
  if (width > 8192 || height > 8192) return "settings width and height must be at most 8192";
  const tracks = new Set<string>();
  for (const track of project.tracks) {
    if (track.id === "" || tracks.has(track.id)) return `empty or duplicate track id ${track.id}`;
    tracks.add(track.id);
  }
  const subtitles = project.tracks.filter((track) => track.subtitles === true);
  if (subtitles.length > 1 || subtitles.some((track) => track.kind !== "video")) {
    return "there can be one subtitles track, a video track";
  }
  const media = new Set<string>();
  for (const item of project.media) {
    if (item.id === "" || media.has(item.id)) return `empty or duplicate media id ${item.id}`;
    media.add(item.id);
    if (!Number.isFinite(item.duration) || item.duration < 0 || !Number.isFinite(item.fps ?? 0) || (item.fps ?? 0) < 0) {
      return `media ${item.id} has invalid duration or fps`;
    }
  }
  const ids = new Set<string>();
  for (const clip of project.clips) {
    if (clip.id === "" || ids.has(clip.id)) return `duplicate clip id ${clip.id}`;
    ids.add(clip.id);
    const track = project.tracks.find((other) => other.id === clip.track);
    if (track === undefined) return `clip ${clip.id} is on unknown track ${clip.track}`;
    if (clip.duration <= 0) return `clip ${clip.id} must have a positive duration`;
    if (clip.start < 0) return `clip ${clip.id} starts before frame 0`;
    if (clip.start + clip.duration > SAFE) return `clip ${clip.id} exceeds the timeline's integer range`;
    if ((clip.fade_in ?? 0) < 0 || (clip.fade_out ?? 0) < 0) return `clip ${clip.id} fades must be nonnegative`;
    if ((clip.type === "audio") !== (track.kind === "audio")) return `clip ${clip.id} is on a ${track.kind} track`;
    const used = clipMedia(clip);
    if (used !== null && !media.has(used)) return `clip ${clip.id} references unknown media ${used}`;
  }
  const ordered = [...project.clips].sort((a, b) =>
    a.track < b.track ? -1 : a.track > b.track ? 1 : a.start - b.start,
  );
  for (let index = 0; index + 1 < ordered.length; index++) {
    const clip = ordered[index]!;
    const other = ordered[index + 1]!;
    if (clip.track === other.track && other.start < clipEnd(clip)) {
      return `clips ${clip.id} and ${other.id} overlap on track ${trackLabel(project, clip.track) ?? ""}`;
    }
  }
  return null;
}

/** A 16-hex-digit FNV-1a hash (stable across runs; not the engine's SipHash). */
function hash(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

function run(command: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    return { ok: result.exitCode === 0, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  } catch (error) {
    return { ok: false, stdout: "", stderr: String(error) };
  }
}

const IMAGES = ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff"];

interface Stub extends Native {
  readonly stub: true;
}

export function createStub(): Stub {
  let config: Omit<InitConfig, "log"> & { log?: InitConfig["log"] } = {
    home: "",
    cacheDir: "",
    ffmpeg: "ffmpeg",
    ffprobe: "ffprobe",
    mediaFolders: [],
  };
  const locks = new Set<string>();
  // (id, rev) → project JSON, the last two revs of at most 16 projects, as the engine keeps them.
  const projects = new Map<string, Map<number, string>>();

  const resolve = (input: ProjectInput): Project => {
    if ("json" in input) return JSON.parse(input.json) as Project;
    const json = projects.get(input.ref.id)?.get(input.ref.rev);
    if (json === undefined) throw new Error(STALE);
    return JSON.parse(json) as Project;
  };

  const keyPath = (path: string): string => {
    for (const dir of config.mediaFolders) {
      const rest = stripPrefix(path, dir);
      if (rest !== null && config.home !== "") return join(config.home, rest);
    }
    return path;
  };

  const keyOf = (name: string, file: string): string => {
    let size = "none";
    let modified = "none";
    try {
      const stat = fs.statSync(file);
      size = String(stat.size);
      modified = String(Math.floor(stat.mtimeMs));
    } catch {
      // A missing file still has a key (as in media.rs: its metadata is None).
    }
    return hash(`${name}\u0000${size}\u0000${modified}`);
  };

  const mediaKey = (path: string) => keyOf(keyPath(path), path);

  const probe = async (path: string): Promise<Probe> => {
    const ext = extension(path)?.toLowerCase() ?? "";
    const result = run([
      config.ffprobe,
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      path,
    ]);
    if (!result.ok) {
      if (result.stderr.includes("ENOENT") || result.stderr.includes("No such file or directory: '")) {
        throw new Error(`ffprobe is not available (${result.stderr.trim()}); install FFmpeg`);
      }
      throw new Error(`could not read ${path}: ${result.stderr.trim()}`);
    }
    const info = JSON.parse(result.stdout) as {
      streams?: Record<string, unknown>[];
      format?: { duration?: string };
    };
    const streams = info.streams ?? [];
    const video = streams.find(
      (stream) =>
        stream.codec_type === "video" &&
        ((stream.disposition as Record<string, number> | undefined)?.attached_pic ?? 0) === 0,
    );
    const hasAudio = streams.some((stream) => stream.codec_type === "audio");
    if (IMAGES.includes(ext) && video !== undefined) {
      return { kind: "image", duration: 30, width: Number(video.width ?? 0), height: Number(video.height ?? 0), fps: 0, has_audio: false };
    }
    const duration = Number.parseFloat(info.format?.duration ?? String(video?.duration ?? "0")) || 0;
    if (video !== undefined) {
      if (duration <= 0) throw new Error(`${path} looks like a still image; images are not supported yet`);
      const [num, den] = String(video.avg_frame_rate ?? "30/1").split("/").map(Number);
      const rate = num !== undefined && den !== undefined && num > 0 && den > 0 ? num / den : 30;
      return {
        kind: "video",
        duration,
        width: Number(video.width ?? 0),
        height: Number(video.height ?? 0),
        fps: rate,
        has_audio: hasAudio,
      };
    }
    if (hasAudio && duration > 0) return { kind: "audio", duration, width: 0, height: 0, fps: 0, has_audio: true };
    throw new Error(`${path} has no playable video or audio`);
  };

  const placeholder = (path: string, bytes: string | Uint8Array) => {
    fs.mkdirSync(path.slice(0, path.lastIndexOf("/")) || ".", { recursive: true });
    fs.writeFileSync(path, bytes);
  };

  const defaults = (): ExportOptions => ({
    format: "h264",
    range: null,
    shape: "original",
    fill: "blur",
    size: null,
    fps: null,
    quality: "high",
    target_mb: null,
    hardware: process.platform === "darwin",
    wait_for_smoothing: false,
    audio: true,
    loudness: null,
    chapters: [],
  });

  const stub: Stub = {
    stub: true,
    init(given) {
      config = { ...given };
    },
    setMediaFolders(known) {
      config.mediaFolders = [...known];
    },
    shutdown() {},
    holdLock(path) {
      // As the addon: held already by this process is held.
      if (locks.has(path)) return true;
      fs.closeSync(fs.openSync(path, "a"));
      locks.add(path);
      return true;
    },
    isLocked(path) {
      return locks.has(path);
    },
    reexec() {
      notInStub("reexec");
    },

    mediaKey,
    keyOf,
    mediaCache(path) {
      return config.cacheDir === "" ? null : join(config.cacheDir, mediaKey(path));
    },
    lightPreview(source) {
      if (config.cacheDir === "") return null;
      const path = join(config.cacheDir, mediaKey(source), "preview-light.mp4");
      return fs.existsSync(path) ? path : null;
    },

    projectLoad(json) {
      let value: unknown;
      try {
        value = JSON.parse(json);
      } catch (error) {
        return { json, problem: `it can't be read: ${(error as Error).message}` };
      }
      const shape = shapeProblem(value);
      if (shape !== null) return { json, problem: `it can't be read: ${shape}` };
      const project = withDefaults(value as Record<string, unknown>);
      const invalid = stubValidate(project);
      const out = JSON.stringify(project);
      return invalid === null ? { json: out } : { json: out, problem: `it doesn't validate: ${invalid}` };
    },
    projectValidate(json) {
      const value = JSON.parse(json) as unknown;
      const shape = shapeProblem(value);
      return shape ?? stubValidate(withDefaults(value as Record<string, unknown>));
    },
    projectCommit(id, rev, json) {
      const value = JSON.parse(json) as unknown;
      const shape = shapeProblem(value);
      if (shape !== null) throw new Error(shape);
      const project = withDefaults(value as Record<string, unknown>);
      const invalid = stubValidate(project);
      if (invalid !== null) throw new Error(invalid);
      const compact = JSON.stringify(project);
      let revs = projects.get(id);
      if (revs === undefined) {
        if (projects.size >= 16) projects.delete(projects.keys().next().value!);
        revs = new Map();
        projects.set(id, revs);
      }
      revs.set(rev, compact);
      for (const kept of revs.keys()) if (kept < rev - 1) revs.delete(kept);
      return { pretty: JSON.stringify(project, null, 2), json: compact };
    },
    removeTime() {
      notInStub("removeTime");
    },
    speedSpanHolding() {
      notInStub("speedSpanHolding");
    },
    sections(input) {
      const project = resolve(input);
      if (project.script === undefined || project.script === null) {
        return { intro: null, intro_splits: 1, outro: null, parts: [] };
      }
      notInStub("sections of a scripted project");
    },
    animatableParams() {
      return Object.fromEntries(Object.entries(ANIMATABLE).map(([type, params]) => [type as ClipType, [...params]]));
    },
    sampleKeyframes(keys, frames) {
      return frames.map((frame) => sample(keys, frame));
    },

    probe,
    async imageSize(path) {
      const found = await probe(path);
      return [found.width, found.height];
    },
    async makePreview(job, onProgress) {
      onProgress(0.5);
      if (job.probe.kind === "video") placeholder(job.paths.proxy, "stub preview");
      if (job.probe.has_audio) placeholder(job.paths.audio, "stub preview sound");
      placeholder(job.paths.proxyDone, "");
      onProgress(1);
    },
    async makeLightPreview(_source, paths) {
      placeholder(paths.light, "stub light preview");
    },
    async makeImageThumbs(_source, paths: CachePaths) {
      placeholder(paths.thumbs, "stub thumbnail");
      placeholder(paths.thumbsMeta, '{"count":1,"interval":30}');
      return 1;
    },
    async makePeaks(_source, out) {
      placeholder(out, new Uint8Array([0, 64, 128, 255]));
    },
    async makeCloudProxy() {
      notInStub("makeCloudProxy");
    },
    smoothSupported() {
      return false;
    },
    async smoothSlowMotion() {
      notInStub("smoothSlowMotion");
    },
    cloudProxyBitrate(width, height) {
      // media.rs cloud_proxy_bitrate: 4 Mbit/s at 1080p, down to 0.8.
      const rate = Math.floor((4_000_000 * width * height) / (1920 * 1080));
      return Math.min(Math.max(rate, 800_000), 4_000_000);
    },

    async renderFrames() {
      notInStub("renderFrames");
    },
    async mediaFrames() {
      notInStub("mediaFrames");
    },
    async saveStill() {
      notInStub("saveStill");
    },
    async composeSheet() {
      notInStub("composeSheet");
    },
    bundledFont() {
      return null;
    },
    SHEET_CELL: 360,

    exportDefaults: defaults,
    exportPlan() {
      notInStub("exportPlan");
    },
    withExtension(path: string, format: Format) {
      const wanted = { h264: "mp4", hevc: "mp4", prores: "mov", gif: "gif", wav: "wav", mp3: "mp3", png: "png" }[format];
      const ext = extension(path);
      const media = ["mp4", "m4v", "mov", "gif", "wav", "mp3", "png", "m4a"];
      if (ext !== null && ext.toLowerCase() === wanted) return path;
      if (ext !== null && media.includes(ext.toLowerCase())) return replaceExtension(path, wanted);
      return `${path}.${wanted}`;
    },
    async encoders() {
      return { videotoolbox: false, hevc: false, prores: false, mp3: false };
    },
    ExportJob: {
      start(_job: ExportStart): ExportJob {
        notInStub("ExportJob");
      },
    },

    async loudnessSpans() {
      notInStub("loudnessSpans");
    },
    async loudestMoment() {
      notInStub("loudestMoment");
    },
    async loudnessPrepare() {},
    loudnessWarm() {},

    async trackAnchors() {
      notInStub("trackAnchors");
    },
    async facesDetect() {
      notInStub("facesDetect");
    },
    facesCached() {
      return null;
    },
    FACES_RATE: 2.0,
    censorIssues() {
      return { issues: [], pending: [] };
    },
    async seatsScenes() {
      notInStub("seatsScenes");
    },
    async desktopFiles() {
      notInStub("desktopFiles");
    },
    textBlock(text, px, _weight, lineHeight) {
      // No font metrics here: a character-count estimate (Geist's average
      // advance is about half its size), lines × px × line height tall.
      const lines = text.split("\n");
      const widest = Math.max(...lines.map((line) => [...line].length));
      return [widest * px * 0.5 + 4, lines.length * px * lineHeight + 4];
    },
  };
  return stub;
}
