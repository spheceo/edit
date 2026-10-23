// Archived projects (docs/plans/2026-10-22-archive-projects.md): a member
// archives an Edit project on Repack's Projects page to free its big files
// (Repack's server deletes its footage on R2 that no active project uses);
// this machine, hearing it, deletes the project's exports and its footage
// here, keeping the project and what was paid to hear and watch. A restore
// (on Repack, or the card's button here) brings the footage back from Drive
// and YouTube, under the same keys, so the edit is as it was.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import * as cloudMedia from "./cloud_media.ts";
import * as diag from "./diag.ts";
import { deleteExport, listExports } from "./exports.ts";
import { writeAtomic } from "./files.ts";
import { ApiError } from "./http/errors.ts";
import type { Router } from "./http/router.ts";
import { join } from "./paths.ts";
import { stableStringify } from "./stable.ts";

/** How often the cloud's list is read for archives and restores. */
export const POLL_MS = 60_000;

/** What happened here to an archived project. */
export interface Here {
  /** When it was archived here (its files freed). */
  at: number;
  /** Bytes freed on this machine. */
  freed: number;
  /** A restore under way, or why the last one failed. */
  restoring?: boolean;
  error?: string;
  /** Media a restore couldn't bring back (from a disk). */
  lost?: string[];
}

function file(home: string): string {
  return join(home, "cloud", "archived.json");
}

export function archived(home: string): Record<string, Here> {
  try {
    return JSON.parse(fs.readFileSync(file(home), "utf8")) as Record<string, Here>;
  } catch {
    return {};
  }
}

function change(home: string, edit: (all: Record<string, Here>) => void): void {
  const all = archived(home);
  edit(all);
  fs.mkdirSync(join(home, "cloud"), { recursive: true });
  writeAtomic(file(home), JSON.stringify(all));
}

/** Frees an archived project here: its exports, then its footage and previews (cloud_media.archiveHere). */
export function archiveHere(app: App, id: string): number {
  const home = app.store.home;
  let freed = 0;
  for (const one of listExports(home, id)) {
    try {
      freed += one.missing ? 0 : (one.bytes ?? 0);
      deleteExport(home, id, one.path);
    } catch (error) {
      diag.warn("cloud", `archiving ${id}: ${one.path}: ${diag.messageOf(error)}`);
    }
  }
  freed += cloudMedia.archiveHere(app, id, new Set(Object.keys(archived(home))));
  change(home, (all) => {
    all[id] = { at: Date.now(), freed };
  });
  app.store.emit({ type: "archive", id, archived: true });
  return freed;
}

const restoring = new Set<string>();

/** Brings an archived project's footage back (once at a time per project), then tells the cloud it's back. */
export async function restore(app: App, id: string): Promise<void> {
  if (restoring.has(id)) return;
  restoring.add(id);
  const home = app.store.home;
  change(home, (all) => {
    if (all[id] !== undefined) all[id] = { ...all[id]!, restoring: true, error: undefined };
  });
  app.store.emit({ type: "archive", id, restoring: true });
  try {
    const lost = await diag.timeOnAsync("cloud", "cloud: restore", id, () => cloudMedia.restoreHere(app, id));
    await cloud.mutation("edit:clearRestore", { projectId: id }).catch((error: unknown) => diag.warn("cloud", `restore of ${id}: telling the cloud: ${diag.messageOf(error)}`));
    change(home, (all) => {
      delete all[id];
    });
    void cloudMedia.ensureLocal(app, id).catch(() => {});
    diag.info("cloud", `${id}: restored${lost.length > 0 ? `; can't come back: ${lost.join(", ")}` : ""}`);
    app.store.emit({ type: "archive", id, archived: false, lost });
  } catch (error) {
    change(home, (all) => {
      if (all[id] !== undefined) all[id] = { ...all[id]!, restoring: false, error: diag.messageOf(error) };
    });
    diag.warn("cloud", `restoring ${id}: ${diag.messageOf(error)}`);
    app.store.emit({ type: "archive", id, restoring: false, error: diag.messageOf(error) });
  } finally {
    restoring.delete(id);
  }
}

/** One look at the cloud's list: archives freed here, restores asked for started. */
export async function poll(app: App): Promise<void> {
  const rows = (await cloud.query("edit:listProjects", {})) as { projectId?: string; archived?: unknown; restore?: unknown }[];
  const here = archived(app.store.home);
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = row.projectId;
    if (typeof id !== "string" || app.store.get(id) === null) continue;
    const isArchived = row.archived !== null && row.archived !== undefined;
    const asked = row.restore !== null && row.restore !== undefined;
    if (isArchived && here[id] === undefined && !asked) archiveHere(app, id);
    if (asked && here[id] !== undefined && here[id]!.restoring !== true) void restore(app, id);
    // Brought back from another machine: nothing archived here any more.
    if (!isArchived && !asked && here[id] !== undefined && here[id]!.restoring !== true) {
      change(app.store.home, (all) => {
        delete all[id];
      });
      cloudMedia.setNoFootage(app.store.home, id, false);
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Follows archives and restores from the start, whenever the cloud is on (the sign-in is read after this runs; see reviews.start). */
export function start(app: App): void {
  if (timer !== null) return;
  const tick = () => {
    if (!cloud.enabled()) return;
    void poll(app).catch((error: unknown) => diag.warn("cloud", `following archives: ${diag.messageOf(error)}`));
  };
  timer = setInterval(tick, POLL_MS);
  timer.unref?.();
  setTimeout(tick, 8_000).unref?.();
}

export function routes(router: Router<App>): void {
  router.get("/api/archived", ({ app }) => new Response(stableStringify(archived(app.store.home)), { headers: { "content-type": "application/json" } }));
  router.post("/api/projects/{id}/restore", ({ app, params }) => {
    const id = params.id ?? "";
    if (archived(app.store.home)[id] === undefined) throw new ApiError(400, "this project isn't archived");
    void restore(app, id);
    return new Response(stableStringify({ started: true }), { headers: { "content-type": "application/json" } });
  });
}
