import { ALL_FORMATS, AudioSampleSink, Input, UrlSource, VideoSampleSink } from "mediabunny";
import { stretchAudio } from "./audio-stretch";
import { AUDIO_CHUNK_SECONDS, type DecodeJob, type DecodeRequest, type DecodeResponse, type PcmChunk } from "./decoder.protocol";

// No DOM or audio context in this worker. Only demux, decode and transferable resources.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<DecodeRequest>) => void) | null;
  postMessage(message: DecodeResponse, transfer?: Transferable[]): void;
};
interface File {
  input: Input;
  video?: Promise<{ sink: VideoSampleSink; first: number }>;
  audio?: Promise<AudioSampleSink>;
  users: number;
}
interface Lane { latest: DecodeJob | null; running: DecodeJob | null; cancelled: boolean }
const files = new Map<string, File>();
const lanes = new Map<string, Lane>();
let running = 0;

function trimFiles() {
  for (const [key, file] of files) {
    if (files.size <= 4) break;
    if (file.users) continue;
    file.input.dispose();
    files.delete(key);
  }
}

function open(job: DecodeJob) {
  let file = files.get(job.key);
  if (!file) {
    file = {
      input: new Input({ formats: ALL_FORMATS, source: new UrlSource(job.url, {
        maxCacheSize: 8 * 1024 * 1024,
        parallelism: 2,
        getRetryDelay: (attempt) => attempt < 8 ? Math.min(2, 0.25 * 2 ** attempt) : null,
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
    return { sink: new VideoSampleSink(track, { optimizeForLatency: true }), first: await track.getFirstTimestamp() };
  })();
}

async function audioSink(file: File) {
  return file.audio ??= (async () => {
    const track = await file.input.getPrimaryAudioTrack();
    if (!track || !await track.canDecode()) throw new Error("This audio codec cannot be decoded by this browser. Wait for its AAC proxy.");
    return new AudioSampleSink(track);
  })();
}

async function decodeVideo(job: Extract<DecodeJob, { type: "video" }>, file: File, lane: Lane) {
  const { sink, first } = await videoSink(file);
  let i = 0;
  for await (const sample of sink.samplesAtTimestamps(job.times.map((time) => Math.max(first, time)))) {
    // Finish the first requested picture even if the cursor moved while decoding it:
    // the preview can display that complete scene instead of starving during a drag.
    if (lane.cancelled || (i > 0 && lane.latest)) { sample?.close(); break; }
    const time = job.times[i++];
    if (!sample) throw new Error("No video frame at the requested source time");
    try {
      const frame = sample.toVideoFrame();
      scope.postMessage({ type: "video", id: job.id, key: job.key, time, frame }, [frame]);
    } finally { sample.close(); }
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
  lane.latest = null;
  let file: File | undefined;
  try {
    file = open(job);
    if (job.type === "video") await decodeVideo(job, file, lane);
    else await decodeAudio(job, file, lane);
  } catch (error) {
    if (!lane.cancelled) scope.postMessage({ type: "error", id: job.id, key: job.key, lane: job.lane, error: String(error) });
  } finally {
    if (file) file.users--;
    running--;
    lane.running = null;
    scope.postMessage({ type: "done", id: job.id, lane: job.lane });
    if (!lane.latest && lanes.get(job.lane) === lane) lanes.delete(job.lane);
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

scope.onmessage = ({ data }) => {
  if (data.type === "forget") {
    for (const [key, lane] of lanes) if (lane.running?.key === data.key || lane.latest?.key === data.key) {
      lane.cancelled = true; lane.latest = null; lanes.delete(key);
    }
    files.get(data.key)?.input.dispose();
    files.delete(data.key);
  } else if (data.type === "retain") {
    const keep = new Set(data.lanes);
    for (const [key, lane] of lanes) if (!keep.has(key)) {
      lane.cancelled = true; lane.latest = null; lanes.delete(key);
    }
  } else {
    const lane = lanes.get(data.lane) ?? { latest: null, running: null, cancelled: false };
    lane.latest = data;
    lanes.set(data.lane, lane);
  }
  pump();
};
