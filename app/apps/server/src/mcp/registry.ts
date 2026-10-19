// The MCP tools: their declarations (names, descriptions, schemas) are
// tools.json, and each package registers the handlers for its tools here. A
// declared tool nobody has registered answers that it isn't registered.

import type { App } from "../app.ts";
import { allSkillNames } from "../styles.ts";
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

/** Every tool as tools/list declares it. */
export const TOOLS: Tool[] = declared as unknown as Tool[];

// The skill tool's choices are the skills in agent/ (agent_text.ts), so a new
// skill file is offered without touching tools.json.
const skillName = TOOLS.find((tool) => tool.name === "skill")?.inputSchema.properties.name;
if (skillName !== undefined) skillName.enum = allSkillNames();

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
export function unregistered(): string[] {
  return TOOLS.map((tool) => tool.name).filter((name) => !handlers.has(name));
}

/** A tool's answer as text. */
export function text(value: string): Content[] {
  return [{ type: "text", text: value }];
}

/** A picture and its caption. */
export function image(data: Uint8Array, caption: string, mimeType = "image/png"): Content[] {
  return [
    { type: "image", data: Buffer.from(data).toString("base64"), mimeType },
    { type: "text", text: caption },
  ];
}
