// The subtitles package's MCP tools (add_subtitles, place_subtitles,
// repack_subtitles, mute_house_words, set_segments) and routes (`POST
// /api/projects/{id}/repack-subtitles`, `POST
// /api/projects/{id}/media/{media}/speakers`). Importing this module
// registers the tools; the server calls `routes` on its router.

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { isBug } from "./guard.ts";
import { ApiError, bad, notFound } from "./http/errors.ts";
import { badShape, readJson, type RouteContext, type Router } from "./http/router.ts";
import { registerTool, text } from "./mcp/registry.ts";
import type { Project, Segment } from "./model.ts";
import { duration, fps as fpsOf, mediaOf } from "./project.ts";
import * as faces from "./faces.ts";
import { fixed, round, toI64 } from "./rust.ts";
import * as seams from "./seams.ts";
import * as speakers from "./speakers.ts";
import { stableStringify } from "./stable.ts";
import * as subtitles from "./subtitles.ts";
import { serialize } from "./transcribe.ts";

/** A JSON number argument (serde_json's `as_f64`), else null. */
function number(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** Seconds on the timeline as a frame (`(seconds * fps).round() as i64`). */
function frameOf(seconds: number, fps: number): number {
  return toI64(round(seconds * fps));
}

function liveProject(app: App, id: string): Project {
  const live = app.store.get(id);
  if (live === null) throw new Error("project vanished");
  return live.project;
}

/** A span's frames from `start` / `end` (seconds) with defaults. */
function span(args: Record<string, unknown>, fps: number, from: number, to: number): [number, number] {
  const start = number(args.start);
  const end = number(args.end);
  return [start === null ? from : frameOf(start, fps), end === null ? to : frameOf(end, fps)];
}

registerTool("add_subtitles", async ({ app, args, projectId }) => {
  const project = liveProject(app, projectId);
  const fps = fpsOf(project);
  const introEnd = seams.captions.intro(project)?.[1] ?? 0;
  const [from, to] = span(args, fps, introEnd, duration(project));
  const neglect = args.neglect === true;
  const summary = await seams.captions.subtitles(app, projectId, from, to, neglect);
  return text(`subtitled ${fixed(from / fps, 2)}–${fixed(to / fps, 2)}s: ${stableStringify(summary)}`);
});

registerTool("place_subtitles", async ({ app, args, projectId }) => {
  const project = liveProject(app, projectId);
  const [from, to] = span(args, fpsOf(project), 0, duration(project));
  const report = await faces.placeSubtitles(app, projectId, from, to);
  return text(stableStringify(report));
});

const SEGMENT_KINDS = ["footage", "captioned", "narration", "other"];

registerTool("set_segments", async ({ app, args, projectId }) => {
  const project = liveProject(app, projectId);
  const fps = fpsOf(project);
  const total = duration(project);
  if (!Array.isArray(args.segments)) throw new Error("segments must be a list");
  const given: Segment[] = (args.segments as unknown[]).map((item) => {
    const segment = (typeof item === "object" && item !== null && !Array.isArray(item) ? item : {}) as Record<string, unknown>;
    const at = (key: string) => {
      const seconds = number(segment[key]);
      if (seconds === null) throw new Error(`each segment needs ${key} (seconds)`);
      return Math.min(Math.max(frameOf(seconds, fps), 0), total);
    };
    const start = at("start");
    const end = at("end");
    const kind = segment.kind;
    if (typeof kind !== "string" || !SEGMENT_KINDS.includes(kind)) throw new Error("kind is footage, captioned, narration or other");
    const note = typeof segment.note === "string" ? segment.note : "";
    const out: Segment = { start, end, kind: kind as Segment["kind"] };
    if (note !== "") out.note = note;
    return out;
  });
  const kept = given.filter((segment) => segment.end > segment.start).sort((a, b) => a.start - b.start);
  const segments = subtitles.fillSegments(kept, total);
  const count = segments.length;
  await app.store.update(projectId, "agent", (edited) => {
    edited.segments = segments;
  });
  return text(`${count} segments set (gaps are footage)`);
});

registerTool("mute_house_words", async ({ app, args, projectId }) => {
  const project = liveProject(app, projectId);
  const fps = fpsOf(project);
  const [from, to] = span(args, fps, 0, duration(project));
  const neglect = args.neglect === true;
  // The video's own words besides the house's (a Doc's "Blur this": murder, killer).
  const given = args.words;
  if (given !== undefined && given !== null && (!Array.isArray(given) || given.some((word) => typeof word !== "string"))) {
    throw new Error("words must be a list of words or phrases");
  }
  const extra = ((given ?? []) as string[]).map((word) => word.trim()).filter((word) => word !== "");
  const keep = args.keep;
  if (keep !== undefined && keep !== null && (!Array.isArray(keep) || keep.some((time) => typeof time !== "number"))) {
    throw new Error("keep must be a list of timeline seconds");
  }
  const summary = await subtitles.muteHouseWords(app, projectId, from, to, neglect, extra, (keep ?? []) as number[]);
  return text(`muted ${fixed(from / fps, 2)}–${fixed(to / fps, 2)}s: ${stableStringify(summary)}`);
});

/** `hold_ms` when it's a number from 0 to 3000, else the default. */
function holdMs(value: unknown): number {
  const hold = number(value);
  return hold !== null && Number.isFinite(hold) && hold >= 0 && hold <= 3000 ? hold : subtitles.DEFAULT_HOLD_MS;
}

registerTool("repack_subtitles", async ({ app, args, projectId }) => {
  const project = liveProject(app, projectId);
  const fps = fpsOf(project);
  const [from, to] = span(args, fps, 0, duration(project));
  const overlap = args.overlap === true;
  const options = {
    from,
    to,
    neglect: args.neglect === true,
    hold_ms: holdMs(args.hold_ms),
    overlap,
    faces: typeof args.faces === "boolean" ? args.faces : overlap,
  };
  const stretches = questioning(args.interrogation, fps, from, to);
  const summary = await subtitles.repackSubtitles(app, projectId, options);
  if (stretches.length === 0) return text(`subtitled ${fixed(from / fps, 2)}–${fixed(to / fps, 2)}s: ${stableStringify(summary)}`);
  // Then each questioning stretch again, the interrogation way (each run replaces only its own span).
  const questioned: unknown[] = [];
  for (const [start, end] of stretches) {
    const again = await subtitles.repackSubtitles(app, projectId, { ...options, from: start, to: end, overlap: true, faces: true, moving: true });
    questioned.push({ start: fixed(start / fps, 2), end: fixed(end / fps, 2), ...(again as Record<string, unknown>) });
  }
  return text(`subtitled ${fixed(from / fps, 2)}–${fixed(to / fps, 2)}s: ${stableStringify({ ...(summary as Record<string, unknown>), interrogation: questioned })}`);
});

/** The interrogation stretches ([start, end] seconds each) as frames inside `from`–`to`, sorted. */
export function questioning(given: unknown, fps: number, from: number, to: number): [number, number][] {
  if (given === undefined || given === null) return [];
  if (!Array.isArray(given)) throw new Error("interrogation: a list of [start, end] seconds");
  const out: [number, number][] = [];
  for (const stretch of given as unknown[]) {
    if (!Array.isArray(stretch) || stretch.length !== 2 || !stretch.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new Error("interrogation: each stretch is [start, end] in seconds");
    }
    const [start, end] = [Math.max(frameOf(stretch[0] as number, fps), from), Math.min(frameOf(stretch[1] as number, fps), to)];
    if (end > start) out.push([start, end]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** JSON with sorted keys (a `json!` value), as `Json(value)` answered. */
function sortedJson(value: unknown): Response {
  return new Response(stableStringify(value), { headers: { "content-type": "application/json" } });
}

/**
 * An optional JSON body, as axum's `Option<Json<T>>`: none without a
 * content type, refused (415) with one that isn't JSON, else parsed.
 */
async function optionalJson(context: RouteContext<App>): Promise<Record<string, unknown> | null> {
  if (context.request.headers.get("content-type") === null) return null;
  const body = await readJson<unknown>(context);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badShape("invalid type: expected struct RepackSubtitlesBody");
  }
  return body as Record<string, unknown>;
}

/** A body field serde reads as `Option<f64>`. */
function optionalNumber(body: Record<string, unknown>, key: string): number | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number") throw badShape(`${key}: invalid type: ${describe(value)}, expected f64`);
  return value;
}

/** A body field serde reads as `#[serde(default)] bool`. */
function flag(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw badShape(`${key}: invalid type: ${describe(value)}, expected a boolean`);
  return value;
}

/** How serde names a JSON value in "invalid type" errors. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  if (typeof value === "number") return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
  if (typeof value === "boolean") return `boolean \`${value}\``;
  return Array.isArray(value) ? "sequence" : "map";
}

/** Repack's subtitles and mutes for a span (all of it by default), as the agent's repack_subtitles tool. */
async function repackRoute(context: RouteContext<App>): Promise<Response> {
  const { app } = context;
  const id = context.params.id ?? "";
  const body = (await optionalJson(context)) ?? {};
  const start = optionalNumber(body, "start");
  const end = optionalNumber(body, "end");
  const neglect = flag(body, "neglect");
  const hold = optionalNumber(body, "hold_ms");
  const overlap = flag(body, "overlap");
  const live = app.store.get(id);
  if (live === null) throw notFound("no such project");
  const fps = fpsOf(live.project);
  const options = {
    from: start === null ? 0 : frameOf(start, fps),
    to: end === null ? duration(live.project) : frameOf(end, fps),
    neglect,
    hold_ms: hold !== null && Number.isFinite(hold) && hold >= 0 && hold <= 3000 ? hold : subtitles.DEFAULT_HOLD_MS,
    overlap,
    faces: overlap,
  };
  let summary: unknown;
  try {
    summary = await diag.timeAsync("subtitles", "repack subtitles", () => subtitles.repackSubtitles(app, id, options));
  } catch (error) {
    // A bug answers 500 (the server's own catch), as a panic did.
    if (error instanceof ApiError || isBug(error)) throw error;
    throw bad(diag.messageOf(error));
  }
  return sortedJson(summary);
}

/** Sets who a voice is (its role, which decides its colour) by hand. */
async function speakerRoute(context: RouteContext<App>): Promise<Response> {
  const { app } = context;
  const body = await readJson<unknown>(context);
  const given = (typeof body === "object" && body !== null && !Array.isArray(body) ? body : null) as Record<string, unknown> | null;
  if (given === null) throw badShape("invalid type: expected struct SpeakerBody");
  for (const field of ["voice", "role"]) {
    if (!(field in given)) throw badShape(`missing field \`${field}\``);
    if (typeof given[field] !== "string") throw badShape(`${field}: invalid type: ${describe(given[field])}, expected a string`);
  }
  const label = given.label;
  if (label !== undefined && label !== null && typeof label !== "string") {
    throw badShape(`label: invalid type: ${describe(label)}, expected a string`);
  }
  const live = app.store.get(context.params.id ?? "");
  if (live === null) throw notFound("no such project");
  const media = mediaOf(live.project, context.params.media ?? "");
  if (media === undefined) throw notFound("no such media");
  let transcript;
  try {
    transcript = await speakers.setRole(app, media.path, given.voice as string, given.role as string, typeof label === "string" ? label : null);
  } catch (error) {
    if (isBug(error)) throw error;
    throw bad(diag.messageOf(error));
  }
  // The transcript as it's always been written (its fields in order).
  return new Response(serialize(transcript), { headers: { "content-type": "application/json" } });
}

/** The subtitles package's routes. */
export function routes(router: Router<App>): void {
  router.post("/api/projects/{id}/repack-subtitles", repackRoute);
  router.post("/api/projects/{id}/media/{media}/speakers", speakerRoute);
}
