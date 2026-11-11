// The agent's tools for coded effects (effects.ts; Edit V2, a project with
// `hq`). It writes an effect's code itself, with its own file tools in the
// project's effects folder (agent.ts); these are the three things code can't
// do from there: see the page drawn, bring one of the project's pictures into
// its folder, and put it among the project's media.

import type { App } from "./app.ts";
import * as effects from "./effects.ts";
import { handlerFor, image, registerTool, text, type Content, type ToolCall } from "./mcp/registry.ts";
import { fixed } from "./rust.ts";

/** An effect's name from a call, in a project made the new way. */
function named(app: App, projectId: string, args: Record<string, unknown>): string {
  if (app.store.get(projectId)?.project.hq !== true) throw new Error("coded effects are for Bodycam HQ projects (Edit V2): this project isn't one");
  if (typeof args.name !== "string" || args.name === "") throw new Error("name is required: the effect's folder under effects/");
  return args.name;
}

/** What a frame's cost means for playing it: the video's own frame time is what it's held to. */
function costLine(look: effects.Look, fps: number): string {
  const frame = 1000 / fps;
  // The cost is counted in the screen's refreshes, so one over the frame time by less than half a refresh still fits it.
  const slow = look.stills.filter((still) => still.cost > frame + look.interval / 2);
  if (look.stills.length === 0) return "";
  if (slow.length === 0) return `It plays live on this computer: a frame took ${fixed(Math.max(...look.stills.map((still) => still.cost)), 0)} ms at most to draw from the moments looked at, and the video's frames are ${fixed(frame, 0)} ms apart.`;
  return `IT WON'T PLAY LIVE at ${slow.map((still) => `${fixed(still.time, 2)} s (${fixed(still.cost, 0)} ms a frame, about ${fixed(1000 / still.cost, 0)} a second)`).join(", ")} on this computer: the video's frames are ${fixed(frame, 0)} ms apart. Make those moments lighter (whole-frame blurs and filters, big blurred shadows and thousands of things redrawn each frame are what cost).`;
}

async function lookAtEffect({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const name = named(app, projectId, args);
  let times: number[] | null = null;
  if (args.times !== undefined && args.times !== null) {
    if (!Array.isArray(args.times) || args.times.some((time) => typeof time !== "number" || !Number.isFinite(time) || time < 0)) throw new Error("times is a list of seconds into the effect, each 0 or more");
    if (args.times.length > 8) throw new Error("times: at most 8 moments a look");
    times = args.times as number[];
  }
  const fps = app.store.get(projectId)!.project.settings.fps;
  const look = await effects.look(app, projectId, name, times);
  const out: Content[] = [];
  for (const still of look.stills) out.push(...image(still.picture, `${name} at ${fixed(still.time, 2)} s`, still.mime));
  const lines = [`${name}: ${look.duration > 0 ? `${fixed(look.duration, 2)} s long` : "no length (window.duration)"}.`];
  if (look.errors.length > 0) lines.push(`ERRORS its page threw (fix these first):\n${look.errors.map((error) => `- ${error}`).join("\n")}`);
  if (look.problems.length > 0) lines.push(`BREAKS THE EFFECT CONTRACT:\n${look.problems.map((problem) => `- ${problem}`).join("\n")}`);
  const cost = costLine(look, fps);
  if (cost !== "") lines.push(cost);
  const render = effects.renderLine(app, projectId, name);
  if (render !== null) lines.push(render);
  out.push(...text(lines.join("\n")));
  return out;
}

async function addEffect({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const name = named(app, projectId, args);
  const added = await effects.add(app, projectId, name);
  const fps = app.store.get(projectId)!.project.settings.fps;
  return text(`${name} is media ${added.media}: ${fixed(added.duration, 2)} s (${Math.round(added.duration * fps)} frames). Place it like a video (add_clip or apply_edit_plan with media ${added.media}); the viewer plays its page live wherever its clip is, and a change to its code shows there at once.`);
}

async function effectPicture({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const name = named(app, projectId, args);
  if (typeof args.media_id !== "string") throw new Error("media_id is required");
  const time = typeof args.time === "number" && Number.isFinite(args.time) ? args.time : null;
  const given = await effects.give(app, projectId, name, args.media_id, time, typeof args.as === "string" && args.as !== "" ? args.as : null);
  return text(`effects/${name}/${given.file} (${given.width}x${given.height}): load it in the page as "${given.file}".`);
}

const TOOLS: [string, (call: ToolCall) => Promise<Content[]>][] = [
  ["look_at_effect", lookAtEffect],
  ["add_effect", addEffect],
  ["effect_picture", effectPicture],
];

/** Registers the effects' tools with the MCP server (once; later calls do nothing). */
export function registerEffectTools(): void {
  for (const [name, handler] of TOOLS) {
    if (handlerFor(name)?.handler === handler) continue;
    registerTool(name, handler);
  }
}
