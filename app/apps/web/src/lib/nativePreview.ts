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
 * undrawn, slow draws (over 33 ms), their times (ms), and the speaker's output calls that ran short of sound.
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
}

export const nativePreview = {
  /** Opens the layer (hidden until placed); false when this Mac's window can't. */
  open: async (): Promise<boolean> => (await call("preview_open")) === true,
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
  close: (): Promise<unknown> => call("preview_close"),
};
