// A review copy is shared only when it plays as its export (review_check.ts;
// Nov 1: four copies went up with each piece's last frame held to the
// export's end). The same rule as the worker's review_runtime.copy_problem.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import { asLengths, copyProblem, lengthsOf } from "../src/review_check.ts";
import * as tools from "../src/tools.ts";

test("a copy is refused unless its picture plays as the export's and its sound as its picture", () => {
  const exported = { video: 4948.77, frames: 148463, audio: 4948.77 };
  expect(copyProblem({ video: 4948.77, frames: 148463, audio: 4948.8 }, exported, 30)).toBeNull();
  // Kroger's: every frame there, each piece's last held to the export's end.
  expect(copyProblem({ video: 61860, frames: 148463, audio: 4948.77 }, exported, 30)).toContain("picture runs 61860.0 s");
  expect(copyProblem({ video: 4948.77, frames: 148000, audio: 4948.77 }, exported, 30)).toContain("frames");
  expect(copyProblem({ video: 4948.77, frames: 148463, audio: 1590 }, exported, 30)).toContain("sound runs");
  expect(copyProblem({ video: null, frames: null, audio: 10 }, exported, 30)).toBe("it has no picture");
  // An export longer than its edit (Off-Duty Officer) still passes: the copy stands for the export.
  const long = { video: 7344, frames: 220320, audio: 7344 };
  expect(copyProblem({ ...long }, long, 30)).toBeNull();
  // The cloud's measurements, as its JSON gives them.
  expect(asLengths({ video: "12.5", frames: 375, audio: null })).toEqual({ video: 12.5, frames: 375, audio: null });
  expect(asLengths(undefined)).toBeNull();
});

test("a copy joined with a piece's last frame held is caught from the file itself", async () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "review-check-"));
  try {
    const ffmpeg = (...args: string[]) => tools.run([tools.ffmpeg(), "-v", "error", "-nostdin", "-y", ...args]);
    const exported = nodePath.join(dir, "export.mp4");
    await ffmpeg("-f", "lavfi", "-i", "testsrc=size=160x120:rate=30", "-f", "lavfi", "-i", "sine=r=48000", "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", exported);
    for (const [name, at] of [["a", "0"], ["b", "1"]] as const) await ffmpeg("-ss", at, "-i", exported, "-frames:v", "30", "-an", "-c:v", "libx264", "-preset", "ultrafast", nodePath.join(dir, `${name}.mp4`));
    // As the concat demuxer did with a piece that said it ran to the export's end.
    fs.writeFileSync(nodePath.join(dir, "list.txt"), `ffconcat version 1.0\nfile 'a.mp4'\nduration 5\nfile 'b.mp4'\n`);
    const stretched = nodePath.join(dir, "stretched.mp4");
    await ffmpeg("-f", "concat", "-safe", "0", "-i", nodePath.join(dir, "list.txt"), "-i", exported, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", stretched);
    const [copy, whole] = [await lengthsOf(stretched), await lengthsOf(exported)];
    expect(whole.frames).toBe(60);
    expect(copyProblem(whole, whole, 30)).toBeNull();
    expect(copyProblem(copy, whole, 30)).toMatch(/picture runs (5|6)\.\d s, the export's 2\.0 s/);
    expect(await lengthsOf(nodePath.join(dir, "missing.mp4"))).toEqual({ video: null, frames: null, audio: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
