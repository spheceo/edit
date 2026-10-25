// MCP (streamable HTTP, JSON responses) so Codex / Claude Code can edit.
// Every mutation goes through the store, so the open UI updates live.
//
// This is the protocol half: JSON-RPC dispatch, the tool list, and
// the preamble every tool call shares (which project it works on). The tools
// themselves are registered by their packages (`registry.ts`).

import * as reviewGuard from "../review_guard.ts";
import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import { isBug, crashed } from "../guard.ts";
import { empty, json, text as plain } from "../http/errors.ts";
import { readJson, type RouteContext } from "../http/router.ts";
import { stableStringify } from "../stable.ts";
import { VERSION } from "../version.ts";
import { INSTRUCTIONS } from "./instructions.ts";
import { handlerFor, registerTool, text, TOOLS, type Content } from "./registry.ts";

export { INSTRUCTIONS } from "./instructions.ts";
export { toolReference } from "./reference.ts";
export { image, registerTool, text, TOOLS, type Content, type ToolCall, type ToolHandler } from "./registry.ts";
export { stableStringify } from "../stable.ts";

/** Who agent edits come from (clients skip their own echo by it). */
export const ORIGIN = "agent";

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export function rejectGet(): Response {
  return plain("POST JSON-RPC to /mcp", 405);
}

/** `POST /mcp`: one message or a batch; `?project=<id>` pins every tool call to one project. */
export async function handle(context: RouteContext<App>): Promise<Response> {
  const scope = context.query.get("project");
  const body = await readJson<unknown>(context);
  if (Array.isArray(body)) {
    const out: unknown[] = [];
    for (const message of body) {
      const reply = await dispatch(context.app, message, scope);
      if (reply !== null) out.push(reply);
    }
    return out.length === 0 ? empty(202) : json(out);
  }
  const reply = await dispatch(context.app, body, scope);
  return reply === null ? empty(202) : json(reply);
}

/** The answer to one JSON-RPC message; null for a notification (no id). */
export async function dispatch(app: App, message: unknown, scope: string | null): Promise<unknown> {
  if (typeof message !== "object" || message === null || !("id" in message)) return null;
  const { id, method, params } = message as { id: unknown; method?: unknown; params?: unknown };
  const name = typeof method === "string" ? method : "";
  const given = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
  let result: unknown;
  switch (name) {
    case "initialize": {
      const requested = typeof given.protocolVersion === "string" ? given.protocolVersion : "2025-06-18";
      const version = PROTOCOLS.includes(requested) ? requested : PROTOCOLS[1];
      result = {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "edit", version: VERSION },
        instructions: INSTRUCTIONS,
      };
      break;
    }
    case "ping":
      result = {};
      break;
    case "tools/list":
      result = { tools: TOOLS };
      break;
    case "tools/call": {
      const tool = typeof given.name === "string" ? given.name : "";
      const args =
        given.arguments !== undefined && given.arguments !== null ? (given.arguments as Record<string, unknown>) : {};
      try {
        const content = await diag.timeAsync("agent", `tool ${tool}`, () => call(app, tool, args, scope));
        result = { content, isError: false };
      } catch (error) {
        const said = isBug(error) ? crashed(`tool ${tool}`, error) : diag.messageOf(error);
        result = { content: [{ type: "text", text: said }], isError: true };
      }
      break;
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${name}` } };
  }
  return { jsonrpc: "2.0", id, result };
}

/** Tools a scoped connection may point at another project: they only read it. */
const READ_ELSEWHERE = ["get_edit_context", "get_project"];

/**
 * The project a call works on. A scoped connection (an Edit chat) edits only
 * its own project but may read another (a reference edit to match) with
 * READ_ELSEWHERE; anything else naming another project is refused. It used to
 * answer from its own project without a word, so an agent asked to read the
 * reference edit read the edit it was fixing and took it for the reference.
 */
export function targetProject(scope: string | null, asked: string | null, tool: string): string | null {
  const named = asked !== null && asked !== "" ? asked : null;
  if (scope !== null && named !== null && named !== scope) {
    if (READ_ELSEWHERE.includes(tool)) return named;
    throw new Error(
      `this chat works on project ${scope} only: ${tool} can't touch ${named} (get_edit_context and get_project can read it)`,
    );
  }
  if (scope !== null) return scope;
  return named;
}

/** Runs tool `name`: the shared preamble (which project), then its package's handler. */
export async function call(
  app: App,
  name: string,
  args: Record<string, unknown>,
  scope: string | null,
): Promise<Content[]> {
  const registered = handlerFor(name);
  const asked = typeof args.project_id === "string" ? args.project_id : null;
  // A turn driven by review notes edits its own video only (review_guard.ts).
  const refused = reviewGuard.refusal(scope, name, asked !== null && asked !== "" ? asked : null);
  if (refused !== null) {
    app.store.emit({ type: "review-refused", project: scope, tool: name, message: `The agent was stopped from using ${name} while fixing review notes (notes come from people with the review link): ${scope}` });
    throw new Error(refused);
  }
  if (registered?.noProject === true) return registered.handler({ app, args, projectId: "", scope });
  const projectId = app.store.resolve(targetProject(scope, asked, name));
  if (registered === undefined) {
    if (TOOLS.some((tool) => tool.name === name)) throw new Error(`${name} is not available`);
    throw new Error(`unknown tool ${name}`);
  }
  if (!LONG.has(name)) return registered.handler({ app, args, projectId, scope });
  return once(`${projectId}|${name}|${stableStringify({ ...args, project_id: null })}`, name, async () => registered.handler({ app, args, projectId, scope }));
}

/**
 * Tools that can outlast an agent's wait for one call (~5 min): asked again
 * after the client gave up, they ran twice over each other (Helpful Wife got
 * a second set of 26 captions; the comp's mute_house_words never answered and
 * was retried). So one with the same project and arguments runs once: a
 * repeat joins the run in progress, a run past `answerAfterMs` answers that
 * it's still working, and the result waits for the next call to collect it.
 */
const LONG = new Set(["caption_speakers", "mute_house_words", "add_subtitles", "repack_subtitles", "import_broll", "share_for_review"]);

export const longTiming = { answerAfterMs: 4 * 60 * 1000, importAnswerAfterMs: 1500, keepMs: 15 * 60 * 1000 };

type Flight = { promise: Promise<Content[]>; started: number; waiting: number; done: { at: number; content?: Content[]; error?: unknown } | null };

const flights = new Map<string, Flight>();

export async function once(key: string, name: string, work: () => Promise<Content[]>): Promise<Content[]> {
  let flight = flights.get(key);
  if (flight?.done !== null && flight?.done !== undefined) {
    // Finished while nobody was waiting: this call collects it.
    flights.delete(key);
    if (Date.now() - flight.done.at < longTiming.keepMs) {
      if (flight.done.error !== undefined) throw flight.done.error;
      return flight.done.content!;
    }
    flight = undefined;
  }
  if (flight === undefined) {
    const made: Flight = { promise: work(), started: Date.now(), waiting: 0, done: null };
    made.promise.then(
      (content) => {
        made.done = { at: Date.now(), content };
        if (made.waiting > 0) flights.delete(key);
      },
      (error: unknown) => {
        made.done = { at: Date.now(), error };
        if (made.waiting > 0) flights.delete(key);
      },
    );
    flights.set(key, made);
    flight = made;
  }
  const own = flight;
  own.waiting += 1;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), name === "import_broll" ? longTiming.importAnswerAfterMs : longTiming.answerAfterMs);
  });
  try {
    const answer = await Promise.race([own.promise, late]);
    if (answer !== null) return answer;
    const seconds = Math.round((Date.now() - own.started) / 1000);
    const meanwhile = name === "import_broll" ? ". search_broll {queries:[]} lists completed ranges as they arrive; inspect those or existing source footage and compose the current chapter while the rest download" : "";
    return [{ type: "text", text: `${name} is still working in the background (${seconds} s so far): call ${name} again with the same arguments in a minute or two; it answers with this run's result and never runs it twice${meanwhile}` }];
  } finally {
    if (timer !== null) clearTimeout(timer);
    own.waiting -= 1;
  }
}

// list_projects answers before any project is resolved (it works with none).
registerTool("list_projects", ({ app }) => text(JSON.stringify(app.store.visible(), null, 2)), { noProject: true });
