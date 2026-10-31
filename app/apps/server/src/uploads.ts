// What people drop into a project, whatever it is (Sphe, Oct 31: "we should
// ENSURE dragging and dropping works for all file types … then we should be
// able to tell the agent add the new images i've uploaded"). Video, sound and
// pictures Edit reads are imported as they are; other pictures (HEIC, AVIF,
// PSD, RAW…) become PNGs, other video and sound (WMV, FLV, MPG, WMA, AMR…) MP4
// or M4A, so each lands in its media folder; anything else (a PDF, a Doc, a
// text file) is kept as one of the project's files. Each upload is remembered
// (`uploads.json` in the project's media folder) so the agent's context can
// say what the person added and whether it's on the timeline yet.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { writeAtomic } from "./files.ts";
import * as media from "./media.ts";
import { registerTool, text } from "./mcp/registry.ts";
import { extension, fileName, fileStem, join } from "./paths.ts";
import { ffmpeg, ffprobe } from "./tools.ts";

/** Pictures macOS's `sips` reads that Edit doesn't: made PNGs. */
export const PICTURES = ["heic", "heif", "avif", "psd", "ico", "icns", "jp2", "tga", "exr", "dng", "cr2", "cr3", "nef", "arw", "orf", "rw2", "raf", "srw", "pef"];
/** Text a file's words are read from as they are. */
const PLAIN = ["txt", "md", "markdown", "csv", "tsv", "json", "srt", "vtt", "xml", "yaml", "yml", "log"];
/** Documents macOS's `textutil` reads. */
const DOCUMENTS = ["doc", "docx", "rtf", "rtfd", "odt", "html", "htm", "webarchive", "wordml"];

export interface Uploaded {
  /** When it landed (ms). */
  at: number;
  /** The name it was dropped with. */
  name: string;
  /** The media it became, or null for a file kept as it is. */
  media: string | null;
  /** A file kept as it is: where it is. */
  file: string | null;
  /** Converted from this extension (a HEIC made PNG). */
  from?: string;
}

const listOf = (dir: string) => join(dir, "uploads.json");

export function list(dir: string): Uploaded[] {
  try {
    const kept = JSON.parse(fs.readFileSync(listOf(dir), "utf8")) as unknown;
    return Array.isArray(kept) ? (kept as Uploaded[]) : [];
  } catch {
    return [];
  }
}

export function remember(dir: string, entry: Uploaded): void {
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(listOf(dir), JSON.stringify([...list(dir), entry].slice(-500), null, 1));
}

/** How a dropped file goes in: as media (`path`, converted when `from` is set), or kept as a file. */
export type Plan = { media: string; from?: string } | { file: true };

async function run(command: string[]): Promise<{ code: number; out: string }> {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out: code === 0 ? out : err.trim().split("\n").slice(-3).join(" ") };
}

/** Which streams a file has, as FFmpeg reads it (none when it can't). */
async function streams(path: string): Promise<{ video: boolean; audio: boolean; frames: number }> {
  const said = await run([ffprobe(), "-v", "error", "-show_entries", "stream=codec_type,nb_frames,codec_name", "-of", "json", path]);
  if (said.code !== 0) return { video: false, audio: false, frames: 0 };
  try {
    const found = (JSON.parse(said.out) as { streams?: { codec_type?: string; nb_frames?: string; codec_name?: string }[] }).streams ?? [];
    const video = found.find((one) => one.codec_type === "video");
    return { video: video !== undefined, audio: found.some((one) => one.codec_type === "audio"), frames: Number(video?.nb_frames ?? 0) || 0 };
  } catch {
    return { video: false, audio: false, frames: 0 };
  }
}

/**
 * How `path` goes into the project: Edit's own media as it is; another picture
 * as a PNG, another video or sound as MP4 or M4A, made beside it in `dir`; else
 * kept as a file.
 */
export async function plan(path: string, dir: string): Promise<Plan> {
  const ext = (extension(path) ?? "").toLowerCase();
  if (media.isMediaPath(path) || media.isImagePath(path)) return { media: path };
  const stem = fileStem(path) ?? "upload";
  fs.mkdirSync(dir, { recursive: true });
  const free = (wanted: string) => {
    let made = join(dir, wanted);
    for (let n = 2; fs.existsSync(made); n++) made = join(dir, wanted.replace(/(\.[^.]+)$/, ` ${n}$1`));
    return made;
  };
  if (PICTURES.includes(ext) && process.platform === "darwin") {
    const out = free(`${stem}.png`);
    const made = await run(["/usr/bin/sips", "-s", "format", "png", path, "--out", out]);
    if (made.code === 0 && fs.existsSync(out)) return { media: out, from: ext };
    diag.warn("upload", `${fileName(path)}: not made a picture (${made.out}); kept as a file`);
    return { file: true };
  }
  // A text or document never goes through FFmpeg (it reads some text as pictures).
  if (PLAIN.includes(ext) || DOCUMENTS.includes(ext) || ext === "pdf") return { file: true };
  const found = await streams(path);
  if (found.video && found.frames !== 1) {
    const out = free(`${stem}.mp4`);
    const made = await run([ffmpeg(), "-v", "error", "-y", "-i", path, "-map", "0:v:0", ...(found.audio ? ["-map", "0:a:0", "-c:a", "aac", "-b:a", "256k"] : []),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-movflags", "+faststart", out]);
    if (made.code === 0) return { media: out, from: ext };
    fs.rmSync(out, { force: true });
    diag.warn("upload", `${fileName(path)}: not made a video (${made.out}); kept as a file`);
    return { file: true };
  }
  if (found.video) {
    const out = free(`${stem}.png`);
    const made = await run([ffmpeg(), "-v", "error", "-y", "-i", path, "-frames:v", "1", out]);
    if (made.code === 0) return { media: out, from: ext };
    fs.rmSync(out, { force: true });
  }
  if (found.audio) {
    const out = free(`${stem}.m4a`);
    const made = await run([ffmpeg(), "-v", "error", "-y", "-i", path, "-vn", "-c:a", "aac", "-b:a", "256k", out]);
    if (made.code === 0) return { media: out, from: ext };
    fs.rmSync(out, { force: true });
    diag.warn("upload", `${fileName(path)}: not made a sound (${made.out}); kept as a file`);
  }
  return { file: true };
}

/** A kept file's words, for the agent: plain text as it is, documents through textutil. */
export async function words(path: string): Promise<string> {
  const ext = (extension(path) ?? "").toLowerCase();
  if (PLAIN.includes(ext)) return fs.readFileSync(path, "utf8");
  if (DOCUMENTS.includes(ext) && process.platform === "darwin") {
    const made = await run(["/usr/bin/textutil", "-convert", "txt", "-stdout", path]);
    if (made.code === 0) return made.out;
    throw new Error(`${fileName(path)} couldn't be read: ${made.out}`);
  }
  if (ext === "pdf" && process.platform === "darwin") {
    // Spotlight's own reading of the PDF, when it has one.
    const made = await run(["/usr/bin/mdls", "-raw", "-name", "kMDItemTextContent", path]);
    if (made.code === 0 && made.out.trim() !== "" && made.out.trim() !== "(null)") return made.out;
    throw new Error(`${fileName(path)}'s text isn't readable here (a scanned PDF, or not indexed yet): ask the user what's in it`);
  }
  throw new Error(`${fileName(path)} is a ${ext || "binary"} file: its words can't be read`);
}

/** How long ago, in words. */
function ago(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/**
 * What the person uploaded, newest first, for the agent's context: each media
 * with whether it's on the timeline, each file with read_upload to read it.
 */
export function forContext(app: App, project: { id: string; media: { id: string; name: string; kind: string }[]; clips: unknown[] }, now = Date.now()): string[] {
  let dir: string;
  try {
    dir = app.store.uploadsDir(project.id);
  } catch {
    return [];
  }
  const used = new Set(project.clips.map((clip) => (clip as { media?: unknown }).media).filter((id): id is string => typeof id === "string"));
  const rows: string[] = [];
  for (const entry of list(dir).slice().reverse().slice(0, 30)) {
    if (entry.media !== null) {
      const own = project.media.find((one) => one.id === entry.media);
      if (own === undefined) continue;
      rows.push(`${own.id} ${own.kind} "${entry.name}"${entry.from ? ` (made ${extension(own.name) ?? "media"} from ${entry.from})` : ""} ${used.has(own.id) ? "on the timeline" : "NOT ON THE TIMELINE YET"}, ${ago(entry.at, now)}`);
    } else if (entry.file !== null && fs.existsSync(entry.file)) {
      rows.push(`file "${entry.name}" (read_upload name "${entry.name}"), ${ago(entry.at, now)}`);
    }
  }
  return rows;
}

registerTool("read_upload", ({ app, args, projectId }) => {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const dir = app.store.uploadsDir(projectId);
  const files = list(dir).filter((entry) => entry.file !== null && fs.existsSync(entry.file));
  if (name === "") {
    if (files.length === 0) return text("the user hasn't uploaded any files other than media to this project");
    return text(files.map((entry) => `"${entry.name}" (${Math.round(fs.statSync(entry.file!).size / 1024)} KB)`).join("\n"));
  }
  const found = files.reverse().find((entry) => entry.name === name) ?? files.find((entry) => entry.name.toLowerCase().includes(name.toLowerCase()));
  if (found === undefined) throw new Error(`no uploaded file "${name}" (read_upload with no name lists them)`);
  return words(found.file!).then((said) => text(said.length > 60_000 ? `${said.slice(0, 60_000)}\n… (cut at 60,000 characters of ${said.length})` : said));
});
