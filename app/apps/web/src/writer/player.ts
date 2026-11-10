/**
 * The script's player, chosen where it runs (docs/plans/2026-11-10-script-player.md).
 * In Edit.app it's the window's own player, the one the editor uses
 * (window-player.ts), whenever every recording the cut plays is a file on
 * this Mac (the server says: writer/window_sources.ts); in a browser, on
 * Linux, and for footage still only in the cloud, it's the page's
 * (playback.ts). One `Player` either way, so the monitor and everything that
 * drives it never know which.
 *
 * The choice is made again when what the cut plays from changes, and when a
 * preview that was coming down has landed: the cut moves to the other player
 * where it rests, at the same moment. A window that can't go on hands the cut
 * back to the page's player for the rest of the visit.
 *
 * Nothing is asked of the server or the window until the monitor's canvas is
 * here, and a player disposed and then used again lives again: in development
 * React's StrictMode makes every player twice (one is never shown) and
 * unmounts the one it keeps once before mounting it for good. In Edit.app
 * (Nov 10) the one never shown had opened the window's preview and the kept
 * one's dispose closed it, so `just dev` showed "the preview isn't open" and
 * a page player that never drew.
 */

import { note, recordTiming } from "../lib/diagnostics";
import { nativeAvailable, nativePreview } from "../lib/nativePreview";
import { windowSources } from "./api";
import { isCutIn } from "./clips";
import { clipStarts, editedPosition, ScriptPlayer, type Item, type Player, type Playhead } from "./playback";
import { WindowPlayer } from "./window-player";

/** While a preview is coming down, or a play is in the way of moving over, asked again this often. */
const AGAIN_MS = 15_000;

/** A script's player; `src` and `durationMs` are its own recording when it has one (`setSource`), known from the start so the choice is made once. */
export function newPlayer(clips: Item[], playhead: Playhead, src = "", durationMs = 0): Player {
  const player = nativeAvailable() ? new EitherPlayer(clips, playhead) : new ScriptPlayer(clips, playhead);
  player.setSource(src, durationMs);
  onScreen(player, playhead);
  return player;
}

/** For checks with nobody at the keys (the window's EDIT_PREVIEW_JS steps): the player on screen and which one draws. */
function onScreen(player: Player, playhead: Playhead) {
  (window as unknown as { __editScript?: unknown }).__editScript = { player, playhead, drawnBy: () => (player instanceof EitherPlayer ? player.drawnBy : "page") };
}

export class EitherPlayer implements Player {
  private clips: Item[];
  private src = "";
  private mediaMs = 0;
  private rate = 1;
  private volume = 1;
  private canvas: HTMLCanvasElement | null = null;
  private inner: Player | null = null;
  private window: WindowPlayer | null = null;
  private off: (() => void) | null = null;
  /** The window failed here: the page plays until the script is opened again. */
  private refused = false;
  /** The recordings last asked about. */
  private asked: string | null = null;
  private choosing = false;
  private stale = false;
  private again: ReturnType<typeof setTimeout> | undefined;
  /** What was asked of the transport before a player was chosen. */
  private intent: ((player: Player) => void) | null = null;
  private disposed = false;
  private listeners = new Set<() => void>();

  constructor(clips: Item[], private playhead: Playhead) {
    this.clips = clips;
  }

  /** Which player draws now. */
  get drawnBy(): "window" | "page" | "choosing" {
    return this.window !== null ? "window" : this.inner !== null ? "page" : "choosing";
  }

  get duration() {
    return this.inner?.duration ?? clipStarts(this.clips).at(-1)!;
  }
  get playing() {
    return this.inner?.playing ?? false;
  }
  get current() {
    return this.inner?.current ?? null;
  }
  get error() {
    return this.inner?.error ?? null;
  }
  get frameRatio() {
    return this.inner?.frameRatio;
  }
  get framed() {
    return this.inner?.framed ?? false;
  }
  get buffering() {
    return this.inner?.buffering ?? false;
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

  // ---- Choosing ----

  /** Every recording the cut plays from, and the script's own (an audition's). */
  private needed(): string[] {
    const srcs = new Set<string>();
    for (const clip of this.clips) if (!isCutIn(clip)) srcs.add(clip.src ?? this.src);
    srcs.add(this.src);
    srcs.delete("");
    return [...srcs];
  }

  /** Disposed and used again (StrictMode's second mount): alive, with everything to choose anew. */
  private revive() {
    if (!this.disposed) return;
    this.disposed = false;
    this.asked = null;
  }

  /** Chooses again when what the cut plays from changed (or `anew`); one choice at a time, the newest state last. Not before the monitor's canvas is here: a player nobody sees asks for nothing. */
  private choose(anew = false) {
    if (this.disposed || this.canvas === null) return;
    if (anew) this.asked = null;
    if (this.choosing) {
      this.stale = true;
      return;
    }
    this.choosing = true;
    void this.decide()
      .catch((error: unknown) => {
        note("warn", "preview", `choosing the script's player: ${error}`);
        this.usePage();
      })
      .finally(() => {
        this.choosing = false;
        if (this.stale) {
          this.stale = false;
          this.choose();
        }
      });
  }

  private async decide() {
    const srcs = this.needed();
    const key = srcs.join("\n");
    if (key === this.asked) return;
    this.asked = key;
    clearTimeout(this.again);
    if (srcs.length === 0 || this.refused) {
      this.usePage();
      return;
    }
    const found = await windowSources(srcs);
    if (this.disposed) return;
    if (found.coming.length > 0) this.again = setTimeout(() => this.choose(true), AGAIN_MS);
    if (!srcs.every((src) => found.sources[src] !== undefined)) {
      this.usePage();
      return;
    }
    if (this.window !== null) {
      this.window.setSources(found.sources);
      return;
    }
    if (this.inner?.playing) {
      // Mid-play it stays where it is, and moves over once it rests.
      clearTimeout(this.again);
      this.again = setTimeout(() => this.choose(true), AGAIN_MS);
      return;
    }
    let opened = false;
    try {
      opened = await nativePreview.open();
    } catch (error) {
      note("warn", "preview", `the window's own preview didn't open for the script: ${error}`);
    }
    if (this.disposed) {
      if (opened) void nativePreview.close().catch(() => {});
      return;
    }
    if (!opened) {
      this.refused = true;
      this.usePage();
      return;
    }
    recordTiming("script preview: window", 0);
    const player = new WindowPlayer(this.clips, this.playhead, found.sources, found.cache, (why) => this.windowLost(why));
    this.use(player, player);
  }

  private usePage() {
    if (this.disposed || (this.inner !== null && this.window === null)) return;
    this.use(new ScriptPlayer(this.clips, this.playhead), null);
  }

  private windowLost(why: string) {
    if (this.disposed || this.window === null) return;
    this.refused = true;
    recordTiming("script preview: window off", 0);
    note("warn", "preview", `the window's player stopped on the script (${why}): the page plays it`);
    this.usePage();
  }

  /** `next` takes the cut over from the player before it, at the same moment, playing if it was. */
  private use(next: Player, window: WindowPlayer | null) {
    const was = this.inner;
    const at = { ms: this.playhead.ms, sourceMs: this.playhead.sourceMs, auditioning: this.playhead.auditioning, playing: was?.playing ?? false };
    this.off?.();
    was?.dispose();
    this.inner = next;
    this.window = window;
    this.off = next.onStatus(() => this.emit());
    next.setSource(this.src, this.mediaMs);
    next.setRate(this.rate);
    next.setVolume(this.volume);
    next.attach(this.canvas);
    const intent = this.intent;
    this.intent = null;
    if (intent !== null) intent(next);
    else if (was !== null) {
      if (at.auditioning && at.playing) next.audition(at.sourceMs);
      else if (at.auditioning) next.cue(at.sourceMs);
      else {
        next.seek(at.ms);
        if (at.playing) next.play();
      }
    }
    this.emit();
  }

  /** The transport's ask: to the player, or kept for the one being chosen. */
  private ask(what: (player: Player) => void) {
    if (this.inner !== null) what(this.inner);
    else this.intent = what;
  }

  // ---- The monitor's asks ----

  attach(element: HTMLCanvasElement | null) {
    this.canvas = element;
    this.inner?.attach(element);
    if (element === null) return;
    this.revive();
    onScreen(this, this.playhead);
    this.choose();
  }

  setSource(url: string, durationMs = 0) {
    this.revive();
    this.src = url;
    this.mediaMs = durationMs;
    this.inner?.setSource(url, durationMs);
    this.choose();
  }

  update(clips: Item[]) {
    this.revive();
    this.clips = clips;
    this.inner?.update(clips);
    this.choose();
  }

  setRate(rate: number) {
    this.rate = rate;
    this.inner?.setRate(rate);
  }

  setVolume(level: number) {
    this.volume = level;
    this.inner?.setVolume(level);
  }

  seek(ms: number) {
    if (this.inner === null) {
      const to = Math.max(0, Math.min(this.duration, ms));
      this.playhead.set(to, editedPosition(this.clips, to)?.sourceMs ?? 0, false, false);
    }
    this.ask((player) => player.seek(ms));
  }

  play(from?: number) {
    this.ask((player) => player.play(from));
  }

  audition(sourceMs: number) {
    this.ask((player) => player.audition(sourceMs));
  }

  cue(sourceMs: number) {
    this.ask((player) => player.cue(sourceMs));
  }

  pause() {
    if (this.inner !== null) this.inner.pause();
    else this.intent = null;
  }

  toggle() {
    this.ask((player) => player.toggle());
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.again);
    this.off?.();
    this.inner?.dispose();
    this.inner = null;
    this.window = null;
  }
}
