// Edit's built-in agent: the user's own Claude Code (`claude.ts`: their
// `claude` through Anthropic's Agent SDK, on their own sign-in). Codex was a
// second provider until Nov 4, off since the Oct 20 A/B Opus won (Sphe:
// "remove Codex").
//
// Edit's MCP server is injected per conversation (`/mcp?project=<id>`), so a
// chat can only touch its own project, with its tools pre-approved; no other
// tools, settings or MCP servers of the user's are loaded: the agent edits
// through Edit's tools and nothing else.
//
// `ask` is the one-off question other packages use (speakers.ts names voices
// with it): no chat, no tools.

import * as fs from "node:fs";

import { attachedText, pictures as attachedPictures, savedAttached, type Attached, type Picture } from "./chat_attachments.ts";
import * as claude from "./claude.ts";
import { ClaudeSupport, type SupportAction, type SupportStatus } from "./claude_support.ts";
import * as diag from "./diag.ts";
import * as reviewGuard from "./review_guard.ts";
import { nowMs, writeAtomic } from "./files.ts";
import { crashed, isBug } from "./guard.ts";
import { INSTRUCTIONS, toolReference } from "./mcp/index.ts";
import { join, withExtension } from "./paths.ts";
import { rateText } from "./project.ts";
import { compareStrings, takeChars, charCount } from "./rust.ts";
import * as seams from "./seams.ts";
import { stableStringify } from "./stable.ts";
import type { Project } from "./model.ts";
import type { Store } from "./store.ts";
import * as toolChanges from "./tool_changes.ts";

type Json = unknown;

/** Where a chat's conversation runs: the user's Claude Code (a chat saved from the Codex days has none, and starts a new one). */
export type Provider = "claude";

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
  /** A person's message: the files attached to it (chat_attachments.ts). */
  attachments?: Attached[];
}

/** A project's chat: what's saved (thread, model, effort, entries) and the running turn's state. */
export interface Chat {
  /** The provider the conversation (`thread`) belongs to; null for one Claude Code can't resume. */
  provider: Provider | null;
  thread: string | null;
  model: string | null;
  effort: string | null;
  entries: Entry[];
  running: boolean;
  /** When the running turn started, to time it. */
  started: number | null;
  /** Turns restarted in a row after the model was at capacity. */
  retries: number;
  /** The user pressed stop: nothing restarts on its own until they send again. */
  halted: boolean;
  /** Identifies this work so retries cannot revive an old turn. */
  generation: number;
  /** When the running turn last heard from its agent (`timing.now()`), to end one that stopped answering. */
  heard: number;
  /** Edit ended the running turn itself (stopped, stalled, quitting): what it says after is ignored. */
  dropped: boolean;
  /** A message already resumed or explicitly cancelled: never adopt it again from old history. */
  authRecoveryUser: string | null;
  /** The tools the Claude session last saw (tool_changes.ts): a resumed one is told what changed since. */
  tools: toolChanges.ToolSchema | null;
}

export interface Model {
  id: string;
  name: string;
  description: string;
  default_effort: string;
  efforts: string[];
  is_default: boolean;
}

function freshChat(): Chat {
  return {
    provider: null,
    thread: null,
    model: null,
    effort: null,
    entries: [],
    running: false,
    started: null,
    retries: 0,
    halted: false,
    generation: 0,
    heard: 0,
    dropped: false,
    authRecoveryUser: null,
    tools: null,
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
  if (item.attachments !== undefined) out.attachments = item.attachments;
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
 * How long a "ready" status is answered from memory: checking runs Claude
 * Code (a Node start-up), and the panel and the setup card ask on every
 * project opened. Not-ready is never kept, so a fresh sign-in shows at once.
 */
export const READY_FOR_MS = 300_000;

/** `cached` when it's still fresh at `now`. */
export function stillReady(cached: [number, Json] | null, now: number): Json | null {
  if (cached === null) return null;
  return now - cached[0] < READY_FOR_MS ? cached[1] : null;
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
 * A tool call gives up after 15 minutes (`MCP_TOOL_TIMEOUT`) and a model
 * streams as it thinks, so a turn silent
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
  /** The fresh-eyes final pass after a whole edit (off on a trial server: the teaching loop runs it as its own step). */
  freshEyes: process.env.EDIT_FRESH_EYES === "1" || process.env.EDIT_TRIALS !== "1",
};

/** Follow-ups Edit sends after one message at most, each only while the last cut the flags by a fifth or more. */
export const MAX_FOLLOW_UPS = 3;

/**
 * A sub-agent's chat is keyed by its project and its name (`<project>~review`):
 * its own conversation and session on the same project, shown in the main chat
 * as a card that opens it (the user, Nov 1: "launch it as a sub agent… we can
 * click into the sub agent to view it and go back to the main thread").
 */
export const SUB = "~";
/** The project a chat key belongs to. */
export const projectOf = (key: string): string => key.split(SUB)[0]!;
/** A sub-agent's chat key, `name` lowercase letters. */
export function subKey(project: string, name: string): string {
  if (!/^[a-z]+$/u.test(name)) throw new Error("a sub-agent's name is lowercase letters");
  return `${project}${SUB}${name}`;
}
/**
 * The fresh-eyes final pass: once a whole edit is done, a new agent that
 * didn't make it watches it through as the team would and fixes what it'd flag
 * (loop 6, Nov 1: 2–7 minutes, it closed what every trial's edit had left).
 */
export const FRESH_EYES =
  "Do the final pass on this edit with fresh eyes: watch it through as the team would (every cut, sound, subtitle and Windows screen), then fix everything you'd flag. " +
  "What the team catches most: narration or the room's voice starting before the picture changes; a glimpse or a half-second clip; a cover (an audio section, a pause, an overlay) fading to show what's under it; a zoom that jumps at a cut; the same photo in cut-in after cut-in; a picture before the words that name it; the date title (the date first) and the countdown (from the date to the tape); a click off its pop-up; music too loud under the intro or changing mid-line; the ending (the last page held and faded, nothing after it).";


/** The turn that carries on one a restart cut short. */
const RESUMED =
  "(Edit, automatically) Edit restarted while you were working, which cut your last turn off; your last tool call may not have finished. Carry on from where you stopped: get_edit_context shows what's already done; then finish the task.";

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

export class Agents implements seams.AgentPanel {
  /** Remote updates wait for all agent turns to finish. */
  hasRunningTurns(): boolean {
    return [...this.chats.values()].some((chat) => chat.running);
  }

  /** The projects whose agent turn is running now. */
  runningProjects(): string[] {
    return [...new Set([...this.chats.entries()].flatMap(([project, chat]) => (chat.running ? [projectOf(project)] : [])))];
  }
  readonly claudeSupport: ClaudeSupport;
  /** Told each time a chat is saved (app.ts mirrors it to the cloud, chat_sync.ts). */
  onChatSaved: ((project: string) => void) | null = null;

  /** Whether a project's chat has been loaded here (a cloud copy must not land over it). */
  chatLoaded(project: string): boolean {
    return this.chats.has(project);
  }
  /** Failed messages survive app restarts, but never Stop, New Chat or a newer message. */
  private authPending = new Map<string, { text: string; user: string; model: string | null; effort: string | null; continued: boolean; retried: boolean }>();
  private authRetried = new Set<string>();
  /** Each project's automatic follow-ups for the user's last message: its generation, how many, the flags left at the last. */
  private followedUp = new Map<string, { generation: number; sent: number; count: number }>();
  /** Projects whose chat goes when their turn ends (`new_chat`). */
  private resetAfter = new Set<string>();
  private dir: string;
  private chats = new Map<string, Chat>();
  /** Each project's message already given a fresh-eyes pass (by generation). */
  private reviewed = new Map<string, number>();
  /** A sub-agent's chat key: its parent's chat and the card there. */
  private subCards = new Map<string, { parent: string; card: string }>();
  private sending = new Map<string, Lock>();
  private nextGeneration = 1;
  /** The last "ready" status and when it was found (see `status`). */
  private ready: [number, Json] | null = null;
  /** Claude Code's models, cached a day (`<home>/agent/claude-models.json`). */
  private claudeCatalog: { fetched_ms: number; models: claude.ModelInfo[] } | null = null;
  /** Each project's running Claude query, to stop it. */
  private claudeQueries = new Map<string, claude.Query>();
  /** Looks for stalled turns while any runs. */
  private watchdog: ReturnType<typeof setInterval> | null = null;
  /** Edit is quitting: the turns it ends stay noted as running (`RUNNING`). */
  private quitting = false;
  /** The SDK's `query`, the user's `claude` and its model list (tests put stand-ins here). */
  claudeQuery: (params: { prompt: string | AsyncIterable<claude.UserMessage>; options: claude.Options }) => Promise<claude.Query> = async (params) =>
    (await claude.sdk()).query(params);
  findClaude: () => Promise<string | null> = () => claude.findClaude();
  listClaudeModels: (binary: string, workspace: string) => Promise<claude.ModelInfo[]> = (binary, workspace) =>
    claude.listModels(binary, workspace);

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
    try {
      const saved: unknown = JSON.parse(fs.readFileSync(join(this.dir, "claude-pending.json"), "utf8"));
      if (Array.isArray(saved)) for (const [project, pending] of saved) {
        if (typeof project === "string" && typeof pending?.text === "string" && typeof pending?.user === "string") this.authPending.set(project, pending);
      }
    } catch { /* No message waiting for sign-in. */ }
    try {
      const value = JSON.parse(fs.readFileSync(join(this.dir, "claude-models.json"), "utf8")) as { fetched_ms?: unknown; models?: unknown };
      if (typeof value.fetched_ms === "number" && Array.isArray(value.models)) {
        this.claudeCatalog = { fetched_ms: value.fetched_ms, models: value.models as claude.ModelInfo[] };
      }
    } catch {
      this.claudeCatalog = null;
    }
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
    if (chat.provider !== "claude" || chat.running || chat.halted || this.authPending.has(project)) return null;
    if (!last || !user || chat.authRecoveryUser === user.id || !authFailure(last) || last.status === "done") return null;
    if (verified.phase !== "ready" || verified.checkedAt === null || last.updated > verified.checkedAt) return null;
    return user.id;
  }

  /** POST from the open conversation only. The expected user id and saved
   * receipt make concurrent refreshes and repeated requests harmless. */
  async retryClaude(project: string, userId: string): Promise<boolean> {
    if (this.store.get(projectOf(project)) === null) throw new Error("no such project");
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
      if (this.quitting) return;
      if (chat.running) continue;
      this.authPending.delete(project);
      this.saveAuthPending();
      if (chat.halted || this.store.get(projectOf(project)) === null || chat.entries.findLast((item) => item.kind === "user")?.id !== pending.user) continue;
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

  /** Whether Claude Code is installed and signed in: `state` "missing", "logged_out" or "ready", or its setup's phase. */
  async status(): Promise<Json> {
    const support = this.claudeSupport.status();
    if (["updating", "checking", "signing_in", "needs_login", "error"].includes(support.phase)) {
      return { provider: "claude", ready: false, state: support.phase, error: support.error, support };
    }
    const now = timing.now();
    const cached = stillReady(this.ready, now);
    if (cached !== null) return cached;
    const status = sorted(await claude.checkClaude());
    if ((status as { ready?: unknown }).ready === true) this.ready = [now, status];
    return status;
  }

  // --- models --------------------------------------------------------------

  /** Claude Code's models, refreshed in the background once a day (or now with `refresh`). */
  async models(refresh: boolean): Promise<Json> {
    const found = await this.claudeModels(refresh);
    return { models: claude.catalog(found.models), fetched_ms: found.fetched_ms, provider: "claude" };
  }

  /** Claude Code's models (what the user's plan offers), cached a day. */
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
    const snapshot = { provider: chat.provider, thread: chat.thread, model: chat.model, effort: chat.effort, authRecoveryUser: chat.authRecoveryUser, ...(chat.tools === null ? {} : { tools: chat.tools }), entries: chat.entries.map(entryJson), savedAt: Date.now() };
    try {
      writeAtomic(this.store.chatPath(project), JSON.stringify(snapshot));
      this.onChatSaved?.(project);
    } catch {
      // Kept in memory; the next save tries again.
    }
  }

  chat(project: string): Json {
    const chat = this.withChat(project);
    return sorted({ entries: chat.entries.map(entryJson), running: chat.running, model: chat.model, effort: chat.effort, auth_retry: this.legacyClaudeRetry(project) });
  }

  /** The agent's `new_chat` (the user asked for one): this chat goes when the turn now running ends. */
  resetAfterTurn(project: string): void {
    this.resetAfter.add(project);
  }

  reset(project: string): void {
    this.resetAfter.delete(project);
    this.authPending.delete(project);
    this.saveAuthPending();
    this.authRetried.delete(project);
    const chat = this.withChat(project);
    // A turn still running would go on editing with nothing on screen to show it.
    if (chat.running) {
      chat.halted = true;
      this.abandon(project, "Stopped.");
    }
    this.chats.set(project, freshChat());
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

  /** Sends a message, starting or resuming the project's conversation. */
  /** `context`: what the agent reads after the message but the chat doesn't show (where the playhead is and what's under it). */
  /** `attached`: files the person attached, already in the project (chat_attachments.ts). */
  send(project: string, text: string, model: string | null, effort: string | null, context = "", attached: Attached[] = []): Promise<void> {
    return this.sendTurn(project, text, model, effort, null, false, context, attached);
  }

  private async sendTurn(
    project: string,
    text: string,
    model: string | null,
    effort: string | null,
    generation: number | null,
    replay = false,
    context = "",
    attached: Attached[] = [],
  ): Promise<void> {
    if (this.store.get(projectOf(project)) === null) throw new Error("no such project");
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
      chat.running = true;
      chat.started = timing.now();
      chat.heard = chat.started;
      chat.dropped = false;
      this.noteRunning();
      this.watch();
      const current = chat.generation;
      this.emit(project, { event: "status", running: true });
      try {
        await this.prepareTurn(project, text, model, effort, current, replay, context, attached);
      } catch (error) {
        const said = isBug(error) ? crashed("the agent turn", error) : diag.messageOf(error);
        if (claude.signInProblem(said) && this.waitForClaudeLogin(project, current, text, false)) return;
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
    replay = false,
    context = "",
    attached: Attached[] = [],
  ): Promise<void> {
    const live = this.store.get(projectOf(project));
    if (live === null) throw new Error("no such project");
    // The attached pictures as pictures, the rest named (the first build sent only the names, and the agent couldn't see them).
    const given = await attachedPictures(attached, live.project.media, join(this.dir, "workspace", "attached"));
    const about = attachedText(attached, new Set(given.map((one) => one.media)));
    return this.claudeTurn(project, text, model, effort, generation, replay, context + about, attached, given);
  }

  /**
   * A turn on Claude Code: one query resuming the project's session (by its
   * id, so a restart picks it back up), Edit's MCP server its only tools and
   * pre-approved, the instructions as its system prompt, and its messages
   * mapped onto the chat as they stream in.
   */
  private async claudeTurn(
    project: string,
    text: string,
    model: string | null,
    effort: string | null,
    generation: number,
    replay = false,
    context = "",
    attached: Attached[] = [],
    given: Picture[] = [],
  ): Promise<void> {
    const live = this.store.get(projectOf(project));
    if (live === null) throw new Error("no such project");
    const chat = this.withChat(project);
    if (chat.provider !== "claude") {
      // A rejected login may occur before the CLI starts. Its waiting message
      // still belongs to Claude, including a chat saved from the Codex days.
      chat.thread = null;
      chat.model = model;
      chat.effort = effort;
      chat.provider = "claude";
    }
    if (!replay) this.upsert(project, entry({ id: newId("user"), kind: "user", text, ...(attached.length > 0 ? { attachments: attached } : {}) }));
    this.save(project);
    // The once-per-nightly update finishes before a new CLI is started.
    // Sign-in failures below keep this already-visible message for recovery.
    await this.claudeSupport.settled();
    if (!stillOn(chat, generation)) throw new Error("Stopped.");
    const setup = this.claudeSupport.status();
    if (setup.phase === "needs_login") throw new Error("Claude authentication_error: sign-in required");
    const binary = await this.findClaude();
    if (binary === null) throw new Error("Claude Code isn't installed. Choose Set up Claude.");
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
      mcpServers: { edit: { type: "http", url: `http://127.0.0.1:${this.port}/mcp?project=${projectOf(project)}` } },
      systemPrompt: agentInstructions(live.project),
      includePartialMessages: true,
      // A stop for a runaway turn (a whole edit is a few hundred tool calls); a turn
      // driven by review notes, which nobody's watching, gets a tighter one (the audit, Oct 23).
      ...(reviewGuard.inReviewTurn(project) ? { maxTurns: REVIEW_MAX_TURNS, maxBudgetUsd: REVIEW_MAX_USD } : { maxTurns: MAX_TURNS }),
    };
    const level = chat.effort ?? "medium";
    if (claude.EFFORTS.includes(level)) options.effort = level as claude.Options["effort"];
    if (chat.thread !== null) options.resume = chat.thread;
    // A resumed session keeps the tool schemas it read: tell it once what this build changed (tool_changes.ts).
    const tools = toolChanges.current();
    const updated = chat.thread !== null && chat.tools !== null ? toolChanges.changes(chat.tools, tools) : "";
    chat.tools = tools;
    const now = this.withChat(project);
    if (!stillOn(now, generation)) throw new Error("Stopped.");
    now.provider = "claude";
    this.save(project);
    this.emit(project, { event: "status", running: true });
    if (updated !== "") diag.info("agent", `${project}: told the resumed session what changed in the tools`);
    await this.runClaude(project, generation, updated === "" ? text + context : `${updated}\n\n${text}${context}`, options, 0, given);
  }

  /**
   * Starts the turn's query and follows it in the background. One resuming
   * a session Claude Code no longer has is started again once as a new
   * conversation (`fresh`), rather than failing the turn.
   */
  private async runClaude(project: string, generation: number, text: string, options: claude.Options, attempt = 0, given: Picture[] = []): Promise<void> {
    // Pictures go in the one user message with the words.
    const running = await this.claudeQuery({ prompt: given.length === 0 ? text : claude.withPictures(text, given), options });
    this.claudeQueries.set(project, running);
    // Edit's own tools didn't connect (a turn started as Edit came back from
    // a restart, card 1 of Oct 28: the agent said it had "lost the connection
    // to Edit" and asked for a restart): started again in a few seconds, up to twice.
    const again =
      attempt < EDIT_TOOLS_RETRIES
        ? async () => {
            diag.warn("agent", `${project}: Edit's tools didn't connect for this turn; starting it again (${attempt + 1} of ${EDIT_TOOLS_RETRIES})`);
            await timing.sleep(EDIT_TOOLS_WAIT_MS);
            const chat = this.withChat(project);
            if (chat.generation !== generation || chat.halted || !chat.running) return;
            await this.runClaude(project, generation, text, options, attempt + 1, given);
          }
        : null;
    const fresh =
      options.resume === undefined
        ? null
        : () => {
            const { resume: _gone, ...rest } = options;
            return this.runClaude(project, generation, `${SESSION_GONE}\n\n${text}`, rest, 0, given);
          };
    void this.followClaude(project, generation, new ClaudeTurn(nowMs()), running, fresh, text, again);
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
    again: (() => Promise<void>) | null = null,
  ): Promise<void> {
    let error: string | null = null;
    let result: Record<string, unknown> | null = null;
    let toolsMissing = false;
    try {
      for await (const message of running) {
        if (message.type === "result") result = message as unknown as Record<string, unknown>;
        if (again !== null && editToolsFailed(message as unknown as Record<string, unknown>)) {
          toolsMissing = true;
          await running.interrupt().catch(() => undefined);
          break;
        }
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
    if (toolsMissing && again !== null) {
      try {
        await again();
        return;
      } catch (thrown) {
        error = isBug(thrown) ? crashed("starting the turn again", thrown) : diag.messageOf(thrown);
      }
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
   * Asks a Claude model ("claude-…") one question through the user's Claude
   * Code, outside any chat and with no tools, its final answer out, held to
   * `schema` (a JSON Schema) when given: text and images in.
   */
  async ask(model: string, effort: string, instructions: string, input: Json[], schema: Json | null, timeoutMs: number): Promise<string> {
    if (!model.startsWith("claude-")) throw new Error(`${model} isn't a Claude model: Edit asks Claude only`);
    return this.askClaude(model, effort, instructions, input, schema, timeoutMs);
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
      }
    } catch (error) {
      if (isBug(error)) throw error;
      // The agent couldn't be told: end the turn here rather than leave it running on screen.
      diag.warn("agent", `stopping the turn in ${project}: ${diag.messageOf(error)}; ending it here`);
      this.abandon(project, "Stopped.");
    }
  }

  /**
   * Ends a running turn from Edit's side: its Claude query closed (the
   * process with it). For a stop that wasn't answered, a stalled turn or
   * Edit quitting.
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
   * Edit is quitting: each running turn ends and says so in its chat, and
   * Claude Code is closed. The turns stay noted as running, so a
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
      if (typeof project !== "string" || this.store.get(projectOf(project)) === null) continue;
      diag.info("agent", `${project}: carrying on the turn the restart cut short`);
      // The "Edit was closed" note is answered now: no longer a problem to show.
      const chat = this.withChat(project);
      for (const item of chat.entries) {
        if (item.kind === "error" && item.status !== "done" && item.text.startsWith("Edit was closed during this turn")) {
          this.upsert(project, { ...item, status: "done", detail: item.detail ?? item.text, text: "Edit restarted; the agent carried on where it stopped." });
        }
      }
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
    if (error !== null) this.upsert(project, entry({ id: newId("error"), kind: "error", text: error }));
    const now = nowMs();
    chat.running = false;
    const last = chat.entries[chat.entries.length - 1];
    if (last !== undefined) last.updated = Math.max(last.updated, now);
    // A turn that ended mid-tool leaves it unresolved; mark it.
    for (const item of chat.entries) {
      if (item.status === "running" && item.kind !== "subagent") item.status = "stopped";
    }
    this.save(project);
    if (!this.quitting) this.noteRunning();
    this.emit(project, { event: "status", running: false });
    // A sub-agent's turn over: its card in the main chat says how it ended.
    if (project.includes(SUB)) this.subFinished(project, error);
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
    // The user asked for a new chat: this one ends with the turn, and the next message starts afresh.
    if (this.resetAfter.has(project)) {
      this.reset(project);
      return;
    }
    if (error === null && !halted) this.followUp(project, generation);
  }

  /**
   * A whole edit (or its final pass) that ended with flags the team would
   * catch still in the audit gets one follow-up from Edit: the comp's round-2
   * agent stopped with 18 bridges unillustrated, 12 long shots and 52 marked
   * pictures, and said so, rather than fixing them.
   */
  private followUp(project: string, generation: number): void {
    if (project.includes(SUB)) return;
    const before = this.followedUp.get(project);
    const mine = before !== undefined && before.generation === generation ? before : null;
    if (mine !== null && mine.sent >= MAX_FOLLOW_UPS) return void this.freshEyes(project, generation);
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
    if (left === null) return void this.freshEyes(project, generation);
    // Another pass only while the last one got somewhere.
    if (mine !== null && left.count > mine.count * 0.8) return void this.freshEyes(project, generation);
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

  /**
   * Starts the fresh-eyes final pass as a sub-agent once a whole edit (and
   * Edit's follow-ups to it) is done: a new chat of its own on the project,
   * shown in the main chat as a card that opens it. Once per message.
   */
  private freshEyes(project: string, generation: number): void {
    if (agentHooks.freshEyes === false || this.reviewed.get(project) === generation) return;
    const chat = this.withChat(project);
    // Only after a whole edit or its final pass (as the follow-ups judge it).
    let asked = -1;
    chat.entries.forEach((item, index) => {
      if (item.kind === "user" && !item.text.startsWith("(Edit, automatically)")) asked = index;
    });
    const whole = chat.entries.slice(asked + 1).some((item) => item.kind === "tool" && item.tool === "skill" && /edit-workflow|final-pass/u.test(item.text));
    if (!whole) return;
    this.reviewed.set(project, generation);
    const key = subKey(project, "review");
    if (this.withChat(key).running) return;
    this.reset(key);
    const card = newId("subagent");
    this.subCards.set(key, { parent: project, card });
    this.upsert(project, entry({ id: card, kind: "subagent", text: "Fresh-eyes final pass", status: "running", detail: key }));
    this.save(project);
    diag.info("agent", `${project}: the edit is done; a fresh-eyes final pass starts as a sub-agent`);
    void (async () => {
      await timing.sleep(1000);
      try {
        await this.sendTurn(key, FRESH_EYES, null, null, null);
      } catch (thrown) {
        this.subFinished(key, diag.messageOf(thrown));
      }
    })();
  }

  /** A sub-agent's turn ended: its card says so (done, or why not). */
  private subFinished(key: string, error: string | null): void {
    const card = this.subCards.get(key);
    if (card === undefined) return;
    const parent = this.withChat(card.parent);
    const found = parent.entries.find((item) => item.id === card.card);
    if (found === undefined) return;
    this.upsert(card.parent, { ...found, status: error === null ? "done" : error === "Stopped." ? "stopped" : "failed", ...(error !== null && error !== "Stopped." ? { text: `Fresh-eyes final pass: ${error}` } : {}) });
    this.save(card.parent);
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
export function agentInstructions(project: Pick<Project, "name" | "style" | "settings">): string {
  const { settings } = project;
  const waiting = "Slow tools (watch_footage, caption_speakers, map_view, export) answer when they're done: start them as early as their inputs allow and never call one again to check on it. ";
  const tools = "The edit tools (call them directly; every one is listed here)";
  return (
    `You are the agent built into Edit, a video editor. The user is watching the editor while you work: every change you make through the \`edit\` tools appears live on their timeline and can be undone with ⌘Z. ` +
    `Edit only through the \`edit\` tools; you have no shell or files. The project is "${project.name}" (${settings.width}x${settings.height} at ${rateText(settings)} fps). ` +
    "Every tool call is a round trip the user waits on, so work in as few as you can (see WORK FAST): start with get_edit_context (narrowed to the part you're working on; never get_project), make the changes you've decided in one apply_edit_plan and the tools that place sounds, images or text in one batch, then look once with the plan's review_frames or one contact_sheet and fix only what's actually wrong. Don't re-read what you've read or re-check work that hasn't changed. " +
    "Independent tool calls (lookups, renders) can go in one step, side by side. " +
    waiting +
    "When the user asks you to start the edit or the editing workflow (in whatever words), load the edit-workflow skill and do the whole edit in that one turn, stage after stage, without stopping to ask; anything else in their message steers it. When asked to resume, recover or finish a partially edited/imported project, load resume-edit first and preserve completed work. For other requests, load the skill for the part you're working on (see SKILLS). " +
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
  // A conversation from the Codex days (or before providers were saved) can't be resumed in Claude Code: its next turn starts a new one.
  chat.provider = option("provider") === "claude" ? "claude" : null;
  chat.model = option("model");
  chat.effort = option("effort");
  chat.authRecoveryUser = option("authRecoveryUser");
  chat.tools = toolChanges.read(given.tools);
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
      const attachments = savedAttached(fields.attachments);
      if (attachments !== undefined) read.attachments = attachments;
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

/** Times a turn is started again when Edit's own tools didn't connect, and the wait before each. */
const EDIT_TOOLS_RETRIES = 2;
const EDIT_TOOLS_WAIT_MS = 5000;

/** Whether Claude Code's first message says Edit's own tools (`edit`) failed to connect. */
export function editToolsFailed(message: Record<string, unknown>): boolean {
  if (message.type !== "system" || message.subtype !== "init" || !Array.isArray(message.mcp_servers)) return false;
  const edit = (message.mcp_servers as { name?: unknown; status?: unknown }[]).find((server) => server.name === "edit");
  return edit !== undefined && edit.status !== "connected" && edit.status !== "pending";
}

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

/** The most model calls an agent turn may take: a stop for a runaway, well above a whole edit's few hundred. */
export const MAX_TURNS = 1500;
/** A turn fixing review notes (automatic, unwatched): its calls and its estimated cost at API prices. */
export const REVIEW_MAX_TURNS = 250;
export const REVIEW_MAX_USD = 75;
