import { produce, type Draft } from "immer";
import { create } from "zustand";

import { applyAgentEvent, openAgent } from "./agent";
import { api, ApiError, useConnection } from "./api";
import { readOnly, type CloudStatus } from "./cloud";
import { addContext, note } from "./diagnostics";
import { validateProject } from "./edit";
import * as patches from "./patch";
import { shareProject } from "./project-sharing";
import { forgetSetting, readSetting, writeSetting } from "./storage";
import type { MediaStatus, Project, ScriptJob } from "./types";

/** Until resized, the timeline takes a bit over half the window: the tracks are where the work is. */
export function defaultTimelineHeight() {
  return Math.round(Math.max(160, Math.min(window.innerHeight - 260, window.innerHeight * 0.55)));
}

export const clientId = `ui-${Math.random().toString(36).slice(2, 10)}`;

const HISTORY_LIMIT = 200;

export interface ExportState {
  state: "running" | "done" | "failed" | "cancelled";
  progress: number;
  path: string;
  error?: string;
  seconds?: number;
  /** Size of the finished file. */
  bytes?: number;
  /** A Drive upload follows (a whole subtitled video). */
  drive?: boolean;
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
  toasts: Toast[];
  agentActive: number;
  /** The open project's cloud state (apps/server/src/cloud_projects.ts); null for none. */
  cloud: CloudStatus | null;

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
  /** Back to the default height (the divider's double-click). */
  resetTimelineHeight(): void;
  toast(text: string, tone?: Toast["tone"]): void;
  dismiss(id: number): void;
}

let toastId = 0;
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

/**
 * `incoming` (the server's newer version) with the unsaved edits on screen
 * put on top: `kept` when there were any and they fit, `lost` when they
 * didn't (the caller keeps the version on screen in the undo history).
 */
function rebase(incoming: Project): { project: Project; kept: boolean; lost: boolean } {
  const { project, dirty } = useEditor.getState();
  if (!project || !dirty || synced === null || synced.id !== incoming.id) return { project: incoming, kept: false, lost: false };
  const local = patches.diff(synced, project);
  if (patches.empty(local)) return { project: incoming, kept: false, lost: false };
  for (const attempt of [local, withoutOrders(local)]) {
    try {
      const merged = patches.apply(incoming, attempt);
      if (validateProject(merged) === null) return { project: merged, kept: true, lost: false };
    } catch {
      // Doesn't fit as it is: try without the reordering, then give up.
    }
  }
  return { project: incoming, kept: false, lost: true };
}

/** Takes the server's newer `incoming` at `rev` with the edits on screen kept on top (one undo step). */
function takeFromServer(rev: number, incoming: Project, extra: Partial<EditorState> = {}) {
  const state = useEditor.getState();
  const current = state.project;
  if (!current) return;
  const { project: merged, kept, lost } = rebase(incoming);
  synced = incoming;
  const next = shareProject(current, merged);
  useEditor.setState({
    project: next,
    rev,
    dirty: kept,
    gestureBase: null,
    past: next === current ? state.past : [...state.past.slice(-HISTORY_LIMIT), current],
    future: [],
    ...extra,
  });
  if (kept) scheduleSave(0);
  if (lost) useEditor.getState().toast("The project changed while you were editing and your latest change didn't fit; undo brings it back.", "error");
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
  toasts: [],
  agentActive: 0,
  cloud: null,

  load: (rev, project) => {
    editorSession++;
    clearTimeout(saveTimer);
    server = { rev, project };
    synced = project;
    set({ project, rev, past: [], future: [], gestureBase: null, selection: [], dirty: false, saving: false, exportState: null, driveState: null, media: {}, scriptJob: null });
  },
  close: () => {
    editorSession++;
    clearTimeout(saveTimer);
    server = null;
    synced = null;
    set({ project: null, rev: 0, past: [], future: [], gestureBase: null, dirty: false, saving: false, selection: [], media: {}, cloud: null });
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
      get().toast(`Can't do that: ${problem}.`, "error");
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
      get().toast(`Can't do that: ${problem}.`, "error");
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
    // Edits made while the server worked on it (a rename during an import) stay.
    takeFromServer(rev, next);
  },

  select: (ids, mode = "replace") => {
    const current = new Set(get().selection);
    if (mode === "replace") return set({ selection: ids });
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
  setTimelineHeight: (height) => {
    writeSetting("edit.timelineHeight", String(Math.round(height)));
    set({ timelineHeight: height });
  },
  resetTimelineHeight: () => {
    forgetSetting("edit.timelineHeight");
    set({ timelineHeight: defaultTimelineHeight() });
  },
  toast: (text, tone = "info") => {
    if (tone === "error") note("error", "ui", text);
    const id = ++toastId;
    set({ toasts: [...get().toasts.slice(-3), { id, text, tone }] });
    setTimeout(() => get().dismiss(id), tone === "error" ? 6000 : 3200);
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
    useEditor.setState({ rev: Math.max(rev, current.rev), dirty: current.project !== project });
  } catch (error) {
    if (session !== editorSession) return;
    if (error instanceof ApiError && error.status === 409) {
      // Changed elsewhere meanwhile: the edits on screen go on top of the latest version.
      const body = error.body as { rev: number; project: Project };
      remember(body.rev, body.project);
      takeFromServer(body.rev, body.project);
      useEditor.getState().toast("The project changed elsewhere; your edits are kept on the latest version.", "info");
    } else if (error instanceof ApiError && error.status === 423) {
      // A cloud project someone else is editing now (they took over): show theirs.
      useEditor.getState().toast(error.message, "error");
      try {
        const live = await api.project(project.id);
        if (session === editorSession) {
          remember(live.rev, live.project);
          synced = live.project;
          useEditor.setState({ project: live.project, rev: live.rev, dirty: false, gestureBase: null });
        }
      } catch {
        // Offline: keep what's on screen.
      }
    } else if (error instanceof ApiError && error.status === 400) {
      // The server refused the change: show what it has, never a version that
      // can't be saved; what was on screen stays one undo away.
      useEditor.getState().toast(`That change couldn't be saved (${error.message}); restored the last saved version (undo brings yours back).`, "error");
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
      useEditor.getState().toast(`Couldn't save: ${(error as Error).message}`, "error");
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
    if (useEditor.getState().dirty) useEditor.getState().toast("Your last changes couldn't be saved.", "error");
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
let agentTimer: ReturnType<typeof setTimeout> | undefined;

let dropped = false;
let downTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Shows a script import's progress, and picks it up again if it stopped
 * (the server restarted mid-download): downloads resume where they left off.
 */
export async function syncScriptJob(id: string) {
  const project = useEditor.getState().project;
  if (project?.id !== id || !project.script) return;
  try {
    const { job, unfinished } = await api.scriptJob(id);
    if (useEditor.getState().project?.id !== id) return;
    const running = job && (job.state === "downloading" || job.state === "transcribing" || job.state === "placing" || job.state === "voicing");
    useEditor.setState(running ? { scriptJob: job, mediaTab: "downloads", showMedia: true } : { scriptJob: job });
    // A failed run waits for Retry; an import that stopped part-way (blocks never
    // placed) carries on by itself. A placed block whose clip is gone was removed
    // on purpose (a cut-in card replaced by B-roll): never put it back.
    // Laid out once (any block placed): finished, never resumed (only a Re-cut lays it out again; the server refuses too).
    const laidOut = project.script.blocks.some((block) => block.clip || (block.kind === "narration" && block.voiceover));
    const neverPlaced = !laidOut && project.script.blocks.some((block) => !block.clip);
    // Only an import that stopped part-way, never one that finished: a finished edit
    // whose blocks lost their clip links was laid out again on top of itself when it
    // was opened (Mom Leaves 5 Kids, Oct 23: a second copy after 30:50).
    if (unfinished && neverPlaced && !running && job?.state !== "failed" && job?.state !== "done") {
      const resumed = await api.resumeScript(id);
      if (useEditor.getState().project?.id === id) useEditor.setState({ scriptJob: resumed.job });
    }
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

export function connectEvents() {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws?patches=1`;
  socket = new WebSocket(url);
  socket.onopen = () => {
    clearTimeout(downTimer);
    useConnection.setState({ down: false });
    if (dropped) catchUp();
    dropped = false;
  };
  socket.onmessage = (message) => {
    const event = JSON.parse(message.data);
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
      if (event.origin === "agent") {
        clearTimeout(agentTimer);
        useEditor.setState({ agentActive: Date.now() });
        agentTimer = setTimeout(() => useEditor.setState({ agentActive: 0 }), 2500);
      }
    } else if (event.type === "media" && project) {
      const ids = project.media.filter((media) => media.path === event.path).map((media) => media.id);
      if (ids.length) {
        const media = { ...state.media };
        for (const id of ids) media[id] = event.status;
        useEditor.setState({ media });
      }
    } else if (event.type === "export" && project && event.id === project.id) {
      useEditor.setState({ exportState: event });
    } else if (event.type === "drive" && project && event.id === project.id) {
      useEditor.setState({ driveState: event });
    } else if (event.type === "script" && project && event.id === project.id) {
      useEditor.setState({ scriptJob: event.job });
    } else if (event.type === "cloud" && project && event.id === project.id) {
      useEditor.setState({ cloud: event.status });
    } else if (event.type === "cloud-conflict") {
      useEditor.getState().toast(event.message, "error");
    } else if (event.type === "review-refused") {
      // A review note tried to take the agent outside its video (review_guard.ts).
      useEditor.getState().toast(event.message, "error");
    } else if (event.type === "review-missed") {
      // A client's notes Edit hadn't heard (reviews.reconcile): never quietly.
      useEditor.getState().toast(event.message, "error");
    } else if (event.type === "transcript") {
      // A transcript changed on disk (its voices were just named): panels reload it.
      window.dispatchEvent(new CustomEvent("edit:transcript", { detail: event.path }));
    } else if (event.type === "agent") {
      applyAgentEvent(event);
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
