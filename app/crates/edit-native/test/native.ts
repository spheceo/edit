// The addon, initialised once for every test file (bun runs them in one
// process, and `init` only counts the first time).
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as Native from "../index";

export const native: typeof Native = require("../edit-native.node");

export const home = mkdtempSync(join(tmpdir(), "edit-native-test-"));
export const cache = join(home, "cache");
export const drive = join(home, "drive");
mkdirSync(cache, { recursive: true });
mkdirSync(drive, { recursive: true });

export const logs: Native.NativeLog[] = [];

native.init({
  home,
  cacheDir: cache,
  ffmpeg: process.env.EDIT_FFMPEG || "ffmpeg",
  ffprobe: process.env.EDIT_FFPROBE || "ffprobe",
  mediaFolders: [drive],
  log: (line) => {
    logs.push(line);
  },
});

/** A 320×180 project at 30 fps: a red solid for its first `frames` frames. */
export function solidProject(id = "p-solid", frames = 60) {
  return {
    version: 1,
    id,
    name: "solid",
    settings: { width: 320, height: 180, fps: 30 },
    media: [],
    tracks: [{ id: "v1", kind: "video" }],
    clips: [
      { id: "red", track: "v1", type: "solid", fill: [1, 0, 0, 1], start: 0, duration: frames },
    ],
  };
}

/** Runs `ffmpeg` with `args`; true if it worked. */
export function ffmpeg(args: string[]): boolean {
  const run = Bun.spawnSync([process.env.EDIT_FFMPEG || "ffmpeg", "-v", "error", "-y", ...args]);
  return run.exitCode === 0;
}

/** Whether this machine can render (a GPU wgpu can use). */
export async function hasGpu(): Promise<boolean> {
  if (process.env.EDIT_NO_GPU) return false;
  try {
    await native.renderFrames({
      project: { json: JSON.stringify(solidProject("p-gpu-probe", 1)) },
      frames: [0],
      maxSide: 16,
      priority: "ui",
      encode: "png",
    });
    return true;
  } catch (error) {
    console.warn(`no GPU render here (${(error as Error).message}); skipping GPU tests`);
    return false;
  }
}
