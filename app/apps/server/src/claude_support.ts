// Claude owns its installation and browser OAuth flow. Edit runs its CLI,
// checks a real request, and retains only the diagnosis, never credentials.
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import * as claude from "./claude.ts";
import * as diag from "./diag.ts";
import { writeAtomic } from "./files.ts";
import { join } from "./paths.ts";

export type SupportPhase = "idle" | "updating" | "checking" | "signing_in" | "ready" | "needs_login" | "error";
export interface SupportCheck { name: string; ok: boolean; detail: string }
export interface SupportStatus {
  phase: SupportPhase;
  message: string;
  error: string | null;
  url: string | null;
  path: string | null;
  version: string | null;
  checkedAt: number | null;
  checks: SupportCheck[];
}
export type SupportAction = "diagnose" | "repair" | "login";
interface CommandResult { code: number | null; out: string }
export interface SupportRuntime {
  find(): Promise<string | null>;
  run(command: string[], cwd: string, signal: AbortSignal, timeout: number, output?: (text: string) => void, env?: Record<string, string | undefined>): Promise<CommandResult>;
  sdkProbe?(binary: string, cwd: string, signal: AbortSignal): Promise<CommandResult>;
}

/** No authorization URLs, API keys or bearer tokens in saved reports. */
export function safeDetail(text: string): string {
  return diag.scrub(text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ""))
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, "<redacted>")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1<redacted>").slice(-6000);
}

/** Only Claude's own authorization pages may be offered as a sign-in link. */
export function loginUrl(text: string): string | null {
  for (const match of text.matchAll(/https:\/\/[^\s<>"'\x1b]+/g)) {
    try {
      const url = new URL(match[0]);
      if (["claude.ai", "platform.claude.com", "console.anthropic.com"].includes(url.hostname) && /oauth|authorize/i.test(url.pathname) && !url.username && !url.password) return url.href;
    } catch { /* A partially printed URL is tried when the next chunk arrives. */ }
  }
  return null;
}

const defaultRuntime: SupportRuntime = {
  find: () => claude.findClaude(),
  async run(command, cwd, signal, timeout, output, env = claude.environment()) {
    signal.throwIfAborted();
    const child = spawn(command[0]!, command.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let text = "";
    let timedOut = false;
    const stop = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* Already exited. */ }
    };
    signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    const read = async (stream: AsyncIterable<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        const next = decoder.decode(chunk, { stream: true });
        text = (text + next).slice(-32_000);
        output?.(text);
      }
    };
    try {
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code));
      });
      const [code] = await Promise.all([exited, read(child.stdout!), read(child.stderr!)]);
      signal.throwIfAborted();
      if (timedOut) throw new Error(`${command[1] ?? "Claude Code"} did not finish in ${timeout / 1000} seconds`);
      return { code, out: text };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    }
  },
  async sdkProbe(binary, cwd, signal) {
    const abort = new AbortController();
    const stop = () => abort.abort();
    signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, 90_000);
    let run: claude.Query | null = null;
    try {
      signal.throwIfAborted();
      run = (await claude.sdk()).query({ prompt: "Reply with exactly OK.", options: {
        ...claude.baseOptions(binary, cwd), model: claude.DEFAULT_MODEL, effort: "low", tools: [], mcpServers: {},
        permissionMode: "dontAsk", persistSession: false, maxTurns: 1, abortController: abort,
      } });
      for await (const message of run) {
        if (message.type !== "result") continue;
        const result = message as unknown as Record<string, unknown>;
        return { code: claude.resultError(result) === null ? 0 : 1, out: JSON.stringify(result) };
      }
      throw new Error("Edit's Claude connection ended without an answer.");
    } catch (error) {
      signal.throwIfAborted();
      return { code: 1, out: abort.signal.aborted ? "Edit's Claude connection timed out after 90 seconds." : diag.messageOf(error) };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      run?.close();
    }
  },
};

export class ClaudeSupport {
  private state: SupportStatus = { phase: "idle", message: "", error: null, url: null, path: null, version: null, checkedAt: null, checks: [] };
  private build: string | null = null;
  private stored = false;
  private job: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private file: string;
  private workspace: string;

  constructor(home: string, private ready: () => Promise<void> | void, private changed: () => void = () => {}, public runtime: SupportRuntime = defaultRuntime) {
    claude.useStoredLogin(false);
    this.file = join(home, "agent/claude-support.json");
    this.workspace = join(home, "agent/workspace");
    fs.mkdirSync(this.workspace, { recursive: true });
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.build = typeof saved.build === "string" ? saved.build : null;
      this.stored = saved.stored === true;
      claude.useStoredLogin(this.stored);
      // A saved success is useful evidence, but an interrupted operation never
      // restarts a browser or an update on every launch.
      if (["idle", "updating", "checking", "signing_in", "ready", "needs_login", "error"].includes(saved.state?.phase)) this.state = { ...this.state, ...saved.state, url: null };
      if (["updating", "checking", "signing_in"].includes(this.state.phase)) {
        this.state.phase = "error";
        this.state.message = "Claude setup was interrupted. Choose Check Claude to continue.";
      }
    } catch { /* First run. */ }
  }

  status(): SupportStatus { return structuredClone(this.state); }
  get busy(): boolean { return this.job !== null; }
  async settled(): Promise<void> { await this.job; }

  /** Called only for a release nightly. Mark the attempt before doing work. */
  afterNightly(build: string): void {
    if (this.build === build) return;
    this.build = build;
    this.persist();
    this.start("repair");
  }

  start(action: SupportAction): SupportStatus {
    if (this.job) return this.status();
    const abort = new AbortController();
    this.abort = abort;
    this.state.checks = [];
    this.set(action === "repair" ? "updating" : "checking", action === "repair" ? "Updating Claude Code…" : "Checking Claude Code…");
    const job = this.work(action, abort.signal).catch((error: unknown) => {
      if (!abort.signal.aborted) this.set("error", "Claude Code needs attention.", safeDetail(diag.messageOf(error)));
    }).finally(() => {
      if (this.job === job) { this.job = null; this.abort = null; }
    });
    this.job = job;
    void job.then(async () => {
      if (!abort.signal.aborted && this.state.phase === "ready") await this.ready();
    }).catch((error: unknown) => diag.warn("claude", `resuming after sign-in: ${safeDetail(diag.messageOf(error))}`));
    return this.status();
  }

  cancel(): SupportStatus {
    this.abort?.abort();
    this.set("idle", "Claude setup cancelled.");
    return this.status();
  }

  /** Shutdown preserves the interrupted phase for the next launch's recovery card. */
  close(): void { this.abort?.abort(); }

  authenticationFailed(): void {
    if (this.job) return;
    this.set("needs_login", "Claude rejected its sign-in. Your message is saved.");
  }

  private persist(): void {
    try {
      // The OAuth URL (including state/PKCE) lives only while signing in.
      writeAtomic(this.file, JSON.stringify({ build: this.build, stored: this.stored, state: { ...this.state, url: null } }));
    } catch (error) { diag.warn("claude", `saving the diagnosis: ${safeDetail(diag.messageOf(error))}`); }
  }

  private set(phase: SupportPhase, message: string, error: string | null = null): void {
    this.state = { ...this.state, phase, message, error, url: phase === "signing_in" ? this.state.url : null };
    this.persist();
    this.changed();
  }

  private check(name: string, ok: boolean, detail: string): void {
    this.state.checks.push({ name, ok, detail: safeDetail(detail) });
    diag.info("claude", `${name}: ${ok ? "ok" : "failed"} ${safeDetail(detail).slice(0, 600)}`);
    this.persist();
  }

  private async run(binary: string, args: string[], signal: AbortSignal, timeout = 30_000, output?: (text: string) => void): Promise<CommandResult> {
    return this.runtime.run([binary, ...args], this.workspace, signal, timeout, output);
  }

  private async work(action: SupportAction, signal: AbortSignal): Promise<void> {
    let binary = await this.runtime.find();
    signal.throwIfAborted();
    if (action === "repair") {
      if (binary === null) {
        const installed = await this.run("/bin/bash", ["-c", "set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash"], signal, 180_000);
        this.check("Installation", installed.code === 0, installed.out);
      } else {
        try {
          const updated = await this.update(binary, signal);
          this.check("Update", updated.code === 0, updated.out);
        } catch (error) {
          signal.throwIfAborted();
          this.check("Update", false, diag.messageOf(error));
        }
      }
      binary = await this.runtime.find();
    }
    if (binary === null) { this.set("error", "Claude Code is not installed. Choose Set up Claude to install it."); return; }
    this.state.path = binary;
    this.set("checking", "Testing Claude Code on this Mac…");
    const version = await this.run(binary, ["--version"], signal);
    this.state.version = safeDetail(version.out.trim());
    this.check("Executable", version.code === 0, `${binary}: ${version.out}`);
    if (version.code !== 0) throw new Error("Claude Code could not start.");
    // Record which credentials can override a saved browser login, never values.
    const overrides = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"].filter((key) => claude.environment()[key]);
    this.check("Environment", true, `Config: ${process.env.CLAUDE_CONFIG_DIR ?? "default"}; credential overrides: ${overrides.join(", ") || "none"}`);
    const auth = await this.run(binary, ["auth", "status"], signal);
    let status: Record<string, unknown> = {};
    try { status = JSON.parse(auth.out); } catch { /* Old or broken CLI. */ }
    this.check("Saved sign-in", status.loggedIn === true, `${status.authMethod ?? "unknown"}${typeof status.email === "string" ? ` (${status.email})` : ""}`);
    try {
      const doctor = await this.run(binary, ["doctor"], signal, 15_000);
      this.check("Installation diagnosis", doctor.code === 0, doctor.out);
    } catch (error) {
      signal.throwIfAborted();
      this.check("Installation diagnosis", false, diag.messageOf(error));
    }
    let probe = await this.probe(binary, signal);
    if (!probe.ok && probe.auth && overrides.length) {
      // Try the stored sign-in without a stale inherited credential. Keep the
      // change only if a real request proves it works, or after browser login.
      claude.useStoredLogin(true);
      try {
        const clean = await this.probe(binary, signal);
        if (clean.ok) { this.stored = true; probe = clean; this.check("Credential recovery", true, "Edit now uses the working browser sign-in instead of an inherited token."); }
      } finally { claude.useStoredLogin(this.stored); }
    }
    if (probe.ok) { this.success(); return; }
    if (!probe.auth) { this.set("error", "Claude's test request failed.", probe.error); return; }
    if (action === "diagnose") { this.set("needs_login", "Sign in to Claude to continue. Your message is saved.", probe.error); return; }
    // Use the user's own CLI and its PKCE/loopback callback. No sign-in codes
    // or credentials pass through Edit. The CLI opens the default browser.
    claude.useStoredLogin(true);
    try {
      this.set("signing_in", "Finish signing in on Claude's website. Edit will continue when you're ready.");
      const login = await this.run(binary, ["auth", "login"], signal, 600_000, (output) => {
        const url = loginUrl(output);
        if (url) { this.state.url = url; this.changed(); }
      });
      if (login.code !== 0) { this.set("needs_login", "Claude sign-in did not finish. Choose Sign in to try again.", safeDetail(login.out)); return; }
      this.set("checking", "Sign-in complete. Checking a real Claude request…");
      probe = await this.probe(binary, signal);
      if (probe.ok) { this.stored = true; this.success(); }
      else this.set(probe.auth ? "needs_login" : "error", "Claude still could not complete its test request.", probe.error);
    } finally { claude.useStoredLogin(this.stored); }
  }

  private async update(binary: string, signal: AbortSignal): Promise<CommandResult> {
    let path = binary;
    try { path = fs.realpathSync(Bun.which(binary) ?? binary); } catch { /* A broken executable is diagnosed below. */ }
    const cask = /\/Caskroom\/(claude-code(?:@latest)?)\//.exec(path)?.[1];
    if (cask) return this.run("brew", ["upgrade", "--cask", cask], signal, 180_000);
    if (path.includes("/node_modules/@anthropic-ai/claude-code/")) return this.run("npm", ["install", "-g", "@anthropic-ai/claude-code@latest"], signal, 180_000);
    const env = claude.environment();
    delete env.DISABLE_AUTOUPDATER;
    return this.runtime.run([binary, "update"], this.workspace, signal, 180_000, undefined, env);
  }

  private async probe(binary: string, signal: AbortSignal): Promise<{ ok: boolean; auth: boolean; error: string | null }> {
    // The same settings isolation, model and environment as Edit's SDK turns.
    const args = ["-p", "Reply with exactly OK.", "--output-format", "json", "--model", claude.DEFAULT_MODEL,
      "--effort", "low", "--max-turns", "1", "--no-session-persistence", "--tools", "", "--permission-mode", "dontAsk",
      "--setting-sources", "", "--settings", JSON.stringify({ disableAllHooks: true }),
      "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} })];
    const answer = await this.run(binary, args, signal, 90_000);
    let verdict = this.probeResult(answer, "Claude request");
    if (verdict.ok && this.runtime.sdkProbe) verdict = this.probeResult(await this.runtime.sdkProbe(binary, this.workspace, signal), "Edit connection");
    return verdict;
  }

  private probeResult(answer: CommandResult, name: string): { ok: boolean; auth: boolean; error: string | null } {
    let result: Record<string, unknown> | null = null;
    for (const line of [answer.out.trim(), ...answer.out.trim().split("\n").reverse()]) {
      try { const value = JSON.parse(line); if (value?.type === "result" || value?.subtype) { result = value; break; } } catch { /* CLI warnings may accompany JSON. */ }
    }
    const error = result ? claude.resultError(result) : answer.code === 0 ? null : answer.out;
    const ok = answer.code === 0 && error === null && typeof result?.result === "string" && /^OK[.!]?$/i.test(result.result.trim());
    const detail = ok ? "A real request to Edit's Claude model succeeded." : safeDetail(error || answer.out || "Claude returned no answer.");
    this.check(name, ok, detail);
    return { ok, auth: !ok && claude.signInProblem(detail), error: ok ? null : detail };
  }

  private success(): void {
    this.state.checkedAt = Date.now();
    this.set("ready", "Claude is ready.");
  }
}
