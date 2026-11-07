// Slow motion smoothed on Linux: RIFE (v4.6, through rife-ncnn-vulkan on the
// GPU) makes the frames between the real ones, where a Mac uses VideoToolbox's
// frame-rate conversion (broll.ts). Nov 7, an RTX 4060: 2 s of 1080p slowed to
// a quarter in 4.8 s, against FFmpeg's minterpolate in 36.6 s, and moving
// subjects keep their shape where minterpolate breaks them into blocks.
//
// A release carries the program and its model inside `edit` (embed.ts
// --rife) and writes them to `<home>/bin/rife` when first used; a dev run
// reads app/rife (scripts/rife.sh). Only where Vulkan has a real GPU: on
// Vulkan's software device it would take minutes a shot, so FFmpeg's stays.

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import { embedded } from "./embedded.ts";
import { isFile, join, parent } from "./paths.ts";
import * as tools from "./tools.ts";

export interface Rife {
  program: string;
  /** The model's folder (flownet.param, flownet.bin). */
  model: string;
}

/** Writes `from` to `to` unless it's there already with the same bytes. */
function keep(from: string, to: string, mode: number): void {
  const bytes = new Uint8Array(fs.readFileSync(from));
  try {
    if (Buffer.from(fs.readFileSync(to)).equals(Buffer.from(bytes))) return;
  } catch {
    // Not there yet.
  }
  fs.mkdirSync(parent(to) ?? ".", { recursive: true });
  const next = `${to}.${process.pid}.next`;
  fs.writeFileSync(next, bytes, { mode });
  fs.chmodSync(next, mode);
  fs.renameSync(next, to);
}

/** RIFE's files: written out of the binary (a release) or app/rife (a dev run); null off Linux or without them. */
function files(home: string): Rife | null {
  if (process.platform !== "linux") return null;
  const inside = embedded()?.rife ?? null;
  if (inside !== null) {
    const dir = join(home, "bin", "rife");
    const model = join(dir, "rife-v4.6");
    keep(inside.program, join(dir, "rife-ncnn-vulkan"), 0o755);
    keep(inside.param, join(model, "flownet.param"), 0o644);
    keep(inside.bin, join(model, "flownet.bin"), 0o644);
    return { program: join(dir, "rife-ncnn-vulkan"), model };
  }
  const repo = join(import.meta.dir, "../../../rife");
  const program = join(repo, "rife-ncnn-vulkan");
  return isFile(program) && isFile(join(repo, "rife-v4.6", "flownet.bin")) ? { program, model: join(repo, "rife-v4.6") } : null;
}

let found: Rife | null | undefined;

/**
 * RIFE when it can smooth here: on Linux, its files there, and Vulkan's
 * first device a GPU (rife-ncnn-vulkan takes device 0; a machine with none
 * lists only the software one, llvmpipe or SwiftShader). Looked at once.
 */
export function rife(home: string): Rife | null {
  if (found !== undefined) return found;
  found = null;
  try {
    const have = files(home);
    if (have === null) return null;
    // Two tiny frames: what devices it sees, and that it runs at all.
    const dir = fs.mkdtempSync(join(home, ".rife-check-"));
    try {
      fs.mkdirSync(join(dir, "in"));
      fs.mkdirSync(join(dir, "out"));
      for (const name of ["1", "2"]) {
        Bun.spawnSync([tools.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", "color=gray:s=64x64", "-frames:v", "1", join(dir, "in", `${name}.png`)], { stdout: "ignore", stderr: "ignore" });
      }
      const ran = Bun.spawnSync([have.program, "-i", join(dir, "in"), "-o", join(dir, "out"), "-m", have.model, "-n", "3"], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
      const said = `${ran.stdout.toString()}${ran.stderr.toString()}`;
      const first = /^\[0 ([^\]]+)\]/mu.exec(said)?.[1] ?? "";
      if (ran.exitCode !== 0 || first === "") {
        diag.warn("broll", `RIFE didn't run here (${said.trim().split("\n").pop() ?? `exit ${ran.exitCode}`}); smoothing stays FFmpeg's`);
      } else if (/llvmpipe|swiftshader|software/iu.test(first)) {
        diag.info("broll", `RIFE would run on Vulkan's software device (${first}); smoothing stays FFmpeg's`);
      } else {
        diag.info("broll", `smoothing slow motion with RIFE on ${first}`);
        found = have;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (error) {
    diag.warn("broll", `looking for RIFE: ${diag.messageOf(error)}`);
  }
  return found;
}

/** FFmpeg's `-framerate` for `fps`: NTSC rates as their exact fraction. */
function rate(fps: number): string {
  const ntsc = Math.round(fps * 1001);
  return Math.abs(fps - Math.round(fps)) > 1e-6 && Math.abs(ntsc / 1001 - fps) < 1e-6 ? `${ntsc}/1001` : String(Math.round(fps));
}

/** The stretch's frame rate and colour matrix, as FFmpeg reads them (the matrix by size when untagged). */
async function probe(input: string): Promise<{ fps: number; matrix: string }> {
  const text = new TextDecoder().decode(
    await tools.run([tools.ffprobe(), "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate,r_frame_rate,color_space,height", "-of", "json", input], { timeoutMs: 30_000 }),
  );
  const stream = (JSON.parse(text) as { streams?: { avg_frame_rate?: string; r_frame_rate?: string; color_space?: string; height?: number }[] }).streams?.[0] ?? {};
  const fraction = (value: string | undefined) => {
    const [top, bottom] = (value ?? "").split("/").map(Number);
    return top !== undefined && bottom !== undefined && bottom > 0 && top > 0 ? top / bottom : null;
  };
  const fps = fraction(stream.avg_frame_rate) ?? fraction(stream.r_frame_rate) ?? 30;
  const tagged = stream.color_space ?? "";
  const matrix = ["bt709", "bt470bg", "smpte170m", "bt2020nc"].includes(tagged) ? tagged : (stream.height ?? 0) >= 720 ? "bt709" : "smpte170m";
  return { fps, matrix };
}

/**
 * `length` seconds of `input` from `start`, slowed to `speed` and played at
 * `fps`, with RIFE's frames between the real ones, fitted within
 * `width`×`height`, into `out` (H.264: NVENC at VideoToolbox's rate where the
 * card has it, else libx264 at CRF 15, as FFmpeg's smoothing). The frames go
 * through `work` as PNGs (lossless) and are removed after. RIFE spaces its
 * frames evenly over the real ones' span, so the count asked is the real
 * frames times the slowing: each made frame lands exactly where it plays.
 */
export async function smooth(rife: Rife, input: string, start: number, length: number, speed: number, fps: number, width: number, height: number, out: string, work: string, limitMs: number): Promise<void> {
  const { fps: sourceFps, matrix } = await probe(input);
  const frames = join(work, "in");
  const made = join(work, "out");
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(frames, { recursive: true });
  fs.mkdirSync(made, { recursive: true });
  const began = performance.now();
  const left = () => Math.max(limitMs - (performance.now() - began), 5_000);
  try {
    await tools.run([
      tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-ss", start.toFixed(4), "-t", length.toFixed(4), "-i", input, "-an",
      "-vf", `scale=w='min(${width},iw)':h='min(${height},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:in_color_matrix=${matrix},format=rgb24`,
      "-fps_mode", "passthrough", join(frames, "%08d.png"),
    ], { timeoutMs: left() });
    const real = fs.readdirSync(frames).filter((name) => name.endsWith(".png")).length;
    if (real < 2) throw new Error(`the stretch had ${real} frame(s)`);
    const wanted = Math.max(real, Math.round((real * fps) / (sourceFps * speed)));
    await tools.run([rife.program, "-i", frames, "-o", made, "-m", rife.model, "-n", String(wanted), "-j", "4:2:4", "-f", "%08d.png"], { timeoutMs: left() });
    const count = fs.readdirSync(made).filter((name) => name.endsWith(".png")).length;
    if (count !== wanted) throw new Error(`RIFE made ${count} frames, not ${wanted}`);
    const bitrate = Math.max(4_000_000, Math.round((20_000_000 * width * height) / (1920 * 1080) * (fps / 30)));
    const hardware = tools.hardwareH264();
    const encode = hardware !== null ? [...hardware, "-b:v", String(bitrate), "-maxrate", String(Math.round(bitrate * 1.5)), "-bufsize", String(bitrate * 2)] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "15"];
    await tools.run([
      tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-framerate", rate(fps), "-i", join(made, "%08d.png"),
      "-vf", `scale=out_color_matrix=${matrix}:out_range=tv,format=yuv420p`, "-colorspace", matrix, "-color_range", "tv",
      ...encode, "-movflags", "+faststart", out,
    ], { timeoutMs: left() });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
