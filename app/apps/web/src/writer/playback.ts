import { useSyncExternalStore } from "react";
import { isCutIn } from "./clips";
import { Decoder, videoTime } from "../lib/decoder";
import { AUDIO_CHUNK_SECONDS } from "../lib/decoder.protocol";
import type { Clip } from "./types";

/**
 * Where the preview's playhead is, held outside React state as Repack holds
 * it: the player reports every frame, and only what shows the playhead
 * follows it, each by subscribing. `ms` is on the edited clock; `sourceMs` is
 * the footage's own clock, for the transcript's live word.
 */
export class Playhead {
  ms = 0;
  sourceMs = 0;
  playing = false;
  /** Playing the footage straight through rather than the cut. */
  auditioning = false;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  set(ms: number, sourceMs: number, playing: boolean, auditioning: boolean) {
    if (ms === this.ms && sourceMs === this.sourceMs && playing === this.playing && auditioning === this.auditioning) return;
    this.ms = ms;
    this.sourceMs = sourceMs;
    this.playing = playing;
    this.auditioning = auditioning;
    for (const listener of this.listeners) listener();
  }
}

/** Something read from the playhead, redrawing the caller only when it changes. */
export function usePlayheadValue<T>(playhead: Playhead, read: (playhead: Playhead) => T) {
  return useSyncExternalStore(playhead.subscribe, () => read(playhead), () => read(playhead));
}

export const usePlaying = (playhead: Playhead) => usePlayheadValue(playhead, (p) => p.playing);

/** Where each item starts on the edited clock, with the total last. */
export function clipStarts(clips: Clip[]) {
  const starts = [0];
  for (const clip of clips) starts.push(starts[starts.length - 1] + (clip.endMs - clip.startMs));
  return starts;
}

/** The item at an edited moment, and where in it: footage on its own clock, a card from its start. */
export function editedPosition(clips: Clip[], ms: number) {
  let at = 0;
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index];
    const length = clip.endMs - clip.startMs;
    if (ms < at + length || index === clips.length - 1) {
      return { index, clip, sourceMs: clip.startMs + Math.max(0, Math.min(length, ms - at)) };
    }
    at += length;
  }
  return null;
}

/** The edited moment a footage moment plays at, if the cut plays it. */
export function editedAtSource(clips: Clip[], sourceMs: number) {
  let at = 0;
  for (const clip of clips) {
    if (!isCutIn(clip) && sourceMs >= clip.startMs && sourceMs < clip.endMs) return at + sourceMs - clip.startMs;
    at += clip.endMs - clip.startMs;
  }
  return null;
}

/** An item of a cut. A commentary's clips each name the recording they play from. */
export type Item = Clip & { src?: string };

/** What the monitor asks of either player. */
export interface Player {
  /** Which element plays the picture: a <video> (CutPlayer) or a <canvas> (ScriptPlayer). */
  readonly kind: "video" | "canvas";
  readonly duration: number;
  readonly playing: boolean;
  /** The item showing now, or null over nothing (auditioning, or before a first cue). */
  readonly current: Item | null;
  /** Why nothing plays, when it can't (a decode failure; the player retries and clears it). */
  readonly error: string | null;
  /** The picture's shape, once a frame has been drawn (the captions' frame). */
  readonly frameRatio?: number;
  onStatus(listener: () => void): () => void;
  attach(element: HTMLVideoElement | HTMLCanvasElement | null): void;
  /** The recording footage clips play from when an item names none (the script's proxy) and how long it is. */
  setSource(url: string, durationMs?: number): void;
  update(clips: Item[]): void;
  setRate(rate: number): void;
  setVolume(level: number): void;
  seek(ms: number): void;
  play(from?: number): void;
  audition(sourceMs: number): void;
  cue(sourceMs: number): void;
  pause(): void;
  toggle(): void;
  dispose(): void;
}

/**
 * The player for this browser: the shared decode pipeline (a canvas) when it
 * has WebCodecs, the <video> player else.
 */
export function newPlayer(clips: Item[], playhead: Playhead): Player {
  if (typeof VideoDecoder !== "undefined" && typeof AudioContext !== "undefined") return new ScriptPlayer(clips, playhead);
  return new CutPlayer(null, clips, playhead);
}

/**
 * Plays the cut from one local video: footage clips in order, each cut-in as
 * a card held for its length while the picture waits. A frame loop, not the
 * video's own time events, decides where a clip ends, so cuts land within a
 * frame. Auditioning plays the footage straight through instead.
 */
export class CutPlayer implements Player {
  readonly kind = "video";
  readonly error = null;
  private clips: Item[];
  private starts: number[];
  /** The recording the picture has loaded, for a cut that plays from several. */
  private loaded: string | null = null;
  /** Waiting on a recording to load: where it should start, and whether to play. */
  private pending: { index: number; ms: number } | null = null;
  private frame = 0;
  private running = false;
  private index = 0;
  /** For a card: when it began, on the page's clock, and where on the edited clock. */
  private cardFrom = 0;
  private cardAt = 0;
  private offset = 0;
  private rate = 1;
  private auditioning = false;

  constructor(
    private video: HTMLVideoElement | null,
    clips: Item[],
    private playhead: Playhead,
  ) {
    this.clips = clips;
    this.starts = clipStarts(clips);
  }

  get duration() {
    return this.starts[this.starts.length - 1];
  }

  get playing() {
    return this.running;
  }

  /** The item showing now, or null over nothing. */
  get current() {
    return this.auditioning ? null : (this.clips[this.index] ?? null);
  }

  attach(video: HTMLVideoElement | null) {
    if (this.video === video) return;
    this.pause();
    this.video = video;
    this.loaded = null;
    if (video) video.playbackRate = this.rate;
    this.seek(this.offset);
  }

  update(clips: Item[]) {
    const ms = this.position();
    const was = this.running;
    this.pause();
    this.clips = clips;
    this.starts = clipStarts(clips);
    this.seek(Math.min(ms, this.duration));
    if (was && !this.auditioning) void this.play();
  }

  setRate(rate: number) {
    this.rate = rate;
    if (this.video) this.video.playbackRate = rate;
    if (this.running && this.isCard()) {
      this.cardAt = this.position();
      this.cardFrom = performance.now();
    }
  }

  setVolume(level: number) {
    if (!this.video) return;
    this.video.volume = Math.max(0, Math.min(1, level));
    this.video.muted = level <= 0;
  }

  private isCard() {
    const clip = this.clips[this.index];
    return !!clip && isCutIn(clip);
  }

  /** Where the cut is now, on the edited clock. */
  position() {
    if (this.auditioning) return this.offset;
    const clip = this.clips[this.index];
    if (!clip) return this.offset;
    if (this.pending) return this.pending.ms;
    if (isCutIn(clip)) {
      if (!this.running) return this.offset;
      return Math.min(this.starts[this.index + 1], this.cardAt + (performance.now() - this.cardFrom) * this.rate);
    }
    const source = (this.video?.currentTime ?? 0) * 1000;
    return this.starts[this.index] + Math.max(0, Math.min(clip.endMs - clip.startMs, source - clip.startMs));
  }

  onStatus(_listener: () => void): () => void {
    return () => {};
  }

  setSource(_url: string, _durationMs?: number): void {}

  private report() {
    const ms = this.position();
    const sourceMs = this.auditioning
      ? (this.video?.currentTime ?? 0) * 1000
      : (editedPosition(this.clips, ms)?.sourceMs ?? 0);
    if (this.auditioning) {
      const edited = editedAtSource(this.clips, sourceMs);
      if (edited !== null) this.offset = edited;
    }
    this.playhead.set(this.auditioning ? this.offset : ms, sourceMs, this.running, this.auditioning);
  }

  /** Show item `index` from `ms` on the edited clock. */
  private enter(index: number, ms: number) {
    this.index = index;
    const clip = this.clips[index];
    if (!clip) return;
    if (isCutIn(clip)) {
      this.video?.pause();
      this.cardAt = ms;
      this.cardFrom = performance.now();
      return;
    }
    const source = clip.startMs + (ms - this.starts[index]);
    const video = this.video;
    if (!video) return;
    if (this.load(clip, index, ms)) return;
    // Footage that carries straight on from the last clip needs no seek.
    if (Math.abs(video.currentTime * 1000 - source) > 60) video.currentTime = source / 1000;
    if (this.running && video.paused) void video.play().catch(() => {});
  }

  /**
   * Loads the recording an item plays from, when it is not the one loaded,
   * and shows the item once it is in. Says whether it had to.
   */
  private load(clip: Item, index: number, ms: number) {
    const video = this.video;
    if (!video || !clip.src || clip.src === this.loaded) return false;
    this.loaded = clip.src;
    this.pending = { index, ms };
    video.pause();
    video.src = clip.src;
    const ready = () => {
      if (this.pending?.index !== index || this.loaded !== clip.src) return;
      this.pending = null;
      video.currentTime = (clip.startMs + (ms - this.starts[index])) / 1000;
      if (this.running) void video.play().catch(() => {});
    };
    video.addEventListener("loadedmetadata", ready, { once: true });
    return true;
  }

  seek(ms: number) {
    const was = this.running;
    this.stopLoop();
    this.video?.pause();
    this.auditioning = false;
    this.offset = Math.max(0, Math.min(this.duration, ms));
    const at = editedPosition(this.clips, this.offset);
    this.pending = null;
    if (at) {
      this.index = at.index;
      if (!isCutIn(at.clip) && this.video && !this.load(at.clip, at.index, this.offset)) this.video.currentTime = at.sourceMs / 1000;
    }
    this.report();
    if (was) void this.play();
  }

  async play(from?: number) {
    if (!this.clips.length) return;
    this.auditioning = false;
    let start = from ?? this.position();
    if (start >= this.duration - 30) start = 0;
    this.offset = start;
    const at = editedPosition(this.clips, start);
    if (!at) return;
    this.pending = null;
    this.running = true;
    this.enter(at.index, start);
    this.loop();
  }

  /** Plays the footage from a moment, outside the cut. */
  audition(sourceMs: number) {
    this.stopLoop();
    this.pending = null;
    this.auditioning = true;
    const video = this.video;
    if (!video) return;
    video.currentTime = sourceMs / 1000;
    this.running = true;
    void video.play().catch(() => {});
    this.loop();
  }

  /** Shows a footage moment without playing, as clicking a transcript word does. */
  cue(sourceMs: number) {
    this.stopLoop();
    this.pending = null;
    this.video?.pause();
    const video = this.video;
    if (video) video.currentTime = sourceMs / 1000;
    const edited = editedAtSource(this.clips, sourceMs);
    if (edited !== null) {
      this.auditioning = false;
      this.offset = edited;
      this.index = editedPosition(this.clips, edited)?.index ?? 0;
    } else this.auditioning = true;
    this.playhead.set(this.offset, sourceMs, false, this.auditioning);
  }

  pause() {
    if (!this.running) return;
    this.offset = this.position();
    this.stopLoop();
    this.video?.pause();
    this.report();
  }

  toggle() {
    if (this.running) this.pause();
    else if (this.auditioning) this.audition(this.playhead.sourceMs);
    else void this.play();
  }

  private stopLoop() {
    this.running = false;
    cancelAnimationFrame(this.frame);
  }

  private loop() {
    cancelAnimationFrame(this.frame);
    const tick = () => {
      if (!this.running) return;
      if (this.pending) {
        this.report();
        this.frame = requestAnimationFrame(tick);
        return;
      }
      if (!this.auditioning) {
        const clip = this.clips[this.index];
        const ms = this.position();
        if (!clip) {
          this.finish();
          return;
        }
        const end = this.starts[this.index + 1];
        // A frame early, so the last frame of a clip is the last one shown.
        if (ms >= end - (isCutIn(clip) ? 0 : 16)) {
          if (this.index + 1 >= this.clips.length) {
            this.finish();
            return;
          }
          this.enter(this.index + 1, end);
        }
      } else if (this.video?.ended) {
        // The audition reached the footage's end: the cut's play is what the next Space wants.
        this.auditioning = false;
        this.pause();
        return;
      }
      this.report();
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  private finish() {
    this.stopLoop();
    this.video?.pause();
    this.offset = this.duration;
    this.index = Math.max(0, this.clips.length - 1);
    this.report();
  }

  dispose() {
    this.stopLoop();
    this.video?.pause();
  }
}

/** The proxies are conformed to 30 fps when they're made (writer/media.ts). */
const PROXY_FPS = 30;
/** Sound is scheduled this far ahead of the playhead. */
const AUDIO_AHEAD_MS = 800;
/** Seeks closer together than this are one drag; the exact frame follows once it rests. */
const DRAG_GAP_MS = 150;
const SETTLE_MS = 300;
/** A keyframe this far (source seconds) stands in mid-drag (proxies keyframe a second). */
const ROUGH_REACH = 0.55;
/** How far ahead of the playhead (edited ms) the coming clips are warmed. */
const WARM_MS = 1500;
/** Starting play waits on picture and sound no longer than this before going without the sound. */
const START_WAIT_MS = 1500;
/** After a decoding failure, try again this soon. */
const DECODE_RETRY_MS = 4_000;

/**
 * Plays the cut through the shared decode pipeline (lib/decoder.ts): frames
 * decoded by worker lanes and kept in a cache — the coming clips' first frames
 * are decoded before their cuts land — the sound's PCM chunks scheduled on the
 * audio clock, all of it drawn on a canvas. Where CutPlayer hard-seeks one
 * <video> at every cut (a decode from the last keyframe and a rebuffer each
 * time) and reloads the element for every other recording, this never waits
 * and never reloads.
 */
export class ScriptPlayer implements Player {
  readonly kind = "canvas";
  error: string | null = null;
  /** The drawn picture's shape (the captions' frame); set on the first frame. */
  frameRatio: number | undefined;

  private clips: Item[];
  private starts: number[];
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  /** The recording footage clips play from when an item names none. */
  private src = "";
  /** The footage's whole length, for an audition's end. */
  private mediaMs = 0;
  private audio: AudioContext | null = null;
  private master: GainNode | null = null;
  private volume = 1;
  private scheduled = new Map<string, AudioBufferSourceNode>();
  private running = false;
  private auditioning = false;
  /** Where the edited clock stood at the last pause or seek. */
  private offset = 0;
  /** The footage moment a cue outside the cut left, while auditioning is set. */
  private offsetSource = 0;
  private frame = 0;
  private queued = 0;
  /** The position (edited ms; source ms while auditioning) the clock started from. */
  private clockFrom = 0;
  private clockStart = 0;
  private runningClock = false;
  private waitingToStart = 0;
  private rate = 1;
  private dragging = false;
  private settled = true;
  private lastSeekAt = -Infinity;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();
  private decoder = new Decoder(
    () => this.invalidate(),
    (error) => {
      this.error = `Preview decoding failed: ${error}`;
      this.emit();
      // Most failures are the network's: try again shortly rather than wait for a reload.
      clearTimeout(this.retryTimer);
      const message = this.error;
      this.retryTimer = setTimeout(() => {
        if (this.error !== message) return;
        this.error = null;
        this.emit();
        this.invalidate();
      }, DECODE_RETRY_MS);
    },
  );

  constructor(clips: Item[], private playhead: Playhead) {
    this.clips = clips;
    this.starts = clipStarts(clips);
  }

  get duration() {
    return this.starts[this.starts.length - 1];
  }

  get playing() {
    return this.running;
  }

  get current() {
    if (this.auditioning) return null;
    return editedPosition(this.clips, this.position())?.clip ?? null;
  }

  onStatus = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit() {
    for (const listener of this.listeners) listener();
  }

  attach(canvas: HTMLCanvasElement | null) {
    this.canvas = canvas;
    this.ctx = canvas?.getContext("2d") ?? null;
    this.invalidate();
  }

  setSource(url: string, durationMs = 0) {
    this.src = url;
    this.mediaMs = durationMs;
    this.invalidate();
  }

  private srcOf(clip: Item): string {
    return clip.src ?? this.src;
  }

  /**
   * The position now, on the clock the position domain uses: edited ms, or
   * source ms while auditioning. The audio context owns it while it plays.
   */
  private nowMs() {
    if (this.running && this.runningClock && this.audio)
      return this.clockFrom + Math.max(0, this.audio.currentTime - this.clockStart) * 1000 * this.rate;
    return this.auditioning ? this.offsetSource : this.offset;
  }

  /** The position now, on the edited clock. */
  private position() {
    if (this.auditioning) return editedAtSource(this.clips, this.nowMs()) ?? this.offset;
    return Math.min(this.duration, Math.max(0, this.nowMs()));
  }

  private report() {
    const now = this.nowMs();
    if (this.auditioning) {
      const edited = editedAtSource(this.clips, now);
      if (edited !== null) this.offset = edited;
      this.playhead.set(this.offset, now, this.running, true);
      return;
    }
    const ms = Math.min(this.duration, Math.max(0, now));
    this.playhead.set(ms, editedPosition(this.clips, ms)?.sourceMs ?? 0, this.running, false);
  }

  /** What the frame at the position comes from: the file and where in it (source s), with its clip's bounds. */
  private wanted(pos = this.nowMs()): { url: string; sec: number; lo: number; hi: number } | null {
    if (this.auditioning) {
      return this.src ? { url: this.src, sec: pos / 1000, lo: 0, hi: Math.max(this.mediaMs / 1000, pos / 1000 + 1) } : null;
    }
    const at = editedPosition(this.clips, Math.min(this.duration, Math.max(0, pos)));
    if (!at || isCutIn(at.clip)) return null;
    const url = this.srcOf(at.clip);
    if (!url) return null;
    return { url, sec: at.sourceMs / 1000, lo: at.clip.startMs / 1000, hi: at.clip.endMs / 1000 };
  }

  /** An audible stretch: where it sits on the clock [e0, e1), its file, and the source ms at e0. */
  private spans(pos: number): { e0: number; e1: number; s0: number; src: string; lane: string }[] {
    if (this.auditioning) {
      return this.src && this.mediaMs > 0 ? [{ e0: 0, e1: this.mediaMs, s0: 0, src: this.src, lane: "audition" }] : [];
    }
    const spans: { e0: number; e1: number; s0: number; src: string; lane: string }[] = [];
    const until = pos + AUDIO_AHEAD_MS;
    for (let i = 0; i < this.clips.length && this.starts[i] <= until; i++) {
      const clip = this.clips[i];
      if (isCutIn(clip) || this.starts[i + 1] <= pos) continue;
      const src = this.srcOf(clip);
      if (src) spans.push({ e0: this.starts[i], e1: this.starts[i + 1], s0: clip.startMs, src, lane: `${i}` });
    }
    return spans;
  }

  /** The source ms at position-domain `pos` inside `span`. */
  private sourceAt(span: { e0: number; s0: number }, pos: number) {
    return span.s0 + Math.max(0, pos - span.e0);
  }

  /** Asks for the picture and sound at and just after the position (the coming cuts' first frames too). */
  private warm() {
    const lanes = new Set<string>();
    const pos = this.nowMs();
    const rough = !this.running && this.dragging && !this.settled;
    // The current picture first, then every span sounding or showing by WARM_MS
    // (a coming cut's first frame and sound are here before it lands).
    const targets: { url: string; lane: string; sec: number; hi: number }[] = [];
    if (this.auditioning) {
      const wanted = this.wanted(pos);
      if (wanted !== null) targets.push({ url: wanted.url, lane: "audition", sec: wanted.sec, hi: wanted.hi });
    } else {
      const until = pos + WARM_MS;
      const startIndex = editedPosition(this.clips, Math.min(this.duration, Math.max(0, pos)))?.index ?? 0;
      for (let i = startIndex; i < this.clips.length && this.starts[i] <= until; i++) {
        const clip = this.clips[i];
        if (isCutIn(clip) || this.starts[i + 1] <= pos) continue;
        const src = this.srcOf(clip);
        if (!src) continue;
        const e0 = Math.max(pos, this.starts[i]);
        targets.push({ url: src, lane: `w:${i}`, sec: (clip.startMs + (e0 - this.starts[i])) / 1000, hi: clip.endMs / 1000 });
      }
    }
    for (const target of targets) {
      lanes.add(`v:${target.lane}`);
      if (rough) this.decoder.requestRough(target.url, target.url, `v:${target.lane}`, target.sec, PROXY_FPS, target.hi, ROUGH_REACH);
      else this.decoder.requestVideo(target.url, target.url, `v:${target.lane}`, target.sec, PROXY_FPS, target.hi, 1, this.running, this.rate / PROXY_FPS);
    }
    for (const span of this.spans(pos)) {
      lanes.add(`a:${span.lane}`);
      this.decoder.requestAudio(span.src, span.src, `a:${span.lane}`, this.sourceAt(span, pos) / 1000, (span.s0 + span.e1 - span.e0) / 1000, this.rate);
    }
    this.decoder.retain(lanes);
  }

  private pictureReady(pos: number) {
    const wanted = this.wanted(pos);
    if (wanted === null) return true;
    return Boolean(this.decoder.picture(wanted.url, videoTime(wanted.sec, PROXY_FPS, wanted.hi)));
  }

  /** Whether each span active at the position has its first PCM chunk. */
  private soundReady(pos: number) {
    return this.spans(pos).every((span) => {
      if (pos < span.e0 || pos >= span.e1) return true;
      const chunk = Math.floor(this.sourceAt(span, pos) / 1000 / AUDIO_CHUNK_SECONDS);
      return Boolean(this.decoder.pcm(span.src, chunk, this.rate));
    });
  }

  /** Schedules each span's PCM chunks on the audio clock, ahead of the position. */
  private scheduleAudio(pos: number) {
    const audio = this.audio;
    const master = this.master;
    if (!audio || !master) return;
    for (const span of this.spans(pos)) {
      const first = Math.max(0, Math.floor(this.sourceAt(span, pos) / 1000 / AUDIO_CHUNK_SECONDS));
      const endSource = span.s0 + span.e1 - span.e0;
      for (let chunk = first; chunk * AUDIO_CHUNK_SECONDS * 1000 < endSource; chunk++) {
        // The chunk's clock-domain span; only the part inside the span and ahead of the position plays.
        const ce0 = span.e0 + chunk * AUDIO_CHUNK_SECONDS * 1000 - span.s0;
        const ce1 = ce0 + AUDIO_CHUNK_SECONDS * 1000;
        if (ce1 <= pos && chunk === first) continue;
        const key = `${span.lane}@${chunk}`;
        if (this.scheduled.has(key)) continue;
        const pcm = this.decoder.pcm(span.src, chunk, this.rate);
        if (!pcm || pcm.channels.length === 0) continue;
        const p0 = Math.max(pos, span.e0, ce0);
        const p1 = Math.min(span.e1, ce1);
        if (p1 <= p0) continue;
        const offsetSec = (p0 - ce0) / this.rate / 1000;
        const when = this.clockStart + (p0 - this.clockFrom) / this.rate / 1000;
        const late = Math.max(0, audio.currentTime - when);
        const dur = (p1 - p0) / this.rate / 1000 - late;
        if (dur <= 0) continue;
        const buffer = audio.createBuffer(pcm.channels.length, pcm.channels[0].length, pcm.sampleRate);
        pcm.channels.forEach((channel, index) => buffer.copyToChannel(channel, index));
        const source = audio.createBufferSource();
        source.buffer = buffer;
        source.connect(master);
        source.start(Math.max(audio.currentTime, when), Math.max(0, offsetSec + late), dur);
        source.onended = () => {
          source.disconnect();
          if (this.scheduled.get(key) === source) this.scheduled.delete(key);
        };
        this.scheduled.set(key, source);
      }
    }
  }

  private stopSounds() {
    for (const source of this.scheduled.values()) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already ended.
      }
      source.disconnect();
    }
    this.scheduled.clear();
  }

  /** Re-anchors the clock at `from` (position domain); its first sound lands a lead in. */
  private resetClock(from: number) {
    this.runningClock = false;
    this.waitingToStart = performance.now();
    this.clockFrom = from;
    this.clockStart = (this.audio?.currentTime ?? 0) + 0.05;
  }

  /** Draws the position's frame on the canvas; a card or an undecoded frame holds the last. */
  private draw() {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;
    const wanted = this.wanted();
    if (wanted === null) return;
    const time = videoTime(wanted.sec, PROXY_FPS, wanted.hi);
    const frame =
      this.decoder.picture(wanted.url, time) ??
      this.decoder.nearbyPicture(wanted.url, time, this.dragging && !this.settled ? ROUGH_REACH : 0.12, Math.max(0, wanted.lo - 0.5 / PROXY_FPS), wanted.hi);
    if (!frame) return;
    if (canvas.width !== frame.codedWidth || canvas.height !== frame.codedHeight) {
      canvas.width = frame.codedWidth;
      canvas.height = frame.codedHeight;
      const ratio = (frame.displayWidth || frame.codedWidth) / (frame.displayHeight || frame.codedHeight);
      if (this.frameRatio !== ratio) {
        this.frameRatio = ratio;
        this.emit();
      }
    }
    ctx.drawImage(frame, 0, 0);
  }

  private invalidate() {
    if (this.queued || this.frame) return;
    this.queued = requestAnimationFrame(() => {
      this.queued = 0;
      this.warm();
      this.draw();
    });
  }

  private loop() {
    cancelAnimationFrame(this.frame);
    const tick = () => {
      this.frame = 0;
      if (!this.running) return;
      const audio = this.audio;
      if (!audio || audio.state !== "running") {
        this.frame = requestAnimationFrame(tick);
        return;
      }
      const pos = this.nowMs();
      if (!this.runningClock) {
        // Held on the first frame until its picture and first sound are in
        // (or the wait is long enough that the sound joins mid-stream).
        if (performance.now() - this.waitingToStart < START_WAIT_MS && !(this.pictureReady(pos) && this.soundReady(pos))) {
          this.warm();
          this.frame = requestAnimationFrame(tick);
          return;
        }
        this.clockStart = audio.currentTime + 0.05;
        this.runningClock = true;
      }
      if (!this.auditioning && pos >= this.duration - 1) {
        this.finish();
        return;
      }
      if (this.auditioning && this.mediaMs > 0 && pos >= this.mediaMs - 30) {
        // The audition reached the footage's end: the cut's play is what the next Space wants.
        this.auditioning = false;
        this.offset = editedAtSource(this.clips, pos) ?? this.offset;
        this.pause();
        return;
      }
      this.warm();
      this.scheduleAudio(pos);
      this.draw();
      this.report();
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  private stopLoop() {
    this.running = false;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  update(clips: Item[]) {
    const ms = this.position();
    const was = this.running;
    this.pause();
    this.clips = clips;
    this.starts = clipStarts(clips);
    this.seek(Math.min(ms, this.duration));
    if (was) this.play();
  }

  setRate(rate: number) {
    if (rate === this.rate) return;
    const pos = this.nowMs();
    this.rate = rate;
    if (this.running) {
      this.stopSounds();
      this.resetClock(pos);
    }
  }

  setVolume(level: number) {
    this.volume = Math.max(0, Math.min(1, level));
    if (this.master) this.master.gain.value = this.volume;
  }

  seek(ms: number) {
    const now = performance.now();
    this.dragging = now - this.lastSeekAt < DRAG_GAP_MS;
    this.lastSeekAt = now;
    this.settled = false;
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settled = true;
      this.invalidate();
    }, SETTLE_MS);
    this.auditioning = false;
    this.offset = Math.max(0, Math.min(this.duration, ms));
    if (this.running) {
      this.stopSounds();
      this.resetClock(this.offset);
    }
    this.warm();
    this.invalidate();
    this.report();
  }

  play(from?: number) {
    if (!this.clips.length) return;
    this.auditioning = false;
    let start = from ?? this.offset;
    if (start >= this.duration - 30) start = 0;
    this.offset = start;
    this.running = true;
    this.ensureAudio();
    this.stopSounds();
    this.resetClock(start);
    this.report();
    this.loop();
  }

  private ensureAudio() {
    this.audio ??= new AudioContext({ latencyHint: "interactive" });
    void this.audio.resume().catch((error: unknown) => {
      this.error = `Audio failed to start: ${error}`;
      this.emit();
      this.pause();
    });
    if (!this.master) {
      this.master = this.audio.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.audio.destination);
    }
  }

  /** Plays the footage from a moment, outside the cut. */
  audition(sourceMs: number) {
    this.stopSounds();
    this.auditioning = true;
    this.offsetSource = sourceMs;
    this.running = true;
    this.ensureAudio();
    this.resetClock(sourceMs);
    this.report();
    this.loop();
  }

  /** Shows a footage moment without playing, as clicking a transcript word does. */
  cue(sourceMs: number) {
    if (this.running) this.pause();
    const edited = editedAtSource(this.clips, sourceMs);
    if (edited !== null) {
      this.auditioning = false;
      this.seek(edited);
      return;
    }
    this.stopLoop();
    this.stopSounds();
    this.auditioning = true;
    this.offsetSource = sourceMs;
    this.warm();
    this.invalidate();
    this.playhead.set(this.offset, sourceMs, false, true);
  }

  pause() {
    if (!this.running) return;
    this.offset = this.position();
    this.stopLoop();
    this.stopSounds();
    this.report();
  }

  toggle() {
    if (this.running) this.pause();
    else if (this.auditioning) this.audition(this.playhead.sourceMs);
    else this.play();
  }

  private finish() {
    this.stopLoop();
    this.stopSounds();
    this.offset = this.duration;
    this.report();
  }

  dispose() {
    this.stopLoop();
    this.stopSounds();
    clearTimeout(this.settleTimer);
    clearTimeout(this.retryTimer);
    this.decoder.dispose();
    void this.audio?.close().catch(() => {});
    this.audio = null;
    this.master = null;
  }
}
