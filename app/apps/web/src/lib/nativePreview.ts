/**
 * Edit.app's native preview (crates/edit-window/src/preview.rs,
 * docs/plans/2026-11-06-native-player.md): the engine draws the viewer's
 * picture in a layer under the page, from the Mac's video decoder, where the
 * page decoded and drew every frame in WebKit. Only in Edit.app's window (a
 * browser has no window to ask). At rest the page owns the playhead and asks
 * for each frame; playing is the window's, on its speaker's clock (the sound
 * mixed there as the export mixes it), and the page follows its position.
 * The page keeps everything over the picture, and goes back to drawing it
 * itself if the window can't.
 */

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

const invoke = (): Invoke | null => {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__;
  return typeof internals?.invoke === "function" ? internals.invoke : null;
};

/** Whether this page is in Edit.app's window, which can draw the preview itself. */
export const nativeAvailable = (): boolean => invoke() !== null && /Mac/.test(navigator.platform);

const call = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
  const run = invoke();
  if (run === null) throw new Error("not in Edit.app");
  return run(command, args);
};

/** Seconds `from..to` of a streamed source in a file here (a pieced proxy's piece): the window reads it instead. */
export interface NativeExcerpt { from: number; to: number; path: string }

/** A frame's answer: the revision on screen, whether it was drawn (else on screen already, or a newer ask took its place) and where its time went (ms). */
export interface NativeDrawn {
  revision: number;
  drawn: boolean;
  skipped: boolean;
  ms: number;
  decode: number;
  composite: number;
  present: number;
  opens: number;
  seeks: number;
  ffmpeg: number;
}

/**
 * Where the window's player is: the playhead (a frame and a fraction), whether it's playing and whether it
 * reached the end since the last ask, and how playing went since then: frames drawn, frames the clock passed
 * undrawn, slow draws (over 33 ms), their times (ms), the speaker's output calls that ran short of sound, and
 * why the sound went silent when it did.
 */
export interface NativeWhere {
  frame: number;
  playing: boolean;
  ended: boolean;
  drawn: number;
  skipped: number;
  slow: number;
  draws: number[];
  starved: number;
  /** The sound went silent since the last ask, and why (a file that won't open: gone from this Mac). */
  problem?: string;
}

/**
 * The window has one player, opened by whichever screen shows a picture (the
 * editor's viewer, the script's monitor) and closed as it leaves. A close
 * still under way gives the page its background back when it ends, so an open
 * waits for it: opened sooner, the layer would be painted over.
 */
let closing: Promise<unknown> = Promise.resolve();

export const nativePreview = {
  /** Opens the layer (hidden until placed); false when this Mac's window can't. */
  open: async (): Promise<boolean> => {
    await closing;
    return (await call("preview_open")) === true;
  },
  /** Where the viewer is, in the page's points, the radius of its top corners, and whether the layer shows. */
  place: (rect: { x: number; y: number; width: number; height: number }, radius: number, visible: boolean): Promise<unknown> =>
    call("preview_place", { ...rect, radius, visible }),
  /**
   * The whole edit at `revision` as the page's engine takes it, what each media is decoded from, local excerpts of
   * streamed ones, and the media cache; resolves with the revision the window now draws, rejects with why it refused.
   */
  project: async (json: string, revision: number, sources: Record<string, string>, sounds: Record<string, string>, excerpts: Record<string, NativeExcerpt[]>, cache: string): Promise<number> =>
    Number(await call("preview_project", { json, revision, sources, sounds, excerpts, cache })),
  /** What changed since `base` (lib/patch.ts), making `revision`; rejects when the window isn't at `base` or it doesn't fit. */
  patch: async (base: number, revision: number, patch: string): Promise<number> => Number(await call("preview_patch", { base, revision, patch })),
  /** Draws `frame`; settles once it's on screen, saying how. */
  frame: async (frame: number): Promise<NativeDrawn> => (await call("preview_frame", { frame })) as NativeDrawn,
  /** Plays from `frame` on the window's clock; rejects when there's nothing to play ("at the end"). */
  play: (frame: number): Promise<unknown> => call("preview_play", { frame }),
  /** Stops playing; the frame the playhead rests on (null: it wasn't playing). */
  pause: async (): Promise<number | null> => { const at = await call("preview_pause"); return typeof at === "number" ? at : null; },
  /** Where the player is, and how playing went since the last ask. */
  position: async (): Promise<NativeWhere> => (await call("preview_position")) as NativeWhere,
  /** The playhead is about to land on `frame`: its pictures are made ready. */
  hint: (frame: number): Promise<unknown> => call("preview_hint", { frame }),
  /** The playing speed (1, or 2 for Script mode's 2×): the sound sped with it, its pitch kept; playing carries on from where it is. */
  rate: (rate: number): Promise<unknown> => call("preview_rate", { rate }),
  /** How loud the speaker is, 0 to 1, at once. */
  volume: (level: number): Promise<unknown> => call("preview_volume", { level }),
  close: (): Promise<unknown> => {
    const closed = call("preview_close");
    closing = closed.catch(() => {});
    return closed;
  },
};

/** One play on the window's clock, as it went: what the line in the log says (`playLine`). */
export interface NativeRun {
  /** Where it began (the edit's frame) and the edit's rate. */
  from: number;
  fps: number;
  /** Frames the window showed, passed over, and drew late (over a frame's time). */
  shown: number;
  skipped: number;
  slow: number;
  /** The longest a frame took to draw (ms), and how often the speaker ran out of sound. */
  longest: number;
  starved: number;
}

/**
 * The log's line for a play of two seconds or more (shorter ones are a tap):
 * how it went, so a hitch is in a teammate's report without asking them (Nov 10:
 * the window wrote nothing about its plays). A warning when it shows: frames
 * passed over (more than 1 in 100), a frame held a tenth of a second, the sound
 * short; null for a short one. `where`: the editor's viewer or the script's
 * monitor, both the window's one player.
 */
export function playLine(run: NativeRun, where = "in the window"): { level: "info" | "warn"; text: string } | null {
  if (run.shown < run.fps * 2) return null;
  const at = Math.floor(run.from / run.fps);
  const clock = `${Math.floor(at / 60)}:${String(at % 60).padStart(2, "0")}`;
  const seconds = (run.shown + run.skipped) / run.fps;
  const bad = run.skipped * 100 > run.shown || run.longest >= 100 || run.starved > 0;
  const text =
    `played ${seconds.toFixed(1)} s from ${clock} ${where}: ${run.shown} frames shown, ${run.skipped} passed over, ` +
    `${run.slow} drawn late, the longest ${Math.round(run.longest)} ms; ${run.starved > 0 ? `the sound ran short ${run.starved}×` : "the sound never ran short"}`;
  return { level: bad ? "warn" : "info", text };
}

/** A play's run so far, with what the window said while it played (`preview_position`). */
export function heardRun(run: NativeRun, at: NativeWhere): void {
  run.shown += at.drawn;
  run.skipped += at.skipped;
  run.slow += at.slow;
  run.starved += at.starved;
  for (const ms of at.draws) run.longest = Math.max(run.longest, ms);
}
