// Script mode's questions to Claude: the user's own Claude Code through
// Anthropic's Agent SDK, as Edit's agent reaches it (claude.ts `baseOptions`:
// nothing of their setup, their plan pays). One structured answer, an answer
// that may read a folder's files (case files, frames) or search the web
// (spelling research), or a turn on Script mode's own tools (build.ts serves
// them over MCP). Writer ran a sidecar process for this; Edit's server holds
// the SDK itself.

import type * as Sdk from "@anthropic-ai/claude-agent-sdk";

import { baseOptions, findClaude, sdk } from "../claude.ts";
import * as diag from "../diag.ts";
import { join } from "../paths.ts";
import * as live from "./live.ts";

/** The model every build, revision and check that reads the whole script uses: Opus 5.5, pinned. */
export const OPUS = "claude-opus-5-5";
export const SONNET = "claude-sonnet-5-5";
export const HAIKU = "claude-haiku-5-5";

/** A failure, and whether asking again a minute later could help. */
export class Trouble extends Error {
  constructor(
    message: string,
    readonly again = false,
  ) {
    super(message);
  }
}

export interface Question {
  model: string;
  system: string;
  prompt: string;
  /** A structured answer in this shape. */
  schema?: Record<string, unknown>;
  /** Carry on an earlier session (a repair turn). */
  resume?: string;
  /** Let Claude read files in this folder, and nothing else. */
  read?: string;
  /** Let Claude search the web (WebSearch, WebFetch). */
  web?: boolean;
  /** Script mode's tools for this question, served over MCP at this address. */
  tools?: string;
  maxTurns?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
  /** For the log: "Claude opus", "Claude opus (repair turn)". */
  label: string;
  signal?: AbortSignal;
}

/** What a question came back with. */
export interface Answer {
  structured: Record<string, unknown> | null;
  text: string | null;
  session: string | null;
  costUsd: number;
  /** The result, as `whyStopped` reads it. */
  result: Record<string, unknown>;
  replies: number;
  biggestReply: number;
}

/** A reply that stopped at the model's output limit before it was complete. */
export const CUT_OFF = "Claude's reply was cut off at its output limit before the plan was complete. Nothing was saved. Build again; if it keeps happening, the script may be too long to write in one go.";

/** Why a reply stopped, for the log and for a refusal. */
export function whyStopped(result: Record<string, unknown>): string {
  const field = (key: string) => (typeof result[key] === "string" ? (result[key] as string) : "?");
  const usage = (result.usage ?? {}) as { output_tokens?: number };
  const stop = typeof result.stop_reason === "string" ? result.stop_reason : typeof result.terminal_reason === "string" ? result.terminal_reason : "?";
  return `subtype ${field("subtype")}, stop ${stop}, ${typeof result.num_turns === "number" ? result.num_turns : 0} turns, ${usage.output_tokens ?? 0} output tokens`;
}

/** What a result means when it carries no answer: cut off, out of turns, refused. */
export function stoppedShort(result: Record<string, unknown>): Trouble | null {
  if (result.stop_reason === "max_tokens") return new Trouble(CUT_OFF);
  if (result.subtype === "error_max_turns") return new Trouble("Claude used all its turns before the plan was finished. Build again; nothing was changed.");
  if (result.stop_reason === "refusal") return new Trouble("Claude declined to write this. Nothing was changed.");
  return null;
}

const clipped = (text: string, max: number) => [...text.trim()].slice(0, max).join("");

/** What a Claude Code failure means, said plainly. Nothing is saved to a script until a plan passes, so each leaves it as it was. */
export function explain(said: string, status: number | null = null): Trouble {
  const lower = said.toLowerCase();
  const quoted = clipped(said, 240);
  if (lower.includes("failed to start") || lower.includes("enoent")) return new Trouble("Install Claude Code on this Mac (the claude command), then build again.");
  if (lower.includes("not logged in") || lower.includes("/login") || lower.includes("invalid api key") || lower.includes("authentication") || status === 401) {
    return new Trouble("Claude Code on this Mac is signed out. Run claude in a terminal and sign in, then build again.");
  }
  if (lower.includes("usage limit") || lower.includes("limit reached") || lower.includes("limit will reset")) return new Trouble(`Your Claude plan's usage limit is reached: "${quoted}" Build again once it resets.`);
  // A reply cut off at its output limit: what a whole plan in one answer can run into.
  if (lower.includes("max_tokens") || lower.includes("output token") || lower.includes("output limit") || lower.includes("maximum output")) return new Trouble(CUT_OFF);
  if (lower.includes("error_max_turns") || lower.includes("maximum number of turns") || lower.includes("max turns")) return new Trouble("Claude used all its turns before the plan was finished. Build again; nothing was changed.");
  if (lower.includes("prompt is too long") || lower.includes("context length") || lower.includes("too many tokens")) return new Trouble("This transcript is too long for one build.");
  if (lower.includes("took too long")) return new Trouble("Claude worked for over 40 minutes and was stopped. Build again; nothing was changed.");
  if (lower.includes("overloaded") || lower.includes("rate limit") || status === 429 || (status !== null && status >= 500 && status <= 599)) {
    return new Trouble(`Anthropic is busy or overloaded right now ("${quoted}"). Try again in a few minutes.`, true);
  }
  if (lower.includes("could not resolve") || lower.includes("network") || lower.includes("econnreset") || lower.includes("fetch failed") || lower.includes("enotfound") || lower.includes("can't reach the api")) return new Trouble("Claude Code couldn't reach Anthropic. Check the connection, then build again.", true);
  return new Trouble(`Claude stopped: "${quoted}" Nothing was changed.`);
}

let workspaceDir: string | null = null;

/** Where questions run: an empty folder, since Claude reads its own folder without asking. */
export function useWorkspace(dir: string): void {
  workspaceDir = dir;
}

const workspace = (): string => workspaceDir ?? join(process.env.HOME ?? "/tmp", ".edit", "writer", "claude");

/** One question through the Agent SDK. */
export async function ask(question: Question): Promise<Answer> {
  const binary = await findClaude();
  if (binary === null) throw new Trouble("Install Claude Code on this Mac (the claude command), then build again.");
  const { query } = await sdk();
  const abort = new AbortController();
  const stop = () => abort.abort();
  question.signal?.addEventListener("abort", stop, { once: true });
  const dir = workspace();
  await Bun.write(join(dir, ".keep"), "");
  const readDir = question.read?.replace(/\/+$/, "");
  const allowed = [...(readDir ? [`Read(/${readDir}/**)`] : []), ...(question.tools ? ["mcp__writer"] : []), ...(question.web ? ["WebSearch", "WebFetch"] : [])];
  const options: Sdk.Options = {
    ...baseOptions(binary, dir),
    model: question.model,
    systemPrompt: question.system,
    tools: [...(readDir ? ["Read"] : []), ...(question.web ? ["WebSearch", "WebFetch"] : [])],
    allowedTools: allowed,
    // Nothing prompts: what isn't allowed is refused.
    permissionMode: "dontAsk",
    mcpServers: question.tools ? { writer: { type: "http", url: question.tools } } : {},
    ...(readDir ? { additionalDirectories: [readDir] } : {}),
    ...(question.schema ? { outputFormat: { type: "json_schema", schema: question.schema } } : {}),
    ...(question.resume ? { resume: question.resume } : {}),
    ...(question.maxTurns ? { maxTurns: question.maxTurns } : {}),
    ...(question.effort ? { effort: question.effort } : {}),
    // And a check of every Read's path, whatever the rules allow.
    canUseTool: async (tool, input) => {
      if (tool === "Read") {
        const path = typeof input.file_path === "string" ? input.file_path : "";
        const inside = readDir !== undefined && path.startsWith(`${readDir}/`) && !path.includes("/../");
        return inside ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Only the files in this question's folder can be read." };
      }
      return tool.startsWith("mcp__") || (question.web === true && (tool === "WebSearch" || tool === "WebFetch")) ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "That tool isn't available here." };
    },
    abortController: abort,
  };
  const began = Date.now();
  diag.info("writer", `${question.label}: asked (${Math.round(question.prompt.length / 1024)} KB of prompt)`);
  const answer: Answer = { structured: null, text: null, session: null, costUsd: 0, result: {}, replies: 0, biggestReply: 0 };
  const stops: string[] = [];
  let finished: Record<string, unknown> | null = null;
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    abort.abort();
  }, question.timeoutMs ?? 40 * 60_000);
  const run = query({ prompt: question.prompt, options });
  try {
    for await (const message of run) {
      if (message.type === "assistant") {
        const reply = message.message as { stop_reason?: string | null; usage?: { output_tokens?: number }; content?: unknown };
        // The chat's live turn (live.ts): its words, and each tool as it starts.
        if (question.tools && Array.isArray(reply.content))
          for (const block of reply.content as { type?: string; text?: string; id?: string; name?: string }[]) {
            if (block.type === "text" && typeof block.text === "string") live.said(block.text);
            else if (block.type === "tool_use" && typeof block.id === "string") live.tool({ id: block.id, tool: (block.name ?? "").replace(/^mcp__writer__/, ""), label: "", state: "running" });
          }
        answer.replies++;
        answer.biggestReply = Math.max(answer.biggestReply, reply.usage?.output_tokens ?? 0);
        if (reply.stop_reason === "max_tokens" || reply.stop_reason === "refusal") stops.push(reply.stop_reason);
      } else if (message.type === "user" && question.tools) {
        // Each tool's answer settles its row: done or refused, and what it said of itself.
        const content = (message.message as { content?: unknown }).content;
        if (Array.isArray(content))
          for (const block of content as { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[]) {
            if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
            const text = typeof block.content === "string" ? block.content : Array.isArray(block.content) ? (block.content as { text?: unknown }[]).map((part) => (typeof part.text === "string" ? part.text : "")).join("\n") : "";
            const detail = live.detailOf(text);
            live.tool({ id: block.tool_use_id, label: "", state: block.is_error === true ? "error" : "done", ...(detail ? { detail } : {}) });
          }
      } else if (message.type === "result") finished = message as unknown as Record<string, unknown>;
    }
  } catch (error) {
    if (question.signal?.aborted) throw new Trouble("Stopped by you. Completed work is saved.");
    if (late) throw new Trouble("Claude worked for over 40 minutes and was stopped. Build again; nothing was changed.");
    diag.error("writer", `${question.label}: failed after ${seconds(began)}: ${clipped(diag.messageOf(error), 300)}`);
    throw explain(diag.messageOf(error));
  } finally {
    clearTimeout(timer);
    question.signal?.removeEventListener("abort", stop);
    run.close();
  }
  if (finished === null) {
    if (question.signal?.aborted) throw new Trouble("Stopped by you. Completed work is saved.");
    throw explain("Claude Code ended without an answer");
  }
  const result = finished as Record<string, unknown>;
  const usage = (result.usage ?? {}) as { output_tokens?: number };
  answer.result = { subtype: result.subtype, stop_reason: result.stop_reason, terminal_reason: result.terminal_reason, num_turns: result.num_turns, usage: { output_tokens: usage.output_tokens ?? 0 }, is_error: result.is_error };
  const why = `${whyStopped(answer.result)}; ${answer.replies} replies, the biggest ${answer.biggestReply} output tokens${stops.length ? `, stopped short: ${stops.join(", ")}` : ""}`;
  if (result.subtype !== "success" || result.is_error === true) {
    const errors = Array.isArray(result.errors) ? result.errors.filter((one): one is string => typeof one === "string").join("; ") : "";
    const said = typeof result.result === "string" && result.result !== "" ? result.result : errors;
    diag.error("writer", `${question.label}: stopped after ${seconds(began)} (${why}): ${clipped(said, 300)}`);
    throw stoppedShort(answer.result) ?? explain(said, typeof result.api_error_status === "number" ? result.api_error_status : null);
  }
  answer.costUsd = typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0;
  answer.session = typeof result.session_id === "string" ? result.session_id : null;
  answer.text = typeof result.result === "string" ? result.result : null;
  answer.structured = typeof result.structured_output === "object" && result.structured_output !== null ? (result.structured_output as Record<string, unknown>) : null;
  diag.info("writer", `${question.label}: answered in ${seconds(began)} ($${answer.costUsd.toFixed(2)} at API prices; ${why})`);
  return answer;
}

const seconds = (since: number) => `${Math.round((Date.now() - since) / 1000)} s`;

/** Waits before another try (20 s, then 60 s). */
const AGAIN_MS = [20_000, 60_000];

/**
 * Claude busy or overloaded, or the connection to it lost for a moment (a
 * teammate's Wi-Fi dropped DNS for seconds at a time, Oct 30: "Claude Code
 * couldn't reach Anthropic"), gets two more tries before the build fails.
 */
export async function askPatiently(question: Question): Promise<Answer> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ask(question);
    } catch (error) {
      if (!(error instanceof Trouble) || !error.again || attempt >= AGAIN_MS.length) throw error;
      diag.warn("writer", `${question.label}: ${error.message} Trying again in ${AGAIN_MS[attempt]! / 1000} s.`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, AGAIN_MS[attempt]);
        question.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Trouble("Stopped by you. Completed work is saved."));
        }, { once: true });
      });
    }
  }
}

/** A structured answer, its JSON read from the answer's text when the SDK didn't give it as structured output. */
export function planOf(answer: Answer): Record<string, unknown> | null {
  if (answer.structured !== null) return answer.structured;
  const found = answer.text === null ? null : extractJson(answer.text);
  return found !== null && typeof found === "object" && !Array.isArray(found) ? (found as Record<string, unknown>) : null;
}

/** One structured answer from a model, tools off: speakers, research, lessons. */
export async function structured(model: string, system: string, schema: Record<string, unknown>, prompt: string, signal?: AbortSignal, label = `Claude ${model}`): Promise<Record<string, unknown>> {
  const answer = await askPatiently({ model, system, prompt, schema, label, ...(signal ? { signal } : {}) });
  const plan = planOf(answer);
  if (plan === null) throw stoppedShort(answer.result) ?? new Trouble("Claude did not answer in the expected shape.");
  return plan;
}

/** JSON in a reply: the whole of it, fenced or not, else its outermost braces. */
export function extractJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?/, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}
