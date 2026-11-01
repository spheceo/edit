// A review copy whose video runs longer than its edit, read from the MP4's
// own index and mapped back (Nov 1: Kroger's 82.5-minute edit came out a
// 17 h 11 min review copy: Modal's pieces carried the export's chapters,
// Debian's ffmpeg counted them in each piece's length, and the join held each
// piece's last frame until the export's end). scripts/repair-review-copies.ts
// sweeps the reviews with these, makes each faulty copy again from its export
// and moves its notes to the moments they meant.

/** The video track's timing: its timescale and its stts runs (count samples of delta each). */
export type VideoTiming = { timescale: number; runs: [count: number, delta: number][] };

/** Every child box in `buffer[from, to)`: type and where its body is. */
function boxes(buffer: Uint8Array, from: number, to: number): { type: string; body: number; end: number }[] {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const found: { type: string; body: number; end: number }[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(...buffer.subarray(at + 4, at + 8));
    let body = at + 8;
    if (size === 1) {
      size = Number(view.getBigUint64(at + 8));
      body = at + 16;
    } else if (size === 0) size = to - at;
    if (size < 8 || at + size > to) break;
    found.push({ type, body, end: at + size });
    at += size;
  }
  return found;
}

/** The video track's timing in a `moov` box's bytes (its header included), or null when it has none. */
export function videoTiming(moov: Uint8Array): VideoTiming | null {
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const [top] = boxes(moov, 0, moov.length);
  if (top === undefined || top.type !== "moov") return null;
  const child = (box: { body: number; end: number }, type: string) => boxes(moov, box.body, box.end).find((one) => one.type === type);
  for (const trak of boxes(moov, top.body, top.end).filter((one) => one.type === "trak")) {
    const mdia = child(trak, "mdia");
    if (mdia === undefined) continue;
    const hdlr = child(mdia, "hdlr");
    // hdlr: version/flags (4), pre_defined (4), handler_type (4).
    if (hdlr === undefined || String.fromCharCode(...moov.subarray(hdlr.body + 8, hdlr.body + 12)) !== "vide") continue;
    const mdhd = child(mdia, "mdhd");
    const stts = child(child(child(mdia, "minf") ?? { body: 0, end: 0 }, "stbl") ?? { body: 0, end: 0 }, "stts");
    if (mdhd === undefined || stts === undefined) return null;
    // mdhd v0: version/flags (4), created (4), modified (4), timescale (4); v1: the times are 8 each.
    const timescale = view.getUint32(mdhd.body + (moov[mdhd.body] === 1 ? 20 : 12));
    const entries = view.getUint32(stts.body + 4);
    const runs: [number, number][] = [];
    for (let index = 0; index < entries; index++) runs.push([view.getUint32(stts.body + 8 + index * 8), view.getUint32(stts.body + 12 + index * 8)]);
    return { timescale, runs };
  }
  return null;
}

/** The delta most samples have: one frame's length. */
export function frameDelta(timing: VideoTiming): number {
  const counts = new Map<number, number>();
  for (const [count, delta] of timing.runs) counts.set(delta, (counts.get(delta) ?? 0) + count);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 1;
}

/** The video's length as its index says, in ms. */
export function videoMs(timing: VideoTiming): number {
  return (timing.runs.reduce((sum, [count, delta]) => sum + count * delta, 0) / timing.timescale) * 1000;
}

/** Whether the video runs longer than the edit it's of (`durationMs`): a second, and a hundredth, of slack. */
export function stretched(timing: VideoTiming, durationMs: number): boolean {
  return videoMs(timing) > durationMs * 1.01 + 1000;
}

/**
 * Where a moment of the stretched video (`ms`) is in the copy made again:
 * inside a piece's own frames, the same frame; inside a held frame's tail,
 * that frame (the end of its piece).
 */
export function fixedMs(timing: VideoTiming, ms: number): number {
  const frame = frameDelta(timing);
  const at = (ms / 1000) * timing.timescale;
  let start = 0;
  let frames = 0;
  for (const [count, delta] of timing.runs) {
    const span = count * delta;
    if (at < start + span) {
      const index = Math.floor((at - start) / delta);
      const into = at - start - index * delta;
      return Math.round((((frames + index) * frame + Math.min(into, frame)) / timing.timescale) * 1000);
    }
    start += span;
    frames += count;
  }
  return Math.round(((frames * frame) / timing.timescale) * 1000);
}
