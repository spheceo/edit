// Just enough ISO BMFF (MP4) to read an MP4's sample tables and write a
// fragmented MP4 from them: an init segment (ftyp + moov with mvex),
// fragments (moof + mdat), `free` padding and a random-access index (mfra).
// The pieced proxy (proxy_pieces.ts) is built from these.

import * as fs from "node:fs";

/** One sample of a track as an MP4 holds it. */
export interface Sample {
  /** Where its bytes are in the file. */
  offset: number;
  size: number;
  /** In the track's timescale. */
  duration: number;
  sync: boolean;
  /** Composition offset (presentation minus decode time), in the timescale. */
  cts: number;
}

/** A track of an MP4 (`readMp4`). */
export interface Track {
  id: number;
  /** `vide` or `soun` (or another handler). */
  handler: string;
  timescale: number;
  /** Its sample entry box (`avc1`, `mp4a`, …), header and all. */
  entry: Uint8Array;
  width: number;
  height: number;
  samples: Sample[];
}

interface Box {
  type: string;
  /** Where its content starts and ends, in the buffer it was read from. */
  start: number;
  end: number;
}

function boxes(data: Uint8Array, from: number, to: number): Box[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(data[at + 4]!, data[at + 5]!, data[at + 6]!, data[at + 7]!);
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header || at + size > to) throw new Error(`a broken ${type} box at ${at}`);
    out.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return out;
}

function child(data: Uint8Array, parent: Box, type: string): Box | null {
  return boxes(data, parent.start, parent.end).find((box) => box.type === type) ?? null;
}

function path(data: Uint8Array, parent: Box, ...types: string[]): Box | null {
  let at: Box | null = parent;
  for (const type of types) {
    if (at === null) return null;
    at = child(data, at, type);
  }
  return at;
}

/** The top-level boxes of the file at `file` (type, where it starts, its size). */
export function topBoxes(file: string): { type: string; at: number; size: number }[] {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const head = new Uint8Array(16);
    const view = new DataView(head.buffer);
    const out: { type: string; at: number; size: number }[] = [];
    let at = 0;
    while (at + 8 <= size) {
      fs.readSync(fd, head, 0, 16, at);
      let length = view.getUint32(0);
      if (length === 1) length = Number(view.getBigUint64(8));
      else if (length === 0) length = size - at;
      if (length < 8) throw new Error(`a broken box at ${at} of ${file}`);
      out.push({ type: String.fromCharCode(head[4]!, head[5]!, head[6]!, head[7]!), at, size: length });
      at += length;
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** The tracks of the (unfragmented) MP4 at `file`, with every sample's place and timing. */
export function readMp4(file: string): Track[] {
  const moovAt = topBoxes(file).find((box) => box.type === "moov");
  if (moovAt === undefined) throw new Error(`${file} has no moov box`);
  const data = new Uint8Array(moovAt.size);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, data, 0, moovAt.size, moovAt.at);
  } finally {
    fs.closeSync(fd);
  }
  const view = new DataView(data.buffer);
  const moov = boxes(data, 0, data.length)[0]!;
  const tracks: Track[] = [];
  for (const trak of boxes(data, moov.start, moov.end).filter((box) => box.type === "trak")) {
    const tkhd = child(data, trak, "tkhd");
    const mdhd = path(data, trak, "mdia", "mdhd");
    const hdlr = path(data, trak, "mdia", "hdlr");
    const stbl = path(data, trak, "mdia", "minf", "stbl");
    if (tkhd === null || mdhd === null || hdlr === null || stbl === null) continue;
    const tkhdV1 = data[tkhd.start] === 1;
    const id = view.getUint32(tkhd.start + (tkhdV1 ? 20 : 12));
    const width = view.getUint32(tkhd.end - 8) >>> 16;
    const height = view.getUint32(tkhd.end - 4) >>> 16;
    const timescale = view.getUint32(mdhd.start + (data[mdhd.start] === 1 ? 20 : 12));
    const handler = String.fromCharCode(...data.subarray(hdlr.start + 8, hdlr.start + 12));
    const stsd = child(data, stbl, "stsd");
    if (stsd === null) continue;
    const entryBox = boxes(data, stsd.start + 8, stsd.end)[0];
    if (entryBox === undefined) continue;
    const entryStart = entryBox.start - (entryBox.end - entryBox.start > 0xffffffff ? 16 : 8);
    const entry = data.slice(entryStart, entryBox.end);
    // Sizes.
    const stsz = child(data, stbl, "stsz");
    if (stsz === null) continue;
    const fixed = view.getUint32(stsz.start + 4);
    const count = view.getUint32(stsz.start + 8);
    const sizes = new Array<number>(count);
    for (let i = 0; i < count; i++) sizes[i] = fixed !== 0 ? fixed : view.getUint32(stsz.start + 12 + 4 * i);
    // Durations.
    const durations = new Array<number>(count).fill(0);
    const stts = child(data, stbl, "stts");
    if (stts !== null) {
      let i = 0;
      const entries = view.getUint32(stts.start + 4);
      for (let e = 0; e < entries; e++) {
        const n = view.getUint32(stts.start + 8 + 8 * e);
        const delta = view.getUint32(stts.start + 12 + 8 * e);
        for (let k = 0; k < n && i < count; k++) durations[i++] = delta;
      }
    }
    // Composition offsets.
    const cts = new Array<number>(count).fill(0);
    const ctts = child(data, stbl, "ctts");
    if (ctts !== null) {
      let i = 0;
      const entries = view.getUint32(ctts.start + 4);
      const signed = data[ctts.start] === 1;
      for (let e = 0; e < entries; e++) {
        const n = view.getUint32(ctts.start + 8 + 8 * e);
        const offset = signed ? view.getInt32(ctts.start + 12 + 8 * e) : view.getUint32(ctts.start + 12 + 8 * e);
        for (let k = 0; k < n && i < count; k++) cts[i++] = offset;
      }
    }
    // Sync samples (none listed: every one).
    const stss = child(data, stbl, "stss");
    const sync = new Array<boolean>(count).fill(stss === null);
    if (stss !== null) {
      const entries = view.getUint32(stss.start + 4);
      for (let e = 0; e < entries; e++) {
        const n = view.getUint32(stss.start + 8 + 4 * e);
        if (n >= 1 && n <= count) sync[n - 1] = true;
      }
    }
    // Offsets: chunks (stco/co64) and samples per chunk (stsc).
    const stco = child(data, stbl, "stco");
    const co64 = child(data, stbl, "co64");
    const chunkOffsets: number[] = [];
    if (stco !== null) {
      const n = view.getUint32(stco.start + 4);
      for (let c = 0; c < n; c++) chunkOffsets.push(view.getUint32(stco.start + 8 + 4 * c));
    } else if (co64 !== null) {
      const n = view.getUint32(co64.start + 4);
      for (let c = 0; c < n; c++) chunkOffsets.push(Number(view.getBigUint64(co64.start + 8 + 8 * c)));
    }
    const stsc = child(data, stbl, "stsc");
    const runs: { first: number; perChunk: number }[] = [];
    if (stsc !== null) {
      const n = view.getUint32(stsc.start + 4);
      for (let e = 0; e < n; e++) runs.push({ first: view.getUint32(stsc.start + 8 + 12 * e), perChunk: view.getUint32(stsc.start + 12 + 12 * e) });
    }
    const samples: Sample[] = [];
    let index = 0;
    for (let c = 0; c < chunkOffsets.length && index < count; c++) {
      let run = runs[0];
      for (const one of runs) if (one.first <= c + 1) run = one;
      let at = chunkOffsets[c]!;
      for (let k = 0; k < (run?.perChunk ?? 0) && index < count; k++) {
        samples.push({ offset: at, size: sizes[index]!, duration: durations[index]!, sync: sync[index]!, cts: cts[index]! });
        at += sizes[index]!;
        index++;
      }
    }
    if (samples.length !== count) throw new Error(`${file}: track ${id}'s chunks hold ${samples.length} of its ${count} samples`);
    tracks.push({ id, handler, timescale, entry, width, height, samples });
  }
  return tracks;
}

// ---------------------------------------------------------------------------
// Writing.

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function u8(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function u16(value: number): Uint8Array {
  return u8((value >>> 8) & 255, value & 255);
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0);
  return out;
}

function i32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value);
  return out;
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

export function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const content = concat(parts);
  return concat([u32(content.length + 8), ascii(type), content]);
}

function fullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array {
  return box(type, u8(version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255), ...parts);
}

/** A `free` box of `size` bytes (≥ 8): its header; the rest is any bytes (readers skip it). */
export function freeHeader(size: number): Uint8Array {
  if (size < 8 || size > 0xffffffff) throw new Error(`a free box can't be ${size} bytes`);
  return concat([u32(size), ascii("free")]);
}

const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

/** A track of an init segment. */
export interface InitTrack {
  id: number;
  handler: "vide" | "soun";
  timescale: number;
  entry: Uint8Array;
  width: number;
  height: number;
}

/**
 * An init segment: ftyp and a moov with no samples and an mvex (`mehd`
 * giving the whole duration, so readers know it before any fragment).
 */
export function initSegment(durationSeconds: number, tracks: InitTrack[]): Uint8Array {
  const movieScale = 1000;
  const movieDuration = Math.round(durationSeconds * movieScale);
  const ftyp = box("ftyp", ascii("isom"), u32(512), ascii("isom"), ascii("iso6"), ascii("avc1"), ascii("mp41"));
  const mvhd = fullBox(
    "mvhd", 1, 0, u64(0), u64(0), u32(movieScale), u64(movieDuration),
    u32(0x00010000), u16(0x0100), new Uint8Array(10), ...MATRIX.map(u32), new Uint8Array(24), u32(Math.max(...tracks.map((t) => t.id)) + 1),
  );
  const traks = tracks.map((track) => {
    const video = track.handler === "vide";
    const tkhd = fullBox(
      "tkhd", 1, 3, u64(0), u64(0), u32(track.id), u32(0), u64(movieDuration), new Uint8Array(8),
      u16(0), u16(0), u16(video ? 0 : 0x0100), u16(0), ...MATRIX.map(u32), u32(video ? track.width << 16 : 0), u32(video ? track.height << 16 : 0),
    );
    const mdhd = fullBox("mdhd", 1, 0, u64(0), u64(0), u32(track.timescale), u64(0), u16(0x55c4), u16(0));
    const hdlr = fullBox("hdlr", 0, 0, u32(0), ascii(track.handler), new Uint8Array(12), ascii(video ? "VideoHandler\0" : "SoundHandler\0"));
    const header = video ? fullBox("vmhd", 0, 1, new Uint8Array(8)) : fullBox("smhd", 0, 0, new Uint8Array(4));
    const dinf = box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));
    const stbl = box(
      "stbl",
      fullBox("stsd", 0, 0, u32(1), track.entry),
      fullBox("stts", 0, 0, u32(0)),
      fullBox("stsc", 0, 0, u32(0)),
      fullBox("stsz", 0, 0, u32(0), u32(0)),
      fullBox("stco", 0, 0, u32(0)),
    );
    return box("trak", tkhd, box("mdia", mdhd, hdlr, box("minf", header, dinf, stbl)));
  });
  const mvex = box(
    "mvex",
    fullBox("mehd", 1, 0, u64(movieDuration)),
    ...tracks.map((track) => fullBox("trex", 0, 0, u32(track.id), u32(1), u32(0), u32(0), u32(0))),
  );
  return concat([ftyp, box("moov", mvhd, ...traks, mvex)]);
}

/** A sample of a fragment: its timing and where its bytes come from. */
export interface FragmentSample {
  size: number;
  duration: number;
  sync: boolean;
  cts: number;
  /** Its bytes: in file `from` at `offset`, or these (`bytes`). */
  from: string;
  offset: number;
  bytes?: Uint8Array;
}

/** One track's run in a fragment. */
export interface FragmentTrack {
  id: number;
  /** Its first sample's decode time, in the track's timescale. */
  baseTime: number;
  samples: FragmentSample[];
}

const SYNC = 0x02000000;
const NOT_SYNC = 0x01010000;

/** The moof of a fragment holding `tracks` (in that order in its mdat), and the mdat's header. */
/** A track's run of samples, as a moof describes it. */
export interface Run {
  id: number;
  baseTime: number;
  samples: { size: number; duration: number; sync: boolean; cts: number }[];
}

export function fragmentHeader(sequence: number, tracks: Run[]): { moof: Uint8Array; mdat: Uint8Array; size: number } {
  const build = (offsets: number[]) =>
    box(
      "moof",
      fullBox("mfhd", 0, 0, u32(sequence)),
      ...tracks.map((track, index) => {
        const withCts = track.samples.some((sample) => sample.cts !== 0);
        const flags = 0x000001 | 0x000100 | 0x000200 | 0x000400 | (withCts ? 0x000800 : 0);
        const rows = track.samples.map((sample) =>
          concat([u32(sample.duration), u32(sample.size), u32(sample.sync ? SYNC : NOT_SYNC), ...(withCts ? [i32(sample.cts)] : [])]),
        );
        return box(
          "traf",
          fullBox("tfhd", 0, 0x020000, u32(track.id)),
          fullBox("tfdt", 1, 0, u64(track.baseTime)),
          fullBox("trun", withCts ? 1 : 0, flags, u32(track.samples.length), i32(offsets[index] ?? 0), ...rows),
        );
      }),
    );
  // The data offsets depend on the moof's size, which doesn't on their values.
  const moofSize = build(tracks.map(() => 0)).length;
  const bytes = tracks.map((track) => track.samples.reduce((sum, sample) => sum + sample.size, 0));
  const offsets: number[] = [];
  let at = moofSize + 8;
  for (const size of bytes) {
    offsets.push(at);
    at += size;
  }
  const data = bytes.reduce((sum, size) => sum + size, 0);
  if (data + 8 > 0xffffffff) throw new Error("a fragment's data must be under 4 GB");
  return { moof: build(offsets), mdat: concat([u32(data + 8), ascii("mdat")]), size: moofSize + 8 + data };
}

/** Writes the fragment of `tracks` to `out` (moof, mdat, the samples' bytes copied in); its size. */
export function writeFragment(out: string, sequence: number, tracks: FragmentTrack[]): number {
  const { moof, mdat, size } = fragmentHeader(sequence, tracks);
  const fd = fs.openSync(out, "w");
  const sources = new Map<string, number>();
  try {
    fs.writeSync(fd, moof);
    fs.writeSync(fd, mdat);
    const buffer = new Uint8Array(4 << 20);
    for (const track of tracks) {
      // Runs of samples next to each other in their file, copied at once.
      let index = 0;
      while (index < track.samples.length) {
        const first = track.samples[index]!;
        if (first.bytes !== undefined) {
          fs.writeSync(fd, first.bytes);
          index++;
          continue;
        }
        let end = first.offset + first.size;
        let next = index + 1;
        while (next < track.samples.length && track.samples[next]!.bytes === undefined && track.samples[next]!.from === first.from && track.samples[next]!.offset === end) {
          end += track.samples[next]!.size;
          next++;
        }
        let source = sources.get(first.from);
        if (source === undefined) {
          source = fs.openSync(first.from, "r");
          sources.set(first.from, source);
        }
        for (let at = first.offset; at < end; ) {
          const want = Math.min(buffer.length, end - at);
          const got = fs.readSync(source, buffer, 0, want, at);
          if (got <= 0) throw new Error(`${first.from} ended at ${at}, before its samples did`);
          fs.writeSync(fd, buffer, 0, got);
          at += got;
        }
        index = next;
      }
    }
  } finally {
    for (const source of sources.values()) fs.closeSync(source);
    fs.closeSync(fd);
  }
  return size;
}

/**
 * The runs of a fragment file `writeFragment` wrote (its moof read back):
 * each track's samples, their bytes where they are in `file`, ready to be
 * written into another fragment.
 */
export function readFragment(file: string): FragmentTrack[] {
  const fd = fs.openSync(file, "r");
  let moof: Uint8Array;
  try {
    const header = new Uint8Array(8);
    if (fs.readSync(fd, header, 0, 8, 0) !== 8) throw new Error(`${file} is too short for a fragment`);
    const size = new DataView(header.buffer).getUint32(0);
    if (String.fromCharCode(...header.subarray(4, 8)) !== "moof" || size < 16) throw new Error(`${file} doesn't start with a moof`);
    moof = new Uint8Array(size);
    if (fs.readSync(fd, moof, 0, size, 0) !== size) throw new Error(`${file}'s moof is cut short`);
  } finally {
    fs.closeSync(fd);
  }
  const view = new DataView(moof.buffer);
  const root = boxes(moof, 0, moof.length)[0]!;
  return boxes(moof, root.start, root.end)
    .filter((box) => box.type === "traf")
    .map((traf) => {
      const tfhd = child(moof, traf, "tfhd");
      const tfdt = child(moof, traf, "tfdt");
      const trun = child(moof, traf, "trun");
      if (tfhd === null || tfdt === null || trun === null) throw new Error(`${file}: a traf without its tfhd, tfdt or trun`);
      const id = view.getUint32(tfhd.start + 4);
      const baseTime = moof[tfdt.start] === 1 ? Number(view.getBigUint64(tfdt.start + 4)) : view.getUint32(tfdt.start + 4);
      const flags = view.getUint32(trun.start) & 0xffffff;
      if ((flags & 0x701) !== 0x701) throw new Error(`${file}: a trun this doesn't read (flags ${flags.toString(16)})`);
      const withCts = (flags & 0x800) !== 0;
      const count = view.getUint32(trun.start + 4);
      let offset = view.getInt32(trun.start + 8);
      const samples: FragmentSample[] = [];
      for (let n = 0, at = trun.start + 12; n < count; n++, at += withCts ? 16 : 12) {
        const size = view.getUint32(at + 4);
        samples.push({ size, duration: view.getUint32(at), sync: view.getUint32(at + 8) === SYNC, cts: withCts ? view.getInt32(at + 12) : 0, from: file, offset });
        offset += size;
      }
      return { id, baseTime, samples };
    });
}

/** The random-access index at a file's end (mfra: a tfra per track, then mfro): each fragment's time and moof's place. */
export function mfra(tracks: { id: number; entries: { time: number; offset: number }[] }[]): Uint8Array {
  const tfras = tracks.map((track) =>
    fullBox(
      "tfra", 1, 0, u32(track.id), u32(0), u32(track.entries.length),
      ...track.entries.map((entry) => concat([u64(entry.time), u64(entry.offset), u8(1, 1, 1)])),
    ),
  );
  const size = 8 + tfras.reduce((sum, tfra) => sum + tfra.length, 0) + 16;
  return box("mfra", ...tfras, fullBox("mfro", 0, 0, u32(size)));
}

/**
 * A segment index (sidx) for track `id`: `references` subsegments, each
 * `size` bytes and `duration` long (the track's timescale), the first
 * `firstOffset` bytes after the sidx's end. Readers that use one (FFmpeg)
 * know every fragment's place without reading the file through.
 */
export function sidx(id: number, timescale: number, firstOffset: number, references: { size: number; duration: number }[]): Uint8Array {
  return fullBox(
    "sidx", 1, 0, u32(id), u32(timescale), u64(0), u64(firstOffset), u16(0), u16(references.length),
    ...references.map((one) => concat([u32(one.size & 0x7fffffff), u32(one.duration), u32(0x90000000)])),
  );
}

/** The sample rates ADTS and AudioSpecificConfig number (their index). */
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** An AAC-LC sample entry (mp4a with its esds) for `rate` Hz, `channels`, about `bitrate` bit/s. */
export function aacEntry(rate: number, channels: number, bitrate: number): Uint8Array {
  const index = AAC_RATES.indexOf(rate);
  if (index < 0) throw new Error(`AAC has no ${rate} Hz`);
  // AudioSpecificConfig: object type 2 (LC), the rate's index, the channels.
  const config = u8((2 << 3) | (index >> 1), ((index & 1) << 7) | (channels << 3));
  const descriptor = (tag: number, ...parts: Uint8Array[]) => {
    const body = concat(parts);
    return concat([u8(tag, body.length), body]);
  };
  const esds = fullBox(
    "esds", 0, 0,
    descriptor(
      0x03, u16(AUDIO_ES_ID), u8(0),
      descriptor(0x04, u8(0x40, 0x15), u8(0, 0, 0), u32(bitrate), u32(bitrate), descriptor(0x05, config)),
      descriptor(0x06, u8(0x02)),
    ),
  );
  return box("mp4a", new Uint8Array(6), u16(1), new Uint8Array(8), u16(channels), u16(16), u16(0), u16(0), u32(rate << 16), esds);
}

const AUDIO_ES_ID = 2;

/**
 * The whole ADTS frames at the start of `data` (their payloads, headers
 * dropped) and what's left after them (a frame not all there yet).
 */
export function adtsFrames(data: Uint8Array): { frames: Uint8Array[]; rest: Uint8Array } {
  const frames: Uint8Array[] = [];
  let at = 0;
  while (at + 7 <= data.length) {
    if (data[at] !== 0xff || (data[at + 1]! & 0xf6) !== 0xf0) throw new Error(`not an ADTS frame at ${at}`);
    const header = (data[at + 1]! & 1) === 1 ? 7 : 9;
    const length = ((data[at + 3]! & 0x03) << 11) | (data[at + 4]! << 3) | (data[at + 5]! >> 5);
    if (length < header) throw new Error(`a broken ADTS frame at ${at}`);
    if (at + length > data.length) break;
    frames.push(data.slice(at + header, at + length));
    at += length;
  }
  return { frames, rest: data.slice(at) };
}
