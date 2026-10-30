import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join as joinPath } from "node:path";

import { ffmpeg } from "../../src/tools.ts";
import { append, join, overview, peaks, streams } from "../../src/writer/media.ts";

function make(args: string[], out: string) {
  const done = Bun.spawnSync([ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", ...args, out]);
  if (done.exitCode !== 0) throw new Error(done.stderr.toString());
}

test("joins mixed recordings, appends by copying, and reads the sound's peaks", async () => {
  const dir = fs.mkdtempSync(joinPath(os.tmpdir(), "writer-join-"));
  try {
    const [a, b, c] = [joinPath(dir, "a.mp4"), joinPath(dir, "b.mp3"), joinPath(dir, "c.mov")];
    make(["-f", "lavfi", "-i", "testsrc=s=640x360:d=3", "-f", "lavfi", "-i", "sine=d=3", "-shortest"], a);
    make(["-f", "lavfi", "-i", "sine=f=330:d=2"], b);
    make(["-f", "lavfi", "-i", "testsrc=s=1280x720:d=2"], c);
    const parts = await Promise.all([a, b, c].map(async (path) => ({ path, streams: await streams(path) })));
    const out = joinPath(dir, "joined.mp4");
    await join(parts, out);
    const found = await streams(out);
    expect(found.video && found.audio).toBe(true);
    expect(found.durationMs).toBeGreaterThanOrEqual(6_900);
    expect(found.durationMs).toBeLessThanOrEqual(7_200);
    // A second piece encoded the same way is copied on.
    const more = joinPath(dir, "more.mp4");
    await join([parts[2]!], more);
    const longer = joinPath(dir, "longer.mp4");
    await append(more, [more], longer);
    expect((await streams(longer)).durationMs).toBeGreaterThanOrEqual(3_800);
    const sound = await peaks(out);
    expect(sound.length).toBeGreaterThan(300);
    expect(Math.max(...sound.slice(0, 100))).toBeGreaterThan(0.05);
    expect(overview(sound, 10)).toHaveLength(10);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

// Oct 30, 591): Axon bodycam recordings are full range (yuvj420p); their
// pieces kept that flag, never matched the rest, and the join encoded all 10
// hours again with libx264. Every piece is TV range now, so they copy.
test("a full-range recording's piece matches the others and joins by copying", async () => {
  const dir = fs.mkdtempSync(joinPath(os.tmpdir(), "writer-range-"));
  try {
    const [full, normal] = [joinPath(dir, "full.mp4"), joinPath(dir, "normal.mp4")];
    make(["-f", "lavfi", "-i", "testsrc=s=1280x720:d=2", "-f", "lavfi", "-i", "sine=d=2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuvj420p", "-color_range", "pc"], full);
    make(["-f", "lavfi", "-i", "testsrc=s=1280x720:d=2", "-f", "lavfi", "-i", "sine=d=2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p"], normal);
    const pieces = [joinPath(dir, "a.mp4"), joinPath(dir, "b.mp4")];
    for (const [index, source] of [full, normal].entries()) await join([{ path: source, streams: await streams(source) }], pieces[index]!);
    const formats = pieces.map((piece) => Bun.spawnSync(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0", piece]).stdout.toString().trim());
    expect(formats).toEqual(["yuv420p", "yuv420p"]);
    const joined = joinPath(dir, "joined.mp4");
    expect(await append(pieces[0]!, [pieces[1]!], joined)).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
