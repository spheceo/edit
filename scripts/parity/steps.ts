// The steps the parity run replays against both servers, in order. A step
// returns what's compared (answers, images); the run also compares project
// files, websocket events and outside calls after it.
//
// The seed home (run.ts) has three projects: "Parity small" (the short clip,
// a voice-over, a still and a sound effect, placed), the reference edit (a
// real script edit remapped onto the fixtures: cut-ins, voice-overs, B-roll,
// music) and a subtitled video (real subtitles and segments, remapped).

import * as fs from "node:fs";
import * as nodePath from "node:path";

import { SCRIPT_DOC } from "../../apps/server/test/mocks/parity.ts";
import type { ParityMock } from "../../apps/server/test/mocks/parity.ts";
import { mcpResult } from "./compare.ts";
import type { Fixtures } from "./fixtures.ts";
import type { Reply, Side } from "./servers.ts";

export interface World {
  fixtures: Fixtures;
  seed: { small: string; reference: string; subtitled: string };
  dir: string;
  /** Names one side's id (a project it created) the same on both sides. */
  alias(side: Side, id: string, label: string): void;
  mock(side: Side): ParityMock;
}

export interface Step {
  name: string;
  run(side: Side, world: World): Promise<unknown>;
  /** Differences that are known and kept (path pattern, why). */
  expect?: { path: RegExp; why: string }[];
  /** Compared and reported, never failed. */
  pending?: string;
  /** Compare project files after this step (default true). */
  files?: boolean;
  /** Which events to compare: all (default), project events only, or none. */
  events?: "all" | "project" | "none";
  /** Compare the outside calls made (default true). */
  calls?: boolean;
  /** Quiet time to wait for after the step, ms. */
  settle?: number;
  /** Runs even with --only (it sets up what later steps use). */
  always?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers

interface Clip {
  id: string;
  track: string;
  start: number;
  duration: number;
  type: string;
  media?: string;
  link?: string;
  name?: string;
  text?: string;
  [key: string]: unknown;
}

interface Project {
  id: string;
  name: string;
  media: { id: string; kind: string; path: string; name: string; duration: number }[];
  clips: Clip[];
  tracks: { id: string; kind: string }[];
  script?: { blocks: { kind: string; clip?: string; voiceover?: string }[] };
  [key: string]: unknown;
}

/** An HTTP reply as compared: status, the headers that matter and the body (bytes by size and hash). */
function shown(reply: Reply, image = false): unknown {
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "cache-control", "content-range", "accept-ranges", "content-disposition", "content-length"]) {
    if (reply.headers[name] !== undefined) headers[name] = reply.headers[name]!;
  }
  // JSON is compared as values (serde writes 30.0 where JS writes 30), so not by length.
  if (reply.body !== null) {
    delete headers["content-length"];
    return { status: reply.status, headers, body: reply.body };
  }
  if (image && reply.type.startsWith("image/")) return { status: reply.status, headers: { "content-type": headers["content-type"] }, body: { image: reply.bytes, mime: reply.type } };
  return { status: reply.status, headers, bytes: reply.bytes.length, sha256: new Bun.CryptoHasher("sha256").update(reply.bytes).digest("hex") };
}

const get = (path: string | ((world: World, side: Side) => string), image = false) => async (side: Side, world: World) =>
  shown(await side.http("GET", typeof path === "string" ? path : path(world, side)), image);
const post = (path: string | ((world: World, side: Side) => string), body?: unknown | ((world: World, side: Side) => unknown)) => async (side: Side, world: World) =>
  shown(
    await side.http(
      "POST",
      typeof path === "string" ? path : path(world, side),
      typeof body === "function" ? (body as (world: World, side: Side) => unknown)(world, side) : body,
    ),
  );

/** A tool call's result as compared (texts parsed, images by pixels). */
async function call(side: Side, name: string, args: Record<string, unknown>, project?: string): Promise<unknown> {
  const reply = await side.tool(name, args, project);
  return { status: reply.status, result: mcpResult(reply.result), error: reply.error };
}

/** A step that calls one tool on a project with arguments made from the live project. */
function tool(
  name: string,
  project: (world: World) => string,
  args: (live: { rev: number; project: Project }, world: World, side: Side) => Record<string, unknown> | Promise<Record<string, unknown>>,
): (side: Side, world: World) => Promise<unknown> {
  return async (side, world) => {
    const id = project(world);
    const current = await live(side, id);
    return call(side, name, { project_id: id, ...(await args(current, world, side)) });
  };
}

async function live(side: Side, id: string): Promise<{ rev: number; project: Project }> {
  const reply = await side.http("GET", `/api/projects/${id}`);
  if (reply.status !== 200) throw new Error(`GET ${id}: ${reply.status} ${JSON.stringify(reply.body)}`);
  return reply.body as { rev: number; project: Project };
}

const small = (world: World) => world.seed.small;
const reference = (world: World) => world.seed.reference;
const subtitled = (world: World) => world.seed.subtitled;
const created = (side: Side) => String(side.vars.created);
const scripted = (side: Side) => String(side.vars.scripted);

function first(project: Project, check: (clip: Clip) => boolean, what: string): Clip {
  const clip = project.clips.filter(check).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))[0];
  if (clip === undefined) throw new Error(`no ${what} in ${project.id}`);
  return clip;
}

function mediaOf(project: Project, check: (media: Project["media"][number]) => boolean, what: string): string {
  const media = project.media.find(check);
  if (media === undefined) throw new Error(`no ${what} media in ${project.id}`);
  return media.id;
}

/** Waits for an event of `type` on this side's stream after `from` that `check` accepts. */
async function event(side: Side, from: number, check: (event: Record<string, unknown>) => boolean, ms = 600_000): Promise<Record<string, unknown> | null> {
  let found: Record<string, unknown> | null = null;
  await side.until(() => {
    found = side.events.slice(from).find(check) ?? null;
    return found !== null;
  }, ms, 200);
  return found;
}

async function mediaSettled(side: Side, id: string, ms = 600_000): Promise<unknown> {
  const settled = (stage: unknown) => stage === "ready" || stage === "skipped" || stage === "failed" || stage === "pending";
  let last: unknown = null;
  await side.until(async () => {
    const reply = await side.http("GET", `/api/projects/${id}/media-status`);
    last = reply.body;
    const media = (reply.body as { media?: Record<string, Record<string, unknown>> }).media ?? {};
    return Object.values(media).every((status) => ["proxy", "light", "thumbs", "peaks", "transcript"].every((stage) => settled(status[stage])));
  }, ms, 500);
  return last;
}

async function exported(side: Side, id: string, from: number): Promise<unknown> {
  const done = await event(side, from, (item) => item.type === "export" && item.id === id && ["done", "failed", "cancelled"].includes(String(item.state)));
  if (done === null) return { timeout: true };
  const path = String((done as { path?: unknown }).path ?? "");
  const { seconds: _seconds, ...shownEvent } = done as Record<string, unknown>;
  return { event: shownEvent, frames: fs.existsSync(path) ? framesOf(path) : null };
}

/** An exported file's decoded frames and sound, by ffmpeg's framemd5 (so encoders' metadata doesn't count). */
function framesOf(path: string): unknown {
  const streams: Record<string, { frames: number; sha256: string }> = {};
  for (const [name, map] of [
    ["video", "0:v?"],
    ["audio", "0:a?"],
  ] as const) {
    const out = Bun.spawnSync(["ffmpeg", "-v", "error", "-i", path, "-map", map, "-f", "framemd5", "-"]);
    const lines = out.stdout
      .toString()
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"));
    if (lines.length > 0) streams[name] = { frames: lines.length, sha256: new Bun.CryptoHasher("sha256").update(lines.join("\n")).digest("hex") };
  }
  const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,width,height,r_frame_rate,sample_rate,channels:format=duration", "-of", "json", path]);
  return { ...streams, probe: JSON.parse(probe.stdout.toString() || "{}") };
}

// ---------------------------------------------------------------------------
// The steps

const SKILLS = ["edit-workflow", "research", "intro", "transitions", "cut-ins", "outro", "subtitles", "subtitle-video", "music-and-sound", "final-pass"];

export const steps: Step[] = [
  // The server itself.
  { name: "GET /api/health", run: get("/api/health") },
  {
    name: "GET /api/diagnostics",
    run: async (side) => {
      const reply = await side.http("GET", "/api/diagnostics");
      const body = reply.body as Record<string, unknown>;
      return { status: reply.status, keys: Object.keys(body).sort(), machine: body.machine, home: body.home, os: body.os };
    },
  },
  { name: "GET /api/setup", run: get("/api/setup") },
  { name: "GET /api/media-drive", run: get("/api/media-drive") },
  { name: "GET /api/update", run: get("/api/update") },
  { name: "POST /api/update (a dev build refuses)", run: post("/api/update") },
  { name: "GET /api/export/encoders", run: get("/api/export/encoders") },
  { name: "GET /api/fs (the user's home)", run: get("/api/fs") },
  { name: "GET /api/fs (the fixtures)", run: get((world) => `/api/fs?path=${encodeURIComponent(world.fixtures.dir)}`) },
  { name: "GET /api/fs (missing)", run: get("/api/fs?path=/no/such/folder") },
  { name: "GET /fonts/Geist-SemiBold.ttf", run: get("/fonts/Geist-SemiBold.ttf") },
  { name: "GET /fonts (missing)", run: get("/fonts/Nope.ttf") },
  { name: "GET / (the UI)", run: get("/") },
  { name: "GET /assets/index.js", run: get("/assets/index.js") },
  { name: "GET /a/spa/path", run: get("/projects/whatever") },
  { name: "GET /mcp (refused)", run: get("/mcp") },
  {
    name: "a request from another host is refused",
    run: async (side) => shown(await side.http("GET", "/api/health", undefined, { host: "evil.example" })),
  },
  { name: "POST /api/diagnostics/client", run: post("/api/diagnostics/client", { level: "warn", message: "parity: a client line" }) },
  { name: "GET /api/projects", run: get("/api/projects") },
  { name: "GET /api/projects (missing)", run: get("/api/projects/p0-0") },
  {
    name: "GET the small project",
    always: true,
    run: async (side, world) => shown(await side.http("GET", `/api/projects/${world.seed.small}`)),
  },
  { name: "GET media-status", run: get((world) => `/api/projects/${world.seed.small}/media-status`) },
  {
    name: "GET media files (proxy, audio, light, thumbs, peaks, transcript, unknown)",
    run: async (side, world) => {
      const { project } = await live(side, world.seed.small);
      const out: Record<string, unknown> = {};
      for (const media of project.media) {
        for (const kind of ["proxy", "audio", "light", "thumbs", "peaks", "transcript", "nope"]) {
          out[`${media.id}/${kind}`] = shown(await side.http("GET", `/api/projects/${world.seed.small}/media/${media.id}/${kind}`));
        }
      }
      // A range, as a <video> asks.
      const video = project.media.find((media) => media.kind === "video")!;
      out.range = shown(await side.http("GET", `/api/projects/${world.seed.small}/media/${video.id}/proxy`, undefined, { range: "bytes=0-99" }));
      return out;
    },
  },
  { name: "GET a frame as PNG", run: get((world) => `/api/projects/${world.seed.small}/frame/45.png`, true) },
  { name: "GET a frame as PNG (max 320)", run: get((world) => `/api/projects/${world.seed.small}/frame/200.png?max=320`, true) },
  { name: "GET a frame (not a number)", run: get((world) => `/api/projects/${world.seed.small}/frame/abc.png`) },

  // MCP basics.
  {
    name: "MCP initialize",
    run: async (side) => shown(await side.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "parity", version: "1" } })),
  },
  { name: "MCP ping", run: async (side) => shown(await side.rpc("ping", {})) },
  { name: "MCP unknown method", run: async (side) => shown(await side.rpc("nope/nothing", {})) },
  { name: "MCP tools/list", run: async (side) => shown(await side.rpc("tools/list", {})) },
  { name: "MCP an unknown tool", run: async (side) => call(side, "no_such_tool", {}) },
  { name: "list_projects", run: (side) => call(side, "list_projects", {}) },
  ...SKILLS.map(
    (name): Step => ({
      name: `skill ${name}`,
      run: (side, world) => call(side, "skill", { name, project_id: name === "edit-workflow" ? world.seed.small : world.seed.reference }),
      // edit-workflow starts watching the footage in the background.
      settle: name === "edit-workflow" ? 3000 : 500,
    }),
  ),
  { name: "skill (unknown)", run: (side, world) => call(side, "skill", { name: "nope", project_id: world.seed.small }) },
  { name: "get_project (scoped by ?project=)", run: async (side, world) => call(side, "get_project", {}, world.seed.small) },

  // The reference edit: reading it.
  { name: "get_edit_context intro", run: tool("get_edit_context", reference, () => ({ section: "intro" })) },
  { name: "get_edit_context story 60-124 s with transcript", run: tool("get_edit_context", reference, () => ({ start: 60, end: 124, include_transcript: true })) },
  { name: "get_edit_context outro", run: tool("get_edit_context", reference, () => ({ section: "outro" })) },
  { name: "get_edit_context clip_ids", run: tool("get_edit_context", reference, ({ project }) => ({ clip_ids: project.clips.slice(0, 6).map((clip) => clip.id) })) },
  { name: "get_edit_context subtitled", run: tool("get_edit_context", subtitled, () => ({ start: 0, end: 200 })) },
  { name: "read_transcript", run: tool("read_transcript", reference, () => ({})) },
  {
    name: "media_transcript phrases",
    run: tool("media_transcript", reference, ({ project }) => ({ media_id: mediaOf(project, (media) => media.kind === "video", "video"), start: 30, end: 120 })),
  },
  {
    name: "media_transcript words",
    run: tool("media_transcript", reference, ({ project }) => ({ media_id: mediaOf(project, (media) => media.kind === "video", "video"), start: 0, end: 20, words: true })),
  },
  {
    name: "find_in_footage",
    run: tool("find_in_footage", reference, () => ({
      phrases: ["the door was open", "found the car", "her brother had been home", "where were you on Saturday", "nobody answered the door"],
      context: 6,
      limit: 3,
    })),
  },
  {
    name: "look_at_media",
    run: tool("look_at_media", reference, ({ project }) => ({ media_id: mediaOf(project, (media) => media.kind === "video", "video"), start: 20, end: 65, count: 6, columns: 3 })),
  },
  { name: "render_frame (time)", run: tool("render_frame", reference, () => ({ time: 131.8 })) },
  { name: "render_frame (frame, max_size)", run: tool("render_frame", reference, () => ({ frame: 1300, max_size: 640 })) },
  { name: "contact_sheet", run: tool("contact_sheet", reference, () => ({ start: 10, end: 40, count: 6, columns: 3 })) },
  { name: "review_edit (audit only)", run: tool("review_edit", reference, () => ({})), settle: 2000 },
  { name: "review_edit (frames)", run: tool("review_edit", reference, () => ({ frames: [300, 1394, 4265, 7385] })) },
  { name: "measure_audio (span)", run: tool("measure_audio", reference, () => ({ start: 0, end: 60 })) },
  {
    name: "measure_audio (clips)",
    run: tool("measure_audio", reference, ({ project }) => ({ clip_ids: project.clips.filter((clip) => clip.type === "audio").slice(0, 4).map((clip) => clip.id) })),
  },
  { name: "list_library", run: tool("list_library", reference, () => ({})) },
  { name: "list_library (refresh)", run: tool("list_library", reference, () => ({ refresh: true })) },
  { name: "GET /api/library", run: get("/api/library") },
  { name: "case_articles", run: tool("case_articles", reference, () => ({})) },
  {
    name: "case_articles (id)",
    run: async (side, world) => {
      const listed = JSON.parse(fs.readFileSync(nodePath.join(side.home, "research", world.seed.reference, "articles.json"), "utf8")) as { id: string }[];
      return call(side, "case_articles", { project_id: world.seed.reference, id: listed[0]?.id ?? "none" });
    },
  },
  { name: "case_articles (find)", run: tool("case_articles", reference, () => ({ find: "Margate" })) },
  { name: "look_at_found", run: tool("look_at_found", reference, () => ({ count: 6 })) },
  { name: "look_at_found (offset)", run: tool("look_at_found", reference, () => ({ count: 4, offset: 6 })) },
  { name: "GET research items", run: get((world) => `/api/projects/${world.seed.reference}/research`) },
  {
    name: "GET a research image",
    run: async (side, world) => {
      const index = JSON.parse(fs.readFileSync(nodePath.join(side.home, "research", world.seed.reference, "index.json"), "utf8")) as { id: string }[];
      return shown(await side.http("GET", `/api/projects/${world.seed.reference}/research/${index[0]!.id}/image`));
    },
  },
  { name: "read_page (an article on the mock)", run: tool("read_page", reference, (_live, world, side) => ({ url: `${world.mock(side).url}/news/elm-street`, limit: 2000 })) },
  { name: "read_page (not a web address)", run: tool("read_page", reference, () => ({ url: "file:///etc/passwd" })) },
  {
    name: "add_article",
    run: tool("add_article", reference, (_live, world, side) => ({
      url: `${world.mock(side).url}/news/elm-street`,
      summary: "Names the street and says a car was found in the garage; the brother's alibi.",
    })),
  },

  // The reference edit: changing it.
  {
    name: "apply_edit_plan (dry run, a stale revision)",
    run: tool("apply_edit_plan", reference, ({ rev }) => ({ base_rev: rev - 1, dry_run: true, operations: [{ op: "tidy_tracks" }] })),
  },
  {
    name: "apply_edit_plan (a realistic stage)",
    run: tool("apply_edit_plan", reference, ({ rev, project }) => {
      const broll = first(project, (clip) => clip.type === "video" && clip.track !== "v1" && clip.start > 300, "B-roll");
      const caption = first(project, (clip) => clip.type === "text" && String(clip.name ?? "").startsWith("Caption"), "caption");
      const solid = first(project, (clip) => clip.type === "solid", "solid");
      const video = mediaOf(project, (media) => media.kind === "video", "video");
      const images = project.media.filter((media) => media.kind === "image").map((media) => media.id);
      const end = Math.max(...project.clips.map((clip) => clip.start + clip.duration));
      return {
        base_rev: rev,
        review_frames: [1300, 4500],
        operations: [
          {
            op: "add",
            as: "hero",
            clip: {
              type: "video",
              media: video,
              source_in: 60.2,
              speed: 0.5,
              start: 411,
              duration: 91,
              track: "new",
              name: "Intro B-roll · the house from the street",
              keyframes: { scale: [{ frame: 0, value: 1, ease: "linear" }, { frame: 90, value: 1.08, ease: "linear" }] },
            },
          },
          { op: "update", select: { ids: [{ $ref: "hero" }] }, patch: { opacity: 0.9, fade_in: 6 } },
          { op: "keyframes", select: { ids: [broll.id] }, param: "scale", keyframes: [{ frame: 0, value: 1, ease: "linear" }, { frame: 60, value: 1.1, ease: "out" }] },
          { op: "update", select: { ids: [caption.id] }, patch: { text: "Officer Rodriguez" } },
          { op: "delete", select: { ids: [solid.id] } },
          { op: "transition", kind: "drop", at: 1248 },
          { op: "transition", kind: "flash", at: 4713 },
          { op: "transition", kind: "dip", at: 10764 },
          { op: "markers", add: [{ name: "door slam", frame: 2000, note: "the front door" }, { name: "camera flash", media: video, time: 75.5 }] },
          {
            op: "evidence_board",
            start: end - 900,
            end: end - 600,
            items: images.slice(0, 3).map((media, index) => ({ media, label: ["the chat", "the closet", "the house"][index], at: end - 880 + index * 90 })),
            illustrative: true,
          },
          { op: "evidence_card", media: images[3] ?? images[0], start: end - 600, end: end - 480, label: "The photo shown in court" },
          { op: "date_title", text: "October 24, 2023", start: 1248, end: 1330 },
          {
            op: "desktop_profile",
            start: end - 480,
            duration: 150,
            media: images[4] ?? images[0],
            lines: ["34 years old", "The girl's aunt", "Charged with aggravated child abuse"],
            title: "Latricia.txt",
          },
          { op: "tidy_tracks" },
        ],
      };
    }),
    settle: 2000,
  },
  {
    name: "apply_edit_plan (an invalid plan saves nothing)",
    run: tool("apply_edit_plan", reference, ({ rev }) => ({
      base_rev: rev,
      operations: [{ op: "add", clip: { type: "text", text: "no start" } }, { op: "update", select: { ids: ["c999999"] }, patch: { opacity: 0.5 } }],
    })),
  },
  {
    name: "markers (list, add, remove)",
    run: async (side, world) => {
      const id = world.seed.reference;
      return [
        await call(side, "markers", { project_id: id }),
        await call(side, "markers", { project_id: id, add: [{ name: "phone buzz", frame: 900 }] }),
        await call(side, "markers", { project_id: id, remove: [{ name: "door slam" }] }),
      ];
    },
  },
  { name: "add_sound_effect (times)", run: tool("add_sound_effect", reference, () => ({ sound: "shutter", times: [41.6, 158.1], volume_db: -6 })) },
  { name: "add_sound_effect (markers)", run: tool("add_sound_effect", reference, () => ({ sound: "shutter", markers: ["phone buzz"] })) },
  { name: "add_from_library (a hit on a cut)", run: tool("add_from_library", reference, () => ({ id: "boom", times: [41.6], loudness: -18, seconds: 1, lead: 0.3 })), settle: 1500 },
  { name: "add_from_library (music under speech)", run: tool("add_from_library", reference, () => ({ id: "song1", times: [9.5], seconds: 30, under_speech: true, fade_out: 1.5 })), settle: 1500 },
  {
    name: "set_loudness",
    run: tool("set_loudness", reference, ({ project }) => {
      const voiceovers = project.script?.blocks.map((block) => block.voiceover).filter((id): id is string => typeof id === "string") ?? [];
      return { clip_ids: voiceovers.slice(0, 3) };
    }),
  },
  {
    name: "set_loudness (to a level)",
    run: tool("set_loudness", reference, ({ project }) => ({
      clip_ids: project.clips.filter((clip) => clip.type === "audio" && clip.track === "a4" && clip.duration > 90).slice(0, 2).map((clip) => clip.id),
      loudness: -26,
    })),
  },
  {
    name: "cover_cut_in (cut-in 2)",
    run: tool("cover_cut_in", reference, ({ project }) => {
      const video = project.media.filter((media) => media.kind === "video");
      return {
        cut_in: 2,
        shots: [
          { media: video[0]!.id, source_in: 100, name: "the patrol car pulls up" },
          { media: video[1]!.id, source_in: 40, name: "the front door", at: 43.5 },
          { media: project.media.find((media) => media.kind === "image")!.id, source_in: 0, name: "the chat", label: "The message in the class chat", at: 46 },
        ],
      };
    }),
    settle: 1500,
  },
  {
    name: "batch (several edits, $N refs, keep_going)",
    run: tool("batch", reference, ({ project }) => {
      const text = first(project, (clip) => clip.type === "text" && clip.start > 2000, "text");
      return {
        keep_going: true,
        calls: [
          { tool: "add_text", args: { text: "Margate, Florida", start: 50, duration: 2.5, style: { size: 64 } } },
          { tool: "set_keyframes", args: { clip_id: "$1", param: "opacity", keyframes: [{ frame: 0, value: 0, ease: "linear" }, { frame: 10, value: 1, ease: "linear" }] } },
          { tool: "update_clip", args: { clip_id: text.id, patch: { text: `${text.text ?? ""} (checked)` } } },
          { tool: "update_clip", args: { clip_id: "c0", patch: { opacity: 1 } } },
          { tool: "get_edit_context", args: { start: 48, end: 55 } },
        ],
      };
    }),
  },
  {
    name: "update_clips (by label on a track, start/end)",
    run: tool("update_clips", reference, ({ project }) => {
      const caption = first(project, (clip) => clip.type === "text" && String(clip.name ?? "").startsWith("Caption"), "caption");
      const label = (caption.style as { label?: { text?: string } } | undefined)?.label?.text;
      return label !== undefined
        ? { label, patch: { style: { label: { text: label.replace(/:$/, "").split(" ")[0] + ":" } } } }
        : { clip_ids: [caption.id], patch: { opacity: 0.95 } };
    }),
  },
  { name: "update_clips (by range)", run: tool("update_clips", reference, () => ({ start: 0, end: 20, track: "v2", patch: { fade_out: 2 } })) },
  { name: "realign_script", run: tool("realign_script", reference, () => ({})), settle: 1500 },
  { name: "tighten_voiceover (dry run)", run: tool("tighten_voiceover", reference, () => ({ dry_run: true, start: 0, end: 400 })) },
  { name: "tighten_voiceover", run: tool("tighten_voiceover", reference, () => ({ start: 40, end: 60, max_pause: 0.6, keep: 0.3 })) },
  {
    name: "speed_voiceover (the last cut-in)",
    run: tool("speed_voiceover", reference, ({ project }) => {
      const blocks = project.script?.blocks.filter((block) => block.kind === "narration") ?? [];
      const voiceover = project.clips.find((clip) => clip.id === blocks.at(-1)?.voiceover);
      if (voiceover === undefined) return { start: 1500, end: 1520, speed: 1.1 };
      return { start: voiceover.start / 30, end: (voiceover.start + voiceover.duration) / 30, speed: 1.1 };
    }),
  },
  { name: "place_voiceovers", run: tool("place_voiceovers", reference, () => ({})), settle: 2000 },
  { name: "remove_time", run: tool("remove_time", reference, () => ({ start: 1590, end: 1592.5 })) },
  { name: "tidy_tracks", run: tool("tidy_tracks", reference, () => ({})) },
  { name: "caption_speakers (the model is unavailable)", run: tool("caption_speakers", reference, () => ({ start: 0, end: 12 })), settle: 1500 },
  { name: "place_captions", run: tool("place_captions", reference, () => ({ start: 0, end: 40 })), settle: 1500 },
  { name: "mute_house_words (edit, neglect)", run: tool("mute_house_words", reference, () => ({ neglect: true })) },
  {
    name: "track_region (a caption follows a box)",
    run: tool("track_region", reference, ({ project }) => {
      const footage = first(project, (clip) => clip.type === "video" && clip.track === "v1" && clip.duration > 60, "footage");
      const text = first(project, (clip) => clip.type === "text" && clip.start >= footage.start && clip.start < footage.start + footage.duration, "text over footage");
      return { box: [840, 300, 1080, 560], follow: text.id, place: "below", time: (text.start + 2) / 30 };
    }),
    settle: 1500,
  },
  {
    name: "track_region (an adjustment blurs, with sightings)",
    run: tool("track_region", reference, ({ project }) => {
      const adjustment = first(project, (clip) => clip.type === "adjustment", "adjustment");
      return {
        box: [700, 400, 900, 640],
        follow: adjustment.id,
        place: "on",
        target: "blur",
        time: (adjustment.start + 1) / 30,
        boxes: [{ time: (adjustment.start + 7) / 30, box: [760, 420, 960, 660] }],
      };
    }),
    settle: 1500,
  },
  {
    name: "still_frame",
    run: tool("still_frame", reference, ({ project }) => ({ media_id: mediaOf(project, (media) => media.kind === "video", "video"), time: 234, name: "Case footage · the porch" })),
  },
  {
    name: "use_found",
    run: async (side, world) => {
      const index = JSON.parse(fs.readFileSync(nodePath.join(side.home, "research", world.seed.reference, "index.json"), "utf8")) as { id: string }[];
      return call(side, "use_found", { project_id: world.seed.reference, found_id: index[1]!.id });
    },
  },
  {
    name: "reject_found",
    run: async (side, world) => {
      const index = JSON.parse(fs.readFileSync(nodePath.join(side.home, "research", world.seed.reference, "index.json"), "utf8")) as { id: string }[];
      return call(side, "reject_found", { project_id: world.seed.reference, ids: [index[2]!.id, index[3]!.id, "nope"] });
    },
  },
  {
    name: "POST research review (kept, rejected, bad status)",
    run: async (side, world) => {
      const id = world.seed.reference;
      const index = JSON.parse(fs.readFileSync(nodePath.join(side.home, "research", id, "index.json"), "utf8")) as { id: string }[];
      return [
        shown(await side.http("POST", `/api/projects/${id}/research/${index[4]!.id}`, { status: "kept", origin: "ui" })),
        shown(await side.http("POST", `/api/projects/${id}/research/${index[5]!.id}`, { status: "rejected", origin: "ui" })),
        shown(await side.http("POST", `/api/projects/${id}/research/${index[6]!.id}`, { status: "maybe", origin: "ui" })),
      ];
    },
  },
  { name: "POST research clear (rejected)", run: post((world) => `/api/projects/${world.seed.reference}/research/clear?status=rejected`) },
  { name: "search_web (no query)", run: tool("search_web", reference, () => ({ query: "  " })) },
  { name: "collect_images (no queries)", run: tool("collect_images", reference, () => ({ queries: [" "], per_query: 2 })) },
  // The two that read the live web through headless Chrome (DuckDuckGo, Bing): no
  // stand-in reaches them, so what the web answers is allowed to differ between the
  // two asks; how each server reads and reports it is still compared.
  {
    name: "search_web (live web)",
    run: tool("search_web", reference, () => ({ query: "Margate police teen class chat aunt uncle arrested" })),
    expect: [{ path: /^\.result\.content\[0\]/, why: "the live web (DuckDuckGo) answered each server on its own" }],
    calls: false,
  },
  {
    name: "collect_images (live web)",
    run: tool("collect_images", reference, () => ({ queries: ["Margate Florida police car"], per_query: 2 })),
    expect: [{ path: /^\.result\.content|^history|^p1791811932480-23\.json/, why: "the live web (Bing images) answered each server on its own" }],
    calls: false,
    settle: 3000,
  },
  { name: "map_view (the map service isn't there)", run: tool("map_view", reference, () => ({ place: "4435 Paxton Drive South, Hilliard, Ohio", seconds: 5.5, highlight_after: 2.6, highlight_fade: 0.4, still: true })) },
  { name: "GET /api/maps/{token} (unknown)", run: get("/api/maps/nope") },
  { name: "POST /api/maps/{token} (unknown)", run: post("/api/maps/nope", { error: "x" }) },
  { name: "POST /api/maps/{token}/frame/{index} (unknown)", run: post("/api/maps/nope/frame/0") },
  { name: "the reference edit after its edits", run: async (side, world) => live(side, world.seed.reference) },

  // The subtitled video.
  { name: "watch_footage (the subtitled video)", run: tool("watch_footage", subtitled, () => ({})), settle: 2000 },
  { name: "watch_footage again (cached)", run: tool("watch_footage", subtitled, () => ({})) },
  { name: "POST watch (REST, segments)", run: post((world) => `/api/projects/${world.seed.subtitled}/watch`, { segments: true }), settle: 3000 },
  {
    name: "set_segments",
    run: tool("set_segments", subtitled, () => ({
      segments: [
        { start: 0, end: 11, kind: "captioned", note: "cold open" },
        { start: 11, end: 30, kind: "narration", note: "the narrator sets it up" },
        { start: 30, end: 600, kind: "footage" },
        { start: 600, end: 620, kind: "other", note: "a title card" },
      ],
    })),
  },
  { name: "repack_subtitles (overlap, faces)", run: tool("repack_subtitles", subtitled, () => ({ start: 30, end: 240, overlap: true, neglect: true })), settle: 2000 },
  { name: "repack_subtitles (no faces, hold)", run: tool("repack_subtitles", subtitled, () => ({ start: 240, end: 400, faces: false, hold_ms: 800 })), settle: 1500 },
  { name: "POST repack-subtitles (REST)", run: post((world) => `/api/projects/${world.seed.subtitled}/repack-subtitles`, { start: 400, end: 480, overlap: true }), settle: 3000 },
  { name: "add_subtitles", run: tool("add_subtitles", subtitled, () => ({ start: 480, end: 600, neglect: true })), settle: 1500 },
  { name: "place_subtitles", run: tool("place_subtitles", subtitled, () => ({ start: 30, end: 200 })), settle: 1500 },
  { name: "mute_house_words (subtitled)", run: tool("mute_house_words", subtitled, () => ({ start: 0, end: 600 })) },
  {
    name: "update_clips (relabel one person)",
    run: tool("update_clips", subtitled, ({ project }) => {
      const sub = project.clips.find((clip) => clip.type === "text" && (clip.style as { label?: { text?: string } } | undefined)?.label?.text);
      const label = (sub?.style as { label?: { text?: string } } | undefined)?.label?.text ?? "Officer:";
      return { label, patch: { style: { label: { text: "Detective:" } } } };
    }),
  },
  {
    name: "POST speakers (name a voice)",
    run: async (side, world) => {
      const { project } = await live(side, world.seed.subtitled);
      return shown(await side.http("POST", `/api/projects/${world.seed.subtitled}/media/${project.media[0]!.id}/speakers`, { voice: "speaker_1", role: "suspect", label: "Dana" }));
    },
    settle: 1500,
  },
  { name: "POST captions (REST, the model is unavailable)", run: post((world) => `/api/projects/${world.seed.subtitled}/captions`, { start: 0, end: 8 }), settle: 3000 },
  { name: "GET the subtitled agent chat", run: get((world) => `/api/projects/${world.seed.subtitled}/agent`) },
  { name: "GET drive link (the subtitled video)", run: get((world) => `/api/projects/${world.seed.subtitled}/drive`) },
  { name: "POST drive (not an export)", run: post((world) => `/api/projects/${world.seed.subtitled}/drive`, { path: "/tmp/not-an-export.mp4" }) },
  { name: "the subtitled video after its edits", run: async (side, world) => live(side, world.seed.subtitled) },

  // The small project: the editing tools one by one.
  { name: "add_text", run: tool("add_text", small, () => ({ text: "Elm Street, Saturday", start: 0, duration: 2, animation: { preset: "rise" }, color: "yellow", style: { size: 64 }, transform: { x: 0, y: 300, scale: 1, rotation: 0 } })) },
  {
    name: "add_clip (a solid on a new track)",
    run: tool("add_clip", small, () => ({ clip: { type: "solid", start: 30, duration: 45, fill: [0, 0, 0, 0.5], track: "new", name: "Darken" } })),
  },
  {
    name: "add_clip (B-roll with keyframes)",
    run: tool("add_clip", small, ({ project }) => ({
      clip: {
        type: "video",
        media: mediaOf(project, (media) => media.kind === "video", "video"),
        source_in: 2,
        speed: 0.5,
        start: 120,
        duration: 90,
        name: "B-roll · the pattern",
        keyframes: { scale: [{ frame: 0, value: 1, ease: "linear" }, { frame: 90, value: 1.08, ease: "linear" }] },
      },
    })),
  },
  { name: "add_clip (invalid)", run: tool("add_clip", small, () => ({ clip: { type: "video", start: 0, duration: 10, media: "m404" } })) },
  {
    name: "update_clip",
    run: tool("update_clip", small, ({ project }) => ({ clip_id: first(project, (clip) => clip.type === "text", "text").id, patch: { text: "Elm Street, Saturday night", style: { size: 72 } } })),
  },
  {
    name: "set_keyframes",
    run: tool("set_keyframes", small, ({ project }) => ({
      clip_id: first(project, (clip) => clip.type === "audio", "audio").id,
      param: "volume_db",
      keyframes: [{ frame: 0, value: -11.5, ease: "linear" }, { frame: 60, value: -18.600000381469727, ease: "out" }],
    })),
  },
  { name: "set_in_out", run: tool("set_in_out", small, () => ({ in: 1, out: 8.5 })) },
  { name: "set_in_out (clear in)", run: tool("set_in_out", small, () => ({ in: null })) },
  {
    name: "import_media (tool)",
    run: tool("import_media", small, (_live, world) => ({ paths: [world.fixtures.tone, "/no/such/file.mp4"], place: true })),
    settle: 3000,
  },
  { name: "transcribe (tool)", run: tool("transcribe", small, ({ project }) => ({ media_id: mediaOf(project, (media) => media.path.endsWith("tone.m4a"), "tone") })), settle: 3000 },
  { name: "media status after the import", run: async (side, world) => mediaSettled(side, world.seed.small), settle: 1500 },
  {
    name: "smooth_slow_motion (no wait)",
    run: tool("smooth_slow_motion", small, ({ project }) => ({ clip_id: first(project, (clip) => clip.type === "video" && clip.speed === 0.5, "slowed clip").id, wait: false })),
    settle: 1500,
  },
  {
    name: "delete_clips (close_gap)",
    run: tool("delete_clips", small, ({ project }) => ({ clip_ids: [first(project, (clip) => clip.type === "solid", "solid").id], close_gap: true })),
  },
  { name: "remove_time (small)", run: tool("remove_time", small, () => ({ start: 3, end: 4 })) },
  { name: "tidy_tracks (small)", run: tool("tidy_tracks", small, () => ({})) },
  {
    name: "export (tool, a range, small)",
    run: async (side, world) => {
      const from = side.events.length;
      const path = nodePath.join(world.dir, `export-${side.name}`, "small.mp4");
      const answer = await call(side, "export", { project_id: world.seed.small, path, options: { range: [0, 90], size: 360, quality: "small" } });
      return { answer, done: await exported(side, world.seed.small, from) };
    },
    settle: 1000,
  },
  {
    name: "POST export (REST, wav)",
    run: async (side, world) => {
      const from = side.events.length;
      const path = nodePath.join(world.dir, `export-${side.name}`, "small.wav");
      const answer = shown(await side.http("POST", `/api/projects/${world.seed.small}/export`, { path, options: { format: "wav", range: [0, 120] } }));
      return { answer, done: await exported(side, world.seed.small, from) };
    },
  },
  {
    name: "POST export (REST, png)",
    run: async (side, world) => {
      const from = side.events.length;
      const path = nodePath.join(world.dir, `export-${side.name}`, "small.png");
      const answer = shown(await side.http("POST", `/api/projects/${world.seed.small}/export`, { path, options: { format: "png", range: [45, 46] } }));
      const done = await exported(side, world.seed.small, from);
      return { answer, done, image: fs.existsSync(path) ? { image: new Uint8Array(fs.readFileSync(path)), mime: "image/png" } : null };
    },
  },
  {
    name: "POST export then cancel",
    run: async (side, world) => {
      const from = side.events.length;
      const path = nodePath.join(world.dir, `export-${side.name}`, "cancelled.mp4");
      const answer = shown(await side.http("POST", `/api/projects/${world.seed.reference}/export`, { path, options: { size: 360 } }));
      const cancel = shown(await side.http("POST", `/api/projects/${world.seed.reference}/export/cancel`));
      const done = await event(side, from, (item) => item.type === "export" && ["done", "failed", "cancelled"].includes(String(item.state)));
      return { answer, cancel, state: done?.state };
    },
  },
  { name: "POST export/cancel (nothing running)", run: post((world) => `/api/projects/${world.seed.small}/export/cancel`) },
  {
    name: "GET /api/exports/file",
    run: async (side, world) => shown(await side.http("GET", `/api/exports/file?path=${encodeURIComponent(nodePath.join(world.dir, `export-${side.name}`, "small.mp4"))}`)),
    expect: [{ path: /sha256|content-length|bytes/, why: "an encoder's container bytes (the decoded frames are compared by the export steps)" }],
  },
  { name: "GET /api/exports/file (not an export)", run: get("/api/exports/file?path=/etc/hosts") },
  { name: "POST /api/exports/reveal (not an export)", run: post("/api/exports/reveal", { path: "/etc/hosts" }) },
  { name: "the small project after its edits", run: async (side, world) => live(side, world.seed.small) },

  // A new project (a cloud project: the relay token is set), its media and its life.
  {
    name: "POST /api/projects (create)",
    always: true,
    run: async (side, world) => {
      const reply = await side.http("POST", "/api/projects", { name: "Parity new", width: 1280, height: 720, fps: 30 });
      const id = (reply.body as { project: { id: string } }).project.id;
      side.vars.created = id;
      world.alias(side, id, "<created>");
      return shown(reply);
    },
    settle: 3000,
  },
  { name: "POST /api/projects (bad body)", run: post("/api/projects", { width: 3 }) },
  {
    name: "POST import (cloud: uploaded with a proxy)",
    run: async (side, world) => {
      const id = created(side);
      const answer = shown(await side.http("POST", `/api/projects/${id}/import`, { paths: [world.fixtures.short, world.fixtures.still], place: true, origin: "ui" }));
      return { answer, settled: await mediaSettled(side, id) };
    },
    settle: 4000,
  },
  {
    name: "POST upload (a sound)",
    run: async (side, world) => {
      const id = created(side);
      const bytes = new Uint8Array(fs.readFileSync(world.fixtures.tone));
      const answer = shown(await side.http("POST", `/api/projects/${id}/upload?name=tone.m4a&size=${bytes.length}&origin=ui`, bytes, { "content-type": "application/octet-stream" }));
      return { answer, settled: await mediaSettled(side, id) };
    },
    settle: 4000,
  },
  { name: "POST upload (not media)", run: async (side) => shown(await side.http("POST", `/api/projects/${created(side)}/upload?name=notes.txt&size=3`, new Uint8Array([1, 2, 3]))) },
  {
    name: "POST transcribe (REST)",
    run: async (side) => {
      const { project } = await live(side, created(side));
      const out: unknown[] = [];
      for (const media of project.media) out.push(shown(await side.http("POST", `/api/projects/${created(side)}/media/${media.id}/transcribe`)));
      return out;
    },
    settle: 3000,
  },
  {
    name: "PUT project (rename; then a stale revision)",
    run: async (side) => {
      const id = created(side);
      const current = await live(side, id);
      const renamed = { ...current.project, name: "Parity new (renamed)" };
      const first = shown(await side.http("PUT", `/api/projects/${id}`, { base_rev: current.rev, project: renamed, origin: "ui" }));
      const stale = shown(await side.http("PUT", `/api/projects/${id}`, { base_rev: current.rev, project: current.project, origin: "ui" }));
      const invalid = shown(await side.http("PUT", `/api/projects/${id}`, { base_rev: current.rev + 1, project: { ...renamed, clips: [{ id: "x", track: "nope" }] }, origin: "ui" }));
      return { first, stale, invalid };
    },
    settle: 3000,
  },
  { name: "GET /api/cloud", run: get("/api/cloud") },
  { name: "POST /api/cloud (holder)", run: post("/api/cloud", { holder: "parity-mac" }) },
  { name: "GET /api/cloud/projects", run: get("/api/cloud/projects"), settle: 3000 },
  { name: "GET project cloud status", run: async (side) => shown(await side.http("GET", `/api/projects/${created(side)}/cloud`)) },
  { name: "POST cloud/open", run: async (side) => shown(await side.http("POST", `/api/projects/${created(side)}/cloud/open`, {})), settle: 3000 },
  { name: "POST cloud/open (no JSON body)", run: async (side) => shown(await side.http("POST", `/api/projects/${created(side)}/cloud/open`)) },
  { name: "POST cloud/takeover", run: async (side) => shown(await side.http("POST", `/api/projects/${created(side)}/cloud/takeover`)), settle: 3000 },
  { name: "POST cloud/close", run: async (side) => shown(await side.http("POST", `/api/projects/${created(side)}/cloud/close`, {})), settle: 3000 },
  { name: "POST cloud/upload (move the small project to the cloud)", run: post((world) => `/api/projects/${world.seed.small}/cloud/upload`), settle: 5000 },
  { name: "POST cloud/backfill (its media follow)", run: post((world) => `/api/projects/${world.seed.small}/cloud/backfill`), settle: 8000 },
  { name: "GET small project cloud status", run: get((world) => `/api/projects/${world.seed.small}/cloud`) },
  { name: "POST library (a sound into the new project)", run: async (side) => shown(await side.http("POST", `/api/projects/${created(side)}/library`, { sound: "whoosh", origin: "ui" })), settle: 3000 },

  // A script import: the Doc, its Drive footage, the voice-overs, research.
  { name: "POST /api/scripts/preview", run: post("/api/scripts/preview", { url: `https://docs.google.com/document/d/${SCRIPT_DOC}/edit` }) },
  { name: "POST /api/scripts/preview (not a Doc)", run: post("/api/scripts/preview", { url: "https://example.com/doc" }) },
  {
    name: "POST script (attach and import)",
    always: true,
    run: async (side, world) => {
      const reply = await side.http("POST", "/api/projects", { name: "Parity case" });
      const id = (reply.body as { project: { id: string } }).project.id;
      side.vars.scripted = id;
      world.alias(side, id, "<scripted>");
      const from = side.events.length;
      const attached = shown(await side.http("POST", `/api/projects/${id}/script`, { url: `https://docs.google.com/document/d/${SCRIPT_DOC}/edit` }));
      const done = await event(side, from, (item) => item.type === "script" && ["done", "failed"].includes(String((item.job as { state?: string } | undefined)?.state)), 900_000);
      return { attached, done };
    },
    settle: 5000,
  },
  { name: "GET script/job", run: async (side) => shown(await side.http("GET", `/api/projects/${scripted(side)}/script/job`)) },
  {
    name: "POST script/job (resume)",
    run: async (side) => {
      const from = side.events.length;
      const answer = shown(await side.http("POST", `/api/projects/${scripted(side)}/script/job`));
      const done = await event(side, from, (item) => item.type === "script" && ["done", "failed"].includes(String((item.job as { state?: string } | undefined)?.state)), 600_000);
      return { answer, done };
    },
    settle: 3000,
  },
  { name: "the imported script project", run: async (side) => live(side, scripted(side)) },
  { name: "get_edit_context (the imported script)", run: async (side) => call(side, "get_edit_context", { project_id: scripted(side) }) },

  // Voice-over projects.
  { name: "GET /api/voice", run: get("/api/voice") },
  { name: "GET /api/voice/voices", run: get("/api/voice/voices") },
  { name: "GET /api/voice/voices (refresh)", run: get("/api/voice/voices?refresh=true") },
  {
    name: "POST /api/voice (from the script project)",
    always: true,
    run: async (side, world) => {
      const reply = await side.http("POST", "/api/voice", { name: "Parity narration", from_project: scripted(side) });
      const id = String((reply.body as { project?: { id?: string }; id?: string }).project?.id ?? (reply.body as { id?: string }).id ?? "");
      side.vars.voice = id;
      if (id !== "") world.alias(side, id, "<voice>");
      return shown(reply);
    },
  },
  { name: "GET /api/voice/{id}", run: async (side) => shown(await side.http("GET", `/api/voice/${side.vars.voice}`)) },
  {
    name: "PUT /api/voice/{id}",
    run: async (side) => {
      const current = (await side.http("GET", `/api/voice/${side.vars.voice}`)).body as Record<string, unknown>;
      const project = (current.project ?? current) as Record<string, unknown>;
      return shown(await side.http("PUT", `/api/voice/${side.vars.voice}`, { ...project, name: "Parity narration (v2)" }));
    },
  },
  {
    name: "POST voice line generate",
    run: async (side) => {
      const current = (await side.http("GET", `/api/voice/${side.vars.voice}`)).body as { project?: { lines?: { id: string }[] }; lines?: { id: string }[] };
      const lines = current.project?.lines ?? current.lines ?? [];
      side.vars.line = lines[0]?.id ?? "0";
      return shown(await side.http("POST", `/api/voice/${side.vars.voice}/lines/${side.vars.line}/generate`));
    },
    settle: 3000,
  },
  {
    name: "GET a voice take, its full mp3, delete a take",
    run: async (side) => {
      const current = (await side.http("GET", `/api/voice/${side.vars.voice}`)).body as Record<string, unknown>;
      const project = (current.project ?? current) as { lines?: { id: string; takes?: { id: string }[] }[] };
      const take = project.lines?.find((line) => line.id === side.vars.line)?.takes?.[0]?.id ?? "0";
      return {
        take: shown(await side.http("GET", `/api/voice/${side.vars.voice}/lines/${side.vars.line}/takes/${take}`)),
        full: shown(await side.http("GET", `/api/voice/${side.vars.voice}/full.mp3`)),
        deleted: shown(await side.http("DELETE", `/api/voice/${side.vars.voice}/lines/${side.vars.line}/takes/${take}`)),
      };
    },
    expect: [{ path: /full.*(sha256|bytes|content-length)/, why: "the full voice-over is joined by an encoder" }],
  },
  { name: "POST /api/voice/{id}/send", run: async (side) => shown(await side.http("POST", `/api/voice/${side.vars.voice}/send`, { project: created(side) })), settle: 3000 },
  {
    name: "POST /api/voice/{id}/send (a take chosen)",
    run: async (side) => {
      const current = (await side.http("GET", `/api/voice/${side.vars.voice}`)).body as Record<string, unknown>;
      const project = structuredClone((current.project ?? current) as { lines?: { id: string; takes?: { id: string }[]; chosen?: string | null }[] });
      for (const line of project.lines ?? []) if (line.takes?.[0] !== undefined) line.chosen = line.takes[0].id;
      const saved = shown(await side.http("PUT", `/api/voice/${side.vars.voice}`, project));
      return { saved, sent: shown(await side.http("POST", `/api/voice/${side.vars.voice}/send`, { project: created(side) })) };
    },
    settle: 3000,
  },
  { name: "DELETE /api/voice/{id}", run: async (side) => shown(await side.http("DELETE", `/api/voice/${side.vars.voice}`)) },

  // The agent (Codex isn't signed in here: nothing reaches a model).
  { name: "GET /api/agent", run: get("/api/agent") },
  { name: "GET /api/projects/{id}/agent", run: get((world) => `/api/projects/${world.seed.small}/agent`) },
  { name: "POST agent (empty)", run: post((world) => `/api/projects/${world.seed.small}/agent`, { text: "" }) },
  { name: "POST agent/stop", run: post((world) => `/api/projects/${world.seed.small}/agent/stop`) },
  { name: "POST agent/reset", run: post((world) => `/api/projects/${world.seed.small}/agent/reset`) },
  {
    name: "GET /api/agent/models",
    run: async (side) => {
      const reply = await side.http("GET", "/api/agent/models");
      return { status: reply.status };
    },
    calls: false,
  },
  {
    name: "POST /api/research (collect: the web isn't reached)",
    run: post((world) => `/api/projects/${world.seed.reference}/research`, { queries: [], per_query: 2 }),
  },

  // Media drive, then the end of a project's life.
  {
    name: "POST /api/media-drive (set, then off)",
    run: async (side, world) => {
      const folder = nodePath.join(world.dir, `drive-${side.name}`);
      fs.mkdirSync(folder, { recursive: true });
      const set = shown(await side.http("POST", "/api/media-drive", { dir: folder }));
      const shownDrive = shown(await side.http("GET", "/api/media-drive"));
      const off = shown(await side.http("POST", "/api/media-drive", { dir: null }));
      return { set, shownDrive, off };
    },
  },
  { name: "DELETE the new project", run: async (side) => shown(await side.http("DELETE", `/api/projects/${created(side)}`)), settle: 3000 },
  { name: "DELETE (missing)", run: async (side) => shown(await side.http("DELETE", "/api/projects/p0-0")) },
  { name: "GET /api/projects (at the end)", run: get("/api/projects") },
];
