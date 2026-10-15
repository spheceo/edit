import { ALL_FORMATS, AudioSampleSink, EncodedPacketSink, Input, StreamSource, VideoSampleSink, type VideoSample } from "mediabunny";
import { stretchAudio } from "./audio-stretch";
import { forgetBlocks, network, rangeReader, setStreaming } from "./range-source";
import { AUDIO_CHUNK_SECONDS, type DecodeJob, type DecodeRequest, type DecodeResponse, type PcmChunk } from "./decoder.protocol";

// No DOM or audio context in this worker. Only demux, decode and transferable resources.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<DecodeRequest>) => void) | null;
  postMessage(message: DecodeResponse, transfer?: Transferable[]): void;
};
interface File {
  input: Input;
  video?: Promise<{ sink: VideoSampleSink; packets: EncodedPacketSink; first: number }>;
  audio?: Promise<AudioSampleSink>;
  users: number;
}
/**
 * During playback one decoder per lane stays open between jobs, so each batch
 * continues where the last picture left off instead of reopening the codec and
 * decoding again from a keyframe. Scrubs near it reuse it too.
 */
interface Cursor {
  key: string;
  file: File;
  samples: AsyncGenerator<VideoSample, void, unknown>;
  /** The most recent decoded picture, which may cover several requested times. */
  held: VideoSample | null;
  start: number;
  ended: boolean;
}
interface Lane { latest: DecodeJob | null; running: DecodeJob | null; cancelled: boolean; cursor: Cursor | null }
/** Decoding forward this far is cheaper than reopening at the preceding keyframe. */
const CONTINUE_SECONDS = 1;
const EPSILON = 1e-6;
/** Open files kept. Cheap to keep (their bytes live in the shared block cache);
 * reopening one costs parsing its index again. */
const OPEN_FILES = 16;
const files = new Map<string, File>();
const lanes = new Map<string, Lane>();
let running = 0;

function trimFiles() {
  for (const [key, file] of files) {
    if (files.size <= OPEN_FILES) break;
    if (file.users) continue;
    file.input.dispose();
    files.delete(key);
  }
}

function open(job: DecodeJob) {
  let file = files.get(job.key);
  if (!file) {
    file = {
      input: new Input({ formats: ALL_FORMATS, source: new StreamSource({
        ...rangeReader(job.url),
        // Exact reads: the block layer aligns them and reads ahead only when access is sequential.
        prefetchProfile: "none",
        handleUnhandledError: () => {}, // A subsequent read reports the failure to the preview.
      }) }),
      users: 0,
    };
  }
  files.delete(job.key);
  files.set(job.key, file);
  file.users++;
  trimFiles();
  return file;
}

async function videoSink(file: File) {
  return file.video ??= (async () => {
    const track = await file.input.getPrimaryVideoTrack();
    if (!track || !await track.canDecode()) throw new Error("This video codec cannot be decoded by this browser. Wait for its H.264 proxy.");
    return { sink: new VideoSampleSink(track, { optimizeForLatency: true }), packets: new EncodedPacketSink(track), first: await track.getFirstTimestamp() };
  })();
}

async function audioSink(file: File) {
  return file.audio ??= (async () => {
    const track = await file.input.getPrimaryAudioTrack();
    if (!track || !await track.canDecode()) throw new Error("This audio codec cannot be decoded by this browser. Wait for its AAC proxy.");
    return new AudioSampleSink(track);
  })();
}

function closeCursor(lane: Lane) {
  const cursor = lane.cursor;
  if (!cursor) return;
  lane.cursor = null;
  cursor.held?.close();
  void cursor.samples.return(undefined).catch(() => {});
  cursor.file.users--;
}

/** The decoded picture shown at `time`: the last frame starting at or before it. */
async function pictureAt(cursor: Cursor, time: number) {
  for (;;) {
    const held = cursor.held;
    if (held && (held.timestamp > time + EPSILON || time < held.timestamp + held.duration - EPSILON)) return held;
    if (cursor.ended) return held;
    const next = await cursor.samples.next();
    if (next.done) { cursor.ended = true; continue; }
    held?.close();
    cursor.held = next.value;
  }
}

async function decodeVideo(job: Extract<DecodeJob, { type: "video" }>, file: File, lane: Lane) {
  const { sink, packets, first } = await videoSink(file);
  for (const [i, requested] of job.times.entries()) {
    // Finish the first requested picture even if the cursor moved while decoding it:
    // the preview can display that complete scene instead of starving during a drag.
    if (lane.cancelled || (i > 0 && lane.latest)) break;
    const time = Math.max(first, requested);
    const cursor = lane.cursor;
    const at = cursor?.held?.timestamp ?? cursor?.start ?? 0;
    const continues = cursor?.key === job.key && time >= at - EPSILON && time - at <= CONTINUE_SECONDS;
    let frame: VideoFrame;
    if (continues) {
      const sample = await pictureAt(cursor, time);
      if (lane.cancelled) break;
      if (!sample) throw new Error("No video frame at the requested source time");
      frame = sample.toVideoFrame();
    } else if (job.playing) {
      // Playback reads on from here until the lane is released.
      closeCursor(lane);
      file.users++;
      lane.cursor = { key: job.key, file, samples: sink.samples(time), held: null, start: time, ended: false };
      const sample = await pictureAt(lane.cursor, time);
      if (lane.cancelled) break;
      if (!sample) throw new Error("No video frame at the requested source time");
      frame = sample.toVideoFrame();
    } else if (job.rough) {
      // Mid-drag, the keyframe at or before the time stands in: one packet to
      // fetch and decode instead of a run of them. The exact frame follows once
      // the playhead rests.
      const key = await packets.getKeyPacket(time, { metadataOnly: true });
      const at = Math.max(first, key?.timestamp ?? time);
      const sample = await sink.getSample(at);
      if (!sample) throw new Error("No video frame at the requested source time");
      try {
        if (lane.cancelled) break;
        frame = sample.toVideoFrame();
        scope.postMessage({ type: "video", id: job.id, key: job.key, time: sample.timestamp, frame, rough: true }, [frame]);
      } finally { sample.close(); }
      continue;
    } else {
      // An open decoder reads dozens of packets ahead. A scrub decodes from the
      // keyframe to exactly its picture, so a drag doesn't download what it skips.
      let sample: VideoSample | null = null;
      for await (const decoded of sink.samplesAtTimestamps([time])) sample = decoded;
      if (!sample) throw new Error("No video frame at the requested source time");
      try {
        if (lane.cancelled) break;
        frame = sample.toVideoFrame();
      } finally { sample.close(); }
    }
    scope.postMessage({ type: "video", id: job.id, key: job.key, time: requested, frame }, [frame]);
  }
}

async function decodeAudio(job: Extract<DecodeJob, { type: "audio" }>, file: File, lane: Lane) {
  const sink = await audioSink(file);
  // AAC needs preceding packets to reconstruct its overlap window. One decoder
  // stays alive across the whole batch; chunk boundaries are storage boundaries.
  const context = 0.15;
  const buffers = job.chunks.map((chunk) => ({ chunk, start: chunk * AUDIO_CHUNK_SECONDS,
    readStart: Math.max(0, chunk * AUDIO_CHUNK_SECONDS - context),
    readEnd: (chunk + 1) * AUDIO_CHUNK_SECONDS + context, pcm: null as PcmChunk | null }));
  if (!buffers.length) return;
  let next = 0;
  const emit = (buffer: typeof buffers[number]) => {
    const pcm = buffer.pcm;
    if (!pcm) throw new Error("No audio samples at the requested source time");
    const channels = stretchAudio(pcm.channels, pcm.sampleRate, job.speed);
    const from = Math.round((buffer.start - buffer.readStart) / job.speed * pcm.sampleRate);
    const count = Math.round(AUDIO_CHUNK_SECONDS / job.speed * pcm.sampleRate);
    pcm.channels = channels.map((channel) => channel.slice(from, from + count));
    scope.postMessage({ type: "audio", id: job.id, key: job.key, chunk: buffer.chunk, speed: job.speed, pcm }, pcm.channels.map((c) => c.buffer));
    buffer.pcm = null;
  };
  for await (const sample of sink.samples(buffers[0].readStart, buffers.at(-1)!.readEnd)) {
    try {
      if (lane.cancelled) break;
      const sampleEnd = sample.timestamp + sample.duration;
      for (let i = next; i < buffers.length; i++) {
        const buffer = buffers[i];
        if (buffer.readStart >= sampleEnd) break;
        if (buffer.readEnd <= sample.timestamp) continue;
        const pcm = buffer.pcm ??= { start: buffer.start, sampleRate: sample.sampleRate,
          channels: Array.from({ length: sample.numberOfChannels },
            () => new Float32Array(Math.round((buffer.readEnd - buffer.readStart) * sample.sampleRate))) };
        const offset = Math.round((sample.timestamp - buffer.readStart) * pcm.sampleRate);
        const from = Math.max(0, -offset);
        const count = Math.min(sample.numberOfFrames - from, pcm.channels[0].length - Math.max(0, offset));
        if (count <= 0) continue;
        for (let channel = 0; channel < pcm.channels.length; channel++) {
          sample.copyTo(pcm.channels[channel].subarray(Math.max(0, offset), Math.max(0, offset) + count),
            { planeIndex: channel, format: "f32-planar", frameOffset: from, frameCount: count });
        }
      }
      while (next < buffers.length && sampleEnd >= buffers[next].readEnd - 0.5 / sample.sampleRate) emit(buffers[next++]);
      if (lane.latest && next > 0) break;
    } finally { sample.close(); }
  }
  // The file can end inside the final storage chunk; its remainder is silence.
  if (!lane.cancelled && !lane.latest) while (next < buffers.length) emit(buffers[next++]);
}

async function run(job: DecodeJob, lane: Lane) {
  running++;
  lane.running = job;
  // Playback reads on sequentially (worth reading ahead); a scrub only reads what it asks for.
  setStreaming(job.type === "audio" || job.playing);
  lane.latest = null;
  let file: File | undefined;
  try {
    file = open(job);
    if (job.type === "video") await decodeVideo(job, file, lane);
    else await decodeAudio(job, file, lane);
  } catch (error) {
    // A failed decoder can't be trusted for the next request on this lane.
    closeCursor(lane);
    if (!lane.cancelled) scope.postMessage({ type: "error", id: job.id, key: job.key, lane: job.lane, error: String(error) });
  } finally {
    if (file) file.users--;
    running--;
    lane.running = null;
    if (lane.cancelled) closeCursor(lane);
    scope.postMessage({ type: "done", id: job.id, lane: job.lane, network: { ...network } });
    // Idle audio lanes hold nothing; video lanes keep their decoder until released.
    if (!lane.latest && !lane.cursor && lanes.get(job.lane) === lane) lanes.delete(job.lane);
    trimFiles();
    pump();
  }
}

function pump() {
  for (const lane of lanes.values()) {
    if (running >= 2) break;
    if (!lane.running && lane.latest && !lane.cancelled) void run(lane.latest, lane);
  }
}

function release(name: string, lane: Lane) {
  lane.cancelled = true;
  lane.latest = null;
  lanes.delete(name);
  // A running job closes its own cursor when it notices the cancellation.
  if (!lane.running) closeCursor(lane);
}

scope.onmessage = ({ data }) => {
  if (data.type === "forget") {
    for (const [name, lane] of lanes) {
      if (lane.running?.key === data.key || lane.latest?.key === data.key || lane.cursor?.key === data.key) release(name, lane);
    }
    files.get(data.key)?.input.dispose();
    files.delete(data.key);
    forgetBlocks(data.key);
  } else if (data.type === "retain") {
    const keep = new Set(data.lanes);
    for (const [name, lane] of lanes) if (!keep.has(name)) release(name, lane);
    trimFiles();
  } else {
    const lane = lanes.get(data.lane) ?? { latest: null, running: null, cancelled: false, cursor: null };
    lane.latest = data;
    lanes.set(data.lane, lane);
  }
  pump();
};
