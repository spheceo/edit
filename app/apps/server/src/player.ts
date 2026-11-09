// Which player draws a project open on this server: Edit.app's window (the
// native player, crates/edit-engine/src/player.rs) or the page's own engine
// (a browser tab, Linux). The two want different footage behind them. The
// window reads whole local copies, prefetched in playhead order (native_preview.ts),
// and plays on its own clock, so it needs no smooth-playback render
// (playback_render.ts), no scrub pieces (scrub.ts) and no 2 MiB block
// cache (cloud_blocks.ts). The page's player needs all three, and keeps
// them. A project is the window's from the moment its page asks where the
// window reads from (`GET …/native-sources`), for as long as this server runs.

const native = new Set<string>();

/** The window asked where to read project `id` from: it's drawn natively here. */
export function markNative(id: string): void {
  native.add(id);
}

/** Whether Edit.app's window draws project `id` on this server. */
export function isNative(id: string): boolean {
  return native.has(id);
}

/** For tests. */
export function reset(): void {
  native.clear();
}
