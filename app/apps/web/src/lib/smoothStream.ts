// Smooth playback a chunk at a time (off Modal, step 4f): the render's
// chunks (apps/server/src/playback_stream.ts) appended to a MediaSource as
// each is made, the playhead's first, then on from there, so the viewer plays
// smoothly from the first chunk rather than the whole file; its sound from the
// render's own mix in an <audio> element kept with the picture.
//
// Only a stretch around the playhead is kept in the MediaSource (`BEHIND` and
// `AHEAD` seconds): a 40-minute edit's whole render is past what a browser
// lets a page buffer. Where nothing is appended, `covers` says so and the
// viewer draws live, as it did without a render.
//
// The rest of the render is kept on disk instead (Sphe, Nov 12, the progress
// bar's grey "keeps stopping at a certain buffer"): once what's near the
// playhead is in, every ready chunk is fetched in the background, one at a
// time, into the browser's Cache Storage, where a seek or a play reads it
// without the network. A chunk is named by its content, so one the edit
// didn't change is fetched once; this project's chunks the render no longer
// has are let go. What's stored is what the progress bar shows as loaded.

import { mediaHost, request } from "./api";

export interface StreamSegment { start: number; end: number; key: string; ready: boolean }
export interface StreamInfo { segments: StreamSegment[]; codec: string | null; sound: "ready" | "pending" | "none"; soundUrl: string | null }

/** Seconds behind and ahead of the playhead kept appended. */
const BEHIND = 20;
const AHEAD = 120;
/** The browser's store for the render's chunks (Cache Storage, on disk). */
const STORE = "edit-smooth-chunks";
/** How often the render is asked what's ready while chunks are still to come (ms). */
const POLL_MS = 1500;
/** The sound is put back in step past this much (s). */
const DRIFT = 0.08;
/** Past this much (s) the sound is too far out to drift back: it is moved, once. */
const SEEK = 0.5;

/**
 * How the render's sound is kept with its picture, from how far out it is
 * (sound time − picture time, s): a small drift is played out at a slightly
 * off rate until it lands — a hard move on every drift past `DRIFT` was
 * heard as bumps laid over the sound, the seek restarting the element's
 * buffering again and again while it streamed. Only a big drift seeks.
 */
export function soundSync(drift: number): { seek: boolean; rate: number } {
  if (Math.abs(drift) > SEEK) return { seek: true, rate: 1 };
  if (Math.abs(drift) < DRIFT / 2) return { seek: false, rate: 1 };
  return { seek: false, rate: drift < 0 ? 1.06 : 0.94 };
}

/**
 * How far into a chunk's own time its first picture sits (s), from where an
 * append at `at` landed in `ranges`. An encoder that reorders frames (a Mac's:
 * two) writes each chunk's pictures that many frames in, and a MediaSource
 * takes those times as they are (a file's edit list, which says "start at the
 * first picture", isn't read): appended at the chunk's own start, every
 * picture showed two frames late. Nov 10, measured on the acceptance edit:
 * the cut at frame 90 showed at 92, the sound 67 ms ahead of the picture, and
 * the edit's last frames never drew.
 */
export function leadOf(ranges: [number, number][], at: number): number {
  const landed = ranges.map(([start]) => start - at).filter((lead) => lead > -0.001 && lead < 0.5);
  return landed.length === 0 ? 0 : Math.max(0, Math.min(...landed));
}

export class SmoothStream {
  readonly url: string;
  private media = new MediaSource();
  private buffer: SourceBuffer | null = null;
  /** What's appended: each chunk's first frame → its key. */
  private appended = new Map<number, string>();
  private info: StreamInfo | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private working = false;
  private closed = false;
  private soundSource: string | null = null;
  /** `leadOf` for this render's chunks, measured at the first append (null until then): each is appended that much early. */
  private lead: number | null = null;
  /** The chunks kept on disk (their keys), and whether the background fetch runs. */
  private stored = new Set<string>();
  private stocking = false;

  constructor(
    private project: string,
    /** The revision this render shows: the server answers only with its chunks. */
    private rev: number,
    private fps: number,
    private frames: number,
    /** The playhead's frame now. */
    private at: () => number,
    readonly sound: HTMLAudioElement,
    /** A chunk was appended: the viewer shows the render where it now can. */
    private changed: () => void = () => {},
  ) {
    this.url = URL.createObjectURL(this.media);
    this.media.addEventListener("sourceopen", () => void this.pump(), { once: true });
  }

  /** Whether frames `frame` to `frame + ahead` are appended, so the video can show them. */
  covers(frame: number, ahead = 0): boolean {
    const segments = this.info?.segments ?? [];
    let at = Math.floor(frame);
    const until = Math.min(this.frames - 1, at + ahead);
    while (at <= until) {
      const holding = segments.find((one) => one.start <= at && at < one.end);
      if (holding === undefined || this.appended.get(holding.start) !== holding.key) return false;
      at = holding.end;
    }
    return true;
  }

  /** Whether the render has frames `frame` to `frame + ahead` made (here or on the server): worth waiting for, not drawing live. */
  made(frame: number, ahead = 0): boolean {
    const segments = this.info?.segments ?? [];
    let at = Math.floor(frame);
    const until = Math.min(this.frames - 1, at + ahead);
    while (at <= until) {
      const holding = segments.find((one) => one.start <= at && at < one.end);
      if (holding === undefined || !holding.ready) return false;
      at = holding.end;
    }
    return true;
  }

  /** The stretches (frames) that play without waiting: appended, or kept on disk. */
  loaded(): [number, number][] {
    const out: [number, number][] = [];
    for (const one of this.info?.segments ?? []) {
      if (this.appended.get(one.start) !== one.key && !this.stored.has(one.key)) continue;
      const last = out.at(-1);
      if (last !== undefined && last[1] === one.start) last[1] = one.end;
      else out.push([one.start, one.end]);
    }
    return out;
  }

  /** Keeps the sound with the picture at `time` (s), playing (at `speed`, the picture's) or not. */
  follow(time: number, playing: boolean, speed = 1) {
    const url = this.info?.soundUrl ?? null;
    if (url !== this.soundSource) {
      this.soundSource = url;
      if (url === null) this.sound.removeAttribute("src");
      else this.sound.src = mediaHost(url);
    }
    if (url === null) return;
    const sync = soundSync(this.sound.currentTime - time);
    if (sync.seek) {
      // One move, and not another while that one is still landing.
      if (!this.sound.seeking) this.sound.currentTime = time;
      this.sound.playbackRate = playing ? speed : 1;
    } else {
      this.sound.playbackRate = playing ? sync.rate * speed : 1;
    }
    if (playing && this.sound.paused) void this.sound.play().catch(() => {});
    if (!playing && !this.sound.paused) this.sound.pause();
  }

  /** The playhead moved: what's near it is fetched first. */
  poke() {
    if (!this.working) void this.pump();
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.sound.pause();
    this.sound.removeAttribute("src");
    URL.revokeObjectURL(this.url);
  }

  private async pump() {
    if (this.closed || this.working) return;
    this.working = true;
    clearTimeout(this.timer);
    try {
      this.info = await request<StreamInfo>("GET", `/api/projects/${encodeURIComponent(this.project)}/playback/stream?rev=${this.rev}`);
      if (this.closed) return;
      if (this.buffer === null && this.info.codec !== null && this.media.readyState === "open") {
        this.buffer = this.media.addSourceBuffer(`video/mp4; codecs="${this.info.codec}"`);
        this.buffer.mode = "segments";
        this.media.duration = this.frames / this.fps;
      }
      const buffer = this.buffer;
      if (buffer !== null) {
        // The chunk at the playhead first; what's far from it is let go after (letting go first held a seek up by seconds).
        for (let next = this.next(); next !== null && !this.closed; next = this.next()) {
          const bytes = await this.chunk(next.key);
          if (bytes === null) break;
          if (this.closed) return;
          const at = next.start / this.fps;
          const append = async () => {
            buffer.timestampOffset = at - (this.lead ?? 0);
            try {
              await this.wait(buffer, () => buffer.appendBuffer(bytes));
            } catch (error) {
              // Full: what's far goes, then it's tried once more.
              if (!(error instanceof DOMException && error.name === "QuotaExceededError")) throw error;
              await this.trim(buffer);
              await this.wait(buffer, () => buffer.appendBuffer(bytes));
            }
          };
          await append();
          if (this.lead === null) {
            // The first chunk in says where a chunk's pictures land: put where they belong, as every chunk after is.
            const ranges: [number, number][] = [];
            for (let index = 0; index < buffer.buffered.length; index++) ranges.push([buffer.buffered.start(index), buffer.buffered.end(index)]);
            this.lead = leadOf(ranges, at);
            if (this.lead > 0.25 / this.fps) {
              await this.wait(buffer, () => buffer.remove(0, Number.POSITIVE_INFINITY));
              await append();
            }
          }
          this.appended.set(next.start, next.key);
          this.changed();
        }
        await this.trim(buffer);
        // Everything made and the edit's end appended: said, so the decoder gives up the last frames it holds back
        // for reordering (the end of the edit never drew) and playing to the end ends instead of waiting for more.
        // A chunk appended later opens it again.
        const last = this.info.segments.at(-1);
        if (last !== undefined && this.info.segments.every((one) => one.ready) && this.appended.get(last.start) === last.key && this.media.readyState === "open" && !buffer.updating) {
          this.media.endOfStream();
        }
      }
    } catch {
      // A missed look: the next one tries again.
    } finally {
      this.working = false;
    }
    if (!this.closed && this.next() === null) void this.stock();
    const pending = this.info === null || this.info.segments.some((one) => !one.ready) || this.info.sound === "pending" || this.next() !== null;
    if (!this.closed) this.timer = setTimeout(() => void this.pump(), pending ? POLL_MS : POLL_MS * 4);
  }

  private chunkUrl(key: string): string {
    return mediaHost(`/api/projects/${encodeURIComponent(this.project)}/playback/segment/${key}`);
  }

  /** A chunk's bytes: from disk when it's kept there, else fetched (and kept). Null when the server hasn't it. */
  private async chunk(key: string): Promise<ArrayBuffer | null> {
    const url = this.chunkUrl(key);
    const store = await openStore();
    const kept = await store?.match(url).catch(() => undefined);
    if (kept !== undefined) return await kept.arrayBuffer();
    const answer = await fetch(url);
    if (!answer.ok) return null;
    if (store !== null) {
      await store.put(url, answer.clone()).then(() => this.stored.add(key), () => {});
    }
    return await answer.arrayBuffer();
  }

  /**
   * Fetches every ready chunk not yet on disk, from the playhead on and then
   * the start, one at a time while nothing nearer is wanted; then lets go of
   * this project's chunks the render no longer has.
   */
  private async stock() {
    if (this.stocking) return;
    const store = await openStore();
    if (store === null) return;
    this.stocking = true;
    try {
      const prefix = this.chunkUrl("");
      const keys = (await store.keys()).map((one) => one.url).filter((url) => url.startsWith(prefix));
      for (const url of keys) this.stored.add(url.slice(prefix.length));
      this.changed();
      for (;;) {
        if (this.closed || this.next() !== null) return;
        const here = this.at();
        const segments = this.info?.segments ?? [];
        const missing = segments.filter((one) => one.ready && !this.stored.has(one.key)).sort((a, b) => (a.end > here ? 0 : 1) - (b.end > here ? 0 : 1) || a.start - b.start);
        const want = missing[0];
        if (want === undefined) break;
        const answer = await fetch(this.chunkUrl(want.key)).catch(() => null);
        if (answer === null || !answer.ok) return;
        await store.put(this.chunkUrl(want.key), answer);
        this.stored.add(want.key);
        this.changed();
      }
      // This project's chunks the render no longer has: gone from disk.
      const current = new Set((this.info?.segments ?? []).map((one) => one.key));
      if (this.info?.segments.every((one) => one.ready) === true) {
        for (const url of keys) {
          const key = url.slice(prefix.length);
          if (current.has(key)) continue;
          await store.delete(url);
          this.stored.delete(key);
        }
      }
    } catch {
      // Out of room or the network went: what's kept is still used; the next look carries on.
    } finally {
      this.stocking = false;
    }
  }

  /** The ready chunk to append next: the one at the playhead and on, then those before, within what's kept. */
  private next(): StreamSegment | null {
    const segments = this.info?.segments ?? [];
    const here = this.at();
    const near = (one: StreamSegment) => one.end > here - BEHIND * this.fps && one.start < here + AHEAD * this.fps;
    const wanted = segments.filter((one) => one.ready && near(one) && this.appended.get(one.start) !== one.key);
    wanted.sort((a, b) => {
      const order = (one: StreamSegment) => (one.end > here ? [0, one.start] : [1, -one.start]);
      const [ka, va] = order(a);
      const [kb, vb] = order(b);
      return ka - kb || va - vb;
    });
    return wanted[0] ?? null;
  }

  /** Lets go of what's far from the playhead, and of chunks the render has since changed (runs of them removed at once). */
  private async trim(buffer: SourceBuffer) {
    const here = this.at();
    const segments = this.info?.segments ?? [];
    const gone: [number, number][] = [];
    for (const [start, key] of [...this.appended].sort((a, b) => a[0] - b[0])) {
      const now = segments.find((one) => one.start === start);
      const end = now?.end ?? start + 1;
      const far = end < here - BEHIND * this.fps || start > here + AHEAD * this.fps;
      if (!far && now?.key === key) continue;
      this.appended.delete(start);
      const last = gone.at(-1);
      if (last !== undefined && last[1] === start) last[1] = end;
      else gone.push([start, end]);
    }
    for (const [start, end] of gone) await this.wait(buffer, () => buffer.remove(start / this.fps, end / this.fps));
  }

  private wait(buffer: SourceBuffer, act: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => { buffer.removeEventListener("updateend", done); buffer.removeEventListener("error", failed); resolve(); };
      const failed = () => { buffer.removeEventListener("updateend", done); buffer.removeEventListener("error", failed); reject(new Error("the chunk wouldn't append")); };
      buffer.addEventListener("updateend", done);
      buffer.addEventListener("error", failed);
      try {
        act();
      } catch (error) {
        buffer.removeEventListener("updateend", done);
        buffer.removeEventListener("error", failed);
        reject(error);
      }
    });
  }
}

/** The chunks' store on disk, or null where the browser has none (a page not served securely). */
function openStore(): Promise<Cache | null> {
  if (typeof caches === "undefined") return Promise.resolve(null);
  return caches.open(STORE).catch(() => null);
}
