// The native addon (crates/edit-native, one napi-rs `.node`): the hot paths
// that stay in Rust. This file is the contract of docs/rewrite-plan.md §1.3
// as TS types, the loader, and a thin wrapper that keeps the conventions of
// §1.2 on this side:
// - a native failure is a thrown Error (or rejected promise) with the Rust
//   message text, which agents read, so it's passed on untouched except that
//   presigned URLs are scrubbed out (native errors can carry them, media.rs:968);
// - native log lines go to `diag` (native never writes edit.log itself).
//
// Until the real addon is built (WP0), and in tests, `stub.ts` stands in.

import * as fs from "node:fs";
import * as nodePath from "node:path";

import { nativeLog, scrub, warn } from "../diag.ts";

import type {
  Encoders,
  ExportOptions,
  Format,
  Keyframe,
  Media,
  Plan,
  Probe,
  Rippled,
  Sections,
} from "../model.ts";

// ---------------------------------------------------------------------------
// Boundary types

export type NativeLog =
  | { level: "info" | "warn" | "error"; area: string; message: string }
  | { timing: true; area: string; name: string; ms: number; failure?: string };

export interface InitConfig {
  home: string;
  cacheDir: string;
  ffmpeg: string;
  ffprobe: string;
  /** media_drive Layout.known: every media folder ever set (key_path names files there by their data-folder place). */
  mediaFolders: string[];
  log: (line: NativeLog) => void;
}

/**
 * A project for native work: by reference to a revision `projectCommit` has
 * seen (renders, censor checks, plans), or as JSON (exports, whose paths
 * `cloud_media.forExport` rewrites). A reference native no longer holds throws
 * `"stale project"`; send it again as JSON (`withProject` does).
 */
export type ProjectInput = { ref: { id: string; rev: number } } | { json: string };

/** A media file's cache files (media.rs CachePaths), all under `<cache>/<media key>/`. */
export interface CachePaths {
  /** Preview picture (video sources only, no sound). */
  proxy: string;
  /** Preview sound (sources with audio). */
  audio: string;
  /** Written once both preview files are complete. */
  proxyDone: string;
  thumbs: string;
  thumbsMeta: string;
  peaks: string;
  transcript: string;
  /** The light preview picture, made from the preview once it's done. */
  light: string;
}

export interface EncodedImage {
  data: Buffer;
  mime: "image/png" | "image/jpeg";
  width: number;
  height: number;
}

/** RGBA pixels, row by row. */
export interface RawImage {
  width: number;
  height: number;
  pixels: Buffer;
}

/** A face as shares of the picture: [x0, y0, x1, y1], its corners from the picture's top left (faces.rs). */
export type Box = [number, number, number, number];

export interface RenderRequest {
  project: ProjectInput;
  frames: number[];
  maxSide: number;
  /** Agent renders go ahead of the UI's. */
  priority: "ui" | "agent";
  /** PNG, or the agent's JPEG. */
  encode: "png" | "agent";
  /** Tile the frames into one contact sheet this many across. */
  sheetColumns?: number;
}

export interface MediaFramesRequest {
  media: Media;
  /** Seconds of the file. */
  start: number;
  end: number;
  count: number;
  maxSide: number;
  sheetColumns: number;
  encode: "agent";
}

export interface ExportStart {
  project: { json: string };
  options: ExportOptions;
  plan: Plan;
  output: string;
  cacheDir: string;
}

export interface TrackRequest {
  path: string;
  size: [number, number];
  fps: number;
  /** Source seconds. */
  from: number;
  to: number;
  anchors: { at: number; region: [number, number, number, number] }[];
}

export interface TrackResult {
  samples: { time: number; x: number; y: number }[];
  lost: [number, number][];
  cuts: number[];
}

export interface LoudnessSpan {
  integrated: number;
  loudest: number;
  peak: number;
}

/** A running export (render.rs): cancel it, or wait for its file. */
export interface ExportJob {
  cancel(): void;
  /** Rejects "cancelled" after cancel(). */
  wait(): Promise<{ seconds: number; bytes: number }>;
}

export interface ExportJobClass {
  start(job: ExportStart, onProgress: (progress: number) => void): ExportJob;
}

/** The addon's API (plan §1.3). S: sync, microseconds to a few ms; A: async; T: with progress; BG: fire and forget. */
export interface Native {
  // Lifecycle and process
  init(config: InitConfig): void; // S
  setMediaFolders(known: string[]): void; // S
  shutdown(): void; // S
  holdLock(path: string): boolean; // S: flock, held for the life of the process
  isLocked(path: string): boolean; // S
  reexec(exe: string, args: string[]): never; // S

  // Cache keys
  mediaKey(path: string): string; // S
  keyOf(name: string, file: string): string; // S
  mediaCache(path: string): string | null; // S
  lightPreview(source: string): string | null; // S

  // edit-core
  projectLoad(json: string): { json: string; problem?: string }; // S
  projectValidate(json: string): string | null; // S
  projectCommit(id: string, rev: number, json: string): { pretty: string; json: string }; // S
  removeTime(project: ProjectInput, start: number, end: number): { json: string; rippled: Rippled }; // S
  speedSpanHolding(
    project: ProjectInput,
    start: number,
    end: number,
    speed: number,
    hold: string[],
  ): { json: string; rippled: Rippled }; // S
  sections(project: ProjectInput): Sections; // S
  animatableParams(): Record<string, string[]>; // S
  sampleKeyframes(keys: Keyframe[], frames: number[]): (number | null)[]; // S

  // Probing and preview making
  probe(path: string): Promise<Probe>; // A
  imageSize(path: string): Promise<[number, number]>; // A
  makePreview(
    job: { source: string; probe: Probe; paths: CachePaths; fromCloudProxy: boolean },
    onProgress: (progress: number) => void,
  ): Promise<void>; // T
  makeLightPreview(source: string, paths: CachePaths, probe: Probe): Promise<void>; // A
  makeImageThumbs(source: string, paths: CachePaths): Promise<number>; // A
  makePeaks(source: string, out: string): Promise<void>; // A
  makeCloudProxy(source: string, probe: Probe, out: string): Promise<void>; // A
  cloudProxyBitrate(width: number, height: number): number; // S

  // Rendering and images
  renderFrames(request: RenderRequest): Promise<EncodedImage[]>; // A
  mediaFrames(request: MediaFramesRequest): Promise<{ image: EncodedImage; times: number[] }>; // A
  saveStill(media: Media, time: number, out: string): Promise<void>; // A
  composeSheet(images: RawImage[], columns: number, encode: "png" | "agent"): Promise<EncodedImage>; // A
  bundledFont(file: string): Buffer | null; // S
  readonly SHEET_CELL: number;

  // Export
  exportDefaults(): ExportOptions; // S
  exportPlan(project: ProjectInput, options: ExportOptions): { plan: Plan; fps: number }; // S
  withExtension(path: string, format: Format): string; // S
  encoders(): Promise<Encoders>; // A
  readonly ExportJob: ExportJobClass; // T

  // Sound measurement
  loudnessSpans(path: string, spans: { from: number; seconds: number }[]): Promise<LoudnessSpan[]>; // A
  loudestMoment(path: string): Promise<number>; // A
  loudnessPrepare(paths: string[]): Promise<void>; // A
  loudnessWarm(path: string): void; // BG

  // Analysis
  trackAnchors(request: TrackRequest): Promise<TrackResult>; // A
  facesDetect(source: string, size: [number, number], indexes: number[]): Promise<Record<number, Box[]>>; // A
  facesCached(source: string): Record<number, Box[]> | null; // S
  readonly FACES_RATE: number;
  censorIssues(project: ProjectInput, start: boolean): { issues: unknown[]; pending: string[] }; // S (+BG)
  /** Camera angles from 64×36 grey frames; TS does the FFmpeg read that makes them (seats.rs:195-232). */
  seatsScenes(gray64x36: Buffer): { scenes: [number, number, number | null][]; angles: number }; // S
  desktopFiles(width: number, height: number, photoTitle: string, notepadTitle: string): Promise<[string, string, string]>; // A
  /**
   * The laid-out size [width, height] of `text` in the bundled Geist at `px`
   * (left-aligned, still, 2 px pad), as the renderer lays it out: desktop.rs
   * `text_block` (edit_render::text::rasterize's block). WP7 needs it for the
   * desktop profile's notes; not in plan §1.3 (a contract addition).
   */
  textBlock(text: string, px: number, weight: number, lineHeight: number): [number, number]; // S
}

// ---------------------------------------------------------------------------
// Loading

/** What `projectCommit` caches miss with: the caller sends the project again as JSON. */
export const STALE = "stale project";

let current: Native | null = null;

/** The addon in use: the real one when it's found, else the stub. */
export function native(): Native {
  if (current === null) {
    const found = findAddon();
    if (found !== null) {
      current = wrap(load(found));
    } else {
      // Required lazily: the stub only exists for development and tests.
      const { createStub } = require("./stub.ts") as typeof import("./stub.ts");
      current = wrap(createStub());
      warn(
        "native",
        "the native addon wasn't found (EDIT_NATIVE, or crates/edit-native built with napi): running on the stub, which renders, exports and measures nothing",
      );
    }
  }
  return current;
}

/** Puts `impl` in place of the addon (tests, the stub). Returns what was there. */
export function useNative(impl: Native | null): Native | null {
  const before = current;
  current = impl;
  return before;
}

/** Whether the real addon is loaded (not the stub). */
export function isReal(): boolean {
  return current !== null && (current as { stub?: boolean }).stub !== true;
}

/**
 * Starts the addon: its log lines go to diag (scrubbed there), its caches
 * under `cacheDir`, its cache keys name media-drive files by `mediaFolders`.
 */
export function initNative(config: Omit<InitConfig, "log">): Native {
  const addon = native();
  addon.init({ ...config, log: nativeLog });
  return addon;
}

/** Where the addon is: `EDIT_NATIVE`, else beside the binary or in the dev tree. */
export function findAddon(): string | null {
  const given = process.env.EDIT_NATIVE;
  if (given !== undefined && given !== "") return fs.existsSync(given) ? given : null;
  // napi's `--platform` names: darwin-arm64, darwin-x64, linux-x64-gnu (WSL).
  const platform = `${process.platform}-${process.arch}`;
  const names = [`edit-native.${platform}.node`, `edit-native.${platform}-gnu.node`, "edit-native.node"];
  const dirs = [
    nodePath.dirname(process.execPath),
    // apps/server/src/native → crates/edit-native (dev: `napi build --platform`).
    nodePath.join(import.meta.dir, "../../../../crates/edit-native"),
  ];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = nodePath.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function load(path: string): Native {
  return require(path) as Native;
}

/**
 * The addon with §1.2's conventions applied on this side: every function's
 * error has presigned URLs scrubbed out (its text otherwise as native wrote it).
 */
export function wrap(raw: Native): Native {
  const scrubbed = (error: unknown): unknown => {
    if (error instanceof Error) {
      const message = scrub(error.message);
      if (message !== error.message) {
        const clean = new Error(message);
        clean.name = error.name;
        return clean;
      }
    }
    return error;
  };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw) as (keyof Native)[]) {
    const value = raw[key];
    if (typeof value !== "function" || key === "ExportJob") {
      out[key] = value;
      continue;
    }
    const fn = value as (...args: unknown[]) => unknown;
    out[key] = (...args: unknown[]) => {
      try {
        const result = fn.apply(raw, args);
        if (result instanceof Promise) {
          return result.catch((error: unknown) => {
            throw scrubbed(error);
          });
        }
        return result;
      } catch (error) {
        throw scrubbed(error);
      }
    };
  }
  return out as unknown as Native;
}

/**
 * Runs native work on a project by reference, re-sending it as JSON when the
 * addon no longer holds that revision (`"stale project"`).
 */
export function withProject<T>(
  id: string,
  rev: number,
  json: () => string,
  work: (project: ProjectInput) => T,
): T {
  try {
    return work({ ref: { id, rev } });
  } catch (error) {
    if (error instanceof Error && error.message === STALE) return work({ json: json() });
    throw error;
  }
}

/** `withProject` for async work. */
export async function withProjectAsync<T>(
  id: string,
  rev: number,
  json: () => string,
  work: (project: ProjectInput) => Promise<T>,
): Promise<T> {
  try {
    return await work({ ref: { id, rev } });
  } catch (error) {
    if (error instanceof Error && error.message === STALE) return work({ json: json() });
    throw error;
  }
}
