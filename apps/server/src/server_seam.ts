// What other packages use from server.rs (through `seams.server`): where an
// export goes by default, and keeping a found image.

import type { App } from "./app.ts";
import type { Project } from "./model.ts";
import { join } from "./paths.ts";
import { isAlphanumeric } from "./rust.ts";
import * as seams from "./seams.ts";
import type { Store } from "./store.ts";

/** `<exports folder>/<name>.mp4`: the media drive's `Exports` when one is set, else ~/Movies/Edit. */
export function defaultExportPath(store: Store, project: Project): string {
  const dir = store.layout().exportsDir();
  const safe = [...project.name].map((char) => (isAlphanumeric(char) || " -_".includes(char) ? char : "_")).join("");
  const trimmed = safe.trim();
  return join(dir, `${trimmed === "" ? "Edit" : trimmed}.mp4`);
}

/**
 * Sets a found image's status; kept the first time, it goes into the media
 * bin, named after its caption (server.rs review_found, which research.ts has).
 */
export function reviewFound(app: App, id: string, item: string, status: string, origin: string): Promise<seams.ResearchItem> {
  return seams.research.reviewFound(app, id, item, status, origin);
}
