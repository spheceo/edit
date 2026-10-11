// Workers decode source frames and PCM. Web Audio owns the timeline clock;
// the shared WASM compositor still evaluates and renders each complete scene.
import init, { createEngine, type Engine } from "../engine/pkg/edit_wasm";
import { fetchRetrying, mediaUrl } from "./api";
import { Decoder, videoTime } from "./decoder";
import { AUDIO_CHUNK_SECONDS } from "./decoder.protocol";
import { clipEnd, paramAt, projectDuration, validateProject } from "./edit";
import { savedFrame, saveFrame } from "./storage";
import type { Clip, Media, Project, Sections, Track } from "./types";

type Listener = () => void;
class Playhead {
  frame = 0;
  playing = false;
  private listeners = new Set<Listener>();
  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  emit() { for (const listener of this.listeners) listener(); }
}
export const playhead = new Playhead();

/** Same faces the native renderer bundles (crates/edit-render/src/text.rs). */
/** Bundled typefaces: [family, weight, file] (mirrors edit-render BUNDLED_FONTS). */
export const FONTS: [string, number, string][] = [
  ["Geist", 400, "Geist-Regular.ttf"],
  ["Geist", 500, "Geist-Medium.ttf"],
  ["Geist", 600, "Geist-SemiBold.ttf"],
  ["Geist", 700, "Geist-Bold.ttf"],
  ["Geist", 900, "Geist-Black.ttf"],
  ["Montserrat", 600, "Montserrat-SemiBold.ttf"],
];

let wasmReady: Promise<unknown> | null = null;
let fontBytes: Promise<[string, number, Uint8Array][]> | null = null;

type AudioClip = Extract<Clip, { type: "audio" }>;
interface PictureSource { clip: string; media: string; time: number }
interface ScheduledSound { source: AudioBufferSourceNode; gain: GainNode }
const BUFFERING_BADGE_MS = 600;
const LOOK_AHEAD = 1;
const AUDIO_AHEAD = 0.8;
const START_LEAD = 0.05;

class Preview {
  engine: Engine | null = null;
  sections: Sections | null = null;
  error: string | null = null;
  buffering = false;
  private bufferingTimer: ReturnType<typeof setTimeout> | undefined;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private canvas: HTMLCanvasElement | null = null;
  private restarts = 0;
  private project: Project | null = null;
  private clips: Clip[] = [];
  private clipsByTrack = new Map<string, Clip[]>();
  private clipsById = new Map<string, Clip>();
  private tracks = new Map<string, Track>();
  private media = new Map<string, Media>();
  private sources = new Map<string, string>();
  private duration = 0;
  private persistedAt = 0;
  private renderedFrame: number | null = null;
  private copied = new Map<string, VideoFrame>();
  private pendingScenes = new Map<number, { serial: number; sources: PictureSource[] }>();
  private seekSerial = 0;
  private renderedScrub = -1;
  private direction = 1;
  private playedFrom = 0;
  private audio: AudioContext | null = null;
  private peaks = new Map<string, Uint8Array | Promise<void>>();
  private scheduled = new Map<string, ScheduledSound>();
  private queued = 0;
  private generation = 0;
  private attaching = false;
  private clockStart = 0;
  private frameAtStart = 0;
  private runningClock = false;
  private playbackStats = { videoMisses: 0, audioUnderruns: 0 };
  private loop = 0;
  private listeners = new Set<Listener>();
  private decoder = new Decoder(() => this.invalidate(), (error) => {
    this.error = `Preview decoding failed: ${error}`;
    this.pause();
    this.setBuffering(false);
    this.notify();
  });

  get diagnostics() {
    return { ...this.decoder.stats, ...this.playbackStats, renderedFrame: this.renderedFrame,
      videoCacheBytes: this.decoder.pictures.bytes, videoCacheFrames: this.decoder.pictures.size,
      audioCacheBytes: this.decoder.sound.bytes, scheduledAudio: this.scheduled.size };
  }

  onStatus = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async attach(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.error = null;
    const generation = ++this.generation;
    if (!("gpu" in navigator)) {
      this.error =
        location.hostname === "localhost" || location.protocol === "https:"
          ? "This browser has no WebGPU. Use Chrome, Edge, Arc or Safari 26+."
          : "WebGPU needs a secure page. Open via http://localhost or HTTPS (tailscale serve).";
      this.notify();
      return;
    }
    this.attaching = true;
    this.setBuffering(true);
    try {
      wasmReady ??= init();
      fontBytes ??= Promise.all(
        FONTS.map(
          async ([family, weight, file]) =>
            [family, weight, new Uint8Array(await (await fetchRetrying(`/fonts/${file}`)).arrayBuffer())] as [string, number, Uint8Array],
        ),
      ).catch((error) => {
        fontBytes = null; // try again next time rather than caching the failure
        throw error;
      });
      await wasmReady;
      const engine = await createEngine(canvas);
      for (const [family, weight, bytes] of await fontBytes) engine.addFont(family, weight, bytes);
      if (generation !== this.generation) {
        engine.free(); // detached, or attached again, while this one started
        return;
      }
      this.retire();
      this.engine = engine;
      if (this.project) engine.setProject(JSON.stringify(this.project));
      for (const [media, levels] of this.peaks) if (levels instanceof Uint8Array) engine.setPeaks(media, levels);
      this.readSections();
      this.setBuffering(false);
      this.notify();
      this.invalidate();
    } catch (error) {
      if (generation !== this.generation) return;
      this.error = `Preview failed to start: ${error}`;
      this.setBuffering(false);
      this.notify();
    } finally {
      if (generation === this.generation) this.attaching = false;
    }
  }

  /**
   * The page is visible again. The browser may have dropped the GPU device
   * (or the canvas contents) while it was hidden, so redraw, which rebuilds
   * the engine if needed, or retry an engine that failed to start.
   */
  wake() {
    this.renderedFrame = null;
    if (this.canvas && !this.engine && !this.attaching) void this.attach(this.canvas);
    else this.invalidate();
  }

  /** The GPU device went away (see Engine.isLost): start over on the same canvas. */
  private recover() {
    if (!this.canvas || this.attaching) return;
    console.warn("edit: preview lost its GPU device; restarting it");
    this.retire();
    void this.attach(this.canvas);
  }

  /**
   * Runs an engine call. A Rust panic poisons the WASM instance, so any
   * failure retires this engine and builds a fresh one on the same canvas
   * instead of letting the error escape into React.
   */
  private use<T>(call: (engine: Engine) => T): T | undefined {
    const engine = this.engine;
    if (!engine) return undefined;
    try {
      return call(engine);
    } catch (error) {
      console.warn("edit engine failed; restarting", error);
      this.engine = null;
      if (this.canvas && this.restarts < 3) {
        this.restarts += 1;
        void this.attach(this.canvas);
      } else {
        this.error = "The preview stopped. Reload the page to restart it.";
        this.notify();
      }
      return undefined;
    }
  }

  /** Frees the current engine; a poisoned one may refuse, which is fine. */
  private retire() {
    try {
      this.engine?.free();
    } catch {
      // Already dead.
    }
    this.engine = null;
    this.renderedFrame = null;
    this.copied.clear();
  }

  detach() {
    this.setBuffering(false);
    this.remember();
    this.canvas = null;
    this.generation++;
    this.attaching = false;
    this.pause();
    cancelAnimationFrame(this.queued);
    this.queued = 0;
    this.retire();
    this.decoder.dispose();
    this.pendingScenes.clear();
  }

  resize(width: number, height: number) {
    this.renderedFrame = null;
    this.use((engine) => engine.resize(width, height));
    cancelAnimationFrame(this.queued);
    this.queued = 0;
    this.draw();
  }

  setProject(project: Project, proxyVersions: Record<string, string>) {
    if (validateProject(project)) return;
    const changedSource = this.project?.id !== project.id;
    if (changedSource) {
      this.remember();
      this.pause();
      this.decoder.dispose();
      this.sources.clear();
      this.copied.clear();
      this.peaks.clear();
      this.use((engine) => engine.clearPeaks());
      playhead.frame = savedFrame(project.id);
      playhead.emit();
    }
    const ids = new Set(project.clips.map((clip) => clip.id));
    for (const clip of this.project?.clips ?? []) if (!ids.has(clip.id)) {
      this.use((engine) => engine.forgetVideo(clip.id));
      this.copied.delete(clip.id);
    }
    this.project = project;
    this.error = null;
    this.renderedFrame = null;
    this.pendingScenes.clear();
    this.seekSerial++;
    this.renderedScrub = -1;
    this.clips = [...project.clips].sort((a, b) => a.start - b.start);
    this.clipsById = new Map(project.clips.map((clip) => [clip.id, clip]));
    this.clipsByTrack.clear();
    for (const clip of this.clips) {
      const clips = this.clipsByTrack.get(clip.track) ?? [];
      clips.push(clip);
      this.clipsByTrack.set(clip.track, clips);
    }
    this.duration = projectDuration(project);
    this.tracks = new Map(project.tracks.map((track) => [track.id, track]));
    this.media = new Map(project.media.map((media) => [media.id, media]));
    const nextSources = new Map(project.media.map((media) => [media.id,
      `${mediaUrl(project.id, media.id, "proxy")}?v=${encodeURIComponent(proxyVersions[media.id] ?? "source")}`]));
    for (const [id, url] of this.sources) if (nextSources.get(id) !== url) this.decoder.forget(url);
    this.sources = nextSources;
    this.copied.clear();
    this.loadPeaks(project);
    this.resetClock();
    this.use((engine) => engine.setProject(JSON.stringify(project)));
    this.readSections();
    this.notify();
    this.invalidate();
  }

  private loadPeaks(project: Project) {
    if (!project.clips.some((clip) => clip.type === "waveform")) return;
    for (const clip of project.clips) {
      if (clip.type !== "audio" || this.peaks.has(clip.media)) continue;
      const media = clip.media;
      const loading: Promise<void> = fetchRetrying(mediaUrl(project.id, media, "peaks"))
        .then(async (response) => {
          if (!response.ok) throw new Error(`peaks: HTTP ${response.status}`);
          const levels = new Uint8Array(await response.arrayBuffer());
          if (this.project?.id !== project.id) return;
          this.peaks.set(media, levels);
          this.use((engine) => engine.setPeaks(media, levels));
          this.invalidate();
        }).catch(() => { if (this.peaks.get(media) === loading) this.peaks.delete(media); });
      this.peaks.set(media, loading);
    }
  }

  private readSections() {
    try { this.sections = JSON.parse(this.use((engine) => engine.sections()) ?? "null"); }
    catch { this.sections = null; }
  }

  remember() {
    clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    if (this.project) saveFrame(this.project.id, playhead.frame);
    this.persistedAt = performance.now();
  }

  invalidate = () => {
    if (this.queued || this.loop) return;
    this.queued = requestAnimationFrame(() => { this.queued = 0; this.draw(); });
  };

  seek(frame: number) {
    if (!Number.isFinite(frame)) return;
    this.direction = frame < playhead.frame ? -1 : 1;
    this.seekSerial++;
    playhead.frame = Math.max(0, Math.round(frame));
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.remember(), 200);
    this.resetClock();
    playhead.emit();
    this.invalidate();
  }

  seekEnd() { this.seek(this.project ? projectDuration(this.project) : 0); }
  toggle() { if (playhead.playing) this.pause(); else this.play(); }

  play() {
    if (!this.project || playhead.playing || this.duration <= 0 || this.error) return;
    if (playhead.frame >= this.duration - 1) playhead.frame = 0;
    playhead.playing = true;
    this.pendingScenes.clear();
    this.direction = 1;
    this.playedFrom = playhead.frame;
    // Unlock audio in the user gesture, even for edits whose first shot is silent.
    this.audio ??= new AudioContext({ latencyHint: "interactive" });
    void this.audio.resume().catch((error) => {
      this.error = `Audio failed to start: ${error}`; this.pause(); this.notify();
    });
    this.resetClock();
    playhead.emit();
    cancelAnimationFrame(this.queued);
    this.queued = 0;
    const tick = () => {
      this.loop = 0;
      if (!playhead.playing) return;
      this.tick();
      if (playhead.playing) this.loop = requestAnimationFrame(tick);
    };
    this.loop = requestAnimationFrame(tick);
  }

  pause() {
    this.remember();
    const playing = playhead.playing;
    playhead.playing = false;
    cancelAnimationFrame(this.loop);
    this.loop = 0;
    this.resetClock();
    if (!playing) return;
    playhead.frame = Math.round(playhead.frame);
    playhead.emit();
    this.invalidate();
  }

  private resetClock() {
    this.runningClock = false;
    this.stopSounds();
    this.frameAtStart = playhead.frame;
    this.clockStart = (this.audio?.currentTime ?? 0) + START_LEAD;
  }

  /** Audio hardware is the only clock. Video may drop frames, but never resets sound. */
  private tick() {
    if (!this.project || !this.audio || this.audio.state !== "running") return;
    if (!this.engine) { this.resetClock(); this.setBuffering(true); return; }
    const fps = this.project.settings.fps;
    let frame = this.runningClock
      ? this.frameAtStart + Math.max(0, this.audio.currentTime - this.clockStart) * fps
      : playhead.frame;
    const out = this.project.mark_out ?? null;
    if (out !== null && this.playedFrom < out && frame >= out && out < this.duration) {
      playhead.frame = out; this.pause(); return;
    }
    if (frame >= this.duration) {
      playhead.frame = Math.max(0, this.duration - 1); this.pause(); return;
    }
    const sources = this.sceneSources(Math.floor(frame));
    this.warm(Math.floor(frame), sources);
    if (!this.runningClock && (!this.picturesReady(sources) || !this.audioReady(frame, 0.5))) {
      this.setBuffering(true);
      return;
    }
    if (!this.runningClock) {
      frame = playhead.frame;
      this.frameAtStart = frame;
      this.clockStart = this.audio.currentTime + START_LEAD;
      this.runningClock = true;
    }
    playhead.frame = frame;
    if (!this.audioReady(frame, 0)) this.playbackStats.audioUnderruns++;
    this.scheduleAudio(frame);
    this.draw();
    if (performance.now() - this.persistedAt >= 1000) this.remember();
    playhead.emit();
  }

  /** Active clips are found by binary search rather than scanning the full edit per tick. */
  private activeClips(frame: number) {
    const active: Clip[] = [];
    for (const clips of this.clipsByTrack.values()) {
      let lo = 0, hi = clips.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (clips[mid].start <= frame) lo = mid + 1; else hi = mid;
      }
      if (lo && frame < clipEnd(clips[lo - 1])) active.push(clips[lo - 1]);
    }
    return active;
  }

  private audible(clip: Clip): clip is AudioClip {
    const media = clip.type === "audio" ? this.media.get(clip.media) : undefined;
    return clip.type === "audio" && !this.tracks.get(clip.track)?.muted && Boolean(media && (media.kind === "audio" || media.has_audio));
  }

  private sceneSources(frame: number): PictureSource[] {
    try { return JSON.parse(this.use((engine) => engine.sources(frame)) ?? "[]"); }
    catch { return []; }
  }

  private picture(source: PictureSource) {
    const media = this.media.get(source.media);
    const url = this.sources.get(source.media);
    if (!media || !url) return;
    const time = media.kind === "image" ? 0 : videoTime(source.time, media.fps, media.duration);
    return this.decoder.picture(url, time);
  }

  private picturesReady(sources: PictureSource[]) { return sources.every((source) => Boolean(this.picture(source))); }

  private requestPicture(source: PictureSource, lanes: Set<string>) {
    const media = this.media.get(source.media);
    const url = this.sources.get(source.media);
    if (!media || !url) return;
    const lane = `v:${source.clip ?? source.media}`;
    lanes.add(lane);
    const clip = this.clipsById.get(source.clip);
    const speed = clip?.type === "video" ? clip.speed : 1;
    if (media.kind === "image") this.decoder.requestImage(url, url);
    else this.decoder.requestVideo(url, url, lane, source.time, media.fps || 30, media.duration,
      playhead.playing ? 1 : this.direction, playhead.playing, speed / this.project!.settings.fps);
  }

  private warm(frame: number, sources: PictureSource[]) {
    if (!this.project) return;
    const fps = this.project.settings.fps;
    const lanes = new Set<string>();
    for (const source of sources) this.requestPicture(source, lanes);
    // Scrubbing needs one picture, not concurrent audio and future-cut decodes.
    if (!playhead.playing) { this.decoder.retain(lanes); return; }
    const active = this.activeClips(frame);
    // Cue upcoming cuts, including a different moment of the same source.
    let lo = 0, hi = this.clips.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.clips[mid].start <= frame) lo = mid + 1; else hi = mid;
    }
    const upcoming: Clip[] = [];
    for (let i = lo; i < this.clips.length && this.clips[i].start <= frame + fps * LOOK_AHEAD; i++) upcoming.push(this.clips[i]);
    for (const clip of upcoming) if (clip.type === "video" && !this.tracks.get(clip.track)?.hidden) {
      this.requestPicture({ clip: clip.id, media: clip.media, time: clip.source_in }, lanes);
    }
    for (const clip of [...active, ...upcoming]) if (this.audible(clip)) {
      const media = this.media.get(clip.media)!;
      const url = this.sources.get(clip.media)!;
      const time = clip.source_in + Math.max(0, frame - clip.start) / fps * clip.speed;
      if (time >= media.duration) continue;
      const lane = `a:${clip.id}`;
      lanes.add(lane);
      this.decoder.requestAudio(url, url, lane, time, media.duration, clip.speed);
    }
    this.decoder.retain(lanes);
  }

  private audioReady(frame: number, ahead: number) {
    if (!this.project) return true;
    const fps = this.project.settings.fps;
    const until = frame + ahead * fps;
    return this.clips.every((clip) => {
      if (clip.start > until || clipEnd(clip) <= frame) return true;
      if (!this.audible(clip)) return true;
      const media = this.media.get(clip.media)!;
      const time = clip.source_in + Math.max(0, frame - clip.start) / fps * clip.speed;
      if (time >= media.duration) return true;
      const end = Math.min(media.duration, clip.source_in + (Math.min(until, clipEnd(clip)) - clip.start) / fps * clip.speed);
      const first = Math.floor((time + 1e-8) / AUDIO_CHUNK_SECONDS);
      const last = Math.max(first, Math.floor((end - 1e-8) / AUDIO_CHUNK_SECONDS));
      for (let chunk = first; chunk <= last; chunk++) if (!this.decoder.pcm(this.sources.get(clip.media)!, chunk, clip.speed)) return false;
      return true;
    });
  }

  private scheduleAudio(frame: number) {
    const project = this.project;
    const audio = this.audio;
    if (!project || !audio) return;
    const fps = project.settings.fps;
    const until = frame + fps * AUDIO_AHEAD;
    for (const clip of this.clips) {
      if (clip.start > until) break;
      if (clipEnd(clip) <= frame || !this.audible(clip)) continue;
      const url = this.sources.get(clip.media)!;
      const media = this.media.get(clip.media)!;
      const time = clip.source_in + Math.max(0, frame - clip.start) / fps * clip.speed;
      const first = Math.floor(time / AUDIO_CHUNK_SECONDS);
      const last = Math.floor((clip.source_in + (Math.min(until, clipEnd(clip)) - clip.start) / fps * clip.speed) / AUDIO_CHUNK_SECONDS);
      for (let chunk = first; chunk <= last; chunk++) {
        const key = `${clip.id}@${chunk}`;
        if (this.scheduled.has(key)) continue;
        const pcm = this.decoder.pcm(url, chunk, clip.speed);
        if (!pcm) continue;
        const start = Math.max(frame, clip.start, clip.start + (pcm.start - clip.source_in) / clip.speed * fps);
        const end = Math.min(clipEnd(clip), clip.start + (Math.min(media.duration, pcm.start + AUDIO_CHUNK_SECONDS) - clip.source_in) / clip.speed * fps);
        if (end <= start) continue;
        const offset = clip.source_in + (start - clip.start) / fps * clip.speed - pcm.start;
        const when = this.clockStart + (start - this.frameAtStart) / fps;
        const late = Math.max(0, audio.currentTime - when);
        const length = (end - start) / fps - late;
        if (length <= 0) continue;
        const buffer = audio.createBuffer(pcm.channels.length, pcm.channels[0].length, pcm.sampleRate);
        pcm.channels.forEach((channel, index) => buffer.copyToChannel(channel, index));
        const source = audio.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = 1; // Worker PCM is already stretched, with pitch preserved.
        const gain = audio.createGain();
        const at = Math.max(audio.currentTime, when);
        // Automation follows the same frame fades and volume keys as the native mixer.
        for (let sample = start + late * fps; sample <= end; sample = Math.min(end, sample + 1)) {
          const local = sample - clip.start;
          let volume = 10 ** (paramAt(clip, "volume_db", sample) / 20);
          if (clip.fade_in > 0) volume *= Math.min(1, (local + 1) / (clip.fade_in + 1));
          if (clip.fade_out > 0) volume *= Math.min(1, (clip.duration - local) / (clip.fade_out + 1));
          const t = at + (sample - start - late * fps) / fps;
          if (sample === start + late * fps) gain.gain.setValueAtTime(volume, t);
          else gain.gain.linearRampToValueAtTime(volume, t);
          if (sample === end) break;
        }
        source.connect(gain).connect(audio.destination);
        source.start(at, Math.max(0, offset / clip.speed + late), length);
        const scheduled = { source, gain };
        source.onended = () => {
          source.disconnect(); gain.disconnect();
          if (this.scheduled.get(key) === scheduled) this.scheduled.delete(key);
        };
        this.scheduled.set(key, scheduled);
      }
    }
  }

  private stopSounds() {
    for (const { source, gain } of this.scheduled.values()) {
      source.onended = null;
      try { source.stop(); } catch { /* Already ended. */ }
      source.disconnect(); gain.disconnect();
    }
    this.scheduled.clear();
  }

  private draw() {
    if (!this.engine || !this.project || this.error) return;
    if (this.use((engine) => engine.isLost())) { this.recover(); return; }
    const wanted = Math.floor(playhead.frame);
    const sources = this.sceneSources(wanted);
    this.warm(wanted, sources);
    let frame = wanted;
    let selected = sources;
    const ready = this.picturesReady(sources);
    if (!playhead.playing) {
      this.pendingScenes.set(wanted, { serial: this.seekSerial, sources });
      while (this.pendingScenes.size > 32) this.pendingScenes.delete(this.pendingScenes.keys().next().value!);
      if (!ready) {
        // Display the newest completed request as a complete scene, never a new
        // title over old footage. The final cursor position stays queued for exact landing.
        const completed = [...this.pendingScenes].reverse().find(([, scene]) => scene.serial > this.renderedScrub && this.picturesReady(scene.sources));
        if (!completed) { this.setBuffering(true); return; }
        frame = completed[0];
        selected = completed[1].sources;
        this.renderedScrub = completed[1].serial;
      }
    }
    const pictures: VideoFrame[] = [];
    for (const source of selected) {
      let picture = this.picture(source);
      if (!picture && playhead.playing) {
        const media = this.media.get(source.media);
        const clip = this.clipsById.get(source.clip);
        if (media && clip?.type === "video") {
          const time = videoTime(source.time, media.fps, media.duration);
          picture = this.decoder.nearbyPicture(this.sources.get(source.media)!, time, 0.12 * clip.speed,
            Math.max(0, clip.source_in - 0.5 / (media.fps || 30)), clip.source_in + clip.duration / this.project.settings.fps * clip.speed);
        }
      }
      if (!picture) {
        if (playhead.playing) this.playbackStats.videoMisses++;
        this.setBuffering(true);
        return;
      }
      pictures.push(picture);
    }
    let changed = false;
    for (const [index, source] of selected.entries()) {
      const picture = pictures[index];
      const key = source.clip ?? source.media;
      if (this.copied.get(key) === picture) continue;
      this.use((engine) => engine.uploadFrame(key, picture));
      if (this.engine) this.copied.set(key, picture);
      changed = true;
    }
    this.setBuffering(false);
    if (!changed && this.renderedFrame === frame) return;
    this.use((engine) => {
      if (this.canvas) engine.resize(this.canvas.width, this.canvas.height);
      engine.render(frame);
    });
    if (this.engine) this.renderedFrame = frame;
    if (ready && !playhead.playing) this.renderedScrub = this.seekSerial;
    const visible = new Set(selected.map((source) => source.clip ?? source.media));
    for (const key of this.copied.keys()) if (!visible.has(key)) this.copied.delete(key);
    if (ready) this.pendingScenes.clear();
    if (this.engine) this.restarts = 0;
  }

  private notify() { for (const listener of this.listeners) listener(); }
  private setBuffering(waiting: boolean) {
    if (waiting) {
      if (!this.buffering && this.bufferingTimer === undefined) this.bufferingTimer = setTimeout(() => {
        this.bufferingTimer = undefined; this.buffering = true; this.notify();
      }, BUFFERING_BADGE_MS);
    } else {
      clearTimeout(this.bufferingTimer); this.bufferingTimer = undefined;
      if (this.buffering) { this.buffering = false; this.notify(); }
    }
  }
}

export const preview = new Preview();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") preview.wake();
  else { preview.remember(); preview.pause(); }
});
window.addEventListener("pagehide", () => preview.remember());
(window as unknown as { __edit?: unknown }).__edit = { preview, playhead };
