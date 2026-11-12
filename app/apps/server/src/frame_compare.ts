// Frames laid out for the agent's eyes with FFmpeg: a stretch of them in
// numbered sheets, a close-up of one region of each (`zoom`), and its own
// effect's frames paired with a reference's at the same moments (Sphe, Nov 12:
// "it's so important for the agents to be able to do side-by-side comparisons
// of its recreations"; "it's important for it to be able to zoom in and get a
// close-up"). A board's handwriting that shimmered, a box that jittered with
// its text, a feathered oval read as a cut-out: none show in one still, at a
// sheet's size, or apart from the reference.

import * as fs from "node:fs";

import labelFace from "../../../crates/edit-render/fonts/GeistMono-SemiBold.ttf" with { type: "file" };

import { writeAtomic } from "./files.ts";
import { join } from "./paths.ts";
import * as tools from "./tools.ts";

/** A region of the frame, in its own pixels. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The region from a tool's arguments (`zoom: {x, y, width, height}`), held inside a `width`×`height` frame; null when none is asked. */
export function regionOf(value: unknown, width: number, height: number): Region | null {
  if (value === undefined || value === null) return null;
  const given = value as Record<string, unknown>;
  const num = (key: string) => (typeof given[key] === "number" && Number.isFinite(given[key]) ? (given[key] as number) : null);
  const [x, y, w, h] = [num("x"), num("y"), num("width"), num("height")];
  if (x === null || y === null || w === null || h === null || w < 16 || h < 16) throw new Error("zoom is {x, y, width, height} in the frame's pixels, at least 16 by 16");
  const left = Math.max(0, Math.min(Math.round(x), width - 16));
  const top = Math.max(0, Math.min(Math.round(y), height - 16));
  return { x: left, y: top, width: Math.min(Math.round(w), width - left), height: Math.min(Math.round(h), height - top) };
}

/** Frames `count` of `path` from `start` (seconds), at `fps`, as full-size PNGs `<prefix>NNN.png` in `dir` (a reference's moments, matched to the project's frames). */
export async function framesOf(path: string, start: number, count: number, fps: number, width: number, height: number, dir: string, prefix: string): Promise<string[]> {
  await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-ss", String(Math.max(0, start)), "-i", path, "-an", "-vf", `fps=${fps},scale=${width}:${height}`, "-frames:v", String(count), join(dir, `${prefix}%03d.png`)], { timeoutMs: 5 * 60_000 });
  return fs.readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith(".png")).sort().map((name) => join(dir, name));
}

/** One cell of a sheet: its pictures side by side (a reference's, then yours), and what it's labelled. */
export interface Cell {
  files: string[];
  labels: string[];
}

/**
 * drawtext's `fontfile=…` for the labels, one of Edit's own faces: without one
 * FFmpeg asks the computer's fontconfig, which a static FFmpeg (a Mac's) may
 * not have. Written into `cacheDir` once, since the compiled binary's copy is
 * inside it where FFmpeg can't read; escaped for a filtergraph.
 */
export function labelFont(cacheDir: string): string {
  const file = join(cacheDir, "label-font", "GeistMono-SemiBold.ttf");
  const data = fs.readFileSync(labelFace);
  if (!fs.existsSync(file) || fs.statSync(file).size !== data.length) {
    fs.mkdirSync(join(cacheDir, "label-font"), { recursive: true });
    writeAtomic(file, data);
  }
  // Once for the option's value, once for the graph it's in.
  const value = file.replace(/[\\':]/gu, (one) => `\\${one}`);
  return `fontfile=${value.replace(/[\\'[\],;]/gu, (one) => `\\${one}`)}`;
}

const drawn = (text: string) => text.replace(/[\\':]/gu, (one) => `\\${one}`);

/**
 * Sheets of `cells`, `across` to a row and `rows` to a sheet, each picture
 * cropped to `zoom` (the whole frame without) and `size` px wide, labelled in
 * its corner in `font` (`labelFont`). Answers each sheet's JPEG bytes.
 */
export async function sheets(cells: Cell[], zoom: Region | null, size: number, across: number, rows: number, dir: string, font: string): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  const pieces: string[] = [];
  for (const [index, cell] of cells.entries()) {
    const piece = join(dir, `cell${String(index).padStart(3, "0")}.jpg`);
    const inputs = cell.files.flatMap((file) => ["-i", file]);
    const each = cell.files.map((_, n) => `[${n}]${zoom === null ? "" : `crop=${zoom.width}:${zoom.height}:${zoom.x}:${zoom.y},`}scale=${size}:-2,drawtext=${font}:text='${drawn(cell.labels[n] ?? "")}':x=6:y=6:fontsize=${Math.max(14, Math.round(size / 24))}:fontcolor=yellow:box=1:boxcolor=black@0.75[p${n}]`);
    const joined = cell.files.length > 1 ? `${each.join(";")};${cell.files.map((_, n) => `[p${n}]`).join("")}hstack=inputs=${cell.files.length}:shortest=1,pad=iw+6:ih:0:0:black` : each[0]!.replace(/\[p0\]$/u, "");
    await tools.run([tools.ffmpeg(), "-v", "error", "-y", ...inputs, "-filter_complex", joined, "-frames:v", "1", "-q:v", "3", piece]);
    pieces.push(piece);
  }
  const per = across * rows;
  for (let at = 0; at < pieces.length; at += per) {
    const part = pieces.slice(at, at + per);
    const list = join(dir, `sheet${at}.txt`);
    fs.writeFileSync(list, part.map((file) => `file '${file}'\nduration 1\n`).join(""));
    const sheet = join(dir, `sheet${at}.jpg`);
    await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-vf", `tile=${Math.min(across, part.length)}x${Math.ceil(part.length / across)}:padding=6:color=black`, "-frames:v", "1", "-q:v", "3", sheet]);
    out.push(new Uint8Array(fs.readFileSync(sheet)));
  }
  return out;
}
