/**
 * Script mode on Edit.app's own player (docs/plans/2026-11-10-script-player.md;
 * Sphe, Nov 10: "within the edits app, in the script writing section, we
 * should have the same improvements"). The script's cut is handed to the
 * window as a small edit (@edit/types/script_cut) and drawn by the engine in
 * a layer under the monitor, as the editor's viewer is (lib/nativePreview.ts):
 * the Mac's video decoder, the speaker's clock, cuts decoded ahead. So what's
 * improved there is improved here, where the page's player (playback.ts) was
 * a second one every improvement passed by.
 *
 * Behind the monitor's own `Player`, so nothing that uses one changes. At
 * rest this owns the playhead and asks the window for its frame; playing is
 * the window's, and the playhead follows where it says it is. An audition
 * (the footage straight through, outside the cut) is the same edit with one
 * clip, the whole recording. The page keeps everything over the picture: a
 * cut-in's card, the captions, the loader.
 *
 * One thing at a time goes to the window, in order (`pump`): the edit when it
 * changed, the speed, then playing or the frame to rest on, each from what's
 * wanted now, so a drag asks only for its newest position. When the window
 * can't go on (a file gone from under it, a refused edit), `lost` hands the
 * cut back to the page's player.
 */

import { auditionProject, cutProject, frameAt, msAt, type Cut, type CutSource } from "@edit/types/script_cut";

import { note, recordTiming, tell } from "../lib/diagnostics";
import { heardRun, nativePreview, playLine, type NativeRun, type NativeWhere } from "../lib/nativePreview";
import { isCutIn } from "./clips";
import { clipStarts, editedAtSource, editedPosition, sameCut, type Item, type Player, type Playhead } from "./playback";

/** A frame at rest slower than this shows the wait. */
const SLOW_MS = 150;
/** This many asks failing in a row: the page's player takes the cut back. */
const FAILURES = 3;
/** The monitor's top corners inside its 1 px border (writer.css `--radius`). */
const RADIUS = 9;
/** The edit's id in the window: one for the cut and an audition, so its decoders stay open between them. */
const EDIT_ID = "script-preview";

interface Edit {
  /** The edit as sent: what tells one from another. */
  json: string;
  cut: Cut;
  paths: Record<string, string>;
}

export class WindowPlayer implements Player {
  error: string | null = null;
  frameRatio: number | undefined;
  framed = false;
  buffering = false;

  private clips: Item[];
  private starts: number[];
  private src = "";
  private rate = 1;
  private running = false;
  private auditioning = false;
  /** The edited moment the playhead is at. */
  private offset = 0;
  /** The footage's own moment, while auditioning. */
  private offsetSource = 0;
  private disposed = false;
  private listeners = new Set<() => void>();

  /** The cut and the audition as edits, built when what they're made of changes. */
  private cutEdit: Edit | null = null;
  private auditionEdit: Edit | null = null;
  /** What the window has: the edit, its speed, whether it's playing, the frame it rests on. */
  private sent: Edit | null = null;
  private revision = 0;
  private sentRate = 1;
  private playingThere = false;
  private drawn: number | null = null;
  /** A play to start from the playhead (a play asked for, a seek while playing, a new cut under it). */
  private replay = false;
  /** The pause's own frame is the playhead's, unless something moved it since. */
  private adoptPause = false;
  /** Moves with every ask of the transport: an answer from before it is dropped. */
  private epoch = 0;
  private pumping = false;
  private dirty = false;
  private failures = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private follow = 0;
  private polling = false;
  /** The play under way in the window, for its line in the log when it ends (the editor's, `playLine`). */
  private run: NativeRun | null = null;

  private canvas: HTMLCanvasElement | null = null;
  private placing = 0;
  private placed = "";
  /** What's see-through while the layer shows under it, and <html>'s own paint before. */
  private marked: Element[] = [];
  private painted: string | null = null;

  /**
   * `sources`: each recording's address as the file the window reads; `cache`:
   * Edit's media cache; `lost`: the window can't go on, with why.
   */
  constructor(
    clips: Item[],
    private playhead: Playhead,
    private sources: Record<string, CutSource>,
    private cache: string,
    private lost: (why: string) => void,
  ) {
    this.clips = clips;
    this.starts = clipStarts(clips);
  }

  get duration() {
    return this.starts[this.starts.length - 1]!;
  }

  get playing() {
    return this.running;
  }

  get current() {
    if (this.auditioning) return null;
    return editedPosition(this.clips, this.offset)?.clip ?? null;
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

  /** The recordings changed where they're read from (one came down, another clip's footage arrived). */
  setSources(sources: Record<string, CutSource>) {
    this.sources = sources;
    this.rebuilt();
  }

  setSource(url: string) {
    if (url === this.src) return;
    this.src = url;
    this.rebuilt();
  }

  /** What the edits are made of changed: built again at the next step. */
  private rebuilt() {
    this.cutEdit = null;
    this.auditionEdit = null;
    this.kick();
  }

  // ---- The picture's place ----

  attach(canvas: HTMLCanvasElement | null) {
    cancelAnimationFrame(this.placing);
    this.placing = 0;
    this.canvas = canvas;
    if (canvas === null) {
      this.place();
      return;
    }
    // The picture is the window's, under the page: nothing of the page's own is left on the canvas over it
    // (setting a canvas's width clears it).
    const { width } = canvas;
    canvas.width = width;
    const loop = () => {
      this.placing = requestAnimationFrame(loop);
      this.place();
    };
    loop();
    this.kick();
  }

  /**
   * The window's layer under the monitor's screen, and the page see-through
   * down to it there. Out of sight in the Script view (the monitor a pixel
   * wide, so a cut plays on across views) the layer goes off the window's
   * edge, still playing.
   */
  private place() {
    const canvas = this.disposed ? null : this.canvas;
    if (canvas === null) {
      if (this.placed === "") return;
      this.placed = "";
      this.seeThrough(null);
      void nativePreview.place({ x: 0, y: 0, width: 1, height: 1 }, 0, false).catch(() => {});
      return;
    }
    const box = canvas.getBoundingClientRect();
    const seen = box.width > 2 && box.height > 2;
    const key = seen ? `${box.left},${box.top},${box.width},${box.height}` : "out of sight";
    if (key === this.placed) return;
    this.placed = key;
    this.seeThrough(seen ? canvas : null);
    const rect = seen ? { x: box.left, y: box.top, width: box.width, height: box.height } : { x: -8, y: -8, width: 2, height: 2 };
    void nativePreview.place(rect, seen ? RADIUS : 0, true).then(() => {
      // The layer's new size is drawn at the next frame asked for: asked now.
      if (this.placed !== key) return;
      this.drawn = null;
      this.kick();
    }, () => {});
  }

  /** The page see-through from <html> down to the screen under `canvas` (index.css `native-preview`, writer.css `data-window`), or as it was. */
  private seeThrough(canvas: HTMLCanvasElement | null) {
    const root = document.documentElement;
    for (const element of this.marked) element.removeAttribute("data-window");
    this.marked = [];
    if (canvas === null) {
      if (this.painted === null) return;
      root.classList.remove("native-preview");
      root.style.setProperty("background", this.painted);
      this.painted = null;
      return;
    }
    if (this.painted === null) {
      // index.html paints <html> itself (inline, before the app loads): see-through too.
      this.painted = root.style.getPropertyValue("background");
      root.style.setProperty("background", "transparent");
      root.classList.add("native-preview");
    }
    this.marked = [canvas.closest(".screen"), canvas.closest(".monitor")].filter((element): element is Element => element !== null);
    for (const element of this.marked) element.setAttribute("data-window", "");
  }

  // ---- What the window is asked ----

  private edit(): Edit | null {
    const made = (cut: Cut): Edit => ({ json: JSON.stringify(cut.project), cut, paths: Object.fromEntries(cut.project.media.map((media) => [media.id, media.path])) });
    if (this.auditioning) {
      const source = this.sources[this.src];
      if (source === undefined) return null;
      this.auditionEdit ??= made(auditionProject(EDIT_ID, this.src, source));
      return this.auditionEdit;
    }
    this.cutEdit ??= made(
      cutProject(
        EDIT_ID,
        this.clips.map((clip) => ({ startMs: clip.startMs, endMs: clip.endMs, card: isCutIn(clip), src: isCutIn(clip) ? "" : (clip.src ?? this.src) })),
        this.sources,
      ),
    );
    return this.cutEdit;
  }

  /** The playhead's frame in `edit`: the footage's own while auditioning, else the cut's. */
  private frameOf(edit: Edit): number {
    const last = Math.max(0, edit.cut.starts[edit.cut.starts.length - 1]! - 1);
    return Math.min(last, frameAt(this.auditioning ? this.offsetSource : this.offset));
  }

  private kick() {
    this.dirty = true;
    if (!this.pumping && !this.disposed) void this.pump();
  }

  private async pump() {
    this.pumping = true;
    try {
      while (this.dirty && !this.disposed) {
        this.dirty = false;
        await this.step();
        this.failures = 0;
      }
    } catch (error) {
      this.failed(error);
    } finally {
      this.pumping = false;
    }
  }

  /** One pass: the edit, the speed, then playing from the playhead or resting on its frame, each only when the window isn't there already. */
  private async step() {
    const edit = this.edit();
    if (edit === null) return;
    if (this.sent?.json !== edit.json) {
      if (this.playingThere) {
        this.playingThere = false;
        this.endRun();
        await nativePreview.pause();
      }
      await nativePreview.project(edit.json, ++this.revision, edit.paths, edit.paths, {}, this.cache);
      this.sent = edit;
      this.drawn = null;
      if (this.running) this.replay = true;
      const { width, height } = edit.cut.project.settings;
      if (this.frameRatio !== width / height) {
        this.frameRatio = width / height;
        this.emit();
      }
    }
    if (this.rate !== this.sentRate) {
      const rate = this.rate;
      await nativePreview.rate(rate);
      this.sentRate = rate;
    }
    if (this.running) {
      if (!this.replay && this.playingThere) return;
      this.replay = false;
      const epoch = this.epoch;
      try {
        await nativePreview.play(this.frameOf(edit));
      } catch (error) {
        if (!String(error).includes("at the end")) throw error;
        if (epoch === this.epoch) this.finish();
        return;
      }
      this.endRun();
      this.run = { from: this.frameOf(edit), fps: edit.cut.project.settings.fps, shown: 0, skipped: 0, slow: 0, longest: 0, starved: 0 };
      this.playingThere = true;
      this.drawn = null;
      recordTiming("script preview: play (window)", 0);
      this.following();
      return;
    }
    if (this.playingThere) {
      this.playingThere = false;
      this.endRun();
      const at = await nativePreview.pause();
      if (at !== null && this.adoptPause) this.heardAt(at);
    }
    this.adoptPause = false;
    const frame = this.frameOf(edit);
    if (frame === this.drawn) return;
    const slow = setTimeout(() => this.setBuffering(true), SLOW_MS);
    try {
      const answer = await nativePreview.frame(frame);
      if (answer?.drawn) recordTiming("script preview: window draw", answer.ms);
    } finally {
      clearTimeout(slow);
    }
    this.drawn = frame;
    this.setBuffering(false);
    this.shownFrame();
  }

  private shownFrame() {
    if (this.framed && this.error === null) return;
    this.framed = true;
    this.error = null;
    this.emit();
  }

  private setBuffering(on: boolean) {
    if (on === this.buffering) return;
    this.buffering = on;
    this.emit();
  }

  /** The window failed an ask: tried again shortly, and after a few in a row the page's player takes over. */
  private failed(error: unknown) {
    if (this.disposed) return;
    this.failures++;
    this.setBuffering(false);
    if (this.failures === 1) note("warn", "preview", `the window's player on the script: ${error}`);
    if (this.failures >= FAILURES) {
      this.lost(String(error));
      return;
    }
    // What it has is no longer known: the edit goes whole again.
    this.sent = null;
    this.playingThere = false;
    this.endRun();
    if (this.running) this.replay = true;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.kick(), 250);
  }

  // ---- Playing: the window's clock, the playhead following ----

  /** Once an animation frame while the window plays: where it is, into the playhead. */
  private following() {
    cancelAnimationFrame(this.follow);
    const tick = () => {
      this.follow = 0;
      if (!this.running || !this.playingThere || this.disposed) return;
      if (!this.polling) {
        this.polling = true;
        const epoch = this.epoch;
        nativePreview.position().then(
          (at) => {
            this.polling = false;
            if (epoch === this.epoch && this.running && this.playingThere) this.heard(at);
          },
          (error: unknown) => {
            this.polling = false;
            if (epoch === this.epoch && this.running) this.failed(error);
          },
        );
      }
      this.follow = requestAnimationFrame(tick);
    };
    this.follow = requestAnimationFrame(tick);
  }

  /** The play under way ended (a pause, a seek, the end, a new cut, a failure): its line in the log. */
  private endRun() {
    const run = this.run;
    this.run = null;
    if (run === null) return;
    const line = playLine(run, "on the script");
    if (line === null) return;
    if (line.level === "warn") note("warn", "preview", line.text);
    else tell("preview", line.text);
  }

  private heard(at: NativeWhere) {
    if (this.run !== null) heardRun(this.run, at);
    for (const ms of at.draws) recordTiming("script preview: window draw", ms);
    if (at.skipped > 0) recordTiming("script preview: window skipped frames", at.skipped);
    if (at.starved > 0) recordTiming("script preview: window sound starved", at.starved);
    if (at.problem) {
      // Its sound won't open (the recording gone from this Mac under it): the picture played on in
      // silence with nothing said (Nov 10). The page's player takes the cut, from wherever the footage is.
      this.lost(`its sound: ${at.problem}`);
      return;
    }
    if (at.ended) {
      this.playingThere = false;
      this.endRun();
      this.finish();
      return;
    }
    if (!at.playing) {
      // Stopped by itself (its layer hidden): the playhead rests where it got to.
      this.playingThere = false;
      this.endRun();
      this.running = false;
      this.epoch++;
      this.heardAt(at.frame);
      this.kick();
      return;
    }
    this.heardAt(at.frame);
    this.shownFrame();
  }

  /** The window's frame (and a fraction) into the playhead. */
  private heardAt(frame: number) {
    const ms = msAt(Math.max(0, frame));
    if (this.auditioning) {
      this.offsetSource = ms;
      const edited = editedAtSource(this.clips, ms);
      if (edited !== null) this.offset = edited;
    } else this.offset = Math.min(this.duration, ms);
    this.report();
  }

  private report() {
    if (this.auditioning) this.playhead.set(this.offset, this.offsetSource, this.running, true);
    else this.playhead.set(this.offset, editedPosition(this.clips, this.offset)?.sourceMs ?? 0, this.running, false);
  }

  /** Played to the end: the cut rests on its end; an audition's end goes back to the cut (the next Space plays it). */
  private finish() {
    this.running = false;
    this.epoch++;
    if (this.auditioning) {
      this.auditioning = false;
      this.offset = editedAtSource(this.clips, this.offsetSource) ?? this.offset;
    } else this.offset = this.duration;
    this.report();
    this.kick();
  }

  // ---- The monitor's asks ----

  update(clips: Item[]) {
    // The same cut again (the script read afresh every few seconds while it's saved): nothing to replay.
    if (sameCut(clips, this.clips)) {
      this.clips = clips;
      return;
    }
    this.clips = clips;
    this.starts = clipStarts(clips);
    this.offset = Math.min(this.offset, this.duration);
    this.epoch++;
    this.cutEdit = null;
    if (!this.auditioning) this.report();
    this.kick();
  }

  setRate(rate: number) {
    if (rate === this.rate) return;
    this.rate = rate;
    this.kick();
  }

  setVolume(level: number) {
    void nativePreview.volume(Math.max(0, Math.min(1, level))).catch(() => {});
  }

  seek(ms: number) {
    this.auditioning = false;
    this.offset = Math.max(0, Math.min(this.duration, ms));
    this.epoch++;
    this.adoptPause = false;
    if (this.running) this.replay = true;
    this.report();
    this.kick();
  }

  play(from?: number) {
    if (!this.clips.length) return;
    this.auditioning = false;
    let start = from ?? this.offset;
    if (start >= this.duration - 30) start = 0;
    this.offset = start;
    this.running = true;
    this.replay = true;
    this.epoch++;
    this.report();
    this.kick();
  }

  /** Plays the footage from a moment, outside the cut. */
  audition(sourceMs: number) {
    this.auditioning = true;
    this.offsetSource = sourceMs;
    this.running = true;
    this.replay = true;
    this.epoch++;
    this.report();
    this.kick();
  }

  /** Shows a footage moment without playing, as clicking a transcript word does. */
  cue(sourceMs: number) {
    this.running = false;
    const edited = editedAtSource(this.clips, sourceMs);
    if (edited !== null) {
      this.seek(edited);
      return;
    }
    this.auditioning = true;
    this.offsetSource = sourceMs;
    this.epoch++;
    this.adoptPause = false;
    this.report();
    this.kick();
  }

  pause() {
    if (!this.running) return;
    this.running = false;
    this.epoch++;
    this.adoptPause = true;
    this.report();
    this.kick();
  }

  toggle() {
    if (this.running) this.pause();
    else if (this.auditioning) this.audition(this.playhead.sourceMs);
    else this.play();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    this.endRun();
    cancelAnimationFrame(this.follow);
    cancelAnimationFrame(this.placing);
    clearTimeout(this.retry);
    this.canvas = null;
    this.placed = "";
    this.seeThrough(null);
    void nativePreview.close().catch(() => {});
  }
}
