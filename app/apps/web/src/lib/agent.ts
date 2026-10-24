// The agent chat: the user's Claude Code, through Edit's server (apps/server/src/agent.ts). Edit picks the model.

import { create } from "zustand";

import { fetchRetrying } from "./api";
import { readSetting, writeSetting } from "./storage";

export interface AgentEntry {
  id: string;
  kind: "user" | "assistant" | "tool" | "error";
  text: string;
  tool?: string;
  status?: "running" | "done" | "failed" | "stopped";
  /** Tool arguments (JSON) for the expanded view. */
  detail?: string;
  at?: number;
  updated?: number;
}

export type AgentProvider = "claude" | "codex";

export interface AgentStatus {
  ready: boolean;
  /** Where the agent runs: the user's Claude Code, or Codex. */
  provider?: AgentProvider;
  /** The Claude account signed in, and its plan ("Claude Max", "API key"). */
  email?: string;
  plan?: string;
  /** "missing" (not installed), "logged_out" or "ready". */
  state?: "missing" | "logged_out" | "ready";
  error?: string;
  path?: string;
  version?: string | null;
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
}

export const useAgent = create<AgentState>(() => ({
  status: null,
  project: null,
  loaded: false,
  entries: [],
  running: false,
  activityAt: 0,
  modelName: readSetting("edit.agent.modelName"),
}));

/** The name of the model Edit runs turns on (the server's default: the panel sends none). */
async function loadModelName() {
  const { models } = await json<{ models: { name: string; is_default: boolean }[] }>(await fetchRetrying("/api/agent/models"));
  const name = models.find((model) => model.is_default)?.name ?? null;
  if (name === null) return;
  writeSetting("edit.agent.modelName", name);
  useAgent.setState({ modelName: name });
}

/** Chats already seen this session, so reopening the panel or a project is instant. */
const chats = new Map<string, { entries: AgentEntry[]; running: boolean }>();

const json = async <T>(response: Response): Promise<T> => {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `request failed (${response.status})`);
  return body as T;
};

/** The agent's name as the panel shows it. */
export const providerName = (status: AgentStatus | null) => (status?.provider === "codex" ? "Codex" : "Claude Code");

/** Shows this project's chat (instantly if seen before), then refreshes it quietly. */
export async function openAgent(project: string) {
  const state = useAgent.getState();
  if (state.project !== project) {
    const cached = chats.get(project);
    useAgent.setState({ project, loaded: Boolean(cached), entries: cached?.entries ?? [], running: cached?.running ?? false });
  }
  const [status, chat] = await Promise.all([
    fetchRetrying("/api/agent").then((response) => json<AgentStatus>(response)),
    fetchRetrying(`/api/projects/${project}/agent`).then((response) =>
      json<{ entries: AgentEntry[]; running: boolean }>(response),
    ),
  ]).catch(() => [null, null] as const);
  if (useAgent.getState().project !== project) return;
  if (!status || !chat) {
    useAgent.setState({ loaded: true });
    return;
  }
  // Keep a message we're still sending that the server hasn't echoed yet.
  const pending = useAgent.getState().entries.filter((entry) => entry.id.startsWith("pending-"));
  useAgent.setState({
    status,
    loaded: true,
    entries: [...chat.entries, ...pending],
    running: chat.running || pending.length > 0,
  });
  if (status.ready) loadModelName().catch(() => {});
}

export async function sendToAgent(text: string) {
  const state = useAgent.getState();
  if (!state.project) return;
  // Show the message now; the server's copy replaces it when it arrives.
  const now = Date.now();
  useAgent.setState({
    running: true,
    activityAt: now,
    entries: [...state.entries, { id: `pending-${now}`, kind: "user", text, at: now, updated: now }],
  });
  try {
    await fetchRetrying(`/api/projects/${state.project}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }).then(json);
  } catch (error) {
    useAgent.setState((current) => ({
      running: false,
      entries: [...current.entries, { id: `local-${Date.now()}`, kind: "error", text: (error as Error).message }],
    }));
  }
}

export const stopAgent = () => {
  const project = useAgent.getState().project;
  if (project) void fetchRetrying(`/api/projects/${project}/agent/stop`, { method: "POST" });
};

export const newChat = () => {
  const project = useAgent.getState().project;
  if (project) void fetchRetrying(`/api/projects/${project}/agent/reset`, { method: "POST" });
};

/** Live events from the server (see store.ts connectEvents). */
export function applyAgentEvent(event: { project: string; event: string; [key: string]: unknown }) {
  const state = useAgent.getState();
  if (event.project !== state.project) return;
  const now = Date.now();
  switch (event.event) {
    case "entry": {
      const entry = event.entry as AgentEntry;
      let entries: AgentEntry[];
      if (state.entries.some((existing) => existing.id === entry.id)) {
        entries = state.entries.map((existing) => (existing.id === entry.id ? { ...entry, text: entry.text || existing.text } : existing));
      } else if (entry.kind === "user" && state.entries.some((existing) => existing.id.startsWith("pending-") && existing.text === entry.text)) {
        // The server's copy of the message we already show: swap in place.
        let swapped = false;
        entries = state.entries.map((existing) => {
          if (swapped || !existing.id.startsWith("pending-") || existing.text !== entry.text) return existing;
          swapped = true;
          return entry;
        });
      } else {
        entries = [...state.entries, entry];
      }
      useAgent.setState({ entries, activityAt: now });
      break;
    }
    case "delta":
      useAgent.setState({
        activityAt: now,
        entries: state.entries.map((entry) => (entry.id === event.id ? { ...entry, text: entry.text + String(event.text) } : entry)),
      });
      break;
    case "status":
      useAgent.setState({ running: Boolean(event.running), activityAt: now });
      break;
    case "reset":
      useAgent.setState({ entries: [], running: false });
      break;
  }
  const after = useAgent.getState();
  chats.set(after.project!, { entries: after.entries, running: after.running });
}

// Remember every loaded chat (including optimistic sends) for instant reopening.
useAgent.subscribe((state) => {
  if (state.project && state.loaded) chats.set(state.project, { entries: state.entries, running: state.running });
});
