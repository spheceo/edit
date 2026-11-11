// Coded effects (Edit V2, a beta: a project with `hq`). A graphic is a web
// page the agent writes, kept as a folder of code among the project's media:
//
//     <home>/media/<project>/effects/<name>/scene.html   (and whatever it loads from beside it)
//
// The page draws any moment on request (`window.duration`, `window.ready`,
// `window.seek(t)`: effect_runtime.html, which the server puts into the page,
// says the rest). Playing it is asking it for the playhead's moment, so the
// viewer plays it the instant it's written, with no render (the page in a
// frame over the picture; apps/web's `EffectLayer`), and the agent looks at it
// as stills from the Chrome Edit drives (`look`).
//
// The code is the agent's, so the page is shut in wherever it runs: no origin
// of its own (no cookies, no storage, no way to the page around it), no
// network, and nothing loaded from outside its own folder (`policy`). Checked
// Nov 10 with the team's evidence board in headless Chrome on Linux: inside
// those walls, the playhead sent by message, it held 60 frames a second for
// its 44 s (two late).
//
//     GET /api/projects/{id}/effects                 the project's effects, each with its page's address and when it last changed
//     GET /api/effects/{key}/{id}/{name}/{file…}     a file of one, the page itself with Edit's runtime in it
//
// A page with no origin is a stranger to the server as well: every route
// refuses it (http/host.ts), so nothing of the app answers it. Its own files
// are the one thing it's let read, and by the address alone: `KEY`, made anew
// each time Edit starts and told only to Edit's own page with the list above,
// is part of every file's path, so no other site's page can name one.
//
// The render: once an effect's code has stopped changing for a few seconds,
// and while it's on the timeline, it's drawn frame by frame in Chromes Edit
// drives, side by side (each `seek` is pure, so any frame can be drawn by any
// of them), and the video made of the frames takes the still's place under the
// same media id (`Media::effect_key` says which version of the code it is). The
// engine then plays and exports it like footage, and the viewer stops playing
// the page live (a Mac's window draws the render on its own player, where a
// heavy page can't keep up: Nov 10, the evidence board's blur at 16 frames a
// second in WKWebView). Every export waits for the renders it needs
// (`waitForRenders`). Measured Nov 11 on mandalorian: a 1080p frame captured as
// JPEG in 84 ms (a PNG 534), four Chromes 41 frames a second together.
//
// Not yet: sound, and effects kept in the cloud (the folder is this
// computer's; another computer plays the render, which the cloud does carry).

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { join, sep } from "node:path";
import type { App } from "./app.ts";
import * as devtools from "./chrome_devtools.ts";
import * as diag from "./diag.ts";
import runtimeText from "./effect_runtime.html" with { type: "text" };
import { writeAtomic } from "./files.ts";
import { ApiError, json, notFound } from "./http/errors.ts";
import { serveFile } from "./http/files.ts";
import { letStrangersRead } from "./http/host.ts";
import type { RouteContext, Router } from "./http/router.ts";
import { importPaths } from "./import.ts";
import { fingerprint } from "./hash.ts";
import { probe as probeFile, Semaphore } from "./media.ts";
import type { Media, Project } from "./model.ts";
import { native } from "./native/index.ts";
import { fps as rateOf } from "./project.ts";
import * as relay from "./relay.ts";
import * as seams from "./seams.ts";
import type { Store } from "./store.ts";
import * as tools from "./tools.ts";

/** Edit's side of every effect page (effect_runtime.html), put in ahead of the page's own code. */
const RUNTIME = runtimeText as unknown as string;

/** The page an effect's folder must have. */
export const ENTRY = "scene.html";

const KEY = randomBytes(16).toString("hex");
/** Where every effect's files are served: unguessable, and the one path a page with no origin may read. */
const BASE = `/api/effects/${KEY}/`;
letStrangersRead(BASE);

/** An effect's folder as an address on this server (ending "/"). */
function addressOf(project: string, name: string): string {
  return `${BASE}${encodeURIComponent(project)}/${name}/`;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Where a project's effects are kept: a folder each, by name. */
export function root(store: Store, project: string): string {
  return join(store.uploadsDir(project), "effects");
}

/** One effect's folder; a name that isn't lower-case letters, digits and hyphens is refused. */
export function folder(store: Store, project: string, name: string): string {
  if (!NAME.test(name)) throw new Error(`an effect's name is lower-case letters, digits and hyphens (its folder's name): "${name}" isn't`);
  return join(root(store, project), name);
}

export interface Effect {
  name: string;
  /** When its newest file last changed (ms): a new number is a new page to load. */
  changed: number;
  /** Its page's address on this server, for the viewer's frame. */
  page: string;
  /** The version of its code (`sourceKey`): a media whose `effect_key` is this one plays its render, not the page. */
  key: string;
}

/** Every file in a folder, however deep: its path inside the folder, size and when it changed. */
function filesIn(dir: string, under = ""): [string, number, number][] {
  const found: [string, number, number][] = [];
  for (const entry of fs.readdirSync(join(dir, under), { withFileTypes: true })) {
    const inside = under === "" ? entry.name : `${under}/${entry.name}`;
    if (entry.isDirectory()) found.push(...filesIn(dir, inside));
    else if (entry.isFile()) {
      const stat = fs.statSync(join(dir, inside));
      found.push([inside, stat.size, Math.floor(stat.mtimeMs)]);
    }
  }
  return found.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * The version of an effect's code: its files (each by name, size and when it
 * last changed), Edit's runtime and the frame it's drawn at. A save makes a new
 * one, and so does a new build whose runtime draws differently.
 */
function sourceKey(files: [string, number, number][], frame: { width: number; height: number; fps: number }): string {
  return fingerprint([RUNTIME, `${frame.width}x${frame.height}@${frame.fps}`, ...files.map(([path, size, changed]) => `${path} ${size} ${changed}`)]);
}

/** The project's effects: every folder with a page in it, by name. */
export function list(store: Store, project: string): Effect[] {
  const live = store.get(project);
  const frame = live === null ? { width: 0, height: 0, fps: 0 } : frameOf(live.project);
  let names: string[];
  try {
    names = fs.readdirSync(root(store, project));
  } catch {
    return [];
  }
  const found: Effect[] = [];
  for (const name of names.sort()) {
    if (!NAME.test(name)) continue;
    const dir = join(root(store, project), name);
    try {
      if (!fs.statSync(join(dir, ENTRY)).isFile()) continue;
      const files = filesIn(dir);
      found.push({ name, changed: Math.max(0, ...files.map((one) => one[2])), page: `${addressOf(project, name)}${ENTRY}`, key: sourceKey(files, frame) });
    } catch {
      // A folder with no page yet: the agent is still writing it.
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// The agent's hands

/** Claude Code's own tools the agent of a project with effects has: files, and nothing that runs a command or reaches the network. */
export const FILE_TOOLS: readonly string[] = ["Read", "Write", "Edit", "Glob", "Grep"];

/** Those tools allowed in `dir` and nowhere else (Claude Code's permission rules: `//` opens a path from the disk's root; a search is held to what may be read). */
export function fileRules(dir: string): string[] {
  return [`Read(/${dir}/**)`, `Edit(/${dir}/**)`, `Write(/${dir}/**)`];
}

/** Where a project's agent writes its effects: the folder, made and watched from here on, by the name the disk itself gives it (the rules above are held to that one). */
export function workshop(store: Store, project: string): string {
  const dir = root(store, project);
  fs.mkdirSync(dir, { recursive: true });
  watch(store, project);
  return fs.realpathSync(dir);
}

// ---------------------------------------------------------------------------
// Telling the viewer

const watched = new Map<string, fs.FSWatcher>();
/** Told when a project's effects change on disk (the renders, once `start` has run). */
let changed: ((project: string) => void) | null = null;

/**
 * Watches a project's effects from here on, so a file the agent writes is on
 * screen at once: every change tells the open editors (`{type: "effects"}`),
 * which load the page again. Started by whoever needs it (a turn in an HQ
 * project, an editor asking for the list) and kept while Edit runs.
 */
export function watch(store: Store, project: string): void {
  if (watched.has(project)) return;
  const dir = root(store, project);
  try {
    fs.mkdirSync(dir, { recursive: true });
    let soon: ReturnType<typeof setTimeout> | null = null;
    const watcher = fs.watch(dir, { recursive: true }, () => {
      // A save is several events (the write, the rename into place): one message for them all.
      if (soon !== null) return;
      soon = setTimeout(() => {
        soon = null;
        store.emit({ type: "effects", id: project, effects: list(store, project) });
        changed?.(project);
      }, 40);
    });
    watcher.on("error", (error) => {
      diag.warn("effects", `${project}: watching its effects stopped: ${diag.messageOf(error)}`);
      watcher.close();
      watched.delete(project);
    });
    watched.set(project, watcher);
  } catch (error) {
    diag.warn("effects", `${project}: its effects can't be watched: ${diag.messageOf(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Serving the page, shut in

/**
 * What the page may do, sent with every file of an effect. `sandbox` with only
 * scripts allowed gives it no origin; the rest lets it load from its own
 * folder (`own`), from data it made itself, and from nowhere else, and ask the
 * network for nothing. The server's own guard is the second wall: a page with
 * no origin is a stranger to every route but its effect's files (http/host.ts).
 */
function policy(own: string): string {
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${own}`,
    `style-src 'unsafe-inline' ${own}`,
    `img-src ${own} data: blob:`,
    `font-src ${own} data:`,
    `media-src ${own} data: blob:`,
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    // Framed by Edit's own viewer and by no other site's page.
    "frame-ancestors 'self'",
  ].join("; ");
}

/** The effect's own folder as the page's browser names it: the host it asked (already checked against the hosts Edit answers to) and the folder's path, in whichever scheme the page came by. */
function ownSource(request: Request, project: string, name: string): string {
  const host = request.headers.get("host") ?? "";
  // A policy can't name an IPv6 address: the whole of Edit's own address then, which the missing origin still keeps it out of.
  if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) return "'self'";
  return `${host}${addressOf(project, name)}`;
}

/** The page with Edit's runtime ahead of its own code. */
function withRuntime(page: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(page);
  return doctype === null ? `${RUNTIME}${page}` : `${doctype[0]}\n${RUNTIME}${page.slice(doctype[0].length)}`;
}

function file(context: RouteContext<App>): Response {
  const { app, params, request } = context;
  const project = params.id!;
  if (params.key !== KEY) throw notFound("no such effect");
  if (app.store.get(project) === null) throw notFound("no such project");
  const why = app.store.unavailable(project);
  if (why !== null) throw new ApiError(403, why);
  let dir: string;
  try {
    dir = folder(app.store, project, params.name!);
  } catch {
    throw notFound("no such effect");
  }
  const parts = [params.a, params.b, params.c].filter((part): part is string => part !== undefined);
  if (parts.some((part) => part === "" || part === "." || part === ".." || /[/\\\0]/.test(part))) throw notFound("no such file");
  // The file itself, wherever a link in the folder points: nothing outside the folder is served.
  let path: string;
  try {
    path = fs.realpathSync(join(dir, ...parts));
    if (!path.startsWith(fs.realpathSync(dir) + sep)) throw new Error("outside");
  } catch {
    throw notFound("no such file");
  }
  const headers = { "content-security-policy": policy(ownSource(request, project, params.name!)), "cache-control": "no-store" };
  if (path.endsWith(".html")) {
    let page: string;
    try {
      page = fs.readFileSync(path, "utf8");
    } catch {
      throw notFound("no such file");
    }
    return new Response(withRuntime(page), { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
  }
  const response = serveFile(request, path);
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  // A page with no origin asks for its fonts and its script modules as a stranger would, and a browser hands those
  // over only when the server says a page of no origin may read them. Said for those alone: the pictures beside
  // them (the case's photos) are shown by the page and stay unreadable to anything else that asks.
  if (/\.(ttf|otf|woff2?|m?js|css)$/i.test(path)) response.headers.set("access-control-allow-origin", "null");
  return response;
}

export function routes(router: Router<App>): void {
  router
    .get("/api/projects/{id}/effects", ({ app, params }: RouteContext<App>) => {
      const project = params.id!;
      if (app.store.get(project) === null) throw notFound("no such project");
      const why = app.store.unavailable(project);
      if (why !== null) throw new ApiError(403, why);
      watch(app.store, project);
      return json({ effects: list(app.store, project) });
    })
    .get("/api/effects/{key}/{id}/{name}/{a}", file)
    .get("/api/effects/{key}/{id}/{name}/{a}/{b}", file)
    .get("/api/effects/{key}/{id}/{name}/{a}/{b}/{c}", file);
}

// ---------------------------------------------------------------------------
// Looking at one: stills from the Chrome Edit drives

const PROFILE = "edit-effect-";

let kept: { page: Promise<devtools.Page>; width: number; height: number; interval: number } | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;
let line: Promise<unknown> = Promise.resolve();

function close(): void {
  const open = kept;
  kept = null;
  // A Chrome that never started: its error went to the look that waited on it.
  void open?.page.then((page) => page.close()).catch(() => {});
}

/** One piece of work on the page of the Chrome kept open for effects (started again once if it went away), one at a time. */
function inChrome<T>(width: number, height: number, work: (page: devtools.Page, interval: number) => Promise<T>): Promise<T> {
  const turn = line.then(async () => {
    if (idle !== null) clearTimeout(idle);
    for (let attempt = 0; ; attempt++) {
      const warm = kept === null ? null : await kept.page.catch(() => null);
      if (kept === null || warm === null || warm.closed || kept.width !== width || kept.height !== height) {
        close();
        const opened = { page: devtools.open({ profile: PROFILE, width, height, gpu: true, what: "Looking at an effect" }), width, height, interval: 0 };
        kept = opened;
        // The screen's own interval there, with nothing to draw: what a frame's cost is held against.
        opened.interval = await (await opened.page).evaluate<number>(
          "new Promise((resolve) => { const gaps = []; let last = 0; const tick = (now) => { if (last) gaps.push(now - last); last = now; if (gaps.length === 12) resolve(gaps.sort((a, b) => a - b)[6]); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); })",
        );
      }
      const open = kept;
      try {
        return await work(await open.page, open.interval);
      } catch (error) {
        const gone = (await open.page.catch(() => null))?.closed !== false;
        if (!gone || attempt >= 1) throw error;
        close();
      }
    }
  });
  // The line only orders the looks: each one's error goes to its own caller.
  line = turn.catch(() => {});
  void turn.finally(() => {
    if (idle !== null) clearTimeout(idle);
    idle = setTimeout(close, 5 * 60_000);
    idle.unref?.();
  });
  return turn;
}

/** Closes the Chrome kept for effects (tests, and Edit leaving). */
export function closeChrome(): void {
  if (idle !== null) clearTimeout(idle);
  close();
}

export interface Still {
  /** Seconds into the effect. */
  time: number;
  picture: Uint8Array;
  mime: string;
  /** What a frame takes while it plays from here, in milliseconds, on this computer. */
  cost: number;
}

export interface Look {
  /** The effect's length in seconds (`window.duration`; 0 when the page doesn't say). */
  duration: number;
  stills: Still[];
  /** The screen's interval in the Chrome that drew them (ms): a cost near it plays live. */
  interval: number;
  /** Where the page's code breaks the contract (it draws on its own clock, it has no seek…), each once. */
  problems: string[];
  /** What the page threw. */
  errors: string[];
}

/** The size an effect is drawn at, and its frames a second: the project's. */
function frameOf(project: Project): { width: number; height: number; fps: number } {
  return { width: project.settings.width, height: project.settings.height, fps: rateOf(project) };
}

/** Opens an effect's page (`url`, carrying `token`) in a Chrome's page and waits for it to be ready: its length, and whether it has a seek. */
async function load(page: devtools.Page, url: string, token: string, name: string): Promise<{ duration: number; seek: boolean }> {
  await page.call("Page.navigate", { url });
  const loaded = await page.evaluate<{ duration: number; seek: boolean } | "none" | "slow">(
    `new Promise((resolve) => {
      const until = Date.now() + 20000;
      (function wait() {
        if (location.search.includes(${JSON.stringify(token)}) && window.__edit) {
          const slow = setTimeout(() => resolve("slow"), Math.max(0, until - Date.now()));
          window.__edit.ready.then((value) => { clearTimeout(slow); resolve(value); });
        } else if (Date.now() > until) resolve("none");
        else setTimeout(wait, 30);
      })();
    })`,
    40_000,
  );
  if (loaded === "none") throw new Error(`${name}'s page didn't load in Chrome`);
  if (loaded === "slow") throw new Error(`${name}'s window.ready didn't resolve in 20 s: a picture or font it waits for never loads (everything it loads must be in its own folder)`);
  return loaded;
}

/**
 * The effect as the Chrome Edit drives draws it: its length, a still at each
 * of `times` (null: six spread over its length; `side`: the longest side in
 * pixels, whole frames as PNG when 0),
 * what a frame costs to play from each, and everything wrong the page or the
 * runtime noticed. A page that can't be loaded at all is the error.
 */
export async function look(app: App, projectId: string, name: string, times: number[] | null, side = 960): Promise<Look> {
  const live = app.store.get(projectId);
  if (live === null) throw new Error("no such project");
  const dir = folder(app.store, projectId, name);
  if (!fs.existsSync(join(dir, ENTRY))) {
    const others = list(app.store, projectId).map((effect) => effect.name);
    throw new Error(`no effect "${name}": it needs ${ENTRY} at effects/${name}/${ENTRY}${others.length > 0 ? `; there are ${others.join(", ")}` : ""}`);
  }
  const { width, height, fps } = frameOf(live.project);
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const url = `http://${seams.broll.pageHost(app)}${addressOf(projectId, name)}${ENTRY}?look=${token}`;
  const started = Date.now();
  try {
    return await inChrome(width, height, async (page, interval) => {
      const loaded = await load(page, url, token, name);
      const stills: Still[] = [];
      if (loaded.seek) {
        // Six of it, each from the middle of its sixth, when no moments are asked for.
        const wanted = times ?? (loaded.duration > 0 ? [0, 1, 2, 3, 4, 5].map((part) => Math.round(((part + 0.5) * loaded.duration * 100) / 6) / 100) : [0]);
        for (const time of wanted) {
          const cost = await page.evaluate<number>(`window.__edit.cost(${time}, ${1 / fps})`);
          await page.evaluate(`window.__edit.seek(${time})`);
          const scale = side > 0 ? Math.min(1, side / Math.max(width, height)) : 1;
          const shot = await page.call(
            "Page.captureScreenshot",
            { format: side > 0 ? "jpeg" : "png", ...(side > 0 ? { quality: 82 } : {}), clip: { x: 0, y: 0, width, height, scale } },
            90_000,
          );
          if (typeof shot.data !== "string") throw new Error("Chrome drew nothing");
          stills.push({ time, picture: new Uint8Array(Buffer.from(shot.data, "base64")), mime: side > 0 ? "image/jpeg" : "image/png", cost });
        }
      }
      const said = await page.evaluate<{ problems: string[]; errors: string[] }>("({ problems: window.__edit.problems, errors: window.__edit.errors })");
      return { duration: loaded.duration, stills, interval, problems: said.problems, errors: said.errors };
    });
  } finally {
    diag.record("effects", "look", Date.now() - started);
  }
}

// ---------------------------------------------------------------------------
// On the timeline

/**
 * The effect as one of the project's media, so it's placed and cut like
 * footage: `media.effect` names it, its length is the page's, and what the
 * engine plays for it is a still from its middle until the render is built
 * (the viewer plays the page itself, live). Adding one that's there already
 * takes its length again from the page.
 */
export async function add(app: App, projectId: string, name: string): Promise<{ media: string; duration: number }> {
  const first = await look(app, projectId, name, []);
  const wrong = [...first.errors, ...first.problems];
  if (first.duration <= 0 || wrong.length > 0) throw new Error(`${name} isn't ready for the timeline: ${wrong.join(" ") || "its page has no window.duration"}`);
  const live = app.store.get(projectId);
  const existing = live?.project.media.find((media) => media.effect === name);
  let mediaId = existing?.id;
  if (mediaId === undefined) {
    const still = (await look(app, projectId, name, [first.duration / 2], 0)).stills[0];
    if (still === undefined) throw new Error(`${name} drew nothing`);
    const dir = join(app.store.uploadsDir(projectId), "effect-stills");
    fs.mkdirSync(dir, { recursive: true });
    const path = join(dir, `${name}.png`);
    writeAtomic(path, still.picture);
    const [, added, errors] = await importPaths(app, projectId, [path], false, "agent");
    mediaId = added[0];
    if (mediaId === undefined) throw new Error(errors.join("; "));
  }
  const id = mediaId;
  await app.store.update(projectId, "agent", (project) => {
    const media = project.media.find((one) => one.id === id);
    if (media === undefined) throw new Error(`media ${id} is gone`);
    media.effect = name;
    media.name = name;
    media.duration = first.duration;
  });
  return { media: id, duration: first.duration };
}

/**
 * A picture of the project's put into an effect's folder, where its page can
 * load it (the page reaches nothing outside the folder): a photo as it is, or
 * the frame of a video at `time`. Answers the file's name beside scene.html
 * and its size.
 */
export async function give(app: App, projectId: string, name: string, mediaId: string, time: number | null, as: string | null): Promise<{ file: string; width: number; height: number }> {
  const live = app.store.get(projectId);
  if (live === null) throw new Error("no such project");
  const media = live.project.media.find((one) => one.id === mediaId);
  if (media === undefined) throw new Error(`no media ${mediaId}`);
  if (media.kind === "audio") throw new Error(`${mediaId} is a sound: an effect takes pictures`);
  if (media.effect !== undefined && media.effect !== null) throw new Error(`${mediaId} is an effect itself`);
  const dir = folder(app.store, projectId, name);
  fs.mkdirSync(dir, { recursive: true });
  const stem = (as ?? media.name).replace(/\.[A-Za-z0-9]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "picture";
  if (media.kind === "image") {
    const extension = /\.([A-Za-z0-9]+)$/.exec(media.path)?.[1]?.toLowerCase() ?? "png";
    const file = `${stem}.${extension}`;
    fs.copyFileSync(media.path, join(dir, file));
    return { file, width: media.width, height: media.height };
  }
  if (time === null || !(time >= 0 && time <= media.duration)) throw new Error(`${mediaId} is a video: give the second of the frame to take (0 to ${media.duration.toFixed(2)})`);
  const file = `${stem}.png`;
  await native().saveStill(structuredClone(media), time, join(dir, file));
  return { file, width: media.width, height: media.height };
}

/** The effects a project's timeline shows, by the clips of their media. */
export function onTimeline(project: Project): string[] {
  const names: string[] = [];
  for (const media of project.media) {
    if (media.effect === undefined || media.effect === null || names.includes(media.effect)) continue;
    if (project.clips.some((clip) => (clip.type === "video" || clip.type === "audio") && clip.media === media.id)) names.push(media.effect);
  }
  return names;
}

// ---------------------------------------------------------------------------
// The render

/** How long an effect's code has to stay unchanged before it's rendered: the agent saves a page several times a minute while it works. */
const SETTLE_MS = 6_000;
/** Chromes drawing one render side by side: as the map shots, by the computer's memory. */
const CHROMES = os.totalmem() >= 16 * 2 ** 30 ? 4 : 2;
const RENDER_PROFILE = "edit-effect-render-";

/** Where a project's renders and their frames are kept. */
function rendersDir(store: Store, project: string): string {
  return join(store.uploadsDir(project), "effect-renders");
}

/** A render that stopped because the code changed under it: it's started again for the new code. */
class Outdated extends Error {}

/** One effect's render: what it's for and how far it's got. */
interface Render {
  project: string;
  name: string;
  key: string;
  /** Frames drawn of all of them (0 until its length is known). */
  drawn: number;
  frames: number;
  done: Promise<void>;
}

const renders = new Map<string, Render>();
/** Renders that failed, by project, effect and code version: not tried again until the code changes. */
const failed = new Map<string, string>();
const settling = new Map<string, ReturnType<typeof setTimeout>>();
const renderSlot = new Semaphore(1);
const id = (project: string, name: string, key: string) => `${project}/${name}/${key}`;

/** The effects on a project's timeline, each with its media, its code now (null: not on this computer) and whether its render is that code's. */
function needed(store: Store, project: string): { name: string; media: Media; current: Effect | null; fresh: boolean }[] {
  const live = store.get(project);
  if (live === null || live.project.hq !== true) return [];
  const effects = list(store, project);
  const out: { name: string; media: Media; current: Effect | null; fresh: boolean }[] = [];
  for (const name of onTimeline(live.project)) {
    const media = live.project.media.find((one) => one.effect === name)!;
    const current = effects.find((one) => one.name === name) ?? null;
    // Made on another computer: whatever it rendered there is what there is.
    const fresh = current === null ? media.effect_key !== undefined && media.effect_key !== null : media.effect_key === current.key;
    out.push({ name, media, current, fresh });
  }
  return out;
}

/**
 * Renders an effect's code as it is now, unless it's rendered already or
 * under way: the frames drawn in `CHROMES` Chromes at once, kept on disk as
 * they land (a render cut short goes on from them), joined into a video, and
 * that put in place of the still. Answers when it's in place.
 */
export function renderNow(app: App, project: string, name: string): Promise<void> {
  const dir = folder(app.store, project, name);
  const live = app.store.get(project);
  if (live === null) return Promise.reject(new Error("no such project"));
  const key = sourceKey(filesIn(dir), frameOf(live.project));
  const running = renders.get(id(project, name, key));
  if (running !== undefined) return running.done;
  const failure = failed.get(id(project, name, key));
  if (failure !== undefined) return Promise.reject(new Error(failure));
  const render: Render = { project, name, key, drawn: 0, frames: 0, done: Promise.resolve() };
  render.done = renderSlot
    .with(() => draw(app, render))
    .catch((error: unknown) => {
      if (error instanceof Outdated) return renderNow(app, project, name);
      const said = diag.messageOf(error);
      failed.set(id(project, name, key), said);
      diag.warn("effects", `${project}: ${name} didn't render: ${said}`);
      throw new Error(`${name} didn't render: ${said}`);
    })
    .finally(() => renders.delete(id(project, name, key)));
  renders.set(id(project, name, key), render);
  // Its error goes to whoever waits on it; one nobody waits on is in the log.
  render.done.catch(() => {});
  return render.done;
}

async function draw(app: App, render: Render): Promise<void> {
  const { project, name, key } = render;
  const live = app.store.get(project);
  if (live === null) throw new Error("the project is gone");
  const frame = frameOf(live.project);
  const dir = rendersDir(app.store, project);
  const out = join(dir, `${name}-${key}.mp4`);
  const frames = join(dir, `${name}-${key}.frames`);
  const started = Date.now();
  if (!fs.existsSync(out)) {
    fs.mkdirSync(frames, { recursive: true });
    const url = `http://${seams.broll.pageHost(app)}${addressOf(project, name)}${ENTRY}?render=`;
    const opened: devtools.Page[] = [];
    try {
      for (let at = 0; at < CHROMES; at++) opened.push(await devtools.open({ profile: RENDER_PROFILE, width: frame.width, height: frame.height, gpu: true, what: "Rendering an effect" }));
      const loaded = await Promise.all(opened.map((page, at) => load(page, `${url}${key}-${at}`, `${key}-${at}`, name)));
      const duration = loaded[0]!.duration;
      if (!(duration > 0)) throw new Error("its page has no window.duration");
      if (!loaded[0]!.seek) throw new Error("its page has no window.seek(t)");
      render.frames = Math.max(1, Math.round(duration * frame.fps));
      const wanted: number[] = [];
      for (let index = 0; index < render.frames; index++) if (!fs.existsSync(join(frames, frameName(index)))) wanted.push(index);
      render.drawn = render.frames - wanted.length;
      let next = 0;
      await Promise.all(
        opened.map(async (page) => {
          for (;;) {
            const index = wanted[next++];
            if (index === undefined) return;
            // The code changed while it rendered: these frames are an older version's.
            if (index % 60 === 0 && sourceKey(filesIn(folder(app.store, project, name)), frame) !== key) throw new Outdated();
            const time = index / frame.fps;
            const drawn = await page.evaluate<{ error?: string }>(`window.__edit.seek(${time})`, 15_000);
            if (drawn.error !== undefined) throw new Error(`its page threw at ${time.toFixed(2)} s: ${drawn.error.split("\n")[0]}`);
            const shot = await page.call("Page.captureScreenshot", { format: "jpeg", quality: 95, optimizeForSpeed: true, clip: { x: 0, y: 0, width: frame.width, height: frame.height, scale: 1 } }, 60_000);
            if (typeof shot.data !== "string") throw new Error(`Chrome drew nothing at ${time.toFixed(2)} s`);
            // Whole frames only: one cut short by a quit is drawn again.
            const path = join(frames, frameName(index));
            fs.writeFileSync(`${path}.partial`, Buffer.from(shot.data, "base64"));
            fs.renameSync(`${path}.partial`, path);
            render.drawn += 1;
          }
        }),
      );
    } finally {
      for (const page of opened) page.close();
    }
    const partial = join(dir, `${name}-${key}.partial.mp4`);
    try {
      await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-framerate", rateArg(live.project), "-i", join(frames, "frame-%05d.jpg"), "-vf", "format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "14", "-an", "-movflags", "+faststart", partial]);
      fs.renameSync(partial, out);
    } catch (error) {
      fs.rmSync(partial, { force: true });
      throw new Error(`its frames didn't join into a video: ${diag.messageOf(error)}`);
    }
    fs.rmSync(frames, { recursive: true, force: true });
  }
  const probe = await probeFile(out);
  if (probe.kind !== "video" || !(probe.duration > 0)) throw new Error("its render isn't a video Edit can read");
  // Code changed while the video was made: the next render takes over.
  if (sourceKey(filesIn(folder(app.store, project, name)), frame) !== key) throw new Outdated();
  let placed = false;
  await app.store.update(project, "effects", (edited) => {
    for (const media of edited.media) {
      if (media.effect !== name) continue;
      media.path = out;
      media.kind = probe.kind;
      media.duration = probe.duration;
      media.width = probe.width;
      media.height = probe.height;
      media.fps = probe.fps;
      media.has_audio = probe.has_audio;
      media.effect_key = key;
      delete media.cloud;
      placed = true;
    }
    return placed;
  });
  if (!placed) return;
  app.media.ensure(out, probe);
  try {
    if (relay.cloudEnabled()) seams.cloudMedia.backfillSoon(app, project);
  } catch (error) {
    diag.warn("cloud", `backfill ${project}: ${diag.messageOf(error)}`);
  }
  diag.record("effects", "render", Date.now() - started);
  diag.info("effects", `${project}: ${name} rendered (${render.frames} frames in ${((Date.now() - started) / 1000).toFixed(1)} s)`);
}

function frameName(index: number): string {
  return `frame-${String(index).padStart(5, "0")}.jpg`;
}

/** The project's rate as FFmpeg reads it ("30", "30000/1001"). */
function rateArg(project: Project): string {
  const whole = Math.max(project.settings.fps, 1);
  return project.settings.ntsc === true ? `${whole * 1000}/1001` : String(whole);
}

/**
 * Renders, a few seconds after the code stops changing, every effect on the
 * project's timeline whose render isn't of its code now. Called on every
 * change to the project or its effects; cheap when there's nothing to do.
 */
export function renderSoon(app: App, project: string): void {
  const waiting = settling.get(project);
  if (waiting !== undefined) clearTimeout(waiting);
  const timer = setTimeout(() => {
    settling.delete(project);
    for (const effect of needed(app.store, project)) {
      if (effect.fresh || effect.current === null) continue;
      renderNow(app, project, effect.name).catch(() => {});
    }
  }, SETTLE_MS);
  timer.unref?.();
  settling.set(project, timer);
}

/** What the agent is told of an effect's render: null while the effect isn't on the timeline (nothing renders it then). */
export function renderLine(app: App, project: string, name: string): string | null {
  const effect = needed(app.store, project).find((one) => one.name === name);
  if (effect === undefined) return null;
  if (effect.fresh) return "Its render is of this code: that's what plays and exports.";
  const state = effect.current === null ? null : renderState(project, name, effect.current.key);
  return state === null ? "Its render follows a few seconds after the code stops changing; until then the viewer plays the code live." : `Its render: ${state}.`;
}

/** What an effect's render is doing, for the agent and the person: null when there's nothing to say. */
export function renderState(project: string, name: string, key: string): string | null {
  const running = renders.get(id(project, name, key));
  if (running !== undefined) return running.frames > 0 ? `rendering, ${running.drawn} of ${running.frames} frames` : "rendering";
  const failure = failed.get(id(project, name, key));
  return failure === undefined ? null : `its render failed: ${failure}`;
}

/**
 * Waits (up to `limitMs`) for every effect on the timeline to be rendered from
 * its code as it is, starting any render that isn't under way: an export never
 * goes out with a still, or an older version, where an effect is. An error
 * says which effect and why.
 */
export async function waitForRenders(app: App, project: string, limitMs: number): Promise<void> {
  const until = Date.now() + limitMs;
  for (const effect of needed(app.store, project)) {
    if (effect.fresh) continue;
    if (effect.current === null) throw new Error(`${effect.name} is a coded effect made on another computer and never rendered there: open the project there to render it`);
    const done = renderNow(app, project, effect.name);
    const left = until - Date.now();
    const timedOut = await Promise.race([done.then(() => false), Bun.sleep(Math.max(0, left)).then(() => true)]);
    if (timedOut) {
      throw new Error(`${effect.name} is still rendering (${renderState(project, effect.name, effect.current.key) ?? "starting"}): it's done in a minute or two, then export again`);
    }
  }
}

/**
 * From Edit's start: every change to a project made the new way (a clip of an
 * effect placed, a file of one saved) brings its renders up to date, and the
 * ones left undone when Edit last closed are made.
 */
export function start(app: App): void {
  changed = (project) => renderSoon(app, project);
  app.store.subscribe((event) => {
    if (event.type !== "project" || typeof event.id !== "string" || event.origin === "effects") return;
    if ((event.project as Project | undefined)?.hq === true) renderSoon(app, event.id);
  });
  for (const summary of app.store.list()) {
    if (summary.hq !== true) continue;
    watch(app.store, summary.id);
    renderSoon(app, summary.id);
  }
}
