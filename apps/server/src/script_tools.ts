// The script, voice and research package's MCP tools (search_web,
// read_page, add_article, case_articles, look_at_found, reject_found,
// collect_images, use_found, realign_script, place_voiceovers,
// tighten_voiceover, speed_voiceover) and routes (`/api/voice/*`,
// `/api/scripts/preview`, `/api/projects/{id}/script(/job)`,
// `/api/projects/{id}/research/*`). Importing this module registers the tools
// (seams.ts does); the server calls `routes` on its router. The script
// module itself is re-exported, so this file is the script seam.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { isBug } from "./guard.ts";
import { mimeOf } from "./http/assets.ts";
import { ApiError, bad, notFound } from "./http/errors.ts";
import { badShape, readJson, type RouteContext, type Router } from "./http/router.ts";
import { image, registerTool, text, type Content } from "./mcp/registry.ts";
import type { Project } from "./model.ts";
import { native } from "./native/index.ts";
import { duration as projectDuration, fps as fpsOf } from "./project.ts";
import { isFile } from "./paths.ts";
import * as research from "./research.ts";
import { display, fixed, round, toI64, trim } from "./rust.ts";
import * as script from "./script.ts";
import { field, read, readStruct, required, SerdeError, type Struct } from "./serde.ts";
import { stableStringify } from "./stable.ts";
import { changesFrom, narrationLines } from "./voice.ts";
import * as voiceover from "./voiceover.ts";

export * from "./script.ts";

const ORIGIN = "agent";

// ---------------------------------------------------------------------------
// Arguments, as serde_json's Value accessors read them.

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** `as_f64`. */
function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** `as_u64`. */
function uint(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function clampInt(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/** `serde_json::from_value::<Vec<String>>` (serde's words when it isn't one). */
function strings(value: unknown): string[] {
  try {
    return read({ vec: "string" }, value ?? null) as string[];
  } catch (error) {
    if (error instanceof SerdeError) throw new Error(error.message);
    throw error;
  }
}

function liveProject(app: App, id: string): Project {
  const live = app.store.get(id);
  if (live === null) throw new Error("project vanished");
  return live.project;
}

const publishedOf = (article: research.Article) =>
  article.published !== undefined && article.published !== null ? `, ${article.published}` : "";

// ---------------------------------------------------------------------------
// Research tools.

registerTool("search_web", async ({ args }) => {
  const query = str(args.query);
  if (query === null) throw new Error("query is required");
  const found = await research.searchWeb(query);
  if (found.length === 0) return text("nothing found");
  return text(found.map((hit, index) => `${index + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet}`).join("\n"));
});

registerTool("read_page", async ({ args }) => {
  const url = str(args.url);
  if (url === null) throw new Error("url is required");
  const limit = clampInt(uint(args.limit) ?? 12_000, 500, 60_000);
  return text(await research.readPage(url, limit));
});

registerTool("add_article", async ({ app, args, projectId }) => {
  const url = str(args.url);
  if (url === null) throw new Error("url is required");
  const summary = str(args.summary) ?? "";
  const [article, photos] = await research.addArticle(app.store.home, projectId, url, summary);
  return text(
    `saved "${article.title}" (${article.outlet}${publishedOf(article)}) to the project's articles, and added ${photos} of its photos to the review`,
  );
});

/** Code points of `text`, with their UTF-16 offsets. */
function offsets(text: string): number[] {
  const out: number[] = [];
  let at = 0;
  for (const c of text) {
    out.push(at);
    at += c.length;
  }
  return out;
}

registerTool("case_articles", ({ app, args, projectId }) => {
  const articles = research.articles(app.store.home, projectId);
  if (articles.length === 0) {
    return text("no articles saved for this project yet (research the case: search_web, read_page, add_article)");
  }
  const wanted = str(args.id);
  if (wanted !== null) {
    const article = articles.find((own) => own.id === wanted);
    if (article === undefined) throw new Error(`no article ${wanted}`);
    return text(`${article.title} (${article.outlet}${publishedOf(article)})\n${article.url}\n\n${article.text}`);
  }
  const find = str(args.find);
  if (find !== null && trim(find) !== "") {
    const needle = find.replace(/[A-Z]/g, (c) => c.toLowerCase());
    // The needle's length in bytes, as Rust counted it.
    const needleBytes = Buffer.byteLength(needle, "utf8");
    const found: string[] = [];
    for (const article of articles) {
      // Each mention with the sentence or so around it. ASCII lowercasing
      // keeps positions, so they index the text itself.
      const body = article.text;
      const lower = body.replace(/[A-Z]/g, (c) => c.toLowerCase());
      let from = 0;
      for (;;) {
        const at = lower.indexOf(needle, from);
        if (at < 0) break;
        const before = offsets(body.slice(0, at));
        const start = before.length > 200 ? before[before.length - 201]! : 0;
        const after = offsets(body.slice(at));
        const reach = needleBytes + 200;
        const end = after.length > reach ? at + after[reach]! : body.length;
        found.push(`[${article.outlet} · ${article.id}] …${body.slice(start, end)}…`);
        // Always forward, so a mention can't be found twice.
        from = Math.min(Math.max(end, at + Math.max(needle.length, 1)), lower.length);
        if (from >= lower.length) break;
      }
    }
    return text(found.length === 0 ? `"${find}" isn't in the saved articles` : found.join("\n\n"));
  }
  return text(
    articles
      .map((article) => `${article.id} · ${article.title} (${article.outlet}${publishedOf(article)})\n   ${article.summary}`)
      .join("\n"),
  );
});

registerTool("look_at_found", async ({ app, args, projectId }): Promise<Content[]> => {
  const offset = uint(args.offset) ?? 0;
  const count = clampInt(uint(args.count) ?? 24, 1, 36);
  const waiting = research.items(app.store.home, projectId).filter((item) => item.status === "new");
  const total = waiting.length;
  const shown = waiting.slice(offset, offset + count);
  if (shown.length === 0) return text(`no found images waiting from ${offset} (${total} waiting)`);
  const thumbs = await Promise.all(
    shown.map(async (item) => (await research.thumbnail(item.file)) ?? { width: 320, height: 240, pixels: Buffer.alloc(320 * 240 * 4) }),
  );
  const sheet = await native().composeSheet(thumbs, 6, "png");
  const list = shown.map((item, index) => `${offset + index + 1} ${item.id} — ${item.title} (${item.page})`).join("\n");
  return image(
    sheet.data,
    `found images ${offset + 1}–${offset + shown.length} of ${total} waiting, left to right then down:\n${list}`,
    sheet.mime,
  );
});

registerTool("reject_found", ({ app, args, projectId }) => {
  const ids = strings(args.ids);
  return text(`rejected ${research.reject(app.store.home, projectId, ids)}`);
});

registerTool("collect_images", async ({ app, args, projectId }) => {
  const queries = strings(args.queries);
  const perQuery = clampInt(uint(args.per_query) ?? 40, 1, 150);
  const [added, had, failed] = await research.collect(app.store.home, projectId, queries, perQuery);
  const total = research.items(app.store.home, projectId).length;
  return text(
    `added ${added} new images to the Research review (${had} already there, ${failed} couldn't be used: blocked, not an image or too small); ${total} in all. The user reviews them in the media bin's Research view; the ones they keep land in the media bin.`,
  );
});

registerTool("use_found", async ({ app, args, projectId }) => {
  const found = str(args.found_id);
  if (found === null) throw new Error("found_id is required");
  const item = await research.reviewFound(app, projectId, found, "kept", ORIGIN);
  if (item.media === undefined || item.media === null) throw new Error("it was kept but isn't in the media bin");
  return text(`kept ${found}: media ${item.media} (${item.title})`);
});

// ---------------------------------------------------------------------------
// Script and voice-over tools.

registerTool("realign_script", async ({ app, projectId }) => {
  const changed = await script.realign(app, projectId);
  return text(changed.length === 0 ? "every range already starts and ends on its words" : stableStringify(changed, 2));
});

registerTool("place_voiceovers", async ({ app, args, projectId }) => {
  const given = args.media_ids;
  const media = given === undefined || given === null ? null : strings(given);
  const report = await voiceover.place(app, projectId, media);
  return text(stableStringify(report, 2));
});

registerTool("tighten_voiceover", async ({ app, args, projectId }) => {
  const project = liveProject(app, projectId);
  const fps = fpsOf(project);
  const start = num(args.start);
  const end = num(args.end);
  const from = start === null ? 0 : toI64(round(start * fps));
  const to = end === null ? projectDuration(project) : toI64(round(end * fps));
  const pause = num(args.max_pause);
  const maxPause = pause !== null && Number.isFinite(pause) && pause >= 0.2 ? pause : 0.7;
  const kept = num(args.keep);
  const keep = Math.min(kept !== null && Number.isFinite(kept) && kept >= 0.1 ? kept : 0.35, maxPause);
  const dryRun = typeof args.dry_run === "boolean" ? args.dry_run : false;
  const done = await diag.timeAsync("voiceover", "tighten voice-over", () =>
    voiceover.tighten(app, projectId, [from, to], maxPause, keep, dryRun),
  );
  return text(stableStringify(done, 2));
});

registerTool("speed_voiceover", async ({ app, args, projectId }) => {
  const fps = fpsOf(liveProject(app, projectId));
  const frame = (key: string) => {
    const seconds = num(args[key]);
    if (seconds === null || !Number.isFinite(seconds) || seconds < 0) throw new Error(`${key} is required (seconds)`);
    return toI64(round(seconds * fps));
  };
  const from = frame("start");
  const to = frame("end");
  const speed = num(args.speed);
  if (speed === null) throw new Error("speed is required");
  const [, [start, end, saved]] = await app.store.update(projectId, ORIGIN, (project) => voiceover.speedUp(project, from, to, speed));
  return text(`sped ${fixed(start / fps, 2)}–${fixed(end / fps, 2)}s up ${display(speed)}x: saved ${fixed(saved / fps, 2)}s`);
});

// ---------------------------------------------------------------------------
// Routes.

/** JSON with sorted keys (a `json!` value), as `Json(value)` answered. */
function sortedJson(value: unknown): Response {
  return new Response(stableStringify(value), { headers: { "content-type": "application/json" } });
}

/** A body read as serde reads `T` (axum's 422 in serde's words when it isn't one). */
async function body(context: RouteContext<App>, spec: Struct): Promise<Record<string, unknown>> {
  const given = await readJson<unknown>(context);
  try {
    return readStruct(spec, given);
  } catch (error) {
    if (error instanceof SerdeError) throw badShape(error.message);
    throw error;
  }
}

/** A failure as a 400 (a bug stays a 500). */
function badOf(error: unknown): unknown {
  if (error instanceof ApiError || isBug(error)) return error;
  return bad(diag.messageOf(error));
}

function notFoundOf(error: unknown): unknown {
  if (error instanceof ApiError || isBug(error)) return error;
  return notFound(diag.messageOf(error));
}

/** A file as tower's ServeFile answers it: its type by extension, byte ranges, 404 when it isn't there. */
function serveFile(request: Request, path: string): Response {
  let size: number;
  let modified: Date;
  try {
    const stat = fs.statSync(path);
    if (!stat.isFile()) return new Response(null, { status: 404 });
    size = stat.size;
    modified = stat.mtime;
  } catch {
    return new Response(null, { status: 404 });
  }
  const headers: Record<string, string> = {
    "content-type": mimeOf(path),
    "accept-ranges": "bytes",
    "last-modified": modified.toUTCString(),
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  const file = Bun.file(path);
  if (range !== null && (range[1] !== "" || range[2] !== "")) {
    let start: number;
    let end: number;
    if (range[1] === "") {
      start = Math.max(size - Number(range[2]), 0);
      end = size - 1;
    } else {
      start = Number(range[1]);
      end = range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
    }
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
    }
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
    });
  }
  return new Response(file, { headers: { ...headers, "content-length": String(size) } });
}

function projectOr404(app: App, id: string): { rev: number; project: Project } {
  const live = app.store.get(id);
  if (live === null) throw notFound("no such project");
  return live;
}

// Voice-overs: their own projects, for now.

const VOICE_CREATE: Struct = {
  name: "VoiceCreate",
  fields: [field("name", "string", ""), field("from_project", { option: "string" }, null)],
};

async function voiceCreate(context: RouteContext<App>): Promise<Response> {
  const { app } = context;
  const given = await body(context, VOICE_CREATE);
  const fromProject = given.from_project as string | null;
  let name = given.name as string;
  let lines: [string, string | null][] = [];
  if (fromProject !== null) {
    const live = projectOr404(app, fromProject);
    lines = narrationLines(live.project);
    if (lines.length === 0) throw bad("That project's script has no cut-ins to voice.");
    if (trim(name) === "") name = `${live.project.name} (voice-over)`;
  }
  try {
    return sortedJson({ project: app.voices.create(name, fromProject, lines) });
  } catch (error) {
    throw badOf(error);
  }
}

async function voiceUpdate(context: RouteContext<App>): Promise<Response> {
  const { app } = context;
  const given = await readJson<unknown>(context);
  let changes;
  try {
    changes = changesFrom(given);
  } catch (error) {
    if (error instanceof SerdeError) throw badShape(error.message);
    throw error;
  }
  try {
    return sortedJson({ project: app.voices.update(context.params.id ?? "", changes) });
  } catch (error) {
    throw badOf(error);
  }
}

const VOICE_SEND: Struct = { name: "VoiceSend", fields: [required("project", "string")] };

async function voiceSend(context: RouteContext<App>): Promise<Response> {
  const { app } = context;
  const id = context.params.id ?? "";
  const given = await body(context, VOICE_SEND);
  try {
    app.voices.get(id);
  } catch (error) {
    throw notFoundOf(error);
  }
  projectOr404(app, given.project as string);
  try {
    return sortedJson(await voiceover.send(app, id, given.project as string));
  } catch (error) {
    throw badOf(error);
  }
}

/** A `#[serde(default)] bool` query value: absent false, else "true" / "false". */
function queryFlag(context: RouteContext<App>, key: string): boolean {
  const value = context.query.get(key);
  if (value === null) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ApiError(400, `Failed to deserialize query string: ${key}: provided string was not \`true\` or \`false\``, true);
}

// Research.

const COLLECT: Struct = {
  name: "CollectBody",
  fields: [required("queries", { vec: "string" }), field("per_query", { option: "u64" }, null)],
};

async function researchCollect(context: RouteContext<App>): Promise<Response> {
  const { app } = context;
  const id = context.params.id ?? "";
  // axum ran the body's extractor before the handler.
  const given = await body(context, COLLECT);
  projectOr404(app, id);
  const queries = (given.queries as string[]).map((query) => trim(query)).filter((query) => query !== "");
  if (queries.length === 0) throw bad("say what to search for");
  if (research.collecting(id)) throw bad("already collecting images for this project");
  const home = app.store.home;
  const perQuery = clampInt((given.per_query as number | null) ?? 40, 1, 150);
  void diag
    .timeOnAsync("research", "research: collect images", id, () => research.collect(home, id, queries, perQuery))
    .catch(() => undefined);
  return sortedJson({ started: true });
}

const REVIEW: Struct = { name: "ReviewBody", fields: [required("status", "string"), required("origin", "string")] };

async function researchReview(context: RouteContext<App>): Promise<Response> {
  const { app } = context;
  const id = context.params.id ?? "";
  const given = await body(context, REVIEW);
  const status = given.status as string;
  if (!["new", "kept", "rejected"].includes(status)) throw bad("status is new, kept or rejected");
  let item;
  try {
    item = await research.reviewFound(app, id, context.params.item ?? "", status, given.origin as string);
  } catch (error) {
    throw badOf(error);
  }
  const live = projectOr404(app, id);
  return sortedJson({ item, project: live.project, rev: live.rev });
}

// Scripts.

const SCRIPT_BODY: Struct = { name: "ScriptBody", fields: [required("url", "string")] };

/** Reads a Google Doc script on this machine (it fetches as the Doc's public link). */
async function readScript(url: string): Promise<script.Parsed> {
  const id = script.docId(url);
  if (id === null) throw bad("Paste a Google Docs link (docs.google.com/document/d/…).");
  let html: string;
  let title: string;
  try {
    [html, title] = await script.fetchDoc(id);
  } catch (error) {
    throw badOf(error);
  }
  const parsed = script.parse(html);
  if (parsed.title === "") parsed.title = title;
  if (!parsed.blocks.some((block) => block.kind === "footage")) {
    throw bad("No footage timestamps linked to Google Drive files were found in that Doc.");
  }
  return parsed;
}

async function scriptAttach(context: RouteContext<App>): Promise<Response> {
  const { app } = context;
  const id = context.params.id ?? "";
  const given = await body(context, SCRIPT_BODY);
  const url = given.url as string;
  const parsed = await readScript(url);
  let live;
  try {
    [live] = await app.store.update(id, "script", (project) => script.attach(project, trim(url), parsed));
  } catch (error) {
    throw badOf(error);
  }
  script.start(app, id, false);
  return sortedJson({ job: app.scripts.get(id), project: live.project, rev: live.rev });
}

async function scriptResume(context: RouteContext<App>): Promise<Response> {
  const { app } = context;
  const id = context.params.id ?? "";
  const recut = queryFlag(context, "recut");
  projectOr404(app, id);
  try {
    await app.store.mayWrite(id);
  } catch (error) {
    if (isBug(error)) throw error;
    throw new ApiError(423, diag.messageOf(error));
  }
  script.start(app, id, recut);
  return sortedJson({ job: app.scripts.get(id) });
}

/** The voice-over routes (`/api/voice/*`): `voice.routes`. */
export function voiceRoutes(router: Router<App>): void {
  router.get("/api/voice", ({ app }) => sortedJson({ projects: app.voices.list() }));
  router.post("/api/voice", voiceCreate);
  router.get("/api/voice/voices", async (context) => {
    const refresh = queryFlag(context, "refresh");
    try {
      return sortedJson(await context.app.voices.voices(refresh));
    } catch (error) {
      throw badOf(error);
    }
  });
  router.get("/api/voice/{id}", ({ app, params }) => {
    try {
      return sortedJson({ project: app.voices.get(params.id ?? "") });
    } catch (error) {
      throw notFoundOf(error);
    }
  });
  router.put("/api/voice/{id}", voiceUpdate);
  router.delete("/api/voice/{id}", ({ app, params }) => {
    try {
      app.voices.delete(params.id ?? "");
    } catch (error) {
      throw badOf(error);
    }
    return sortedJson({ ok: true });
  });
  router.get("/api/voice/{id}/full.mp3", async ({ app, params, request }) => {
    let path: string;
    try {
      path = await app.voices.full(params.id ?? "");
    } catch (error) {
      throw badOf(error);
    }
    return serveFile(request, path);
  });
  router.post("/api/voice/{id}/send", voiceSend);
  router.post("/api/voice/{id}/lines/{line}/generate", async ({ app, params }) => {
    try {
      return sortedJson({ project: await app.voices.generate(params.id ?? "", params.line ?? "") });
    } catch (error) {
      throw badOf(error);
    }
  });
  router.get("/api/voice/{id}/lines/{line}/takes/{take}", ({ app, params, request }) => {
    let path: string;
    try {
      path = app.voices.takePath(params.id ?? "", params.take ?? "");
    } catch (error) {
      throw notFoundOf(error);
    }
    if (!isFile(path)) throw notFound("no such take");
    return serveFile(request, path);
  });
  router.delete("/api/voice/{id}/lines/{line}/takes/{take}", ({ app, params }) => {
    try {
      return sortedJson({ project: app.voices.deleteTake(params.id ?? "", params.line ?? "", params.take ?? "") });
    } catch (error) {
      throw badOf(error);
    }
  });
}

/** The research routes (`/api/projects/{id}/research/*`): `research.routes`. */
export function researchRoutes(router: Router<App>): void {
  router.get("/api/projects/{id}/research", ({ app, params }) => {
    const id = params.id ?? "";
    projectOr404(app, id);
    const home = app.store.home;
    return sortedJson({ articles: research.articles(home, id), collecting: research.collecting(id), items: research.items(home, id) });
  });
  router.post("/api/projects/{id}/research", researchCollect);
  router.post("/api/projects/{id}/research/clear", ({ app, params, query }) => {
    const id = params.id ?? "";
    projectOr404(app, id);
    try {
      return sortedJson({ removed: research.clear(app.store.home, id, query.get("status") ?? "new") });
    } catch (error) {
      throw badOf(error);
    }
  });
  router.post("/api/projects/{id}/research/{item}", researchReview);
  router.get("/api/projects/{id}/research/{item}/image", ({ app, params, request }) => {
    const found = research.items(app.store.home, params.id ?? "").find((own) => own.id === params.item);
    if (found === undefined) throw notFound("no such found image");
    return serveFile(request, found.file);
  });
}

/** The script routes (`/api/scripts/preview`, `/api/projects/{id}/script(/job)`): the script seam's. */
export function routes(router: Router<App>): void {
  router.post("/api/scripts/preview", async (context) => {
    const given = await body(context, SCRIPT_BODY);
    return sortedJson(script.summary(await readScript(given.url as string)));
  });
  router.post("/api/projects/{id}/script", scriptAttach);
  router.get("/api/projects/{id}/script/job", ({ app, params }) => {
    const id = params.id ?? "";
    const live = projectOr404(app, id);
    return sortedJson({ job: app.scripts.get(id), unfinished: script.unfinished(live.project) });
  });
  router.post("/api/projects/{id}/script/job", scriptResume);
}
