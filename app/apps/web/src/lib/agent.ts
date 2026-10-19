import { readSetting, writeSetting } from "./storage";
// The agent chat: the user's Claude Code or Codex, through Edit's server (apps/server/src/agent.ts).

import { create } from "zustand";

import { fetchRetrying } from "./api";

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

export interface AgentModel {
  id: string;
  name: string;
  description: string;
  default_effort: string;
  efforts: string[];
  is_default: boolean;
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
  models: AgentModel[];
  project: string | null;
  /** This project's chat has been fetched (until then show nothing, not the empty state). */
  loaded: boolean;
  entries: AgentEntry[];
  running: boolean;
  /** Last streamed or changed moment, so "Thinking" only shows after a quiet spell. */
  activityAt: number;
  model: string | null;
  effort: string | null;
}

const cachedModels = (): AgentModel[] => {
  try {
    return JSON.parse(readSetting("edit.agent.models") ?? "[]");
  } catch {
    return [];
  }
};

export const useAgent = create<AgentState>(() => ({
  status: null,
  models: cachedModels(),
  project: null,
  loaded: false,
  entries: [],
  running: false,
  activityAt: 0,
  model: readSetting("edit.agent.model"),
  effort: readSetting("edit.agent.effort"),
}));

/** Chats already seen this session, so reopening the panel or a project is instant. */
const chats = new Map<string, { entries: AgentEntry[]; running: boolean }>();

const json = async <T>(response: Response): Promise<T> => {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `request failed (${response.status})`);
  return body as T;
};

export const EFFORT_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

/** The agent's name as the panel shows it. */
export const providerName = (status: AgentStatus | null) => (status?.provider === "codex" ? "Codex" : "Claude Code");

/** Fetches the models of the provider now chosen. */
async function refreshModels() {
  const { models } = await json<{ models: AgentModel[] }>(await fetchRetrying("/api/agent/models"));
  writeSetting("edit.agent.models", JSON.stringify(models));
  useAgent.setState({ models });
}

/** Switches the agent to Claude Code or Codex; the next message in each chat starts a new conversation there. */
export async function chooseProvider(provider: AgentProvider) {
  const status = await json<AgentStatus>(
    await fetchRetrying("/api/agent/provider", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider }),
    }),
  );
  // Each provider names its models its own way.
  writeSetting("edit.agent.models", "[]");
  useAgent.setState({ status, models: [], model: null, effort: null });
  writeSetting("edit.agent.model", "");
  writeSetting("edit.agent.effort", "");
  if (status.ready) await refreshModels().catch(() => {});
  return status;
}

/** The selected model, falling back to the provider's default. */
export function currentModel(state = useAgent.getState()) {
  return state.models.find((model) => model.id === state.model) ?? state.models.find((model) => model.is_default) ?? state.models[0];
}

/** The selected thinking level, kept valid for the current model. */
export function currentEffort(state = useAgent.getState()) {
  const model = currentModel(state);
  if (!model) return state.effort ?? "medium";
  return state.effort && model.efforts.includes(state.effort) ? state.effort : model.default_effort;
}

export function chooseModel(id: string) {
  writeSetting("edit.agent.model", id);
  useAgent.setState({ model: id });
}

export function chooseEffort(effort: string) {
  writeSetting("edit.agent.effort", effort);
  useAgent.setState({ effort });
}

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
      json<{ entries: AgentEntry[]; running: boolean; model: string | null; effort: string | null }>(response),
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
    ...(chat.model ? { model: chat.model } : {}),
    ...(chat.effort ? { effort: chat.effort } : {}),
  });
  if (status.ready) refreshModels().catch(() => {});
}

export async function sendToAgent(text: string) {
  const state = useAgent.getState();
  if (!state.project) return;
  const model = currentModel(state);
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
      body: JSON.stringify({ text, model: model?.id, effort: currentEffort(state) }),
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
