/**
 * Edit.app's native preview (crates/edit-window/src/preview.rs,
 * docs/plans/2026-11-06-native-player.md): the engine draws the viewer's
 * picture in a layer under the page, from the Mac's video decoder, where the
 * page decoded and drew every frame in WebKit. Only in Edit.app's window (a
 * browser has no window to ask); the page keeps the playhead, the sound and
 * everything over the picture, and goes back to drawing it itself if the
 * window can't.
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
  project: async (json: string, revision: number, sources: Record<string, string>, excerpts: Record<string, NativeExcerpt[]>, cache: string): Promise<number> =>
    Number(await call("preview_project", { json, revision, sources, excerpts, cache })),
  /** What changed since `base` (lib/patch.ts), making `revision`; rejects when the window isn't at `base` or it doesn't fit. */
  patch: async (base: number, revision: number, patch: string): Promise<number> => Number(await call("preview_patch", { base, revision, patch })),
  /** Draws `frame`; settles once it's on screen, saying how. */
  frame: async (frame: number): Promise<NativeDrawn> => (await call("preview_frame", { frame })) as NativeDrawn,
  close: (): Promise<unknown> => call("preview_close"),
};
