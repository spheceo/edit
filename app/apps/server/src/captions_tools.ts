// The captions package's MCP tools (caption_speakers, place_captions,
// track_region, watch_footage, transcribe, media_transcript, find_in_footage,
// read_transcript) and routes (`POST /api/projects/{id}/captions`,
// `POST /api/projects/{id}/watch`, `POST
// /api/projects/{id}/media/{media}/transcribe`). Importing this module
// registers the tools; the server calls `routes` on its router.

import type { App } from "./app.ts";
import * as captions from "./captions.ts";
import * as diag from "./diag.ts";
import * as footageSearch from "./footage_search.ts";
import { isBug } from "./guard.ts";
import { ApiError, bad, notFound } from "./http/errors.ts";
import { badShape, readJson, type RouteContext, type Router } from "./http/router.ts";
import { registerTool, text } from "./mcp/registry.ts";
import type { Project } from "./model.ts";
import { duration as durationOf, fps as fpsOf, isSoundEffect, mediaOf } from "./project.ts";
import { display, round, toI64 } from "./rust.ts";
import * as seams from "./seams.ts";
import type { Under } from "./seams.ts";
import { compareKeys, stableStringify } from "./stable.ts";
import * as watch from "./watch.ts";

/** serde_json's `as_f64`. */
function number(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** serde_json's `as_u64`. */
function unsigned(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
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

/** How serde_json names a value it didn't expect. */
function unexpected(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return `boolean \`${value}\``;
  if (typeof value === "number") return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  return Array.isArray(value) ? "sequence" : "map";
}

registerTool("find_in_footage", ({ app, args, projectId }) => {
  const project = liveProject(app, projectId);
  const given = args.phrases;
  if (!Array.isArray(given)) throw new Error(`phrases: invalid type: ${unexpected(given)}, expected a sequence`);
  const phrases = given.map((phrase) => {
    if (typeof phrase !== "string") throw new Error(`phrases: invalid type: ${unexpected(phrase)}, expected a string`);
    return phrase;
  });
  if (phrases.length === 0 || phrases.length > 60) throw new Error("give 1 to 60 phrases");
  const limit = Math.min(Math.max(unsigned(args.limit) ?? 4, 1), 12);
  const context = Math.min(unsigned(args.context) ?? 8, 40);
  return text(stableStringify(footageSearch.find(app, project, phrases, limit, context)));
});

registerTool("media_transcript", async ({ app, args, projectId }) => {
  const project = liveProject(app, projectId);
  const mediaId = args.media_id;
  if (typeof mediaId !== "string") throw new Error("media_id is required");
  const media = mediaOf(project, mediaId);
  if (media === undefined) throw new Error(`no media ${mediaId}`);
  const from = number(args.start) ?? 0.0;
  const to = number(args.end) ?? Number.MAX_VALUE;
  const words = bool(args.words) ?? false;
  return text(await seams.broll.mediaTranscript(app, media, from, to, words));
});

registerTool("transcribe", ({ app, args, projectId }) => {
  const project = liveProject(app, projectId);
  const mediaId = args.media_id;
  if (typeof mediaId !== "string") throw new Error("media_id is required");
  const media = mediaOf(project, mediaId);
  if (media === undefined) throw new Error(`no media ${mediaId}`);
  if (isSoundEffect(media)) throw new Error(`${media.name} is a sound effect; there's nothing said to transcribe`);
  const status = app.media.transcribe(media.path, media.has_audio);
  return text(`transcript for ${media.name}: ${JSON.stringify(status.transcript)}`);
});

registerTool("caption_speakers", async ({ app, args, projectId }) => {
  const project = liveProject(app, projectId);
  const fps = fpsOf(project);
  const [introFrom, introTo] = captions.intro(project) ?? [0, durationOf(project)];
  const start = number(args.start);
  const end = number(args.end);
  const from = start === null ? introFrom : frameOf(start, fps);
  const to = end === null ? introTo : frameOf(end, fps);
  const summary = await captions.captionSpeakers(app, projectId, from, to);
  return text(`captioned ${display(from / fps)}–${display(to / fps)}s: ${stableStringify(summary)}`);
});

registerTool("place_captions", async ({ app, args, projectId }) => {
  const project = liveProject(app, projectId);
  const fps = fpsOf(project);
  const start = number(args.start);
  const end = number(args.end);
  const from = start === null ? 0 : frameOf(start, fps);
  const to = end === null ? durationOf(project) : frameOf(end, fps);
  const under = new Map<string, Under>();
  const given = args.under;
  if (typeof given === "object" && given !== null && !Array.isArray(given)) {
    const choices = given as Record<string, unknown>;
    for (const clip of Object.keys(choices).sort(compareKeys)) {
      const value = choices[clip];
      let choice: Under;
      if (value === "bottom") {
        choice = { kind: "bottom" };
      } else if (value === "auto") {
        choice = { kind: "auto" };
      } else if (Array.isArray(value)) {
        if (value.length !== 2) throw new Error(`under.${clip}: a point is [x, y]`);
        const [x, y] = [number(value[0]), number(value[1])];
        if (x === null || y === null) throw new Error("under points are [x, y] numbers");
        choice = { kind: "at", x, y };
      } else {
        throw new Error(`under.${clip}: "bottom", "auto" or [x, y]`);
      }
      under.set(clip, choice);
    }
  }
  const report = await captions.placeCaptions(app, projectId, from, to, under);
  return text(stableStringify(report));
});

registerTool("watch_footage", async ({ app, args, projectId }) => {
  const options = { force: bool(args.force) ?? false, segments: bool(args.segments) };
  const summary = await diag.timeAsync("watch", "watch footage", () => watch.watchFootage(app, projectId, options));
  return text(`watched: ${stableStringify(summary)}`);
});

/** The numbers of a JSON list (`filter_map(Value::as_f64)`). */
function numbers(value: unknown): number[] | null {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : null;
}

registerTool("track_region", async ({ app, args, projectId }) => {
  const time = number(args.time);
  if (time === null) throw new Error("time is required");
  const region = numbers(args.box) ?? [];
  const follow = args.follow;
  if (typeof follow !== "string") throw new Error("follow is required");
  if (region.length !== 4) throw new Error("box is [x0, y0, x1, y1]");
  const place = typeof args.place === "string" ? args.place : "on";
  const target = typeof args.target === "string" ? args.target : "position";
  let offset: [number, number] = [0.0, 0.0];
  const given = numbers(args.offset);
  if (given !== null) {
    if (given.length !== 2) throw new Error("offset is [dx, dy]");
    offset = [given[0]!, given[1]!];
  }
  const more: [number, [number, number, number, number]][] = [];
  for (const extra of Array.isArray(args.boxes) ? (args.boxes as unknown[]) : []) {
    const box = (typeof extra === "object" && extra !== null ? extra : {}) as Record<string, unknown>;
    const at = number(box.time);
    if (at === null) throw new Error("each of boxes is {time, box}");
    const values = numbers(box.box) ?? [];
    if (values.length !== 4) throw new Error("each of boxes is {time, box: [x0, y0, x1, y1]}");
    more.push([at, values as [number, number, number, number]]);
  }
  const summary = await captions.followRegion(app, projectId, time, region as [number, number, number, number], more, follow, place, target, offset);
  return text(summary);
});

registerTool("read_transcript", ({ app, projectId }) => {
  const project = liveProject(app, projectId);
  return text(seams.editing.timelineTranscript(app, project));
});

/** JSON with sorted keys (a `json!` value), as `Json(value)` answered. */
function sortedJson(value: unknown): Response {
  return new Response(stableStringify(value), { headers: { "content-type": "application/json" } });
}

/**
 * An optional JSON body, as axum's `Option<Json<T>>`: none without a content
 * type, refused (415) with one that isn't JSON, else parsed.
 */
async function optionalJson(context: RouteContext<App>, struct: string): Promise<Record<string, unknown>> {
  if (context.request.headers.get("content-type") === null) return {};
  const body = await readJson<unknown>(context);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badShape(`invalid type: ${unexpected(body)}, expected struct ${struct}`);
  }
  return body as Record<string, unknown>;
}

/** A body field serde reads as `Option<T>`. */
function optional<T>(body: Record<string, unknown>, key: string, kind: "f64" | "a boolean"): T | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  const fits = kind === "f64" ? typeof value === "number" : typeof value === "boolean";
  if (!fits) throw badShape(`${key}: invalid type: ${unexpected(value)}, expected ${kind}`);
  return value as T;
}

/** A failure of the work a route did: 400 with its reason; a bug stays a 500. */
function failed(error: unknown): never {
  if (error instanceof ApiError || isBug(error)) throw error;
  throw bad(diag.messageOf(error));
}

/** Speaker captions for a span (the intro by default), as the agent's caption_speakers tool. */
async function captionsRoute(context: RouteContext<App>): Promise<Response> {
  const { app } = context;
  const id = context.params.id ?? "";
  const body = await optionalJson(context, "CaptionsBody");
  const start = optional<number>(body, "start", "f64");
  const end = optional<number>(body, "end", "f64");
  const live = app.store.get(id);
  if (live === null) throw notFound("no such project");
  const fps = fpsOf(live.project);
  const [introFrom, introTo] = captions.intro(live.project) ?? [0, durationOf(live.project)];
  const from = start === null ? introFrom : frameOf(start, fps);
  const to = end === null ? introTo : frameOf(end, fps);
  try {
    return sortedJson(await captions.captionSpeakers(app, id, from, to));
  } catch (error) {
    failed(error);
  }
}

/** The watcher over a subtitled video's footage, as the agent's watch_footage tool. */
async function watchRoute(context: RouteContext<App>): Promise<Response> {
  const { app } = context;
  const id = context.params.id ?? "";
  const body = await optionalJson(context, "WatchBody");
  const force = optional<boolean>(body, "force", "a boolean") ?? false;
  const segments = optional<boolean>(body, "segments", "a boolean");
  try {
    return sortedJson(await diag.timeAsync("watch", "watch footage", () => watch.watchFootage(app, id, { force, segments })));
  } catch (error) {
    failed(error);
  }
}

/** Starts transcription (costs money via the relay, so only on request). */
function transcribeRoute(context: RouteContext<App>): Response {
  const { app } = context;
  const live = app.store.get(context.params.id ?? "");
  if (live === null) throw notFound("no such project");
  const media = mediaOf(live.project, context.params.media ?? "");
  if (media === undefined) throw notFound("no such media");
  if (!media.has_audio) throw bad(`${media.name} has no audio to transcribe`);
  if (isSoundEffect(media)) throw bad(`${media.name} is a sound effect; there's nothing said to transcribe`);
  return sortedJson({ status: app.media.transcribe(media.path, media.has_audio) });
}

/** The captions package's routes. */
export function routes(router: Router<App>): void {
  router.post("/api/projects/{id}/captions", captionsRoute);
  router.post("/api/projects/{id}/watch", watchRoute);
  router.post("/api/projects/{id}/media/{media}/transcribe", transcribeRoute);
}
