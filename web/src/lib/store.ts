import { produce, type Draft } from "immer";
import { create } from "zustand";

import { applyAgentEvent, openAgent } from "./agent";
import { api, ApiError, useConnection } from "./api";
import { addContext, note } from "./diagnostics";
import { validateProject } from "./edit";
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

/** The upload of an export to Drive (`drive` events from crates/edit/src/drive.rs). */
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
export type SideTab = "info" | "presets" | "library" | "transcript";
/** Edit: bin, panels and viewer. Script: viewer beside the script, as Repack's split view. */
export type Workspace = "edit" | "script";

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
  /** The Info / Elements / Transcript panel. */
  showInspector: boolean;
  showAgent: boolean;
  sideTab: SideTab;
  workspace: Workspace;
  /** The project's script import (footage downloads), while one exists. */
  scriptJob: ScriptJob | null;
  timelineHeight: number;
  toasts: Toast[];
  agentActive: number;

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
  setWorkspace(workspace: Workspace): void;
  setTimelineHeight(height: number): void;
  /** Back to the default height (the divider's double-click). */
  resetTimelineHeight(): void;
  toast(text: string, tone?: Toast["tone"]): void;
  dismiss(id: number): void;
}

let toastId = 0;
let editorSession = 0;

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
  sideTab: (["info", "presets", "library", "transcript"] as const).find((tab) => tab === readSetting("edit.sideTab")) ?? "info",
  workspace: readSetting("edit.workspace") === "script" ? "script" : "edit",
  scriptJob: null,
  timelineHeight: Number(readSetting("edit.timelineHeight")) || defaultTimelineHeight(),
  toasts: [],
  agentActive: 0,

  load: (rev, project) => {
    editorSession++;
    clearTimeout(saveTimer);
    set({ project, rev, past: [], future: [], gestureBase: null, selection: [], dirty: false, saving: false, exportState: null, driveState: null, media: {}, scriptJob: null });
  },
  close: () => {
    editorSession++;
    clearTimeout(saveTimer);
    set({ project: null, rev: 0, past: [], future: [], gestureBase: null, dirty: false, saving: false, selection: [], media: {} });
  },

  edit: (recipe) => {
    // A drag the browser cancelled must not hold back this edit or the saves.
    if (get().gestureBase) get().endGesture();
    const { project, past } = get();
    if (!project) return;
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
    if (!base) return;
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

  undo: () => {
    const { past, project, future } = get();
    if (!past.length || !project) return;
    // The Drive link follows Drive, not the edit: undo keeps it.
    set({ project: { ...past[past.length - 1], drive: project.drive }, past: past.slice(0, -1), future: [project, ...future], dirty: true });
    scheduleSave(0);
  },
  redo: () => {
    const { past, project, future } = get();
    if (!future.length || !project) return;
    set({ project: { ...future[0], drive: project.drive }, past: [...past, project], future: future.slice(1), dirty: true });
    scheduleSave(0);
  },

  adopt: (rev, next) => {
    if (get().gestureBase) get().endGesture();
    const { project, past } = get();
    if (!project || next.id !== project.id || rev < get().rev) return;
    // The live event for our own change can land first: it bumps rev but leaves the project
    // to this response. Another client's event may instead have brought the change already.
    if (rev === get().rev && JSON.stringify(project) === JSON.stringify(next)) return;
    set({ project: next, rev, past: [...past.slice(-HISTORY_LIMIT), project], future: [], dirty: false });
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
  setWorkspace: (workspace) => {
    writeSetting("edit.workspace", workspace);
    set({ workspace });
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
    const { rev } = await api.saveProject(project.id, state.rev, project, clientId);
    if (session !== editorSession) return;
    const current = useEditor.getState();
    useEditor.setState({ rev: Math.max(rev, current.rev), dirty: current.project !== project });
  } catch (error) {
    if (session !== editorSession) return;
    if (error instanceof ApiError && error.status === 409) {
      const body = error.body as { rev: number; project: Project };
      const current = useEditor.getState();
      useEditor.setState({ project: body.project, rev: body.rev, dirty: false, gestureBase: null, past: [...current.past.slice(-HISTORY_LIMIT), current.project ?? project], future: [] });
      useEditor.getState().toast("The project changed elsewhere; showing the latest version.", "info");
    } else if (error instanceof ApiError && error.status === 400) {
      // The server refused the change: show what it has, never a version that can't be saved.
      useEditor.getState().toast(`That change couldn't be saved (${error.message}); restored the last saved version.`, "error");
      try {
        const live = await api.project(project.id);
        if (session === editorSession) useEditor.setState({ project: live.project, rev: live.rev, dirty: false });
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
    useEditor.setState({ scriptJob: job });
    const running = job && (job.state === "downloading" || job.state === "transcribing" || job.state === "placing");
    // A failed run waits for Retry; an import that stopped part-way (blocks never
    // placed) carries on by itself. A placed block whose clip is gone was removed
    // on purpose (a cut-in card replaced by B-roll): never put it back.
    const neverPlaced = project.script.blocks.some((block) => !block.clip);
    if (unfinished && neverPlaced && !running && job?.state !== "failed") {
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
      if (now.project?.id === fresh.id && !now.dirty && rev > now.rev) useEditor.setState({ rev, project: fresh });
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
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`;
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
      if (event.origin === clientId) {
        if (event.rev > state.rev) useEditor.setState({ rev: event.rev });
        return;
      }
      if (event.rev <= state.rev) return;
      clearTimeout(saveTimer);
      useEditor.setState({
        project: event.project,
        rev: event.rev,
        dirty: false,
        gestureBase: null,
        past: [...state.past.slice(-HISTORY_LIMIT), project],
        future: [],
        selection: state.selection.filter((id) => event.project.clips.some((clip: { id: string }) => clip.id === id)),
      });
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
