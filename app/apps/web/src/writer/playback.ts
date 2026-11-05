import { useSyncExternalStore } from "react";
import { isCutIn } from "./clips";
import { Decoder, videoTime } from "../lib/decoder";
import { AUDIO_CHUNK_SECONDS } from "../lib/decoder.protocol";
import { note, recordTiming } from "../lib/diagnostics";
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

/** What the monitor asks of the player. */
export interface Player {
  readonly duration: number;
  readonly playing: boolean;
  /** The item showing now, or null over nothing (auditioning, or before a first cue). */
  readonly current: Item | null;
  /** Why nothing plays, when it can't (a decode failure; the player retries and clears it). */
  readonly error: string | null;
  /** The picture's shape, once a frame has been drawn (the captions' frame). */
  readonly frameRatio?: number;
  /** A picture of this footage is on the screen (before it, the monitor says it's loading). */
  readonly framed: boolean;
  /** Playing, but held where it is until its picture arrives (as a <video> waits for data). */
  readonly buffering: boolean;
  onStatus(listener: () => void): () => void;
  attach(element: HTMLCanvasElement | null): void;
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

/** The script's player: the shared decode pipeline, drawn on a canvas (Edit's window and every browser it runs in have WebCodecs). */
export function newPlayer(clips: Item[], playhead: Playhead): Player {
  return new ScriptPlayer(clips, playhead);
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
/** Starting play waits on the sound no longer than this, then goes on without it; the picture it always waits for. */
const START_WAIT_MS = 1500;
/** The position's picture missing this long while playing: the clock holds until it's in. */
const STALL_MS = 300;
/** A hold shorter than this isn't shown (most are a frame or two). */
const SHOW_WAIT_MS = 300;
/** A wait this long for the picture goes in the log (Report a problem shows it). */
const SLOW_WAIT_MS = 3000;
/** After a decoding failure, try again this soon. */
const DECODE_RETRY_MS = 4_000;

/**
 * Plays the cut through the shared decode pipeline (lib/decoder.ts): frames
 * decoded by worker lanes and kept in a cache — the coming clips' first frames
 * are decoded before their cuts land — the sound's PCM chunks scheduled on the
 * audio clock, all of it drawn on a canvas. Where one <video> hard-seeked at
 * every cut (a decode from the last keyframe and a rebuffer each time) and
 * reloaded for every other recording, this never waits and never reloads.
 */
export class ScriptPlayer implements Player {
  error: string | null = null;
  /** The drawn picture's shape (the captions' frame); set on the first frame. */
  frameRatio: number | undefined;
  framed = false;
  buffering = false;

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
  /** When the position's picture went missing while the clock ran (0: it's there). */
  private missingSince = 0;
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
    if (url !== this.src && this.framed) {
      this.framed = false;
      this.emit();
    }
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

  /** Whether the position has a picture to show (a card or nothing to show counts: there's nothing to wait for). */
  private pictureReady(pos: number) {
    const wanted = this.wanted(pos);
    return wanted === null || this.frameFor(wanted) !== null;
  }

  /** The decoded picture for `wanted`: its own frame, or one close enough (further mid-drag). */
  private frameFor(wanted: { url: string; sec: number; lo: number; hi: number }) {
    const time = videoTime(wanted.sec, PROXY_FPS, wanted.hi);
    return (
      this.decoder.picture(wanted.url, time) ??
      this.decoder.nearbyPicture(wanted.url, time, this.dragging && !this.settled ? ROUGH_REACH : 0.12, Math.max(0, wanted.lo - 0.5 / PROXY_FPS), wanted.hi) ??
      null
    );
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
    this.missingSince = 0;
    this.clockFrom = from;
    this.clockStart = (this.audio?.currentTime ?? 0) + 0.05;
  }

  /** Holds the running clock at `pos` (position domain) until its picture and sound are in again. */
  private holdAt(pos: number) {
    if (this.auditioning) this.offsetSource = pos;
    else this.offset = Math.max(0, Math.min(this.duration, pos));
    this.stopSounds();
    this.resetClock(pos);
  }

  /** Says when the waiting shows or stops showing. */
  private setBuffering(on: boolean) {
    if (on === this.buffering) return;
    this.buffering = on;
    this.emit();
  }

  /** Draws the position's frame on the canvas; a card or an undecoded frame holds the last. False: its picture isn't here yet. */
  private draw(): boolean {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return true;
    const wanted = this.wanted();
    if (wanted === null) return true;
    const frame = this.frameFor(wanted);
    if (!frame) return false;
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
    if (!this.framed) {
      this.framed = true;
      this.emit();
    }
    return true;
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
        // Held until the position's picture is in, however long that takes: the
        // clock and captions never run over a black or stale screen (Nov 4, JJ's
        // Mac: the cut played on over black while its cloud preview opened).
        // The sound may join mid-stream after a short wait.
        const waited = performance.now() - this.waitingToStart;
        if (!this.pictureReady(pos) || (waited < START_WAIT_MS && !this.soundReady(pos))) {
          this.setBuffering(waited >= SHOW_WAIT_MS);
          this.warm();
          this.draw();
          this.frame = requestAnimationFrame(tick);
          return;
        }
        recordTiming("script preview: waiting to start", waited);
        if (waited >= SLOW_WAIT_MS) note("warn", "preview", `The script's preview waited ${(waited / 1000).toFixed(1)} s for its picture at ${Math.round(pos / 1000)} s`);
        this.setBuffering(false);
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
      if (this.draw()) this.missingSince = 0;
      else if (this.missingSince === 0) this.missingSince = performance.now();
      else if (performance.now() - this.missingSince > STALL_MS) {
        // Fallen behind the picture (a cut's footage not in yet, a slow read): hold here until it is.
        recordTiming("script preview: stalled while playing", performance.now() - this.missingSince);
        this.holdAt(pos);
      }
      this.report();
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  private stopLoop() {
    this.running = false;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.setBuffering(false);
  }

  update(clips: Item[]) {
    // The same cut again (the script read afresh every few seconds while it's saved): nothing to replay.
    if (sameCut(clips, this.clips)) {
      this.clips = clips;
      return;
    }
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
    if (this.running) this.holdAt(pos);
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

/** Whether two cuts play alike: the same items, each over the same footage and stretch. */
export function sameCut(a: Item[], b: Item[]) {
  return a.length === b.length && a.every((one, at) => {
    const other = b[at]!;
    return one.id === other.id && one.startMs === other.startMs && one.endMs === other.endMs && isCutIn(one) === isCutIn(other) && one.src === other.src;
  });
}
