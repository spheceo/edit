// MCP (streamable HTTP, JSON responses) so Codex / Claude Code can edit.
// Every mutation goes through the store, so the open UI updates live.
//
// This is the protocol half: JSON-RPC dispatch, the tool list, and
// the preamble every tool call shares (which project it works on). The tools
// themselves are registered by their packages (`registry.ts`).

import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import { isBug, crashed } from "../guard.ts";
import { empty, json, text as plain } from "../http/errors.ts";
import { readJson, type RouteContext } from "../http/router.ts";
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
  if (registered?.noProject === true) return registered.handler({ app, args, projectId: "", scope });
  const asked = typeof args.project_id === "string" ? args.project_id : null;
  const projectId = app.store.resolve(targetProject(scope, asked, name));
  if (registered === undefined) {
    if (TOOLS.some((tool) => tool.name === name)) throw new Error(`${name} is not available`);
    throw new Error(`unknown tool ${name}`);
  }
  return registered.handler({ app, args, projectId, scope });
}

// list_projects answers before any project is resolved (it works with none).
registerTool("list_projects", ({ app }) => text(JSON.stringify(app.store.list(), null, 2)), { noProject: true });
