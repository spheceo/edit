// Linux's slow-motion smoothing (rife.ts): RIFE's frames land where they play.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { rife, smooth } from "../src/rife.ts";
import * as tools from "../src/tools.ts";

const home = fs.mkdtempSync(join(os.tmpdir(), "rife-"));
const gpu = process.platform === "linux" ? rife(home) : null;

test.skipIf(gpu === null)("a stretch slowed to a half at 30 fps comes out twice as long, every frame there, in H.264 at the picture's size", async () => {
  try {
    const source = join(home, "moving.mp4");
    // 25 fps of moving pattern, 3 s.
    await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=3", "-c:v", "libx264", "-preset", "ultrafast", source]);
    const out = join(home, "smoothed.mp4");
    await smooth(gpu!, source, 1, 1.2, 0.5, 30, 1920, 1080, out, join(home, "work"), 120_000);
    const probe = new TextDecoder().decode(
      await tools.run([tools.ffprobe(), "-v", "error", "-count_frames", "-show_entries", "stream=nb_read_frames,width,height,codec_name,r_frame_rate", "-of", "csv=p=0", out]),
    );
    // 1.2 s of source slowed to a half is 2.4 s, at 30 fps: 72 frames; kept at the source's size (it's smaller than the frame).
    expect(probe.trim()).toBe("h264,640,360,30/1,72");
    expect(fs.existsSync(join(home, "work"))).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
