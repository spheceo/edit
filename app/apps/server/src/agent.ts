// Edit's built-in agent, on one of two providers the user picks in
// Settings: Claude Code (`claude.ts`: the user's own `claude` through
// Anthropic's Agent SDK, on their own sign-in; the default) or Codex through `codex app-server`
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

import * as claude from "./claude.ts";
import { ClaudeSupport, type SupportAction, type SupportStatus } from "./claude_support.ts";
import * as diag from "./diag.ts";
import * as reviewGuard from "./review_guard.ts";
import { nowMs, writeAtomic } from "./files.ts";
import { crashed, isBug } from "./guard.ts";
import { INSTRUCTIONS, toolReference } from "./mcp/index.ts";
import { join, withExtension } from "./paths.ts";
import { rateText } from "./project.ts";
import { compareStrings, takeChars, trim, charCount } from "./rust.ts";
import * as seams from "./seams.ts";
import { stableStringify } from "./stable.ts";
import type { Project } from "./model.ts";
import type { Store } from "./store.ts";
import { VERSION } from "./version.ts";

type Json = unknown;

/** Where the agent runs: the user's Claude Code (Claude) or Codex. */
export type Provider = "claude" | "codex";

export const DEFAULT_PROVIDER: Provider = "claude";

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
  /** The provider the thread belongs to ("codex" or "claude"); another's thread isn't resumed. */
  provider: Provider | null;
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
  /** The provider the running turn is on (null between turns): only Codex's going away ends a Codex turn. */
  on: Provider | null;
  /** When the running turn last heard from its agent (`timing.now()`), to end one that stopped answering. */
  heard: number;
  /** Edit ended the running turn itself (stopped, stalled, quitting): a Codex turn id arriving after is interrupted. */
  dropped: boolean;
  /** A message already resumed or explicitly cancelled: never adopt it again from old history. */
  authRecoveryUser: string | null;
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
  return {
    provider: null,
    thread: null,
    model: null,
    effort: null,
    entries: [],
    turn: null,
    running: false,
    started: null,
    retries: 0,
    halted: false,
    generation: 0,
    on: null,
    heard: 0,
    dropped: false,
    authRecoveryUser: null,
  };
}

let entries = 0;

/** A new entry's id: "error-<ms>-<n>" (two in one millisecond, a stall then a quit, mustn't be one entry). */
function newId(kind: string): string {
  entries += 1;
  return `${kind}-${nowMs()}-${entries}`;
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

function authFailure(item: Entry): boolean {
  return item.kind === "error" && (claude.signInProblem(item.text) || item.text === claude.SIGN_IN_AGAIN || /^Claude (needs to sign in again|still rejected its sign-in)/u.test(item.text));
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
  /** Runs `work` after `ms`. */
  later: (ms: number, work: () => void) => later(ms, work),
};

/** How long a stopped turn may take to end before Edit ends it itself (an interrupt lost, a process hung). */
export const STOP_GRACE_MS = 15_000;

/**
 * How long a turn may go without a word from its agent before it's ended.
 * A tool call gives up after 15 minutes (`MCP_TOOL_TIMEOUT`, Codex's
 * `tool_timeout_sec`) and a model streams as it thinks, so a turn silent
 * for longer is stuck: without this the panel said "working" for good.
 */
export const STALL_MS = 25 * 60_000;

/** How often running turns are looked at for a stall. */
const WATCH_EVERY_MS = 60_000;

/** Runs `work` after `ms` without holding the process open. */
function later(ms: number, work: () => void): void {
  const timer = setTimeout(() => {
    try {
      work();
    } catch (error) {
      if (isBug(error)) crashed("the agent's timer", error);
      else diag.warn("agent", diag.messageOf(error));
    }
  }, ms);
  timer.unref?.();
}

/** Whether the chat's turn `generation` is still the one running, not stopped or ended by Edit. */
function stillOn(chat: Chat, generation: number): boolean {
  return chat.generation === generation && chat.running && !chat.halted && !chat.dropped;
}

/** The first words of a turn that starts a new Claude Code conversation because the last one's session is gone. */
const SESSION_GONE =
  "(Edit, automatically) The earlier conversation couldn't be picked up again (Claude Code no longer has it), so this is a new one: get_edit_context shows what's already done. My message:";

/**
 * The running turns, noted in `<home>/agent` as each starts and ends and
 * every minute while any runs, so a quit or a crash leaves the ones it cut.
 */
const RUNNING = "running-turns.json";

/** Edit back this soon after it last noted its turns was a restart: they carry on. */
export const RESUME_WITHIN_MS = 10 * 60_000;

/**
 * What a whole edit left that the team would catch (the audit's fixable
 * flags), as Edit's own follow-up message, or null when nothing's left: set
 * where the editing tools are (edit_tools.unfinishedNote).
 */
export const agentHooks = {
  unfinished: (_project: string): { note: string; count: number } | null => null,
};

/** Follow-ups Edit sends after one message at most, each only while the last cut the flags by a fifth or more. */
export const MAX_FOLLOW_UPS = 3;


/** The turn that carries on one a restart cut short. */
const RESUMED =
  "(Edit, automatically) Edit restarted while you were working (a new build), which cut your last turn off; your last tool call may not have finished. Carry on from where you stopped: get_edit_context shows what's already done; then finish the task.";

/** A mutex for async work (one turn of a chat at a time). */
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

/** Codex's token counts (the app server's TokenUsageBreakdown). */
interface Tokens {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

/** A running turn's token use: the thread's totals when it started and now, and the last call's. */
interface TurnUsage {
  start: Tokens | null;
  /** The first update's own call, already in `start`. */
  first: Tokens | null;
  total: Tokens;
  last: Tokens | null;
  calls: number;
  window: number | null;
}

export class Agents implements seams.AgentPanel {
  /** Remote updates wait for all agent turns to finish. */
  hasRunningTurns(): boolean {
    return [...this.chats.values()].some((chat) => chat.running);
  }
  readonly claudeSupport: ClaudeSupport;
  /** Failed messages survive app restarts, but never Stop, New Chat or a newer message. */
  private authPending = new Map<string, { text: string; user: string; model: string | null; effort: string | null; continued: boolean; retried: boolean }>();
  private authRetried = new Set<string>();
  /** Each project's automatic follow-ups for the user's last message: its generation, how many, the flags left at the last. */
  private followedUp = new Map<string, { generation: number; sent: number; count: number }>();
  /** Token use of each project's running turn. */
  private usage = new Map<string, TurnUsage>();
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
  /** The provider new turns go to: Claude unless the API chose Codex since Edit started. */
  private chosen: Provider = DEFAULT_PROVIDER;
  /** Claude Code's models, cached a day like Codex's (`<home>/agent/claude-models.json`). */
  private claudeCatalog: { fetched_ms: number; models: claude.ModelInfo[] } | null = null;
  /** Each project's running Claude query, to stop it. */
  private claudeQueries = new Map<string, claude.Query>();
  /** Codex turns Edit ended itself, whose own end is still to come (and is ignored). */
  private abandoned = new Set<string>();
  /** Looks for stalled turns while any runs. */
  private watchdog: ReturnType<typeof setInterval> | null = null;
  /** Edit is quitting: the turns it ends stay noted as running (`RUNNING`). */
  private quitting = false;
  /** The SDK's `query`, the user's `claude` and its model list (tests put stand-ins here). */
  claudeQuery: (params: { prompt: string; options: claude.Options }) => Promise<claude.Query> = async (params) =>
    (await claude.sdk()).query(params);
  findClaude: () => Promise<string | null> = () => claude.findClaude();
  listClaudeModels: (binary: string, workspace: string) => Promise<claude.ModelInfo[]> = (binary, workspace) =>
    claude.listModels(binary, workspace);
  /** Starts Codex (tests put a stand-in here). */
  spawnCodex: (onMessage: (message: Record<string, unknown>) => void) => Promise<Codex> = (onMessage) =>
    Codex.spawn(onMessage);

  constructor(
    private store: Store,
    home: string,
    private port: number,
  ) {
    this.dir = join(home, "agent");
    this.claudeSupport = new ClaudeSupport(home, () => this.resumeAfterClaudeLogin(), () => {
      this.ready = null;
      this.emit("", { event: "claude", support: this.claudeSupport.status() });
    });
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
    try {
      const saved: unknown = JSON.parse(fs.readFileSync(join(this.dir, "claude-pending.json"), "utf8"));
      if (Array.isArray(saved)) for (const [project, pending] of saved) {
        if (typeof project === "string" && typeof pending?.text === "string" && typeof pending?.user === "string") this.authPending.set(project, pending);
      }
    } catch { /* No message waiting for sign-in. */ }
    // Every start is on Claude (Oct 24: Codex is hidden from Settings); a
    // Codex chosen through the API (an experiment) lasts until Edit restarts.
    try {
      const value = JSON.parse(fs.readFileSync(join(this.dir, "claude-models.json"), "utf8")) as { fetched_ms?: unknown; models?: unknown };
      if (typeof value.fetched_ms === "number" && Array.isArray(value.models)) {
        this.claudeCatalog = { fetched_ms: value.fetched_ms, models: value.models as claude.ModelInfo[] };
      }
    } catch {
      this.claudeCatalog = null;
    }
  }

  /** The provider new turns go to. */
  provider(): Provider {
    return this.chosen;
  }

  /** Switches provider; each chat starts a new conversation on its next turn there. */
  setProvider(provider: Provider): void {
    this.chosen = provider;
    this.ready = null;
    if (provider !== "claude") { this.cancelClaudeRetries(); }
  }

  claudeSetup(action?: SupportAction | "cancel"): SupportStatus {
    if (action === "cancel") {
      this.cancelClaudeRetries();
      return this.claudeSupport.cancel();
    }
    return action ? this.claudeSupport.start(action) : this.claudeSupport.status();
  }

  private saveAuthPending(): void {
    try { writeAtomic(join(this.dir, "claude-pending.json"), JSON.stringify([...this.authPending])); }
    catch (error) { diag.warn("claude", `saving the waiting message: ${diag.messageOf(error)}`); }
  }

  private cancelClaudeRetries(): void {
    for (const project of new Set([...this.chats.keys(), ...this.authPending.keys()])) {
      const chat = this.withChat(project);
      chat.authRecoveryUser = chat.entries.findLast((item) => item.kind === "user")?.id ?? null;
      this.save(project);
    }
    this.authPending.clear();
    this.saveAuthPending();
  }

  /** A pre-nightly-21 failure has no waiting-message receipt. Only the open
   * conversation may adopt it, after verification newer than that failure. */
  private legacyClaudeRetry(project: string): string | null {
    const chat = this.withChat(project);
    const verified = this.claudeSupport.status();
    const last = chat.entries.at(-1);
    const user = chat.entries.findLast((item) => item.kind === "user");
    if (this.chosen !== "claude" || chat.provider !== "claude" || chat.running || chat.halted || this.authPending.has(project)) return null;
    if (!last || !user || chat.authRecoveryUser === user.id || !authFailure(last) || last.status === "done") return null;
    if (verified.phase !== "ready" || verified.checkedAt === null || last.updated > verified.checkedAt) return null;
    return user.id;
  }

  /** POST from the open conversation only. The expected user id and saved
   * receipt make concurrent refreshes and repeated requests harmless. */
  async retryClaude(project: string, userId: string): Promise<boolean> {
    if (this.store.get(project) === null) throw new Error("no such project");
    await this.store.mayWrite(project);
    if (this.legacyClaudeRetry(project) !== userId) return false;
    const chat = this.withChat(project);
    const user = chat.entries.find((item) => item.id === userId)!;
    const after = chat.entries.slice(chat.entries.indexOf(user) + 1);
    chat.authRecoveryUser = userId;
    this.save(project);
    this.authPending.set(project, { user: userId, text: user.text, model: chat.model, effort: chat.effort, continued: after.some((item) => item.kind === "tool"), retried: false });
    this.saveAuthPending();
    await this.resumeAfterClaudeLogin();
    return true;
  }

  private waitForClaudeLogin(project: string, generation: number, text: string, continued: boolean): boolean {
    const chat = this.withChat(project);
    if (chat.generation !== generation || chat.halted || this.quitting) return false;
    const user = chat.entries.findLast((item) => item.kind === "user");
    if (!user) return false;
    const retried = this.authRetried.has(project);
    this.authPending.set(project, { text, user: user.id, model: chat.model, effort: chat.effort, continued, retried });
    this.saveAuthPending();
    this.finish(project, retried ? "Claude still rejected its sign-in. Your message is saved; choose Check Claude to continue." : "Claude needs to sign in again. Your message is saved and will continue after sign-in.");
    this.claudeSupport.authenticationFailed();
    // One automatic recovery per user request; a second failure is actionable,
    // never an endless series of browser windows and duplicate messages.
    if (!retried) this.claudeSupport.start("login");
    return true;
  }

  private async resumeAfterClaudeLogin(): Promise<void> {
    this.ready = null;
    this.claudeCatalog = null;
    for (const [project, pending] of [...this.authPending]) {
      const chat = this.withChat(project);
      if (this.quitting || this.chosen !== "claude") return;
      if (chat.running) continue;
      this.authPending.delete(project);
      this.saveAuthPending();
      if (chat.halted || this.store.get(project) === null || chat.entries.findLast((item) => item.kind === "user")?.id !== pending.user) continue;
      try {
        // A cloud lock may have moved while the browser was open.
        await this.store.mayWrite(project);
        if (this.withChat(project) !== chat || chat.halted || chat.running || chat.entries.findLast((item) => item.kind === "user")?.id !== pending.user) continue;
        this.authRetried.add(project);
        chat.authRecoveryUser = pending.user;
        const userAt = chat.entries.findIndex((item) => item.id === pending.user);
        for (const item of chat.entries.slice(userAt + 1)) if (authFailure(item) && item.status !== "done") {
          this.upsert(project, { ...item, status: "done", detail: item.detail ?? item.text, text: "Claude sign-in restored. Continuing your message." });
        }
        this.save(project);
        chat.model = pending.model;
        chat.effort = pending.effort;
        const prompt = pending.continued ? `(Edit, automatically) Claude's sign-in was renewed after this turn stopped. Continue the user's request below. Read get_edit_context first and check what is already done before making changes; do not repeat completed work.\n\n${pending.text}` : pending.text;
        await this.sendTurn(project, prompt, pending.model, pending.effort, chat.generation, true);
      } catch (error) {
        this.upsert(project, entry({ id: newId("error"), kind: "error", text: `Claude is signed in, but the message could not continue: ${diag.messageOf(error)}` }));
        this.save(project);
      }
    }
  }

  /**
   * Whether Codex is installed and logged in (cheap; no app-server needed).
   * `state` is "missing", "logged_out" or "ready".
   */
  async status(): Promise<Json> {
    if (this.chosen === "claude") {
      const support = this.claudeSupport.status();
      if (["updating", "checking", "signing_in", "needs_login", "error"].includes(support.phase)) {
        return { provider: "claude", ready: false, state: support.phase, error: support.error, support };
      }
    }
    const now = timing.now();
    const cached = stillReady(this.ready, now);
    if (cached !== null) return cached;
    const status = this.chosen === "claude" ? sorted(await claude.checkClaude()) : await checkCodex();
    if ((status as { ready?: unknown }).ready === true) this.ready = [now, status];
    return status;
  }

  /** Settings: whether each CLI Edit drives (Claude Code, Codex for `ask`) is installed and signed in, and which runs the agent. */
  async clis(): Promise<Json> {
    const [claudeStatus, codexStatus] = await Promise.all([claude.checkClaude(), checkCodex()]);
    const support = this.claudeSupport.status();
    const blocked = !["idle", "ready"].includes(support.phase);
    return sorted({ claude: { ...claudeStatus, support, ...(blocked ? { ready: false, state: support.phase, error: support.error ?? support.message } : {}) }, codex: codexStatus, provider: this.chosen });
  }

  /** The running app-server, started (and initialized) when there's none. */
  async codex(): Promise<Codex> {
    const release = await this.codexLock.acquire();
    try {
      if (this.codexProcess !== null && this.codexProcess.alive) return this.codexProcess;
      const codex = await this.spawnCodex((message) => this.onMessage(message));
      try {
        await codex.call(
          "initialize",
          { clientInfo: { name: "edit", title: "Edit", version: VERSION } },
          20_000,
        );
      } catch (error) {
        // Never left running unused: the next turn starts another.
        codex.kill();
        throw error;
      }
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
    if (this.chosen === "claude") {
      const found = await this.claudeModels(refresh);
      return { models: claude.catalog(found.models), fetched_ms: found.fetched_ms, provider: "claude" };
    }
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

  /** Claude Code's models (what the user's plan offers), cached a day like Codex's. */
  private async claudeModels(refresh: boolean): Promise<{ fetched_ms: number; models: claude.ModelInfo[] }> {
    const cached = this.claudeCatalog;
    const fetch = async () => {
      const binary = await this.findClaude();
      if (binary === null) throw new Error("Claude Code isn't installed");
      const workspace = join(this.dir, "workspace");
      fs.mkdirSync(workspace, { recursive: true });
      const found = { fetched_ms: nowMs(), models: await this.listClaudeModels(binary, workspace) };
      this.claudeCatalog = found;
      try {
        fs.writeFileSync(join(this.dir, "claude-models.json"), JSON.stringify(found, null, 2));
      } catch {
        // Fetched again next time.
      }
      return found;
    };
    if (cached !== null && !refresh && cached.models.length > 0) {
      if (nowMs() - cached.fetched_ms > MODELS_TTL_MS) {
        void fetch().catch((error: unknown) => diag.warn("agent", `refreshing Claude Code's models: ${diag.messageOf(error)}`));
      }
      return cached;
    }
    return fetch();
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
      const chat = readChat(text);
      // A turn saved mid-tool died with the Edit that ran it.
      for (const item of chat.entries) {
        if (item.status === "running") item.status = "stopped";
      }
      return chat;
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
    const snapshot = { provider: chat.provider, thread: chat.thread, model: chat.model, effort: chat.effort, authRecoveryUser: chat.authRecoveryUser, entries: chat.entries.map(entryJson) };
    try {
      writeAtomic(this.store.chatPath(project), JSON.stringify(snapshot));
    } catch {
      // Kept in memory; the next save tries again.
    }
  }

  chat(project: string): Json {
    const chat = this.withChat(project);
    return sorted({ entries: chat.entries.map(entryJson), running: chat.running, model: chat.model, effort: chat.effort, auth_retry: this.legacyClaudeRetry(project) });
  }

  reset(project: string): void {
    this.authPending.delete(project);
    this.saveAuthPending();
    this.authRetried.delete(project);
    const chat = this.withChat(project);
    // A turn still running would go on editing with nothing on screen to show it.
    if (chat.running) {
      chat.halted = true;
      this.abandon(project, "Stopped.");
    }
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
    replay = false,
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
        this.authPending.delete(project);
        this.saveAuthPending();
        this.authRetried.delete(project);
        // A review fix, Edit's follow-up to one, or the team's own message (review_guard.ts).
        reviewGuard.turnStarts(project, text);
        chat.generation = this.nextGeneration++;
        chat.halted = false;
        chat.retries = 0;
        // Edit picks the model: the panel sends none, so a model chosen in an
        // older build isn't kept. A caller naming one (the teaching loop) gets
        // it, and Edit's own retries and follow-ups stay on it.
        chat.model = model;
        chat.effort = effort;
      }
      // A retried turn stays with the provider it ran on, whatever's chosen since.
      const provider = generation !== null && chat.provider !== null ? chat.provider : this.chosen;
      chat.running = true;
      chat.started = timing.now();
      chat.heard = chat.started;
      chat.on = provider;
      chat.dropped = false;
      this.noteRunning();
      this.watch();
      const current = chat.generation;
      this.emit(project, { event: "status", running: true });
      try {
        await this.prepareTurn(project, text, model, effort, current, provider, replay);
      } catch (error) {
        const said = isBug(error) ? crashed("the agent turn", error) : diag.messageOf(error);
        if (provider === "claude" && claude.signInProblem(said) && this.waitForClaudeLogin(project, current, text, false)) return;
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
    provider: Provider,
    replay = false,
  ): Promise<void> {
    const live = this.store.get(project);
    if (live === null) throw new Error("no such project");
    if (provider === "claude") return this.claudeTurn(project, text, model, effort, generation, replay);
    const codex = await this.codex();
    const chat = this.withChat(project);
    if (!stillOn(chat, generation)) throw new Error("Stopped.");
    chat.model = model ?? chat.model;
    chat.effort = effort ?? chat.effort;
    // A Claude conversation can't be resumed in Codex: start a new thread.
    const previous = chat.provider === "claude" ? null : chat.thread;
    const known = previous !== null && this.threads.has(previous);
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
    const instructions = agentInstructions(live.project, "codex");
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
    if (!stillOn(now, generation)) throw new Error("Stopped.");
    if (now.provider !== "codex") {
      // Codex and Claude name models differently.
      now.model = model;
      now.effort = effort;
    }
    now.thread = thread;
    now.provider = "codex";
    const selection = { model: now.model, effort: now.effort };
    this.upsert(project, entry({ id: newId("user"), kind: "user", text }));
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
    if (!stillOn(check, generation)) throw new Error("Stopped.");
    const request = codex.request("turn/start", params);
    const turn = (await codex.response("turn/start", request, 30_000)) as { turn?: { id?: unknown } } | null;
    const id = typeof turn?.turn?.id === "string" ? turn.turn.id : null;
    const after = this.withChat(project);
    let stopped = false;
    if (after.generation !== generation || (after.halted && after.running) || after.dropped) stopped = true;
    else if (after.running) after.turn = id;
    // Stop can arrive before turn/start returns the turn id.
    if (stopped) {
      if (id !== null) {
        // Its end, when it comes, belongs to no turn of the chat's.
        this.abandoned.add(id);
        await codex.call("turn/interrupt", { threadId: thread, turnId: id }, 15_000).catch((error: unknown) => {
          diag.warn("agent", `interrupting a stopped turn in ${project}: ${diag.messageOf(error)}`);
        });
      }
      throw new Error("Stopped.");
    }
    this.save(project);
  }

  /**
   * A turn on Claude Code: one query resuming the project's session (by its
   * id, so a restart picks it back up), Edit's MCP server its only tools and
   * pre-approved, the instructions as its system prompt, and its messages
   * mapped onto the chat as they stream in.
   */
  private async claudeTurn(project: string, text: string, model: string | null, effort: string | null, generation: number, replay = false): Promise<void> {
    const live = this.store.get(project);
    if (live === null) throw new Error("no such project");
    const chat = this.withChat(project);
    if (chat.provider !== "claude") {
      // A rejected login may occur before the CLI starts. Its waiting message
      // still belongs to Claude, including a chat previously run on Codex.
      chat.thread = null;
      chat.model = model;
      chat.effort = effort;
      chat.provider = "claude";
    }
    if (!replay) this.upsert(project, entry({ id: newId("user"), kind: "user", text }));
    this.save(project);
    // The once-per-nightly update finishes before a new CLI is started.
    // Sign-in failures below keep this already-visible message for recovery.
    await this.claudeSupport.settled();
    if (!stillOn(chat, generation)) throw new Error("Stopped.");
    const setup = this.claudeSupport.status();
    if (setup.phase === "needs_login") throw new Error("Claude authentication_error: sign-in required");
    const binary = await this.findClaude();
    if (binary === null) throw new Error("Claude Code isn't installed. Choose Set up Claude.");
    if (chat.provider !== "claude") {
      // Codex's thread and model names mean nothing to Claude Code.
      chat.thread = null;
      chat.model = null;
      chat.effort = null;
    }
    chat.model = model ?? chat.model;
    chat.effort = effort ?? chat.effort;
    const workspace = join(this.dir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const options: claude.Options = {
      ...claude.baseOptions(binary, workspace),
      model: chat.model ?? claude.DEFAULT_MODEL,
      // No built-in tools; Edit's own run without asking, anything else is refused.
      tools: [],
      allowedTools: ["mcp__edit"],
      permissionMode: "dontAsk",
      mcpServers: { edit: { type: "http", url: `http://127.0.0.1:${this.port}/mcp?project=${project}` } },
      systemPrompt: agentInstructions(live.project, "claude"),
      includePartialMessages: true,
      // A stop for a runaway turn (a whole edit is a few hundred tool calls); a turn
      // driven by review notes, which nobody's watching, gets a tighter one (the audit, Oct 23).
      ...(reviewGuard.inReviewTurn(project) ? { maxTurns: REVIEW_MAX_TURNS, maxBudgetUsd: REVIEW_MAX_USD } : { maxTurns: MAX_TURNS }),
    };
    const level = chat.effort ?? "medium";
    if (claude.EFFORTS.includes(level)) options.effort = level as claude.Options["effort"];
    if (chat.thread !== null) options.resume = chat.thread;
    const now = this.withChat(project);
    if (!stillOn(now, generation)) throw new Error("Stopped.");
    now.provider = "claude";
    this.save(project);
    this.emit(project, { event: "status", running: true });
    await this.runClaude(project, generation, text, options);
  }

  /**
   * Starts the turn's query and follows it in the background. One resuming
   * a session Claude Code no longer has is started again once as a new
   * conversation (`fresh`), rather than failing the turn.
   */
  private async runClaude(project: string, generation: number, text: string, options: claude.Options): Promise<void> {
    const running = await this.claudeQuery({ prompt: text, options });
    this.claudeQueries.set(project, running);
    const fresh =
      options.resume === undefined
        ? null
        : () => {
            const { resume: _gone, ...rest } = options;
            return this.runClaude(project, generation, `${SESSION_GONE}\n\n${text}`, rest);
          };
    void this.followClaude(project, generation, new ClaudeTurn(nowMs()), running, fresh, text);
    const after = this.withChat(project);
    // Stop can arrive while the query starts.
    if (after.generation !== generation || after.halted || !after.running) await running.interrupt().catch(() => undefined);
  }

  /** Reads a Claude query's messages until its result, then ends the turn. */
  private async followClaude(
    project: string,
    generation: number,
    turn: ClaudeTurn,
    running: claude.Query,
    fresh: (() => Promise<void>) | null,
    text: string,
  ): Promise<void> {
    let error: string | null = null;
    let result: Record<string, unknown> | null = null;
    try {
      for await (const message of running) {
        if (message.type === "result") result = message as unknown as Record<string, unknown>;
        try {
          this.onClaudeMessage(project, generation, turn, message as unknown as Record<string, unknown>);
        } catch (thrown) {
          diag.warn("agent", `a Claude message: ${isBug(thrown) ? crashed("handling Claude", thrown) : diag.messageOf(thrown)}`);
        }
      }
    } catch (thrown) {
      error = isBug(thrown) ? crashed("the Claude turn", thrown) : diag.messageOf(thrown);
    } finally {
      if (this.claudeQueries.get(project) === running) this.claudeQueries.delete(project);
      running.close();
    }
    if (result !== null) {
      error = claude.resultError(result);
      const usage = (result.usage ?? {}) as Record<string, number | undefined>;
      const cost = typeof result.total_cost_usd === "number" ? `; $${result.total_cost_usd.toFixed(2)} at API prices` : "";
      diag.info(
        "agent",
        `${project}: the Claude turn took ${diag.human(nowMs() - turn.started)} over ${turn.calls} model calls and ${turn.tools} tool calls, reading ${(usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)} tokens (${usage.cache_read_input_tokens ?? 0} cached) and writing ${usage.output_tokens ?? 0}${cost}`,
      );
    } else if (error === null) {
      error = "Claude Code stopped before the turn finished; send your message again.";
    }
    if (error !== null && claude.signInProblem(error) && this.waitForClaudeLogin(project, generation, text, turn.tools > 0)) return;
    const chat = this.withChat(project);
    if (chat.generation !== generation || !chat.running) return;
    if (chat.halted && error !== null) error = "Stopped.";
    if (error !== null && /no conversation found/i.test(error)) {
      // Its session is gone (Claude Code's history cleared): this turn starts a new one.
      chat.thread = null;
      this.save(project);
      if (fresh !== null && turn.calls === 0) {
        diag.warn("agent", `${project}: Claude Code no longer has the conversation; starting a new one`);
        try {
          await fresh();
          return;
        } catch (thrown) {
          error = isBug(thrown) ? crashed("restarting the Claude turn", thrown) : diag.messageOf(thrown);
        }
      } else {
        error = "The earlier conversation couldn't be picked up again; send your message again to start a new one.";
      }
    }
    this.turnEnded(project, error);
  }

  /** One of a Claude query's messages, onto the chat. */
  private onClaudeMessage(project: string, generation: number, turn: ClaudeTurn, message: Record<string, unknown>): void {
    const chat = this.withChat(project);
    if (chat.generation !== generation) return;
    chat.heard = timing.now();
    // A subagent's messages (none are offered, but just in case) stay out of the chat.
    if (typeof message.parent_tool_use_id === "string") return;
    switch (message.type) {
      case "system": {
        if (message.subtype === "init" && typeof message.session_id === "string" && chat.thread !== message.session_id) {
          chat.thread = message.session_id;
          this.save(project);
        } else if (message.subtype === "compact_boundary") {
          diag.info("agent", `${project}: Claude Code compacted the conversation`);
        } else if (message.subtype === "api_retry") {
          diag.warn("agent", `${project}: Claude's API asked for a retry: ${stableStringify(message.error ?? message.error_status ?? null)}`);
        }
        break;
      }
      case "stream_event": {
        const event = (message.event ?? {}) as Record<string, unknown>;
        const index = typeof event.index === "number" ? event.index : -1;
        switch (event.type) {
          case "message_start":
            turn.calls += 1;
            turn.blocks.clear();
            break;
          case "content_block_start": {
            const block = (event.content_block ?? {}) as Record<string, unknown>;
            if (block.type === "text") {
              const id = `claude-${turn.started}-${turn.calls}-${index}`;
              turn.blocks.set(index, { kind: "text", id });
              this.upsert(project, entry({ id, kind: "assistant", text: typeof block.text === "string" ? block.text : "" }));
            } else if (block.type === "thinking" || block.type === "redacted_thinking") {
              turn.blocks.set(index, { kind: "thinking", id: null });
              this.emit(project, { event: "thinking", active: true });
            } else if (block.type === "tool_use" && typeof block.id === "string") {
              const id = `claude-tool-${block.id}`;
              const tool = claude.toolName(typeof block.name === "string" ? block.name : "tool");
              turn.blocks.set(index, { kind: "tool", id });
              turn.tools += 1;
              turn.byUseId.set(block.id, { id, tool, args: {} });
              this.upsert(project, entry({ id, kind: "tool", text: "", tool, status: "running", detail: "{}" }));
            }
            break;
          }
          case "content_block_delta": {
            const delta = (event.delta ?? {}) as Record<string, unknown>;
            const block = turn.blocks.get(index);
            if (delta.type === "text_delta" && block?.kind === "text" && block.id !== null && typeof delta.text === "string") {
              const found = chat.entries.find((item) => item.id === block.id);
              if (found !== undefined) found.text += delta.text;
              this.emit(project, { event: "delta", id: block.id, text: delta.text });
            }
            break;
          }
          case "content_block_stop": {
            const block = turn.blocks.get(index);
            if (block?.kind === "thinking") this.emit(project, { event: "thinking", active: false });
            else if (block?.kind === "text" && block.id !== null) {
              const found = chat.entries.find((item) => item.id === block.id);
              if (found !== undefined) this.upsert(project, { ...found });
              this.save(project);
            }
            break;
          }
          default:
            break;
        }
        break;
      }
      case "assistant": {
        // The finished call: each tool's whole arguments.
        const content = ((message.message as { content?: unknown } | undefined)?.content ?? []) as Record<string, unknown>[];
        for (const block of content) {
          if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
          const known = turn.byUseId.get(block.id) ?? {
            id: `claude-tool-${block.id}`,
            tool: claude.toolName(typeof block.name === "string" ? block.name : "tool"),
            args: {},
          };
          known.args = block.input ?? {};
          turn.byUseId.set(block.id, known);
          const existing = chat.entries.find((item) => item.id === known.id);
          if (existing?.status === "done" || existing?.status === "failed") continue;
          this.upsert(
            project,
            entry({ id: known.id, kind: "tool", text: summarizeArgs(known.args), tool: known.tool, status: "running", detail: stableStringify(known.args ?? null, 2) }),
          );
        }
        break;
      }
      case "user": {
        // Tool results.
        const content = ((message.message as { content?: unknown } | undefined)?.content ?? []) as Record<string, unknown>[];
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
          const known = turn.byUseId.get(block.tool_use_id);
          if (known === undefined) continue;
          const failed = block.is_error === true;
          this.upsert(
            project,
            entry({
              id: known.id,
              kind: "tool",
              text: failed ? takeChars(claude.resultText(block.content) || "The tool failed", 300) : summarizeArgs(known.args),
              tool: known.tool,
              status: failed ? "failed" : "done",
              detail: stableStringify(known.args ?? null, 2),
            }),
          );
        }
        this.save(project);
        break;
      }
      default:
        break;
    }
  }

  /**
   * Asks a model one question, outside any chat and with no tools, its final
   * answer out, held to `schema` (a JSON Schema) when given. A Claude model
   * ("claude-…") goes through the user's Claude Code, text only; any other
   * through Codex: text, images (`localImage`) and sound (`localAudio`) in.
   */
  async ask(
    model: string,
    effort: string,
    instructions: string,
    input: Json[],
    schema: Json | null,
    timeoutMs: number,
  ): Promise<string> {
    if (model.startsWith("claude-")) return this.askClaude(model, effort, instructions, input, schema, timeoutMs);
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

  /** `ask` on Claude Code: the input's text items, joined. */
  private async askClaude(
    model: string,
    effort: string,
    instructions: string,
    input: Json[],
    schema: Json | null,
    timeoutMs: number,
  ): Promise<string> {
    const texts: string[] = [];
    const images: { data: string; mime: string }[] = [];
    for (const item of input) {
      const { type, text, data, mime } = (item ?? {}) as { type?: unknown; text?: unknown; data?: unknown; mime?: unknown };
      if (type === "text" && typeof text === "string") texts.push(text);
      else if (type === "image" && typeof data === "string") images.push({ data, mime: typeof mime === "string" ? mime : "image/jpeg" });
      else throw new Error(`${model} through Claude Code takes text and images (base64 data) only`);
    }
    const binary = await this.findClaude();
    if (binary === null) throw new Error("Claude Code isn't installed. Install it with `curl -fsSL https://claude.ai/install.sh | bash`, then `claude auth login`.");
    const workspace = join(this.dir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const shape = schema !== null && typeof schema === "object" && !Array.isArray(schema) ? (schema as Record<string, unknown>) : null;
    return claude.ask(binary, workspace, model, effort, instructions, texts.join("\n\n"), shape, timeoutMs, images);
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
    this.authPending.delete(project);
    this.saveAuthPending();
    const chat = this.withChat(project);
    chat.authRecoveryUser = chat.entries.findLast((item) => item.kind === "user")?.id ?? null;
    this.save(project);
    chat.halted = true;
    if (chat.running) {
      // Should the agent never end it (an interrupt lost, a process hung), the turn is ended here.
      const generation = chat.generation;
      timing.later(STOP_GRACE_MS, () => {
        const now = this.withChat(project);
        if (now.generation !== generation || !now.running) return;
        diag.warn("agent", `${project}: the turn didn't end ${STOP_GRACE_MS / 1000} s after stop; ending it here`);
        this.abandon(project, "Stopped.");
      });
    }
    try {
      const running = this.claudeQueries.get(project);
      if (running !== undefined) {
        // Not waited on for good: past the grace the turn is ended anyway.
        await Promise.race([running.interrupt(), timing.sleep(STOP_GRACE_MS)]);
        return;
      }
      if ((chat.on ?? chat.provider) === "claude") return;
      const { thread, turn } = chat;
      if (thread === null || turn === null) return;
      const codex = this.codexProcess;
      if (codex === null || !codex.alive) {
        // Nothing left to tell: its Codex is gone.
        this.abandon(project, "Stopped.");
        return;
      }
      await codex.call("turn/interrupt", { threadId: thread, turnId: turn }, 15_000);
    } catch (error) {
      if (isBug(error)) throw error;
      // The agent couldn't be told: end the turn here rather than leave it running on screen.
      diag.warn("agent", `stopping the turn in ${project}: ${diag.messageOf(error)}; ending it here`);
      this.abandon(project, "Stopped.");
    }
  }

  /**
   * Ends a running turn from Edit's side: its Claude query closed (the
   * process with it), its Codex turn interrupted and its end ignored when it
   * comes. For a stop that wasn't answered, a stalled turn or Edit quitting.
   */
  private abandon(project: string, error: string): void {
    const chat = this.withChat(project);
    if (!chat.running) return;
    chat.dropped = true;
    const running = this.claudeQueries.get(project);
    if (running !== undefined) {
      this.claudeQueries.delete(project);
      try {
        running.close();
      } catch (thrown) {
        diag.warn("agent", `closing Claude Code for ${project}: ${diag.messageOf(thrown)}`);
      }
    }
    const { thread, turn } = chat;
    if (chat.on === "codex" && thread !== null && turn !== null) {
      this.abandoned.add(turn);
      const codex = this.codexProcess;
      if (codex !== null && codex.alive) {
        void codex.call("turn/interrupt", { threadId: thread, turnId: turn }, 15_000).catch(() => undefined);
      }
    }
    this.finish(project, error);
  }

  /** Starts looking for stalled turns (once). */
  private watch(): void {
    if (this.watchdog !== null) return;
    this.watchdog = setInterval(() => {
      try {
        this.checkStalls(timing.now());
        this.noteRunning();
      } catch (error) {
        if (isBug(error)) crashed("looking for stalled agent turns", error);
      }
    }, WATCH_EVERY_MS);
    this.watchdog.unref?.();
  }

  /** Ends every running turn whose agent has said nothing for STALL_MS. */
  checkStalls(now: number): void {
    for (const [project, chat] of this.chats) {
      if (!chat.running || now - chat.heard < STALL_MS) continue;
      diag.warn("agent", `${project}: nothing from the agent for ${diag.human(now - chat.heard)}; ending the turn`);
      this.abandon(
        project,
        `The agent stopped answering (nothing for ${STALL_MS / 60_000} minutes), so Edit ended the turn; send a message to carry on.`,
      );
    }
  }

  /** Notes the running turns the user hasn't stopped (`RUNNING`), or that none runs. */
  private noteRunning(): void {
    const path = join(this.dir, RUNNING);
    const projects = [...this.chats].filter(([, chat]) => chat.running && !chat.halted).map(([project]) => project);
    try {
      if (projects.length === 0) fs.rmSync(path, { force: true });
      else writeAtomic(path, JSON.stringify({ at: nowMs(), projects }));
    } catch (error) {
      diag.warn("agent", `noting the running turns: ${diag.messageOf(error)}`);
    }
  }

  /**
   * Edit is quitting: each running turn ends and says so in its chat, Claude
   * Code is closed and Codex stopped. The turns stay noted as running, so a
   * restart carries them on.
   */
  shutdown(): void {
    this.claudeSupport.close();
    if (this.watchdog !== null) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    this.noteRunning();
    this.quitting = true;
    for (const [project, chat] of this.chats) {
      if (!chat.running) continue;
      chat.halted = true;
      this.abandon(
        project,
        `Edit was closed during this turn. Back within ${RESUME_WITHIN_MS / 60_000} minutes (a restart), it carries on by itself; otherwise send a message to carry on.`,
      );
    }
    for (const running of this.claudeQueries.values()) {
      try {
        running.close();
      } catch {
        // Going anyway.
      }
    }
    this.claudeQueries.clear();
    this.codexProcess?.kill();
    this.codexProcess = null;
  }

  /**
   * Edit is back: the turns its last run left running (quit or crashed)
   * carry on, each as a new turn of the same conversation, when it noted
   * them within RESUME_WITHIN_MS (a restart). A server restart for a code
   * change then costs an agent its last tool call, not its whole task.
   */
  resumeInterrupted(): void {
    const path = join(this.dir, RUNNING);
    let noted: { at?: unknown; projects?: unknown };
    try {
      noted = JSON.parse(fs.readFileSync(path, "utf8")) as typeof noted;
    } catch {
      return;
    } finally {
      fs.rmSync(path, { force: true });
    }
    if (typeof noted.at !== "number" || !Array.isArray(noted.projects) || nowMs() - noted.at > RESUME_WITHIN_MS) return;
    for (const project of noted.projects) {
      if (typeof project !== "string" || this.store.get(project) === null) continue;
      diag.info("agent", `${project}: carrying on the turn the restart cut short`);
      void this.send(project, RESUMED, null, null).catch((error: unknown) => {
        diag.warn("agent", `carrying on the turn in ${project}: ${diag.messageOf(error)}`);
      });
    }
  }

  private finish(project: string, error: string | null): void {
    const chat = this.withChat(project);
    if (error === null) chat.retries = 0;
    const started = chat.started;
    chat.started = null;
    if (started !== null) diag.record("agent", "agent turn", timing.now() - started, error);
    const used = this.usage.get(project);
    this.usage.delete(project);
    if (used !== undefined && used.start !== null) {
      // The first update already includes the turn's first call: count from before it.
      const minus = (key: keyof Tokens) => (used.total[key] ?? 0) - (used.start![key] ?? 0) + (used.first?.[key] ?? 0);
      const context = used.last === null ? "" : `; the last call read ${used.last.inputTokens}${used.window === null ? "" : ` of ${used.window}`}`;
      diag.info(
        "agent",
        `${project}: the turn took ${started === null ? "?" : diag.human(timing.now() - started)} over ${used.calls} model calls, reading ${minus("inputTokens")} tokens (${minus("cachedInputTokens")} cached) and writing ${minus("outputTokens")} (${minus("reasoningOutputTokens")} reasoning)${context}`,
      );
    }
    if (error !== null) this.upsert(project, entry({ id: newId("error"), kind: "error", text: error }));
    const now = nowMs();
    chat.running = false;
    chat.turn = null;
    chat.on = null;
    const last = chat.entries[chat.entries.length - 1];
    if (last !== undefined) last.updated = Math.max(last.updated, now);
    // A turn that ended mid-tool leaves it unresolved; mark it.
    for (const item of chat.entries) {
      if (item.status === "running") item.status = "stopped";
    }
    this.save(project);
    if (!this.quitting) this.noteRunning();
    this.emit(project, { event: "status", running: false });
  }

  /** A turn ended (`error` null when it finished): a busy model's turn is picked up again a few times, else the chat is done. */
  private turnEnded(project: string, error: string | null): void {
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
    if (error === null && !halted) this.followUp(project, generation);
  }

  /**
   * A whole edit (or its final pass) that ended with flags the team would
   * catch still in the audit gets one follow-up from Edit: the comp's round-2
   * agent stopped with 18 bridges unillustrated, 12 long shots and 52 marked
   * pictures, and said so, rather than fixing them.
   */
  private followUp(project: string, generation: number): void {
    const before = this.followedUp.get(project);
    const mine = before !== undefined && before.generation === generation ? before : null;
    if (mine !== null && mine.sent >= MAX_FOLLOW_UPS) return;
    const chat = this.withChat(project);
    // A whole edit or its final pass, in this message's turns (the user's last
    // message and Edit's follow-ups after it).
    let asked = -1;
    chat.entries.forEach((item, index) => {
      if (item.kind === "user" && !item.text.startsWith("(Edit, automatically)")) asked = index;
    });
    const whole = chat.entries
      .slice(asked + 1)
      .some((item) => item.kind === "tool" && item.tool === "skill" && /edit-workflow|final-pass/u.test(item.text));
    if (!whole) return;
    let left: { note: string; count: number } | null;
    try {
      left = agentHooks.unfinished(project);
    } catch (error) {
      diag.warn("agent", `checking what ${project}'s edit left: ${diag.messageOf(error)}`);
      return;
    }
    if (left === null) return;
    // Another pass only while the last one got somewhere.
    if (mine !== null && left.count > mine.count * 0.8) return;
    this.followedUp.set(project, { generation, sent: (mine?.sent ?? 0) + 1, count: left.count });
    diag.info("agent", `${project}: the edit left ${left.count} flags; asking for them (${(mine?.sent ?? 0) + 1} of ${MAX_FOLLOW_UPS})`);
    const note = left.note;
    void (async () => {
      await timing.sleep(1000);
      const later = this.withChat(project);
      if (later.running || later.halted || later.generation !== generation) return;
      try {
        await this.sendTurn(project, note, null, null, generation);
      } catch (thrown) {
        diag.warn("agent", `following up ${project}: ${diag.messageOf(thrown)}`);
      }
    })();
  }

  /** Codex notifications, mapped onto the chat of the project their thread belongs to. */
  onMessage(message: Record<string, unknown>): void {
    const method = typeof message.method === "string" ? message.method : "";
    const params = (typeof message.params === "object" && message.params !== null ? message.params : {}) as Record<string, unknown>;
    // The process is gone: no turn of it will ever complete, so end them now.
    if (method === EXITED) {
      // One-off questions waiting on it fail now, not when their time is up.
      for (const ask of this.asks.values()) {
        const done = ask.done;
        ask.done = null;
        done?.({ error: "Codex stopped" });
      }
      // Only Codex's turns: a Claude turn running meanwhile carries on (it'd go on editing unseen if ended here).
      const running = [...this.chats].filter(([, chat]) => chat.running && chat.on === "codex").map(([project]) => project);
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
    this.withChat(project).heard = timing.now();
    switch (method) {
      case "thread/tokenUsage/updated": {
        // What the turn reads and writes, logged when it ends (speed-plan 2.1):
        // long full edits were model round trips, not tools.
        const usage = params.tokenUsage as { total?: Tokens; last?: Tokens; modelContextWindow?: number | null } | undefined;
        if (usage?.total === undefined) break;
        const turnUsage = this.usage.get(project) ?? { start: null, first: null, total: usage.total, last: usage.last ?? null, calls: 0, window: null };
        if (turnUsage.start === null) {
          turnUsage.start = usage.total;
          turnUsage.first = usage.last ?? null;
        }
        turnUsage.total = usage.total;
        turnUsage.last = usage.last ?? null;
        turnUsage.calls += 1;
        turnUsage.window = typeof usage.modelContextWindow === "number" ? usage.modelContextWindow : turnUsage.window;
        this.usage.set(project, turnUsage);
        break;
      }
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
            entry({ id: newId("error"), kind: "error", text: typeof said === "string" ? said : "Codex reported an error" }),
          );
        }
        break;
      }
      case "turn/completed": {
        const turn = (params.turn ?? {}) as Record<string, unknown>;
        const id = typeof turn.id === "string" ? turn.id : null;
        // A turn Edit already ended, or another than the one running, ends nothing.
        if (id !== null && this.abandoned.delete(id)) break;
        const chat = this.withChat(project);
        if (!chat.running || (chat.turn !== null && id !== null && id !== chat.turn)) break;
        let error: string | null = null;
        if (turn.status === "failed") {
          const said = (turn.error as { message?: unknown } | undefined)?.message;
          error = typeof said === "string" ? said : "The turn failed";
        } else if (turn.status === "interrupted") {
          error = "Stopped.";
        }
        this.turnEnded(project, error);
        break;
      }
      default:
        break;
    }
  }
}

/** A Claude turn's state as its messages come in. */
class ClaudeTurn {
  /** The current model call's content blocks, by index: their kind and chat entry. */
  blocks = new Map<number, { kind: string; id: string | null }>();
  calls = 0;
  tools = 0;
  /** Tool calls by their tool_use id, for their results. */
  byUseId = new Map<string, { id: string; tool: string; args: unknown }>();
  constructor(readonly started: number) {}
}

/** The developer instructions every turn carries: who the agent is, how to work fast, the house style, every tool on one line. */
export function agentInstructions(project: Pick<Project, "name" | "style" | "settings">, provider: Provider): string {
  const { settings } = project;
  const waiting =
    provider === "codex"
      ? "When a tool is still running (watch_footage, map_view, export), wait for it in long blocks (yield_time_ms 30000 or more), never second by second. "
      : "Slow tools (watch_footage, caption_speakers, map_view, export) answer when they're done: start them as early as their inputs allow and never call one again to check on it. ";
  const tools =
    provider === "codex"
      ? "The edit tools (in exec: tools.mcp__edit__<name>({…}); their full declarations are in ALL_TOOLS, but this list is usually enough)"
      : "The edit tools (call them directly; every one is listed here)";
  return (
    `You are the agent built into Edit, a video editor. The user is watching the editor while you work: every change you make through the \`edit\` tools appears live on their timeline and can be undone with ⌘Z. ` +
    `Edit only through the \`edit\` tools; you have no shell or files. The project is "${project.name}" (${settings.width}x${settings.height} at ${rateText(settings)} fps). ` +
    "Every tool call is a round trip the user waits on, so work in as few as you can (see WORK FAST): start with get_edit_context (narrowed to the part you're working on; never get_project), make the changes you've decided in one apply_edit_plan and the tools that place sounds, images or text in one batch, then look once with the plan's review_frames or one contact_sheet and fix only what's actually wrong. Don't re-read what you've read or re-check work that hasn't changed. " +
    (provider === "claude" ? "Independent tool calls (lookups, renders) can go in one step, side by side. " : "") +
    waiting +
    "When the user asks you to start the edit or the editing workflow (in whatever words), load the edit-workflow skill and do the whole edit in that one turn, stage after stage, without stopping to ask; anything else in their message steers it. For other requests, load the skill for the part you're working on (see SKILLS). " +
    `Keep replies short: say what you changed and where (timecodes).\n\n${INSTRUCTIONS}\n\n${seams.styles.instructions(project.style)}\n\n${tools}:\n${toolReference()}`
  );
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
  const provider = option("provider");
  // Chats saved before Claude Code were all Codex's.
  chat.provider = provider === "claude" || provider === "codex" ? provider : chat.thread !== null ? "codex" : null;
  chat.model = option("model");
  chat.effort = option("effort");
  chat.authRecoveryUser = option("authRecoveryUser");
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
    if (await claude.runs(candidate)) return candidate;
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
  const [printed, login] = await Promise.all([claude.runCheck([binary, "--version"]), claude.runCheck([binary, "login", "status"])]);
  const said = printed.code === 0 && trim(printed.out) !== "" ? trim(printed.out) : null;
  const logged = login.code === 0;
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
  const signs = [
    "at capacity",
    "overloaded",
    "temporarily unavailable",
    "try again later",
    "server_error",
    "high demand",
    // Claude Code's words for a failed API call: "API Error: 500 … api_error", a dropped connection.
    "internal server error",
    "api_error",
    "connection error",
    "request timed out",
    "stream disconnected",
    "econnreset",
    "socket hang up",
  ];
  return signs.some((sign) => lower.includes(sign)) || /\b(500|502|503|504|529)\b/.test(lower);
}

/** Sent to `onMessage` (by Edit, not Codex) when Codex's output ends. */
export const EXITED = "edit/codexExited";

type Reply = (result: { ok: unknown } | { error: string }) => void;

/** Where messages to Codex go: its stdin (or a test's list). */
export interface Transport {
  write(line: string): void;
  kill(): void;
  /** The end of what it printed to stderr, to say why it stopped. */
  said?(): string;
}

/** Codex features Edit's agent never needs: a shell, a browser, the computer, pictures made. */
/** The most model calls an agent turn may take: a stop for a runaway, well above a whole edit's few hundred. */
export const MAX_TURNS = 1500;
/** A turn fixing review notes (automatic, unwatched): its calls and its estimated cost at API prices. */
export const REVIEW_MAX_TURNS = 250;
export const REVIEW_MAX_USD = 75;

export const CODEX_OFF = ["shell_tool", "unified_exec", "browser_use", "browser_use_external", "in_app_browser", "computer_use", "image_generation"];

/**
 * Codex's environment: what it needs to run and sign in (its home, PATH, the
 * locale, a temp folder), not Edit's keys and tokens.
 */
export function codexEnv(from: Record<string, string | undefined> = process.env): Record<string, string> {
  const keep = ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "LANG", "LC_ALL", "CODEX_HOME", "SSL_CERT_FILE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];
  const out: Record<string, string> = {};
  for (const name of keep) if (from[name] !== undefined) out[name] = from[name]!;
  return out;
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
    // No shell, web, browser or computer of its own (the audit, Oct 23: a read-only
    // sandbox still reads the whole disk): Edit's tools are all it needs, through code mode.
    for (const feature of CODEX_OFF) args.push("--disable", feature);
    args.push("-c", 'web_search="disabled"');
    for (const name of userMcpServers()) args.push("-c", `mcp_servers.${tomlKey(name)}.enabled=false`);
    let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      child = Bun.spawn([binary, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: codexEnv() });
    } catch (error) {
      throw new Error(`couldn't start Codex: ${diag.messageOf(error)}`);
    }
    // Read as it comes (a full pipe would stop Codex), the last few lines kept for when it stops.
    let tail = "";
    void (async () => {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of child.stderr as unknown as AsyncIterable<Uint8Array>) {
          tail = (tail + decoder.decode(chunk, { stream: true })).slice(-4000);
        }
      } catch {
        // Gone with the process.
      }
    })();
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
        said: () => tail,
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
    const said = trim(this.transport.said?.() ?? "");
    if (said !== "") diag.warn("agent", `Codex stopped; it last said: ${takeChars(said.split("\n").slice(-6).join(" | "), 800)}`);
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
