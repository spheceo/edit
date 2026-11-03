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
// A render lives in R2 under the picture's hash
// (`edit/exports/playback/<project>/<hash>.mp4`, `cloudKey`) when Modal made
// it, and before rendering a Mac looks there and plays any render of the same
// picture at once (streamed through this server's block cache, copied down
// behind it), so a project opened on another Mac plays straight away. Modal
// renders only with its exports on (`EDIT_MODAL_EXPORTS`, off by default
// since Sphe moved Edit off Modal, Nov 2); otherwise it renders here, and a
// render Modal can't make is made here too. A Mac's own render isn't put in
// R2 yet: whole, a 40-minute edit's is ~900 MB up from South Africa after
// every agent turn; it goes up chunk by chunk once renders are kept in chunks.
//
// The Mac's file is `<cache>/playback/<project>.mp4`; either way the status
// says which revision it shows (`rev`), and the viewer plays it only when
// that's the revision on screen.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import { streamFromCloud } from "./cloud_media.ts";
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
import * as exportExcerpts from "./export_excerpts.ts";
import * as playbackStream from "./playback_stream.ts";
import { playbackKey } from "./cloud_playback.ts";
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
  /** Rendered here in chunks: the viewer plays it a chunk at a time as each lands (playback_stream.ts), while it renders too. */
  stream: boolean;
}

interface Made {
  rev: number;
  hash: string;
  stamp: string;
  /** Whether it has sound (the edit has something heard). */
  heard?: boolean;
  /** In R2 (made on Modal or another Mac), not on this Mac. */
  key?: string;
}

interface Running {
  project: string;
  rev: number;
  hash: string;
  progress: number;
  job: ExportJob | null;
  cancelled: boolean;
  /** On Modal: it doesn't take the Mac, so a local export needn't stop it. */
  cloud: boolean;
  key?: string;
  /** When it started (ms since 1970): a chunk plan older than this is another render's. */
  started: number;
  /** Whether it has sound. */
  heard?: boolean;
}

const made = new Map<string, Made>();
const failed = new Map<string, { rev: number; error: string }>();
let running: Running | null = null;
/** The newest ask per project while another render runs: [rev wanted]. */
const asked = new Map<string, number>();
/** Where the viewer's playhead was when it asked: that chunk is rendered first. */
const focus = new Map<string, number>();
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
  const found: Made = { rev: saved.rev, hash: saved.hash, stamp: saved.stamp, ...(typeof saved.key === "string" ? { key: saved.key } : {}), ...(typeof saved.heard === "boolean" ? { heard: saved.heard } : {}) };
  made.set(id, found);
  return found;
}

/** Whether the render `done` is there to play: in R2, or a file here. */
function present(app: App, id: string, done: Made | undefined): done is Made {
  return done !== undefined && (done.key !== undefined || isFile(file(app, id)));
}

/** Where a picture's render lives in R2, whichever Mac (or Modal) made it (under edit/exports/: the relay keeps an installed Edit's cloud exports there). */
export function cloudKey(id: string, hash: string): string {
  return `edit/exports/playback/${id.replace(/[^A-Za-z0-9_-]/g, "_")}/${hash}.mp4`;
}

/**
 * Modal's render copied to this Mac behind the stream, so playback stops
 * leaning on the network once it's down (580 MB for 26 minutes): played from
 * the file when it's whole and still this picture's, streamed from R2 before.
 */
async function fetchLocal(app: App, id: string, key: string): Promise<void> {
  const local = file(app, id).replace(/\.mp4$/u, `.${key.split("/").pop() ?? "cloud.mp4"}`);
  try {
    await cloud.download(key, local);
  } catch (error) {
    diag.warn("playback", `${id}: smooth playback stays streamed (${diag.messageOf(error)})`);
    return;
  }
  if (made.get(id)?.key !== key) fs.rmSync(local, { force: true });
}

/** This Mac's copy of a render made on Modal, when it's whole. */
function localCopy(app: App, id: string, key: string): string | null {
  const local = file(app, id).replace(/\.mp4$/u, `.${key.split("/").pop() ?? "cloud.mp4"}`);
  return isFile(local) ? local : null;
}

/** The export takes the Mac: a smooth playback render waits for local exports only. */
function exporting(app: App): boolean {
  return app.exports.localRunning?.() ?? app.exports.running();
}

export function status(app: App, id: string): Status {
  const live = app.store.get(id);
  const done = record(app, id);
  const ready = present(app, id, done) ? done : undefined;
  // A save that changed nothing seen (a note, the chat) keeps the render.
  if (live !== null && ready !== undefined && ready.rev !== live.rev && ready.hash === pictureHash(live.project)) ready.rev = live.rev;
  const url = ready === undefined ? null : `/api/projects/${encodeURIComponent(id)}/playback.mp4?v=${ready.stamp}`;
  // While another revision renders or waits, the file there shows an older
  // picture: no url, so nothing plays it as this one (JJ, Nov 2: "I've made
  // changes to the window screen rather than the paper, but on the screen, it
  // still shows the paper thing": the status gave the new rev with the old file).
  if (running?.project === id) return { state: "rendering", rev: running.rev, progress: running.progress, url: running.rev === ready?.rev ? url : null, error: null, stream: !running.cloud };
  if (asked.has(id)) return { state: "waiting", rev: asked.get(id)!, progress: 0, url: asked.get(id) === ready?.rev ? url : null, error: null, stream: false };
  if (ready !== undefined) return { state: "ready", rev: ready.rev, progress: 1, url, error: null, stream: ready.key === undefined };
  const lost = failed.get(id);
  if (lost !== undefined) return { state: "failed", rev: lost.rev, progress: 0, url: null, error: lost.error, stream: false };
  return { state: "none", rev: null, progress: 0, url: null, error: null, stream: false };
}

function publish(app: App, id: string): void {
  app.store.emit({ type: "playback", id, status: status(app, id) });
}

/**
 * Renders project `id` as it is now, unless the file already shows it. A
 * render of an older revision stops (its chunks are kept for this one); one
 * of another project stops too (the viewer moved on).
 */
export function request(app: App, id: string, frame?: number): Status {
  const live = app.store.get(id);
  if (live === null) throw notFound("no such project");
  const hash = pictureHash(live.project);
  const done = record(app, id);
  if (present(app, id, done) && done.hash === hash) {
    done.rev = live.rev;
    return status(app, id);
  }
  if (running !== null && running.project === id && running.hash === hash) return status(app, id);
  asked.clear();
  asked.set(id, live.rev);
  if (frame !== undefined && Number.isFinite(frame) && frame >= 0) focus.set(id, Math.floor(frame));
  if (running !== null) {
    running.cancelled = true;
    running.job?.cancel();
  } else void next(app);
  publish(app, id);
  return status(app, id);
}

/** Asked in the background (an agent's turn over): queued behind what's asked, never stopping a render or dropping an ask. */
function requestQuietly(app: App, id: string): void {
  const live = app.store.get(id);
  if (live === null) return;
  const hash = pictureHash(live.project);
  const done = record(app, id);
  if (present(app, id, done) && done.hash === hash) return;
  if (running !== null && running.project === id && running.hash === hash) return;
  if (!asked.has(id)) asked.set(id, live.rev);
  if (running === null) void next(app);
}

/** Stops a render for an export (it carries on once the export is done). */
export function yieldToExport(app: App): void {
  if (running === null || running.cloud) return;
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
  const live = app.store.get(id);
  if (live === null) {
    asked.delete(id);
    return void next(app);
  }
  const project = live.project;
  const onCloud = await hooks.toCloud(project);
  // A local export goes first (a render on Modal doesn't take the Mac); this looks again shortly.
  if (!onCloud && exporting(app)) {
    clearTimeout(waitTimer);
    waitTimer = setTimeout(() => void next(app), WAIT_MS);
    return;
  }
  if (running !== null || asked.get(id) === undefined) return;
  asked.delete(id);
  const current: Running = { project: id, rev: live.rev, hash: pictureHash(project), progress: 0, job: null, cancelled: false, cloud: onCloud, started: Date.now() };
  running = current;
  failed.delete(id);
  publish(app, id);
  const started = performance.now();
  try {
    // Its record and file live here whichever way it's made (Nov 1: made on Modal into a fresh data folder, its record
    // couldn't be written, so it was never copied down and a restart would have paid Modal to make it again).
    fs.mkdirSync(join(app.store.cacheDir(), "playback"), { recursive: true });
    const key = cloudKey(id, current.hash);
    // A render of this very picture any Mac made (or Modal) is played as it is: opened on a new Mac, it plays at once.
    let found = false;
    if (await hooks.inCloud(key)) {
      current.key = key;
      found = true;
    } else if (current.cloud) {
      try {
        await renderOnModal(app, project, current);
      } catch (error) {
        if (current.cancelled) throw error;
        // Out of credit, down, or off: made here, as any other (an export starting stops it till it's done).
        diag.warn("playback", `${project.name}: Modal couldn't make smooth playback (${diag.messageOf(error)}); rendering it here`);
        current.cloud = false;
        delete current.key;
        await render(app, project, current);
      }
    } else await render(app, project, current);
    if (!current.cancelled) {
      const stamp = `${current.hash}-${Date.now().toString(36)}`;
      const before = made.get(id);
      made.set(id, { rev: current.rev, hash: current.hash, stamp, ...(current.key !== undefined ? { key: current.key } : {}), ...(current.heard !== undefined ? { heard: current.heard } : {}) });
      writeAtomic(file(app, id).replace(/\.mp4$/u, ".json"), JSON.stringify(made.get(id)));
      if (current.key !== undefined) {
        fs.rmSync(file(app, id), { force: true });
        const old = before?.key;
        if (old !== undefined && old !== current.key) fs.rmSync(file(app, id).replace(/\.mp4$/u, `.${old.split("/").pop() ?? ""}`), { force: true });
        void fetchLocal(app, id, current.key);
      } else keepRecent(app);
      // The render it replaces, made on Modal, goes from R2 (another Mac's of this picture is the same key, kept).
      if (before?.key !== undefined && before.key !== key) void cloud.remove([before.key]).catch(() => {});
      const frames = duration(project);
      const how = found ? "found in the cloud" : current.cloud ? "made on Modal" : "rendered here";
      diag.info("playback", `${project.name}: smooth playback of ${frames} frames ${how} in ${diag.human(performance.now() - started)}`);
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

/** The render's export: the project's own size (the chunked encoder and Modal take no other), smallest quality, with sound. */
function playbackOptions(): ExportOptions {
  return {
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
}

/** Whether `project` renders on Modal: every footage it plays is in the cloud and Modal exports are on. */
async function toCloud(project: Project): Promise<boolean> {
  try {
    await seams.modalExports.ready();
    if (!seams.modalExports.enabled()) return false;
    const { plan } = native().exportPlan({ json: jsonForSerde(project) }, playbackOptions());
    return seams.modalExports.unsuitable(project, playbackOptions(), plan) === null;
  } catch {
    return false;
  }
}

/** On Modal, kept in R2 by the picture's hash; a render another Mac made of the same picture is used as it is. */
async function renderOnModal(app: App, project: Project, current: Running): Promise<void> {
  const key = cloudKey(project.id, current.hash);
  current.key = key;
  if ((await cloud.head(key).catch(() => null)) !== null) return;
  const scratch = file(app, project.id).replace(/\.mp4$/u, ".modal.mp4");
  await seams.modalExports.run(app.store.home, project, playbackOptions(), scratch, () => current.cancelled, (progress) => {
    current.progress = progress;
    publishSoon(app, project.id);
  }, key);
}

async function render(app: App, project: Project, current: Running): Promise<void> {
  const output = file(app, project.id);
  await seams.cloudMedia.restoreStills(app, project);
  if (current.cancelled) return;
  const options = playbackOptions();
  // Its own chunk folder and file, so the real export's are never touched.
  const own = { ...project, id: `${project.id}.playback` };
  const input = { json: jsonForSerde(own) };
  const { plan } = native().exportPlan(input, options);
  if (plan.end <= plan.start) throw new ApiError(400, "nothing on the timeline to play");
  current.heard = plan.audio;
  // The proxies it reads, cut to this Mac first as an export's originals are
  // (export_excerpts.ts): AVFoundation reads them, where FFmpeg read each clip
  // again over this server's preview URL (Nov 3: the 16-Year-Old rendered at 48 fps).
  const urls = new Map<string, string>();
  const keys = new Map<string, string>();
  for (const media of project.media) {
    const key = playbackKey(media.path);
    if (key !== null && media.kind === "video") {
      urls.set(media.id, media.path);
      keys.set(media.id, key);
    }
  }
  const excerpts = urls.size === 0 ? [] : await exportExcerpts.prepare(own, plan.start, plan.end, app.store.cacheDir(), urls, keys, () => current.cancelled).catch((error: unknown) => {
    diag.warn("playback", `${project.name}: its proxies are read over the preview URL (${diag.messageOf(error)})`);
    return [];
  });
  if (current.cancelled) return;
  const unpin = exportExcerpts.pin(excerpts.map((one) => one.path));
  // The viewer's playhead's chunk first, then on from there (the viewer plays each as it lands).
  const at = focus.get(project.id);
  focus.delete(project.id);
  let job: ExportJob;
  try {
    job = native().ExportJob.start({ project: input, options, plan: at === undefined ? plan : { ...plan, focus: at }, output, cacheDir: app.store.cacheDir(), excerpts }, (progress) => {
      current.progress = progress;
      publishSoon(app, project.id);
    });
  } catch (error) {
    unpin();
    throw error;
  }
  current.job = job;
  if (current.cancelled) job.cancel();
  try {
    await job.wait();
  } catch (error) {
    if (current.cancelled) return;
    throw error;
  } finally {
    unpin();
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

/**
 * How long an agent's turn has been over before its edit is made smooth (a
 * follow-up turn may start meanwhile); whether it would be made on Modal;
 * whether R2 has a render at a key. Tests change them.
 */
export const hooks = {
  afterTurnMs: 45_000,
  toCloud: (project: Project) => toCloud(project),
  inCloud: async (key: string): Promise<boolean> => cloud.enabled() && (await cloud.head(key).catch(() => null)) !== null,
};

/**
 * Follows exports: a local one stops a render, which carries on once it's done.
 * And the agent: when its turn is over (and no follow-up has started), the
 * edit is made smooth by itself, so it plays smoothly when someone opens it
 * (the user, Oct 31: "too many loading frame issues… the biggest issue"; a
 * 40-minute edit was only rendered once someone sat watching it): here, behind
 * any export, since Edit moved off Modal (Sphe, Nov 2), and shared in R2 for
 * the other Macs. Never on a trial server.
 */
export function start(app: App): void {
  const turns = new Map<string, number>();
  app.store.subscribe((event) => {
    if (event.type === "agent" && event.event === "status" && typeof event.project === "string" && process.env.EDIT_TRIALS !== "1") {
      // A sub-agent's turns (the fresh-eyes pass, `<project>~review`) are the project's: it's rendered after them.
      const project = event.project.split("~")[0]!;
      const turn = (turns.get(project) ?? 0) + 1;
      turns.set(project, turn);
      if (event.running !== false) return;
      setTimeout(() => {
        if (turns.get(project) !== turn || app.store.get(project) === null) return;
        requestQuietly(app, project);
      }, hooks.afterTurnMs).unref?.();
      return;
    }
    if (event.type !== "export") return;
    if (event.state === "running" && exporting(app)) yieldToExport(app);
    else if (event.state !== "running" && event.state !== "queued") void next(app);
  });
}

/** What playback_stream.ts serves for revision `rev` of `id`: the render under way, or the one made, when it's that revision's and made here. */
const lookup: playbackStream.Lookup = (app, id, rev) => {
  const fps = app.store.get(id)?.project.settings.fps ?? 30;
  if (running?.project === id) return running.rev === rev && !running.cloud ? { output: file(app, id), heard: running.heard ?? true, fps, since: running.started } : null;
  const done = record(app, id);
  if (!present(app, id, done) || done.key !== undefined) return null;
  // A save that changed nothing seen keeps the render (status's rule).
  const live = app.store.get(id);
  const current = done.rev === rev || (live !== null && live.rev === rev && done.hash === pictureHash(live.project));
  return current ? { output: file(app, id), heard: done.heard ?? true, fps, since: null } : null;
};

export function routes(router: Router<App>): void {
  playbackStream.routes(router, lookup, (app, id) => app.store.get(id)?.project.settings.fps ?? 30, (app, id) => file(app, id));
  router
    .get("/api/projects/{id}/playback", ({ app, params }) => json(status(app, params.id ?? "")))
    .post("/api/projects/{id}/playback", async ({ app, params, request: given }) => {
      let frame: number | undefined;
      try {
        const body = (await given.json()) as { frame?: unknown };
        if (typeof body.frame === "number") frame = body.frame;
      } catch {
        // No body: from the start.
      }
      return json(request(app, params.id ?? "", frame));
    })
    .get("/api/projects/{id}/playback.mp4", async ({ app, params, request: given }) => {
      const id = params.id ?? "";
      const done = record(app, id);
      if (!present(app, id, done)) throw notFound("no smooth playback yet");
      if (done.key !== undefined) {
        const here = localCopy(app, id, done.key);
        if (here !== null) {
          const response = serveFile(given, here);
          response.headers.set("cache-control", "private, max-age=86400");
          return response;
        }
        const streamed = await streamFromCloud(given, { proxy: done.key }, "proxy");
        if (streamed === null) throw new ApiError(503, "smooth playback needs Edit's cloud connection");
        return streamed;
      }
      const response = serveFile(given, file(app, id));
      // Each render is a new address (`v`), so a version may be kept.
      response.headers.set("cache-control", "private, max-age=86400");
      return response;
    });
}
