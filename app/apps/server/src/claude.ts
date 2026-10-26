// Edit's agent on Claude Code: the user's own installed `claude`, driven
// through Anthropic's Agent SDK (`@anthropic-ai/claude-agent-sdk`) and signed
// in by the user with `claude auth login` (their Claude plan or API key, billed
// to them). Edit never sees or keeps their sign-in: Anthropic allows a user's
// own unmodified Claude Code with their own subscription, not an app's own
// Claude login (code.claude.com/docs/en/legal-and-compliance).
//
// Each turn is one `query` resuming the project's session. The agent has
// Edit's MCP server and nothing else: no built-in tools (shell, files, web),
// none of the user's settings, hooks, MCP servers or claude.ai connectors.

import type * as Sdk from "@anthropic-ai/claude-agent-sdk";

import type { Model } from "./agent.ts";
import { join } from "./paths.ts";
import { trim } from "./rust.ts";
import { VERSION } from "./version.ts";

export type Query = Sdk.Query;
export type Message = Sdk.SDKMessage;
export type Options = Sdk.Options;
export type ModelInfo = Sdk.ModelInfo;

let loading: Promise<typeof Sdk> | null = null;

/** The SDK, loaded on first use. */
export function sdk(): Promise<typeof Sdk> {
  loading ??= import("@anthropic-ai/claude-agent-sdk");
  return loading;
}

/** The model the agent starts on: Claude Code's `opus` (the newest Opus, 5.5 now). */
export const DEFAULT_MODEL = "opus";

/** Edit's own default thinking level, as for Codex (agent.ts `DEFAULT_EFFORT`). */
const DEFAULT_EFFORT = "medium";

/** How long a CLI's `--version` or sign-in check may take before it's taken as not working. */
export const CHECK_MS = 20_000;

// A verified browser login may replace a stale inherited token for Edit's
// children only. Never change the user's shell or read their credentials.
let storedLogin = false;
export function useStoredLogin(value: boolean): void { storedLogin = value; }
export function environment(from: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...from, DISABLE_AUTOUPDATER: "1" };
  if (storedLogin) for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) delete env[key];
  return env;
}

/**
 * Runs a CLI's quick check (`--version`, `auth status`) and says how it went:
 * its exit code (null when it couldn't start or was stopped) and what it
 * printed. Stopped after `timeoutMs`: a CLI waiting on a keychain prompt or
 * an update would otherwise hold the setup card and the agent panel forever.
 */
export async function runCheck(command: string[], timeoutMs = CHECK_MS): Promise<{ code: number | null; out: string }> {
  let child: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: environment() });
  } catch {
    return { code: null, out: "" };
  }
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { code: late ? null : code, out };
  } catch {
    return { code: null, out: "" };
  } finally {
    clearTimeout(timer);
  }
}

/** Whether `binary --version` runs and succeeds. */
export async function runs(binary: string): Promise<boolean> {
  return (await runCheck([binary, "--version"])).code === 0;
}

/** The user's `claude`: on PATH or where its installers put it. */
export async function findClaude(): Promise<string | null> {
  const home = process.env.HOME ?? "";
  const candidates = [
    "claude",
    join(home, ".local/bin/claude"),
    join(home, ".claude/local/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    join(home, ".npm-global/bin/claude"),
  ];
  for (const candidate of candidates) {
    if (await runs(candidate)) return candidate;
  }
  return null;
}

/** Whether Claude Code is installed and signed in, from `claude auth status` (its JSON). */
export async function checkClaude(): Promise<Record<string, unknown>> {
  const binary = await findClaude();
  if (binary === null) {
    return {
      provider: "claude",
      ready: false,
      state: "missing",
      error: "Claude Code isn't installed. Install it with `curl -fsSL https://claude.ai/install.sh | bash`, then `claude auth login`.",
    };
  }
  // Both at once: each is a start-up of the CLI.
  const [status, printed] = await Promise.all([runCheck([binary, "auth", "status"]), runCheck([binary, "--version"])]);
  let said: Record<string, unknown> = {};
  try {
    const value = JSON.parse(trim(status.out)) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) said = value as Record<string, unknown>;
  } catch {
    said = {};
  }
  const version = printed.code === 0 ? trim(printed.out) || null : null;
  const out: Record<string, unknown> = { provider: "claude", path: binary, version };
  if (typeof said.email === "string") out.email = said.email;
  if (typeof said.subscriptionType === "string") out.plan = planName(said.subscriptionType);
  else if (said.authMethod === "api_key" || said.authMethod === "apiKey") out.plan = "API key";
  if (said.loggedIn !== true) {
    return { ...out, ready: false, state: "logged_out", error: "Claude Code isn't signed in. Run `claude auth login` on the machine running Edit." };
  }
  return { ...out, ready: true, state: "ready" };
}

/** "max" → "Claude Max". */
export function planName(subscription: string): string {
  const word = subscription.replace(/^claude\s*/i, "").replace(/\s*subscription$/i, "");
  return `Claude ${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

/**
 * The options every query shares: the user's own `claude`, and nothing of
 * their setup (settings, CLAUDE.md, hooks, MCP servers, claude.ai connectors).
 */
export function baseOptions(binary: string, workspace: string): Options {
  return {
    pathToClaudeCodeExecutable: binary,
    cwd: workspace,
    settingSources: [],
    strictMcpConfig: true,
    settings: { disableAllHooks: true },
    env: {
      ...environment(),
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
      CLAUDE_AGENT_SDK_CLIENT_APP: `edit/${VERSION}`,
      // caption_speakers and watch_footage watch footage with a model: minutes, not seconds.
      MCP_TOOL_TIMEOUT: "900000",
      CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "900000",
      // As for Codex (agent.ts): a model answers several times slower with
      // 300k tokens to read than 100k, so compact near 150k (the window less
      // the summary's room), not near the 1M a model may allow.
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "180000",
    },
    stderr: () => {},
  };
}

/** Claude Code's models as the agent panel lists them (its own "default" row left out); `opus` is the default. */
export function catalog(models: ModelInfo[]): Model[] {
  return models
    .filter((model) => model.value !== "default")
    .map((model) => {
      const efforts = model.supportsEffort === true ? [...(model.supportedEffortLevels ?? [])] : [];
      return {
        id: model.value,
        name: model.displayName || model.value,
        description: model.description ?? "",
        default_effort: efforts.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : (efforts[0] ?? ""),
        efforts,
        is_default: model.value === DEFAULT_MODEL,
      };
    });
}

/** How long Claude Code may take to list its models. */
const MODELS_MS = 60_000;

/** Asks Claude Code for its models without starting a conversation. */
export async function listModels(binary: string, workspace: string): Promise<ModelInfo[]> {
  const { query } = await sdk();
  const abort = new AbortController();
  // A prompt that never comes: the session starts, answers, and is stopped.
  const never = (async function* (): AsyncGenerator<Sdk.SDKUserMessage> {
    await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve()));
  })();
  const probe = query({
    prompt: never,
    options: { ...baseOptions(binary, workspace), persistSession: false, tools: [], mcpServers: {}, abortController: abort },
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    // A CLI that never answers (signed out mid-way, an update prompt) mustn't hold the model list.
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Claude Code didn't list its models in time")), MODELS_MS);
    });
    return await Promise.race([probe.supportedModels(), late]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    abort.abort();
    probe.close();
  }
}

/**
 * One question to a Claude model through the user's Claude Code, outside any
 * chat: no tools, no session kept, `instructions` as the system prompt, the
 * answer held to `schema` when given (returned as its JSON text); an Error
 * after `timeoutMs`. speakers.ts names voices with it.
 */
export async function ask(
  binary: string,
  workspace: string,
  model: string,
  effort: string,
  instructions: string,
  text: string,
  schema: Record<string, unknown> | null,
  timeoutMs: number,
  images: { data: string; mime: string }[] = [],
): Promise<string> {
  const { query } = await sdk();
  const abort = new AbortController();
  const options: Options = {
    ...baseOptions(binary, workspace),
    model,
    systemPrompt: instructions,
    persistSession: false,
    tools: [],
    mcpServers: {},
    abortController: abort,
  };
  if (EFFORTS.includes(effort)) options.effort = effort as Options["effort"];
  if (schema !== null) options.outputFormat = { type: "json_schema", schema };
  // Pictures go in one user message with the words (a frame sheet to describe).
  const prompt = images.length === 0 ? text : (async function* (): AsyncGenerator<Sdk.SDKUserMessage> {
    yield { type: "user", parent_tool_use_id: null, session_id: "", message: { role: "user", content: [
      ...images.map((one) => ({ type: "image" as const, source: { type: "base64" as const, media_type: one.mime as "image/jpeg", data: one.data } })),
      { type: "text" as const, text },
    ] } } as Sdk.SDKUserMessage;
  })();
  const run = query({ prompt, options });
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    abort.abort();
  }, timeoutMs);
  try {
    for await (const message of run) {
      if (message.type !== "result") continue;
      const result = message as unknown as Record<string, unknown>;
      const error = resultError(result);
      if (error !== null) throw new Error(signInProblem(error) ? SIGN_IN_AGAIN : error);
      if (result.structured_output !== undefined) return JSON.stringify(result.structured_output);
      return typeof result.result === "string" ? result.result : "";
    }
    throw new Error("Claude Code ended without an answer");
  } catch (error) {
    if (late) throw new Error(`${model} didn't answer in time`);
    throw error;
  } finally {
    clearTimeout(timer);
    run.close();
  }
}

/** An Edit tool as the chat names it: `mcp__edit__get_edit_context` → `get_edit_context`. */
export function toolName(name: string): string {
  return name.replace(/^mcp__edit__/, "");
}

/** A tool result's words (its text blocks), for a failed call's row. */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
    .filter((text) => text !== "")
    .join("\n");
}

/** The thinking levels Claude Code takes. */
export const EFFORTS: string[] = ["low", "medium", "high", "xhigh", "max"];

/** A finished query's error, or null when it succeeded. */
/**
 * What to say when Claude Code's sign-in has run out mid-turn: `claude auth
 * status` can still say signed in while the token is refused (JJ, Oct 26:
 * "Failed to authenticate… OAuth access token is invalid").
 */
export const SIGN_IN_AGAIN = "Claude Code's sign-in on this Mac has expired or was signed out. Open Terminal, run `claude`, type /login and sign in, then send your message again.";
export function signInProblem(message: string): boolean {
  return /failed to authenticate|oauth (access )?token|invalid (api|x-api) key|authentication_error|please run \/login|not logged in|\b401\b/iu.test(message);
}

export function resultError(result: Record<string, unknown>): string | null {
  if (result.subtype === "success" && result.is_error !== true) return null;
  const errors = Array.isArray(result.errors) ? result.errors.filter((said): said is string => typeof said === "string") : [];
  if (errors.length > 0) return errors.join("; ");
  if (typeof result.result === "string" && result.result !== "") return result.result;
  if (result.subtype === "error_max_turns") return "Claude Code stopped: it reached its limit of turns.";
  return `Claude Code stopped: ${typeof result.subtype === "string" ? result.subtype : "an error"}`;
}
