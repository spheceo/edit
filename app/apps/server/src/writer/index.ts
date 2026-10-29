// Script mode (Writer, merged into Edit on Oct 29 2026): starting it with the
// server. The first start copies this Mac's Writer scripts in (Writer's own
// folder stays as it was, so Writer still opens them); every start marks
// imports and jobs that died with the server as stopped.

import * as fs from "node:fs";

import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import * as archive from "./archive.ts";
import * as build from "./build.ts";
import * as cloud from "./cloud.ts";
import * as reviews from "./reviews.ts";
import * as drive from "./drive.ts";
import { isFile, join, userHome } from "../paths.ts";
import * as jobs from "./jobs.ts";
import * as storage from "./storage.ts";
import * as store from "./store.ts";

/** Where Writer kept its scripts on this Mac. */
export const WRITER_FOLDER = (): string => process.env.EDIT_WRITER_FOLDER ?? join(userHome(), "Library", "Application Support", "com.spheceo.writer");

/** Background work Script mode's parts start with the server (the cloud, review polling…). */
export const starters: ((app: App) => void)[] = [];

export function start(app: App): void {
  const data = store.dataDir(app.store.home);
  drive.hooks.accessToken = () => app.library.accessToken();
  build.usePort(app.port);
  try {
    const adopted = store.adoptWriterFolder(data, WRITER_FOLDER());
    if (adopted > 0) diag.info("writer", `brought ${adopted} scripts in from Writer's folder on this Mac`);
  } catch (error) {
    diag.warn("writer", `Writer's scripts weren't brought in: ${diag.messageOf(error)}`);
  }
  try {
    cloud.adoptLedger(data, WRITER_FOLDER());
    // What Writer knew of its review notes (where it had read them to, open counts, approvals), once.
    const notes = join(WRITER_FOLDER(), "reviews", "notes.json");
    const ours = join(data, "reviews", "notes.json");
    const empty = !isFile(ours) || ((JSON.parse(fs.readFileSync(ours, "utf8")) as { cursor?: number }).cursor ?? 0) === 0;
    if (isFile(notes) && empty) {
      fs.mkdirSync(join(data, "reviews"), { recursive: true });
      fs.copyFileSync(notes, ours);
    }
  } catch (error) {
    diag.warn("writer", `Writer's cloud record wasn't taken: ${diag.messageOf(error)}`);
  }
  store.markInterrupted(data);
  for (const id of store.ids(data)) jobs.markInterrupted(data, id);
  cloud.start(data);
  reviews.start(app, data);
  // Idle scripts' footage left to the cloud.
  storage.start(data);
  // Archives and restores heard from the cloud, acted on every 20 s.
  setInterval(() => archive.react(app, data), 20_000);
  for (const begin of starters) {
    try {
      begin(app);
    } catch (error) {
      diag.warn("writer", diag.messageOf(error));
    }
  }
}
