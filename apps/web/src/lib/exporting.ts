// The export dialog's model: options (as apps/server/src/exports.ts reads
// them), presets, chapters from the script, and what an export will make.

import type { Project, Sections } from "./types";

export type Format = "h264" | "hevc" | "prores" | "gif" | "wav" | "mp3" | "png";
export type Shape = "original" | "vertical" | "square" | "portrait";
export type Fill = "blur" | "crop" | "black";
export type Quality = "high" | "balanced" | "small";

export interface Chapter {
  /** Frame on the timeline. */
  start: number;
  title: string;
}

export interface ExportOptions {
  format: Format;
  /** Frames `[start, end)`; the whole edit when absent. */
  range?: [number, number];
  shape: Shape;
  fill: Fill;
  /** Short side in px; the project's when null. */
  size: number | null;
  /** Output frame rate; the project's when null. */
  fps: number | null;
  quality: Quality;
  /** Aim for about this many MB instead of a quality (MP4 only). */
  target_mb: number | null;
  hardware: boolean;
  audio: boolean;
  /** Integrated loudness to normalise to (LUFS), or null to leave the mix alone. */
  loudness: number | null;
  chapters: Chapter[];
}

/** Which formats and encoders this machine's FFmpeg has (GET /api/export/encoders). */
export interface Encoders {
  videotoolbox: boolean;
  hevc: boolean;
  prores: boolean;
  mp3: boolean;
}

export const FORMATS: { value: Format; label: string; extension: string }[] = [
  { value: "h264", label: "MP4 · H.264", extension: "mp4" },
  { value: "hevc", label: "MP4 · HEVC (smaller)", extension: "mp4" },
  { value: "prores", label: "MOV · ProRes 422 HQ", extension: "mov" },
  { value: "gif", label: "GIF", extension: "gif" },
  { value: "mp3", label: "MP3 (sound only)", extension: "mp3" },
  { value: "wav", label: "WAV (sound only)", extension: "wav" },
  { value: "png", label: "PNG (one frame)", extension: "png" },
];

export const hasVideo = (format: Format) => format !== "wav" && format !== "mp3";
export const hasAudio = (format: Format) => format !== "gif" && format !== "png";
export const hasChapters = (format: Format) => format === "h264" || format === "hevc" || format === "prores";
export const isMp4 = (format: Format) => format === "h264" || format === "hevc";
export const extensionOf = (format: Format) => FORMATS.find((entry) => entry.value === format)!.extension;

export type SpanChoice = "inout" | "whole" | "intro";

/** What an export is unless you change it: YouTube at 1080p. */
export const DEFAULTS: Omit<ExportOptions, "range" | "chapters"> = {
  format: "h264",
  shape: "original",
  fill: "blur",
  size: 1080,
  fps: null,
  quality: "high",
  target_mb: null,
  hardware: true,
  audio: true,
  loudness: -14,
};

export const LOUDNESS: { value: number; label: string }[] = [
  { value: -14, label: "−14 LUFS · YouTube, Spotify" },
  { value: -16, label: "−16 LUFS · Apple, podcasts" },
  { value: -23, label: "−23 LUFS · broadcast" },
];

/** Rounds down to even, at least 2 (as export.rs). */
const even = (value: number) => Math.max(2, Math.round(value) & ~1);

/** The output's size: the shape's aspect at the short side (mirrors export::output_size). */
export function outputSize(options: Pick<ExportOptions, "shape" | "size" | "format">, width: number, height: number): [number, number] {
  const [aw, ah] =
    options.shape === "vertical" ? [9, 16] : options.shape === "square" ? [1, 1] : options.shape === "portrait" ? [4, 5] : [width, height];
  const short = Math.max(2, options.size ?? (options.format === "gif" ? 480 : Math.min(width, height)));
  return aw >= ah ? [even((short * aw) / ah), even(short)] : [even(short), even((short * ah) / aw)];
}

/** A cut-in's words cut down to a chapter title. */
function chapterTitle(text: string) {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const head = words.slice(0, 7).join(" ").replace(/[\s,;:.–—-]+$/, "");
  return words.length > 7 ? `${head}…` : head;
}

/**
 * Chapters from the script: the intro, then a chapter at each cut-in of the
 * story named by its words, then the outro.
 */
export function scriptChapters(project: Project, sections: Sections | null): Chapter[] {
  if (!sections?.parts.length) return [];
  const words = new Map<number, string>();
  for (const block of project.script?.blocks ?? []) {
    if (block.kind !== "narration" || !block.clip) continue;
    const clip = project.clips.find((candidate) => candidate.id === block.clip);
    if (clip) words.set(clip.start, block.text);
  }
  const chapters: Chapter[] = [];
  if (sections.intro) chapters.push({ start: 0, title: "Intro" });
  for (const part of sections.parts) {
    const inStory = !sections.intro || part.start >= sections.intro[1];
    if (part.kind === "broll" && inStory) chapters.push({ start: part.start, title: chapterTitle(words.get(part.start) ?? "Story") });
    if (part.kind === "outro") chapters.push({ start: part.start, title: "Outro" });
  }
  return chapters;
}

/** YouTube's rule: chapters at least this far apart (seconds). */
const LEAST_CHAPTER = 10;

/**
 * The chapters that fall in `span`, the first moved to its start and none
 * closer than 10 s to the one before (YouTube ignores lists that break that).
 * Starts stay timeline frames.
 */
export function chaptersInSpan(chapters: Chapter[], span: [number, number], fps: number): Chapter[] {
  const [start, end] = span;
  // Too-close chapters merge into the one before them, the same for every span.
  const merged = spaced(chapters, fps);
  // The one already running at the span's start opens it.
  const opening = merged.filter((chapter) => chapter.start <= start).at(-1);
  const list = [...(opening ? [{ ...opening, start }] : []), ...merged.filter((chapter) => chapter.start > start && chapter.start < end)];
  return spaced(list, fps).filter((chapter, index) => index === 0 || (end - chapter.start) / fps >= LEAST_CHAPTER);
}

/** Drops chapters starting less than 10 s after the one kept before them. */
function spaced(chapters: Chapter[], fps: number) {
  const kept: Chapter[] = [];
  for (const chapter of [...chapters].sort((a, b) => a.start - b.start)) {
    const last = kept.at(-1);
    if (!last || (chapter.start - last.start) / fps >= LEAST_CHAPTER) kept.push(chapter);
  }
  return kept;
}

const clock = (seconds: number) => {
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};

/** Chapters as a YouTube description list ("0:00 Intro"), timed from the span's start. */
export function youtubeChapters(chapters: Chapter[], span: [number, number], fps: number) {
  return chapters.map((chapter, index) => `${clock(index === 0 ? 0 : (chapter.start - span[0]) / fps)} ${chapter.title}`).join("\n");
}

/**
 * Roughly how big the file will be, where that's knowable: a set bitrate
 * (target size, hardware encoding), ProRes or sound. Quality-based H.264/HEVC
 * size depends on the footage, so it's left out rather than guessed.
 */
export function estimateBytes(options: Omit<ExportOptions, "range" | "chapters">, width: number, height: number, seconds: number, fps: number): number | null {
  const audioRate = !options.audio || !hasAudio(options.format) ? 0 : options.format === "mp3" ? { high: 320, balanced: 224, small: 160 }[options.quality] * 1000 : { high: 256, balanced: 192, small: 128 }[options.quality] * 1000;
  const bitsPerPixel = { high: 0.14, balanced: 0.08, small: 0.045 }[options.quality];
  let videoRate: number | null = 0;
  if (isMp4(options.format)) {
    if (options.target_mb) return options.target_mb * 1_000_000;
    videoRate = options.hardware ? width * height * fps * bitsPerPixel * (options.format === "hevc" ? 0.6 : 1) : null;
  } else if (options.format === "prores") videoRate = width * height * fps * 2.6;
  else if (options.format === "wav") return seconds * 48_000 * 2 * 2;
  else if (options.format === "gif" || options.format === "png") videoRate = null;
  if (videoRate === null) return null;
  return ((videoRate + (options.format === "prores" && options.audio ? 1_536_000 : audioRate)) * seconds) / 8;
}

export function formatBytes(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
