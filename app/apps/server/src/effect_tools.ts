// The agent's tools for coded effects (effects.ts; Edit V2, a project with
// `hq`). It writes an effect's code itself, with its own file tools in the
// project's effects folder (agent.ts); these are the three things code can't
// do from there: see the page drawn, bring one of the project's pictures into
// its folder, and put it among the project's media.

import type { App } from "./app.ts";
import fs from "node:fs";
import { releaseText } from "./agent_text.ts";
import * as effects from "./effects.ts";
import { handlerFor, image, registerTool, text, type Content, type ToolCall } from "./mcp/registry.ts";
import { fixed } from "./rust.ts";
import * as v2cloud from "./v2_cloud.ts";

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

async function effectFootage({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const name = named(app, projectId, args);
  if (typeof args.media_id !== "string") throw new Error("media_id is required");
  const seconds = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const given = await effects.giveFootage(app, projectId, name, args.media_id, seconds(args.start), seconds(args.end), typeof args.as === "string" && args.as !== "" ? args.as : null);
  const lines = [`${fixed(given.duration, 2)} s of ${args.media_id} from ${fixed(given.start, 2)} s, in effects/${name}/:`];
  if (given.video !== null) lines.push(`- "${given.video}": its picture (${given.width}x${given.height}, no sound). Play it in the page and seek it to the moment in seek(t), returning a Promise that resolves on its "seeked" (its time 0 is ${fixed(given.start, 2)} s of the media); wait for its "loadeddata" in window.ready.`);
  if (given.levels !== null) lines.push(`- "${given.levels}": its sound's levels. Load it with <script src="${given.levels}"></script> before your own script, and they're window.levels[${JSON.stringify(given.key)}]: { fps, frames, rms: [per frame], bands: [per frame][16, low to high] }, each 0 (silent) to 1; frame i is i / fps seconds in.`);
  if (given.video === null && given.levels === null) lines.push("- nothing: it has neither picture nor sound");
  return text(lines.join("\n"));
}

/** V2's cloud is there (signed in), or the tool says why not. */
function cloudOn(): void {
  if (!v2cloud.enabled()) throw new Error("V2's cloud needs this computer signed in to Edit: nothing is kept or shared signed out");
}

/** A teacher's tool: refused, in words, to anyone else. */
function teacherOnly(what: string): void {
  if (!v2cloud.teacher()) throw new Error(`${what} is a teacher's to do (agent.teach; admins have it): this computer's account isn't one. Say so to the person: an admin can make them a teacher at accounts.spheceo.com.`);
}

const when = (at: number) => new Date(at).toISOString().replace("T", " ").slice(0, 16);

async function effectVersions({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const name = named(app, projectId, args);
  cloudOn();
  const listed = await v2cloud.versions(v2cloud.effectKey(projectId, name));
  if (listed.length === 0) return text(`${name} has no versions in V2's cloud yet: one is kept each time its code settles and renders.`);
  const item = (await v2cloud.version(v2cloud.effectKey(projectId, name)))?.item;
  return text(listed.map((one) => `- version ${one.n}${one.n === item?.current ? " (in use)" : ""}: ${when(one.at)}, ${v2cloud.whoIs(one.by)}${one.reason ? `, ${one.reason}` : ""}${one.from ? `, from ${one.from.key} version ${one.from.n}` : ""}, ${one.files?.length ?? 0} files`).join("\n"));
}

async function restoreEffect({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const name = named(app, projectId, args);
  cloudOn();
  const n = typeof args.version === "number" && Number.isInteger(args.version) ? args.version : null;
  if (n === null || n < 1) throw new Error("version is required: a version's number (effect_versions lists them)");
  const key = v2cloud.effectKey(projectId, name);
  const restored = await v2cloud.fetchInto(key, n, effects.folder(app.store, projectId, name));
  if (restored === null) throw new Error(`${name} has no version ${n}`);
  await v2cloud.setCurrent(key, n);
  return text(`${name} is version ${n} again (${when(restored.at)}${restored.reason ? `, ${restored.reason}` : ""}): the viewer plays it now and it renders by itself. The newer versions are kept; effect_versions lists them.`);
}

async function templates({ app, projectId }: ToolCall): Promise<Content[]> {
  named(app, projectId, { name: "-" });
  cloudOn();
  const listed = await v2cloud.list("template");
  if (listed.length === 0) return text("No templates yet: every effect is written from nothing until a teacher keeps one (save_template).");
  return text(listed.map((one) => `- ${one.name} (version ${one.current}): ${one.note ?? "no note"}`).join("\n"));
}

async function useTemplate({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const name = named(app, projectId, args);
  cloudOn();
  if (typeof args.template !== "string" || args.template === "") throw new Error("template is required: templates lists them");
  const into = effects.folder(app.store, projectId, name);
  if (fs.existsSync(into)) throw new Error(`there's an effect called ${name} already: name the new one something else`);
  const from = await v2cloud.fetchInto(v2cloud.templateKey(args.template), null, into);
  if (from === null) throw new Error(`no template ${args.template}: templates lists them`);
  return text(`effects/${name}/ is template ${args.template} version ${from.n} (${from.files?.length ?? 0} files): change it from there, as any effect of yours, and look at it.`);
}

async function saveTemplate({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const name = named(app, projectId, args);
  cloudOn();
  teacherOnly("Keeping a template");
  if (typeof args.note !== "string" || args.note.trim() === "") throw new Error("note is required: when to use it, in a sentence");
  const template = typeof args.template === "string" && args.template !== "" ? args.template : name;
  const dir = effects.folder(app.store, projectId, name);
  if (!fs.existsSync(dir)) throw new Error(`no effect ${name} here`);
  const kept = await v2cloud.save(v2cloud.templateKey(template), template, dir, { note: args.note.trim(), ...(typeof args.reason === "string" && args.reason !== "" ? { reason: args.reason } : {}) });
  return text(kept.made ? `Template ${template} is version ${kept.n} now, for every project.` : `Template ${template} is already exactly this (version ${kept.n}).`);
}

/** agent/'s paths a teacher's version may replace: what the release has. */
function knownPath(path: unknown): string {
  if (typeof path !== "string" || releaseText(path) === null) throw new Error(`path is a file of agent/ the release has (instructions.md, hq/notes.md, skills/<name>.md, styles/<style>/walkthrough.md…): "${String(path)}" isn't`);
  return path;
}

async function skillTextTool({ app, args, projectId }: ToolCall): Promise<Content[]> {
  named(app, projectId, { name: "-" });
  const path = knownPath(args.path);
  if (v2cloud.enabled()) await v2cloud.refreshSkills();
  const taught = v2cloud.skillText(path);
  return text(`${taught === null ? "(the release's)" : "(a teacher's, from V2's cloud)"}\n${taught ?? releaseText(path)}`);
}

async function saveSkill({ app, args, projectId }: ToolCall): Promise<Content[]> {
  named(app, projectId, { name: "-" });
  cloudOn();
  teacherOnly("Changing what the agent is taught");
  const path = knownPath(args.path);
  if (typeof args.text !== "string" || args.text.trim() === "") throw new Error("text is required: the whole file");
  if (typeof args.reason !== "string" || args.reason.trim() === "") throw new Error("reason is required: what the teacher asked, in their words");
  const saved = await v2cloud.saveSkill(path, args.text, args.reason.trim());
  v2cloud.forgetSkills();
  await v2cloud.refreshSkills().catch(() => {});
  return text(`${path} is version ${saved.n} in V2's cloud: every Bodycam HQ agent reads it from its next turn.`);
}

const TOOLS: [string, (call: ToolCall) => Promise<Content[]>][] = [
  ["effect_versions", effectVersions],
  ["restore_effect", restoreEffect],
  ["templates", templates],
  ["use_template", useTemplate],
  ["save_template", saveTemplate],
  ["skill_text", skillTextTool],
  ["save_skill", saveSkill],
  ["effect_footage", effectFootage],
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
