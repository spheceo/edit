// The team's own notes on an edit, left in Edit at the playhead (Sphe, Nov 2:
// "where ever you are in the timeline will be the timestamp for that"; "you
// press a button before send just to que it up and you can see it qued up in
// line a row just above the composer"). Each is pinned to the frame it was
// written at, the clip under the playhead then (the topmost footage) and how
// far into its footage, with the box drawn on the picture if there is one, so
// it still finds its moment after the edit moves. Kept in mamagi
// (`edit:*Note*`, through the relay, which stamps who left it), never on the
// review: "in app feedback and feedback-feedback are different". Queued until
// the next message to the agent — they ride it whether or not it asks for
// them (Sphe, Nov 3: "implement the feedback" isn't needed to send them;
// pull_feedback still takes them with the review's), sent while it works,
// then done (its fix: what changed
// where, as a review note's) or left (why); a sent note the turn never
// answered goes back in the queue when the turn ends.

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";
import { ApiError } from "./http/errors.ts";
import { readJson, type Router } from "./http/router.ts";
import type { Clip, Project } from "./model.ts";
import { clipEnd, fps as fpsOf, inOut, mediaOf } from "./project.ts";
import { onScreen } from "./review.ts";
import { fixed } from "./rust.ts";
import * as seams from "./seams.ts";
import { stableStringify } from "./stable.ts";

/** A note's id as the agent is given it: Repack's notes have bare ids, these this mark. */
export const PREFIX = "app:";

export interface AppNote {
  id: string;
  projectId: string;
  text: string;
  frame: number;
  endFrame: number | null;
  fps: number;
  clipId: string | null;
  source: string | null;
  sourceMs: number | null;
  box: { x: number; y: number; w: number; h: number } | null;
  status: "queued" | "sent" | "done" | "left";
  fix: { summary: string; clips: string[]; ranges: number[][] } | null;
  reason: string | null;
  at: number;
  updatedAt: number;
  by: { sub: string; name: string; picture: string | null } | null;
}

/** The note with where it is on the timeline now (its clip moved, its frame with it). */
export type Placed = AppNote & { now: number; nowEnd: number | null };

/** The footage under `frame` that's on top (the highest video track's), or null. */
export function footageAt(project: Project, frame: number): Extract<Clip, { type: "video" }> | null {
  const order = new Map(project.tracks.map((track, index) => [track.id, index]));
  const hidden = new Set(project.tracks.filter((track) => track.hidden).map((track) => track.id));
  let top: Extract<Clip, { type: "video" }> | null = null;
  for (const clip of project.clips) {
    if (clip.type !== "video" || hidden.has(clip.track) || frame < clip.start || frame >= clipEnd(clip)) continue;
    if (top === null || (order.get(clip.track) ?? 0) > (order.get(top.track) ?? 0)) top = clip;
  }
  return top;
}

/** Where a note at `frame` is pinned: the clip there and how far into its footage (ms). */
export function pinAt(project: Project, frame: number): { clipId?: string; source?: string; sourceMs?: number } {
  const clip = footageAt(project, frame);
  if (clip === null) return {};
  const fps = fpsOf(project);
  const seconds = clip.source_in + ((frame - clip.start) / fps) * clip.speed;
  return { clipId: clip.id, source: mediaOf(project, clip.media)?.name ?? clip.media, sourceMs: Math.max(0, Math.round(seconds * 1000)) };
}

/** A note's frame on the timeline now: its clip's, while that clip still shows that moment of its footage; else the frame it was written at. */
export function frameNow(project: Project, note: Pick<AppNote, "frame" | "clipId" | "sourceMs">): number {
  if (note.clipId === null || note.sourceMs === null) return note.frame;
  const clip = project.clips.find((one) => one.id === note.clipId);
  if (clip === undefined || clip.type !== "video") return note.frame;
  const fps = fpsOf(project);
  const at = clip.start + Math.round(((note.sourceMs / 1000 - clip.source_in) / clip.speed) * fps);
  return at >= clip.start && at < clipEnd(clip) ? at : note.frame;
}

function placed(project: Project | null, note: AppNote): Placed {
  if (project === null) return { ...note, now: note.frame, nowEnd: note.endFrame };
  const now = frameNow(project, note);
  return { ...note, now, nowEnd: note.endFrame === null ? null : now + (note.endFrame - note.frame) };
}

function need(): void {
  if (!cloud.enabled()) throw new Error("notes on an edit need Edit's cloud: sign in first");
}

function changed(app: App, projectId: string): void {
  app.store.emit({ type: "notes", id: projectId });
}

export async function list(app: App, projectId: string): Promise<Placed[]> {
  need();
  const rows = (await cloud.query("edit:listNotes", { projectId })) as AppNote[] | null;
  const live = app.store.get(projectId);
  return (rows ?? []).map((note) => placed(live?.project ?? null, note));
}

/**
 * Leaves a note at `frame` (and to `endFrame`: the In–Out span when one is
 * set and the playhead is in it), pinned to the footage there.
 */
export async function add(app: App, projectId: string, given: { text: string; frame: number; endFrame?: number | null; box?: AppNote["box"] }): Promise<Placed> {
  need();
  const live = app.store.get(projectId);
  if (live === null) throw new Error("no such project");
  const text = given.text.trim();
  if (text === "") throw new Error("a note needs words");
  const frame = Math.max(0, Math.round(given.frame));
  const endFrame = given.endFrame === null || given.endFrame === undefined ? undefined : Math.round(given.endFrame);
  const row = (await cloud.mutation("edit:addNote", {
    projectId,
    text,
    frame,
    ...(endFrame !== undefined && endFrame > frame ? { endFrame } : {}),
    fps: fpsOf(live.project),
    ...pinAt(live.project, frame),
    ...(given.box ? { box: given.box } : {}),
  })) as AppNote;
  changed(app, projectId);
  return placed(live.project, row);
}

export async function edit(app: App, projectId: string, id: string, text: string): Promise<Placed> {
  need();
  const row = (await cloud.mutation("edit:editNote", { projectId, id, text })) as AppNote;
  changed(app, projectId);
  return placed(app.store.get(projectId)?.project ?? null, row);
}

export async function remove(app: App, projectId: string, id: string): Promise<void> {
  need();
  await cloud.mutation("edit:removeNote", { projectId, id });
  changed(app, projectId);
}

/** The project's queued notes, sent to the agent now (with `again`, the ones it left before too). */
export async function take(app: App, projectId: string, again = false): Promise<AppNote[]> {
  need();
  if (again) {
    const left = ((await cloud.query("edit:listNotes", { projectId })) as AppNote[]).filter((note) => note.status === "left");
    for (const note of left) await cloud.mutation("edit:resolveNote", { projectId, id: note.id, status: "queued" });
  }
  const sent = ((await cloud.mutation("edit:sendNotes", { projectId })) as AppNote[] | null) ?? [];
  if (sent.length > 0) changed(app, projectId);
  return sent;
}

/** The id the agent was given, as mamagi has it (or null: not one of these). */
export function idOf(given: string): string | null {
  const id = given.trim().replace(/^\[|\]$/g, "");
  return id.startsWith(PREFIX) ? id.slice(PREFIX.length) : null;
}

export async function done(app: App, projectId: string, id: string, fix: { summary: string; clips: string[]; ranges: [number, number][] }): Promise<void> {
  need();
  await cloud.mutation("edit:resolveNote", { projectId, id, status: "done", summary: fix.summary, clips: fix.clips.slice(0, 500), ranges: fix.ranges.slice(0, 200) });
  changed(app, projectId);
}

export async function left(app: App, projectId: string, id: string, reason: string): Promise<void> {
  need();
  await cloud.mutation("edit:resolveNote", { projectId, id, status: "left", reason });
  changed(app, projectId);
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** One line per note: its [app:id], its moment now, the clip there and the box. */
function lines(project: Project, notes: AppNote[]): string {
  const fps = fpsOf(project);
  const { width, height } = project.settings;
  return notes
    .map((note) => placed(project, note))
    .sort((a, b) => a.now - b.now || a.at - b.at)
    .map((note) => {
      const said: string[] = [];
      const span = note.nowEnd === null ? `${clock(note.now / fps)}` : `${clock(note.now / fps)}–${clock(note.nowEnd / fps)}`;
      const timeline = `timeline ${fixed(note.now / fps, 2)}s${note.nowEnd === null ? "" : `–${fixed(note.nowEnd / fps, 2)}s`}, frame ${note.now}${note.now === note.frame ? "" : ` (written at frame ${note.frame}; the edit moved since)`}`;
      said.push(`there: ${onScreen(project, note.now).slice(0, 4).join("; ")}`);
      if (note.clipId !== null) {
        const still = project.clips.some((clip) => clip.id === note.clipId);
        said.push(still ? `on clip ${note.clipId}${note.source === null ? "" : ` (${note.source}${note.sourceMs === null ? "" : ` @${fixed(note.sourceMs / 1000, 2)}s`})`}` : `on clip ${note.clipId}${note.source === null ? "" : ` (${note.source})`}, gone from the edit since`);
      }
      if (note.box !== null) {
        const box = note.box;
        said.push(`the area they boxed: centre ${Math.round((box.x + box.w / 2 - 0.5) * width)}, ${Math.round((box.y + box.h / 2 - 0.5) * height)} px from the frame's centre, ${Math.round(box.w * width)}×${Math.round(box.h * height)} px`);
      }
      return `- [${PREFIX}${note.id}] at ${span} (${timeline}; ${said.join("; ")}): ${note.by?.name ?? "the team"}: ${JSON.stringify(note.text.replace(/\s+/gu, " ").trim())}`;
    })
    .join("\n");
}

const FIX = 'Load the feedback skill and fix them across the video, as you would a review\'s; after each, feedback_done {note: "<its id, app: and all>", summary}, or feedback_unfixed {note, reason}; a question gets feedback_answer {note, answer}.';

/** The agent's message for the team's own notes: each with its [app:id], its moment now, the clip there and the box. */
export function message(project: Project, notes: AppNote[]): string {
  return `The team's own notes, left in Edit at these moments: ${notes.length} note${notes.length === 1 ? "" : "s"}. ${FIX}\n${lines(project, notes)}`;
}

/**
 * The team's queued notes, attached to a message of whatever it says (Sphe,
 * Nov 3: they go on the next message; "implement the feedback" isn't needed to
 * send them): if the message asks for them, the feedback skill's fix; if not,
 * the agent says it sees them and asks, and leaves them alone.
 */
export function context(project: Project, notes: AppNote[]): string {
  return (
    `The team's own notes, left in Edit at these moments (${notes.length}). ` +
    `If their message asks to implement the feedback, ${FIX.charAt(0).toLowerCase()}${FIX.slice(1)} ` +
    `If it doesn't, say you see them and ask whether to implement them; don't fix them unasked.\n${lines(project, notes)}`
  );
}

/** How often a turn is looked at to see it ended. */
let followMs = 5_000;
/** Tests: look at the turn this often. */
export function followEveryForTests(ms: number): void {
  followMs = ms;
}
const LONGEST_MS = 3 * 60 * 60_000;

/** When the turn on `projectId` ends, the notes it was sent and didn't answer go back in the queue (said once, not lost). */
export async function requeueAfterTurn(app: App, projectId: string, ids: string[]): Promise<void> {
  const panel = seams.agentPanel(app);
  const began = Date.now();
  let quiet = 0;
  while (Date.now() - began < LONGEST_MS) {
    await new Promise((resolve) => setTimeout(resolve, followMs));
    quiet = (panel.turn?.(projectId) ?? (panel.chat(projectId) as { running?: boolean })).running === true ? 0 : quiet + 1;
    if (quiet >= 2) break;
  }
  const rows = ((await cloud.query("edit:listNotes", { projectId })) as AppNote[]).filter((note) => ids.includes(note.id) && note.status === "sent");
  for (const note of rows) await cloud.mutation("edit:resolveNote", { projectId, id: note.id, status: "queued" });
  if (rows.length > 0) {
    diag.info("notes", `${projectId}: ${rows.length} note(s) the agent didn't answer went back in the queue`);
    changed(app, projectId);
  }
}

// ---------------------------------------------------------------------------
// Routes

function sorted(value: unknown, status = 200): Response {
  return new Response(stableStringify(value), { status, headers: { "content-type": "application/json" } });
}

const asBox = (value: unknown): AppNote["box"] => {
  if (typeof value !== "object" || value === null) return null;
  const { x, y, w, h } = value as Record<string, unknown>;
  return [x, y, w, h].every((part) => typeof part === "number" && Number.isFinite(part)) ? { x: x as number, y: y as number, w: w as number, h: h as number } : null;
};

async function answered(work: () => Promise<unknown>): Promise<Response> {
  try {
    return sorted(await work());
  } catch (error) {
    throw new ApiError(400, diag.messageOf(error));
  }
}

export function routes(router: Router<App>): void {
  router.get("/api/projects/{id}/notes", ({ app, params }) => answered(() => list(app, params.id ?? "")));
  // {text, frame, end_frame?, box?}; without end_frame, the In–Out span when the frame is in it.
  router.post("/api/projects/{id}/notes", async (context) => {
    const given = (await readJson<unknown>(context).catch(() => ({}))) as Record<string, unknown>;
    const id = context.params.id ?? "";
    const live = context.app.store.get(id);
    if (live === null) throw new ApiError(404, "no such project");
    const frame = typeof given.frame === "number" && Number.isFinite(given.frame) ? given.frame : NaN;
    if (Number.isNaN(frame)) throw new ApiError(400, "frame (a number) is required");
    let endFrame = typeof given.end_frame === "number" && Number.isFinite(given.end_frame) ? given.end_frame : null;
    const span = inOut(live.project);
    if (endFrame === null && given.end_frame === undefined && span !== null && frame >= span[0] && frame < span[1]) endFrame = span[1];
    const box = asBox(given.box);
    return answered(() => add(context.app, id, { text: typeof given.text === "string" ? given.text : "", frame: span !== null && endFrame === span[1] ? span[0] : frame, endFrame, box }));
  });
  router.put("/api/projects/{id}/notes/{note}", async (context) => {
    const given = (await readJson<unknown>(context).catch(() => ({}))) as Record<string, unknown>;
    return answered(() => edit(context.app, context.params.id ?? "", context.params.note ?? "", typeof given.text === "string" ? given.text : ""));
  });
  router.delete("/api/projects/{id}/notes/{note}", ({ app, params }) => answered(async () => {
    await remove(app, params.id ?? "", params.note ?? "");
    return { removed: true };
  }));
}
