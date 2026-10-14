import type { NetworkStats } from "./range-source";
import { DecodedCache } from "./decoded-cache";
import { AUDIO_CHUNK_SECONDS, type DecodeRequest, type DecodeResponse, type PcmChunk } from "./decoder.protocol";

const MiB = 1024 * 1024;
const frameKey = (key: string, time: number) => `${key}|v${Math.round(time * 1e6)}`;
const audioKey = (key: string, chunk: number, speed: number) => `${key}|a${chunk}@${speed}`;

/** Export selects the nearest source frame, including fractional-speed clips. */
export function videoTime(time: number, fps: number, duration: number) {
  const rate = fps > 0 ? fps : 30;
  return Math.max(0, Math.min((Math.floor(time * rate + 0.5 + 1e-7) + 0.01) / rate, Math.max(0, duration - 1e-6)));
}

interface Flight { id: number; key: string; values: Set<string> }

/** Two workers keep video and audio independent. The UI only owns bounded decoded caches. */
export class Decoder {
  private video: Worker | null = null;
  private audio: Worker | null = null;
  private files = new Set<string>();
  private flights = new Map<string, Flight>();
  private serial = 0;
  private generation = 0;
  private images = new Map<string, Promise<void>>();
  private pictureSizes = new Map<string, number>();
  readonly pictures = new DecodedCache<VideoFrame>(128 * MiB, (frame) => frame.close());
  readonly sound = new DecodedCache<PcmChunk>(32 * MiB, () => {});
  readonly stats = { videoRequests: 0, audioRequests: 0, decodedFrames: 0, cacheHits: 0 };
  /** Each worker's media reads so far (bytes, time waiting), for problem reports. */
  readonly network: Partial<Record<"video" | "audio", NetworkStats>> = {};

  constructor(private changed: () => void, private failed: (error: string) => void) {}

  private worker(kind: "video" | "audio") {
    let worker = this[kind];
    if (!worker) {
      try {
        worker = new Worker(new URL("./decode.worker.ts", import.meta.url), { type: "module", name: `edit-${kind}-decoder` });
      } catch (error) {
        this.failed(`Could not start the ${kind} decoder worker: ${error}`);
        return null;
      }
      const generation = this.generation;
      worker.onmessage = ({ data }: MessageEvent<DecodeResponse>) => {
        if (data.type === "done" && data.network) this.network[kind] = data.network;
        if (generation === this.generation) this.receive(data);
        else if (data.type === "video") data.frame.close();
      };
      worker.onerror = (event) => { if (generation === this.generation) this.failed(`The ${kind} decoder worker failed: ${event.message}`); };
      worker.onmessageerror = () => { if (generation === this.generation) this.failed(`The ${kind} decoder could not transfer a decoded sample`); };
      this[kind] = worker;
    }
    return worker;
  }

  private receive(data: DecodeResponse) {
    if (data.type === "video") {
      if (!this.files.has(data.key)) { data.frame.close(); return; }
      let bytes: number;
      try { bytes = data.frame.allocationSize(); } catch { bytes = data.frame.codedWidth * data.frame.codedHeight * 4; }
      this.pictures.set(frameKey(data.key, data.time), data.frame, bytes);
      this.pictureSizes.set(data.key, bytes);
      this.stats.decodedFrames++;
      this.changed();
    } else if (data.type === "audio") {
      if (!this.files.has(data.key)) return;
      this.sound.set(audioKey(data.key, data.chunk, data.speed), data.pcm, data.pcm.channels.reduce((sum, c) => sum + c.byteLength, 0));
      this.changed();
    } else if (data.type === "done") {
      if (this.flights.get(data.lane)?.id === data.id) this.flights.delete(data.lane);
      this.changed();
    } else if (this.files.has(data.key)) {
      this.failed(data.error);
    }
  }

  picture(key: string, time: number): VideoFrame | undefined {
    const frame = this.pictures.get(frameKey(key, time));
    if (frame) this.stats.cacheHits++;
    return frame;
  }

  nearbyPicture(key: string, time: number, distance: number, from: number, to: number) {
    const prefix = `${key}|v`;
    let best: string | undefined;
    let gap = distance;
    for (const cached of this.pictures.keys()) {
      if (!cached.startsWith(prefix)) continue;
      const at = Number(cached.slice(prefix.length)) / 1e6;
      const delta = Math.abs(at - time);
      if (at >= from && at <= to && delta <= gap) { gap = delta; best = cached; }
    }
    return best ? this.pictures.get(best) : undefined;
  }

  pcm(key: string, chunk: number, speed = 1) { return this.sound.get(audioKey(key, chunk, speed)); }

  requestImage(key: string, url: string) {
    if (this.pictures.has(frameKey(key, 0)) || this.images.has(key)) return;
    this.files.add(key);
    const generation = this.generation;
    const loading = (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Image: HTTP ${response.status}`);
      const bitmap = await createImageBitmap(await response.blob());
      try {
        if (generation !== this.generation || !this.files.has(key)) return;
        const frame = new VideoFrame(bitmap, { timestamp: 0 });
        this.pictures.set(frameKey(key, 0), frame, frame.codedWidth * frame.codedHeight * 4);
        this.changed();
      } finally { bitmap.close(); }
    })().catch((error) => { if (generation === this.generation && this.files.has(key)) this.failed(String(error)); })
      .finally(() => { if (this.images.get(key) === loading) this.images.delete(key); });
    this.images.set(key, loading);
  }

  requestVideo(key: string, url: string, lane: string, time: number, fps: number, duration: number, direction = 1, playing = false, step = 1 / fps) {
    const wanted = frameKey(key, videoTime(time, fps, duration));
    const active = this.flights.get(lane);
    if (active?.key === key && active.values.has(wanted)) return;
    const simultaneous = Math.max(1, [...this.flights.keys()].filter((lane) => lane.startsWith("v:")).length);
    const bytes = this.pictureSizes.get(key) ?? 1920 * 1080 * 4;
    const batch = playing ? Math.max(1, Math.min(24, Math.floor(this.pictures.budget / bytes / simultaneous / 2))) : 1;
    const spacing = Math.max(1 / fps, step);
    let ahead = 0;
    for (let i = 0; i < batch; i++) {
      if (!this.pictures.has(frameKey(key, videoTime(time + i * direction * spacing, fps, duration)))) break;
      ahead++;
    }
    // Refill in batches instead of opening a new codec for every displayed frame.
    if (ahead >= Math.max(1, Math.floor(batch / 3))) return;
    const times: number[] = [];
    for (let i = 0; i < batch; i++) {
      const next = videoTime(time + i * direction * spacing, fps, duration);
      if (!this.pictures.has(frameKey(key, next)) && !times.includes(next)) times.push(next);
    }
    if (!times.length) return;
    // A flight already warming these samples should be allowed to finish.
    if (active?.key === key && times.every((t) => active.values.has(frameKey(key, t)))) return;
    const id = ++this.serial;
    this.files.add(key);
    this.flights.set(lane, { id, key, values: new Set(times.map((t) => frameKey(key, t))) });
    this.stats.videoRequests++;
    this.worker("video")?.postMessage({ type: "video", id, key, url, lane, times, playing } satisfies DecodeRequest);
  }

  requestAudio(key: string, url: string, lane: string, time: number, duration: number, speed = 1) {
    const first = Math.max(0, Math.floor(time / AUDIO_CHUNK_SECONDS));
    const active = this.flights.get(lane);
    if (active?.key === key && active.values.has(audioKey(key, first, speed))) return;
    const chunks: number[] = [];
    const ahead = Math.max(8, Math.min(64, Math.ceil(3 * speed / AUDIO_CHUNK_SECONDS) + 1));
    let buffered = 0;
    while (buffered < ahead && this.sound.has(audioKey(key, first + buffered, speed))) buffered++;
    if (buffered * AUDIO_CHUNK_SECONDS >= 1.5 * speed) return;
    for (let chunk = first; chunk < first + ahead && chunk * AUDIO_CHUNK_SECONDS < duration; chunk++) {
      if (!this.sound.has(audioKey(key, chunk, speed))) chunks.push(chunk);
    }
    if (!chunks.length || (active?.key === key && chunks.every((chunk) => active.values.has(audioKey(key, chunk, speed))))) return;
    const id = ++this.serial;
    this.files.add(key);
    this.flights.set(lane, { id, key, values: new Set(chunks.map((chunk) => audioKey(key, chunk, speed))) });
    this.stats.audioRequests++;
    this.worker("audio")?.postMessage({ type: "audio", id, key, url, lane, chunks, speed } satisfies DecodeRequest);
  }

  retain(lanes: Set<string>) {
    for (const key of this.flights.keys()) if (!lanes.has(key)) this.flights.delete(key);
    const message: DecodeRequest = { type: "retain", lanes: [...lanes] };
    this.video?.postMessage(message);
    this.audio?.postMessage(message);
  }

  forget(key: string) {
    this.files.delete(key);
    this.pictureSizes.delete(key);
    this.images.delete(key);
    this.pictures.deletePrefix(`${key}|`);
    this.sound.deletePrefix(`${key}|`);
    for (const [lane, flight] of this.flights) if (flight.key === key) this.flights.delete(lane);
    const message: DecodeRequest = { type: "forget", key };
    this.video?.postMessage(message);
    this.audio?.postMessage(message);
  }

  dispose() {
    this.generation++;
    this.video?.terminate(); this.audio?.terminate();
    this.video = null; this.audio = null;
    this.files.clear(); this.flights.clear();
    this.pictureSizes.clear();
    this.images.clear();
    this.pictures.clear(); this.sound.clear();
  }
}
