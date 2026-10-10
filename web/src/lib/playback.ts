// Drives the WASM engine: owns the playhead clock, a pool of <video> elements
// (two per media, playing the all-intra proxy: one plays while the other waits
// on the next cut, so cuts within one source never seek) and the render loop.
// React never re-renders per frame; the timeline and viewer subscribe directly.

import init, { createEngine, type Engine } from "../engine/pkg/edit_wasm";
import { fetchRetrying, mediaUrl } from "./api";
import { clipEnd, mediaOf, projectDuration, trackOf } from "./edit";
import type { Project } from "./types";

type Listener = () => void;

class Playhead {
  frame = 0;
  playing = false;
  private listeners = new Set<Listener>();

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  emit() {
    for (const listener of this.listeners) listener();
  }
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

interface Want {
  /** The moment this is (start frame and source in): linked picture and sound share it. */
  key: string;
  time: number;
  speed: number;
  audible: boolean;
  volume: number;
  /** Clip the element is serving, to map its playback time back to a frame. */
  clipStart: number;
  sourceIn: number;
  /** Higher drives the clock: the top visible video, else sound. */
  rank: number;
}

/** Seconds of drift tolerated on elements that don't drive the clock. */
const FOLLOWER_DRIFT = 0.25;
/** How far ahead upcoming clips are cued, in seconds. */
const PREROLL = 1;
/** After a cut swaps elements, how long the clock runs on while the new one starts. */
const SWAP_GRACE_MS = 250;
/** The next roll starts playing (muted, unseen) this long before its cut, so it's already running at the cut. */
const RUN_IN = 0.5;
/** Elements per media: the one playing and the one cued for the next cut. */
const ROLLS = 2;

class Preview {
  engine: Engine | null = null;
  error: string | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private restarts = 0;
  private project: Project | null = null;
  /** Each media's elements (A/B rolls). */
  private videos = new Map<string, HTMLVideoElement[]>();
  /** The element showing each media right now. */
  private active = new Map<string, HTMLVideoElement>();
  /** The moment (Want.key) each element is playing or cued for. */
  private owner = new Map<HTMLVideoElement, string>();
  private sources = new Map<string, string>();
  private versions = new Map<string, string>();
  private seeking = new Set<HTMLVideoElement>();
  private waitingFor = new Set<HTMLVideoElement>();
  /** Elements that reported they ran out of data. */
  private stalled = new Set<HTMLVideoElement>();
  private pending = new Map<HTMLVideoElement, number>();
  /** Media whose engine texture holds a frame already. */
  private uploaded = new Set<string>();
  /** When the clock's element last changed (a cut swapped rolls). */
  private masterSince = 0;
  private lastMaster: HTMLVideoElement | null = null;
  private queued = 0;
  private clockStart = 0;
  private frameAtStart = 0;
  private loop = 0;
  private listeners = new Set<Listener>();

  onStatus = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async attach(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.error = null;
    if (!("gpu" in navigator)) {
      this.error =
        location.hostname === "localhost" || location.protocol === "https:"
          ? "This browser has no WebGPU. Use Chrome, Edge, Arc or Safari 26+."
          : "WebGPU needs a secure page. Open via http://localhost or HTTPS (tailscale serve).";
      this.notify();
      return;
    }
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
      this.retire();
      this.engine = engine;
      if (this.project) engine.setProject(JSON.stringify(this.project));
      this.notify();
      this.invalidate();
    } catch (error) {
      this.error = `Preview failed to start: ${error}`;
      this.notify();
    }
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
  }

  detach() {
    this.canvas = null;
    this.pause();
    this.retire();
    for (const video of this.allVideos()) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    this.forgetElements();
  }

  private forgetElements() {
    this.uploaded.clear();
    this.videos.clear();
    this.active.clear();
    this.owner.clear();
    this.sources.clear();
    this.versions.clear();
  }

  /**
   * The canvas backing store just changed size, which blanks it. Redraw in
   * the same task (we're inside a ResizeObserver callback, before paint) so
   * the browser never shows the blank canvas, e.g. while panels animate.
   */
  resize(width: number, height: number) {
    this.use((engine) => engine.resize(width, height));
    cancelAnimationFrame(this.queued);
    this.queued = 0;
    this.draw();
  }

  setProject(project: Project, proxyVersions: Record<string, string>) {
    const changedSource = this.project?.id !== project.id;
    this.project = project;
    if (changedSource) this.detachVideos();
    for (const media of project.media) {
      if (media.kind === "image") continue;
      const version = proxyVersions[media.id] ?? "0";
      if (this.videos.has(media.id) && this.versions.get(media.id) === version) continue;
      const src = `${mediaUrl(project.id, media.id, "proxy")}?v=${version}`;
      this.sources.set(media.id, src);
      this.versions.set(media.id, version);
      const rolls = this.videos.get(media.id) ?? [this.makeVideo(media.id)];
      for (const video of rolls) {
        const resume = video.currentTime;
        video.src = src;
        if (resume) video.currentTime = resume;
      }
    }
    for (const [id, rolls] of this.videos) {
      if (!project.media.some((media) => media.id === id)) {
        for (const video of rolls) {
          video.pause();
          video.removeAttribute("src");
          this.owner.delete(video);
        }
        this.videos.delete(id);
        this.active.delete(id);
        this.use((engine) => engine.forgetVideo(id));
      }
    }
    this.use((engine) => engine.setProject(JSON.stringify(project)));
    this.invalidate();
  }

  private detachVideos() {
    for (const [id, rolls] of this.videos) {
      for (const video of rolls) {
        video.pause();
        video.removeAttribute("src");
      }
      this.use((engine) => engine.forgetVideo(id));
    }
    this.forgetElements();
  }

  /** A media's rolls, adding the second when a cut needs it. */
  private rolls(id: string, wanted = 1) {
    const rolls = this.videos.get(id) ?? [];
    while (rolls.length < Math.min(wanted, ROLLS)) {
      const video = this.makeVideo(id);
      const src = this.sources.get(id);
      if (src) video.src = src;
      rolls.push(video);
    }
    this.videos.set(id, rolls);
    return rolls;
  }

  private allVideos() {
    return [...this.videos.values()].flat();
  }

  /** The element that shows `id` now (the first roll until a cut picks another). */
  private shown(id: string) {
    return this.active.get(id) ?? this.videos.get(id)?.[0];
  }

  private makeVideo(id: string) {
    const video = document.createElement("video");
    // Only headers until needed: many elements buffering at once starve the
    // one that is playing (see `want`, which switches to "auto").
    video.preload = "metadata";
    video.playsInline = true;
    video.muted = true;
    video.crossOrigin = "anonymous";
    video.addEventListener("seeked", () => this.onSeeked(video));
    video.addEventListener("loadeddata", () => this.invalidate());
    video.addEventListener("waiting", () => this.stalled.add(video));
    video.addEventListener("playing", () => this.stalled.delete(video));
    video.addEventListener("canplay", () => this.stalled.delete(video));
    if (!this.videos.has(id)) this.videos.set(id, [video]);
    return video;
  }

  private onSeeked(video: HTMLVideoElement) {
    this.seeking.delete(video);
    const next = this.pending.get(video);
    this.pending.delete(video);
    if (next !== undefined && Math.abs(video.currentTime - next) > 1e-3) {
      this.seekVideo(video, next);
      return;
    }
    this.invalidate();
  }

  private seekVideo(video: HTMLVideoElement, time: number) {
    if (this.seeking.has(video)) {
      this.pending.set(video, time);
      return;
    }
    this.seeking.add(video);
    video.currentTime = time;
  }

  /** Requests a redraw on the next animation frame. Cheap to call often. */
  invalidate = () => {
    if (this.queued || this.loop) return;
    this.queued = requestAnimationFrame(() => {
      this.queued = 0;
      this.draw();
    });
  };

  /** Moves the playhead anywhere from 0 on, including past the last clip (shows black). */
  seek(frame: number) {
    playhead.frame = Math.max(0, Math.round(frame));
    if (playhead.playing) {
      this.frameAtStart = playhead.frame;
      this.clockStart = performance.now();
      this.syncElements(true);
    }
    playhead.emit();
    this.invalidate();
  }

  /** Jumps to the end of the edit (just after the last clip). */
  seekEnd() {
    this.seek(this.project ? projectDuration(this.project) : 0);
  }

  toggle() {
    if (playhead.playing) this.pause();
    else this.play();
  }

  play() {
    if (!this.project || playhead.playing) return;
    const end = projectDuration(this.project);
    if (end <= 0) return;
    if (playhead.frame >= end - 1) playhead.frame = 0;
    playhead.playing = true;
    this.frameAtStart = playhead.frame;
    this.clockStart = performance.now();
    // Start elements inside the user gesture so audio is allowed.
    this.syncElements(true);
    playhead.emit();
    cancelAnimationFrame(this.queued);
    this.queued = 0;
    const tick = () => {
      if (!playhead.playing) return;
      this.tick();
      this.loop = requestAnimationFrame(tick);
    };
    this.loop = requestAnimationFrame(tick);
  }

  pause() {
    if (!playhead.playing) return;
    playhead.playing = false;
    cancelAnimationFrame(this.loop);
    this.loop = 0;
    for (const video of this.allVideos()) {
      video.pause();
      video.muted = true;
    }
    playhead.frame = Math.round(playhead.frame);
    playhead.emit();
    this.invalidate();
  }

  /**
   * The picture is the clock: while the top visible video plays smoothly the
   * playhead reads its time, so nothing drifts and nothing re-seeks. If it is
   * buffering the playhead waits rather than running ahead. Gaps and graphics
   * use the wall clock.
   */
  private tick() {
    if (!this.project) return;
    const fps = this.project.settings.fps;
    const end = projectDuration(this.project);
    const now = performance.now();
    const wall = this.frameAtStart + ((now - this.clockStart) / 1000) * fps;
    let frame = wall;
    const master = [...this.wants(Math.floor(playhead.frame)).entries()].sort((a, b) => b[1].rank - a[1].rank)[0];
    if (master) {
      const [id, want] = master;
      const video = this.shown(id);
      if (video) {
        if (video !== this.lastMaster) {
          this.lastMaster = video;
          this.masterSince = now;
        }
        // Just after a cut the new roll is starting from its cued frame: keep
        // time moving rather than holding the playhead for it.
        const starting = now - this.masterSince < SWAP_GRACE_MS && Math.abs(video.currentTime - want.time) < 0.25;
        const ready = !video.paused && video.readyState >= 3 && !this.seeking.has(video) && !this.stalled.has(video);
        if (video.ended || starting) {
          // The source ran out before its clip did, or a roll is starting: keep time on the wall clock.
        } else if (ready) {
          const pictureFrame = want.clipStart + ((video.currentTime - want.sourceIn) / want.speed) * fps;
          // Follow the picture unless it is plainly elsewhere (then re-cue it below). When it
          // trails by a frame or two, ease forward until it catches up rather than stopping dead.
          if (Math.abs(pictureFrame - wall) <= fps * 0.5) {
            frame = pictureFrame >= playhead.frame ? pictureFrame : playhead.frame + (wall - playhead.frame) * 0.35;
          }
        } else {
          frame = playhead.frame;
        }
      }
    }
    this.frameAtStart = frame;
    this.clockStart = now;
    if (frame >= end) {
      playhead.frame = Math.max(0, end - 1);
      this.pause();
      return;
    }
    playhead.frame = frame;
    playhead.emit();
    this.syncElements(false);
    this.draw();
  }

  /** What each media element should be doing at the playhead. */
  private wants(frame: number): Map<string, Want> {
    const project = this.project!;
    const fps = project.settings.fps;
    const videoTracks = project.tracks.filter((track) => track.kind === "video");
    const wants = new Map<string, Want>();
    for (const clip of project.clips) {
      if (frame < clip.start || frame >= clipEnd(clip)) continue;
      if (clip.type !== "video" && clip.type !== "audio") continue;
      const track = trackOf(project, clip.track);
      if (!track || (clip.type === "video" && track.hidden) || (clip.type === "audio" && track.muted)) continue;
      const time = clip.source_in + ((frame - clip.start) / fps) * clip.speed;
      const base = { key: `${clip.start}@${clip.source_in.toFixed(3)}`, time, speed: clip.speed, clipStart: clip.start, sourceIn: clip.source_in };
      const existing = wants.get(clip.media);
      if (clip.type === "audio") {
        let gain = 10 ** (clip.volume_db / 20);
        const local = frame - clip.start;
        if (clip.fade_in > 0) gain *= Math.min(1, (local + 1) / (clip.fade_in + 1));
        if (clip.fade_out > 0) gain *= Math.min(1, (clip.duration - local) / (clip.fade_out + 1));
        if (existing && Math.abs(existing.time - time) < 0.1) {
          existing.audible = true;
          existing.volume = gain;
        } else if (!existing) {
          wants.set(clip.media, { ...base, audible: true, volume: gain, rank: 0 });
        }
      } else {
        const rank = 1 + videoTracks.findIndex((candidate) => candidate.id === clip.track);
        if (!existing || Math.abs(existing.time - time) >= 0.1) {
          // Picture wins the element; sound from a different moment is dropped.
          wants.set(clip.media, { ...base, audible: false, volume: 1, rank });
        } else {
          existing.rank = Math.max(existing.rank, rank);
        }
      }
    }
    return wants;
  }

  /** The next moment each media is needed, if a clip starts within PREROLL after `frame`. */
  private upcoming(frame: number): Map<string, Want> {
    const project = this.project!;
    const fps = project.settings.fps;
    const starts = [...new Set(project.clips.filter((clip) => clip.start > frame && clip.start <= frame + fps * PREROLL).map((clip) => clip.start))].sort(
      (a, b) => a - b,
    );
    const next = new Map<string, Want>();
    for (const start of starts) {
      for (const [id, want] of this.wants(start)) if (!next.has(id) && want.clipStart === start) next.set(id, want);
    }
    return next;
  }

  /** Starts, cues and nudges elements. `hard` re-cues anything off by more than a frame (play, seek). */
  private syncElements(hard: boolean) {
    const project = this.project;
    if (!project) return;
    const fps = project.settings.fps;
    const frame = playhead.frame;
    const wants = this.wants(Math.floor(frame));
    const next = this.upcoming(Math.floor(frame));
    const master = [...wants.entries()].sort((a, b) => b[1].rank - a[1].rank)[0]?.[0];
    const busy = new Set<HTMLVideoElement>();

    // What plays now: on the roll already cued for this moment, else the nearest.
    for (const [id, want] of wants) {
      const rolls = this.rolls(id);
      const video =
        rolls.find((candidate) => this.owner.get(candidate) === want.key) ??
        rolls.reduce((best, candidate) => (Math.abs(candidate.currentTime - want.time) < Math.abs(best.currentTime - want.time) ? candidate : best));
      busy.add(video);
      this.owner.set(video, want.key);
      this.active.set(id, video);
      video.preload = "auto";
      // Only touch what changed: a rate or mute change can hitch the element's clock.
      setIfChanged(video, "playbackRate", Math.min(16, Math.max(0.0625, want.speed)));
      setIfChanged(video, "volume", want.audible ? Math.min(1, Math.max(0, want.volume)) : 0);
      setIfChanged(video, "muted", !want.audible);
      const drift = Math.abs(video.currentTime - want.time);
      // The clock follows the master, so it only needs re-cueing when it is
      // far off; followers stay within FOLLOWER_DRIFT.
      const limit = hard ? 0.5 / fps : id === master ? 0.5 : FOLLOWER_DRIFT;
      if (drift > limit && !this.seeking.has(video)) this.seekVideo(video, want.time);
      // play() on an ended element would restart it from the top.
      if (video.paused && !video.ended) void video.play().catch(() => {});
    }

    // What plays next: cued paused on its first frame on a free roll, so the cut never seeks.
    for (const [id, cue] of next) {
      const now = wants.get(id);
      // The same source carrying straight on (a split): the playing roll covers it.
      if (now && Math.abs(now.time + ((cue.clipStart - frame) / fps) * now.speed - cue.time) < 0.1) continue;
      const rolls = this.rolls(id, now ? 2 : 1);
      const video = rolls.find((candidate) => !busy.has(candidate) && this.owner.get(candidate) === cue.key) ?? rolls.find((candidate) => !busy.has(candidate));
      if (!video) continue;
      busy.add(video);
      this.owner.set(video, cue.key);
      video.preload = "auto";
      // Wait just before the cut, then run in alongside the clock (when the source has room before the cut).
      const until = (cue.clipStart - frame) / fps;
      const runIn = Math.min(RUN_IN, cue.time / cue.speed);
      const atCut = cue.time - until * cue.speed;
      if (playhead.playing && until <= runIn && atCut >= 0) {
        // Aim a frame past the cut: a roll that's late would show footage from before its in point
        // for a moment (a visible glitch), while one a frame early just skips a frame nobody sees.
        const behind = atCut + 2.5 / fps - video.currentTime;
        if (Math.abs(behind) > 0.3 && !this.seeking.has(video)) this.seekVideo(video, atCut + 2.5 / fps);
        // play() starts a beat late: run fast (or slow) in proportion to the gap so it closes before
        // the cut, without seeking. Steps of 5% keep rate writes rare.
        const nudge = Math.round(Math.max(-0.3, Math.min(0.3, behind * 2.5)) * 20) / 20;
        setIfChanged(video, "playbackRate", Math.min(16, Math.max(0.0625, cue.speed * (1 + nudge))));
        // Sound on but silent: its audio is already running when the cut makes it audible.
        setIfChanged(video, "volume", 0);
        setIfChanged(video, "muted", false);
        if (video.paused && !video.ended) void video.play().catch(() => {});
      } else {
        if (!video.paused) video.pause();
        setIfChanged(video, "muted", true);
        const waitAt = cue.time - runIn * cue.speed;
        if (Math.abs(video.currentTime - waitAt) > 0.5 / fps && !this.seeking.has(video)) this.seekVideo(video, waitAt);
      }
    }

    // Everything else rests.
    for (const video of this.allVideos()) {
      if (busy.has(video)) continue;
      if (!video.paused) video.pause();
      video.muted = true;
    }
  }

  private draw() {
    const project = this.project;
    if (!this.engine || !project) return;
    const frame = Math.floor(playhead.frame);
    let sources: { media: string; time: number }[] = [];
    try {
      sources = JSON.parse(this.use((engine) => engine.sources(frame)) ?? "[]");
    } catch {
      sources = [];
    }
    // While playing, a roll still short of its clip's in point would flash footage from before the
    // cut: keep the frame already shown for that instant instead.
    const playing = playhead.playing ? this.wants(frame) : null;
    for (const { media, time } of sources) {
      const video = this.shown(media);
      if (!video) continue;
      const want = playing?.get(media);
      if (want && video.currentTime < want.sourceIn - 0.25 / project.settings.fps && this.uploaded.has(media)) continue;
      video.preload = "auto";
      if (!playhead.playing) {
        // Show the source frame nearest `time` (the export's rule, see render.rs): an element
        // shows the frame on screen at its time, so aim half a source frame later.
        const fps = mediaOf(project, media)?.fps || 30;
        const target = time + 0.5 / fps;
        const settled = !this.seeking.has(video) && Math.abs(video.currentTime - target) < 0.5 / fps;
        if (!settled) this.seekVideo(video, target);
      }
      if (video.readyState < 2) continue;
      // Building a VideoFrame fails cleanly when the element has nothing to
      // show yet; the next seeked/loadeddata event redraws.
      let picture: VideoFrame | null = null;
      try {
        picture = new VideoFrame(video);
      } catch {
        this.retryWhenPresented(video);
        continue;
      }
      const taken = picture;
      this.use((engine) => engine.uploadFrame(media, taken));
      this.uploaded.add(media);
      taken.close();
    }
    // Match the canvas first (a no-op when unchanged): a resize can land while the
    // engine is still starting, and a stale size stretches the picture.
    const canvas = this.canvas;
    this.use((engine) => {
      if (canvas) engine.resize(canvas.width, canvas.height);
      engine.render(frame);
    });
    // A frame that rendered means any earlier restart worked.
    if (this.engine) this.restarts = 0;
  }

  /** A frame wasn't ready to copy yet: redraw once the element presents one. */
  private retryWhenPresented(video: HTMLVideoElement) {
    if (this.waitingFor.has(video)) return;
    this.waitingFor.add(video);
    const again = () => {
      this.waitingFor.delete(video);
      this.invalidate();
    };
    if ("requestVideoFrameCallback" in video) video.requestVideoFrameCallback(again);
    // Paused elements may not present again on their own; poll gently too.
    setTimeout(again, 60);
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }
}

/** Assigns a media property only when it differs (rate and mute writes can stall playback). */
function setIfChanged<K extends "playbackRate" | "volume" | "muted">(video: HTMLVideoElement, key: K, value: HTMLVideoElement[K]) {
  if (video[key] !== value) video[key] = value;
}

export const preview = new Preview();

// Handle for tests and agents driving the page (e.g. Playwright).
(window as unknown as { __edit?: unknown }).__edit = { preview, playhead };
