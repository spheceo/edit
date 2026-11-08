import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as diag from "../src/diag.ts";
import * as fmp4 from "../src/fmp4.ts";
import * as pieces from "../src/proxy_pieces.ts";

const MIB = 1 << 20;

test("a long file's proxy is laid out in one-minute pieces, every frame and sound frame in exactly one", () => {
  // Robyn in custody: 82 min 58 s at 30 fps, 1080p.
  const layout = pieces.plan("drive:abc", "edit/originals/drive/abc/a.mp4", 4978.244, 30, 1920, 1080, true);
  expect(layout.perPiece).toBe(1800);
  expect(layout.frames).toBe(149_347);
  expect(layout.pieces).toBe(83);
  expect(pieces.framesOf(layout, 0)).toEqual([0, 1800]);
  expect(pieces.framesOf(layout, 82)).toEqual([147_600, 149_347]);
  // The pieces cover every frame once.
  let next = 0;
  for (let n = 0; n < layout.pieces; n++) {
    const [a, b] = pieces.framesOf(layout, n);
    expect(a).toBe(next);
    next = b;
  }
  expect(next).toBe(layout.frames);
  // The sound's frames too, on one grid, ending with the file.
  let sound = 0;
  for (let n = 0; n < layout.pieces; n++) {
    const [a, b] = pieces.audioFramesOf(layout, n);
    expect(a).toBe(sound);
    expect(b).toBeGreaterThan(a);
    sound = b;
  }
  expect(sound).toBe(layout.audio!.frames);
  expect(layout.audio!.frames).toBe(Math.ceil((4978.244 * 48_000) / 1024));
  // At 29.97 fps a piece is 1798 frames, each 3003 ticks of the 90 kHz clock exactly.
  const ntsc = pieces.plan("drive:b", "k", 600, 30_000 / 1001, 1280, 720, false);
  expect(ntsc.perPiece).toBe(1798);
  expect(pieces.videoTime(ntsc, 1798)).toBe(1798 * 3003);
  expect(ntsc.audio).toBeNull();
  expect([ntsc.width, ntsc.height]).toEqual([1280, 720]);
  // A 4K source fits in 1080p at the top rate; a small one gets less.
  expect(pieces.pictureSize(3840, 2160)).toEqual([1920, 1080]);
  expect(pieces.bitrateFor(3840, 2160)).toBe(4_000_000);
  expect(pieces.bitrateFor(640, 360)).toBe(800_000);
  // The piece a time of the source is in.
  expect(pieces.pieceAt(layout, 0)).toBe(0);
  expect(pieces.pieceAt(layout, 59.99)).toBe(0);
  expect(pieces.pieceAt(layout, 60)).toBe(1);
  expect(pieces.pieceAt(layout, 99_999)).toBe(82);
});

const entry = (type: string) => fmp4.box(type, new Uint8Array(70));

test("the virtual file: a head of whole MiB, the picture's index, a region per piece for its picture and sound, an index at the end, and ranges mapped onto them", () => {
  const layout = pieces.plan("drive:abc", "k", 4978.244, 30, 1920, 1080, true);
  const head = pieces.headOf(layout, entry("avc1"), entry("mp4a"));
  expect(layout.head % MIB).toBe(0);
  expect(head.length + 8).toBeLessThanOrEqual(layout.head);
  expect(pieces.indexAt(layout)).toBe(layout.head);
  expect(pieces.pieceSlotAt(layout, 0)).toBe(pieces.indexAt(layout) + pieces.indexSize(layout));
  expect(pieces.pieceSize(layout)).toBe(layout.slot + layout.audio!.slot);
  expect(pieces.pieceSlotAt(layout, 1)).toBe(pieces.pieceSlotAt(layout, 0) + pieces.pieceSize(layout));
  expect(pieces.tailAt(layout)).toBe(pieces.pieceSlotAt(layout, 83));
  const tail = pieces.tail(layout);
  expect(layout.total).toBe(pieces.tailAt(layout) + tail.length);
  // The index's last word is its own size (mediabunny finds it so).
  expect(new DataView(tail.buffer, tail.byteOffset).getUint32(tail.length - 4)).toBe(tail.length);
  // The head's boxes: ftyp and moov.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pieces-")), "head.mp4");
  fs.writeFileSync(file, head);
  expect(fmp4.topBoxes(file).map((box) => box.type)).toEqual(["ftyp", "moov"]);
  // The picture's sidx fills its place exactly and points at the slot right after it (first_offset 0: FFmpeg takes it as whole only so).
  const sidx = pieces.index(layout);
  expect(sidx.length).toBe(pieces.indexSize(layout));
  const view = new DataView(sidx.buffer, sidx.byteOffset);
  expect(Number(view.getBigUint64(28))).toBe(0);
  expect(view.getUint16(38)).toBe(83);
  // Each entry spans a piece's picture and its sound.
  expect(view.getUint32(40)).toBe(layout.slot + layout.audio!.slot);
  expect(pieces.regions(layout, pieces.indexAt(layout), pieces.indexAt(layout) + 1).map((r) => r.kind)).toEqual(["index"]);
  expect(pieces.videoEntryOf(head)).toEqual(entry("avc1"));
  // A range across the end of piece 2 and into piece 3: those two regions only.
  const at = pieces.pieceSlotAt(layout, 3);
  expect(pieces.regions(layout, at - 10, at + 10).map((r) => ("n" in r ? `${r.kind}${r.n}` : r.kind))).toEqual(["piece2", "piece3"]);
  expect(pieces.regions(layout, 0, 100).map((r) => r.kind)).toEqual(["head"]);
  expect(pieces.regions(layout, layout.total - 4, layout.total).map((r) => r.kind)).toEqual(["tail"]);
  expect(pieces.parseRange("bytes=10-19", 100)).toEqual([10, 20]);
  expect(pieces.parseRange("bytes=90-", 100)).toEqual([90, 100]);
  expect(pieces.parseRange("bytes=-10", 100)).toEqual([90, 100]);
  expect(pieces.parseRange("bytes=100-", 100)).toBeNull();
  expect(pieces.parseRange(null, 100)).toEqual([0, 100]);
  expect(pieces.baseOf(pieces.proxyKeyOf("drive:abc"))).toBe("edit/pieces/v3/drive/abc");
  expect(pieces.baseOf("edit/proxies/drive/abc.mp4")).toBeNull();
});

/** A context of files in a folder: R2 is `cloud`, a Map; nothing can be made (no original). */
function fakeContext(root: string, cloudFiles = new Map<string, Uint8Array>()): pieces.Context {
  return {
    cache: root,
    local: (key) => path.join(root, "cloud", key.replace(/^edit\//, "")),
    originalUrl: () => Promise.reject(new Error("no original here")),
    head: (key) => Promise.resolve(cloudFiles.has(key) ? { size: cloudFiles.get(key)!.length } : null),
    fetch: (key, local) => {
      const bytes = cloudFiles.get(key);
      if (bytes === undefined) return Promise.reject(new Error(`${key}: 404`));
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, bytes);
      return Promise.resolve();
    },
    upload: (local, key) => {
      cloudFiles.set(key, fs.readFileSync(local));
      return Promise.resolve();
    },
    exporting: () => false,
  };
}

test("a range of the virtual file is the pieces' bytes with free boxes after them, from R2 where this Mac has none", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pieces-"));
  const cloudFiles = new Map<string, Uint8Array>();
  const context = fakeContext(root, cloudFiles);
  const layout = pieces.plan("drive:x", "edit/originals/drive/x/x.mp4", 900, 30, 1920, 1080, false);
  const head = pieces.headOf(layout, entry("avc1"), null);
  const base = pieces.baseKey("drive:x");
  const put = (key: string, bytes: Uint8Array) => {
    const local = context.local(key);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, bytes);
  };
  put(`${base}/layout.json`, new TextEncoder().encode(JSON.stringify(layout)));
  put(`${base}/head.mp4`, head);
  const piece0 = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
  put(`${base}/video/0.m4s`, piece0);
  // Piece 1 only in R2 (another Mac made it).
  const piece1 = Uint8Array.from({ length: 500 }, (_, i) => (i * 7) % 253);
  cloudFiles.set(`${base}/video/1.m4s`, piece1);
  const at0 = pieces.pieceSlotAt(layout, 0);
  const at1 = pieces.pieceSlotAt(layout, 1);
  // The end of piece 0's bytes, its free box, and the start of piece 1.
  const ask = async (from: number, to: number) => {
    const response = await pieces.serve(context, new Request("http://x/", { headers: { range: `bytes=${from}-${to - 1}` } }), base);
    return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
  };
  const { response, bytes } = await ask(at0 + 990, at0 + 1010);
  expect(response.status).toBe(206);
  expect(response.headers.get("content-range")).toBe(`bytes ${at0 + 990}-${at0 + 1009}/${layout.total}`);
  expect([...bytes.subarray(0, 10)]).toEqual([...piece0.subarray(990)]);
  // free's header: its size (the rest of the slot) and its type.
  expect(new DataView(bytes.buffer).getUint32(10)).toBe(layout.slot - 1000);
  expect(new TextDecoder().decode(bytes.subarray(14, 18))).toBe("free");
  expect(bytes.subarray(18).every((value) => value === 0)).toBe(true);
  const across = await ask(at1 - 4, at1 + 8);
  expect([...across.bytes.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
  expect([...across.bytes.subarray(4)]).toEqual([...piece1.subarray(0, 8)]);
  expect(fs.existsSync(context.local(`${base}/video/1.m4s`))).toBe(true);
  // The head: its bytes then free to the first slot.
  const start = await ask(0, 8);
  expect([...start.bytes]).toEqual([...head.subarray(0, 8)]);
  const end = await ask(layout.total - 4, layout.total);
  expect(new DataView(end.bytes.buffer).getUint32(0)).toBe(pieces.tail(layout).length);
  // A piece nobody has and none can make: the read fails (the preview path answers 503), nothing half-written stays.
  await expect(ask(pieces.pieceSlotAt(layout, 2), pieces.pieceSlotAt(layout, 2) + 10)).rejects.toThrow("no original here");
  expect(fs.existsSync(context.local(`${base}/video/2.m4s`))).toBe(false);
});

test("a pieced proxy that can't be made gives way to the whole proxy", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pieces-"));
  const made = await pieces.tryCreate(fakeContext(root), "drive:y", "edit/originals/drive/y/y.mp4", { duration: 7200, fps: 30, width: 1920, height: 1080, has_audio: true });
  expect(made).toBeNull();
  // One another Mac laid out already is taken as it is.
  const cloudFiles = new Map<string, Uint8Array>();
  const layout = pieces.plan("drive:z", "edit/originals/drive/z/z.mp4", 7200, 30, 1920, 1080, true);
  pieces.headOf(layout, entry("avc1"), entry("mp4a"));
  cloudFiles.set(`${pieces.baseKey("drive:z")}/layout.json`, new TextEncoder().encode(JSON.stringify(layout)));
  const found = await pieces.tryCreate(fakeContext(root, cloudFiles), "drive:z", "edit/originals/drive/z/z.mp4", { duration: 7200, fps: 30, width: 1920, height: 1080, has_audio: true });
  expect(found?.total).toBe(layout.total);
});

test("a fragment written from an MP4's samples reads back as moof and mdat with the samples' bytes in order", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmp4-"));
  const source = path.join(root, "source.bin");
  fs.writeFileSync(source, Uint8Array.from({ length: 300 }, (_, i) => i % 256));
  const out = path.join(root, "piece.m4s");
  const size = fmp4.writeFragment(out, 3, [
    {
      id: 1,
      baseTime: 9000,
      samples: [
        { size: 100, duration: 3000, sync: true, cts: 0, from: source, offset: 0 },
        { size: 50, duration: 3000, sync: false, cts: 0, from: source, offset: 100 },
        { size: 25, duration: 3000, sync: false, cts: 0, from: source, offset: 200 },
      ],
    },
  ]);
  expect(fs.statSync(out).size).toBe(size);
  const boxes = fmp4.topBoxes(out);
  expect(boxes.map((box) => box.type)).toEqual(["moof", "mdat"]);
  const bytes = fs.readFileSync(out);
  const mdat = boxes[1]!;
  expect(mdat.size).toBe(8 + 175);
  expect([...bytes.subarray(mdat.at + 8, mdat.at + 108)]).toEqual(Array.from({ length: 100 }, (_, i) => i));
  expect([...bytes.subarray(mdat.at + 158, mdat.at + 183)]).toEqual(Array.from({ length: 25 }, (_, i) => 200 + i));
  // The trun's data offset is the first sample's place from the moof's start.
  const moof = new Uint8Array(bytes.subarray(0, boxes[0]!.size));
  const trun = Buffer.from(moof).indexOf("trun");
  expect(new DataView(moof.buffer).getInt32(trun + 4 + 4 + 4)).toBe(boxes[0]!.size + 8);
});

test("the sound streams as ADTS frames, cut whole however the pipe splits them, into an AAC-LC entry", () => {
  // Two ADTS frames (no CRC): 7-byte headers, payloads of 3 and 5 bytes.
  const frame = (payload: number[]) => {
    const length = 7 + payload.length;
    return [0xff, 0xf1, 0x4c, 0x80 | ((length >> 11) & 3), (length >> 3) & 0xff, ((length & 7) << 5) | 0x1f, 0xfc, ...payload];
  };
  const data = Uint8Array.from([...frame([1, 2, 3]), ...frame([4, 5, 6, 7, 8])]);
  // Split mid-frame: the first frame now, the second once the rest comes.
  const first = fmp4.adtsFrames(data.subarray(0, 14));
  expect(first.frames.map((f) => [...f])).toEqual([[1, 2, 3]]);
  const joined = new Uint8Array([...first.rest, ...data.subarray(14)]);
  expect(fmp4.adtsFrames(joined).frames.map((f) => [...f])).toEqual([[4, 5, 6, 7, 8]]);
  expect(() => fmp4.adtsFrames(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]))).toThrow("not an ADTS frame");
  // AAC-LC at 48 kHz stereo: AudioSpecificConfig 0x11 0x90, inside an mp4a's esds.
  const entry = pieces.AUDIO_ENTRY;
  expect(new TextDecoder().decode(entry.subarray(4, 8))).toBe("mp4a");
  const text = Buffer.from(entry).toString("hex");
  expect(text).toContain("05021190");
  expect(new DataView(entry.buffer, entry.byteOffset).getUint32(0)).toBe(entry.length);
});

test("the last MiB of a slot is answered without its piece (a reader looking for the index at the file's end)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pieces-"));
  const context = fakeContext(root);
  const layout = pieces.plan("drive:q", "edit/originals/drive/q/q.mp4", 900, 30, 1920, 1080, false);
  const head = pieces.headOf(layout, entry("avc1"), null);
  const base = pieces.baseKey("drive:q");
  for (const [key, bytes] of [[`${base}/layout.json`, new TextEncoder().encode(JSON.stringify(layout))], [`${base}/head.mp4`, head]] as const) {
    fs.mkdirSync(path.dirname(context.local(key)), { recursive: true });
    fs.writeFileSync(context.local(key), bytes);
  }
  // The last 64 KiB of the file: the end of the last (unmade) slot and the index.
  const response = await pieces.serve(context, new Request("http://x/", { headers: { range: `bytes=${layout.total - 65536}-${layout.total - 1}` } }), base);
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(bytes.length).toBe(65536);
  const tail = pieces.tail(layout);
  expect(bytes.subarray(0, 65536 - tail.length).every((value) => value === 0)).toBe(true);
  expect([...bytes.subarray(65536 - tail.length)]).toEqual([...tail]);
  expect(fs.existsSync(context.local(`${base}/video/2.m4s`))).toBe(false);
});

test("the preview path streams a pieced proxy's address, not its pieces' files", async () => {
  const { previewable } = await import("../src/cloud_playback.ts");
  expect(previewable(pieces.proxyKeyOf("sha256:eeb95c55"))).toBe(true);
  expect(previewable(pieces.proxyKeyOf("drive:1jKGSJSlkSEnHaQYmxUMW7vVvbJ1PjLif"))).toBe(true);
  expect(previewable("edit/pieces/drive/abc/video/3.m4s")).toBe(false);
  expect(previewable("edit/pieces/drive/abc/layout.json")).toBe(false);
  expect(previewable("edit/pieces/v3/drive/abc/audio/3.m4s")).toBe(false);
  // The five-minute ones from before v2 still play.
  expect(previewable("edit/pieces/sha256/abc/proxy.mp4")).toBe(true);
  expect(previewable("edit/proxies/drive/abc.mp4")).toBe(true);
  expect(previewable("edit/exports/x.mp4")).toBe(false);
});

/** AAC payloads back into an ADTS stream (LC, 48 kHz, stereo), for FFmpeg to decode. */
function adts(frames: Uint8Array[]): Uint8Array {
  const out: number[] = [];
  for (const frame of frames) {
    const length = frame.length + 7;
    out.push(0xff, 0xf1, 0x4c, 0x80 | ((length >> 11) & 3), (length >> 3) & 0xff, ((length & 7) << 5) | 0x1f, 0xfc, ...frame);
  }
  return Uint8Array.from(out);
}

/**
 * The FFmpeg on PATH's major version (0 when there is none). The seam test below
 * asks for the sound within a few samples of the file's clock, which holds with
 * the FFmpeg Edit ships (9.x, what CI and releases run) and not with Ubuntu's
 * 8.0.1, whose AAC decoder places the joined stream differently (Nov 8:
 * the one test that failed `just check` on the Linux dev machine, every run).
 */
const ffmpegMajor = (() => {
  try {
    const out = Bun.spawnSync(["ffmpeg", "-version"]).stdout.toString();
    return Number(/ffmpeg version n?(\d+)/.exec(out)?.[1] ?? 0);
  } catch {
    return 0;
  }
})();

test.skipIf(ffmpegMajor < 9)("each stretch's sound, made on its own, joins the next without a seam, on the file's clock", async () => {
  // 150 s of a 440 Hz tone at 44.1 kHz that starts 0.3 s into the file (after the picture), so three one-minute pieces.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pieces-sound-"));
  const file = path.join(root, "tone.mp4");
  const made = Bun.spawnSync([
    "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:size=64x36:rate=30:duration=150",
    "-itsoffset", "0.3", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=149.7",
    "-c:v", "mpeg4", "-c:a", "aac", "-b:a", "192k", file,
  ]);
  expect(made.exitCode).toBe(0);
  const layout = pieces.plan("sha256:t", "k", 150, 30, 64, 36, true);
  expect(layout.pieces).toBe(3);
  const context = { originalUrl: async () => file };
  const stretches = await Promise.all([0, 1, 2].map((n) => pieces.soundOf(context, layout, n)));
  stretches.forEach((frames, n) => expect(frames.length).toBe(pieces.audioFramesOf(layout, n)[1] - pieces.audioFramesOf(layout, n)[0]));
  const decoded = Bun.spawnSync(["ffmpeg", "-v", "error", "-f", "aac", "-i", "pipe:0", "-ac", "1", "-f", "f32le", "pipe:1"], { stdin: adts(stretches.flat()) });
  expect(decoded.exitCode).toBe(0);
  const pcm = new Float32Array(decoded.stdout.buffer, decoded.stdout.byteOffset, decoded.stdout.byteLength / 4);
  // How the decoded sound fits the tone over [from, from + 0.1) s: its lag (samples, within half the tone's period) and the worst miss there.
  const fit = (from: number) => {
    let best = { lag: 0, miss: Infinity };
    for (let lag = -54; lag <= 54; lag++) {
      let miss = 0;
      for (let i = Math.round(from * 48_000); i < Math.round((from + 0.1) * 48_000); i += 3) {
        const t = (i - lag) / 48_000;
        miss = Math.max(miss, Math.abs(pcm[i]! - (t < 0.3 ? 0 : Math.sin(2 * Math.PI * 440 * (t - 0.3)) / 8)));
      }
      if (miss < best.miss) best = { lag, miss };
    }
    return best;
  };
  // Silence before the sound starts; then the tone on the file's clock (FFmpeg's own MP4 of it is 0.8 ms early: within 1 ms).
  expect(fit(0.05).miss).toBeLessThan(0.002);
  const inside = fit(30);
  expect(Math.abs(inside.lag)).toBeLessThan(48);
  expect(inside.miss).toBeLessThan(0.005);
  // Across each join: the same lag, and no further from the tone than inside the stretches either side
  // (each is a few µs off the file's clock: 44.1 kHz cut where a 48 kHz frame starts).
  for (const n of [0, 1]) {
    const join = (pieces.audioFramesOf(layout, n)[1] * 1024) / 48_000;
    const across = fit(join - 0.05);
    const either = Math.max(fit(join - 20).miss, fit(join + 20).miss);
    expect(across.lag).toBe(inside.lag);
    expect(across.miss).toBeLessThan(Math.max(either * 1.5, 0.002));
    expect(across.miss).toBeLessThan(0.01);
  }
}, 60_000);

test("the background fill's piece gives way to one someone is waiting on, and is made after it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pieces-way-"));
  // The original is a pipe nobody writes to yet: FFmpeg waits on it, so a piece stays being made until the test lets go.
  const original = path.join(root, "original.mp4");
  expect(Bun.spawnSync(["mkfifo", original]).exitCode).toBe(0);
  const context = { ...fakeContext(root), originalUrl: async () => original };
  const layout = pieces.plan("sha256:w", "k", 600, 30, 1920, 1080, false);
  const base = pieces.baseKey("sha256:w");
  const headFile = context.local(`${base}/head.mp4`);
  fs.mkdirSync(path.dirname(headFile), { recursive: true });
  fs.writeFileSync(headFile, pieces.headOf(layout, entry("avc1"), null));
  const order: string[] = [];
  const watch = (name: string, promise: Promise<string>) => promise.then(() => order.push(`${name} made`), (error: unknown) => order.push(`${name}: ${diag.messageOf(error)}`));
  const behind = watch("3", pieces.ensureVideo(context, base, layout, 3, false));
  await Bun.sleep(300);
  const wanted = watch("7", pieces.ensureVideo(context, base, layout, 7));
  // FFmpeg reads nothing it can use from here on: each piece's try fails in turn.
  for (let tries = 0; tries < 16 && order.length < 2; tries++) {
    const pipe = fs.openSync(original, "w");
    fs.writeSync(pipe, "not a video");
    fs.closeSync(pipe);
    await Bun.sleep(300);
  }
  await Promise.all([behind, wanted]);
  // 7 went first; 3 was stopped for it, not failed by it, and tried again after.
  expect(order.map((one) => one.split(":")[0])).toEqual(["7", "3"]);
  expect(order[1]).toContain("piece 3's picture");
  expect(fs.existsSync(context.local(`${base}/video/3.m4s`))).toBe(false);
}, 30_000);

test("FFmpeg reads a pieced proxy's picture and sound together, from its start and after a seek", async () => {
  // 150 s of picture and a tone: three pieces. Their pictures as makeVideo leaves them (from libx264 here,
  // VideoToolbox in Edit: a keyframe at each piece's start, no B-frames); their sound made as it's read.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pieces-ffmpeg-"));
  const original = path.join(root, "original.mp4");
  const made = Bun.spawnSync([
    "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=150", "-f", "lavfi", "-i", "sine=frequency=440:duration=150",
    "-c:v", "libx264", "-bf", "0", "-g", "15", "-force_key_frames", "expr:gte(t,n_forced*60)", "-c:a", "aac", original,
  ]);
  expect(made.exitCode).toBe(0);
  const layout = pieces.plan("sha256:ff", "k", 150, 30, 320, 180, true);
  const base = pieces.baseKey("sha256:ff");
  const context = { ...fakeContext(root), originalUrl: async () => original };
  const picture = fmp4.readMp4(original).find((track) => track.handler === "vide")!;
  for (let n = 0; n < layout.pieces; n++) {
    const [first, end] = pieces.framesOf(layout, n);
    const file = context.local(`${base}/video/${n}.m4s`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fmp4.writeFragment(file, layout.pieces + n + 1, [
      {
        id: 1,
        baseTime: pieces.videoTime(layout, first),
        samples: picture.samples.slice(first, end).map((sample, index) => ({
          size: sample.size, duration: pieces.videoTime(layout, first + index + 1) - pieces.videoTime(layout, first + index), sync: sample.sync, cts: 0, from: original, offset: sample.offset,
        })),
      },
    ]);
  }
  const head = pieces.headOf(layout, picture.entry, pieces.AUDIO_ENTRY);
  fs.writeFileSync(context.local(`${base}/head.mp4`), head);
  fs.writeFileSync(context.local(`${base}/layout.json`), JSON.stringify(layout));
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => pieces.serve(context, request, base) });
  try {
    const url = `http://127.0.0.1:${server.port}/proxy.mp4`;
    // FFmpeg runs apart from this process (its server answers while it reads).
    const cut = async (from: number, out: string) => {
      const child = Bun.spawn(["ffmpeg", "-v", "error", "-nostdin", "-y", "-ss", String(from), "-i", url, "-t", "4", "-c:v", "copy", "-c:a", "pcm_s16le", out], { stderr: "pipe" });
      expect(await child.exited).toBe(0);
      const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "csv=p=0", out]);
      return new TextDecoder().decode(probe.stdout).trim().split("\n").map((line) => line.split(","));
    };
    for (const from of [0, 70]) {
      const streams = await cut(from, path.join(root, `cut-${from}.mov`));
      expect(streams.map(([kind]) => kind).sort()).toEqual(["audio", "video"]);
      for (const [, seconds] of streams) expect(Math.abs(Number(seconds) - 4)).toBeLessThan(0.1);
    }
    // Each piece read is one fragment of both, joined here; piece 2 was never read.
    expect(fmp4.readFragment(context.local(`${base}/joined/1.m4s`)).map((track) => track.id)).toEqual([1, 2]);
    expect(fs.existsSync(context.local(`${base}/joined/2.m4s`))).toBe(false);
  } finally {
    await server.stop(true);
  }
}, 60_000);

test("the fill's piece someone joined is never stopped for another", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pieces-joined-"));
  const original = path.join(root, "original.mp4");
  expect(Bun.spawnSync(["mkfifo", original]).exitCode).toBe(0);
  const context = { ...fakeContext(root), originalUrl: async () => original };
  const layout = pieces.plan("sha256:j", "k", 600, 30, 1920, 1080, false);
  const base = pieces.baseKey("sha256:j");
  const headFile = context.local(`${base}/head.mp4`);
  fs.mkdirSync(path.dirname(headFile), { recursive: true });
  fs.writeFileSync(headFile, pieces.headOf(layout, entry("avc1"), null));
  const settled: string[] = [];
  const watch = (name: string, promise: Promise<string>) => promise.then(() => settled.push(`${name} made`), (error: unknown) => settled.push(`${name}: ${error instanceof pieces.GaveWay ? "gave way" : "failed"}`));
  const behind = watch("fill's 3", pieces.ensureVideo(context, base, layout, 3, false));
  await Bun.sleep(300);
  // The viewer waits on piece 3 too, then something else on piece 7: 3 goes on being made.
  const joined = watch("viewer's 3", pieces.ensureVideo(context, base, layout, 3));
  const other = watch("7", pieces.ensureVideo(context, base, layout, 7));
  await Bun.sleep(500);
  expect(settled).toEqual([]);
  // Let FFmpeg read (nothing usable) until all of them are done.
  for (let tries = 0; tries < 12 && settled.length < 3; tries++) {
    const pipe = fs.openSync(original, "w");
    fs.writeSync(pipe, "not a video");
    fs.closeSync(pipe);
    await Bun.sleep(300);
  }
  await Promise.all([behind, joined, other]);
  expect(settled.some((one) => one.includes("gave way"))).toBe(false);
}, 30_000);

test("the first piece made while the file was hashed is taken into place as it is", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pieces-first-"));
  const cloudFiles = new Map<string, Uint8Array>();
  const context = fakeContext(root, cloudFiles);
  const picture = path.join(root, "made-picture.m4s");
  const sound = path.join(root, "made-sound.m4s");
  fs.writeFileSync(picture, "picture piece 0");
  fs.writeFileSync(sound, "sound piece 0");
  let discarded = 0;
  const first: pieces.FirstPiece = { made: Promise.resolve({ picture: { file: picture, entry: entry("avc1") }, sound }), discard: () => void discarded++ };
  const layout = await pieces.create(context, "sha256:first", "edit/originals/sha256/first/a.mp4", { duration: 3600, fps: 30, width: 1920, height: 1080, has_audio: true }, first);
  const base = pieces.baseKey("sha256:first");
  expect(layout.pieces).toBe(60);
  expect(fs.readFileSync(context.local(`${base}/video/0.m4s`), "utf8")).toBe("picture piece 0");
  expect(fs.readFileSync(context.local(`${base}/audio/0.m4s`), "utf8")).toBe("sound piece 0");
  expect(fs.existsSync(picture) || fs.existsSync(sound)).toBe(false);
  expect(cloudFiles.has(`${base}/layout.json`) && cloudFiles.has(`${base}/head.mp4`)).toBe(true);
  // Laid out already: another first piece isn't wanted.
  await pieces.create(context, "sha256:first", "edit/originals/sha256/first/a.mp4", { duration: 3600, fps: 30, width: 1920, height: 1080, has_audio: true }, first);
  expect(discarded).toBe(1);
});
