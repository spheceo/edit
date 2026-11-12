// The agent chat: the user's Claude Code, through Edit's server (apps/server/src/agent.ts). Edit picks the model.

import { create } from "zustand";

import { fetchRetrying } from "./api";
import type { ChatFile, FileKind } from "./chatFiles";
import { perFrame } from "./frame";
import { dropSent, holdSent, sending } from "./sentNow";
import type { ProjectFile } from "./upload";
import { readSetting, writeSetting } from "./storage";

export interface AgentEntry {
  id: string;
  /** "subagent": a sub-agent's card (its chat key in `detail`), opened to view its own chat. */
  /** "thinking": a reasoning block. `status` "running" while it is still being written. */
  /** "compact": Claude Code compacting the conversation; `detail` its sizes, {pre, post} tokens, once done. */
  kind: "user" | "assistant" | "tool" | "error" | "subagent" | "thinking" | "compact";
  text: string;
  tool?: string;
  status?: "running" | "done" | "failed" | "stopped";
  /** Tool arguments (JSON) for the expanded view. */
  detail?: string;
  at?: number;
  updated?: number;
  /** A person's message: the files attached to it (the server's chat_attachments.ts), shown above it. */
  attachments?: { name: string; kind: FileKind; media?: string; file?: string; url?: string | null }[];
}

/** A message sent while a Bodycam HQ turn runs, waiting on the server for it to end (the server's agent.ts `Queued`): Steer or Cancel. */
export interface QueuedMessage {
  id: string;
  text: string;
  at: number;
  playhead: number | null;
  attachments?: AgentEntry["attachments"];
}

export type AgentProvider = "claude";

export interface AgentStatus {
  ready: boolean;
  /** Where the agent runs: the user's Claude Code. */
  provider?: AgentProvider;
  /** The Claude account signed in, and its plan ("Claude Max", "API key"). */
  email?: string;
  plan?: string;
  /** "missing" (not installed), "logged_out" or "ready". */
  state?: "missing" | "logged_out" | "ready" | ClaudeSupport["phase"];
  error?: string;
  path?: string;
  version?: string | null;
}

export interface ClaudeSupport {
  phase: "idle" | "updating" | "checking" | "signing_in" | "ready" | "needs_login" | "error";
  message: string;
  error: string | null;
  url: string | null;
  path: string | null;
  version: string | null;
  checkedAt: number | null;
  checks: { name: string; ok: boolean; detail: string }[];
}
export const useClaudeSupport = create<{ status: ClaudeSupport | null; error: string | null }>(() => ({ status: null, error: null }));
export const claudeBusy = (status: ClaudeSupport | null) => Boolean(status && ["updating", "checking", "signing_in"].includes(status.phase));

let supportWatchers = 0;
let supportTimer: ReturnType<typeof setTimeout> | undefined;
let supportFlight: Promise<void> | null = null;

export function refreshClaudeSupport(): Promise<void> {
  if (supportFlight) return supportFlight;
  const flight = (async () => {
    const before = useClaudeSupport.getState().status?.phase;
    const wasReady = useAgent.getState().status?.ready;
    const status = await json<ClaudeSupport>(await fetchRetrying("/api/agent/claude"));
    useClaudeSupport.setState({ status, error: null });
    const agent = await json<AgentStatus>(await fetchRetrying("/api/agent"));
    useAgent.setState({ status: agent });
    if (before !== status.phase || !wasReady) {
      if (status.phase === "ready") {
        const project = useAgent.getState().project;
        if (project) await openAgent(project);
      }
    }
  })().catch((error: unknown) => useClaudeSupport.setState({ error: error instanceof Error ? error.message : String(error) })).finally(() => {
    if (supportFlight === flight) supportFlight = null;
  });
  supportFlight = flight;
  return flight;
}

/** All setup cards share one poll; GET observes state and never runs a diagnosis. */
export function watchClaudeSupport() {
  supportWatchers++;
  if (supportWatchers === 1) void pollClaudeSupport();
  return () => { supportWatchers--; if (!supportWatchers) clearTimeout(supportTimer); };
}

async function pollClaudeSupport() {
  await refreshClaudeSupport();
  clearTimeout(supportTimer);
  if (supportWatchers) supportTimer = setTimeout(() => void pollClaudeSupport(), claudeBusy(useClaudeSupport.getState().status) ? 1000 : 15_000);
}

export async function setupClaude(action: "diagnose" | "repair" | "login" | "cancel") {
  try {
    const status = await json<ClaudeSupport>(await fetchRetrying("/api/agent/claude", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }),
    }));
    useClaudeSupport.setState({ status, error: null });
    await refreshClaudeSupport();
    clearTimeout(supportTimer);
    if (supportWatchers) supportTimer = setTimeout(() => void pollClaudeSupport(), 1000);
  } catch (error) {
    useClaudeSupport.setState({ error: error instanceof Error ? error.message : String(error) });
  }
}

interface AgentState {
  status: AgentStatus | null;
  project: string | null;
  /** This project's chat has been fetched (until then show nothing, not the empty state). */
  loaded: boolean;
  entries: AgentEntry[];
  running: boolean;
  /** Last streamed or changed moment, so "Thinking" only shows after a quiet spell. */
  activityAt: number;
  /** The model Edit runs the agent on ("Opus 5.5"), shown in the composer; it isn't chosen there. */
  modelName: string | null;
  /** Who answers this project's next turn: Opus while the edit is built, then the model menu's pick for its revisions (the server's `model_name`). */
  chatModel: string | null;
  /** The next turn is a revision, so the model menu offers the pick (the server's `revising`). */
  revising: boolean;
  /** A sub-agent's chat being viewed in place of the main one (the fresh-eyes pass): Back returns. */
  sub: SubChat | null;
  /** Bodycam HQ: the messages waiting on the server for the running turn to end, in order (empty elsewhere). */
  queue: QueuedMessage[];
}

/** A sub-agent's chat: its key (`<project>~<name>`), title and conversation. */
export interface SubChat {
  key: string;
  name: string;
  title: string;
  entries: AgentEntry[];
  running: boolean;
  loaded: boolean;
}

export const useAgent = create<AgentState>(() => ({
  status: null,
  project: null,
  loaded: false,
  entries: [],
  running: false,
  activityAt: 0,
  modelName: readSetting("edit.agent.modelName"),
  chatModel: null,
  revising: false,
  sub: null,
  queue: [],
}));

/** Opens a sub-agent's chat from its card in the main chat. */
export async function openSub(card: AgentEntry) {
  const project = useAgent.getState().project;
  const key = card.detail ?? "";
  const name = key.split("~")[1] ?? "";
  if (!project || !key.startsWith(`${project}~`) || !/^[a-z]+$/.test(name)) return;
  useAgent.setState({ sub: { key, name, title: card.text, entries: [], running: card.status === "running", loaded: false } });
  try {
    const chat = await json<{ entries: AgentEntry[]; running: boolean }>(await fetchRetrying(`/api/projects/${project}/agent?chat=${name}`));
    if (useAgent.getState().sub?.key !== key) return;
    useAgent.setState((state) => ({ sub: state.sub && { ...state.sub, entries: chat.entries, running: chat.running, loaded: true } }));
  } catch (error) {
    useAgent.setState((state) => ({ sub: state.sub && { ...state.sub, loaded: true, entries: [{ id: "load", kind: "error", text: (error as Error).message }] } }));
  }
}

/** Back to the main chat. */
export const closeSub = () => useAgent.setState({ sub: null });

/** Stops the sub-agent being viewed. */
export const stopSub = () => {
  const { project, sub } = useAgent.getState();
  if (project && sub) void fetchRetrying(`/api/projects/${project}/agent/stop?chat=${sub.name}`, { method: "POST" });
};

/** The name of the model Edit runs turns on (the server's default: the panel sends none). */
async function loadModelName() {
  const { models } = await json<{ models: { name: string; is_default: boolean }[] }>(await fetchRetrying("/api/agent/models"));
  const name = models.find((model) => model.is_default)?.name ?? null;
  if (name === null) return;
  writeSetting("edit.agent.modelName", name);
  useAgent.setState({ modelName: name });
}

/** Chats already seen this session, so reopening the panel or a project is instant. */
const chats = new Map<string, { entries: AgentEntry[]; running: boolean; chatModel?: string | null; revising?: boolean; queue?: QueuedMessage[] }>();
/** A pre-update failed message is adopted once; the server also saves a receipt. */
const retriedAuth = new Set<string>();
let openedSerial = 0;

const json = async <T>(response: Response): Promise<T> => {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `request failed (${response.status})`);
  return body as T;
};

/** Shows this project's chat (instantly if seen before), then refreshes it quietly. */
export async function openAgent(project: string) {
  const serial = ++openedSerial;
  events.flush();
  const state = useAgent.getState();
  if (state.project !== project) {
    const cached = chats.get(project);
    useAgent.setState({ project, loaded: Boolean(cached), entries: cached?.entries ?? [], running: cached?.running ?? false, chatModel: cached?.chatModel ?? null, revising: cached?.revising ?? false, sub: null, queue: cached?.queue ?? [] });
  }
  const [status, chat] = await Promise.all([
    fetchRetrying("/api/agent").then((response) => json<AgentStatus>(response)),
    fetchRetrying(`/api/projects/${project}/agent`).then((response) =>
      json<{ entries: AgentEntry[]; running: boolean; model_name?: string; revising?: boolean; auth_retry?: string | null; queue?: QueuedMessage[] }>(response),
    ),
  ]).catch(() => [null, null] as const);
  if (useAgent.getState().project !== project || serial !== openedSerial) return;
  if (!status || !chat) {
    useAgent.setState({ loaded: true });
    return;
  }
  events.flush();
  useAgent.setState({
    status,
    loaded: true,
    entries: chat.entries,
    // A message still on its way (sentNow.ts) is a turn about to start.
    running: chat.running || sending(project, chat.entries),
    chatModel: chat.model_name ?? null,
    revising: chat.revising === true,
    queue: chat.queue ?? [],
  });
  if (status.ready) loadModelName().catch(() => {});
  if (status.ready && chat.auth_retry && !chat.running) {
    const key = `${project}:${chat.auth_retry}`;
    if (retriedAuth.has(key)) return;
    retriedAuth.add(key);
    try {
      const retry = await json<{ resumed: boolean }>(await fetchRetrying(`/api/projects/${project}/agent/retry-claude`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: chat.auth_retry }),
      }));
      if (!retry.resumed) { retriedAuth.delete(key); return; }
      if (useAgent.getState().project === project) await openAgent(project);
    } catch (error) {
      if (useAgent.getState().project !== project) return;
      useAgent.setState((current) => ({ entries: [...current.entries, {
        id: `local-retry-${Date.now()}`, kind: "error", text: `Claude is ready, but the earlier message could not resume: ${error instanceof Error ? error.message : String(error)}. Send your message again to continue.`,
      }] }));
    }
  }
}

/**
 * `playhead`: the editor's frame when the message was written, so the agent
 * starts there. `files`: what's attached, already in the project (the chat's
 * uploader); pictures reach the model as pictures. `queues`: a Bodycam HQ chat,
 * where a message sent while the turn runs waits in the server's queue (shown
 * above the composer, not in the conversation) until it ends.
 */
export async function sendToAgent(text: string, playhead?: number, files: ChatFile[] = [], queues = false) {
  const state = useAgent.getState();
  if (!state.project) return;
  const project = state.project;
  const attachments = files.map((one) => {
    const landed = (one.landed ?? {}) as ProjectFile;
    return { name: one.name, kind: one.kind, ...(landed.media === undefined ? {} : { media: landed.media }), ...(landed.file === undefined ? {} : { file: landed.file }) };
  });
  events.flush();
  const shown = files.map((one, index) => ({ ...attachments[index]!, url: one.kind === "image" ? one.preview : null }));
  const queueing = queues && useAgent.getState().running;
  // Show the message now (sentNow.ts); the server's copy takes its place when it arrives. A queued one shows in the queue instead.
  if (!queueing) {
    holdSent(project, useAgent.getState().entries, text, shown);
    useAgent.setState({ running: true, activityAt: Date.now() });
  }
  try {
    const answer = await fetchRetrying(`/api/projects/${project}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        ...(playhead === undefined ? {} : { playhead: String(Math.round(playhead)) }),
        ...(attachments.length === 0 ? {} : { attachments: JSON.stringify(attachments) }),
      }),
    }).then((response) => json<{ queued?: QueuedMessage }>(response));
    const queued = answer.queued;
    // Queued after all (the turn was still running), or before its event: shown in the queue, never twice.
    if (queued !== undefined) {
      dropSent(project);
      useAgent.setState((current) => (current.project !== project || current.queue.some((one) => one.id === queued.id) ? {} : { queue: [...current.queue, queued], running: true }));
    }
  } catch (error) {
    // Refused: the message stays in the chat with why, as it was sent (a turn still running goes on).
    const now = Date.now();
    dropSent(project);
    useAgent.setState((current) => ({
      running: queueing && current.running,
      entries: [...current.entries, { id: `local-user-${now}`, kind: "user", text, at: now, updated: now, ...(shown.length > 0 ? { attachments: shown } : {}) }, { id: `local-${now}`, kind: "error", text: (error as Error).message }],
    }));
  }
}

export const stopAgent = () => {
  const project = useAgent.getState().project;
  if (project) void fetchRetrying(`/api/projects/${project}/agent/stop`, { method: "POST" });
};

/** Takes a queued message out (shown gone at once, back if the server refuses). */
export async function cancelQueued(id: string): Promise<void> {
  await leaveQueue(id, "cancel");
}

/** Steer: the running turn stops and this queued message goes in its place, in the same conversation; the rest wait. */
export async function steerQueued(id: string): Promise<void> {
  await leaveQueue(id, "steer");
}

async function leaveQueue(id: string, how: "cancel" | "steer"): Promise<void> {
  const { project, queue } = useAgent.getState();
  if (!project) return;
  useAgent.setState({ queue: queue.filter((one) => one.id !== id) });
  try {
    await json(await fetchRetrying(`/api/projects/${project}/agent/queue/${encodeURIComponent(id)}/${how}`, { method: "POST" }));
  } catch (error) {
    // The server's queue as it is: the event said so already, or the chat is read again.
    if (useAgent.getState().project === project) void openAgent(project);
    throw error;
  }
}

type AgentEvent = { project: string; event: string; [key: string]: unknown };

/** The chat with one event from the server applied (nothing when it isn't this chat's). */
function reduce(state: AgentState, event: AgentEvent, now: number): AgentState {
  // The sub-agent being viewed has its own chat (the main one's card follows its own events).
  if (state.sub !== null && event.project === state.sub.key) {
    const sub = state.sub;
    if (event.event === "entry") {
      const entry = event.entry as AgentEntry;
      const entries = sub.entries.some((existing) => existing.id === entry.id) ? sub.entries.map((existing) => (existing.id === entry.id ? { ...entry, text: entry.text || existing.text } : existing)) : [...sub.entries, entry];
      return { ...state, sub: { ...sub, entries }, activityAt: now };
    }
    if (event.event === "delta") return { ...state, sub: { ...sub, entries: sub.entries.map((entry) => (entry.id === event.id ? { ...entry, text: entry.text + String(event.text) } : entry)) }, activityAt: now };
    if (event.event === "status") return { ...state, sub: { ...sub, running: Boolean(event.running) }, activityAt: now };
    if (event.event === "reset") return { ...state, sub: { ...sub, entries: [], running: false } };
    return state;
  }
  if (event.project !== state.project) return state;
  switch (event.event) {
    case "entry": {
      const entry = event.entry as AgentEntry;
      const entries = state.entries.some((existing) => existing.id === entry.id)
        ? state.entries.map((existing) => (existing.id === entry.id ? { ...entry, text: entry.text || existing.text } : existing))
        : [...state.entries, entry];
      return { ...state, entries, activityAt: now };
    }
    case "delta":
      return { ...state, activityAt: now, entries: state.entries.map((entry) => (entry.id === event.id ? { ...entry, text: entry.text + String(event.text) } : entry)) };
    case "status":
      return { ...state, running: Boolean(event.running), activityAt: now };
    case "reset":
      return { ...state, entries: [], running: false, queue: [] };
    case "queue":
      return { ...state, queue: Array.isArray(event.queue) ? (event.queue as QueuedMessage[]) : [] };
    case "model":
      return { ...state, chatModel: typeof event.model_name === "string" ? event.model_name : null, revising: event.revising === true };
  }
  return state;
}

/** Events heard since the last frame, applied together. */
let heard: AgentEvent[] = [];
const events = perFrame(() => {
  const batch = heard;
  heard = [];
  if (batch.length === 0) return;
  const before = useAgent.getState();
  const now = Date.now();
  const after = batch.reduce((state, event) => reduce(state, event, now), before);
  if (after === before) return;
  useAgent.setState(after, true);
  if (after.project !== null) chats.set(after.project, { entries: after.entries, running: after.running, chatModel: after.chatModel, revising: after.revising, queue: after.queue });
});

/**
 * Live events from the server (see store.ts connectEvents), applied once a
 * frame: a turn's words stream in as hundreds of messages, and a store update
 * for each re-rendered the chat for each, back to back, until React took it
 * for a loop and gave up (#185 as turns ended: 71 on Marc's Mac, Nov 6-8).
 */
export function applyAgentEvent(event: AgentEvent) {
  if (event.event === "claude") {
    useClaudeSupport.setState({ status: event.support as ClaudeSupport, error: null });
    void refreshClaudeSupport();
    return;
  }
  heard.push(event);
  events.schedule();
}

/** Applies the events heard so far now (tests, and anything about to read the chat). */
export const flushAgentEvents = () => events.flush();

// Remember every loaded chat (including optimistic sends) for instant reopening.
useAgent.subscribe((state) => {
  if (state.project && state.loaded) chats.set(state.project, { entries: state.entries, running: state.running, chatModel: state.chatModel, revising: state.revising, queue: state.queue });
});
