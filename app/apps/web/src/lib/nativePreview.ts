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

export const nativePreview = {
  /** Opens the layer (hidden until placed); false when this Mac's window can't. */
  open: async (): Promise<boolean> => (await call("preview_open")) === true,
  /** Where the viewer is, in the page's points, the radius of its top corners, and whether the layer shows. */
  place: (rect: { x: number; y: number; width: number; height: number }, radius: number, visible: boolean): Promise<unknown> =>
    call("preview_place", { ...rect, radius, visible }),
  /** The edit as the page's engine takes it, what each media is decoded from, and the media cache. */
  project: (json: string, sources: Record<string, string>, cache: string): Promise<unknown> => call("preview_project", { json, sources, cache }),
  /** Draws `frame`; settles once it's on screen. */
  frame: (frame: number): Promise<unknown> => call("preview_frame", { frame }),
  close: (): Promise<unknown> => call("preview_close"),
};
