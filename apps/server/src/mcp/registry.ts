// The MCP tools: their declarations (names, descriptions, schemas) are
// tools.json, and each package registers the handlers for its tools here. A
// declared tool nobody has registered answers that it isn't ported.

import type { App } from "../app.ts";
import declared from "./tools.json" with { type: "json" };

/** One piece of a tool's answer (MCP content). */
export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolCall {
  app: App;
  /** The tool's arguments (`{}` when none were sent). */
  args: Record<string, unknown>;
  /** The project it works on (resolved: explicit, the scope's, the UI's, else the most recent). */
  projectId: string;
  /** `?project=` of the connection, when it's scoped to one project (Edit's own chats). */
  scope: string | null;
}

/** A tool's answer, or a thrown Error whose message is the agent's error text. */
export type ToolHandler = (call: ToolCall) => Promise<Content[]> | Content[];

export interface Tool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, Record<string, unknown>>; required: string[] };
}

/** Every tool as tools/list declares it (the Rust server's list). */
export const TOOLS: Tool[] = declared as unknown as Tool[];

interface Registered {
  handler: ToolHandler;
  /** Called without resolving a project first (`list_projects`). */
  noProject: boolean;
}

const handlers = new Map<string, Registered>();

/** Registers `handler` for tool `name`, which tools.json must declare. */
export function registerTool(name: string, handler: ToolHandler, options: { noProject?: boolean } = {}): void {
  if (!TOOLS.some((tool) => tool.name === name)) throw new Error(`tool ${name} isn't declared in tools.json`);
  if (handlers.has(name)) throw new Error(`tool ${name} is registered twice`);
  handlers.set(name, { handler, noProject: options.noProject === true });
}

/** The handler for `name`, if a package registered one. */
export function handlerFor(name: string): Registered | undefined {
  return handlers.get(name);
}

/** Forgets a registration (tests). */
export function unregisterTool(name: string): void {
  handlers.delete(name);
}

/** The tools declared but not registered yet (what's left to port). */
export function unported(): string[] {
  return TOOLS.map((tool) => tool.name).filter((name) => !handlers.has(name));
}

/** A tool's answer as text. */
export function text(value: string): Content[] {
  return [{ type: "text", text: value }];
}

/** A picture and its caption (`mcp.rs image`). */
export function image(data: Uint8Array, caption: string, mimeType = "image/png"): Content[] {
  return [
    { type: "image", data: Buffer.from(data).toString("base64"), mimeType },
    { type: "text", text: caption },
  ];
}
