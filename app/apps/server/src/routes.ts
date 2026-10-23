// The server's generic handlers (health, diagnostics, setup, the file browser,
// the media drive, updates, projects, imports and uploads, media files,
// frames, exports) and `buildRouter`, which puts them together with every
// package's routes.

import * as windowFocus from "./window_focus.ts";
import * as accounts from "./accounts.ts";
import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { cleanCache } from "./cache_cleanup.ts";
import { importDrive } from "./drive_import.ts";
import { deleteExport, listExports } from "./exports.ts";
import { ioMessage } from "./files.ts";
import { ApiError, bad, json, notFound } from "./http/errors.ts";
import { serveFile } from "./http/files.ts";
import { badShape, pathEndingAt, readJson, showPath, type RouteContext, type Router } from "./http/router.ts";
import { baseRouter } from "./http/server.ts";
import { importPaths } from "./import.ts";
import { routes as mediaRoutes } from "./media_tools.ts";
import { check as checkDrive, status as driveStatus } from "./media_drive/layout.ts";
import { isMediaPath, Semaphore } from "./media.ts";
import type { ExportOptions, Project, Style } from "./model.ts";
import { withProjectAsync } from "./native/index.ts";
import * as patches from "./patch.ts";
import { canonical, expandHome, extension, fileName, fileStem, isFile, join, parent } from "./paths.ts";
import { DEFAULT_SETTINGS } from "./project.ts";
import * as seams from "./seams.ts";
import { defaultExportPath } from "./server_seam.ts";
import { storageReport, verifyExports } from "./storage.ts";
import { missingMedia, UpdateError } from "./store.ts";
import * as archive from "./archive.ts";
import * as avatars from "./avatars.ts";
import * as covers from "./covers.ts";
import * as kinds from "./kinds.ts";
import * as reviews from "./reviews.ts";
import * as tools from "./tools.ts";
import * as writerHandoff from "./writer_handoff.ts";
import { BUILD, VERSION } from "./version.ts";
import { jsonForSerde } from "./rust.ts";

type Context = RouteContext<App>;

/**
 * Every route the server answers: the generic ones, every package's routes
 * in it (the library, drive, agent and map routes are one `media_tools`
 * call; captions, watch and transcribe are `captions.routes`).
 */
export function buildRouter(): Router<App> {
  const router = baseRouter()
    .get("/api/health", health)
    .get("/api/diagnostics", diagnostics)
    // The Logs window: the lines after `since` (ms), and the log file shown in Finder.
    .get("/api/logs", ({ query }) => {
      const since = Number(query.get("since") ?? 0) || 0;
      return json({ lines: diag.lines(2000).filter((line) => line.at > since) });
    })
    .post("/api/logs/reveal", ({ app }) => {
      Bun.spawn(["open", "-R", join(app.store.home, "logs", "edit.log")], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      return json({ ok: true });
    })
    .get("/api/setup", setup)
    .get("/api/media-drive", mediaDrive)
    .post("/api/media-drive", setMediaDrive);
  seams.cloudProjects.routes(router);
  // Before /api/projects/{id}: /api/projects/status is its own.
  reviews.routes(router);
  accounts.routes(router);
  windowFocus.routes(router);
  writerHandoff.routes(router);
  archive.routes(router);
  covers.routes(router);
  avatars.routes(router);
  seams.voice.routes(router);
  router
    .post("/api/diagnostics/client", clientLog)
    .get("/api/update", updateStatus)
    .post("/api/update", updateInstall)
    .put("/api/update/channel", updateChannel)
    .get("/api/projects", listProjects)
    .post("/api/projects", createProject)
    .get("/api/projects/{id}", getProject)
    .put("/api/projects/{id}", putProject)
    .delete("/api/projects/{id}", deleteProject)
    .post("/api/projects/{id}/import", importMedia)
    .post("/api/projects/{id}/import-drive", importDriveMedia)
    .post("/api/projects/{id}/upload", uploadMedia, { bodyLimit: null })
    .get("/api/projects/{id}/media-status", mediaStatus)
    .get("/api/projects/{id}/missing", missingFootage);
  mediaRoutes(router);
  seams.research.routes(router);
  seams.captions.routes(router);
  seams.subtitles.routes(router);
  router
    .get("/api/projects/{id}/media/{media}/{kind}", mediaFile)
    .get("/api/projects/{id}/frame/{frame}", framePng)
    .get("/api/projects/{id}/cover/{frame}", coverJpeg)
    .post("/api/projects/{id}/export", startExport)
    .post("/api/projects/{id}/export/cancel", cancelExport)
    .get("/api/projects/{id}/exports", projectExports)
    .get("/api/storage", async ({ app }) => json({ ...storageReport(app.store.home), exports: await verifyExports(app.store.home) }))
    .post("/api/cache/clean", cleanTheCache)
    .post("/api/projects/{id}/exports/delete", deleteProjectExport);
  router
    .get("/api/export/encoders", exportEncoders)
    .get("/api/exports/file", exportedFile)
    .post("/api/exports/reveal", revealExport);
  seams.script.routes(router);
  router.get("/api/fs", browse);
  return router;
}

// ---------------------------------------------------------------------------
// Request helpers

/** axum's `Query` rejection: plain text, 400. */
function badQuery(why: string): ApiError {
  return new ApiError(400, `Failed to deserialize query string: ${why}`, true);
}

/** A `u32` query value (`?max=`), absent as null. */
function u32Query(context: Context, name: string): number | null {
  const value = context.query.get(name);
  if (value === null) return null;
  if (!/^\+?\d+$/.test(value)) {
    throw badQuery(value === "" ? "cannot parse integer from empty string" : "invalid digit found in string");
  }
  const number = Number(value.replace(/^\+/, ""));
  if (number > 0xffff_ffff) throw badQuery("number too large to fit in target type");
  return number;
}

/** A `u64` query value, absent as null. */
function u64Query(context: Context, name: string): number | null {
  const value = context.query.get(name);
  if (value === null) return null;
  if (!/^\+?\d+$/.test(value)) {
    throw badQuery(value === "" ? "cannot parse integer from empty string" : "invalid digit found in string");
  }
  return Number(value.replace(/^\+/, ""));
}

function requiredQuery(context: Context, name: string): string {
  const value = context.query.get(name);
  if (value === null) throw badQuery(`missing field \`${name}\``);
  return value;
}

/** A JSON body as an object (axum's 422 when it's another kind of value). */
async function body(context: Context): Promise<Record<string, unknown>> {
  const value = await readJson<unknown>(context);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badShape(`invalid type: ${kindOf(value)}, expected a struct`);
  }
  return value as Record<string, unknown>;
}

/** `Option<Json<T>>`: no JSON content type is no body (the defaults); one is read as `Json`. */
async function optionalBody(context: Context): Promise<Record<string, unknown> | null> {
  if (context.request.headers.get("content-type") === null) return null;
  return body(context);
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "sequence";
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  if (typeof value === "number") return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
  if (typeof value === "boolean") return `boolean \`${value}\``;
  return "map";
}

/** What serde says it expected of a JSON kind ("a string"; numbers by their Rust type: "u32"). */
type Expected = "string" | "boolean" | "u32" | "u64" | "f64";

const EXPECTED: Record<Expected, string> = { string: "a string", boolean: "a boolean", u32: "u32", u64: "u64", f64: "f64" };

function field<T>(object: Record<string, unknown>, name: string, kind: Expected, required: true): T;
function field<T>(object: Record<string, unknown>, name: string, kind: Expected, required?: false): T | null;
function field<T>(object: Record<string, unknown>, name: string, kind: Expected, required = false): T | null {
  const value = object[name];
  const expected = EXPECTED[kind];
  if (value === undefined || value === null) {
    if (required && value === undefined) throw badShape(`missing field \`${name}\``);
    if (required) throw badShape(`${name}: invalid type: null, expected ${expected}`);
    return null;
  }
  const js = kind === "string" || kind === "boolean" ? kind : "number";
  if (typeof value !== js) throw badShape(`${name}: invalid type: ${kindOf(value)}, expected ${expected}`);
  if ((kind === "u32" || kind === "u64") && !Number.isInteger(value)) {
    throw badShape(`${name}: invalid type: ${kindOf(value)}, expected ${expected}`);
  }
  if ((kind === "u32" || kind === "u64") && ((value as number) < 0 || (kind === "u32" && (value as number) > 0xffff_ffff))) {
    throw badShape(`${name}: invalid value: ${kindOf(value)}, expected ${expected}`);
  }
  return value as T;
}

function liveOr404(app: App, id: string) {
  const live = app.store.get(id);
  if (live === null) throw notFound("no such project");
  // A kind of video the signed-in person can't work on (kinds.ts): hidden, not read-only.
  const why = app.store.unavailable(id);
  if (why !== null) throw new ApiError(403, why);
  return live;
}

// ---------------------------------------------------------------------------
// Server

function health({ app }: Context): Response {
  return json({ machine: app.machine, name: "edit", version: VERSION });
}

/** The first line `<tool> -version` prints, or null. */
function toolVersion(tool: string): string | null {
  try {
    const output = Bun.spawnSync([tool, "-version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const first = output.stdout.toString().split("\n")[0];
    return first === undefined ? null : first.replace(/\r$/, "");
  } catch {
    return null;
  }
}

/** Everything a problem report needs from the server side. */
function diagnostics({ app }: Context): Response {
  const version = toolVersion(tools.ffmpeg());
  return json({
    ffmpeg: version === null ? null : `${version} (${tools.bundled() ? "shipped with Edit" : "from PATH"})`,
    home: app.store.home,
    lines: diag.lines(400),
    machine: app.machine,
    os: `${diag.osName()} ${diag.archName()}`,
    timings: diag.timings(),
    uptime: diag.human(diag.uptime()),
    version: BUILD,
  });
}

/** What this machine still needs before everything in Edit works. */
async function setup({ app }: Context): Promise<Response> {
  let ffmpeg = false;
  try {
    ffmpeg = Bun.spawnSync([tools.ffmpeg(), "-version"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).success;
  } catch {
    ffmpeg = false;
  }
  let codex: Record<string, unknown>;
  try {
    codex = (await app.agents.status()) as Record<string, unknown>;
  } catch {
    codex = { ready: false, state: "missing" };
  }
  let chrome = false;
  try {
    chrome = seams.broll.chrome() !== null;
  } catch {
    chrome = false;
  }
  const loggedOut = codex.state === "logged_out";
  const checks: Record<string, unknown>[] = [];
  // Only when a media drive is set (`media_drive`).
  const layout = app.store.layout();
  if (layout.media !== null) {
    let ok = true;
    try {
      checkDrive(layout.media);
    } catch {
      ok = false;
    }
    checks.push({
      fix: "Plug it in, or turn it off with: edit media off",
      id: "media-drive",
      ok,
      title: `The media drive (${layout.media})`,
      why: "Its footage shows as missing, and imports, downloads and exports to it are refused until it's back.",
    });
  }
  checks.push(
    {
      fix: "curl -fsSL https://raw.githubusercontent.com/spheceo/edit/main/install.sh | sh",
      id: "ffmpeg",
      ok: ffmpeg,
      title: "FFmpeg",
      why: "Importing footage, previews and export. Reinstalling Edit brings it back.",
    },
    codex.provider === "claude"
      ? {
          fix: loggedOut ? "claude auth login" : "curl -fsSL https://claude.ai/install.sh | bash && claude auth login",
          id: "claude",
          ok: codex.ready === true,
          title: loggedOut ? "Claude Code sign-in" : "Claude Code",
          why: "The agent panel (on your own Claude plan or API key).",
        }
      : {
          fix: loggedOut ? "codex login" : "npm install -g @openai/codex && codex login",
          id: "codex",
          ok: codex.ready === true,
          title: loggedOut ? "Codex sign-in" : "Codex",
          why: "The agent panel.",
        },
    {
      fix: "https://www.google.com/chrome/",
      id: "chrome",
      ok: chrome,
      title: "Google Chrome (or Chromium)",
      why: "Map shots and research.",
    },
  );
  return json({ checks });
}

/** The media drive setting: where new media goes, whether the drive is connected, what's still in the data folder. */
function mediaDrive({ app }: Context): Response {
  try {
    return json(driveStatus(app.store.layout()));
  } catch (error) {
    return json({ error: diag.messageOf(error) });
  }
}

async function setMediaDrive(context: Context): Promise<Response> {
  const given = await body(context);
  const raw = field<string>(given, "dir", "string");
  const trimmed = raw?.trim() ?? "";
  const dir = trimmed === "" ? null : expandHome(trimmed);
  try {
    const layout = context.app.store.setMediaDir(dir);
    return json(driveStatus(layout));
  } catch (error) {
    throw bad(diag.messageOf(error));
  }
}

/** The UI's own problems, kept with the server's so one report has both. */
async function clientLog(context: Context): Promise<Response> {
  const given = await body(context);
  const level = field<string>(given, "level", "string", true);
  const message = [...field<string>(given, "message", "string", true)].slice(0, 2000).join("");
  if (level === "error") diag.error("ui", message);
  else if (level === "warn") diag.warn("ui", message);
  else diag.info("ui", message);
  return json({ ok: true });
}

async function updateStatus({ app }: Context): Promise<Response> {
  return json(await app.updater.status());
}

/** Nightly or Stable (Settings → Updates). */
async function updateChannel(context: Context): Promise<Response> {
  const channel = field<string>(await body(context), "channel", "string") ?? "";
  try {
    return json(await context.app.updater.setChannel(channel));
  } catch (error) {
    throw bad(diag.messageOf(error));
  }
}

/** Downloads the newest release and restarts into it. */
async function updateInstall({ app }: Context): Promise<Response> {
  let uploading = false;
  try {
    uploading = seams.drive.uploading();
  } catch (error) {
    if (!seams.isUnavailable(error)) throw error;
  }
  if (app.exports.running() || uploading) {
    throw new ApiError(409, "an export or Drive upload is running; update when it's done");
  }
  try {
    return json(await app.updater.install());
  } catch (error) {
    throw bad(diag.messageOf(error));
  }
}

// ---------------------------------------------------------------------------
// Projects

function listProjects({ app }: Context): Response {
  return json({ projects: app.store.visible() });
}

const STYLES: Style[] = ["bodycam", "interrogation", "courtroom"];

async function createProject(context: Context): Promise<Response> {
  const given = await body(context);
  const name = field<string>(given, "name", "string", true);
  const style = given.style === undefined ? "bodycam" : given.style;
  if (typeof style !== "string" || !STYLES.includes(style as Style)) {
    throw badShape(`style: unknown variant \`${String(style)}\`, expected one of \`bodycam\`, \`interrogation\`, \`courtroom\``);
  }
  const size = (key: "width" | "height" | "fps") => {
    const value = field<number>(given, key, "u32");
    if (value === null) return DEFAULT_SETTINGS[key];
    return value;
  };
  const settings = { width: size("width"), height: size("height"), fps: size("fps") };
  if (!kinds.mayStart(style as Style)) throw new ApiError(403, kinds.cantMake(`edit.${style}`));
  let live;
  try {
    live = context.app.store.createAs(name, style as Style, settings);
  } catch (error) {
    throw bad(diag.messageOf(error));
  }
  context.app.store.setActive(live.project.id);
  return json({ rev: live.rev, project: live.project });
}

function getProject({ app, params }: Context): Response {
  const id = params.id!;
  const live = liveOr404(app, id);
  app.store.setActive(id);
  for (const media of live.project.media) {
    if (!isFile(media.path)) continue;
    app.media.ensure(media.path, {
      kind: media.kind,
      duration: media.duration,
      width: media.width,
      height: media.height,
      fps: media.fps,
      has_audio: media.has_audio,
    });
  }
  return json({ rev: live.rev, project: live.project });
}

/** The footage the timeline plays that isn't here and can't be fetched: the editor says so. */
function missingFootage({ app, params }: Context): Response {
  const live = liveOr404(app, params.id!);
  const missing = missingMedia(live.project);
  const used = new Set(live.project.clips.flatMap((clip) => ("media" in clip && typeof clip.media === "string" ? [clip.media] : [])));
  return json({
    used: live.project.media.filter((media) => used.has(media.id)).length,
    missing: missing.map((media) => ({ id: media.id, name: media.name, path: media.path })),
  });
}

async function putProject(context: Context): Promise<Response> {
  const given = await body(context);
  const baseRev = field<number>(given, "base_rev", "u64");
  // The UI sends what changed (patch.ts) against the revision it has.
  if (given.project === undefined && given.patch !== undefined) {
    const live = liveOr404(context.app, context.params.id!);
    if (baseRev !== null && live.rev !== baseRev) {
      return json({ error: "conflict", rev: live.rev, project: live.project }, 409);
    }
    try {
      given.project = patches.apply(live.project, given.patch as patches.Patch);
    } catch (error) {
      throw bad(`that change doesn't fit the project: ${diag.messageOf(error)}`);
    }
  }
  if (given.project === undefined) throw badShape("missing field `project`");
  if (typeof given.project !== "object" || given.project === null || Array.isArray(given.project)) {
    throw badShape(`project: invalid type: ${kindOf(given.project)}, expected struct Project`);
  }
  const origin = field<string>(given, "origin", "string") ?? "";
  try {
    const live = await context.app.store.replace(context.params.id!, baseRev, given.project as Project, origin);
    return json({ rev: live.rev });
  } catch (error) {
    if (!(error instanceof UpdateError)) throw error;
    // Read as a Project before anything else, as axum's extractor did (only looked at
    // when the save fails, so a good save doesn't parse the project twice).
    if (error.kind === "invalid" || error.kind === "conflict") projectShape(context.app, given.project);
    switch (error.kind) {
      case "not_found":
        throw notFound("no such project");
      case "invalid":
        throw bad(error.message);
      // A cloud project someone else is editing (`cloud_projects`).
      case "refused":
        throw new ApiError(423, error.message);
      case "conflict":
        return json({ error: "conflict", rev: error.live?.rev, project: error.live?.project }, 409);
    }
  }
}

/**
 * A PUT's project that serde couldn't read as a Project, refused as axum's
 * Json extractor refused it (before the revision is looked at): 422, the path
 * serde_path_to_error gives ("project.clips[0].start"; inside a clip's
 * flattened content, the clip) and the place in the body (withPosition).
 */
function projectShape(app: App, project: unknown): void {
  const text = JSON.stringify(project);
  const problem = app.native.projectLoad(text).problem;
  const prefix = "it can't be read: ";
  if (problem === undefined || !problem.startsWith(prefix)) return;
  const placed = /^([\s\S]*) at line 1 column (\d+)$/.exec(problem.slice(prefix.length));
  if (placed === null) return;
  // serde's column counts bytes; the scan counts characters.
  const end = new TextDecoder().decode(new TextEncoder().encode(text).slice(0, Number(placed[2]))).length;
  const path = pathEndingAt(text, end) ?? [];
  throw badShape(`${showPath(["project", ...path])}: ${placed[1]}`);
}

async function deleteProject({ app, params }: Context): Promise<Response> {
  const id = params.id!;
  // A cloud project goes from the cloud first (refused while someone else
  // edits it or the cloud can't be reached); one only there, only there.
  const local = app.store.get(id) !== null;
  const why = app.store.unavailable(id);
  if (why !== null) throw new ApiError(403, why);
  let inCloud = false;
  if (app.store.cloud() !== null) {
    try {
      inCloud = await seams.cloudProjects.delete(app, id);
    } catch (error) {
      throw new ApiError(409, diag.messageOf(error));
    }
  }
  if (!local && inCloud) return json({ ok: true });
  if (app.store.delete(id)) return json({ ok: true });
  throw notFound("no such project");
}

// ---------------------------------------------------------------------------
// Media in

async function importMedia(context: Context): Promise<Response> {
  const given = await body(context);
  const paths = given.paths;
  if (paths === undefined) throw badShape("missing field `paths`");
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string")) {
    throw badShape("paths: invalid type, expected a sequence of strings");
  }
  const place = field<boolean>(given, "place", "boolean") ?? false;
  const origin = field<string>(given, "origin", "string") ?? "";
  if (paths.length === 0) throw bad("no paths");
  const id = context.params.id!;
  let imported;
  try {
    imported = await importPaths(context.app, id, paths as string[], place, origin);
  } catch (error) {
    throw bad(diag.messageOf(error));
  }
  const [rev, added, errors] = imported;
  const project = context.app.store.get(id)?.project ?? null;
  return json({ rev, added, errors, project });
}

/** Footage from a Google Drive folder or file link (drive_import.ts): downloaded, then imported as `import` does. */
async function importDriveMedia(context: Context): Promise<Response> {
  const given = await body(context);
  const url = field<string>(given, "url", "string", true);
  const place = field<boolean>(given, "place", "boolean") ?? true;
  const origin = field<string>(given, "origin", "string") ?? "";
  const id = context.params.id!;
  liveOr404(context.app, id);
  let imported;
  try {
    imported = await importDrive(context.app, id, url, place, origin);
  } catch (error) {
    throw bad(diag.messageOf(error));
  }
  const [rev, added, errors] = imported;
  const project = context.app.store.get(id)?.project ?? null;
  return json({ rev, added, errors, project });
}

/** An upload that sends nothing for this long is abandoned. */
const UPLOAD_IDLE_MS = 60_000;

/** `dir/name`, or `dir/name-2.ext`, `-3`… if taken (made empty, so two uploads never pick one name). */
export async function reserveUpload(dir: string, name: string): Promise<string> {
  const stem = fileStem(name) ?? "upload";
  const ext = extension(name) ?? "";
  for (let n = 1; ; n++) {
    const candidate = join(dir, n === 1 ? name : ext === "" ? `${stem}-${n}` : `${stem}-${n}.${ext}`);
    try {
      const handle = await fs.promises.open(candidate, "wx");
      await handle.close();
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
}

/** Streams a file from the browser's device to disk, then imports it. The body is never buffered, so multi-GB footage is fine. */
async function uploadMedia(context: Context): Promise<Response> {
  const { app, params } = context;
  const id = params.id!;
  const given = requiredQuery(context, "name");
  const size = u64Query(context, "size");
  const origin = context.query.get("origin") ?? "";
  liveOr404(app, id);
  const name = fileName(given)?.trim() ?? "";
  if (name === "" || name.startsWith(".")) throw bad("invalid file name");
  if (!isMediaPath(name)) throw bad(`${name} is not a supported video or audio file`);
  let dir: string;
  try {
    dir = app.store.uploadsDir(id);
  } catch (error) {
    throw bad(diag.messageOf(error));
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw bad(ioMessage(error));
  }
  const configured = Number.parseInt(process.env.EDIT_MAX_UPLOAD_BYTES ?? "", 10);
  const limit =
    Number.isFinite(configured) && /^\d+$/.test(process.env.EDIT_MAX_UPLOAD_BYTES ?? "") ? configured : 100 * 1024 ** 3;
  if (size !== null && (size === 0 || size > limit)) {
    throw new ApiError(413, `upload must be between 1 and ${limit} bytes`);
  }
  let target: string;
  try {
    target = await reserveUpload(dir, name);
  } catch (error) {
    throw bad(ioMessage(error));
  }
  const temporary = `${target}.uploading`;
  let keepTarget = false;
  try {
    try {
      await receive(context.request, temporary, size, limit);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw bad(`upload of ${name} failed: ${error instanceof Error && "code" in error ? ioMessage(error) : diag.messageOf(error)}`);
    }
    let imported;
    try {
      imported = await importPaths(app, id, [target], false, origin === "" ? "upload" : origin);
    } catch (error) {
      throw bad(diag.messageOf(error));
    }
    const [rev, added, errors] = imported;
    const first = errors[0];
    if (first !== undefined) throw bad(first);
    const project = app.store.get(id)?.project ?? null;
    keepTarget = true;
    // Cloud mode: footage that went up (edited from its proxy now) needs no
    // copy here. Sounds and pictures stay where they are (`cloud_media`).
    const media = added[0] === undefined ? undefined : project?.media.find((item) => item.id === added[0]);
    if (media?.cloud !== undefined && media.cloud !== null && fs.existsSync(target) && media.path !== canonical(target)) {
      // Once it's gone up (the import answered before the upload finished);
      // kept while it hasn't, as the only copy of the original.
      seams.cloudMedia.removeWhenUploaded(canonical(target));
    }
    return json({ rev, added, project });
  } finally {
    if (!keepTarget) fs.rmSync(target, { force: true });
  }
}

/** Writes the request's body to `path` (made new), stopping at the announced size; a minute without data gives up. */
async function receive(request: Request, path: string, size: number | null, limit: number): Promise<void> {
  const file = await fs.promises.open(path, "wx");
  try {
    let received = 0;
    const reader = request.body?.getReader() ?? null;
    // Stop at the announced size rather than waiting for end-of-body: some
    // proxies (HTTP/2 → HTTP/1.1) can lose it on large uploads.
    while (reader !== null && (size === null || received < size)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("no data for a minute")), UPLOAD_IDLE_MS);
      });
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await Promise.race([reader.read(), idle]);
      } finally {
        clearTimeout(timer);
      }
      if (next.done) break;
      received += next.value.byteLength;
      if (received > limit || (size !== null && received > size)) throw new Error("upload exceeds its size limit");
      let written = 0;
      while (written < next.value.byteLength) {
        written += (await file.write(next.value, written)).bytesWritten;
      }
    }
    if (size !== null && size !== received) throw new Error(`received ${received} of ${size} bytes`);
    await file.sync();
  } finally {
    await file.close();
  }
  fs.renameSync(path, path.slice(0, -".uploading".length));
}

/** A file's version: its length and modification time (a remade preview is a new stamp). */
export function fileStamp(path: string): string | null {
  try {
    const meta = fs.statSync(path, { bigint: true });
    return `${meta.size.toString(16)}-${(meta.mtimeNs / 1_000_000n).toString(16)}`;
  } catch {
    return null;
  }
}

function mediaStatus({ app, params }: Context): Response {
  const live = liveOr404(app, params.id!);
  const statuses: Record<string, unknown> = {};
  for (const media of [...live.project.media].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const status = app.media.status(media.path) as unknown as Record<string, unknown>;
    // Which version of each preview file is there: the client puts it in the
    // file's URL, so the browser can keep what it read for good.
    const paths = app.media.paths(media.path);
    statuses[media.id] = { ...status, stamps: { light: fileStamp(paths.light), preview: fileStamp(paths.proxyDone) } };
  }
  return json({ media: statuses });
}

async function mediaFile(context: Context): Promise<Response> {
  const { app, params } = context;
  const live = liveOr404(app, params.id!);
  const media = live.project.media.find((item) => item.id === params.media);
  if (media === undefined) throw notFound("no such media");
  const kind = params.kind!;
  const source = media.path;
  const paths = app.media.paths(source);
  // `v=<preview|light>~<stamp>`: the URL names one version of the file, so
  // when it's that version the browser may keep it (no round trip to check).
  const raw = context.url.search.replace(/^\?/, "");
  const named = raw
    .split("&")
    .find((pair) => pair.startsWith("v="))
    ?.slice(2)
    .replaceAll("%7E", "~")
    .replaceAll("%7e", "~");
  let lasting = false;
  const tilde = named?.indexOf("~") ?? -1;
  if (named !== undefined && tilde >= 0) {
    const which = named.slice(0, tilde);
    const stamp = named.slice(tilde + 1);
    if (which === "light" && kind === "light") lasting = fileStamp(paths.light) === stamp;
    else if (which === "preview" && (kind === "proxy" || kind === "audio")) lasting = fileStamp(paths.proxyDone) === stamp;
  }
  let file: string;
  switch (kind) {
    // Until the proxy exists, stream the original (fine for H.264/HEVC MP4/MOV).
    case "proxy":
    case "audio": {
      const proxy = kind === "proxy" ? paths.proxy : paths.audio;
      file = isFile(paths.proxyDone) && isFile(proxy) ? proxy : source;
      break;
    }
    // Only once it exists: the client asks for it by name when it's ready, so
    // one URL never serves two different files.
    case "light":
      file = paths.light;
      break;
    case "thumbs":
      file = paths.thumbs;
      break;
    case "peaks":
      file = paths.peaks;
      break;
    case "transcript":
      // Transcripts from before speaker names get them now.
      try {
        seams.speakers.ensure(app, source);
      } catch (error) {
        diag.warn("speakers", `${source}: ${diag.messageOf(error)}`);
      }
      file = paths.transcript;
      break;
    default:
      throw notFound("unknown media file");
  }
  if (!isFile(file)) throw notFound("not ready");
  let response = serveFile(context.request, file);
  if (kind === "peaks") {
    // Bun names an octet-stream file in a content-disposition header; tower's ServeFile
    // doesn't. The peaks are small: sent as bytes, the header stays out.
    const headers = new Headers(response.headers);
    headers.set("content-type", "application/octet-stream");
    const body = response.body === null ? null : new Uint8Array(await response.arrayBuffer());
    response = new Response(body, { status: response.status, headers });
  }
  // Never the original standing in while the preview is missing.
  const keep = lasting && file !== media.path && response.status >= 200 && response.status < 300;
  response.headers.set("cache-control", keep ? "private, max-age=31536000, immutable" : "no-cache");
  return response;
}

// ---------------------------------------------------------------------------
// Frames and exports

/**
 * The UI's frame renders in flight. The renderer refuses past 8 waiting, and
 * the home screen asks for every project's cover at once: the rest wait here.
 */
const uiFrames = new Semaphore(4);

async function framePng(context: Context): Promise<Response> {
  const { app, params } = context;
  const text = params.frame!.replace(/(\.png)+$/, "");
  if (!/^[+-]?\d+$/.test(text)) throw bad("frame must be a number");
  const frame = Number(text);
  const max = u32Query(context, "max");
  const live = liveOr404(app, params.id!);
  let images;
  try {
    images = await withProjectAsync(
      live.project.id,
      live.rev,
      () => jsonForSerde(live.project),
      (project) =>
        uiFrames.with(() => app.native.renderFrames({ project, frames: [frame], maxSide: max ?? 0, priority: "ui", encode: "png" })),
    );
  } catch (error) {
    throw new ApiError(500, diag.messageOf(error));
  }
  const image = images[0];
  if (image === undefined) throw new ApiError(500, "the frame didn't render");
  // `v` names the project's version (the home screen's covers pass its
  // modified time): a picture of it can be kept, so a revisit renders nothing.
  const headers: Record<string, string> = { "content-type": "image/png" };
  if (context.query.has("v")) headers["cache-control"] = "private, max-age=86400";
  return new Response(image.data, { headers });
}

/**
 * A home screen card's picture: frame `frame` with any black borders the
 * footage carries (a 4:3 interview inside 16:9, stacked court feeds) cut
 * off, scaled up to fill a 16:9 tile `max` wide, as a JPEG. Made once per
 * project version (`v`) and kept in the cache (older ones of the project
 * removed).
 */
async function coverJpeg(context: Context): Promise<Response> {
  const { app, params } = context;
  const text = params.frame!.replace(/(\.jpg)+$/, "");
  if (!/^\d+$/.test(text)) throw bad("frame must be a number");
  const frame = Number(text);
  const width = Math.min(Math.max(u32Query(context, "max") ?? 640, 64), 1920);
  const height = Math.round((width * 9) / 16 / 2) * 2;
  const version = (context.query.get("v") ?? "").replace(/[^0-9a-z]/gi, "").slice(0, 20);
  const live = liveOr404(app, params.id!);
  const dir = join(app.store.cacheDir(), "covers");
  const out = join(dir, `${live.project.id}-${version}-${frame}-${width}.jpg`);
  const headers = { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" };
  if (isFile(out)) {
    covers.share(app, live.project.id, version, width, out);
    return new Response(Bun.file(out), { headers });
  }
  let images;
  try {
    images = await withProjectAsync(
      live.project.id,
      live.rev,
      () => jsonForSerde(live.project),
      (project) =>
        uiFrames.with(() => app.native.renderFrames({ project, frames: [frame], maxSide: Math.round(width * 1.5), priority: "ui", encode: "png" })),
    );
  } catch (error) {
    throw new ApiError(500, diag.messageOf(error));
  }
  const image = images[0];
  if (image === undefined) throw new ApiError(500, "the frame didn't render");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const still = `${out}.${process.pid}.png`;
    fs.writeFileSync(still, image.data);
    try {
      const box = await pictureBox(still);
      const crop = box === null ? "" : `crop=${box.join(":")},`;
      const made = await ffmpegRun([
        "-v",
        "error",
        "-y",
        "-i",
        still,
        "-vf",
        `${crop}scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
        "-q:v",
        "3",
        `${out}.part.jpg`,
      ]);
      if (made.code !== 0) throw new Error(tools.lastLine(made.stderr));
      fs.renameSync(`${out}.part.jpg`, out);
    } finally {
      fs.rmSync(still, { force: true });
    }
    // Only this version's covers of the project are kept.
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(`${live.project.id}-`) && !name.startsWith(`${live.project.id}-${version}-`)) fs.rmSync(join(dir, name), { force: true });
    }
  } catch (error) {
    diag.warn("http", `cover of ${live.project.id} at ${frame}: ${diag.messageOf(error)}; the frame as it is`);
    return new Response(image.data, { headers: { "content-type": "image/png", "cache-control": "private, max-age=86400" } });
  }
  covers.share(app, live.project.id, version, width, out);
  return new Response(Bun.file(out), { headers });
}

/**
 * Where the picture is in a still that has black borders round it (FFmpeg's
 * cropdetect), as [width, height, x, y]; null when it fills the frame (or
 * nearly), or it's all dark.
 */
async function pictureBox(still: string): Promise<[number, number, number, number] | null> {
  // A still looped for a few frames: cropdetect says nothing about the first ones.
  const probe = await ffmpegRun(["-hide_banner", "-loop", "1", "-t", "0.2", "-i", still, "-vf", "cropdetect=limit=24:round=2:reset=0", "-f", "null", "-"]);
  const found = [...probe.stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)].pop();
  const size = /, (\d+)x(\d+)[, ]/.exec(probe.stderr);
  if (found === undefined || size === null) return null;
  const [w, h, x, y] = found.slice(1, 5).map(Number) as [number, number, number, number];
  const [fullW, fullH] = [Number(size[1]), Number(size[2])];
  if (w <= 0 || h <= 0 || w * h < fullW * fullH * 0.15 || w * h > fullW * fullH * 0.97) return null;
  return [w, h, x, y];
}

/** FFmpeg with `args` (stdin closed), without blocking the server: its exit code and what it said. */
async function ffmpegRun(args: string[]): Promise<{ code: number; stderr: string }> {
  const child = Bun.spawn([tools.ffmpeg(), ...args], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  return { code, stderr };
}

async function startExport(context: Context): Promise<Response> {
  const { app, params } = context;
  const id = params.id!;
  const given = (await optionalBody(context)) ?? {};
  const path = field<string>(given, "path", "string");
  const drive = field<boolean>(given, "drive", "boolean");
  const asked = given.options;
  if (asked !== undefined && (typeof asked !== "object" || asked === null || Array.isArray(asked))) {
    throw badShape(`options: invalid type: ${kindOf(asked)}, expected struct ExportOptions`);
  }
  const options: ExportOptions = { ...app.native.exportDefaults(), ...((asked ?? {}) as Partial<ExportOptions>) };
  if (options.wait_for_smoothing) {
    let done = true;
    try {
      done = await seams.broll.waitForSmoothing(id, 120_000);
    } catch (error) {
      if (!seams.isUnavailable(error)) throw error;
    }
    if (!done) {
      throw bad(
        "optional optical flow is still running; export the current timeline with wait_for_smoothing false or wait for it to finish",
      );
    }
  }
  // A map shot still rendering would export as its first frame. The button
  // answers soon (the agent's export waits longer).
  try {
    await seams.broll.waitForMaps(app, id, 5000);
  } catch (error) {
    if (!seams.isUnavailable(error)) throw bad(diag.messageOf(error));
  }
  const live = liveOr404(app, id);
  const output =
    path !== null && path.trim() !== "" ? expandHome(path) : defaultExportPath(app.store, live.project);
  try {
    return json({ path: await app.exports.start(app.store, app.library, live.project, options, output, drive === null ? {} : { drive }) });
  } catch (error) {
    throw bad(diag.messageOf(error));
  }
}

function cancelExport({ app, params }: Context): Response {
  return json({ cancelled: app.exports.cancel(params.id!) });
}

/** Which export formats and encoders this machine's FFmpeg offers. */
async function exportEncoders({ app }: Context): Promise<Response> {
  try {
    return json(await app.native.encoders());
  } catch {
    return json({ videotoolbox: false, hevc: false, prores: false, mp3: false });
  }
}

/** Cleans the cache now (`dry_run`: only says what would go); cache_cleanup.ts. */
async function cleanTheCache(context: Context): Promise<Response> {
  const given = (await optionalBody(context)) ?? {};
  const dryRun = field<boolean>(given, "dry_run", "boolean") ?? false;
  return json(cleanCache(context.app, dryRun));
}

/** The project's exports, newest first (this machine's: each downloads from Edit, on the Mac or over Tailscale). */
function projectExports({ app, params }: Context): Response {
  return json(listExports(app.store.home, params.id!));
}

/** Deletes one of the project's exports (its file and its place on the list). */
async function deleteProjectExport(context: Context): Promise<Response> {
  const given = await body(context);
  const path = field<string>(given, "path", "string", true);
  try {
    deleteExport(context.app.store.home, context.params.id!, path);
  } catch (error) {
    throw bad(diag.messageOf(error));
  }
  return json(listExports(context.app.store.home, context.params.id!));
}

/** A finished export, downloaded to the device the editor is open on. */
function exportedFile(context: Context): Response {
  const path = requiredQuery(context, "path");
  if (!context.app.exports.exported(path)) throw notFound("not an export from this session");
  const name = fileName(path)?.replaceAll('"', "'") ?? "export";
  const response = serveFile(context.request, path);
  response.headers.set("content-disposition", `attachment; filename="${name}"`);
  return response;
}

/** Shows a finished export in Finder (or the file manager) on the machine running Edit. */
async function revealExport(context: Context): Promise<Response> {
  const given = await body(context);
  const path = field<string>(given, "path", "string", true);
  if (!context.app.exports.exported(path)) throw notFound("not an export from this session");
  const command = process.platform === "darwin" ? ["open", "-R", path] : ["xdg-open", parent(path) || path];
  let opened = false;
  try {
    opened = (await Bun.spawn(command, { stdin: "ignore", stdout: "inherit", stderr: "inherit" }).exited) === 0;
  } catch {
    opened = false;
  }
  if (!opened) throw bad("couldn't open a file browser on this machine");
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// The file browser (picking footage on the machine running Edit)

function browse(context: Context): Response {
  const home = process.env.HOME !== undefined && process.env.HOME !== "" ? process.env.HOME : "/";
  const asked = context.query.get("path");
  const given = asked !== null && asked !== "" ? expandHome(asked) : home;
  let dir: string;
  try {
    dir = fs.realpathSync(given);
  } catch {
    throw notFound("folder not found");
  }
  const entries: { name: string; path: string; dir: boolean; size: number }[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    throw bad(ioMessage(error));
  }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    let meta: fs.Stats;
    try {
      meta = fs.statSync(path);
    } catch {
      continue;
    }
    const isDir = meta.isDirectory();
    if (!isDir && !isMediaPath(path)) continue;
    entries.push({ name, path, dir: isDir, size: meta.size });
  }
  entries.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const places: { name: string | null; path: string }[] = [];
  for (const name of ["Desktop", "Movies", "Downloads", "Documents", "Videos", "Music"]) {
    const path = join(home, name);
    try {
      if (fs.statSync(path).isDirectory()) places.push({ name: fileName(path), path });
    } catch {
      // Not on this machine.
    }
  }
  places.push({ name: "Home", path: home });
  return json({ entries, parent: parent(dir) === "" ? null : parent(dir), path: dir, places });
}
