// The media package's MCP tools (list_library, add_from_library, set_loudness,
// level_footage, measure_audio, smooth_slow_motion, map_view) and routes (the
// library, the map pages Chrome renders, the Drive link and the agent panel).
// `registerMediaTools()` registers the tools (the server's entry point calls
// it, as it calls registerEditingTools); `routes(router)` adds the routes.

import type { App } from "./app.ts";
import * as broll from "./broll.ts";
import * as diag from "./diag.ts";
import * as drive from "./drive.ts";
import * as footageLevels from "./footage_levels.ts";
import { isBug } from "./guard.ts";
import { ApiError, bad, notFound } from "./http/errors.ts";
import { badShape, readBytes, readJson, type RouteContext, type Router } from "./http/router.ts";
import * as library from "./library.ts";
import { handlerFor, registerTool, text, type Content, type ToolCall } from "./mcp/registry.ts";
import type { AudioClip } from "./model.ts";
import { native } from "./native/index.ts";
import { clipEnd, clipOf, duration, fps as fpsOf, mediaOf, trackLabel, trackOf } from "./project.ts";
import { asInt, compareStrings, f32, fixed, round, signed } from "./rust.ts";
import * as seams from "./seams.ts";
import { read, SerdeError, unexpected } from "./serde.ts";
import { stableStringify } from "./stable.ts";

/** Who agent edits come from. */
const ORIGIN = "agent";


const num = (value: unknown): number | null => (typeof value === "number" ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

/** `serde_json::from_value::<Vec<String>>`, its error as serde words it after `prefix`. */
function strings(value: unknown, prefix = ""): string[] {
  try {
    return read({ vec: "string" }, value ?? null) as string[];
  } catch (error) {
    if (error instanceof SerdeError) throw new Error(`${prefix}${error.message}`);
    throw error;
  }
}

function live(app: App, id: string) {
  const found = app.store.get(id);
  if (found === null) throw new Error("project vanished");
  return found;
}

async function listLibrary({ app, args }: ToolCall): Promise<Content[]> {
  const listing = await (app.library as library.Library).list(bool(args.refresh) ?? false);
  let out = "The team's sound library (Google Drive). Place one with add_from_library {id}.\n";
  let heading: [string, string] | null = null;
  for (const sound of listing.sounds) {
    if (heading === null || heading[0] !== sound.kind || heading[1] !== sound.category) {
      heading = [sound.kind, sound.category];
      out += `\n${sound.kind === "music" ? "Music" : "Sound effects"} / ${sound.category}:\n`;
    }
    out += `- ${sound.id} | ${sound.name}${sound.note !== undefined ? ` — ${sound.note}` : ""}\n`;
  }
  if (listing.guide !== "") out += `\nUsage guide (from the library's Doc):\n${listing.guide}\n`;
  return text(out);
}

/** Sounds whose moment is one sharp hit: nothing before it should play. */
const SHARP = /shutter|camera|click|impact|\bhit\b|boom|thud|slam|stinger/iu;

async function addFromLibrary({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const soundId = typeof args.id === "string" ? args.id : null;
  if (soundId === null) throw new Error("id is required");
  const times = seams.editing.soundTimes(app.store, projectId, args);
  const [mediaId, sound] = await library.importSound(app, projectId, soundId, ORIGIN);
  const given = num(args.seconds);
  let seconds = given !== null && given > 0.0 ? given : null;
  const leadGiven = num(args.lead);
  let lead = leadGiven !== null && leadGiven >= 0.0 ? leadGiven : null;
  let fadeOut = Math.max(num(args.fade_out) ?? 0.0, 0.0);
  {
    // A file of several whooshes or hits plays one: its loudest.
    const media = mediaOf(live(app, projectId).project, mediaId);
    const hit = (media?.markers ?? []).find((marker) => marker.name === seams.sfx.HIT)?.time;
    if (seconds === null && sound.kind === "sfx" && media !== undefined && hit !== undefined && media.duration > seams.sfx.LONG_MOMENT && seams.sfx.MOMENT.test(sound.name)) {
      seconds = seams.sfx.HIT_PLAY;
      lead ??= Math.min(hit, (seams.sfx.HIT_PLAY * 2) / 3);
      if (fadeOut === 0.0) fadeOut = 0.25;
    } else if (seconds === null && sound.kind === "sfx" && media !== undefined && hit !== undefined && hit > 0.2 && SHARP.test(sound.name) && !/whoosh|swoosh|riser|build/iu.test(sound.name)) {
      // A short sharp sound whose hit comes late (a camera's focus beeps
      // before its shutter) plays from just before the hit, on the cut.
      lead ??= 0.1;
      seconds = media.duration - (hit - lead);
    }
  }
  let volumeDb = num(args.volume_db) ?? 0.0;
  let level = "";
  let target: number | null = null;
  const loudness = num(args.loudness);
  const under = num(args.under_speech);
  if (loudness !== null) {
    target = loudness;
  } else if (under !== null) {
    // The speech the voice-overs are matched to: the footage's own sound.
    const project = live(app, projectId).project;
    let speech: number;
    try {
      speech = await library.footageLoudness(project);
    } catch (error) {
      if (isBug(error)) throw error;
      throw new Error(
        `under_speech needs the edit's speech to measure (${diag.messageOf(error)}); give loudness in LUFS instead`,
      );
    }
    level = `; the speech is ${fixed(speech, 1)} LUFS`;
    target = speech - under;
  }
  if (target !== null) {
    const media = mediaOf(live(app, projectId).project, mediaId);
    if (media === undefined) throw new Error("sound media vanished");
    // The stretch that plays (around the hit when trimmed; see place_sound).
    const hit = (media.markers ?? []).find((marker) => marker.name === seams.sfx.HIT)?.time ?? 0.0;
    const from = seconds !== null && hit > 0.0 ? Math.max(hit - (lead ?? seconds / 2.0), 0.0) : 0.0;
    const length = Math.min(seconds ?? media.duration, media.duration - from);
    const measured = await library.loudness(media.path, from, length);
    // Never boost a near-silent stretch into noise.
    volumeDb = Math.min(Math.max(target - measured, -40.0), 12.0);
    level += `; it measures ${fixed(measured, 1)} LUFS, so volume ${signed(volumeDb, 1)} dB puts it at ${fixed(measured + volumeDb, 1)} LUFS`;
  }
  const placed = await seams.editing.placeSound(app.store, projectId, mediaId, sound.name, [], times, {
    volume_db: f32(volumeDb),
    seconds,
    lead,
    fade_out: fadeOut,
    color: sound.kind === "music" ? "green" : "yellow",
  });
  return text(`${placed}${level}`);
}

async function setLoudness({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const clipIds = strings(args.clip_ids);
  const project = live(app, projectId).project;
  const given = num(args.loudness);
  const target = given !== null ? given : await library.footageLoudness(project);
  const gains: [string, number][] = [];
  for (const clipId of clipIds) {
    const clip = clipOf(project, clipId);
    if (clip === undefined) throw new Error(`no clip ${clipId}`);
    gains.push([clipId, await library.gainTo(project, clip, target)]);
  }
  await app.store.update(projectId, ORIGIN, (edited) => {
    for (const [clipId, gain] of gains) {
      const clip = edited.clips.find((item) => item.id === clipId);
      if (clip?.type === "audio") clip.volume_db = f32(gain);
    }
  });
  return text(
    `set to ${fixed(target, 1)} LUFS: ${gains.map(([clipId, gain]) => `${clipId} volume ${signed(gain, 1)} dB`).join(", ")}`,
  );
}

async function levelFootage({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const project = live(app, projectId).project;
  const { target, levels } = await footageLevels.levelFootage(app, project, num(args.loudness) ?? undefined, bool(args.only_untouched) ?? false);
  await footageLevels.apply(app, projectId, levels, ORIGIN);
  if (levels.length === 0) {
    return text(
      bool(args.only_untouched) === true
        ? "every footage clip has been levelled already (only_untouched leaves those); run it without only_untouched to level them all again"
        : "no footage sound to level",
    );
  }
  const said = levels.map((level) =>
    level.speech === null
      ? `${level.clip} nothing said: ${signed(level.volume_db, 1)} dB`
      : `${level.clip} ${fixed(level.speech, 1)} LUFS → ${signed(level.volume_db, 1)} dB`,
  );
  return text(`footage speech to ${fixed(target, 1)} LUFS:\n${said.join("\n")}`);
}

async function measureAudio({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const project = live(app, projectId).project;
  const fps = fpsOf(project);
  const start = asInt(round((num(args.start) ?? 0.0) * fps));
  const endGiven = num(args.end);
  const end = endGiven === null ? duration(project) : asInt(round(endGiven * fps));
  const picked = "clip_ids" in args ? strings(args.clip_ids, "clip_ids: ") : null;
  interface Span {
    clip: string;
    name: string;
    track: string;
    from: number;
    to: number;
    path: string;
    source: number;
    seconds: number;
    gain: number;
  }
  const spans: Span[] = [];
  for (const clip of project.clips) {
    if (picked !== null && !picked.includes(clip.id)) continue;
    const track = trackOf(project, clip.track);
    if (track === undefined || track.muted) continue;
    if (clip.type !== "audio") continue;
    const audio = clip as AudioClip;
    const from = Math.max(clip.start, start);
    const to = Math.min(clipEnd(clip), end);
    const media = mediaOf(project, audio.media);
    if (media === undefined || !(to > from)) continue;
    spans.push({
      clip: clip.id,
      name: clip.name ?? media.name,
      track: clip.track,
      from: from / fps,
      to: to / fps,
      path: media.path,
      source: audio.source_in + ((from - clip.start) / fps) * audio.speed,
      seconds: ((to - from) / fps) * audio.speed,
      // The gain as edit-core holds it (an f32).
      gain: f32(audio.volume_db),
    });
  }
  spans.sort((a, b) => a.from - b.from);
  const labels = new Map<string, string>();
  for (const track of project.tracks) {
    const label = trackLabel(project, track.id);
    if (label !== null) labels.set(track.id, label);
  }
  // Each file is analysed once (a few side by side); every span is then arithmetic.
  await native().loudnessPrepare(spans.map((span) => span.path));
  const lines: string[] = [];
  for (const span of spans) {
    let heard: string;
    try {
      heard = `${fixed((await library.loudness(span.path, span.source, span.seconds)) + span.gain, 1)} LUFS`;
    } catch (error) {
      if (isBug(error)) throw error;
      heard = diag.messageOf(error);
    }
    const track = labels.get(span.track) ?? span.track;
    lines.push(
      `${span.clip} ${track} ${fixed(span.from, 2)}–${fixed(span.to, 2)}s ${span.name}: ${heard} (volume ${signed(span.gain, 1)} dB)`,
    );
  }
  return text(lines.length === 0 ? "no audio in that span" : lines.join("\n"));
}

async function smoothSlowMotion({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const clips = args.clip_ids === undefined || args.clip_ids === null ? [] : strings(args.clip_ids);
  if (typeof args.clip_id === "string") clips.push(args.clip_id);
  if (clips.length === 0) throw new Error("give clip_id or clip_ids");
  if (!(bool(args.wait) ?? false)) {
    const started = broll.smoothInBackground(app, projectId, clips);
    return text(
      `smoothing ${started.length} clip(s) in the background (${started.join(", ")}); each swaps in when done`,
    );
  }
  const results = await Promise.allSettled(clips.map((clip) => broll.smoothSlowMotion(app, projectId, clip)));
  const out: string[] = [];
  const failed: string[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") out.push(stableStringify(result.value));
    else if (isBug(result.reason)) throw result.reason;
    else failed.push(`${clips[index]}: ${diag.messageOf(result.reason)}`);
  });
  if (out.length === 0) throw new Error(failed.join("\n"));
  out.push(...failed.map((failure) => `failed ${failure}`));
  return text(out.join("\n"));
}

async function mapView({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const done = await broll.mapView(app, projectId, args);
  return text(broll.pretty(done));
}

const TOOLS: [string, (call: ToolCall) => Promise<Content[]>][] = [
  ["list_library", listLibrary],
  ["add_from_library", addFromLibrary],
  ["set_loudness", setLoudness],
  ["level_footage", levelFootage],
  ["measure_audio", measureAudio],
  ["smooth_slow_motion", smoothSlowMotion],
  ["map_view", mapView],
];

/** Registers the media tools with the MCP server (once; later calls do nothing). */
export function registerMediaTools(): void {
  for (const [name, handler] of TOOLS) {
    if (handlerFor(name)?.handler === handler) continue;
    registerTool(name, handler);
  }
}

// ---------------------------------------------------------------------------
// Routes

/** A JSON answer with its keys sorted (stable.ts). */
function sortedJson(value: unknown, status = 200): Response {
  return new Response(stableStringify(value), { status, headers: { "content-type": "application/json" } });
}

/** A struct-shaped answer (serde's field order). */
function structJson(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

/** `Query<{ #[serde(default)] refresh: bool }>`. */
function refreshQuery(context: RouteContext<App>): boolean {
  const given = context.query.getAll("refresh");
  const value = given[given.length - 1];
  if (value === undefined) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ApiError(400, "Failed to deserialize query string: refresh: provided string was not `true` or `false`", true);
}

/** A JSON body read as a struct of string fields (`required` must be there, the rest may be null). */
async function body(context: RouteContext<App>, name: string, required: string[], optional: string[] = []): Promise<Record<string, string | null>> {
  const value = await readJson<unknown>(context);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badShape(`invalid type: ${unexpected(value)}, expected struct ${name}`);
  }
  const given = value as Record<string, unknown>;
  const out: Record<string, string | null> = {};
  for (const field of [...required, ...optional].sort(compareStrings)) {
    const item = given[field];
    if (item === undefined || (item === null && optional.includes(field))) {
      out[field] = null;
      continue;
    }
    if (typeof item !== "string") throw badShape(`${field}: invalid type: ${unexpected(item)}, expected a string`);
    out[field] = item;
  }
  for (const field of required) {
    if (out[field] === null) throw badShape(`missing field \`${field}\``);
  }
  return out;
}

/** A failure for the UI (400 with its reason); a bug answers 500 as the server's own catch does. */
function failed(error: unknown): never {
  if (error instanceof ApiError || isBug(error)) throw error;
  throw bad(diag.messageOf(error));
}

/** The team's sound library (Drive), with its usage guide. */
async function libraryRoute(context: RouteContext<App>): Promise<Response> {
  const refresh = refreshQuery(context);
  try {
    const listing = await (context.app.library as library.Library).list(refresh);
    return structJson(library.listingJson(listing));
  } catch (error) {
    if (isBug(error)) throw error;
    throw new ApiError(503, diag.messageOf(error));
  }
}

/** Downloads a library sound (first time) and adds it to the project's media. */
async function libraryImportRoute(context: RouteContext<App>): Promise<Response> {
  const { app } = context;
  const id = context.params.id ?? "";
  const given = await body(context, "LibraryImportBody", ["origin", "sound"]);
  let media: string;
  try {
    [media] = await library.importSound(app, id, given.sound!, given.origin!);
  } catch (error) {
    failed(error);
  }
  const found = app.store.get(id);
  if (found === null) throw notFound("no such project");
  return sortedJson({ rev: found.rev, media, project: found.project });
}

/** The project's link to its export on Drive, once checked that the file is still there. */
async function driveLinkRoute(context: RouteContext<App>): Promise<Response> {
  const { app } = context;
  let file;
  try {
    file = await drive.checked(app.store, app.library, context.params.id ?? "");
  } catch (error) {
    if (isBug(error)) throw error;
    throw notFound(diag.messageOf(error));
  }
  return sortedJson({ drive: file });
}

/** Uploads a finished export to Drive again (after a failed upload); progress comes as `drive` events. */
async function driveUploadRoute(context: RouteContext<App>): Promise<Response> {
  const { app } = context;
  const given = await body(context, "ExportedQuery", ["path"]);
  const found = app.store.get(context.params.id ?? "");
  if (found === null) throw notFound("no such project");
  if (!app.exports.exported(given.path!)) throw notFound("not an export from this session");
  drive.start(app.store, app.library, found.project, given.path!);
  return sortedJson({ ok: true });
}

async function agentStatusRoute(context: RouteContext<App>): Promise<Response> {
  let status: unknown;
  try {
    status = await seams.agentPanel(context.app).status();
  } catch {
    status = { ready: false };
  }
  return sortedJson(status);
}

async function agentClisRoute(context: RouteContext<App>): Promise<Response> {
  const panel = seams.agentPanel(context.app);
  return sortedJson(panel.clis ? await panel.clis() : { claude: await panel.status() });
}

async function agentModelsRoute(context: RouteContext<App>): Promise<Response> {
  const refresh = refreshQuery(context);
  try {
    return sortedJson(await seams.agentPanel(context.app).models(refresh));
  } catch (error) {
    failed(error);
  }
}

/** Which provider the agent runs on: `{provider: "claude" | "codex"}`. */
async function agentProviderRoute(context: RouteContext<App>): Promise<Response> {
  const given = await body(context, "AgentProvider", ["provider"]);
  const provider = given.provider;
  if (provider !== "claude" && provider !== "codex") throw bad("provider: expected \"claude\" or \"codex\"");
  seams.agentPanel(context.app).setProvider(provider);
  return agentStatusRoute(context);
}

function agentChatRoute(context: RouteContext<App>): Response {
  const id = context.params.id ?? "";
  if (context.app.store.get(id) === null) throw notFound("no such project");
  return sortedJson(seams.agentPanel(context.app).chat(id));
}

async function agentSendRoute(context: RouteContext<App>): Promise<Response> {
  const { app } = context;
  const id = context.params.id ?? "";
  const given = await body(context, "AgentMessage", ["text"], ["effort", "model"]);
  const said = given.text!.trim();
  if (said === "") throw bad("say something");
  // The agent edits the project: a cloud project needs this machine's lock.
  try {
    await app.store.mayWrite(id);
  } catch (error) {
    if (isBug(error)) throw error;
    throw new ApiError(423, diag.messageOf(error));
  }
  try {
    await seams.agentPanel(app).send(id, said, given.model ?? null, given.effort ?? null);
  } catch (error) {
    failed(error);
  }
  return sortedJson({ ok: true });
}

async function agentStopRoute(context: RouteContext<App>): Promise<Response> {
  try {
    await seams.agentPanel(context.app).stop(context.params.id ?? "");
  } catch (error) {
    failed(error);
  }
  return sortedJson({ ok: true });
}

function agentResetRoute(context: RouteContext<App>): Response {
  seams.agentPanel(context.app).reset(context.params.id ?? "");
  return sortedJson({ ok: true });
}

/** Map pages' bodies (a moving shot's frames, its picture) may be large. */
const MAP_LIMIT = 64 << 20;

function mapPageRoute(context: RouteContext<App>): Response {
  return broll.mapPage(context.params.token ?? "");
}

async function mapShotRoute(context: RouteContext<App>): Promise<Response> {
  const bytes = await readBytes(context.request, context.bodyLimit);
  return new Response(null, { status: broll.mapShot(context.params.token ?? "", context.request.headers, bytes) });
}

async function mapFrameRoute(context: RouteContext<App>): Promise<Response> {
  const given = context.params.index ?? "";
  const index = /^\+?\d+$/.test(given) ? Number(given.replace("+", "")) : Number.NaN;
  if (!(index >= 0 && index <= 0xffff_ffff)) {
    throw new ApiError(400, `Invalid URL: Cannot parse \`${given}\` to a \`u32\``, true);
  }
  const bytes = await readBytes(context.request, context.bodyLimit);
  return new Response(null, { status: broll.mapFrame(context.params.token ?? "", index, bytes) });
}

/** The media package's routes. */
export function routes(router: Router<App>): void {
  router.get("/api/library", libraryRoute);
  router.post("/api/projects/{id}/library", libraryImportRoute);
  router.get("/api/projects/{id}/drive", driveLinkRoute);
  router.post("/api/projects/{id}/drive", driveUploadRoute);
  router.get("/api/agent", agentStatusRoute);
  router.get("/api/agent/clis", agentClisRoute);
  router.get("/api/agent/models", agentModelsRoute);
  router.post("/api/agent/provider", agentProviderRoute);
  router.get("/api/projects/{id}/agent", agentChatRoute);
  router.post("/api/projects/{id}/agent", agentSendRoute);
  router.post("/api/projects/{id}/agent/stop", agentStopRoute);
  router.post("/api/projects/{id}/agent/reset", agentResetRoute);
  router.get("/api/maps/{token}", mapPageRoute, { bodyLimit: MAP_LIMIT });
  router.post("/api/maps/{token}", mapShotRoute, { bodyLimit: MAP_LIMIT });
  router.post("/api/maps/{token}/frame/{index}", mapFrameRoute, { bodyLimit: MAP_LIMIT });
}
