// script.ts's excerpts: a sound-only file (a police call) cuts as footage does.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

import { join } from "../src/paths.ts";
import { cut } from "../src/script.ts";

const ffmpeg = Bun.which("ffmpeg");

test.skipIf(ffmpeg === null)("a sound-only file's excerpt is cut", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "edit-excerpt-"));
  try {
    const call = join(dir, "call.m4a");
    const made = Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=f=400:d=20", "-c:a", "aac", call]);
    expect(made.exitCode).toBe(0);
    const out = join(dir, "excerpt.m4a");
    await cut(call, 5, 12, out);
    expect(fs.statSync(out).size).toBeGreaterThan(1000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
