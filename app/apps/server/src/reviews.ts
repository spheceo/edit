// Repack reviews of an edit (docs/plans/2026-10-22-share-review-handoff.md):
// an export shared to a Repack link, where anyone with it comments at a
// moment of the video (as on Frame.io, which it replaces); the notes followed
// here while Edit runs; the agent set on them by itself two minutes after a
// reviewer's last note; and each fix's changed stretch of the timeline kept
// with its note, so the timeline shows what the agent changed for whom and
// why ("did the agent actually do what we said we wanted it to do?").
//
// Repack's Convex has the reviews (`reviews:*`, through the relay, which
// makes every call Edit's). This machine keeps `<home>/reviews.json`: each
// shared project's review and versions (with the clips each export had where,
// so a note's moment on an old export still finds its clip after later
// edits), every note heard, and the fixes made here. The review copy (720p,
// ~3 Mbit/s) and the clip map go to R2 under `edit/reviews/<project>/<export>/`.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";
import { ApiError } from "./http/errors.ts";
import { readJson, type Router } from "./http/router.ts";
import { clipMap, deleteExport, listExports, mapFile, timelineHash } from "./exports.ts";
import { writeAtomic } from "./files.ts";
import { registerTool, text, type ToolCall } from "./mcp/registry.ts";
import type { Clip, Project } from "./model.ts";
import { join } from "./paths.ts";
import { clipEnd, fps as fpsOf } from "./project.ts";
import { onScreen } from "./review.ts";
import { fixed } from "./rust.ts";
import * as seams from "./seams.ts";
import { stableStringify } from "./stable.ts";
import * as tools from "./tools.ts";

const FILE = "reviews.json";
/** How often Repack is asked for new notes while Edit runs. */
export const POLL_MS = 45_000;
/** A reviewer's notes are fixed together: this long after the last one. */
export const SETTLE_MS = 120_000;
/** A note claimed this long ago and never resolved may be tried again. */
const RETRY_MS = 30 * 60_000;
/** Changed stretches closer than this (frames: a second) are one band. */
const JOIN_SECONDS = 1;

/** A note on a review, as Repack has it, and what was done here about it. */
export interface Note {
  id: string;
  reviewId: string;
  /** The project it's on (the review's source). */
  project: string;
  version: number;
  /** Its moment on that version's export (ms), and its end when it covers a stretch. */
  ms: number | null;
  endMs: number | null;
  text: string;
  author: string;
  status: "open" | "done";
  parentId: string | null;
  /** Written by an app (the agent's own replies), not a reviewer. */
  fromApp?: boolean;
  createdAt: number;
  updatedAt: number;
  /** When the agent here was set on it. */
  claimed?: number;
  /** The agent's fix: what it changed (clip ids, and their stretch then) and its words. */
  fix?: { clips: string[]; ranges: [number, number][]; summary: string; at: number };
  /** Why the agent left it. */
  unfixed?: string;
}

/** One shared export. */
export interface Version {
  n: number;
  timeline: string;
  path: string;
  fps: number;
  durationMs: number;
  /** The export's picture clips: [id, start, duration] (frames). */
  clips: [string, number, number][];
}

export interface Shared {
  reviewId: string;
  url: string;
  versions: Version[];
  /** Approved: which version, by whom, when (the other versions' files deleted). */
  approved?: { version: number; by: string; at: number } | null;
}

interface State {
  /** Repack's place in its notes' changes: the next look asks from here. */
  cursor: number;
  /** Fix new feedback by itself (on unless turned off). */
  autoFix: boolean;
  shared: Record<string, Shared>;
  notes: Record<string, Note>;
}

function empty(): State {
  return { cursor: 0, autoFix: true, shared: {}, notes: {} };
}

export function read(home: string): State {
  try {
    const raw = JSON.parse(fs.readFileSync(join(home, FILE), "utf8")) as Partial<State>;
    return { ...empty(), ...raw, shared: raw.shared ?? {}, notes: raw.notes ?? {} };
  } catch {
    return empty();
  }
}

function write(home: string, state: State): void {
  writeAtomic(join(home, FILE), JSON.stringify(state));
}

/** Changes the saved state (read, change, write: one at a time in this process). */
function update<T>(home: string, change: (state: State) => T): T {
  const state = read(home);
  const out = change(state);
  write(home, state);
  return out;
}

// ---------------------------------------------------------------------------
// Sharing

/** Shares in progress (project id → what it's doing), for the UI. */
const sharing = new Map<string, string>();

/**
 * Shares one of `project`'s whole exports for review: a 720p copy and a
 * poster to R2, then Repack's review (made the first time, a new version
 * under the same link after). Returns the link and the version.
 */
export async function share(app: App, projectId: string, path: string | null): Promise<{ url: string; version: number }> {
  if (!cloud.enabled()) throw new Error("sharing needs Edit's cloud (the relay token)");
  const live = app.store.get(projectId);
  if (live === null) throw new Error("no such project");
  const home = app.store.home;
  const exported = listExports(home, projectId).filter((one) => one.whole && !one.missing);
  const chosen = path === null ? exported[0] : exported.find((one) => one.path === path);
  if (chosen === undefined) throw new Error(path === null ? "export the whole edit first: a review shares an export" : "that isn't one of this project's whole exports");
  if (sharing.has(projectId)) throw new Error("this project is already being shared");
  const timeline = chosen.timeline ?? timelineHash(live.project);
  let clips: [string, number, number][];
  try {
    clips = JSON.parse(fs.readFileSync(mapFile(home, timeline), "utf8")) as [string, number, number][];
  } catch {
    // An export from before the maps were kept: the project as it is now (right while it hasn't changed since).
    clips = clipMap(live.project);
  }
  const fps = fpsOf(live.project);
  const work = join(home, "cache", "reviews", projectId);
  fs.mkdirSync(work, { recursive: true });
  const copy = join(work, `${timeline}.mp4`);
  const poster = join(work, `${timeline}.jpg`);
  sharing.set(projectId, "making the review copy");
  try {
    if (!fs.existsSync(copy)) await reviewCopy(chosen.path, copy);
    const seconds = chosen.frames / fps;
    await tools.run([tools.ffmpeg(), "-v", "error", "-nostdin", "-y", "-ss", fixed(Math.min(5, seconds / 2), 2), "-i", chosen.path, "-frames:v", "1", "-vf", "scale=1280:-2", poster]);
    const prefix = `edit/reviews/${projectId}/${timeline}`;
    sharing.set(projectId, "uploading");
    await cloud.uploadFile(copy, `${prefix}/video.mp4`, (done, total) => sharing.set(projectId, `uploading ${total ? Math.round((done / total) * 100) : 0}%`));
    await cloud.uploadFile(poster, `${prefix}/poster.jpg`);
    sharing.set(projectId, "publishing");
    const durationMs = Math.round((chosen.frames / fps) * 1000);
    const answer = (await cloud.mutation("reviews:publish", {
      sourceId: projectId,
      title: live.project.name,
      kind: "video",
      key: `${prefix}/video.mp4`,
      meta: { fps, durationMs, timeline },
      posterKey: `${prefix}/poster.jpg`,
      by: app.machine,
    })) as { reviewId: string; url: string; version: number };
    update(home, (state) => {
      const was = state.shared[projectId];
      const versions = (was?.reviewId === answer.reviewId ? was.versions : []).filter((one) => one.n !== answer.version);
      versions.push({ n: answer.version, timeline, path: chosen.path, fps, durationMs, clips });
      state.shared[projectId] = { reviewId: answer.reviewId, url: answer.url, versions };
    });
    fs.rmSync(copy, { force: true });
    diag.info("review", `${live.project.name}: shared v${answer.version} at ${answer.url}`);
    return { url: answer.url, version: answer.version };
  } finally {
    sharing.delete(projectId);
  }
}

/** A review copy of an export: 720p H.264 at ~3 Mbit/s on Video Toolbox (a 30-minute edit in a minute or two), x264 without it. */
async function reviewCopy(source: string, dest: string): Promise<void> {
  const partial = `${dest}.partial.mp4`;
  const common = ["-v", "error", "-nostdin", "-y", "-i", source, "-vf", "scale=-2:720", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"];
  try {
    await tools.run([tools.ffmpeg(), ...common, "-c:v", "h264_videotoolbox", "-b:v", "3M", partial]);
  } catch {
    await tools.run([tools.ffmpeg(), ...common, "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", partial]);
  }
  fs.renameSync(partial, dest);
}

// ---------------------------------------------------------------------------
// Notes: heard, placed on the timeline, fixed

/** A note's frame on the timeline now: its moment's clip on that export, wherever the clip is now. */
export function frameNow(project: Project, version: Version | undefined, ms: number): number {
  const fps = fpsOf(project);
  const at = Math.round((ms / 1000) * (version?.fps ?? fps));
  if (version === undefined) return at;
  // The topmost picture there on the export (the last listed of those under it).
  const under = version.clips.filter(([, start, duration]) => start <= at && at < start + duration);
  for (const [id, start] of under.reverse()) {
    const clip = project.clips.find((one) => one.id === id);
    if (clip !== undefined) return clip.start + (at - start);
  }
  return at;
}

/**
 * Notes heard from Repack (`reviews:changes`): kept, and the projects with
 * new open ones to fix: a note not heard before, or one a reviewer opened
 * again ("Not fixed"), which is tried again from the start.
 */
export function heard(state: State, given: unknown[], projects: Set<string>): string[] {
  const fresh = new Set<string>();
  for (const raw of given) {
    if (typeof raw !== "object" || raw === null) continue;
    const one = raw as Record<string, unknown>;
    const id = typeof one.noteId === "string" ? one.noteId : typeof one.id === "string" ? one.id : null;
    const project = typeof one.sourceId === "string" ? one.sourceId : null;
    if (id === null || project === null) continue;
    // Deleted by the guest who wrote it (its replies with it): gone here too.
    if (one.deleted === true) {
      delete state.notes[id];
      continue;
    }
    const anchor = (one.anchor ?? {}) as Record<string, unknown>;
    const was = state.notes[id];
    const status = one.status === "done" ? "done" : "open";
    const reopened = was !== undefined && was.status === "done" && status === "open";
    const note: Note = {
      ...(reopened ? { ...was, fix: undefined, unfixed: undefined, claimed: undefined } : was),
      id,
      reviewId: String(one.reviewId ?? was?.reviewId ?? ""),
      project,
      version: typeof one.version === "number" ? one.version : (was?.version ?? 1),
      ms: anchor.kind === "time" && typeof anchor.ms === "number" ? anchor.ms : null,
      endMs: anchor.kind === "time" && typeof anchor.endMs === "number" ? anchor.endMs : null,
      text: String(one.text ?? ""),
      author: String(one.author ?? "someone"),
      status,
      parentId: typeof one.parentId === "string" ? one.parentId : null,
      fromApp: one.fromApp === true,
      createdAt: typeof one.createdAt === "number" ? one.createdAt : Date.now(),
      updatedAt: typeof one.updatedAt === "number" ? one.updatedAt : Date.now(),
    };
    if (note.fix === undefined) delete note.fix;
    if (note.unfixed === undefined) delete note.unfixed;
    if (note.claimed === undefined) delete note.claimed;
    state.notes[id] = note;
    if (note.parentId === null && note.status === "open" && (was === undefined || reopened) && projects.has(project)) fresh.add(project);
  }
  return [...fresh];
}

/** The open notes of a project not yet tried here (or tried long ago and never resolved). */
export function waiting(state: State, project: string, now: number): Note[] {
  return Object.values(state.notes)
    .filter((note) => note.project === project && note.parentId === null && note.status === "open" && note.unfixed === undefined && note.fix === undefined)
    .filter((note) => note.claimed === undefined || now - note.claimed > RETRY_MS)
    .sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0) || a.createdAt - b.createdAt);
}

/** The message that sets the agent on a project's notes. */
export function fixMessage(project: Project, shared: Shared | undefined, notes: Note[], replies: Note[] = []): string {
  const fps = fpsOf(project);
  const lines = notes.map((note) => {
    // What the team said under it since (a "not fixed", more detail), not the agent's own replies.
    const under = replies
      .filter((reply) => reply.parentId === note.id && reply.fromApp !== true)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((reply) => `\n    ${reply.author} replied: "${reply.text}"`)
      .join("");
    const version = shared?.versions.find((one) => one.n === note.version);
    let where = "";
    if (note.ms !== null) {
      const frame = frameNow(project, version, note.ms);
      const end = note.endMs === null ? null : frameNow(project, version, note.endMs);
      const shown = onScreen(project, frame).slice(0, 4).join("; ");
      where = ` at ${clock(note.ms / 1000)}${note.endMs === null ? "" : `–${clock(note.endMs / 1000)}`} of v${note.version} (timeline ${fixed(frame / fps, 2)}s${end === null ? "" : `–${fixed(end / fps, 2)}s`}, frame ${frame}; there: ${shown})`;
    }
    return `- [${note.id}]${where}: ${note.author}: "${note.text}"${under}`;
  });
  return (
    `(Edit, automatically) New feedback on this edit's review${shared === undefined ? "" : ` (${shared.url})`}: ${notes.length} note${notes.length === 1 ? "" : "s"}. ` +
    "Load the feedback skill and fix them across the video, the team's words being what they want. " +
    'After each note, call feedback_done {note: "<its id>", summary: "<one line: what you changed>"}; for one you can\'t or shouldn\'t do, feedback_unfixed {note, reason}. ' +
    "Then mute_house_words once if subtitles changed, and finish with a line per note.\n" +
    lines.join("\n")
  );
}

function clock(seconds: number): string {
  const whole = Math.max(Math.floor(seconds), 0);
  const tenths = Math.floor((seconds - whole) * 10);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}.${tenths}`;
}

/**
 * What changed between two versions of a project, as clip ids and merged
 * stretches (frames): clips added, removed, or changed in anything but where
 * they start (a ripple that only moves the rest along isn't a change).
 */
export function changes(before: Project, after: Project): { clips: string[]; ranges: [number, number][] } {
  const was = new Map(before.clips.map((clip) => [clip.id, clip]));
  const now = new Map(after.clips.map((clip) => [clip.id, clip]));
  const same = (a: Clip, b: Clip) => JSON.stringify({ ...a, start: 0 }) === JSON.stringify({ ...b, start: 0 });
  const touched: Clip[] = [];
  const ids: string[] = [];
  for (const [id, clip] of now) {
    const old = was.get(id);
    if (old === undefined || !same(old, clip)) {
      touched.push(clip);
      ids.push(id);
    }
  }
  for (const [id, clip] of was) if (!now.has(id)) touched.push(clip);
  const join = Math.round(JOIN_SECONDS * fpsOf(after));
  const spans = touched.map((clip): [number, number] => [clip.start, clipEnd(clip)]).sort((a, b) => a[0] - b[0]);
  const ranges: [number, number][] = [];
  for (const span of spans) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && span[0] <= last[1] + join) last[1] = Math.max(last[1], span[1]);
    else ranges.push([...span]);
  }
  return { clips: ids, ranges };
}

/** The project as it was when the agent began each project's current note (its fix is the difference). */
const checkpoints = new Map<string, Project>();

/** Records the agent's fix of a note: what changed since the last one, kept here and sent to Repack. */
export async function done(app: App, projectId: string, noteId: string, summary: string): Promise<Note["fix"]> {
  const live = app.store.get(projectId);
  if (live === null) throw new Error("no such project");
  const home = app.store.home;
  const state = read(home);
  const note = state.notes[noteId];
  if (note === undefined || note.project !== projectId) throw new Error(`no note ${noteId} on this project's review`);
  const before = checkpoints.get(projectId) ?? live.project;
  const changed = changes(before, live.project);
  checkpoints.set(projectId, structuredClone(live.project));
  const fix = { ...changed, summary, at: Date.now() };
  update(home, (saved) => {
    const own = saved.notes[noteId];
    if (own !== undefined) {
      own.fix = fix;
      own.status = "done";
    }
  });
  const fps = fpsOf(live.project);
  const latest = state.shared[projectId]?.versions.reduce((most, one) => Math.max(most, one.n), 0) ?? note.version;
  await cloud.mutation("reviews:resolve", {
    noteId,
    version: latest + 1,
    changedRanges: changed.ranges.map(([start, end]) => ({ startMs: Math.round((start / fps) * 1000), endMs: Math.round((end / fps) * 1000) })),
    fixSummary: summary,
  });
  return fix;
}

/** Records a note the agent left, with why (a reply on the review; the note stays open for the team). */
export async function unfixed(app: App, projectId: string, noteId: string, reason: string): Promise<void> {
  const home = app.store.home;
  const note = read(home).notes[noteId];
  if (note === undefined || note.project !== projectId) throw new Error(`no note ${noteId} on this project's review`);
  update(home, (saved) => {
    const own = saved.notes[noteId];
    if (own !== undefined) own.unfixed = reason;
  });
  const live = app.store.get(projectId);
  if (live !== null) checkpoints.set(projectId, structuredClone(live.project));
  await cloud.mutation("reviews:reply", { noteId, text: `Not changed: ${reason}`, author: "Edit's agent" });
}

// ---------------------------------------------------------------------------
// Approval: the version the team signed off, the others' files deleted

/**
 * Approves the project's latest shared version: Repack closes the review to
 * new notes and deletes the other versions' files on R2 (their notes stay,
 * the record of every round), and the exports here shared as those versions
 * are deleted (where most of the space is).
 */
export async function approve(app: App, projectId: string): Promise<{ version: number; deleted: string[] }> {
  const shared = read(app.store.home).shared[projectId];
  if (shared === undefined || shared.versions.length === 0) throw new Error("this project hasn't been shared for review");
  const version = Math.max(...shared.versions.map((one) => one.n));
  const answer = (await cloud.mutation("reviews:approve", { sourceId: projectId, version, by: app.machine })) as { approved: NonNullable<Shared["approved"]> };
  update(app.store.home, (state) => {
    if (state.shared[projectId] !== undefined) state.shared[projectId]!.approved = answer.approved;
  });
  return { version, deleted: clearOthers(app, projectId, version) };
}

/** Deletes the exports shared as versions other than `kept` (never the one it is), and the review copies here. */
export function clearOthers(app: App, projectId: string, kept: number): string[] {
  const home = app.store.home;
  const shared = read(home).shared[projectId];
  if (shared === undefined) return [];
  const keep = shared.versions.find((one) => one.n === kept)?.path ?? null;
  const deleted: string[] = [];
  for (const one of shared.versions) {
    if (one.n === kept || one.path === keep) continue;
    try {
      deleteExport(home, projectId, one.path);
      deleted.push(one.path);
    } catch (error) {
      // Gone already, or not on this Mac's list.
      diag.info("review", `v${one.n}'s export ${one.path}: ${diag.messageOf(error)}`);
    }
  }
  // The versions stay listed here (their clip maps still place their notes); only their files go.
  fs.rmSync(join(home, "cache", "reviews", projectId), { recursive: true, force: true });
  if (deleted.length > 0) diag.info("review", `${projectId}: v${kept} approved; deleted ${deleted.length} older export(s)`);
  return deleted;
}

// ---------------------------------------------------------------------------
// Following Repack while Edit runs

let timer: ReturnType<typeof setInterval> | null = null;
/** When each project's newest open note was heard here. */
const lastHeard = new Map<string, number>();

/** Starts following the reviews (with the cloud on): every POLL_MS, and fixes settled notes. */
export function start(app: App): void {
  if (timer !== null || !cloud.enabled()) return;
  const tick = () => {
    void poll(app).catch((error: unknown) => diag.warn("review", `following the reviews: ${diag.messageOf(error)}`));
  };
  timer = setInterval(tick, POLL_MS);
  timer.unref?.();
  setTimeout(tick, 5_000).unref?.();
}

export function stop(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}

/** One look at Repack: new notes kept; projects whose notes have settled get the agent. */
export async function poll(app: App, now = Date.now()): Promise<void> {
  const home = app.store.home;
  const projects = new Set(app.store.list().map((summary) => summary.id));
  const fresh = new Set<string>();
  // Page by page from where the last look ended.
  for (let page = 0; page < 20; page++) {
    const cursor = read(home).cursor;
    const answer = (await cloud.query("reviews:changes", { cursor })) as { notes?: unknown[]; cursor?: number; more?: boolean };
    update(home, (state) => {
      for (const project of heard(state, answer.notes ?? [], projects)) fresh.add(project);
      if (typeof answer.cursor === "number") state.cursor = answer.cursor;
    });
    if (answer.more !== true) break;
  }
  for (const project of fresh) lastHeard.set(project, now);
  if (fresh.size > 0) app.store.emit({ type: "reviews", projects: [...fresh] });
  // Approvals (on Repack's page or another Mac): the other versions' exports here go too.
  const rows = (await cloud.query("reviews:open", {})) as { sourceId?: string; approved?: Shared["approved"] }[];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row.sourceId !== "string") continue;
    const was = read(home).shared[row.sourceId];
    if (was === undefined) continue;
    const approved = row.approved ?? null;
    if ((was.approved?.version ?? null) === (approved?.version ?? null)) continue;
    update(home, (state) => {
      if (state.shared[row.sourceId!] !== undefined) state.shared[row.sourceId!]!.approved = approved;
    });
    if (approved !== null) clearOthers(app, row.sourceId, approved.version);
  }
  await fixSettled(app, now);
}

/** Sets the agent on each project whose open notes have settled, one project's turn at a time. */
export async function fixSettled(app: App, now = Date.now()): Promise<string[]> {
  const home = app.store.home;
  const state = read(home);
  if (!state.autoFix) return [];
  const started: string[] = [];
  const projects = new Set(Object.values(state.notes).map((note) => note.project));
  for (const project of projects) {
    const live = app.store.get(project);
    if (live === null) continue;
    // Approved: nothing more to fix.
    if (state.shared[project]?.approved) continue;
    const notes = waiting(state, project, now);
    if (notes.length === 0) continue;
    const newest = Math.max(...notes.map((note) => note.createdAt), lastHeard.get(project) ?? 0);
    if (now - newest < SETTLE_MS) continue;
    const chat = seams.agentPanel(app).chat(project) as { running?: boolean };
    if (chat.running === true) continue;
    // A cloud project another Mac holds is theirs to fix.
    try {
      await app.store.mayWrite(project);
    } catch {
      continue;
    }
    let claimed: string[];
    try {
      claimed = ((await cloud.mutation("reviews:claim", { noteIds: notes.map((note) => note.id), by: app.machine })) as { claimed?: string[] }).claimed ?? [];
    } catch (error) {
      diag.warn("review", `claiming ${project}'s notes: ${diag.messageOf(error)}`);
      continue;
    }
    const mine = notes.filter((note) => claimed.includes(note.id));
    // Tried now: here, or by the Mac that claimed it first.
    update(home, (saved) => {
      for (const note of notes) if (saved.notes[note.id] !== undefined) saved.notes[note.id]!.claimed = now;
    });
    if (mine.length === 0) continue;
    checkpoints.set(project, structuredClone(live.project));
    try {
      const replies = Object.values(state.notes).filter((note) => note.project === project && note.parentId !== null);
      await seams.agentPanel(app).send(project, fixMessage(live.project, state.shared[project], mine, replies), null, null);
      started.push(project);
      diag.info("review", `${live.project.name}: the agent is fixing ${mine.length} note(s)`);
    } catch (error) {
      diag.warn("review", `starting ${project}'s fix: ${diag.messageOf(error)}`);
      await cloud.mutation("reviews:release", { noteIds: mine.map((note) => note.id), by: app.machine }).catch(() => {});
      update(home, (saved) => {
        for (const note of mine) if (saved.notes[note.id] !== undefined) delete saved.notes[note.id]!.claimed;
      });
    }
  }
  return started;
}

// ---------------------------------------------------------------------------
// What the UI shows

/** A project's review for the UI: its link, versions, and every note with its frame and its fix's stretches now. */
export function view(app: App, projectId: string): unknown {
  const live = app.store.get(projectId);
  const state = read(app.store.home);
  const shared = state.shared[projectId];
  const notes = Object.values(state.notes)
    .filter((note) => note.project === projectId)
    .sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0));
  return {
    sharing: sharing.get(projectId) ?? null,
    autoFix: state.autoFix,
    review: shared === undefined ? null : { url: shared.url, versions: shared.versions.map((one) => ({ n: one.n, path: one.path })), approved: shared.approved ?? null },
    notes: notes.map((note) => {
      const version = shared?.versions.find((one) => one.n === note.version);
      const frame = live === null || note.ms === null ? null : frameNow(live.project, version, note.ms);
      return {
        id: note.id,
        version: note.version,
        author: note.author,
        text: note.text,
        status: note.status,
        reply_to: note.parentId,
        frame,
        fix: note.fix === undefined ? null : { summary: note.fix.summary, ranges: live === null ? note.fix.ranges : bandsNow(live.project, note.fix) },
        unfixed: note.unfixed ?? null,
        fixing: note.claimed !== undefined && note.fix === undefined && note.unfixed === undefined,
      };
    }),
  };
}

/** A fix's stretches on the timeline now: its clips where they are (they move with later edits), else where they were. */
function bandsNow(project: Project, fix: NonNullable<Note["fix"]>): [number, number][] {
  const spans = fix.clips
    .map((id) => project.clips.find((clip) => clip.id === id))
    .filter((clip): clip is Clip => clip !== undefined)
    .map((clip): [number, number] => [clip.start, clipEnd(clip)])
    .sort((a, b) => a[0] - b[0]);
  if (spans.length === 0) return fix.ranges;
  const join = Math.round(JOIN_SECONDS * fpsOf(project));
  const out: [number, number][] = [];
  for (const span of spans) {
    const last = out[out.length - 1];
    if (last !== undefined && span[0] <= last[1] + join) last[1] = Math.max(last[1], span[1]);
    else out.push([...span]);
  }
  return out;
}

/** Per project: its open notes (for the home screen's badge). */
export function openCounts(home: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const note of Object.values(read(home).notes)) {
    if (note.status === "open" && note.parentId === null) out[note.project] = (out[note.project] ?? 0) + 1;
  }
  return out;
}

export function setAutoFix(home: string, on: boolean): void {
  update(home, (state) => {
    state.autoFix = on;
  });
}

// ---------------------------------------------------------------------------
// The agent's tools

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

registerTool("feedback_done", async ({ app, args, projectId }: ToolCall) => {
  const note = str(args.note);
  const summary = str(args.summary);
  if (note === null || summary === null) throw new Error("note (its id) and summary (one line: what you changed) are required");
  const fix = await done(app, projectId, note, summary);
  const fps = fpsOf(app.store.get(projectId)!.project);
  return text(
    stableStringify({
      note,
      changed: (fix?.ranges ?? []).map(([start, end]) => `${fixed(start / fps, 2)}–${fixed(end / fps, 2)}s`),
      clips: fix?.clips.length ?? 0,
      ...(fix !== undefined && fix.ranges.length === 0 ? { warning: "nothing changed since the last note: was it fixed?" } : {}),
    }),
  );
});

registerTool("feedback_unfixed", async ({ app, args, projectId }: ToolCall) => {
  const note = str(args.note);
  const reason = str(args.reason);
  if (note === null || reason === null) throw new Error("note (its id) and reason are required");
  await unfixed(app, projectId, note, reason);
  return text(`left ${note} open, saying why on the review`);
});

registerTool("share_for_review", async ({ app, args, projectId }: ToolCall) => {
  const shared = await share(app, projectId, str(args.path));
  return text(`shared v${shared.version}: ${shared.url}`);
});

// ---------------------------------------------------------------------------
// Routes

function sorted(value: unknown, status = 200): Response {
  return new Response(stableStringify(value), { status, headers: { "content-type": "application/json" } });
}

/** Each project's state for the home screen: open feedback, a finished edit, and whether its current timeline is exported. */
const statusCache = new Map<string, { rev: number; exportsAt: number; exported: boolean }>();

export function projectStatus(app: App): Record<string, { feedback: number; complete: boolean; exported: boolean; approved: number | null }> {
  const home = app.store.home;
  const open = openCounts(home);
  const shared = read(home).shared;
  const out: Record<string, { feedback: number; complete: boolean; exported: boolean; approved: number | null }> = {};
  for (const summary of app.store.list()) {
    if (summary.problem !== undefined) continue;
    const live = app.store.get(summary.id);
    if (live === null) continue;
    const listed = listExports(home, summary.id).filter((one) => one.whole && !one.missing);
    const newest = listed[0]?.finished_ms ?? 0;
    let cached = statusCache.get(summary.id);
    if (cached === undefined || cached.rev !== live.rev || cached.exportsAt !== newest) {
      const now = timelineHash(live.project);
      cached = { rev: live.rev, exportsAt: newest, exported: listed.some((one) => one.timeline === now) };
      statusCache.set(summary.id, cached);
    }
    out[summary.id] = { feedback: open[summary.id] ?? 0, complete: finished(app, summary.id), exported: cached.exported, approved: shared[summary.id]?.approved?.version ?? null };
  }
  return out;
}

/** A whole edit (or a round of feedback) has run to its end in the project's chat, and nothing is running now. */
function finished(app: App, project: string): boolean {
  let chat: { running?: boolean; entries?: { kind?: string; tool?: string; text?: string }[] };
  try {
    chat = seams.agentPanel(app).chat(project) as typeof chat;
  } catch {
    return false;
  }
  if (chat.running === true) return false;
  return (chat.entries ?? []).some((entry) => entry.kind === "tool" && entry.tool === "skill" && /edit-workflow|final-pass|feedback/u.test(entry.text ?? ""));
}

export function routes(router: Router<App>): void {
  router.get("/api/projects/status", ({ app }) => sorted(projectStatus(app)));
  router.get("/api/projects/{id}/review", ({ app, params }) => sorted(view(app, params.id ?? "")));
  router.post("/api/projects/{id}/review/share", async (context) => {
    const given = (await readJson<unknown>(context).catch(() => ({}))) as Record<string, unknown>;
    const id = context.params.id ?? "";
    const path = typeof given?.path === "string" ? given.path : null;
    // A minute or two (the review copy, the upload): it runs on, and the review says how it's going.
    const started = share(context.app, id, path);
    started.catch((error: unknown) => diag.warn("review", `sharing ${id}: ${diag.messageOf(error)}`));
    const first = await Promise.race([started.then((done) => ({ done })), new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500))]).catch((error: unknown) => {
      throw new ApiError(400, diag.messageOf(error));
    });
    return sorted(first === null ? { started: true } : first.done);
  });
  router.post("/api/projects/{id}/review/approve", async ({ app, params }) => {
    try {
      return sorted(await approve(app, params.id ?? ""));
    } catch (error) {
      throw new ApiError(400, diag.messageOf(error));
    }
  });
  router.post("/api/reviews/settings", async (context) => {
    const given = (await readJson<unknown>(context)) as Record<string, unknown>;
    if (typeof given?.autoFix !== "boolean") throw new ApiError(400, "autoFix: true or false");
    setAutoFix(context.app.store.home, given.autoFix);
    return sorted({ autoFix: given.autoFix });
  });
}
