// Workers decode source frames and PCM. Web Audio owns the timeline clock;
// the shared WASM compositor still evaluates and renders each complete scene.
import init, { createEngine, type Engine } from "../engine/pkg/edit_wasm";
import { api, fetchRetrying, mediaHost, mediaUrl } from "./api";
import { Decoder, videoTime } from "./decoder";
import { addContext, note, recordTiming, tell } from "./diagnostics";
import { AUDIO_CHUNK_SECONDS } from "./decoder.protocol";
import { crossfadeGain, crossfades, type SoundEdges } from "@edit/types/crossfades";
import { clipEnd, paramAt, projectDuration, validateClips, validateProject } from "./edit";
import { peopleProblem } from "./people";
import { mutePoints } from "./mutes";
import { heardRun, nativeAvailable, nativePreview, playLine, type NativeDrawn, type NativeExcerpt, type NativeRun, type NativeWhere } from "./nativePreview";
import * as patches from "./patch";
import { SmoothStream } from "./smoothStream";
import { savedFrame, saveFrame } from "./storage";
import type { Clip, Media, Project, Sections, Track } from "./types";
import { rate } from "./types";

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
  ["Akwe Pro", 700, "AkwePro-Bold.otf"],
  ["Geist", 400, "Geist-Regular.ttf"],
  ["Geist", 500, "Geist-Medium.ttf"],
  ["Geist", 600, "Geist-SemiBold.ttf"],
  ["Geist", 700, "Geist-Bold.ttf"],
  ["Geist", 900, "Geist-Black.ttf"],
  ["Montserrat", 600, "Montserrat-SemiBold.ttf"],
  ["Reenie Beanie", 400, "ReenieBeanie.ttf"],
  ["Geist Mono", 500, "GeistMono-Medium.ttf"],
  ["Geist Mono", 600, "GeistMono-SemiBold.ttf"],
  ["VT323", 400, "VT323-Regular.ttf"],
  ["Tinos", 400, "Tinos-Regular.ttf"],
  ["Tinos", 700, "Tinos-Bold.ttf"],
  ["Arimo", 400, "Arimo-Regular.ttf"],
  ["Arimo", 700, "Arimo-Bold.ttf"],
  // Drawn where a face has no glyph (Japanese): edit-render's FALLBACK_FAMILY.
  ["Noto Sans JP", 700, "NotoSansJP-Bold.ttf"],
];

let wasmReady: Promise<unknown> | null = null;
let fontBytes: Promise<[string, number, Uint8Array][]> | null = null;

type AudioClip = Extract<Clip, { type: "audio" }>;

/**
 * An audio clip as its sound plays: a cut's crossfade starts it early and
 * carries it on past its end (`edges`, @edit/types/crossfades, as the export's
 * edit-core `audio_segments`), so `start`, `duration` and `source_in` are the
 * sound's (frames, maybe fractional), and `clip` is the clip itself.
 */
type Sound = AudioClip & { clip: AudioClip; edges: SoundEdges | null };
interface PictureSource { clip: string; media: string; time: number }
/** A stretch of a clip's sound queued on the audio clock, and what it was cut from. */
interface ScheduledSound { source: AudioBufferSourceNode; gain: GainNode; mute?: GainNode; clip: string; url: string }
const BUFFERING_BADGE_MS = 600;
/** Waiting this long for a frame is noted for problem reports, and the viewer offers one. */
const STUCK_MS = 10_000;
/** After a decoding failure, the preview tries again this soon. */
const DECODE_RETRY_MS = 4_000;
const LOOK_AHEAD = 1;
/** How far (s) a scrub-tier frame already decoded stands in for the dragged playhead's. */
const SCRUB_STAND_IN = 0.25;
const AUDIO_AHEAD = 0.8;
const START_LEAD = 0.05;
/** After the playhead rests this long, its sound is decoded so Play starts at once. */
const SETTLE_MS = 300;
/** Seeks closer together than this are one drag. */
const DRAG_GAP_MS = 150;
/** Source seconds a decoded picture may be from the wanted one and still stand in mid-drag. */
const STAND_IN_REACH = 3;
/** A patch to the window's edit bigger than this goes whole instead. */
const PATCH_MOST = 512 * 1024;
/** A window frame slower than this is reported with what made it slow (two frames at 60 fps). */
const NATIVE_SLOW_MS = 33;


/** What each media is decoded from in Edit.app's window and what its sound is read from, the local excerpts of streamed ones, and the media cache. */
type NativeSources = { cache: string; sources: Record<string, string>; sounds: Record<string, string>; excerpts: Record<string, NativeExcerpt[]> };
/** The window's player is asked where it is this often at most while it plays (once an animation frame otherwise). */
const NATIVE_HINT_GAP_MS = 100;
/** What changed between two snapshots of the project, made once and shared by the engine's and the window's patches. */
type Change = { from: Project; to: Project; patch: patches.Patch };

/** Whether a change touches nothing but clips (and the next id handed out): what the engines patch in place. */
function clipsOnly(patch: patches.Patch): boolean {
  return Object.keys(patch.set).every((key) => key === "next_id") && patch.unset.length === 0 && Object.keys(patch.lists).every((key) => key === "clips");
}

class Preview {
  engine: Engine | null = null;
  /**
   * Edit.app's window draws the picture (lib/nativePreview.ts): the page's
   * engine still reads the edit (its sections) but draws nothing, and nothing
   * is decoded here. At rest the playhead is the page's and each frame is
   * asked for; playing is the window's, on its speaker's clock (the sound is
   * mixed there), and the page follows its position. Off in a browser, in
   * full screen (the window's layer isn't in the full-screen one), and after
   * the window fails a frame five times running (the page draws again, as before).
   */
  native = false;
  /** The window can't draw it this session (it failed, or refused to open). */
  private nativeRefused = false;
  /** Full screen, or anything else the window's layer can't show under: the page draws. */
  private nativeAllowed = true;
  /** The edit or what its pictures are decoded from changed since the window had them. */
  private nativeStale = true;
  /** What each media is decoded from in the window, for this project and these versions (`nativeKey`). */
  private nativeSources: NativeSources | null = null;
  /** The media's preview versions the page last had (what the window's sources are asked for with). */
  private versions: Record<string, string> = {};
  private nativeKey = "";
  private nativeBusy = false;
  private nativeWanted: number | null = null;
  private nativeDrawn: number | null = null;
  private nativeFailures = 0;
  /**
   * The window's edit: the last revision sent, the one it said it draws, and
   * the project and sources it has (what the next change is a patch of; null:
   * send it whole). A drag sent the whole 2.4 MB project ten times a second
   * (Cops Realize, Nov 8: 26 MB/s through the window's IPC); a patch is the
   * clip that moved.
   */
  private nativeRevision = 0;
  private nativeAccepted = 0;
  private nativeHas: { project: Project; sources: NativeSources; revision: number } | null = null;
  private nativeSending = false;
  /** How the window's frames went (`diagnostics.nativeFrames`, and the once-a-minute `ui:` timings). */
  private nativeStats = { draws: [] as number[], decodes: [] as number[], drawn: 0, skipped: 0, passed: 0, failed: 0, opens: 0, seeks: 0, streamed: 0, behind: 0, patches: 0, wholes: 0, refused: 0, off: null as string | null,
    played: 0, playedSkipped: 0, playedSlow: 0, starved: 0 };
  private nativeAsked: number | null = null;
  /** The play on the window's clock under way, for its line in the log when it ends. */
  private nativeRun: NativeRun | null = null;
  /** A play on the window's clock (each play a generation, so a stale answer is known), and whether its position is being asked for. */
  private nativePlay = 0;
  /** The speed the window's player has (null: not told since it opened; a newly opened one plays at 1), and the asks to it, one after another. */
  private nativeSpeed: number | null = null;
  private speedAsk: Promise<void> = Promise.resolve();
  private nativePolling = false;
  private nativeHinted = 0;
  /** The project the page's engine holds (what the next change is a patch of; null: send it whole). */
  private engineHas: Project | null = null;
  /** The last change to the project, for the engine's and the window's patches. */
  private change: Change | null = null;
  sections: Sections | null = null;
  error: string | null = null;
  /** The error is the engine refusing the project (cleared when it takes one). */
  private refused = false;
  buffering = false;
  /** A frame of this project has been shown: until then the viewer says it's loading, in its middle. */
  framed = false;
  /** Waiting on a frame for long enough that something's probably wrong. */
  stuck = false;
  private waitingSince: number | undefined;
  /** What the wait was for, for its timing: smooth or live, playing or paused. */
  private waitingKind = "";
  private stuckTimer: ReturnType<typeof setTimeout> | undefined;
  private bufferingTimer: ReturnType<typeof setTimeout> | undefined;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private canvas: HTMLCanvasElement | null = null;
  private restarts = 0;
  private project: Project | null = null;
  /** The engine hasn't seen the latest project yet: it's sent once per frame, before drawing. */
  private engineStale = false;
  private clips: Clip[] = [];
  private clipsById = new Map<string, Clip>();
  /** The heard sounds by track (by start), with their crossfades' reach; and the clips whose crossfades changed with the last edit. */
  private soundsByTrack = new Map<string, Sound[]>();
  private soundEdges = new Map<string, SoundEdges | null>();
  private reshaped = new Set<string>();
  private tracks = new Map<string, Track>();
  private media = new Map<string, Media>();
  private sources = new Map<string, string>();
  private sounds = new Map<string, string>();
  private duration = 0;
  private persistedAt = 0;
  private renderedFrame: number | null = null;
  private copied = new Map<string, VideoFrame>();
  private pendingScenes = new Map<number, { serial: number; sources: PictureSource[] }>();
  private seekSerial = 0;
  private settled = true;
  private dragging = false;
  private lastSeekAt = -Infinity;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
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
  /** When a streamed render was last asked for what's near the playhead while it played. */
  private poked = 0;
  /**
   * Smooth playback: the edit rendered small (apps/server/src/playback_render.ts),
   * played and scrubbed as a video instead of drawing it live, when it shows
   * what's on screen (the team, Oct 31: "currently super laggy! we have too
   * many loading frame issues"). Null draws live.
   */
  private smooth: string | null = null;
  private video: HTMLVideoElement | null = null;
  /**
   * A render played a chunk at a time (`stream:<project>:<rev>`,
   * smoothStream.ts): only where its chunks are appended is it shown, the
   * rest drawn live; its sound plays from `streamSound`.
   */
  private stream: SmoothStream | null = null;
  /**
   * The scrub tier (apps/server/src/scrub.ts): per media, which pieces of
   * `seconds` of its source are made, 960×540 with every frame a keyframe.
   * Read only while the playhead is dragged.
   */
  private scrub: { project: string; seconds: number; ready: Map<string, Set<number>> } | null = null;
  private scrubAskedAt = 0;
  private scrubLookedAt = 0;
  private streamSound: HTMLAudioElement | null = null;
  /** The rendered video is what the viewer shows (playing, or paused on its frame). */
  smoothShown = false;
  /**
   * How fast it plays: 1, or 2 to watch an edit through in half the time (JJ,
   * Nov 10: "a button where we can speed up when watching the video. like in
   * premiere"), the sound sped with it at its own pitch. Whichever player
   * plays: the window's, the render's, the page's own.
   */
  speed = 1;
  private listeners = new Set<Listener>();
  private decoder = new Decoder(() => this.invalidate(), (error, key) => {
    const media = key === undefined ? undefined : [...this.sources, ...this.sounds].find(([, url]) => url === key)?.[0];
    const name = media === undefined ? undefined : this.media.get(media)?.name ?? media;
    const message = `Preview decoding failed${name === undefined ? "" : ` in ${name}`}: ${error}`;
    this.error = message; note("error", "preview", this.error);
    this.pause();
    this.setBuffering(false);
    this.notify();
    // Most failures are the network's (a dropped or slow connection): try again
    // on its own shortly, rather than waiting for a reload.
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.error !== message) return;
      this.error = null;
      this.notify();
      this.invalidate();
    }, DECODE_RETRY_MS);
  });
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * The frame on screen: the canvas's, or the rendered video's own while that
   * shows (none while it's still seeking there). The canvas's alone went stale
   * the moment a smooth render took over, so acceptance read every scrub after
   * it as stuck (Nov 10, a real Mac: "frame 23 drawn (269 asked)" with the
   * right picture on screen; put down to slow decoding on GitHub's Mac).
   */
  private shownFrame(): number | null {
    if (!this.smoothShown) return this.renderedFrame;
    const video = this.video;
    if (!video || !this.project || video.seeking || video.readyState < 2) return null;
    return Math.floor(video.currentTime * rate(this.project.settings));
  }

  get diagnostics() {
    return { ...this.decoder.stats, ...this.playbackStats, renderedFrame: this.shownFrame(), nativeFrames: this.nativeReport(),
      videoCacheBytes: this.decoder.pictures.bytes, videoCacheFrames: this.decoder.pictures.size,
      audioCacheBytes: this.decoder.sound.bytes, scheduledAudio: this.scheduled.size, mediaReads: this.decoder.network,
      // Whether sound can come out at all: a context that never started (or was suspended) plays nothing.
      audioOutput: this.audio ? { state: this.audio.state, sampleRate: this.audio.sampleRate, currentTime: Math.round(this.audio.currentTime * 100) / 100 } : null,
      clockRunning: this.runningClock };
  }

  onStatus = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The viewer's video element, which shows smooth playback over the canvas. */
  attachVideo(video: HTMLVideoElement | null) {
    this.video?.removeEventListener("waiting", this.onVideoWaiting);
    this.video?.removeEventListener("playing", this.onVideoPlaying);
    this.video?.removeEventListener("seeked", this.onVideoPlaying);
    this.video?.removeEventListener("loadeddata", this.onVideoPlaying);
    this.video = video;
    if (video) video.playbackRate = this.speed;
    video?.addEventListener("waiting", this.onVideoWaiting);
    video?.addEventListener("playing", this.onVideoPlaying);
    video?.addEventListener("seeked", this.onVideoPlaying);
    video?.addEventListener("loadeddata", this.onVideoPlaying);
    if (video && this.smooth) this.useSmooth(this.smooth);
  }

  private onVideoWaiting = () => { if (this.smoothShown) this.setBuffering(true); };
  private onVideoPlaying = () => { if (this.smoothShown) { this.setBuffering(false); if (!this.framed) { this.framed = true; this.notify(); } } };

  /**
   * The rendered file for what's on screen, or null when there's none (an
   * edit since): with one, play and scrub show it; without, the canvas draws
   * live (a smooth playback that goes stale while playing pauses there).
   */
  setSmooth(url: string | null) {
    // The window draws the edit live, at the screen's rate: no render to play.
    if (this.native) url = null;
    if (url === this.smooth) return;
    this.smooth = url;
    this.stream?.close();
    this.stream = null;
    if (url !== null) { this.useSmooth(url); return; }
    if (!this.smoothShown) return;
    const playing = playhead.playing;
    if (playing) this.pause();
    this.video?.pause();
    this.smoothShown = false;
    this.renderedFrame = null;
    this.notify();
    this.invalidate();
  }

  private useSmooth(url: string) {
    const video = this.video;
    if (!video || !this.project) return;
    const streamed = /^stream:([^:]+):(\d+)$/.exec(url);
    if (streamed !== null && this.stream === null) {
      this.streamSound ??= new Audio();
      this.stream = new SmoothStream(streamed[1]!, Number(streamed[2]), rate(this.project.settings), this.duration, () => playhead.frame, this.streamSound, () => {
        // Its chunk at the resting playhead just came: shown there now.
        if (!playhead.playing && !this.smoothShown && this.smooth === url) this.showSmooth(playhead.frame);
      });
    }
    const src = this.stream?.url ?? url;
    if (video.getAttribute("src") !== src) video.src = src;
    if (playhead.playing && !this.smoothShown) return; // live playback carries on; the next play is smooth
    this.showSmooth(playhead.frame);
  }

  /** Whether the render shows `frame` (and the next `ahead` frames) now: a streamed one only where its chunks are in. */
  private smoothAt(frame: number, ahead = 0): boolean {
    return this.stream === null || this.stream.covers(frame, ahead);
  }

  /**
   * Stops the rendered video and its sound together. Leaving smooth
   * playback by only hiding it left both playing on their own clocks —
   * the video under the live picture, its sound under the live sound
   * (two sounds at once after a scrub past the render's chunks, Nov 3).
   */
  private stopSmooth() {
    if (this.video && !this.video.paused) this.video.pause();
    if (this.stream) this.stream.follow(this.video?.currentTime ?? 0, false);
  }

  /**
   * Plays at `speed` from here on, where it is if it's playing: the window's
   * player is told, the render plays at it, and the page's own clock starts
   * again at the playhead with the sound cut for the new speed.
   */
  setSpeed(speed: number) {
    if (speed === this.speed) return;
    this.speed = speed;
    if (this.video) this.video.playbackRate = speed;
    if (this.native) void this.sendSpeed();
    else if (playhead.playing && !this.smoothShown) this.resetClock();
    this.notify();
  }

  /**
   * Tells the window's player the speed, when it has another. One that
   * refuses (a window built before it had speeds) plays at 1×, and the
   * button goes back to saying so.
   */
  private sendSpeed(): Promise<void> {
    this.speedAsk = this.speedAsk.then(async () => {
      const speed = this.speed;
      if (!this.native || speed === this.nativeSpeed) return;
      try {
        await nativePreview.rate(speed);
        this.nativeSpeed = speed;
      } catch (error) {
        if (this.nativeSpeed === null && speed === 1) { this.nativeSpeed = 1; return; }
        note("warn", "preview", `the window's player didn't take ${speed}× speed: ${error}`);
        if (this.speed === speed) { this.speed = this.nativeSpeed ?? 1; this.notify(); }
      }
    });
    return this.speedAsk;
  }

  /** Puts the rendered video at `frame` (a hair into it, so it never lands on the frame before); drawn live where a streamed render has nothing yet. */
  private showSmooth(frame: number) {
    const video = this.video;
    if (!video || !this.project) return;
    this.stream?.poke();
    if (!this.smoothAt(frame)) {
      if (this.smoothShown) {
        this.smoothShown = false;
        this.stopSmooth();
        this.renderedFrame = null;
        this.notify();
        this.invalidate();
      }
      return;
    }
    const time = (Math.floor(frame) + 0.25) / rate(this.project.settings);
    if (Math.abs(video.currentTime - time) > 0.5 / rate(this.project.settings)) video.currentTime = time;
    if (!this.smoothShown) {
      this.smoothShown = true;
      this.stopSounds();
      this.notify();
    }
    // Already on its frame (no seek, so no "seeked" to say so): shown now. Opened at frame 0 with the
    // render in, nothing seeked or played, and the viewer said "Loading the preview…" over the picture
    // until play was pressed (Sphe, Nov 12, the bodycam HQ test).
    if (!video.seeking && video.readyState >= 2) this.onVideoPlaying();
  }

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
      if (this.project) this.sendProject(engine, this.project);
      this.engineStale = false;
      for (const [media, levels] of this.peaks) if (levels instanceof Uint8Array) engine.setPeaks(media, levels);
      this.readSections();
      await this.openNative(generation);
      if (generation !== this.generation) return;
      this.setBuffering(false);
      this.notify();
      this.invalidate();
    } catch (error) {
      if (generation !== this.generation) return;
      this.error = `Preview failed to start: ${error}`; note("error", "preview", this.error);
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

  /** Edit.app's window takes the drawing, when it can (`native`). */
  private async openNative(generation: number) {
    if (this.native || this.nativeRefused || !this.nativeAllowed || !nativeAvailable()) return;
    try {
      const opened = await nativePreview.open();
      if (generation !== this.generation) return;
      if (!opened) {
        this.nativeRefused = true;
        this.nativeOff("refused open", "the window can't draw it on this Mac");
        return;
      }
      this.native = true;
      this.nativeSpeed = null;
      this.nativeStale = true;
      this.nativeHas = null;
      this.nativeDrawn = null;
      this.nativeFailures = 0;
      this.nativeStats.off = null;
      this.framed = false;
      this.setSmooth(null);
      recordTiming("preview: native", 0);
      // A new window plays at 1×: told the speed now, the sound it makes ready at rest is at that speed, so the first play starts at once.
      if (this.speed !== 1) void this.sendSpeed();
    } catch (error) {
      this.nativeRefused = true;
      this.nativeOff("refused open", `the window's own preview didn't open: ${error}`);
    }
  }

  /** Why the window stopped drawing (or never did), for the reports: a `ui:` timing per reason, and a warning with the detail. */
  private nativeOff(reason: "full screen" | "failed" | "refused open" | "refused edit", detail: string | null) {
    this.nativeStats.off = detail === null ? reason : `${reason}: ${detail}`;
    recordTiming(`preview: native off (${reason})`, 0);
    if (detail !== null) note("warn", "preview", detail);
  }

  /** Whether Edit.app's window draws the picture here whenever it may (not refused this session): full screen hands it to the page for a while. */
  get nativeHere(): boolean {
    return nativeAvailable() && !this.nativeRefused;
  }

  private nativeReport() {
    const s = this.nativeStats;
    const at = (list: number[], q: number) => { const sorted = [...list].sort((a, b) => a - b); return sorted.length === 0 ? null : Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] * 10) / 10; };
    return { on: this.native, here: this.nativeHere, off: s.off, revision: this.nativeRevision, accepted: this.nativeAccepted, behind: s.behind,
      drawn: s.drawn, skipped: s.skipped, passedOver: s.passed, failed: s.failed, patches: s.patches, wholes: s.wholes, refused: s.refused,
      played: s.played, playedSkipped: s.playedSkipped, playedSlow: s.playedSlow, starved: s.starved,
      drawMs: { p50: at(s.draws, 0.5), p90: at(s.draws, 0.9), max: at(s.draws, 1) }, decodeMs: { p50: at(s.decodes, 0.5), p90: at(s.decodes, 0.9) },
      opens: s.opens, seeks: s.seeks, streamedReads: s.streamed,
      streamedSources: this.nativeSources === null ? null : Object.values(this.nativeSources.sources).filter((source) => source.startsWith("http")).length };
  }

  /**
   * The page draws again: the window failed (`refuse`), or can't show it now
   * (full screen). Playing on the window's clock goes on here (`resume`) on
   * the page's own.
   */
  private leaveNative(refuse: string | null, resume = true) {
    if (!this.native) return;
    const playing = playhead.playing;
    if (playing) this.pause();
    this.native = false;
    if (refuse !== null) {
      this.nativeRefused = true;
      this.nativeOff(refuse.startsWith("the window refused the edit") ? "refused edit" : "failed", `the window's own preview stopped (${refuse}): the page draws it`);
    }
    void nativePreview.close().catch(() => {});
    this.nativeBusy = false;
    this.renderedFrame = null;
    this.copied.clear();
    this.notify();
    this.invalidate();
    if (playing && resume) this.play();
  }

  /** Whether the window may draw the picture now (not in full screen). */
  setNativeAllowed(allowed: boolean) {
    if (allowed === this.nativeAllowed) return;
    this.nativeAllowed = allowed;
    if (!allowed) {
      if (this.native) this.nativeOff("full screen", null);
      this.leaveNative(null);
    } else if (this.engine) void this.openNative(this.generation).then(() => { this.notify(); this.invalidate(); });
  }

  /** The window's sources for this project, asked again when its media or their versions change. */
  private nativeSourcesFor(project: Project, versions: Record<string, string>) {
    const key = `${project.id}|${project.media.map((media) => `${media.id}:${media.path}:${versions[media.id] ?? ""}`).join(",")}`;
    if (key === this.nativeKey) return;
    this.nativeKey = key;
    api.nativeSources(project.id).then((given) => {
      if (this.nativeKey !== key) return;
      const found = { ...given, sounds: given.sounds ?? {}, excerpts: given.excerpts ?? {} };
      const before = JSON.stringify(this.nativeSources ?? null);
      this.nativeSources = found;
      if (JSON.stringify(found) !== before) {
        this.nativeStale = true;
        this.invalidate();
      }
      // A cloud preview still streamed comes down whole behind it (the server's native_preview.ts): asked again until it's here.
      if (Object.values(found.sources).some((source) => source.startsWith("http"))) {
        setTimeout(() => {
          if (this.nativeKey !== key || this.project?.id !== project.id) return;
          this.nativeKey = "";
          this.nativeSourcesFor(project, versions);
        }, 15_000);
      }
    }).catch((error: unknown) => {
      if (this.nativeKey === key) this.nativeKey = "";
      note("warn", "preview", `the window's preview sources: ${error}`);
    });
  }

  /**
   * What the window decodes from, asked again now: the server's cleaner took
   * a copy the window was reading (its `native-sources` event), or a frame
   * failed, which a file gone from under it does.
   */
  refreshNativeSources() {
    if (!this.project || !nativeAvailable()) return;
    this.nativeKey = "";
    this.nativeSourcesFor(this.project, this.versions);
  }

  /**
   * The edit into the window, once it and its sources are known; at most once
   * a frame and one at a time: only what changed since the revision it has
   * (lib/patch.ts), whole when it has none, the sources changed, or a patch
   * didn't fit. A refused edit leaves the window's picture behind the page's
   * engine, so the page draws instead.
   */
  private syncNative() {
    if (!this.nativeStale || this.nativeSending || !this.project || this.nativeSources === null) return;
    if (!this.nativeKey.startsWith(`${this.project.id}|`)) return;
    this.nativeStale = false;
    this.nativeDrawn = null;
    const project = this.project;
    const sources = this.nativeSources;
    const has = this.nativeHas;
    let patch: string | null = null;
    if (has !== null && has.sources === sources && has.project.id === project.id && has.revision === this.nativeAccepted) {
      const change = this.changeSince(has.project, project);
      if (patches.empty(change)) return;
      patch = JSON.stringify(change);
      // A change touching most of the edit goes whole: parsing it is the same work, and it can't not fit.
      if (patch.length > PATCH_MOST) patch = null;
    }
    const revision = ++this.nativeRevision;
    this.nativeSending = true;
    const sent = patch !== null && has !== null
      ? nativePreview.patch(has.revision, revision, patch)
      : nativePreview.project(projectJson(project), revision, sources.sources, sources.sounds, sources.excerpts, sources.cache);
    if (patch !== null) this.nativeStats.patches++; else this.nativeStats.wholes++;
    sent.then((accepted) => {
      this.nativeSending = false;
      this.nativeAccepted = accepted;
      const first = this.nativeHas?.project.id !== project.id;
      this.nativeHas = { project, sources, revision: accepted };
      // The first edit of this project taken: the frame the playhead's on can be drawn now.
      if (this.nativeStale || first) this.invalidate();
    }, (error: unknown) => {
      this.nativeSending = false;
      if (!this.native) return;
      if (patch !== null) {
        // Out of step (or a patch that didn't fit): the whole edit next.
        this.nativeHas = null;
        this.nativeStale = true;
        this.invalidate();
        return;
      }
      this.nativeStats.refused++;
      this.leaveNative(`the window refused the edit: ${error}`);
    });
  }

  /** The playhead's frame drawn by the window; one at a time, the newest asked for next. */
  private drawNative() {
    if (!this.project || this.error) return;
    this.syncNative();
    // Only once the window has taken this project's edit: asked while it's on its way, the window had none ("no edit to
    // draw yet" at every open on JJ's Mac, Nov 10) or, opening another project, drew the one before's frame.
    if (this.nativeHas === null || this.nativeHas.project.id !== this.project.id) return;
    // Playing, the window draws the clock's frames itself; the page only follows (`followNative`).
    if (playhead.playing) return;
    const wanted = Math.floor(playhead.frame);
    this.nativeWanted = wanted;
    if (this.nativeBusy || wanted === this.nativeDrawn) return;
    // Frames the playhead went past while the window was busy with one before: never shown.
    if (playhead.playing && this.nativeAsked !== null && wanted > this.nativeAsked + 1) this.nativeStats.passed += wanted - this.nativeAsked - 1;
    this.nativeAsked = wanted;
    this.nativeBusy = true;
    // The badge only for a frame that's slow, not each one asked for.
    const slow = setTimeout(() => this.setBuffering(true), 150);
    nativePreview.frame(wanted).then((answer) => {
      clearTimeout(slow);
      this.nativeBusy = false;
      if (!this.native) return;
      this.nativeDrawn = wanted;
      this.nativeFailures = 0;
      this.nativeFrame(answer);
      this.setBuffering(false);
      if (!this.framed) { this.framed = true; this.notify(); }
      if (this.nativeWanted !== wanted || this.nativeStale) this.drawNative();
    }, (error: unknown) => {
      clearTimeout(slow);
      this.nativeBusy = false;
      this.nativeFailed(error);
    });
  }

  /** A frame's answer, into the diagnostics: its time and where it went, and whether it shows an older edit than the page's. */
  private nativeFrame(answer: NativeDrawn | undefined) {
    if (answer === undefined || answer === null) return;
    const s = this.nativeStats;
    if (answer.revision !== undefined && answer.revision < this.nativeRevision && !this.nativeSending) s.behind++;
    if (answer.skipped) { s.skipped++; return; }
    if (!answer.drawn) return;
    s.drawn++;
    s.draws.push(answer.ms);
    s.decodes.push(answer.decode);
    if (s.draws.length > 600) { s.draws.shift(); s.decodes.shift(); }
    s.opens += answer.opens;
    s.seeks += answer.seeks;
    s.streamed += answer.ffmpeg;
    recordTiming("preview: native draw", answer.ms);
    if (answer.ms > NATIVE_SLOW_MS) recordTiming(answer.ffmpeg > 0 ? "preview: native slow draw (streamed)" : answer.opens > 0 ? "preview: native slow draw (opened)" : "preview: native slow draw (seek)", answer.ms);
  }

  /** Plays from the playhead on the window's clock, the page following its position. */
  private playNative() {
    const from = Math.floor(playhead.frame);
    // A play from somewhere else while playing (a seek) is a play of its own.
    this.endNativeRun();
    if (this.project) this.nativeRun = { from, fps: rate(this.project.settings), shown: 0, skipped: 0, slow: 0, longest: 0, starved: 0 };
    const generation = ++this.nativePlay;
    playhead.playing = true;
    this.playedFrom = from;
    this.pendingScenes.clear();
    recordTiming("preview: play (native)", 0);
    playhead.emit();
    cancelAnimationFrame(this.queued);
    this.queued = 0;
    cancelAnimationFrame(this.loop);
    this.loop = 0;
    // The speed first, then the play at it; a pause meanwhile, and nothing is played.
    this.sendSpeed().then(() => (generation === this.nativePlay && playhead.playing && this.native ? nativePreview.play(from) : null)).then(() => {
      if (generation !== this.nativePlay || !playhead.playing) return;
      this.followNative(generation);
    }, (error: unknown) => {
      if (generation !== this.nativePlay || !playhead.playing) return;
      if (String(error).includes("at the end")) { this.pause(); return; }
      note("warn", "preview", `the window's player didn't start: ${error}`);
      this.pause();
    });
  }

  /** Once an animation frame while the window plays: where it is, into the playhead; the end stops here. */
  private followNative(generation: number) {
    const tick = () => {
      this.loop = 0;
      if (!playhead.playing || generation !== this.nativePlay || !this.native) return;
      if (!this.nativePolling) {
        this.nativePolling = true;
        nativePreview.position().then((at) => {
          this.nativePolling = false;
          if (!playhead.playing || generation !== this.nativePlay) return;
          this.nativePosition(at);
        }, (error: unknown) => {
          this.nativePolling = false;
          if (!playhead.playing || generation !== this.nativePlay) return;
          this.nativeFailed(error);
          this.pause();
        });
      }
      if (playhead.playing) this.loop = requestAnimationFrame(tick);
    };
    this.loop = requestAnimationFrame(tick);
  }

  /** The play under way ended: its line in the log. */
  private endNativeRun() {
    const run = this.nativeRun;
    this.nativeRun = null;
    if (run === null) return;
    const line = playLine(run);
    if (line === null) return;
    if (line.level === "warn") note("warn", "preview", line.text);
    else tell("preview", line.text);
  }

  /** The window's position: into the playhead and the diagnostics; its end pauses here. */
  private nativePosition(at: NativeWhere) {
    const s = this.nativeStats;
    s.played += at.drawn;
    s.playedSkipped += at.skipped;
    s.playedSlow += at.slow;
    s.starved += at.starved;
    if (this.nativeRun !== null) heardRun(this.nativeRun, at);
    for (const ms of at.draws) {
      s.drawn++;
      s.draws.push(ms);
      recordTiming("preview: native draw", ms);
      if (ms > NATIVE_SLOW_MS) recordTiming("preview: native slow draw (playing)", ms);
    }
    while (s.draws.length > 600) s.draws.shift();
    if (at.skipped > 0) recordTiming("preview: native skipped frames", at.skipped);
    if (at.starved > 0) recordTiming("preview: native sound starved", at.starved);
    if (at.ended || !at.playing) {
      playhead.frame = Math.max(0, Math.floor(at.frame));
      this.pause();
      return;
    }
    playhead.frame = Math.max(0, at.frame);
    if (!this.framed) { this.framed = true; this.notify(); }
    this.setBuffering(false);
    if (performance.now() - this.persistedAt >= 1000) this.remember();
    playhead.emit();
  }

  /**
   * The playhead is about to land on `frame` (a hover over the timeline's
   * ruler, a note picked): the window makes its pictures ready, so the jump
   * lands without a seek on the drawing path.
   */
  hint(frame: number) {
    if (!this.native || !Number.isFinite(frame)) return;
    const now = performance.now();
    if (now - this.nativeHinted < NATIVE_HINT_GAP_MS) return;
    this.nativeHinted = now;
    void nativePreview.hint(Math.max(0, Math.floor(frame))).catch(() => {});
  }

  private nativeFailed(error: unknown) {
    if (!this.native) return;
    this.nativeFailures++;
    this.nativeStats.failed++;
    if (this.nativeFailures === 1) note("warn", "preview", `the window's preview: ${error}`);
    if (this.nativeFailures >= 5) { this.leaveNative(String(error)); return; }
    // A file gone from under it (the cleaner took a copy) fails a frame: what it reads is asked for again.
    this.refreshNativeSources();
    this.nativeStale = true;
    setTimeout(() => this.invalidate(), 250);
  }

  /** The GPU device went away (see Engine.isLost): start over on the same canvas. */
  private recover() {
    if (!this.canvas || this.attaching) return;
    console.warn("edit: preview lost its GPU device; restarting it");
    this.retire();
    void this.attach(this.canvas);
  }

  /**
   * Runs an engine call. A Rust panic poisons the WASM instance, so a panic
   * retires this engine and builds a fresh one on the same canvas instead of
   * letting the error escape into React. A project it refuses is
   * `sendProject`'s, which keeps the engine.
   */
  /**
   * The project into the engine. One it refuses (its model's rules: a page
   * older than the server checks with the old ones) is said on the preview,
   * never a black frame: a preview built before people's white bystanders
   * were allowed showed Mom Leaves 5 Kids as black from start to end.
   */
  private sendProject(engine: Engine, project: Project) {
    const has = this.engineHas;
    if (has !== null && has.id === project.id && has !== project) {
      // Only what changed, when it's clips: the whole edit parsed again took 63 ms a move in Chrome (Nov 8).
      const change = this.changeSince(has, project);
      if (patches.empty(change)) { this.engineHas = project; return; }
      if (clipsOnly(change)) {
        try {
          engine.applyPatch(JSON.stringify(change));
          this.engineHas = project;
          this.accepted();
          return;
        } catch (error) {
          if (error instanceof WebAssembly.RuntimeError) throw error;
          // Its rules refuse the step (a drag through two clips overlapping): the last picture stays.
          return;
        }
      }
    }
    try {
      engine.setProject(projectJson(project));
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) throw error;
      this.engineHas = null;
      this.refuse(error instanceof Error ? error.message : String(error));
      return;
    }
    this.engineHas = project;
    this.accepted();
  }

  /** The engine took the project: a refusal said before is over. */
  private accepted() {
    if (this.refused) {
      this.refused = false;
      this.error = null;
      this.notify();
    }
  }

  /** What changed from `from` to `to`: the change made in `setProject` when it's that step, else diffed now. */
  private changeSince(from: Project, to: Project): patches.Patch {
    const change = this.change;
    if (change !== null && change.from === from && change.to === to) return change.patch;
    return patches.diff(from, to);
  }

  /** A project the page's rules or its engine refuse: said on the preview, never a black frame. */
  /** The last colour warning noted, so it's noted once. */
  private warned: string | null = null;

  private refuse(problem: string) {
    if (this.refused && this.error?.includes(problem)) return;
    this.refused = true;
    this.error = `The preview can't show this project: ${problem}. If Edit was just updated, reload the page.`;
    note("error", "preview", this.error);
    this.notify();
  }

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
        this.error = "The preview stopped. Reload the page to restart it."; note("error", "preview", this.error);
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
    this.engineHas = null;
    this.renderedFrame = null;
    this.copied.clear();
  }

  detach() {
    this.leaveNative(null, false);
    this.nativeKey = "";
    this.nativeSources = null;
    this.nativeHas = null;
    this.setBuffering(false);
    this.remember();
    this.canvas = null;
    this.generation++;
    this.attaching = false;
    this.pause();
    cancelAnimationFrame(this.queued);
    this.queued = 0;
    clearTimeout(this.settleTimer);
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
    // People's colours (one per person) are the server's and the engine's to
    // police: a page whose copy of that rule is out of step only warns, and the
    // picture still shows (Judge EXPLODES showed nothing over a courtroom rule
    // the page lacked).
    const colours = peopleProblem(project);
    if (colours !== null && colours !== this.warned) {
      this.warned = colours;
      note("warn", "preview", `the page's colour check: ${colours} (shown anyway)`);
    }
    const previous = this.project;
    const changedSource = previous?.id !== project.id;
    // What changed, once: the engine's and the window's patches are cut from it, and so is the check below.
    const change: Change | null = previous !== null && !changedSource && previous !== project ? { from: previous, to: project, patch: patches.diff(previous, project) } : null;
    // A step that moves clips alone (a drag) is checked by the clips it touched, not the whole 2 MB edit.
    const problem = change !== null && clipsOnly(change.patch)
      ? validateClips(project, change.patch.lists.clips?.put.map((clip) => (clip as Clip).id) ?? [])
      : validateProject(project, { people: false });
    if (problem) {
      // A drag can pass through an invalid state: the last valid picture
      // stays. With none of this project yet, say why there's nothing.
      if (changedSource) this.refuse(problem);
      return;
    }
    this.change = change;
    if (change !== null && clipsOnly(change.patch) && proxyVersions === this.versions) {
      // Clips alone changed (a drag's move): the lists by time, id and track and the length are made again;
      // media, tracks, sound files, peaks and the window's sources are as they were, and nothing is said
      // to the viewer (making it all again took 12 ms a move on Cops Realize's 3,000 clips, Nov 9).
      const clips = change.patch.lists.clips;
      const changed = new Set<string>(clips?.remove ?? []);
      for (const put of clips?.put ?? []) changed.add((put as Clip).id);
      for (const id of clips?.remove ?? []) this.use((engine) => engine.forgetVideo(id));
      for (const id of changed) this.copied.delete(id);
      this.project = project;
      this.error = null;
      this.refused = false;
      this.renderedFrame = null;
      this.pendingScenes.clear();
      this.seekSerial++;
      this.renderedScrub = -1;
      this.index(project);
      if ((clips?.put ?? []).some((put) => (put as Clip).type === "audio")) this.loadPeaks(project);
      if ([...this.scheduled.values()].some((sound) => this.outdated(sound, changed))) this.resetClock();
      this.engineStale = true;
      this.nativeStale = true;
      this.invalidate();
      return;
    }
    if (changedSource) {
      this.remember();
      this.pause();
      this.setSmooth(null);
      this.decoder.dispose();
      this.sources.clear();
      this.sounds.clear();
      this.copied.clear();
      this.peaks.clear();
      this.use((engine) => engine.clearPeaks());
      playhead.frame = savedFrame(project.id);
      playhead.emit();
    }
    // Clips are shared between snapshots (shareProject, Immer), so a changed clip is a new object.
    const before = changedSource ? new Map<string, Clip>() : this.clipsById;
    const changed = new Set<string>();
    const ids = new Set(project.clips.map((clip) => clip.id));
    for (const clip of previous?.clips ?? []) if (!ids.has(clip.id)) {
      this.use((engine) => engine.forgetVideo(clip.id));
      changed.add(clip.id);
    }
    for (const clip of project.clips) if (before.get(clip.id) !== clip) changed.add(clip.id);
    // Pictures already on the GPU stay for the clips that didn't change.
    for (const id of changed) this.copied.delete(id);
    if (previous?.id !== project.id) this.framed = false;
    this.project = project;
    this.error = null;
    this.refused = false;
    this.renderedFrame = null;
    this.pendingScenes.clear();
    this.seekSerial++;
    this.renderedScrub = -1;
    this.index(project);
    this.tracks = new Map(project.tracks.map((track) => [track.id, track]));
    this.media = new Map(project.media.map((media) => [media.id, media]));
    // Picture and sound are separate preview files, so decoding sound never downloads video.
    // The light preview is picture only: sound keeps coming from the preview's.
    // Versions are "source", "preview~<stamp>" or "light~<light stamp>~<preview stamp>"
    // (the light file is picture only: sound still comes from the preview's).
    const url = (media: Media, kind: "proxy" | "audio") => {
      const [which, ...stamps] = (proxyVersions[media.id] ?? "source").split("~");
      const light = which === "light";
      const file = kind === "proxy" && light ? "light" : kind;
      const named = !light ? [which, ...stamps] : kind === "audio" ? ["preview", stamps[1]] : ["light", stamps[0]];
      return `${mediaUrl(project.id, media.id, file)}?v=${named.filter((part) => part !== undefined && part !== "").join("~")}`;
    };
    const nextSources = new Map(project.media.map((media) => [media.id, url(media, "proxy")]));
    const nextSounds = new Map(project.media.map((media) => [media.id, url(media, "audio")]));
    for (const [id, url] of this.sources) if (nextSources.get(id) !== url) this.decoder.forget(url);
    for (const [id, url] of this.sounds) if (nextSounds.get(id) !== url) this.decoder.forget(url);
    this.sources = nextSources;
    this.sounds = nextSounds;
    this.loadPeaks(project);
    // Sound already queued keeps playing (nothing re-buffers) unless what it was cut from changed.
    if ((previous ? rate(previous.settings) : undefined) !== rate(project.settings) || [...this.scheduled.values()].some((sound) => this.outdated(sound, changed))) {
      this.resetClock();
    }
    this.engineStale = true;
    this.nativeStale = true;
    this.versions = proxyVersions;
    if (nativeAvailable()) this.nativeSourcesFor(project, proxyVersions);
    this.notify();
    this.invalidate();
  }

  /** The clips by time and by id, the edit's length, and the sounds by track. */
  private index(project: Project) {
    this.clips = [...project.clips].sort((a, b) => a.start - b.start);
    this.clipsById = new Map(project.clips.map((clip) => [clip.id, clip]));
    this.duration = projectDuration(project);
    // Each sound as it plays, its crossfades' sound before and after it included.
    const fps = rate(project.settings);
    const reach = crossfades(project);
    const was = this.soundEdges;
    this.soundEdges = new Map();
    this.reshaped.clear();
    this.soundsByTrack.clear();
    for (const clip of this.clips) {
      if (clip.type !== "audio") continue;
      const edges = reach.get(clip.id) ?? null;
      const old = was.get(clip.id) ?? null;
      if (old?.lead !== edges?.lead || old?.tail !== edges?.tail || old?.crossIn !== edges?.crossIn || old?.crossOut !== edges?.crossOut) this.reshaped.add(clip.id);
      const lead = (edges?.lead ?? 0) * fps;
      const tail = (edges?.tail ?? 0) * fps;
      const sound: Sound = { ...clip, start: clip.start - lead, duration: clip.duration + lead + tail, source_in: clip.source_in - (edges?.lead ?? 0) * clip.speed, clip, edges };
      this.soundEdges.set(clip.id, edges);
      const list = this.soundsByTrack.get(clip.track) ?? [];
      list.push(sound);
      this.soundsByTrack.set(clip.track, list);
    }
  }

  /** A queued sound whose clip changed, went quiet or now reads another file. */
  private outdated(sound: ScheduledSound, changed: Set<string>) {
    const clip = this.clipsById.get(sound.clip);
    return changed.has(sound.clip) || this.reshaped.has(sound.clip) || !clip || !this.audible(clip) || this.sounds.get(clip.media) !== sound.url;
  }

  /**
   * Sends the project to the engine. A change (each move of a drag) only marks
   * it stale; this runs at most once per frame, before anything reads the engine.
   */
  private syncEngine() {
    if (!this.engineStale || !this.engine || !this.project) return;
    this.engineStale = false;
    const project = this.project;
    this.use((engine) => this.sendProject(engine, project));
    this.readSections();
    this.notify();
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
    // Seeks in quick succession are a drag (or a held key): rough pictures until it rests.
    const now = performance.now();
    this.dragging = now - this.lastSeekAt < DRAG_GAP_MS;
    // The scrub tier is the page player's; the window reads its whole copies.
    if (this.dragging && !this.native) this.keepScrubbing(frame);
    this.lastSeekAt = now;
    this.direction = frame < playhead.frame ? -1 : 1;
    this.seekSerial++;
    playhead.frame = Math.max(0, Math.round(frame));
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.remember(), 200);
    this.settled = false;
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => { this.settled = true; this.invalidate(); }, SETTLE_MS);
    this.resetClock();
    if (this.smooth) this.showSmooth(playhead.frame);
    if (this.native && playhead.playing) { this.playNative(); return; }
    playhead.emit();
    this.invalidate();
  }

  seekEnd() { this.seek(this.project ? projectDuration(this.project) : 0); }
  toggle() { if (playhead.playing) this.pause(); else this.play(); }

  play() {
    if (!this.project || playhead.playing || this.duration <= 0 || this.error) return;
    if (playhead.frame >= this.duration - 1) playhead.frame = 0;
    if (this.smooth && this.video && this.smoothAt(playhead.frame, Math.round(rate(this.project.settings)))) {
      recordTiming("preview: play (smooth)", 0);
      this.playSmooth(this.video);
      return;
    }
    if (this.native) { this.playNative(); return; }
    recordTiming("preview: play (live)", 0);
    // Live from here: the render (hidden since a scrub past its chunks) is silent first.
    this.stopSmooth();
    playhead.playing = true;
    this.pendingScenes.clear();
    this.direction = 1;
    this.playedFrom = playhead.frame;
    // Unlock audio in the user gesture, even for edits whose first shot is silent.
    this.audio ??= new AudioContext({ latencyHint: "interactive" });
    void this.audio.resume().catch((error) => {
      this.error = `Audio failed to start: ${error}`; note("error", "preview", this.error); this.pause(); this.notify();
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

  /** Plays the rendered video from the playhead; the video's clock moves the playhead. */
  private playSmooth(video: HTMLVideoElement) {
    const project = this.project!;
    const fps = rate(project.settings);
    playhead.playing = true;
    this.playedFrom = playhead.frame;
    this.resetClock();
    this.showSmooth(playhead.frame);
    // A streamed render's sound is its own element's.
    video.muted = this.stream !== null;
    // A new file in the element starts at 1× again.
    video.playbackRate = this.speed;
    this.stream?.follow(video.currentTime, true, this.speed);
    void video.play().catch((error: unknown) => {
      // Refused (no user gesture, a file that won't play): drawn live instead.
      note("warn", "preview", `smooth playback didn't start: ${error}`);
      if (!playhead.playing) return;
      this.pause();
      this.smooth = null;
      this.smoothShown = false;
      this.notify();
      this.play();
    });
    playhead.emit();
    cancelAnimationFrame(this.queued);
    this.queued = 0;
    const tick = () => {
      this.loop = 0;
      if (!playhead.playing || !this.smoothShown) return;
      const frame = video.currentTime * fps - 0.25;
      const out = project.mark_out ?? null;
      if (out !== null && this.playedFrom < out && frame >= out && out < this.duration) { playhead.frame = out; this.pause(); return; }
      if (video.ended || frame >= this.duration - 1) { playhead.frame = Math.max(0, this.duration - 1); this.pause(); return; }
      playhead.frame = Math.max(0, frame);
      if (this.stream !== null) {
        // Half a second from a chunk not in yet: carried on live from here.
        if (!this.stream.covers(frame, Math.round(fps / 2))) {
          video.pause();
          this.stream.follow(video.currentTime, false);
          playhead.playing = false;
          this.smoothShown = false;
          this.renderedFrame = null;
          this.notify();
          this.play();
          return;
        }
        this.stream.follow(video.currentTime, true, this.speed);
        if (performance.now() - this.poked >= 1000) { this.poked = performance.now(); this.stream.poke(); }
      }
      if (performance.now() - this.persistedAt >= 1000) this.remember();
      playhead.emit();
      this.loop = requestAnimationFrame(tick);
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
    if (this.native && playing) {
      this.endNativeRun();
      // The window stops its clock; where it rested is the playhead (it's told after, a frame at most from the last position).
      const generation = ++this.nativePlay;
      nativePreview.pause().then((at) => {
        if (at === null || playhead.playing || generation !== this.nativePlay || !this.native) return;
        if (playhead.frame !== at) { playhead.frame = at; playhead.emit(); }
        this.invalidate();
      }, () => {});
    }
    // Whether or not the render is what's shown: nothing of it plays on
    // behind a pause (it once did, after a scrub had hidden it).
    if (this.video && !this.video.paused) {
      const shown = this.smoothShown;
      this.stopSmooth();
      if (shown && this.project) playhead.frame = Math.max(0, this.video.currentTime * rate(this.project.settings) - 0.25);
    } else if (this.stream) {
      this.stream.follow(this.video?.currentTime ?? 0, false);
    }
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
    const fps = rate(this.project.settings);
    let frame = this.runningClock
      ? this.frameAtStart + Math.max(0, this.audio.currentTime - this.clockStart) * fps * this.speed
      : playhead.frame;
    const out = this.project.mark_out ?? null;
    if (out !== null && this.playedFrom < out && frame >= out && out < this.duration) {
      playhead.frame = out; this.pause(); return;
    }
    if (frame >= this.duration) {
      playhead.frame = Math.max(0, this.duration - 1); this.pause(); return;
    }
    this.syncEngine();
    const scene = { frame: Math.floor(frame), sources: this.sceneSources(Math.floor(frame)) };
    const { sources } = scene;
    this.warm(scene.frame, sources);
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
    this.draw(scene);
    if (performance.now() - this.persistedAt >= 1000) this.remember();
    playhead.emit();
  }

  /**
   * Sounds playing at `frame` or starting by `until`. A track's sounds overlap
   * only where a cut crossfades, so each track's that started by `frame` are
   * looked at back to the first still playing.
   */
  private soundsAround(frame: number, until: number): Sound[] {
    const found: Sound[] = [];
    for (const sounds of this.soundsByTrack.values()) {
      let lo = 0, hi = sounds.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sounds[mid].start <= frame) lo = mid + 1; else hi = mid;
      }
      for (let i = lo - 1; i >= 0 && i >= lo - 2; i--) if (frame < clipEnd(sounds[i])) found.push(sounds[i]);
      for (let i = lo; i < sounds.length && sounds[i].start <= until; i++) found.push(sounds[i]);
    }
    return found;
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
    const scrubbed = this.scrubbed(source);
    if (scrubbed !== null) {
      const time = videoTime(scrubbed.time, media.fps, scrubbed.seconds);
      const found = this.decoder.picture(scrubbed.key, time);
      if (found) return found;
    }
    const time = media.kind === "image" ? 0 : videoTime(source.time, media.fps, media.duration);
    return this.decoder.picture(url, time);
  }

  private picturesReady(sources: PictureSource[]) { return sources.every((source) => Boolean(this.picture(source))); }

  /**
   * Pictures near enough to stand in mid-drag (the keyframes a rough scrub
   * decodes), from within each clip, so the frame's graphics land on time
   * while its footage catches up. Null when any source has none.
   */
  private standIns(sources: PictureSource[]) {
    const pictures: VideoFrame[] = [];
    for (const source of sources) {
      let picture = this.picture(source);
      const media = this.media.get(source.media);
      const clip = this.clipsById.get(source.clip);
      // Dragged through the scrub tier: its nearest frame decoded (a few frames behind at most) before the
      // proxy's keyframe (else the proxy's stand-in showed at every position, the tier's frames landing after).
      const scrubbed = picture ? null : this.scrubbed(source);
      if (scrubbed !== null && media) {
        const time = videoTime(scrubbed.time, media.fps, scrubbed.seconds);
        picture = this.decoder.nearbyPicture(scrubbed.key, time, SCRUB_STAND_IN, Math.max(0, time - SCRUB_STAND_IN), time + SCRUB_STAND_IN);
      }
      if (!picture && media && clip?.type === "video") {
        const time = videoTime(source.time, media.fps, media.duration);
        picture = this.decoder.nearbyPicture(this.sources.get(source.media)!, time, STAND_IN_REACH * Math.max(1, clip.speed),
          Math.max(0, clip.source_in - 0.5 / (media.fps || 30)), clip.source_in + clip.duration / rate(this.project!.settings) * clip.speed);
      }
      if (!picture) return null;
      pictures.push(picture);
    }
    return pictures;
  }

  /** Where a dragged playhead's picture of `source` comes from in the scrub tier, when its piece is made. */
  private scrubbed(source: PictureSource): { key: string; url: string; time: number; seconds: number } | null {
    const scrub = this.scrub;
    const media = this.media.get(source.media);
    if (scrub === null || !media || media.kind !== "video" || playhead.playing || !this.dragging || this.settled) return null;
    const time = videoTime(source.time, media.fps, media.duration);
    const piece = Math.floor(time / scrub.seconds);
    if (!scrub.ready.get(source.media)?.has(piece)) return null;
    return {
      key: `scrub|${source.media}|${piece}`,
      url: mediaHost(`/api/projects/${encodeURIComponent(scrub.project)}/scrub/${encodeURIComponent(source.media)}/${piece}`),
      time: time - piece * scrub.seconds,
      seconds: Math.min(scrub.seconds, Math.max(media.duration - piece * scrub.seconds, 0)),
    };
  }

  /** As a drag goes: the pieces around the playhead asked for, and what's made looked at again (every few seconds at most). */
  private keepScrubbing(frame: number) {
    const project = this.project;
    if (!project) return;
    const now = performance.now();
    const fps = rate(project.settings);
    if (now - this.scrubAskedAt > 5000) {
      this.scrubAskedAt = now;
      void fetch(`/api/projects/${encodeURIComponent(project.id)}/scrub`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: Math.max(0, Math.floor(frame - 60 * fps)), to: Math.floor(frame + 120 * fps) }),
      }).catch(() => {});
    }
    if (now - this.scrubLookedAt > 2000) {
      this.scrubLookedAt = now;
      void fetch(`/api/projects/${encodeURIComponent(project.id)}/scrub`).then((answer) => (answer.ok ? answer.json() : null)).then((given: { seconds: number; ready: Record<string, number[]> } | null) => {
        if (given === null || this.project?.id !== project.id) return;
        this.scrub = { project: project.id, seconds: given.seconds, ready: new Map(Object.entries(given.ready).map(([media, pieces]) => [media, new Set(pieces)])) };
      }).catch(() => {});
    }
  }

  private requestPicture(source: PictureSource, lanes: Set<string>) {
    const media = this.media.get(source.media);
    const url = this.sources.get(source.media);
    if (!media || !url) return;
    const lane = `v:${source.clip ?? source.media}`;
    lanes.add(lane);
    const clip = this.clipsById.get(source.clip);
    const speed = clip?.type === "video" ? clip.speed : 1;
    const scrubbed = this.scrubbed(source);
    if (media.kind === "image") this.decoder.requestImage(url, url);
    // Dragged: the scrub tier's frame itself (every one a keyframe), where its piece is made.
    else if (scrubbed !== null) this.decoder.requestRough(scrubbed.key, scrubbed.url, lane, scrubbed.time, media.fps || 30, scrubbed.seconds, 0.5 / (media.fps || 30));
    else if (!playhead.playing && this.dragging && !this.settled) this.decoder.requestRough(url, url, lane, source.time, media.fps || 30, media.duration);
    else this.decoder.requestVideo(url, url, lane, source.time, media.fps || 30, media.duration,
      playhead.playing ? 1 : this.direction, playhead.playing, speed * (playhead.playing ? this.speed : 1) / rate(this.project!.settings));
  }

  private warm(frame: number, sources: PictureSource[]) {
    if (!this.project) return;
    const fps = rate(this.project.settings);
    const lanes = new Set<string>();
    for (const source of sources) this.requestPicture(source, lanes);
    // Scrubbing needs one picture, not concurrent audio and future-cut decodes.
    if (!playhead.playing) {
      if (this.settled) for (const sound of this.soundsAround(frame, frame)) if (sound.start <= frame) this.requestSound(sound, frame, lanes);
      this.decoder.retain(lanes);
      return;
    }
    // Cue upcoming cuts, including a different moment of the same source.
    let lo = 0, hi = this.clips.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.clips[mid].start <= frame) lo = mid + 1; else hi = mid;
    }
    const upcoming: Clip[] = [];
    for (let i = lo; i < this.clips.length && this.clips[i].start <= frame + fps * this.speed * LOOK_AHEAD; i++) upcoming.push(this.clips[i]);
    for (const clip of upcoming) if (clip.type === "video" && !this.tracks.get(clip.track)?.hidden) {
      this.requestPicture({ clip: clip.id, media: clip.media, time: clip.source_in }, lanes);
    }
    for (const sound of this.soundsAround(frame, frame + fps * this.speed * LOOK_AHEAD)) this.requestSound(sound, frame, lanes);
    this.decoder.retain(lanes);
  }

  private requestSound(clip: Clip, frame: number, lanes: Set<string>) {
    if (!this.audible(clip)) return;
    const media = this.media.get(clip.media)!;
    const url = this.sounds.get(clip.media)!;
    const time = clip.source_in + Math.max(0, frame - clip.start) / rate(this.project!.settings) * clip.speed;
    if (time >= media.duration) return;
    const lane = `a:${clip.id}`;
    lanes.add(lane);
    this.decoder.requestAudio(url, url, lane, time, media.duration, this.stretch(clip));
  }

  /** How much faster than its recording a clip's sound plays: its own speed, and the player's (at rest too, so the sound it warms is what the next play needs). */
  private stretch(clip: AudioClip) {
    return clip.speed * this.speed;
  }

  private audioReady(frame: number, ahead: number) {
    if (!this.project) return true;
    const fps = rate(this.project.settings);
    const until = frame + ahead * fps * this.speed;
    return this.soundsAround(frame, until).every((clip) => {
      if (!this.audible(clip)) return true;
      const media = this.media.get(clip.media)!;
      const time = clip.source_in + Math.max(0, frame - clip.start) / fps * clip.speed;
      if (time >= media.duration) return true;
      const end = Math.min(media.duration, clip.source_in + (Math.min(until, clipEnd(clip)) - clip.start) / fps * clip.speed);
      const first = Math.floor((time + 1e-8) / AUDIO_CHUNK_SECONDS);
      const last = Math.max(first, Math.floor((end - 1e-8) / AUDIO_CHUNK_SECONDS));
      for (let chunk = first; chunk <= last; chunk++) if (!this.decoder.pcm(this.sounds.get(clip.media)!, chunk, this.stretch(clip))) return false;
      return true;
    });
  }

  private scheduleAudio(frame: number) {
    const project = this.project;
    const audio = this.audio;
    if (!project || !audio) return;
    const fps = rate(project.settings);
    // Frames of the edit that go by in a second of the speaker's clock.
    const pace = fps * this.speed;
    const until = frame + pace * AUDIO_AHEAD;
    for (const clip of this.soundsAround(frame, until)) {
      if (!this.audible(clip)) continue;
      const url = this.sounds.get(clip.media)!;
      const media = this.media.get(clip.media)!;
      const time = clip.source_in + Math.max(0, frame - clip.start) / fps * clip.speed;
      const first = Math.floor(time / AUDIO_CHUNK_SECONDS);
      const last = Math.floor((clip.source_in + (Math.min(until, clipEnd(clip)) - clip.start) / fps * clip.speed) / AUDIO_CHUNK_SECONDS);
      for (let chunk = first; chunk <= last; chunk++) {
        const key = `${clip.id}@${chunk}`;
        if (this.scheduled.has(key)) continue;
        const stretch = this.stretch(clip);
        const pcm = this.decoder.pcm(url, chunk, stretch);
        if (!pcm) continue;
        const start = Math.max(frame, clip.start, clip.start + (pcm.start - clip.source_in) / clip.speed * fps);
        const end = Math.min(clipEnd(clip), clip.start + (Math.min(media.duration, pcm.start + AUDIO_CHUNK_SECONDS) - clip.source_in) / clip.speed * fps);
        if (end <= start) continue;
        const offset = clip.source_in + (start - clip.start) / fps * clip.speed - pcm.start;
        const when = this.clockStart + (start - this.frameAtStart) / pace;
        const late = Math.max(0, audio.currentTime - when);
        const length = (end - start) / pace - late;
        if (length <= 0) continue;
        const buffer = audio.createBuffer(pcm.channels.length, pcm.channels[0].length, pcm.sampleRate);
        // One side in both ears when the clip says so, as the export's mix (mix.rs OneSide).
        const side = clip.channel === "left" ? pcm.channels[0] : clip.channel === "right" ? (pcm.channels[1] ?? pcm.channels[0]) : null;
        pcm.channels.forEach((channel, index) => buffer.copyToChannel(side ?? channel, index));
        const source = audio.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = 1; // Worker PCM is already stretched, with pitch preserved.
        const gain = audio.createGain();
        const at = Math.max(audio.currentTime, when);
        // Automation follows the same frame fades, crossfades and volume keys as the native mixer.
        const crossIn = (clip.edges?.crossIn ?? 0) * fps;
        const crossOut = (clip.edges?.crossOut ?? 0) * fps;
        for (let sample = start + late * pace; sample <= end;) {
          const local = sample - clip.start;
          // The volume keys are the clip's own, from its start (a crossfade's lead holds the first).
          let volume = 10 ** (paramAt(clip.clip, "volume_db", Math.max(sample, clip.clip.start)) / 20);
          // A cut's crossfade on the equal-power curve, else the clip's own fade: linear from silence at its start
          // and to silence at its end, as the export's (mix.rs fade_gain).
          if (crossIn > 0) volume *= crossfadeGain(local / crossIn);
          else if (clip.fade_in > 0) volume *= Math.min(1, Math.max(0, local / clip.fade_in));
          if (crossOut > 0) volume *= crossfadeGain((clip.duration - local) / crossOut);
          else if (clip.fade_out > 0) volume *= Math.min(1, Math.max(0, (clip.duration - local) / clip.fade_out));
          const t = at + (sample - start - late * pace) / pace;
          if (sample === start + late * pace) gain.gain.setValueAtTime(volume, t);
          else gain.gain.linearRampToValueAtTime(volume, t);
          if (sample === end) break;
          // A quarter frame at a time through a crossfade, so its curve is followed, not cut into straight lines.
          const curving = (crossIn > 0 && local < crossIn) || (crossOut > 0 && clip.duration - local < crossOut);
          sample = Math.min(end, sample + (curving ? 0.25 : 1));
        }
        // Mutes (source seconds) on a gain of their own, at their exact times with the export's cosine ramps.
        let mute: GainNode | undefined;
        if (clip.mutes?.length) {
          mute = audio.createGain();
          const playedFrom = start + late * pace;
          const sourceAt = (frameAt: number) => clip.source_in + (frameAt - clip.start) / fps * clip.speed;
          const contextAt = (time: number) => at + ((time - clip.source_in) / clip.speed * fps + clip.start - playedFrom) / pace;
          mutePoints(clip.mutes, sourceAt(playedFrom), sourceAt(end)).forEach(([time, value], index) => {
            if (index === 0) mute!.gain.setValueAtTime(value, at);
            else mute!.gain.linearRampToValueAtTime(value, contextAt(time));
          });
          source.connect(gain).connect(mute).connect(audio.destination);
        } else source.connect(gain).connect(audio.destination);
        source.start(at, Math.max(0, offset / stretch + late), length);
        const scheduled = { source, gain, mute, clip: clip.id, url };
        source.onended = () => {
          source.disconnect(); gain.disconnect(); mute?.disconnect();
          if (this.scheduled.get(key) === scheduled) this.scheduled.delete(key);
        };
        this.scheduled.set(key, scheduled);
      }
    }
  }

  private stopSounds() {
    for (const { source, gain, mute } of this.scheduled.values()) {
      source.onended = null;
      try { source.stop(); } catch { /* Already ended. */ }
      source.disconnect(); gain.disconnect(); mute?.disconnect();
    }
    this.scheduled.clear();
  }

  /** `scene`: the sources a playback tick already looked up (and warmed) for its frame. */
  private draw(scene?: { frame: number; sources: PictureSource[] }) {
    if (this.native) {
      this.syncEngine();
      this.drawNative();
      return;
    }
    if (!this.engine || !this.project || this.error) return;
    // The rendered video shows this frame: nothing to decode or draw live.
    if (this.smoothShown) { this.syncEngine(); return; }
    if (this.use((engine) => engine.isLost())) { this.recover(); return; }
    this.syncEngine();
    const wanted = Math.floor(playhead.frame);
    const reuse = scene?.frame === wanted;
    const sources = reuse ? scene.sources : this.sceneSources(wanted);
    if (!reuse) this.warm(wanted, sources);
    let frame = wanted;
    let selected = sources;
    const ready = this.picturesReady(sources);
    let standIns: VideoFrame[] | null = null;
    if (!playhead.playing) {
      this.pendingScenes.set(wanted, { serial: this.seekSerial, sources });
      while (this.pendingScenes.size > 32) this.pendingScenes.delete(this.pendingScenes.keys().next().value!);
      if (!ready) standIns = this.standIns(sources);
      if (!ready && !standIns) {
        // Display the newest completed request as a complete scene, never a new
        // title over old footage. The final cursor position stays queued for exact landing.
        const completed = [...this.pendingScenes].reverse().find(([, scene]) => scene.serial > this.renderedScrub && this.picturesReady(scene.sources));
        if (!completed) { this.setBuffering(true); return; }
        frame = completed[0];
        selected = completed[1].sources;
        this.renderedScrub = completed[1].serial;
      }
    }
    const pictures: VideoFrame[] = standIns ?? [];
    if (!standIns) for (const source of selected) {
      let picture = this.picture(source);
      if (!picture && playhead.playing) {
        const media = this.media.get(source.media);
        const clip = this.clipsById.get(source.clip);
        if (media && clip?.type === "video") {
          const time = videoTime(source.time, media.fps, media.duration);
          picture = this.decoder.nearbyPicture(this.sources.get(source.media)!, time, 0.12 * clip.speed,
            Math.max(0, clip.source_in - 0.5 / (media.fps || 30)), clip.source_in + clip.duration / rate(this.project.settings) * clip.speed);
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
    if (!this.framed) { this.framed = true; this.notify(); }
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
      if (this.waitingSince === undefined) {
        this.waitingSince = performance.now();
        this.waitingKind = `${this.smoothShown ? "smooth" : "live"}, ${playhead.playing ? "playing" : "paused"}`;
        this.stuckTimer = setTimeout(() => {
          this.stuck = true; this.notify();
          note("warn", "preview", `Still waiting for frame ${Math.floor(playhead.frame)} after ${STUCK_MS / 1000} s`);
        }, STUCK_MS);
      }
      if (!this.buffering && this.bufferingTimer === undefined) this.bufferingTimer = setTimeout(() => {
        this.bufferingTimer = undefined; this.buffering = true; this.notify();
      }, BUFFERING_BADGE_MS);
    } else {
      if (this.waitingSince !== undefined) {
        recordTiming(`preview: waiting for a frame (${this.waitingKind})`, performance.now() - this.waitingSince);
        this.waitingSince = undefined;
        clearTimeout(this.stuckTimer);
        if (this.stuck) { this.stuck = false; this.notify(); }
      }
      clearTimeout(this.bufferingTimer); this.bufferingTimer = undefined;
      if (this.buffering) { this.buffering = false; this.notify(); }
    }
  }
}

/** Each clip's JSON, kept while the clip object is (snapshots share unchanged clips). */
const clipJson = new WeakMap<Clip, string>();

/**
 * The project as JSON for the engine. Clips are most of it and a drag changes
 * a few, so each clip's text is made once and reused while the clip is unchanged.
 */
export function projectJson(project: Project) {
  const { clips, ...rest } = project;
  const head = JSON.stringify(rest);
  const parts = clips.map((clip) => {
    let json = clipJson.get(clip);
    if (json === undefined) clipJson.set(clip, (json = JSON.stringify(clip)));
    return json;
  });
  return `${head.slice(0, -1)}${head.length > 2 ? "," : ""}"clips":[${parts.join(",")}]}`;
}

export const preview = new Preview();
// The server's cleaner took a copy the window reads (lib/store.ts hears it): asked again before the next jump fails on it.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") window.addEventListener("edit:native-sources", () => preview.refreshNativeSources());
addContext("Preview", () => ({
  error: preview.error,
  waiting: preview.buffering,
  stuck: preview.stuck,
  playhead: Math.floor(playhead.frame),
  playing: playhead.playing,
  native: preview.native,
  ...preview.diagnostics,
}));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") preview.wake();
  else { preview.remember(); preview.pause(); }
});
window.addEventListener("pagehide", () => preview.remember());
(window as unknown as { __edit?: unknown }).__edit = { preview, playhead };
