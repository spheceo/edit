// Edit's built-in agent (agent.rs): Codex through `codex app-server`
// (JSON-RPC 2.0 over newline-delimited stdio), using the user's own `codex
// login`.
//
// Edit's MCP server is injected per thread (`/mcp?project=<id>`), so a chat
// can only touch its own project, with its tools pre-approved. The user's
// other MCP servers, apps and plugins are switched off and the sandbox is
// read-only: the agent edits through Edit's tools and nothing else.
//
// `ask` is the one-off question other packages use (speakers.ts names voices
// with it): an ephemeral thread, no chat.

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import { nowMs, writeAtomic } from "./files.ts";
import { crashed, isBug } from "./guard.ts";
import { INSTRUCTIONS, toolReference } from "./mcp/index.ts";
import { join, withExtension } from "./paths.ts";
import { compareStrings, takeChars, trim, charCount } from "./rust.ts";
import * as seams from "./seams.ts";
import { stableStringify } from "./stable.ts";
import type { Store } from "./store.ts";
import { VERSION } from "./version.ts";

type Json = unknown;

/** How long a cached model list is trusted before a background refresh. */
const MODELS_TTL_MS = 24 * 3600 * 1000;

export interface Entry {
  id: string;
  /** "user", "assistant", "tool", "error" or "thinking". */
  kind: string;
  text: string;
  tool?: string;
  status?: string;
  /** Full tool arguments / error, shown when a tool row is expanded. */
  detail?: string;
  /** When it appeared and last changed (ms), for "Worked for 12s". */
  at: number;
  updated: number;
}

/** A project's chat: what's saved (thread, model, effort, entries) and the running turn's state. */
export interface Chat {
  thread: string | null;
  model: string | null;
  effort: string | null;
  entries: Entry[];
  turn: string | null;
  running: boolean;
  /** When the running turn started, to time it. */
  started: number | null;
  /** Turns restarted in a row after the model was at capacity. */
  retries: number;
  /** The user pressed stop: nothing restarts on its own until they send again. */
  halted: boolean;
  /** Identifies this work so retries cannot revive an old turn. */
  generation: number;
}

export interface Model {
  id: string;
  name: string;
  description: string;
  default_effort: string;
  efforts: string[];
  is_default: boolean;
}

interface ModelCache {
  fetched_ms: number;
  models: Model[];
}

function freshChat(): Chat {
  return { thread: null, model: null, effort: null, entries: [], turn: null, running: false, started: null, retries: 0, halted: false, generation: 0 };
}

function entry(fields: Partial<Entry> & { id: string; kind: string }): Entry {
  return { text: "", at: 0, updated: 0, ...fields };
}

/** An entry as serde writes it: its fields in order, the empty options left out. */
function entryJson(item: Entry): Record<string, unknown> {
  const out: Record<string, unknown> = { id: item.id, kind: item.kind, text: item.text };
  if (item.tool !== undefined) out.tool = item.tool;
  if (item.status !== undefined) out.status = item.status;
  if (item.detail !== undefined) out.detail = item.detail;
  out.at = item.at;
  out.updated = item.updated;
  return out;
}

/** A `json!` value as Rust sent it out: keys sorted. */
function sorted<T>(value: T): T {
  return JSON.parse(stableStringify(value)) as T;
}

/**
 * How long a "ready" status is answered from memory. Checking runs Codex
 * twice (Node starting up: 2–8 s a call on this Mac), and the panel and the
 * setup card ask on every project opened. Not-ready is never kept, so a
 * fresh `codex login` shows at once.
 */
export const READY_FOR_MS = 300_000;

/** `cached` when it's still fresh at `now`. */
export function stillReady(cached: [number, Json] | null, now: number): Json | null {
  if (cached === null) return null;
  return now - cached[0] < READY_FOR_MS ? cached[1] : null;
}

/** A one-off question's answer as it streams in. */
interface Ask {
  text: string;
  done: ((result: { ok: string } | { error: string }) => void) | null;
}

/** How time passes and work waits (tests move them). */
export const timing = {
  now: () => performance.now(),
  sleep: (ms: number) => Bun.sleep(ms),
};

/** A mutex for async work (tokio's Mutex, as agent.rs held them). */
class Lock {
  private tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = this.tail;
    this.tail = before.then(() => next);
    await before;
    return release;
  }
}

export class Agents implements seams.Agents {
  private dir: string;
  private codexProcess: Codex | null = null;
  private codexLock = new Lock();
  private chats = new Map<string, Chat>();
  private sending = new Map<string, Lock>();
  private nextGeneration = 1;
  /** Codex thread id → Edit project id. */
  readonly threads = new Map<string, string>();
  private modelCache: ModelCache | null;
  private refreshing = false;
  /** One-off questions (see `ask`) by Codex thread id. */
  private asks = new Map<string, Ask>();
  /** The last "ready" status and when it was found (see `status`). */
  private ready: [number, Json] | null = null;
  /** Starts Codex (tests put a stand-in here). */
  spawnCodex: (onMessage: (message: Record<string, unknown>) => void) => Promise<Codex> = (onMessage) =>
    Codex.spawn(onMessage);

  constructor(
    private store: Store,
    home: string,
    private port: number,
  ) {
    this.dir = join(home, "agent");
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {
      // Saving says so when it fails.
    }
    let models: ModelCache | null = null;
    try {
      const value = JSON.parse(fs.readFileSync(join(this.dir, "models.json"), "utf8")) as ModelCache;
      if (typeof value?.fetched_ms === "number" && Array.isArray(value.models)) models = value;
    } catch {
      models = null;
    }
    this.modelCache = models;
  }

  /**
   * Whether Codex is installed and logged in (cheap; no app-server needed).
   * `state` is "missing", "logged_out" or "ready".
   */
  async status(): Promise<Json> {
    const now = timing.now();
    const cached = stillReady(this.ready, now);
    if (cached !== null) return cached;
    const status = await checkCodex();
    if ((status as { ready?: unknown }).ready === true) this.ready = [now, status];
    return status;
  }

  /** The running app-server, started (and initialized) when there's none. */
  async codex(): Promise<Codex> {
    const release = await this.codexLock.acquire();
    try {
      if (this.codexProcess !== null && this.codexProcess.alive) return this.codexProcess;
      const codex = await this.spawnCodex((message) => this.onMessage(message));
      await codex.call(
        "initialize",
        { clientInfo: { name: "edit", title: "Edit", version: VERSION } },
        20_000,
      );
      codex.notify("initialized", null);
      // Threads from a previous process must be resumed before new turns.
      this.threads.clear();
      this.codexProcess = codex;
      return codex;
    } finally {
      release();
    }
  }

  /** Puts a Codex in place without starting one (tests). */
  useCodex(codex: Codex | null): void {
    this.codexProcess = codex;
  }

  /** Holds the Codex lock (tests: a Codex still starting up). */
  holdCodex(): Promise<() => void> {
    return this.codexLock.acquire();
  }

  // --- models --------------------------------------------------------------

  /** Cached models, refreshed in the background once a day (or now with `refresh`). */
  async models(refresh: boolean): Promise<Json> {
    const cached = this.modelCache;
    if (cached !== null && !refresh) {
      if (nowMs() - cached.fetched_ms > MODELS_TTL_MS) {
        void this.fetchModels().catch((error: unknown) => {
          if (isBug(error)) crashed("refreshing models", error);
        });
      }
      return { models: withConfiguredEffort(cached.models), fetched_ms: cached.fetched_ms };
    }
    const cache = await this.fetchModels();
    return { models: withConfiguredEffort(cache.models), fetched_ms: cache.fetched_ms };
  }

  private async fetchModels(): Promise<ModelCache> {
    const was = this.refreshing;
    this.refreshing = true;
    // Another refresh is in flight; serve what we have.
    if (was && this.modelCache !== null) return this.modelCache;
    try {
      const codex = await this.codex();
      const models: Model[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page = (await codex.call("model/list", { cursor }, 30_000)) as Record<string, unknown> | null;
        const data = Array.isArray(page?.data) ? (page.data as Record<string, unknown>[]) : [];
        for (const row of data) {
          if (row?.hidden === true) continue;
          const str = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);
          const efforts = Array.isArray(row.supportedReasoningEfforts)
            ? (row.supportedReasoningEfforts as Record<string, unknown>[])
                .map((effort) => effort?.reasoningEffort)
                .filter((effort): effort is string => typeof effort === "string")
            : [];
          models.push({
            id: str(row.id),
            name: str(row.displayName),
            description: str(row.description),
            default_effort: str(row.defaultReasoningEffort, "medium"),
            efforts,
            is_default: row.isDefault === true,
          });
        }
        cursor = typeof page?.nextCursor === "string" ? page.nextCursor : null;
        if (cursor === null) break;
      }
      const cache: ModelCache = { fetched_ms: nowMs(), models };
      try {
        fs.writeFileSync(join(this.dir, "models.json"), JSON.stringify(cache, null, 2));
      } catch {
        // Fetched again next time.
      }
      this.modelCache = cache;
      return cache;
    } finally {
      this.refreshing = false;
    }
  }

  // --- chats ---------------------------------------------------------------

  /** A project's chat from disk: beside the project, or where Edit used to keep chats. */
  private load(project: string): Chat {
    const path = this.store.chatPath(project);
    const old = join(this.dir, "chats", `${project}.json`);
    if (!fs.existsSync(path) && fs.existsSync(old)) {
      try {
        fs.renameSync(old, path);
      } catch {
        // Read from where it is next time.
      }
    }
    let text: string;
    try {
      text = fs.readFileSync(path, "utf8");
    } catch {
      return freshChat();
    }
    try {
      return readChat(text);
    } catch (error) {
      // Never overwrite a chat we can't read: set it aside and start fresh.
      diag.warn("agent", `agent chat ${path}: ${diag.messageOf(error)}`);
      try {
        fs.renameSync(path, withExtension(path, `unreadable-${nowMs()}`));
      } catch {
        // It's still there; the next save writes over it.
      }
      return freshChat();
    }
  }

  /** The project's chat (loaded the first time), to read or change in place. */
  withChat(project: string): Chat {
    let chat = this.chats.get(project);
    if (chat === undefined) {
      chat = this.load(project);
      this.chats.set(project, chat);
    }
    return chat;
  }

  private save(project: string): void {
    const chat = this.withChat(project);
    const snapshot = { thread: chat.thread, model: chat.model, effort: chat.effort, entries: chat.entries.map(entryJson) };
    try {
      writeAtomic(this.store.chatPath(project), JSON.stringify(snapshot));
    } catch {
      // Kept in memory; the next save tries again.
    }
  }

  chat(project: string): Json {
    const chat = this.withChat(project);
    return sorted({ entries: chat.entries.map(entryJson), running: chat.running, model: chat.model, effort: chat.effort });
  }

  reset(project: string): void {
    const chat = this.withChat(project);
    const thread = chat.thread;
    this.chats.set(project, freshChat());
    if (thread !== null) this.threads.delete(thread);
    fs.rmSync(this.store.chatPath(project), { force: true });
    this.emit(project, { event: "reset" });
  }

  private emit(project: string, event: Record<string, unknown>): void {
    this.store.emit(sorted({ ...event, type: "agent", project }));
  }

  private upsert(project: string, given: Entry): void {
    const now = nowMs();
    const chat = this.withChat(project);
    const existing = chat.entries.findIndex((item) => item.id === given.id);
    let saved: Entry;
    if (existing >= 0) {
      saved = { ...given, at: chat.entries[existing]!.at, updated: now };
      chat.entries[existing] = saved;
    } else {
      saved = { ...given, at: now, updated: now };
      chat.entries.push(saved);
    }
    this.emit(project, { event: "entry", entry: entryJson(saved) });
  }

  /** Sends a message, starting or resuming the project's Codex thread. */
  send(project: string, text: string, model: string | null, effort: string | null): Promise<void> {
    return this.sendTurn(project, text, model, effort, null);
  }

  private async sendTurn(
    project: string,
    text: string,
    model: string | null,
    effort: string | null,
    generation: number | null,
  ): Promise<void> {
    if (this.store.get(project) === null) throw new Error("no such project");
    let sending = this.sending.get(project);
    if (sending === undefined) {
      sending = new Lock();
      this.sending.set(project, sending);
    }
    // A very short turn can complete before turn/start's reply is handled.
    // Queue its next step until that startup has released the slot.
    const release = await sending.acquire();
    try {
      const chat = this.withChat(project);
      if (generation !== null && (chat.generation !== generation || chat.halted)) return;
      if (chat.running) throw new Error("the agent is still working; stop it or wait");
      if (generation === null) {
        chat.generation = this.nextGeneration++;
        chat.halted = false;
        chat.retries = 0;
      }
      chat.running = true;
      chat.started = timing.now();
      const current = chat.generation;
      this.emit(project, { event: "status", running: true });
      try {
        await this.prepareTurn(project, text, model, effort, current);
      } catch (error) {
        const said = isBug(error) ? crashed("the agent turn", error) : diag.messageOf(error);
        const now = this.withChat(project);
        if (now.generation === current && now.running) this.finish(project, said);
        throw new Error(said);
      }
    } finally {
      release();
    }
  }

  private async prepareTurn(
    project: string,
    text: string,
    model: string | null,
    effort: string | null,
    generation: number,
  ): Promise<void> {
    const live = this.store.get(project);
    if (live === null) throw new Error("no such project");
    const codex = await this.codex();
    const chat = this.withChat(project);
    if (!(chat.generation === generation && !chat.halted)) throw new Error("Stopped.");
    chat.model = model ?? chat.model;
    chat.effort = effort ?? chat.effort;
    const known = chat.thread !== null && this.threads.has(chat.thread);
    const previous = chat.thread;
    const workspace = join(this.dir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const config = {
      // A model answers several times slower with 300k tokens to read than
      // with 100k (a whole edit's chat reached 340k): compact well before
      // that, so a long conversation stays quick.
      model_auto_compact_token_limit: 150_000,
      mcp_servers: {
        edit: {
          url: `http://127.0.0.1:${this.port}/mcp?project=${project}`,
          default_tools_approval_mode: "approve",
          startup_timeout_sec: 15,
          // caption_speakers watches footage with a model: minutes, not seconds.
          tool_timeout_sec: 900,
        },
      },
    };
    const { settings } = live.project;
    const instructions =
      `You are the agent built into Edit, a video editor. The user is watching the editor while you work: every change you make through the \`edit\` tools appears live on their timeline and can be undone with ⌘Z. ` +
      `Edit only through the \`edit\` tools; you have no shell or files. The project is "${live.project.name}" (${settings.width}x${settings.height} at ${settings.fps} fps). ` +
      "Every tool call is a round trip the user waits on, so work in as few as you can (see WORK FAST): start with get_edit_context (narrowed to the part you're working on; never get_project), make the changes you've decided in one apply_edit_plan and the tools that place sounds, images or text in one batch, then look once with the plan's review_frames or one contact_sheet and fix only what's actually wrong. Don't re-read what you've read or re-check work that hasn't changed. " +
      "When a tool is still running (watch_footage, map_view, export), wait for it in long blocks (yield_time_ms 30000 or more), never second by second. " +
      "When the user asks you to start the edit or the editing workflow (in whatever words), load the edit-workflow skill and do the whole edit in that one turn, stage after stage, without stopping to ask; anything else in their message steers it. For other requests, load the skill for the part you're working on (see SKILLS). " +
      `Keep replies short: say what you changed and where (timecodes).\n\n${INSTRUCTIONS}\n\n${seams.styles.instructions(live.project.style)}\n\nThe edit tools (in exec: tools.mcp__edit__<name>({…}); their full declarations are in ALL_TOOLS, but this list is usually enough):\n${toolReference()}`;
    let thread: string;
    if (previous !== null && known) {
      thread = previous;
    } else if (previous !== null) {
      // Edit restarted: pick the conversation back up.
      try {
        await codex.call(
          "thread/resume",
          {
            threadId: previous,
            cwd: workspace,
            approvalPolicy: "never",
            sandbox: "read-only",
            config,
            developerInstructions: instructions,
          },
          30_000,
        );
        thread = previous;
      } catch (error) {
        if (isBug(error)) throw error;
        thread = await this.startThread(codex, config, instructions, workspace);
      }
    } else {
      thread = await this.startThread(codex, config, instructions, workspace);
    }
    this.threads.set(thread, project);
    const now = this.withChat(project);
    if (now.generation !== generation || now.halted) throw new Error("Stopped.");
    now.thread = thread;
    const selection = { model: now.model, effort: now.effort };
    this.upsert(project, entry({ id: `user-${nowMs()}`, kind: "user", text }));
    this.save(project);
    this.emit(project, { event: "status", running: true });
    const params: Record<string, unknown> = {
      threadId: thread,
      input: [{ type: "text", text, text_elements: [] }],
      approvalPolicy: "never",
    };
    if (selection.model !== null) params.model = selection.model;
    if (selection.effort !== null) params.effort = selection.effort;
    // Dispatched right after the last check (nothing can run in between), so
    // a stop can't land between the check and writing the request to Codex.
    const check = this.withChat(project);
    if (check.generation !== generation || check.halted) throw new Error("Stopped.");
    const request = codex.request("turn/start", params);
    const turn = (await codex.response("turn/start", request, 30_000)) as { turn?: { id?: unknown } } | null;
    const id = typeof turn?.turn?.id === "string" ? turn.turn.id : null;
    const after = this.withChat(project);
    let stopped = false;
    if (after.generation !== generation || (after.halted && after.running)) stopped = true;
    else if (after.running) after.turn = id;
    // Stop can arrive before turn/start returns the turn id.
    if (stopped) {
      if (id !== null) await codex.call("turn/interrupt", { threadId: thread, turnId: id }, 15_000);
      throw new Error("Stopped.");
    }
    this.save(project);
  }

  /**
   * Asks a model one question through Codex, outside any chat and with no
   * tools: text, images (`localImage`) and sound (`localAudio`) in, its
   * final answer out, held to `schema` (a JSON Schema) when given.
   */
  async ask(
    model: string,
    effort: string,
    instructions: string,
    input: Json[],
    schema: Json | null,
    timeoutMs: number,
  ): Promise<string> {
    const codex = await this.codex();
    const workspace = join(this.dir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const started = (await codex.call(
      "thread/start",
      {
        cwd: workspace,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        developerInstructions: instructions,
        serviceName: "edit",
      },
      30_000,
    )) as { thread?: { id?: unknown } } | null;
    const thread = started?.thread?.id;
    if (typeof thread !== "string") throw new Error("Codex didn't start a thread");
    const answer = new Promise<{ ok: string } | { error: string }>((resolve) => {
      this.asks.set(thread, { text: "", done: resolve });
    });
    const params: Record<string, unknown> = { threadId: thread, input, model, effort, approvalPolicy: "never" };
    if (schema !== null && schema !== undefined) params.outputSchema = schema;
    try {
      await codex.call("turn/start", params, 60_000);
      let timer: ReturnType<typeof setTimeout> | null = null;
      const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      });
      const result = await Promise.race([answer, late]);
      if (timer !== null) clearTimeout(timer);
      if (result === null) throw new Error(`${model} didn't answer in time`);
      if ("error" in result) throw new Error(result.error);
      return result.ok;
    } finally {
      this.asks.delete(thread);
    }
  }

  /** Routes a notification to a one-off question; true when it was one. */
  private answer(thread: string, method: string, params: Record<string, unknown>): boolean {
    const ask = this.asks.get(thread);
    if (ask === undefined) return false;
    const item = params.item as Record<string, unknown> | undefined;
    if (method === "item/completed" && item?.type === "agentMessage") {
      ask.text = typeof item.text === "string" ? item.text : "";
    } else if (method === "turn/completed") {
      const turn = (params.turn ?? {}) as Record<string, unknown>;
      let result: { ok: string } | { error: string };
      if (turn.status === "failed") {
        const message = (turn.error as { message?: unknown } | undefined)?.message;
        result = { error: typeof message === "string" ? message : "The model failed" };
      } else if (turn.status === "interrupted") {
        result = { error: "Stopped." };
      } else {
        result = { ok: ask.text };
        ask.text = "";
      }
      const done = ask.done;
      ask.done = null;
      done?.(result);
    }
    return true;
  }

  private async startThread(codex: Codex, config: Json, instructions: string, workspace: string): Promise<string> {
    const started = (await codex.call(
      "thread/start",
      {
        cwd: workspace,
        approvalPolicy: "never",
        sandbox: "read-only",
        config,
        developerInstructions: instructions,
        serviceName: "edit",
      },
      30_000,
    )) as { thread?: { id?: unknown } } | null;
    const id = started?.thread?.id;
    if (typeof id !== "string") throw new Error("Codex didn't start a thread");
    return id;
  }

  async stop(project: string): Promise<void> {
    const chat = this.withChat(project);
    chat.halted = true;
    const { thread, turn } = chat;
    if (thread === null || turn === null) return;
    const codex = await this.codex();
    await codex.call("turn/interrupt", { threadId: thread, turnId: turn }, 15_000);
  }

  private finish(project: string, error: string | null): void {
    const chat = this.withChat(project);
    if (error === null) chat.retries = 0;
    const started = chat.started;
    chat.started = null;
    if (started !== null) diag.record("agent", "agent turn", timing.now() - started, error);
    if (error !== null) this.upsert(project, entry({ id: `error-${nowMs()}`, kind: "error", text: error }));
    const now = nowMs();
    chat.running = false;
    chat.turn = null;
    const last = chat.entries[chat.entries.length - 1];
    if (last !== undefined) last.updated = Math.max(last.updated, now);
    // A turn that ended mid-tool leaves it unresolved; mark it.
    for (const item of chat.entries) {
      if (item.status === "running") item.status = "stopped";
    }
    this.save(project);
    this.emit(project, { event: "status", running: false });
  }

  /** Codex notifications, mapped onto the chat of the project their thread belongs to. */
  onMessage(message: Record<string, unknown>): void {
    const method = typeof message.method === "string" ? message.method : "";
    const params = (typeof message.params === "object" && message.params !== null ? message.params : {}) as Record<string, unknown>;
    // The process is gone: no turn of it will ever complete, so end them now.
    if (method === EXITED) {
      const running = [...this.chats].filter(([, chat]) => chat.running).map(([project]) => project);
      for (const project of running) {
        this.withChat(project).halted = true;
        this.finish(project, "Codex stopped unexpectedly; send your message again.");
      }
      return;
    }
    const thread = params.threadId;
    if (typeof thread !== "string") return;
    if (this.answer(thread, method, params)) return;
    const project = this.threads.get(thread);
    if (project === undefined) return;
    switch (method) {
      case "item/agentMessage/delta": {
        const id = typeof params.itemId === "string" ? params.itemId : "";
        const delta = typeof params.delta === "string" ? params.delta : "";
        const found = this.withChat(project).entries.find((item) => item.id === id);
        if (found !== undefined) found.text += delta;
        this.emit(project, { event: "delta", id, text: delta });
        break;
      }
      case "item/started":
      case "item/completed": {
        const item = (params.item ?? {}) as Record<string, unknown>;
        const id = typeof item.id === "string" ? item.id : "";
        const done = method === "item/completed";
        switch (item.type) {
          case "agentMessage": {
            let text = typeof item.text === "string" ? item.text : "";
            // Keep streamed text if the start event arrives empty.
            if (!done) {
              const streamed = this.withChat(project).entries.find((existing) => existing.id === id);
              if (streamed !== undefined) text = streamed.text;
            }
            this.upsert(project, entry({ id, kind: "assistant", text }));
            break;
          }
          case "mcpToolCall": {
            const status =
              item.status === "completed" ? "done" : item.status === "failed" ? "failed" : done ? "done" : "running";
            const failure = (item.error as { message?: unknown } | undefined)?.message;
            const text = typeof failure === "string" ? failure : summarizeArgs(item.arguments);
            const tool: Partial<Entry> = typeof item.tool === "string" ? { tool: item.tool } : {};
            this.upsert(
              project,
              entry({ id, kind: "tool", text, ...tool, status, detail: stableStringify(item.arguments ?? null, 2) }),
            );
            break;
          }
          case "reasoning":
            this.emit(project, { event: "thinking", active: !done });
            break;
          default:
            break;
        }
        if (done) this.save(project);
        break;
      }
      case "error": {
        if (params.willRetry !== true) {
          const said = (params.error as { message?: unknown } | undefined)?.message;
          this.upsert(
            project,
            entry({ id: `error-${nowMs()}`, kind: "error", text: typeof said === "string" ? said : "Codex reported an error" }),
          );
        }
        break;
      }
      case "turn/completed": {
        const turn = (params.turn ?? {}) as Record<string, unknown>;
        let error: string | null = null;
        if (turn.status === "failed") {
          const said = (turn.error as { message?: unknown } | undefined)?.message;
          error = typeof said === "string" ? said : "The turn failed";
        } else if (turn.status === "interrupted") {
          error = "Stopped.";
        }
        const chat = this.withChat(project);
        const { halted, generation } = chat;
        if (error !== null && busyModel(error) && !halted) {
          chat.retries += 1;
          const tries = chat.retries;
          if (tries <= MAX_RETRIES) {
            // Wait a little longer each time, then pick the work back up.
            const wait = 20 * tries;
            this.finish(project, `${error} Trying again in ${wait} s (${tries} of ${MAX_RETRIES}).`);
            const failure = error;
            void (async () => {
              await timing.sleep(wait * 1000);
              // The user may have sent something else, or stopped, meanwhile.
              const later = this.withChat(project);
              if (later.running || later.halted || later.generation !== generation) return;
              const text = `(Edit, automatically) Your last turn was cut off by an error ("${failure}") before you finished. Carry on from where you stopped: get_edit_context shows what's already done; then finish the task.`;
              try {
                await this.sendTurn(project, text, null, null, generation);
              } catch (thrown) {
                diag.warn("agent", `retrying the turn in ${project}: ${diag.messageOf(thrown)}`);
              }
            })();
            return;
          }
        }
        this.finish(project, error);
        break;
      }
      default:
        break;
    }
  }
}

/** A saved chat, read as serde reads `Chat` (every field defaults; a wrong type refuses the whole file). */
export function readChat(text: string): Chat {
  const value = JSON.parse(text) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid type: expected struct Chat");
  const given = value as Record<string, unknown>;
  const option = (name: string): string | null => {
    const field = given[name];
    if (field === undefined || field === null) return null;
    if (typeof field !== "string") throw new Error(`${name}: invalid type, expected a string`);
    return field;
  };
  const chat = freshChat();
  chat.thread = option("thread");
  chat.model = option("model");
  chat.effort = option("effort");
  const entries = given.entries;
  if (entries !== undefined) {
    if (!Array.isArray(entries)) throw new Error("entries: invalid type, expected a sequence");
    for (const item of entries as unknown[]) {
      if (typeof item !== "object" || item === null) throw new Error("entries: invalid type, expected struct Entry");
      const fields = item as Record<string, unknown>;
      if (typeof fields.id !== "string") throw new Error("missing field `id`");
      if (typeof fields.kind !== "string") throw new Error("missing field `kind`");
      const read: Entry = {
        id: fields.id,
        kind: fields.kind,
        text: typeof fields.text === "string" ? fields.text : "",
        at: typeof fields.at === "number" ? fields.at : 0,
        updated: typeof fields.updated === "number" ? fields.updated : 0,
      };
      for (const name of ["tool", "status", "detail"] as const) {
        if (typeof fields[name] === "string") read[name] = fields[name] as string;
      }
      chat.entries.push(read);
    }
  }
  return chat;
}

/** A one-line view of tool arguments for the chat ("text: Your title · start: 2"). */
export function summarizeArgs(argumentsValue: unknown): string {
  if (typeof argumentsValue !== "object" || argumentsValue === null || Array.isArray(argumentsValue)) return "";
  const object = argumentsValue as Record<string, unknown>;
  const text = Object.keys(object)
    .sort(compareStrings)
    .filter((key) => key !== "project_id")
    .map((key) => {
      const value = object[key];
      const shown = typeof value === "string" ? value : stableStringify(value ?? null);
      return `${key}: ${takeChars(shown, 60)}`;
    });
  let joined = text.join(" · ");
  if (charCount(joined) > 140) joined = `${takeChars(joined, 140)}…`;
  return joined;
}

function codexHome(): string | null {
  const given = process.env.CODEX_HOME;
  if (given !== undefined) return given;
  const home = process.env.HOME;
  return home !== undefined ? join(home, ".codex") : null;
}

/** MCP server names in the user's `~/.codex/config.toml` (`[mcp_servers.NAME]` tables). */
export function userMcpServers(): string[] {
  const home = codexHome() ?? "";
  let config: string;
  try {
    config = fs.readFileSync(join(home, "config.toml"), "utf8");
  } catch {
    return [];
  }
  return mcpServersIn(config);
}

export function mcpServersIn(config: string): string[] {
  const names = new Set<string>();
  for (const line of config.split("\n")) {
    const trimmed = trim(line.endsWith("\r") ? line.slice(0, -1) : line);
    if (!trimmed.startsWith("[mcp_servers.") || !trimmed.endsWith("]")) continue;
    const name = trimmed.slice("[mcp_servers.".length, -1);
    const first = (name.split(".")[0] ?? "").replace(/^"+|"+$/g, "");
    if (first !== "" && first !== "edit") names.add(first);
  }
  return [...names].sort(compareStrings);
}

/** A TOML key, quoted when it isn't a bare key (e.g. `computer-use` is fine, `a b` isn't). */
export function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]*$/.test(name) ? name : `"${name.replaceAll('"', '\\"')}"`;
}

/** Whether `binary --version` runs and succeeds. */
async function runs(binary: string): Promise<boolean> {
  try {
    const child = Bun.spawn([binary, "--version"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
}

export async function findCodex(): Promise<string | null> {
  const home = process.env.HOME ?? "";
  const candidates = [
    "codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    join(home, ".local/bin/codex"),
    join(home, ".npm-global/bin/codex"),
  ];
  for (const candidate of candidates) {
    if (await runs(candidate)) return candidate;
  }
  return null;
}

async function checkCodex(): Promise<Json> {
  const binary = await findCodex();
  if (binary === null) {
    return sorted({
      provider: "codex",
      ready: false,
      state: "missing",
      error: "Codex isn't installed. Install it with `npm install -g @openai/codex`, then `codex login`.",
    });
  }
  // Both at once: each is a Node start-up.
  const version = (async () => {
    try {
      const child = Bun.spawn([binary, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      const text = trim(out);
      return text === "" ? null : text;
    } catch {
      return null;
    }
  })();
  const loggedIn = (async () => {
    try {
      const child = Bun.spawn([binary, "login", "status"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      return (await child.exited) === 0;
    } catch {
      return false;
    }
  })();
  const [said, logged] = await Promise.all([version, loggedIn]);
  if (!logged) {
    return sorted({
      provider: "codex",
      ready: false,
      state: "logged_out",
      path: binary,
      version: said,
      error: "Codex isn't logged in. Run `codex login` on the machine running Edit.",
    });
  }
  return sorted({ provider: "codex", ready: true, state: "ready", path: binary, version: said });
}

// ---------------------------------------------------------------------------
// The app-server process.

/** How many times in a row a turn cut off by a busy model is restarted. */
export const MAX_RETRIES = 3;

/** A turn that failed because the model was busy (worth trying again), not because of anything in the request. */
export function busyModel(error: string): boolean {
  const lower = error.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return ["at capacity", "overloaded", "temporarily unavailable", "try again later", "server_error", "503"].some((sign) =>
    lower.includes(sign),
  );
}

/** Sent to `onMessage` (by Edit, not Codex) when Codex's output ends. */
export const EXITED = "edit/codexExited";

type Reply = (result: { ok: unknown } | { error: string }) => void;

/** Where messages to Codex go: its stdin (or a test's list). */
export interface Transport {
  write(line: string): void;
  kill(): void;
}

export class Codex {
  /** Replies awaited, by request id. */
  readonly pending = new Map<number, Reply>();
  private next = 1;
  alive = true;

  constructor(
    private transport: Transport,
    private onMessage: (message: Record<string, unknown>) => void,
  ) {}

  static async spawn(onMessage: (message: Record<string, unknown>) => void): Promise<Codex> {
    const binary = await findCodex();
    if (binary === null) throw new Error("Codex isn't installed");
    // Only Edit's tools: switch off the user's own MCP servers, apps and
    // plugins (overrides merge into their config, so each server is disabled by name).
    const args = ["app-server", "--disable", "apps", "--disable", "plugins"];
    for (const name of userMcpServers()) args.push("-c", `mcp_servers.${tomlKey(name)}.enabled=false`);
    let child: Bun.Subprocess<"pipe", "pipe", "ignore">;
    try {
      child = Bun.spawn([binary, ...args], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    } catch (error) {
      throw new Error(`couldn't start Codex: ${diag.messageOf(error)}`);
    }
    const codex = new Codex(
      {
        write: (line) => {
          try {
            child.stdin.write(line);
            void child.stdin.flush();
          } catch {
            // Gone: the reader ends and says so.
          }
        },
        kill: () => child.kill(),
      },
      onMessage,
    );
    void codex.read(child.stdout as unknown as AsyncIterable<Uint8Array>);
    return codex;
  }

  /** Reads Codex's output line by line until it ends; then it's gone, and its callers are answered. */
  async read(stdout: AsyncIterable<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for await (const chunk of stdout) {
        buffered += decoder.decode(chunk, { stream: true });
        let at = buffered.indexOf("\n");
        while (at >= 0) {
          const line = buffered.slice(0, at);
          buffered = buffered.slice(at + 1);
          this.receive(line.endsWith("\r") ? line.slice(0, -1) : line);
          at = buffered.indexOf("\n");
        }
      }
      if (buffered !== "") this.receive(buffered);
    } catch (error) {
      if (isBug(error)) crashed("reading from Codex", error);
    }
    this.exited();
  }

  /** One line from Codex. */
  receive(line: string): void {
    let message: Record<string, unknown>;
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value !== "object" || value === null) return;
      message = value as Record<string, unknown>;
    } catch {
      return;
    }
    const hasMethod = "method" in message;
    const id = message.id;
    if (id !== undefined && !hasMethod) {
      // Response to one of our requests.
      if (typeof id !== "number") return;
      const reply = this.pending.get(id);
      if (reply === undefined) return;
      this.pending.delete(id);
      if ("error" in message) {
        const said = (message.error as { message?: unknown } | null)?.message;
        reply({ error: typeof said === "string" ? said : "Codex error" });
      } else {
        reply({ ok: message.result ?? null });
      }
    } else if (id !== undefined && hasMethod) {
      // A request from Codex (approvals, elicitations): Edit's tools are
      // pre-approved and nothing else is allowed.
      this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Edit only allows its own tools" } });
    } else if (hasMethod) {
      try {
        this.onMessage(message);
      } catch (error) {
        diag.warn("agent", `a Codex notification: ${isBug(error) ? crashed("handling Codex", error) : diag.messageOf(error)}`);
      }
    }
  }

  /** Codex's output ended. */
  exited(): void {
    this.alive = false;
    for (const reply of this.pending.values()) reply({ error: "Codex stopped" });
    this.pending.clear();
    this.onMessage({ method: EXITED });
  }

  private write(message: unknown): void {
    this.transport.write(`${JSON.stringify(message)}\n`);
  }

  /** Sends a request; its id and the reply to wait for. */
  request(method: string, params: unknown): [number, Promise<{ ok: unknown } | { error: string }>] {
    if (!this.alive) throw new Error("Codex stopped");
    const id = this.next++;
    const reply = new Promise<{ ok: unknown } | { error: string }>((resolve) => this.pending.set(id, resolve));
    this.write({ jsonrpc: "2.0", id, method, params });
    return [id, reply];
  }

  async response(method: string, [id, reply]: [number, Promise<{ ok: unknown } | { error: string }>], timeoutMs: number): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const result = await Promise.race([reply, late]);
    if (timer !== null) clearTimeout(timer);
    if (result === null) {
      this.pending.delete(id);
      throw new Error(`Codex didn't answer ${method} in time`);
    }
    if ("error" in result) throw new Error(result.error);
    return result.ok;
  }

  call(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return this.response(method, this.request(method, params), timeoutMs);
  }

  notify(method: string, params: unknown): void {
    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== null && params !== undefined) message.params = params;
    this.write(message);
  }

  kill(): void {
    this.transport.kill();
  }
}

/**
 * The reasoning effort the user's Codex config sets (`model_reasoning_effort`
 * in ~/.codex/config.toml, before any [section]): Codex uses it whenever a
 * turn names none, so it, not the model list's own default, is the default.
 */
export function configuredEffort(): string | null {
  const home = codexHome();
  if (home === null) return null;
  let text: string;
  try {
    text = fs.readFileSync(join(home, "config.toml"), "utf8");
  } catch {
    return null;
  }
  return effortIn(text);
}

export function effortIn(text: string): string | null {
  for (const raw of text.split("\n")) {
    const line = trim(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    if (line.startsWith("[")) break;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    if (trim(line.slice(0, eq)) !== "model_reasoning_effort") continue;
    const value = trim(line.slice(eq + 1)).replace(/^"+|"+$/g, "");
    return value === "" ? null : value;
  }
  return null;
}

/**
 * Edit's own default thinking level: its edits are mostly the house style
 * applied again and again, which medium does as well as high in far less
 * time. The user can still pick another in the agent panel.
 */
const DEFAULT_EFFORT = "medium";

/** The models with the default each will really use: Edit's, else the one the user's Codex config sets. */
export function withConfiguredEffort(models: Model[], configured: string | null = configuredEffort()): Model[] {
  return models.map((model) => {
    const effort = [DEFAULT_EFFORT, configured].find((candidate) => candidate !== null && model.efforts.includes(candidate));
    return effort !== undefined && effort !== null ? { ...model, default_effort: effort } : { ...model };
  });
}
