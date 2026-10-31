// Smooth playback: the edit rendered small in the background, so the viewer
// plays a video instead of decoding every source live. The team, Oct 31:
// "would be great if it was possible to play the video within the software,
// currently super laggy! we have too many loading frame issues and this has
// been the biggest issue we've faced"; the user watched a teammate on the
// latest nightly scrub and play and stall, every few seconds, on a long edit.
//
// It's an export of the open project on the Mac's video engine at its own size
// (the chunked encoder takes no other) and the smallest quality, with its
// sound, through the export's own chunks (crates/edit-engine/src/chunks.rs):
// in a folder of its own (the project's id with ".playback"), so a real
// export's chunks are never touched, and a re-render after an edit copies the
// chunks that didn't change and renders only the rest, seconds for a fix.
// One render at a time, never alongside an export (the export goes first: a
// render running when one starts is stopped and carries on after), and the
// page asks for it (`POST /api/projects/{id}/playback`) once its edits settle,
// so the agent's dozens of changes in a turn don't each start one.
//
// The file is `<cache>/playback/<project>.mp4`; the status says which
// revision it shows (`rev`), and the viewer plays it only when that's the
// revision on screen.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { ApiError, json, notFound } from "./http/errors.ts";
import { serveFile } from "./http/files.ts";
import type { Router } from "./http/router.ts";
import type { ExportOptions, Project } from "./model.ts";
import { native, type ExportJob } from "./native/index.ts";
import { isFile, join } from "./paths.ts";
import { duration } from "./project.ts";
import { readState, writeAtomic } from "./files.ts";
import { jsonForSerde } from "./rust.ts";
import * as seams from "./seams.ts";
import { createHash } from "node:crypto";

/** How often a render waiting on an export looks again (ms). */
const WAIT_MS = 10_000;
/** Renders kept on disk: the projects rendered last (each about 900 MB for a 40-minute edit). */
const KEEP = 3;

export interface Status {
  state: "none" | "waiting" | "rendering" | "ready" | "failed";
  /** The revision the ready file shows, or the one being rendered. */
  rev: number | null;
  /** 0–1 while rendering. */
  progress: number;
  /** The file's address (with its version), when one is ready. */
  url: string | null;
  error: string | null;
}

interface Made {
  rev: number;
  hash: string;
  stamp: string;
}

interface Running {
  project: string;
  rev: number;
  hash: string;
  progress: number;
  job: ExportJob | null;
  cancelled: boolean;
}

const made = new Map<string, Made>();
const failed = new Map<string, { rev: number; error: string }>();
let running: Running | null = null;
/** The newest ask per project while another render runs: [rev wanted]. */
const asked = new Map<string, number>();
let waitTimer: ReturnType<typeof setTimeout> | undefined;

/** What's seen and heard: the project but its script (notes and words that change nothing on screen). */
export function pictureHash(project: Project): string {
  return createHash("sha256").update(jsonForSerde({ ...project, script: null })).digest("hex").slice(0, 16);
}

export function file(app: App, id: string): string {
  return join(app.store.cacheDir(), "playback", `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.mp4`);
}

/** What a project's file shows, kept beside it so a restart still knows (`<project>.json`). */
function record(app: App, id: string): Made | undefined {
  const known = made.get(id);
  if (known !== undefined) return known;
  const saved = readState(file(app, id).replace(/\.mp4$/u, ".json")) as Partial<Made> | null | undefined;
  if (typeof saved?.hash !== "string" || typeof saved.stamp !== "string" || typeof saved.rev !== "number") return undefined;
  const found: Made = { rev: saved.rev, hash: saved.hash, stamp: saved.stamp };
  made.set(id, found);
  return found;
}

/** The export takes the Mac: a smooth playback render waits for local exports only. */
function exporting(app: App): boolean {
  return app.exports.localRunning?.() ?? app.exports.running();
}

export function status(app: App, id: string): Status {
  const live = app.store.get(id);
  const done = record(app, id);
  const ready = done !== undefined && isFile(file(app, id)) ? done : undefined;
  // A save that changed nothing seen (a note, the chat) keeps the render.
  if (live !== null && ready !== undefined && ready.rev !== live.rev && ready.hash === pictureHash(live.project)) ready.rev = live.rev;
  const url = ready === undefined ? null : `/api/projects/${encodeURIComponent(id)}/playback.mp4?v=${ready.stamp}`;
  if (running?.project === id) return { state: "rendering", rev: running.rev, progress: running.progress, url, error: null };
  if (asked.has(id)) return { state: "waiting", rev: asked.get(id)!, progress: 0, url, error: null };
  if (ready !== undefined) return { state: "ready", rev: ready.rev, progress: 1, url, error: null };
  const lost = failed.get(id);
  if (lost !== undefined) return { state: "failed", rev: lost.rev, progress: 0, url: null, error: lost.error };
  return { state: "none", rev: null, progress: 0, url: null, error: null };
}

function publish(app: App, id: string): void {
  app.store.emit({ type: "playback", id, status: status(app, id) });
}

/**
 * Renders project `id` as it is now, unless the file already shows it. A
 * render of an older revision stops (its chunks are kept for this one); one
 * of another project stops too (the viewer moved on).
 */
export function request(app: App, id: string): Status {
  const live = app.store.get(id);
  if (live === null) throw notFound("no such project");
  const hash = pictureHash(live.project);
  const done = record(app, id);
  if (done !== undefined && done.hash === hash && isFile(file(app, id))) {
    done.rev = live.rev;
    return status(app, id);
  }
  if (running !== null && running.project === id && running.hash === hash) return status(app, id);
  asked.clear();
  asked.set(id, live.rev);
  if (running !== null) {
    running.cancelled = true;
    running.job?.cancel();
  } else void next(app);
  publish(app, id);
  return status(app, id);
}

/** Stops a render for an export (it carries on once the export is done). */
export function yieldToExport(app: App): void {
  if (running === null) return;
  asked.set(running.project, running.rev);
  running.cancelled = true;
  running.job?.cancel();
  diag.info("playback", `${running.project}: smooth playback waits for the export`);
  publish(app, running.project);
}

async function next(app: App): Promise<void> {
  if (running !== null) return;
  const first = asked.entries().next();
  if (first.done === true) return;
  const [id] = first.value;
  // An export goes first; this looks again shortly.
  if (exporting(app)) {
    clearTimeout(waitTimer);
    waitTimer = setTimeout(() => void next(app), WAIT_MS);
    return;
  }
  asked.delete(id);
  const live = app.store.get(id);
  if (live === null) return void next(app);
  const project = live.project;
  const current: Running = { project: id, rev: live.rev, hash: pictureHash(project), progress: 0, job: null, cancelled: false };
  running = current;
  failed.delete(id);
  publish(app, id);
  const started = performance.now();
  try {
    await render(app, project, current);
    if (!current.cancelled) {
      const stamp = `${current.hash}-${Date.now().toString(36)}`;
      made.set(id, { rev: current.rev, hash: current.hash, stamp });
      writeAtomic(file(app, id).replace(/\.mp4$/u, ".json"), JSON.stringify(made.get(id)));
      keepRecent(app);
      const frames = duration(project);
      diag.info("playback", `${project.name}: smooth playback of ${frames} frames rendered in ${diag.human(performance.now() - started)}`);
    }
  } catch (error) {
    if (!current.cancelled) {
      const message = diag.messageOf(error);
      failed.set(id, { rev: current.rev, error: message });
      diag.warn("playback", `${project.name}: smooth playback couldn't render: ${message}`);
    }
  } finally {
    running = null;
    publish(app, id);
    void next(app);
  }
}

async function render(app: App, project: Project, current: Running): Promise<void> {
  const output = file(app, project.id);
  fs.mkdirSync(join(app.store.cacheDir(), "playback"), { recursive: true });
  await seams.cloudMedia.restoreStills(app, project);
  if (current.cancelled) return;
  const options: ExportOptions = {
    ...native().exportDefaults(),
    format: "h264",
    range: null,
    shape: "original",
    fill: "black",
    size: null,
    fps: null,
    quality: "small",
    target_mb: null,
    hardware: true,
    wait_for_smoothing: false,
    audio: true,
    loudness: null,
    chapters: [],
  };
  // Its own chunk folder and file, so the real export's are never touched.
  const own = { ...project, id: `${project.id}.playback` };
  const input = { json: jsonForSerde(own) };
  const { plan } = native().exportPlan(input, options);
  if (plan.end <= plan.start) throw new ApiError(400, "nothing on the timeline to play");
  const job = native().ExportJob.start({ project: input, options, plan, output, cacheDir: app.store.cacheDir() }, (progress) => {
    current.progress = progress;
    publishSoon(app, project.id);
  });
  current.job = job;
  if (current.cancelled) job.cancel();
  try {
    await job.wait();
  } catch (error) {
    if (current.cancelled) return;
    throw error;
  }
}

/** Only the KEEP renders made last stay; the others' files go (their next render starts over). */
function keepRecent(app: App): void {
  const dir = join(app.store.cacheDir(), "playback");
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".mp4") && !name.includes(".partial"));
  } catch {
    return;
  }
  const dated = names.map((name) => {
    try { return { name, at: fs.statSync(join(dir, name)).mtimeMs }; } catch { return { name, at: 0 }; }
  }).sort((a, b) => b.at - a.at);
  for (const { name } of dated.slice(KEEP)) {
    for (const gone of [name, name.replace(/\.mp4$/u, ".json")]) fs.rmSync(join(dir, gone), { force: true });
    for (const [id] of made) if (file(app, id).endsWith(`/${name}`)) made.delete(id);
  }
}

let soon: ReturnType<typeof setTimeout> | undefined;
/** Progress at most twice a second. */
function publishSoon(app: App, id: string): void {
  if (soon !== undefined) return;
  soon = setTimeout(() => {
    soon = undefined;
    publish(app, id);
  }, 500);
}

/** Follows exports: a local one stops a render, which carries on once it's done. */
export function start(app: App): void {
  app.store.subscribe((event) => {
    if (event.type !== "export") return;
    if (event.state === "running" && exporting(app)) yieldToExport(app);
    else if (event.state !== "running" && event.state !== "queued") void next(app);
  });
}

export function routes(router: Router<App>): void {
  router
    .get("/api/projects/{id}/playback", ({ app, params }) => json(status(app, params.id ?? "")))
    .post("/api/projects/{id}/playback", ({ app, params }) => json(request(app, params.id ?? "")))
    .get("/api/projects/{id}/playback.mp4", ({ app, params, request: given }) => {
      const path = file(app, params.id ?? "");
      if (record(app, params.id ?? "") === undefined || !isFile(path)) throw notFound("no smooth playback yet");
      const response = serveFile(given, path);
      // Each render is a new address (`v`), so a version may be kept.
      response.headers.set("cache-control", "private, max-age=86400");
      return response;
    });
}
