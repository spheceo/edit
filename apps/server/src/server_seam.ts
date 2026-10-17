// What other packages use from server.rs (through `seams.server`): where an
// export goes by default, and keeping a found image.

import type { App } from "./app.ts";
import { importPaths } from "./import.ts";
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
 * bin, named after its caption. Returns it (with its media, once kept).
 */
export async function reviewFound(
  app: App,
  id: string,
  item: string,
  status: string,
  origin: string,
): Promise<seams.ResearchItem> {
  const home = app.store.home;
  const found = seams.research.items(home, id).find((candidate) => candidate.id === item);
  if (found === undefined) throw new Error("no such found image");
  let media = typeof found.media === "string" ? found.media : null;
  if (status === "kept" && media === null) {
    const [, added, errors] = await importPaths(app, id, [found.file], false, origin);
    const mediaId = added[0];
    if (mediaId === undefined) {
      throw new Error(`couldn't add it to the media bin: [${errors.map((error) => JSON.stringify(error)).join(", ")}]`);
    }
    const name = [...found.title].slice(0, 80).join("");
    if (name.trim() !== "") {
      await app.store.update(id, origin, (project) => {
        const kept = project.media.find((candidate) => candidate.id === mediaId);
        if (kept !== undefined) kept.name = name;
      });
    }
    media = mediaId;
  }
  return seams.research.update(home, id, item, (changed) => {
    changed.status = status;
    if (media === null) delete changed.media;
    else changed.media = media;
  });
}
