import { explain, type Problem } from "@edit/types/problems";
import { produce, type Draft } from "immer";
import { create } from "zustand";

import { useAccount, type Account } from "./account";
import { applyAgentEvent, openAgent } from "./agent";
import { api, ApiError, useConnection } from "./api";
import { readOnly, type CloudStatus } from "./cloud";
import { addContext, note } from "./diagnostics";
import { validateProject } from "./edit";
import { perFrame } from "./frame";
import * as patches from "./patch";
import { shareProject } from "./project-sharing";
import { forgetSetting, readSetting, writeSetting } from "./storage";
import { forgetUnsaved, keepUnsaved, readUnsaved } from "./unsaved";
import type { MediaStatus, Project, ScriptJob } from "./types";

/** Until resized, the viewer and the timeline split their space half and half (below the top bar, its divider and padding). */
export function defaultTimelineHeight() {
  const available = Math.max(320, window.innerHeight - 56);
  return Math.round(Math.min(Math.max(160, available - 160), Math.max(160, available / 2)));
}

export const clientId = `ui-${Math.random().toString(36).slice(2, 10)}`;

const HISTORY_LIMIT = 200;

export interface ExportState {
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: number;
  path: string;
  error?: string;
  seconds?: number;
  /** Size of the finished file. */
  bytes?: number;
  /** A Drive upload follows (a whole subtitled video). */
  drive?: boolean;
  /** Queued: what it waits for. */
  waiting?: string;
  /** Running, before frames encode: "cutting the footage, 12 of 225". */
  phase?: string;
}

/** The upload of an export to Drive (`drive` events from apps/server/src/drive.ts). */
export interface DriveState {
  state: "uploading" | "done" | "failed";
  progress?: number;
  name?: string;
  url?: string;
  error?: string;
}

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "error" | "agent";
  /** An error's plain words (problems.ts): what went wrong and what to do. */
  problem?: Problem;
  /** A button on it (Undo), which dismisses it. */
  action?: { label: string; run: () => void };
}

/** The open edit rendered small for smooth playback (apps/server/src/playback_render.ts). */
export interface PlaybackStatus {
  state: "none" | "waiting" | "rendering" | "ready" | "failed";
  /** The revision the ready file shows, or the one being rendered. */
  rev: number | null;
  progress: number;
  /** The rendered file, when one is ready (it may show an older revision). */
  url: string | null;
  error: string | null;
  /** Rendered here in chunks, played a chunk at a time as each lands (`rev`'s, smoothStream.ts). */
  stream?: boolean;
  /** Why it waits, when it waits: for an export, or for the preview to rest; "preparing" while its excerpts are cut (progress still 0). */
  note?: "export" | "preview" | "preparing" | null;
}

export type Tool = "select" | "razor";
export type SideTab = "info" | "presets" | "transcript";
/** The left panel: the media bin, the script beside it, and its downloads while they run. */
export type MediaTab = "media" | "script" | "downloads";

interface EditorState {
  project: Project | null;
  rev: number;
  saving: boolean;
  dirty: boolean;
  past: Project[];
  future: Project[];
  /** Project before the current drag, so a gesture is one undo step. */
  gestureBase: Project | null;
  selection: string[];
  /** An empty stretch of the timeline clicked on (frames), which Backspace closes. */
  gap: [number, number] | null;
  selectGap(gap: [number, number] | null): void;
  media: Record<string, MediaStatus>;
  exportState: ExportState | null;
  driveState: DriveState | null;
  tool: Tool;
  snapping: boolean;
  showMedia: boolean;
  /** The Info / Presets / Transcript panel. */
  showInspector: boolean;
  showAgent: boolean;
  sideTab: SideTab;
  mediaTab: MediaTab;
  /** The project's script import (footage downloads), while one exists. */
  scriptJob: ScriptJob | null;
  timelineHeight: number;
  /** The chat's width, set by dragging its edge. */
  agentWidth: number;
  toasts: Toast[];
  /** The agent asked to reset the edit (`reset_edit`) and waits for the user's Accept / Reject in the chat. */
  resetAsked: boolean;
  /** The open project's cloud state (apps/server/src/cloud_projects.ts); null for none. */
  cloud: CloudStatus | null;
  /** Its smooth playback render; null until it's asked. */
  playback: PlaybackStatus | null;

  load(rev: number, project: Project): void;
  close(): void;
  edit(recipe: (draft: Draft<Project>) => void): void;
  beginGesture(): void;
  /** Applies `recipe` to the project as it was when the gesture began. */
  gesture(recipe: (draft: Draft<Project>) => void): void;
  endGesture(): void;
  undo(): void;
  redo(): void;
  /** Takes a project the server changed at our request (an import, a script) as one undo step. */
  adopt(rev: number, project: Project): void;
  select(ids: string[], mode?: "replace" | "toggle" | "add"): void;
  setTool(tool: Tool): void;
  toggle(key: "snapping" | "showMedia" | "showInspector" | "showAgent"): void;
  setSideTab(tab: SideTab): void;
  setMediaTab(tab: MediaTab): void;
  setTimelineHeight(height: number): void;
  setAgentWidth(width: number): void;
  /** Back to the default height (the divider's double-click). */
  resetTimelineHeight(): void;
  toast(text: string, tone?: Toast["tone"], action?: Toast["action"]): void;
  /** Says what went wrong in plain words; `doing` finishes "Couldn't …" when nothing better is known. */
  toastError(error: unknown, doing?: string): void;
  dismiss(id: number): void;
}

let toastId = 0;
/** The toast under the pointer, kept until it leaves. */
let heldToast: number | null = null;
export const holdToast = (id: number | null) => {
  heldToast = id;
};
let editorSession = 0;

/**
 * The open project as the server last had it (its revision and content):
 * changes come as patches against it and saves send patches from it
 * (speed-plan 5.1). Never what's on screen, which may have unsaved edits.
 */
let server: { rev: number; project: Project } | null = null;

function remember(rev: number, project: Project) {
  if (server === null || server.project.id !== project.id || rev >= server.rev) server = { rev, project };
}

/**
 * The server's version the project on screen was last in step with: its
 * unsaved edits are what changed since. A change from the server (an import's
 * answer, another client's edit, a conflict) is taken with those edits put
 * back on top (`rebase`), never in their place.
 */
let synced: Project | null = null;

/** Every list patch without its reordering (an order that can't fit after a change from elsewhere). */
function withoutOrders(patch: patches.Patch): patches.Patch {
  const lists: patches.Patch["lists"] = {};
  for (const [key, list] of Object.entries(patch.lists)) lists[key] = { put: list.put, remove: list.remove };
  return { ...patch, lists };
}

/** `incoming` with the edits `local` put on top, or null when they don't fit. */
function onTop(incoming: Project, local: patches.Patch): Project | null {
  for (const attempt of [local, withoutOrders(local)]) {
    try {
      const merged = patches.apply(incoming, attempt);
      if (validateProject(merged) === null) return merged;
    } catch {
      // Doesn't fit as it is: try without the reordering, then give up.
    }
  }
  return null;
}

/**
 * `incoming` (the server's newer version) with the unsaved edits on screen
 * put on top: `kept` when there were any and they fit, `lost` when they
 * didn't (the caller keeps them on this browser). Edits to the same things
 * the incoming version changed (an agent's, another client's) give way to it:
 * they're `clashing`, kept on this browser for "Use mine" (Nov 8 audit, 2b:
 * the edit on screen won item by item, last writer wins).
 */
function rebase(incoming: Project): { project: Project; kept: boolean; lost: boolean; clashing: patches.Patch | null } {
  const { project, dirty } = useEditor.getState();
  if (!project || !dirty || synced === null || synced.id !== incoming.id) return { project: incoming, kept: false, lost: false, clashing: null };
  const local = patches.diff(synced, project);
  if (patches.empty(local)) return { project: incoming, kept: false, lost: false, clashing: null };
  const clash = patches.overlap(patches.diff(synced, incoming), local);
  const { rest, clashing } = clash.length > 0 ? patches.split(local, clash) : { rest: local, clashing: null };
  if (patches.empty(rest)) return { project: incoming, kept: false, lost: false, clashing };
  const merged = onTop(incoming, rest);
  return merged === null ? { project: incoming, kept: false, lost: true, clashing } : { project: merged, kept: true, lost: false, clashing };
}

/**
 * The undo history moved onto `incoming`: each step keeps only its own edits
 * (what it changed since `base`, the server's version it was made on) that
 * the incoming version didn't change, so Undo after a change from elsewhere
 * steps back through this page's edits only and never saves the old project
 * over the other party's change. A step that no longer fits is dropped, with
 * every step before it.
 */
function rebaseHistory(past: Project[], base: Project, incoming: Project, top: Project): Project[] {
  const theirs = patches.touched(patches.diff(base, incoming));
  const out: Project[] = [];
  let after = top;
  for (let at = past.length - 1; at >= 0; at--) {
    const step = past[at]!;
    if (step.id !== incoming.id) break;
    const own = patches.split(patches.diff(base, step), theirs).rest;
    const moved = patches.empty(own) ? incoming : onTop(incoming, own);
    if (moved === null) break;
    // A step whose own edits all gave way is no step any more: Undo goes past it.
    if (patches.empty(patches.diff(moved, after))) continue;
    after = shareProject(incoming, moved);
    out.unshift(after);
  }
  return out;
}

/** Projects with unsaved edits kept on this browser (unsaved.ts), forgotten once a save lands. */
const keptHere = new Set<string>();

/**
 * Keeps the edits on screen that the server hasn't got (what changed since
 * its last version) on this browser, so leaving or reloading can't drop them.
 * The patch is taken now, before the caller moves on; false when there was
 * nothing to keep against or storage failed.
 */
function keepLocally(): Promise<boolean> {
  try {
    const project = useEditor.getState().project;
    if (!project || server === null || server.project.id !== project.id) return Promise.resolve(false);
    const patch = patches.diff(server.project, project);
    if (patches.empty(patch)) return Promise.resolve(false);
    keptHere.add(project.id);
    return keepUnsaved({ id: project.id, base_rev: server.rev, patch, at: Date.now() }).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

/**
 * Puts back the edits a last visit couldn't save (unsaved.ts): on top of the
 * version just opened, whether or not it moved on since, as one undo step,
 * and saves them. Ones that don't fit any more stay kept and are said.
 */
async function restoreUnsaved(id: string) {
  const session = editorSession;
  const entry = await readUnsaved(id);
  if (entry === null || session !== editorSession) return;
  const state = useEditor.getState();
  const current = state.project;
  // Read-only here (another Mac has it): kept until it can be saved here.
  if (!current || current.id !== id || state.gestureBase || readOnly(state.cloud)) return;
  // Kept because it met someone else's change to the same thing: offered, never put back by itself.
  if (entry.collided === true) {
    state.toast("A change of yours that met an edit from elsewhere is still kept on this computer.", "info", { label: "Use mine", run: () => void putBack(id) });
    return;
  }
  keptHere.add(id);
  const merged = onTop(current, entry.patch);
  if (merged === null) {
    state.toast("Your unsaved changes from last time don't fit the latest version; they're still kept on this computer.", "error");
    return;
  }
  if (patches.empty(patches.diff(current, merged))) {
    // The server had them after all (a save whose answer never came).
    keptHere.delete(id);
    void forgetUnsaved(id);
    return;
  }
  const next = shareProject(current, merged);
  useEditor.setState({ project: next, past: [...state.past.slice(-HISTORY_LIMIT), current], future: [], dirty: true });
  scheduleSave(0);
  state.toast("Your unsaved changes from last time are back.");
}

/**
 * Takes the server's newer `incoming` at `rev` with the edits on screen kept
 * on top. `asked`: a change made at this page's request (an import's answer),
 * one undo step of its own; any other (an agent's, another client's, a save's
 * conflict) moves the undo history onto it instead (`rebaseHistory`).
 */
function takeFromServer(rev: number, incoming: Project, extra: Partial<EditorState> = {}, asked = false) {
  const state = useEditor.getState();
  const current = state.project;
  if (!current) return;
  const base = synced;
  const { project: merged, kept, lost, clashing } = rebase(incoming);
  // Edits on screen that didn't fit at all: kept whole, as edits that met a change from elsewhere.
  const unfit = lost && base !== null && base.id === incoming.id ? patches.diff(base, current) : null;
  synced = incoming;
  const next = shareProject(current, merged);
  const past = asked || base === null || base.id !== incoming.id
    ? (next === current ? state.past : [...state.past.slice(-HISTORY_LIMIT), current])
    : rebaseHistory(state.past, base, incoming, next);
  useEditor.setState({
    project: next,
    rev,
    dirty: kept,
    gestureBase: null,
    past,
    future: [],
    ...extra,
  });
  if (kept) scheduleSave(0);
  const aside = unfit ?? clashing;
  if (aside !== null && !patches.empty(aside)) keepCollided(rev, incoming.id, aside);
}

/**
 * Edits that met a change from elsewhere to the same things: the other change
 * is kept, these go on this browser (unsaved.ts, marked `collided`), and one
 * toast offers them back.
 */
function keepCollided(rev: number, id: string, patch: patches.Patch) {
  // Not forgotten by the next save (keptHere): it isn't in it.
  void keepUnsaved({ id, base_rev: rev, patch, at: Date.now(), collided: true });
  useEditor.getState().toast("Your last change met an edit from elsewhere to the same thing, so theirs is kept. Yours is saved on this computer.", "info", { label: "Use mine", run: () => putBack(id) });
}

/** Puts kept edits back on top of the project open now, as one undo step, and saves them. */
async function putBack(id: string) {
  const entry = await readUnsaved(id);
  const state = useEditor.getState();
  const current = state.project;
  if (entry === null || !current || current.id !== id || readOnly(state.cloud)) return;
  const merged = onTop(current, entry.patch);
  if (merged === null) {
    state.toast("Your change doesn't fit the latest version any more; it's still kept on this computer.", "error");
    return;
  }
  // Forgotten once the save with it lands.
  keptHere.add(id);
  useEditor.setState({ project: shareProject(current, merged), past: [...state.past.slice(-HISTORY_LIMIT), current], future: [], dirty: true });
  scheduleSave(0);
}

let readOnlySaid = 0;

/** A cloud project someone else is editing can't be changed here: says so (now and then) and refuses. */
function refuseReadOnly() {
  const cloud = useEditor.getState().cloud;
  if (!readOnly(cloud)) return false;
  if (Date.now() - readOnlySaid > 4000) {
    readOnlySaid = Date.now();
    useEditor.getState().toast(`${cloud?.holder ?? "Someone"} is editing this project. Take over to make changes here.`, "info");
  }
  return true;
}

export const useEditor = create<EditorState>((set, get) => ({
  project: null,
  rev: 0,
  saving: false,
  dirty: false,
  past: [],
  future: [],
  gestureBase: null,
  selection: [],
  gap: null,
  selectGap: (gap) => set({ gap, selection: [] }),
  media: {},
  exportState: null,
  driveState: null,
  tool: "select",
  snapping: true,
  showMedia: true,
  showInspector: true,
  showAgent: readSetting("edit.showAgent") !== "false",
  sideTab: (["info", "presets", "transcript"] as const).find((tab) => tab === readSetting("edit.sideTab")) ?? "info",
  mediaTab: readSetting("edit.mediaTab") === "script" ? "script" : "media",
  scriptJob: null,
  timelineHeight: Number(readSetting("edit.timelineHeight")) || defaultTimelineHeight(),
  agentWidth: Number(readSetting("edit.agentWidth")) || 340,
  toasts: [],
  resetAsked: false,
  cloud: null,
  playback: null,

  load: (rev, project) => {
    editorSession++;
    clearTimeout(saveTimer);
    server = { rev, project };
    synced = project;
    set({ project, rev, past: [], future: [], gestureBase: null, selection: [], dirty: false, saving: false, exportState: null, driveState: null, media: {}, scriptJob: null, resetAsked: false, playback: null });
    void restoreUnsaved(project.id);
  },
  close: () => {
    editorSession++;
    clearTimeout(saveTimer);
    server = null;
    synced = null;
    set({ project: null, rev: 0, past: [], future: [], gestureBase: null, dirty: false, saving: false, selection: [], media: {}, cloud: null, playback: null });
  },

  edit: (recipe) => {
    // A drag the browser cancelled must not hold back this edit or the saves.
    if (get().gestureBase) get().endGesture();
    const { project, past } = get();
    if (!project || refuseReadOnly()) return;
    const next = produce(project, recipe);
    if (next === project) return;
    const problem = validateProject(next);
    if (problem) {
      get().toastError(problem, "do that");
      return;
    }
    set({ project: next, past: [...past.slice(-HISTORY_LIMIT), project], future: [], dirty: true });
    scheduleSave();
  },

  beginGesture: () => {
    if (get().gestureBase) get().endGesture();
    set({ gestureBase: get().project });
  },
  // Gestures re-apply from where they started on every move, so a drag is a
  // pure function of the pointer (and overwrite previews undo themselves).
  gesture: (recipe) => {
    const { project, gestureBase } = get();
    const base = gestureBase ?? project;
    if (!base || refuseReadOnly()) return;
    const next = produce(base, recipe);
    if (next !== project) set({ project: next });
  },
  endGesture: () => {
    const { gestureBase, project, past } = get();
    set({ gestureBase: null });
    if (!gestureBase || !project || gestureBase === project) return;
    const problem = validateProject(project);
    if (problem) {
      set({ project: gestureBase });
      get().toastError(problem, "do that");
      return;
    }
    set({ past: [...past.slice(-HISTORY_LIMIT), gestureBase], future: [], dirty: true });
    scheduleSave(0);
  },

  // Not mid-drag: the next move would re-apply the gesture from its base over
  // the undone project, and its end would push it and drop the redo steps.
  undo: () => {
    const { past, project, future, gestureBase } = get();
    if (gestureBase || !past.length || !project || refuseReadOnly()) return;
    // The Drive link follows Drive, not the edit: undo keeps it.
    set({ project: { ...past[past.length - 1], drive: project.drive }, past: past.slice(0, -1), future: [project, ...future], dirty: true });
    scheduleSave(0);
  },
  redo: () => {
    const { past, project, future, gestureBase } = get();
    if (gestureBase || !future.length || !project || refuseReadOnly()) return;
    set({ project: { ...future[0], drive: project.drive }, past: [...past, project], future: future.slice(1), dirty: true });
    scheduleSave(0);
  },

  adopt: (rev, next) => {
    if (get().gestureBase) get().endGesture();
    const { project } = get();
    if (!project || next.id !== project.id || rev < get().rev) return;
    remember(rev, next);
    // The live event for the change can land first and have brought it already.
    if (rev === get().rev && JSON.stringify(project) === JSON.stringify(next)) return;
    // Edits made while the server worked on it (a rename during an import) stay; the change asked for is one undo step.
    takeFromServer(rev, next, {}, true);
  },

  select: (ids, mode = "replace") => {
    const current = new Set(get().selection);
    if (mode === "replace") return set({ selection: ids, gap: null });
    for (const id of ids) {
      if (mode === "toggle" && current.has(id)) current.delete(id);
      else current.add(id);
    }
    set({ selection: [...current] });
  },
  setTool: (tool) => set({ tool }),
  toggle: (key) => {
    const value = !get()[key];
    if (key === "showAgent") writeSetting("edit.showAgent", String(value));
    set({ [key]: value } as Partial<EditorState>);
  },
  setSideTab: (sideTab) => {
    writeSetting("edit.sideTab", sideTab);
    set({ sideTab, showInspector: true });
  },
  setMediaTab: (mediaTab) => {
    if (mediaTab !== "downloads") writeSetting("edit.mediaTab", mediaTab);
    set({ mediaTab, showMedia: true });
  },
  setAgentWidth: (width) => {
    writeSetting("edit.agentWidth", String(Math.round(width)));
    set({ agentWidth: width });
  },
  setTimelineHeight: (height) => {
    writeSetting("edit.timelineHeight", String(Math.round(height)));
    set({ timelineHeight: height });
  },
  resetTimelineHeight: () => {
    forgetSetting("edit.timelineHeight");
    set({ timelineHeight: defaultTimelineHeight() });
  },
  toast: (text, tone = "info", action) => {
    if (tone === "error") return get().toastError(text);
    const id = ++toastId;
    set({ toasts: [...get().toasts.slice(-3), { id, text, tone, ...(action ? { action } : {}) }] });
    // One with a button stays long enough to press it, and while the pointer is on it.
    const later = () => (heldToast === id ? setTimeout(later, 2000) : get().dismiss(id));
    setTimeout(later, action ? 6000 : 3200);
  },
  toastError: (error, doing) => {
    const problem = explain(error, doing);
    note("error", "ui", problem.details || problem.title);
    const id = ++toastId;
    set({ toasts: [...get().toasts.slice(-3), { id, text: problem.title, tone: "error", problem }] });
    // Long enough to read the fix; it stays while the pointer is on it (Toasts).
    const later = () => (heldToast === id ? setTimeout(later, 2000) : get().dismiss(id));
    setTimeout(later, 12_000);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((toast) => toast.id !== id) }),
}));

// ---------------------------------------------------------------------------
// Saving: debounced whole-document PUTs against the last known revision.

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let inFlight: Promise<void> | null = null;

function scheduleSave(delay = 250) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, delay);
}

async function flush() {
  clearTimeout(saveTimer);
  if (inFlight) {
    await inFlight;
    if (useEditor.getState().dirty) await flush();
    return;
  }
  const state = useEditor.getState();
  if (!state.project || !state.dirty || state.gestureBase) return;
  const task = saveProject(state);
  inFlight = task;
  try { await task; } finally {
    inFlight = null;
    if (useEditor.getState().dirty) scheduleSave(1000);
  }
}

async function saveProject(state: EditorState) {
  if (!state.project) return;
  const project = state.project;
  const session = editorSession;
  useEditor.setState({ saving: true });
  try {
    const base = server !== null && server.project.id === project.id && server.rev === state.rev ? server.project : null;
    const { rev } = base !== null
      ? await api.saveChanges(project.id, state.rev, patches.diff(base, project), clientId)
      : await api.saveProject(project.id, state.rev, project, clientId);
    if (session !== editorSession) return;
    remember(rev, project);
    const current = useEditor.getState();
    if (rev >= current.rev) synced = project;
    const dirty = current.project !== project;
    useEditor.setState({ rev: Math.max(rev, current.rev), dirty });
    if (!dirty && keptHere.delete(project.id)) void forgetUnsaved(project.id);
  } catch (error) {
    if (session !== editorSession) return;
    if (error instanceof ApiError && error.status === 409) {
      // Changed elsewhere meanwhile: the edits on screen go on top of the latest version.
      const body = error.body as { rev: number; project: Project };
      remember(body.rev, body.project);
      takeFromServer(body.rev, body.project);
      useEditor.getState().toast("The project changed elsewhere; your edits are kept on the latest version.", "info");
    } else if (error instanceof ApiError && error.status === 423) {
      // A cloud project someone else is editing now (they took over): show
      // theirs. The edits refused are kept on this browser (they come back
      // when it opens for editing here) and one undo away.
      useEditor.getState().toast(error.message, "error");
      void keepLocally();
      try {
        const live = await api.project(project.id);
        if (session === editorSession) {
          remember(live.rev, live.project);
          synced = live.project;
          const current = useEditor.getState();
          const past = current.project ? [...current.past.slice(-HISTORY_LIMIT), current.project] : current.past;
          useEditor.setState({ project: live.project, rev: live.rev, dirty: false, gestureBase: null, past, future: [] });
        }
      } catch {
        // Offline: keep what's on screen.
      }
    } else if (error instanceof ApiError && error.status === 400) {
      // The server refused the change: show what it has, never a version that
      // can't be saved; what was on screen stays one undo away.
      useEditor.getState().toastError(error, "save that change (the last saved version is back; Undo brings yours back)");
      try {
        const live = await api.project(project.id);
        if (session === editorSession) {
          remember(live.rev, live.project);
          synced = live.project;
          const current = useEditor.getState();
          const past = current.project ? [...current.past.slice(-HISTORY_LIMIT), current.project] : current.past;
          useEditor.setState({ project: live.project, rev: live.rev, dirty: false, gestureBase: null, past, future: [] });
        }
      } catch {
        // Offline: keep what's on screen; the next save retries.
      }
    } else {
      // Offline or the server down: kept on this browser until a save lands.
      void keepLocally();
      useEditor.getState().toastError(error, "save");
    }
  } finally {
    if (session === editorSession) useEditor.setState({ saving: false });
  }
}

export const flushSave = flush;

/** Settles when the last editor left has saved what it had. */
let leaving: Promise<void> = Promise.resolve();

/**
 * Leaves the open project: finishes a drag, saves every edit (waiting for a
 * save already under way, then saving what came after it), and only then
 * closes it. The next project waits for this (`settled`), so nothing it does
 * can drop the last edits, and reopening the same project fetches them.
 */
export function leave(): Promise<void> {
  const state = useEditor.getState();
  if (state.gestureBase) state.endGesture();
  const session = editorSession;
  leaving = (async () => {
    for (let round = 0; round < 3; round++) {
      await flush();
      if (session !== editorSession || !useEditor.getState().dirty) break;
    }
    if (session !== editorSession) return;
    if (useEditor.getState().dirty) {
      // Never dropped: kept on this browser, put back when the project opens again.
      const kept = await keepLocally();
      if (session !== editorSession) return;
      useEditor.getState().toast(kept ? "Your last changes couldn't be saved yet; they're kept on this computer and come back when you open the project." : "Your last changes couldn't be saved.", "error");
    }
    useEditor.getState().close();
  })();
  return leaving;
}

export function settled(): Promise<void> {
  return leaving;
}

// ---------------------------------------------------------------------------
// Live events: agent edits, media processing, exports.

let socket: WebSocket | null = null;

/** Media statuses heard since the last frame, by file path (the last for each). */
let mediaHeard = new Map<string, MediaStatus>();
const mediaEvents = perFrame(() => {
  const heard = mediaHeard;
  mediaHeard = new Map();
  const state = useEditor.getState();
  if (!state.project || heard.size === 0) return;
  let media: Record<string, MediaStatus> | null = null;
  for (const item of state.project.media) {
    const status = heard.get(item.path);
    // Unchanged statuses stay the same objects, so nothing that reads them renders again.
    if (status === undefined || sameStatus(state.media[item.id], status)) continue;
    media ??= { ...state.media };
    media[item.id] = status;
  }
  if (media !== null) useEditor.setState({ media });
});

const sameStatus = (a: MediaStatus | undefined, b: MediaStatus) => a !== undefined && JSON.stringify(a) === JSON.stringify(b);

/** Applies the media statuses heard so far now (tests). */
export const flushMediaEvents = () => mediaEvents.flush();

let dropped = false;
let downTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Shows a script import's progress. Carrying one on after a restart is the
 * server's (its job table resumes it from what each file had); the page only
 * shows what it says, the Downloads tab open while it works or waits.
 */
export async function syncScriptJob(id: string) {
  const project = useEditor.getState().project;
  if (project?.id !== id || !project.script) return;
  try {
    const { job } = await api.scriptJob(id);
    if (useEditor.getState().project?.id !== id) return;
    const running = job && (job.state === "downloading" || job.state === "transcribing" || job.state === "placing" || job.state === "voicing");
    // Running, or waiting (for the person's answer, or by itself): the Downloads tab, open.
    useEditor.setState(running || job?.state === "waiting" ? { scriptJob: job, mediaTab: "downloads", showMedia: true } : { scriptJob: job });
  } catch {
    // Offline: the next reconnect tries again.
  }
}

/** After the server was away (restart, sleep), fetch whatever we missed. */
function catchUp() {
  const state = useEditor.getState();
  const project = state.project;
  if (!project) return;
  void api
    .project(project.id)
    .then(({ rev, project: fresh }) => {
      const now = useEditor.getState();
      if (now.project?.id === fresh.id) remember(rev, fresh);
      if (now.project?.id === fresh.id && !now.dirty && rev > now.rev) {
        synced = fresh;
        useEditor.setState({ rev, project: shareProject(now.project, fresh) });
      }
    })
    .catch(() => {});
  void api
    .mediaStatus(project.id)
    .then(({ media }) => useEditor.getState().project?.id === project.id && useEditor.setState({ media }))
    .catch(() => {});
  void openAgent(project.id);
  void syncScriptJob(project.id);
}

/** Sends a message on the events socket when it's open (lib/notices.ts: where this page is). */
export function sendEvent(text: string): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(text);
}

export function connectEvents() {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws?patches=1`;
  socket = new WebSocket(url);
  socket.onopen = () => {
    clearTimeout(downTimer);
    useConnection.setState({ down: false });
    if (dropped) catchUp();
    dropped = false;
    // A new connection hasn't heard where this page is (lib/notices.ts).
    window.dispatchEvent(new Event("edit:connected"));
  };
  socket.onmessage = (message) => {
    // One malformed frame must not throw out of the handler and drop the rest.
    let event;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    if (event === null || typeof event !== "object") return;
    const state = useEditor.getState();
    const project = state.project;
    if (event.type === "project" && project && event.id === project.id) {
      // A change as a patch against the server's last version (patch.ts); one
      // that doesn't follow on from ours (missed, or out of order) fetches it whole.
      let full: Project | undefined = event.project;
      if (full === undefined && event.patch !== undefined) {
        if (server !== null && server.project.id === event.id && server.rev === event.base_rev) {
          try {
            full = patches.apply(server.project, event.patch);
          } catch {
            full = undefined;
          }
        }
        if (full === undefined) {
          if (event.rev > (server?.rev ?? state.rev)) catchUp();
          return;
        }
      }
      if (full === undefined) return;
      remember(event.rev, full);
      if (event.rev <= state.rev) return;
      // Our own: a save's echo (its answer sets the rev) or a change made at
      // our request (an import), taken now unless edits on screen are waiting
      // to save (their save then meets it and keeps both).
      if (event.origin === clientId && (state.dirty || inFlight !== null)) return;
      takeFromServer(event.rev, full, { selection: state.selection.filter((id) => full.clips.some((clip) => clip.id === id)) });
    } else if (event.type === "media" && project) {
      // Hundreds can come at once (a 300-media project's statuses): one update a frame (Nov 8, Marc's Mac: 503 in a quarter second).
      mediaHeard.set(event.path, event.status);
      mediaEvents.schedule();
    } else if (event.type === "export" && project && event.id === project.id) {
      useEditor.setState({ exportState: event });
    } else if (event.type === "playback" && project && event.id === project.id) {
      useEditor.setState({ playback: event.status });
    } else if (event.type === "drive" && project && event.id === project.id) {
      useEditor.setState({ driveState: event });
    } else if (event.type === "script" && project && event.id === project.id) {
      useEditor.setState({ scriptJob: event.job });
    } else if (event.type === "cloud" && project && event.id === project.id) {
      useEditor.setState({ cloud: event.status });
    } else if (event.type === "cloud-conflict") {
      useEditor.getState().toast(event.message, "error");
    } else if (event.type === "cloud-lost" && project && event.id === project.id) {
      // Someone took over on their computer: read-only here now, and a turn running on it stopped (agent.ts lockLost).
      useEditor.getState().toast(event.message, "error");
    } else if (event.type === "review-refused") {
      // A review note tried to take the agent outside its video (review_guard.ts).
      useEditor.getState().toast(event.message, "error");
    } else if (event.type === "review-missed") {
      // A client's notes Edit hadn't heard (reviews.reconcile): never quietly.
      useEditor.getState().toast(event.message, "error");
    } else if (event.type === "notes" && project && event.id === project.id) {
      // The team's notes on this edit changed (left, sent, fixed): the row above the composer reloads (lib/notes.ts).
      window.dispatchEvent(new CustomEvent("edit:notes", { detail: event.id }));
    } else if (event.type === "transcript") {
      // A transcript changed on disk (its voices were just named): panels reload it.
      window.dispatchEvent(new CustomEvent("edit:transcript", { detail: event.path }));
    } else if (event.type === "agent") {
      applyAgentEvent(event);
    } else if (event.type === "account") {
      // The account as the server has it now: a sign-in that landed, was turned down or ran out, wherever it began.
      useAccount.setState({ account: event.account as Account });
    } else if (event.type === "reset" && project && event.id === project.id) {
      useEditor.setState({ resetAsked: event.state === "asking" });
    } else if (event.type === "notice") {
      // Something the person left running is done (lib/notices.ts shows it).
      window.dispatchEvent(new CustomEvent("edit:notice", { detail: event }));
    } else if (event.type === "resync" && project) {
      catchUp();
    }
  };
  socket.onclose = () => {
    socket = null;
    if (!dropped) {
      dropped = true;
      // A quick blip isn't worth a banner.
      downTimer = setTimeout(() => useConnection.setState({ down: true }), 1500);
    }
    setTimeout(connectEvents, 1000);
  };
}

// The last drag and debounced edit get a chance to save before navigation.
window.addEventListener("pagehide", () => {
  useEditor.getState().endGesture();
  if (useEditor.getState().dirty) void keepLocally();
  void flush();
});
window.addEventListener("beforeunload", (event) => {
  if (useEditor.getState().dirty || useEditor.getState().saving) event.preventDefault();
});

addContext("Open project", () => {
  const { project, rev } = useEditor.getState();
  if (!project) return "none (home screen)";
  return { id: project.id, name: project.name, rev, clips: project.clips.length, tracks: project.tracks.length, media: project.media.length, settings: project.settings };
});
