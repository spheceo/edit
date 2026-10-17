// What the release binary carries inside it (plan §4): the web UI, the window
// helper, and (registered straight with the native loader) the addon.
// `scripts/embed.ts` writes `src/embedded.gen.ts`, the compile's entry, which
// imports each file `with { type: "file" }` (a path inside the binary), hands
// them here, then runs `main.ts`. A dev run has none of this: the UI comes
// from apps/web/dist and the helper from the cargo build.

import { mapAssets, useAssets } from "./http/assets.ts";

export interface Embedded {
  /** The web UI: its path under apps/web/dist → the file inside the binary. */
  web: Map<string, string>;
  /** The window helper (crates/edit-window), when this build has one. */
  window: string | null;
}

let current: Embedded | null = null;

/** Registers the binary's files (embedded.gen.ts, before main runs). */
export function useEmbedded(files: Embedded): void {
  current = files;
  if (files.web.size > 0) {
    const web = new Map<string, Blob>();
    for (const [path, file] of files.web) web.set(path, Bun.file(file));
    useAssets(mapAssets(web));
  }
}

/** The binary's files, or null in a dev run. */
export function embedded(): Embedded | null {
  return current;
}
