// Script mode (Writer, merged into Edit on Oct 29 2026): starting it with the
// server. The first start copies this Mac's Writer scripts in (Writer's own
// folder stays as it was, so Writer still opens them); every start marks
// imports and jobs that died with the server as stopped.

import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import * as build from "./build.ts";
import * as commentary from "./commentary.ts";
import { join, userHome } from "../paths.ts";
import * as jobs from "./jobs.ts";
import * as store from "./store.ts";

/** Where Writer kept its scripts on this Mac. */
export const WRITER_FOLDER = (): string => process.env.EDIT_WRITER_FOLDER ?? join(userHome(), "Library", "Application Support", "com.spheceo.writer");

/** Background work Script mode's parts start with the server (the cloud, review polling…). */
export const starters: ((app: App) => void)[] = [];

export function start(app: App): void {
  const data = store.dataDir(app.store.home);
  commentary.hooks.googleToken = () => app.library.accessToken();
  build.usePort(app.port);
  try {
    const adopted = store.adoptWriterFolder(data, WRITER_FOLDER());
    if (adopted > 0) diag.info("writer", `brought ${adopted} scripts in from Writer's folder on this Mac`);
  } catch (error) {
    diag.warn("writer", `Writer's scripts weren't brought in: ${diag.messageOf(error)}`);
  }
  store.markInterrupted(data);
  for (const id of store.ids(data)) jobs.markInterrupted(data, id);
  for (const begin of starters) {
    try {
      begin(app);
    } catch (error) {
      diag.warn("writer", diag.messageOf(error));
    }
  }
}
