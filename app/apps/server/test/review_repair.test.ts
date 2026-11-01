import { expect, test } from "bun:test";
import * as fs from "node:fs";

import { fixedMs, frameDelta, stretched, videoMs, videoTiming, type VideoTiming } from "../src/review_repair.ts";
import { scratch } from "./helpers/home.ts";

/** Kroger's review copy (Nov 1): 24 pieces of 6185 frames at 512/15360, each piece's last frame held to the export's end. */
function kroger(): VideoTiming {
  const runs: [number, number][] = [];
  const piece = 6185;
  const total = 148_463;
  for (let k = 0; k < 24; k++) {
    const frames = Math.min(piece, total - k * piece);
    const left = total - k * piece - frames;
    runs.push([frames - 1, 512]);
    // The last frame: its own 512, then the rest of the export after it.
    runs.push([1, 512 + left * 512]);
  }
  return { timescale: 15360, runs };
}

test("a stretched review copy is told from its index, and its moments are mapped to the copy made again", () => {
  const timing = kroger();
  expect(frameDelta(timing)).toBe(512);
  const edit = Math.round((148_463 / 30) * 1000);
  expect(stretched(timing, edit)).toBe(true);
  expect(videoMs(timing) / 3_600_000).toBeGreaterThan(17);
  expect(stretched({ timescale: 15360, runs: [[148_463, 512]] }, edit)).toBe(false);
  // Inside piece 0's own frames: the same moment.
  expect(fixedMs(timing, 43_000)).toBe(43_000);
  // Piece 1 starts in the broken file after piece 0's own 206.17 s and its 4742.6 s tail.
  const piece0 = (6185 * 512) / 15.36;
  const tail0 = ((148_463 - 6185) * 512) / 15.36;
  const piece1Start = piece0 + tail0;
  expect(fixedMs(timing, piece1Start + 10_000)).toBeCloseTo(piece0 + 10_000, -1);
  // Inside piece 0's tail: the end of piece 0.
  expect(Math.abs(fixedMs(timing, piece0 + 1_000_000) - piece0)).toBeLessThan(40);
});

test.skipIf(Bun.which("ffmpeg") === null)("the video track's timing is read from a real MP4's moov", () => {
  const { dir, cleanup } = scratch("review-repair");
  try {
    const file = `${dir}/clip.mp4`;
    expect(Bun.spawnSync(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=30", "-f", "lavfi", "-i", "sine", "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-movflags", "+faststart", file]).exitCode).toBe(0);
    const bytes = new Uint8Array(fs.readFileSync(file));
    // The moov comes after ftyp (faststart): find it as the repair script does.
    const view = new DataView(bytes.buffer);
    let at = 0;
    while (String.fromCharCode(...bytes.subarray(at + 4, at + 8)) !== "moov") at += view.getUint32(at);
    const timing = videoTiming(bytes.subarray(at, at + view.getUint32(at)))!;
    expect(timing.timescale).toBeGreaterThan(0);
    expect(Math.abs(videoMs(timing) - 2000)).toBeLessThan(50);
    expect(stretched(timing, 2000)).toBe(false);
  } finally {
    cleanup();
  }
});
