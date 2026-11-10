// A long recording's preview piece is made in stretches, each kept once
// whole, so a restart (an update) redoes one stretch, not the piece (JJ's
// Mac, Nov 10: a 1 h 43 min interview's piece thrown away twice). These
// encode real clips with FFmpeg: a run cut part-way carries on from its whole
// stretches, and the joined piece plays as one encode of it would, picture
// and sound, with no seam where the stretches meet.

import { afterAll, beforeAll, expect, test } from "bun:test";

import * as fs from "node:fs";
import * as os from "node:os";

import { Effect, Fiber } from "effect";

import { runtime } from "../../src/effect/runtime.ts";
import * as tools from "../../src/tools.ts";
import * as media from "../../src/writer/media.ts";

const ffmpeg = Bun.which("ffmpeg");
/** 3.2 s stretches (on the 0.32 s grid) of a 20 s clip: seven, the last 0.8 s. */
const STRETCH = 3_200;

let root: string;
let source: string;
let part: media.JoinPart;
let reference: string;

beforeAll(async () => {
  if (ffmpeg === null) return;
  tools.forget();
  root = fs.mkdtempSync(`${os.tmpdir()}/stretched-`);
  source = `${root}/source.mp4`;
  // A moving picture at 25 fps (fitted to 30 as recordings are) and a chirp at 44.1 kHz (resampled to 48):
  // a stretch a frame or a few samples off its place shows in either.
  const made = Bun.spawnSync([
    ffmpeg, "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=20",
    "-f", "lavfi", "-i", "aevalsrc=0.5*sin(2*PI*(200*t+100*t*t)):s=44100:d=20",
    "-c:v", "libx264", "-g", "50", "-c:a", "aac", "-b:a", "128k", "-shortest", source,
  ]);
  if (made.exitCode !== 0) throw new Error(made.stderr.toString());
  part = { path: source, streams: await media.streams(source) };
  // The piece as one encode makes it, to hold the stretched one against.
  reference = `${root}/reference.mp4`;
  await media.join([part], reference);
});

afterAll(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  tools.forget();
});

const probe = (file: string, entries: string, stream?: string): string =>
  Bun.spawnSync(["ffprobe", "-v", "error", ...(stream ? ["-select_streams", stream] : []), "-count_frames", "-show_entries", entries, "-of", "csv=p=0", file]).stdout.toString().trim();
/** What `media.formatOf` compares before pieces are copied end to end. */
const format = (file: string) => Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,sample_rate,channels:stream_tags=encoder", "-of", "csv=p=0", file]).stdout.toString();
const sound = (file: string) => new Float32Array(Bun.spawnSync([ffmpeg!, "-v", "error", "-i", file, "-ac", "1", "-ar", "48000", "-f", "f32le", "-"]).stdout.buffer);

/** The worst match of `file`'s sound with the reference's, 20 ms at a time (1: the same); a gap or a jump at a join is far below it. */
function worstMatch(file: string): { worst: number; at: number; samples: [number, number] } {
  const [x, y] = [sound(reference), sound(file)];
  let worst = 1;
  let at = 0;
  for (let start = 0; start + 960 <= Math.min(x.length, y.length); start += 480) {
    let [xy, xx, yy] = [0, 0, 0];
    for (let i = start; i < start + 960; i++) {
      xy += x[i]! * y[i]!;
      xx += x[i]! * x[i]!;
      yy += y[i]! * y[i]!;
    }
    const match = xy / Math.sqrt(xx * yy + 1e-12);
    if (match < worst) [worst, at] = [match, start / 48_000];
  }
  return { worst, at, samples: [x.length, y.length] };
}

/** The worst frame's likeness (SSIM) to the reference's: a frame out of place at a join is far below a re-encode's. */
function worstFrame(file: string): number {
  const out = Bun.spawnSync([ffmpeg!, "-v", "error", "-i", reference, "-i", file, "-lavfi", "[0:v][1:v]ssim=stats_file=-", "-f", "null", "-"]).stdout.toString();
  return Math.min(...out.trim().split("\n").map((line) => Number(/All:([\d.]+)/.exec(line)?.[1] ?? 0)));
}

const wholeIn = (work: string) => fs.readdirSync(work).filter((name) => /-\d{4}\.mov$/.test(name)).sort();

test.skipIf(ffmpeg === null)("a long recording's piece cut part-way carries on from its whole stretches, and plays as one encode of it would", async () => {
  const work = `${root}/cut.stretches`;
  const dest = `${root}/cut.mp4`;
  // Cut as a restart cuts it: FFmpeg stopped mid-stretch, once two stretches are whole.
  const cut = new AbortController();
  const watch = setInterval(() => {
    if (fs.existsSync(work) && wholeIn(work).length >= 2) cut.abort();
  }, 20);
  await expect(media.joinStretched(part, dest, work, () => {}, cut.signal, STRETCH)).rejects.toThrow();
  clearInterval(watch);
  const kept = wholeIn(work);
  expect(kept.length).toBeGreaterThanOrEqual(2);
  expect(kept.length).toBeLessThan(7);
  // Nothing half-written is left as a stretch, and the piece isn't there.
  expect(fs.readdirSync(work).filter((name) => name.includes(".partial"))).toEqual([]);
  expect(fs.existsSync(dest)).toBe(false);
  // What a cut run of another build might leave: a partial of its own name, a stretch made another way.
  const prefix = kept[0]!.replace(/-\d{4}\.mov$/, "");
  fs.writeFileSync(`${work}/${prefix}-0005.deadbeef.partial.mov`, "half");
  fs.writeFileSync(`${work}/hw-oldbuild-0003.mov`, "another way");
  const before = new Map(kept.map((name) => [name, fs.statSync(`${work}/${name}`).mtimeMs]));

  const made = await media.joinStretched(part, dest, work, () => {}, undefined, STRETCH);
  expect(made.stretches).toBe(7);
  expect(made.kept).toBe(kept.length);
  // The kept stretches weren't made again; the leftovers are gone.
  for (const [name, mtime] of before) expect(fs.statSync(`${work}/${name}`).mtimeMs).toBe(mtime);
  expect(wholeIn(work)).toHaveLength(7);
  expect(fs.readdirSync(work).filter((name) => !/-\d{4}\.mov$/.test(name))).toEqual([]);

  // As long as the source, every frame of it at 30 fps.
  expect(Math.abs((await media.streams(dest)).durationMs - 20_000)).toBeLessThanOrEqual(50);
  expect(probe(dest, "stream=nb_read_frames", "v:0")).toBe("600");
  // The sound as one encode's, everywhere (the six joins included), and not a sample longer or shorter.
  const match = worstMatch(dest);
  console.log(`stretched piece: sound's worst 20 ms match ${match.worst.toFixed(4)} at ${match.at.toFixed(2)} s, ${match.samples[1]} samples (one encode: ${match.samples[0]}); picture's worst frame SSIM ${worstFrame(dest).toFixed(4)}`);
  expect(match.samples[1]).toBe(match.samples[0]);
  expect(match.worst).toBeGreaterThan(0.99);
  expect(worstFrame(dest)).toBeGreaterThan(0.95);
  // In the format a piece made in one go has, so the two are copied end to end with the case's other pieces.
  expect(format(dest)).toBe(format(reference));
  expect(await media.append(reference, [dest], `${root}/appended.mp4`)).toBe(true);
}, 120_000);

test.skipIf(ffmpeg === null)("an import stopped for an update stops its piece's stretch at once: no FFmpeg left writing, nothing half-made, carried on after", async () => {
  // As imports.ts runs it: the piece inside the import's fiber, its signal ended with the fiber
  // (`importSignal`), the fiber interrupted as `stop`/`stopAll` interrupt it before Edit restarts.
  const work = `${root}/stopped.stretches`;
  const dest = `${root}/stopped.mp4`;
  const ended = new AbortController();
  let encoding: Promise<unknown> = Promise.resolve();
  const fiber = runtime.runFork(Effect.promise(() => (encoding = media.joinStretched(part, dest, work, () => {}, ended.signal, STRETCH).catch((error: unknown) => error))));
  fiber.addObserver(() => ended.abort());
  while (!(fs.existsSync(work) && wholeIn(work).length >= 1)) await Bun.sleep(10);
  await runtime.runPromise(Fiber.interrupt(fiber));
  // The stretch under way ends with the import, not after it: no FFmpeg of this piece outlives the stop.
  expect(await encoding).toBeInstanceOf(Error);
  const writing = Bun.spawnSync(["/bin/ps", "-axo", "ppid=,command="]).stdout.toString().split("\n").filter((line) => line.includes(work));
  expect(writing).toEqual([]);
  expect(fs.readdirSync(work).filter((name) => !/-\d{4}\.mov$/.test(name))).toEqual([]);
  expect(fs.existsSync(dest)).toBe(false);
  const kept = wholeIn(work).length;
  expect(kept).toBeGreaterThanOrEqual(1);
  // After the restart it carries on from what's whole.
  const made = await media.joinStretched(part, dest, work, () => {}, undefined, STRETCH);
  expect(made.kept).toBe(kept);
  expect(worstMatch(dest).worst).toBeGreaterThan(0.99);
}, 120_000);

test.skipIf(ffmpeg === null)("read from the cloud, each stretch is sought where it is, not read from the start, and joins the same", async () => {
  // A stand-in for R2's presigned URL: ranges answered from the file, where each read starts noted.
  const size = fs.statSync(source).size;
  const starts: number[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const range = /bytes=(\d+)-(\d*)/.exec(request.headers.get("range") ?? "");
      const start = range ? Number(range[1]) : 0;
      const end = range && range[2] !== "" ? Math.min(Number(range[2]), size - 1) : size - 1;
      starts.push(start / size);
      const headers = { "accept-ranges": "bytes", "content-length": String(end - start + 1), "content-type": "video/mp4", ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) };
      return new Response(Bun.file(source).slice(start, end + 1), { status: range ? 206 : 200, headers });
    },
  });
  try {
    const url = `http://127.0.0.1:${server.port}/writer/source.mp4`;
    const remote = { path: url, streams: await media.streams(url) };
    starts.length = 0;
    const dest = `${root}/remote.mp4`;
    await media.joinStretched(remote, dest, `${root}/remote.stretches`, () => {}, undefined, STRETCH);
    // Read from the start, every opening's footage would be read from the file's head on (only its index, at the end, apart).
    // Sought, the later stretches' openings (picture and sound apart, two each) start reading part-way through.
    const partWay = starts.filter((at) => at > 0.25 && at < 0.9);
    console.log(`read from a URL: ${starts.length} reads, ${partWay.length} starting part-way through the file (${partWay.map((at) => `${Math.round(at * 100)}%`).join(", ")})`);
    expect(partWay.length).toBeGreaterThanOrEqual(6);
    expect(Math.abs((await media.streams(dest)).durationMs - 20_000)).toBeLessThanOrEqual(50);
    expect(worstMatch(dest).worst).toBeGreaterThan(0.99);
    expect(worstFrame(dest)).toBeGreaterThan(0.95);
  } finally {
    void server.stop(true);
  }
}, 120_000);

test.skipIf(ffmpeg === null)("AAC encoded stretch by stretch would not join without a seam (why the stretches keep their sound as samples)", async () => {
  // The trap, measured on the same clip: each stretch's own AAC adds the encoder's delay and a padded frame at every join.
  const list: string[] = [];
  for (let n = 0; n < 7; n++) {
    const out = `${root}/naive-${n}.mp4`;
    Bun.spawnSync([ffmpeg!, "-v", "error", "-y", "-ss", ((n * STRETCH) / 1000).toFixed(3), "-i", source, "-t", (STRETCH / 1000).toFixed(3), "-vf", "scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2,fps=30", "-c:v", "libx264", "-g", "30", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "96k", out]);
    list.push(`file '${out}'`);
  }
  fs.writeFileSync(`${root}/naive.txt`, `${list.join("\n")}\n`);
  Bun.spawnSync([ffmpeg!, "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", `${root}/naive.txt`, "-c", "copy", `${root}/naive.mp4`]);
  const match = worstMatch(`${root}/naive.mp4`);
  console.log(`AAC per stretch: sound's worst 20 ms match ${match.worst.toFixed(4)} at ${match.at.toFixed(2)} s, ${match.samples[1] - match.samples[0]} samples more than one encode`);
  expect(match.worst).toBeLessThan(0.9);
}, 60_000);

test.skipIf(ffmpeg === null || tools.videoHardware() === null)("a piece whose video hardware fails part-way is made on libx264 throughout, never the two in one piece, and carries on so", async () => {
  // FFmpeg that refuses the hardware encoder for a stretch read from 6 s on (the fourth), as footage the hardware can't take would.
  const wrapper = `${root}/ffmpeg-refusing`;
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh
prev=""; from=0; hw=0
for arg in "$@"; do
  [ "$prev" = "-ss" ] && from=\${arg%%.*}
  case "$arg" in h264_nvenc|h264_videotoolbox) hw=1 ;; esac
  prev=$arg
done
if [ $hw = 1 ] && [ $from -ge 6 ]; then echo "refused" >&2; exit 1; fi
exec "${ffmpeg}" "$@"
`,
  );
  fs.chmodSync(wrapper, 0o755);
  const was = process.env.EDIT_FFMPEG;
  process.env.EDIT_FFMPEG = wrapper;
  tools.forget();
  try {
    const work = `${root}/fallback.stretches`;
    const dest = `${root}/fallback.mp4`;
    const made = await media.joinStretched(part, dest, work, () => {}, undefined, STRETCH);
    expect(made.encoder).toBe("libx264");
    expect(made.kept).toBe(0);
    // Only libx264's stretches are left, and the piece says libx264 made it.
    expect(wholeIn(work).every((name) => name.startsWith("x264-"))).toBe(true);
    expect(wholeIn(work)).toHaveLength(7);
    expect(probe(dest, "stream_tags=encoder", "v:0")).toContain("libx264");
    expect(Math.abs((await media.streams(dest)).durationMs - 20_000)).toBeLessThanOrEqual(50);
    expect(worstMatch(dest).worst).toBeGreaterThan(0.99);
    // Carried on after a restart, it stays on libx264 and keeps every stretch.
    fs.rmSync(dest);
    const again = await media.joinStretched(part, dest, work, () => {}, undefined, STRETCH);
    expect(again).toEqual({ encoder: "libx264", stretches: 7, kept: 7 });
  } finally {
    if (was === undefined) delete process.env.EDIT_FFMPEG;
    else process.env.EDIT_FFMPEG = was;
    tools.forget();
  }
}, 120_000);
