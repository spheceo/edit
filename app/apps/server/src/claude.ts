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

/** Whether `binary --version` runs and succeeds. */
async function runs(binary: string): Promise<boolean> {
  try {
    const child = Bun.spawn([binary, "--version"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
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
  let said: Record<string, unknown> = {};
  try {
    const child = Bun.spawn([binary, "auth", "status"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    said = JSON.parse(trim(out)) as Record<string, unknown>;
  } catch {
    said = {};
  }
  const version = await (async () => {
    try {
      const child = Bun.spawn([binary, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      return trim(out) || null;
    } catch {
      return null;
    }
  })();
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
      ...process.env,
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
      CLAUDE_AGENT_SDK_CLIENT_APP: `edit/${VERSION}`,
      // caption_speakers and watch_footage watch footage with a model: minutes, not seconds.
      MCP_TOOL_TIMEOUT: "900000",
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
  try {
    return await probe.supportedModels();
  } finally {
    abort.abort();
    probe.close();
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
export function resultError(result: Record<string, unknown>): string | null {
  if (result.subtype === "success" && result.is_error !== true) return null;
  const errors = Array.isArray(result.errors) ? result.errors.filter((said): said is string => typeof said === "string") : [];
  if (errors.length > 0) return errors.join("; ");
  if (typeof result.result === "string" && result.result !== "") return result.result;
  if (result.subtype === "error_max_turns") return "Claude Code stopped: it reached its limit of turns.";
  return `Claude Code stopped: ${typeof result.subtype === "string" ? result.subtype : "an error"}`;
}
