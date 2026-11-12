// The agent's tools for coded effects (effects.ts; Edit V2, a project with
// `hq`). It writes an effect's code itself, with its own file tools in the
// project's effects folder (agent.ts); these are the three things code can't
// do from there: see the page drawn, bring one of the project's pictures into
// its folder, and put it among the project's media.

import type { App } from "./app.ts";
import fs from "node:fs";
import { join } from "node:path";
import * as effectInputs from "./effect_inputs.ts";
import * as effects from "./effects.ts";
import { handlerFor, image, registerTool, text, type Content, type ToolCall } from "./mcp/registry.ts";
import { fixed } from "./rust.ts";
import * as tools from "./tools.ts";
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

/** Frames a look at a stretch shows, each one, at most (1.6 s at 30 fps); 16 to a sheet, 4 across. */
export const EFFECT_FRAMES_MOST = 48;
const PER_SHEET = 16;
/** A frame's width on a sheet (px): four across stay under the 2,000 px a picture is read at whole. */
const SHEET_FRAME = 480;

/**
 * look_at_effect over a stretch, every frame of it (Sphe, Nov 12): stills at
 * moments can't show what only moves between frames, a handwriting that
 * shimmers as the board drifts under it, so a board read right in each still
 * jittered on screen. Each frame drawn by the page, tiled into numbered
 * sheets with FFmpeg, to set beside the reference's (look_at_media every_frame).
 */
async function lookAtStretch(app: ToolCall["app"], projectId: string, name: string, args: Record<string, unknown>): Promise<Content[]> {
  const fps = app.store.get(projectId)!.project.settings.fps;
  const start = typeof args.start === "number" && Number.isFinite(args.start) && args.start >= 0 ? args.start : 0;
  const end = typeof args.end === "number" && Number.isFinite(args.end) && args.end > start ? args.end : start + 1;
  const first = Math.round(start * fps);
  const last = Math.max(first, Math.round(end * fps) - 1);
  const count = Math.min(last - first + 1, EFFECT_FRAMES_MOST);
  const times = Array.from({ length: count }, (_, index) => (first + index) / fps);
  const look = await effects.look(app, projectId, name, times, SHEET_FRAME);
  const out: Content[] = [];
  const dir = fs.mkdtempSync(join(app.store.cacheDir(), "effect-frames-"));
  try {
    for (let at = 0; at < look.stills.length; at += PER_SHEET) {
      const part = look.stills.slice(at, at + PER_SHEET);
      part.forEach((still, index) => fs.writeFileSync(join(dir, `f${String(index).padStart(3, "0")}.jpg`), still.picture));
      const sheet = join(dir, `sheet-${at}.jpg`);
      const label = `drawtext=text='%{eif\\:n+${first + at}\\:d}':x=8:y=8:fontsize=22:fontcolor=yellow:box=1:boxcolor=black@0.7`;
      await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-framerate", "1", "-i", join(dir, "f%03d.jpg"), "-frames:v", "1", "-vf", `${label},tile=4x${Math.ceil(part.length / 4)}:padding=4`, "-q:v", "3", sheet]);
      const from = first + at;
      out.push(...image(new Uint8Array(fs.readFileSync(sheet)), `${name}: every frame, ${from}–${from + part.length - 1} (${fixed(from / fps, 2)}–${fixed((from + part.length - 1) / fps, 2)} s), left-to-right then down, numbered by frame`, "image/jpeg"));
      for (const file of fs.readdirSync(dir)) fs.rmSync(join(dir, file), { force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const lines: string[] = [];
  if (first + count <= last) lines.push(`Frames ${first + count}–${last} are left: look again with start ${fixed((first + count) / fps, 3)}.`);
  if (look.errors.length > 0) lines.push(`ERRORS its page threw (fix these first):\n${look.errors.map((error) => `- ${error}`).join("\n")}`);
  if (look.problems.length > 0) lines.push(`BREAKS THE EFFECT CONTRACT:\n${look.problems.map((problem) => `- ${problem}`).join("\n")}`);
  if (lines.length > 0) out.push(...text(lines.join("\n")));
  return out;
}

async function lookAtEffect({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const name = named(app, projectId, args);
  if (args.every_frame === true) return await lookAtStretch(app, projectId, name, args);
  let times: number[] | null = null;
  if (args.times !== undefined && args.times !== null) {
    if (!Array.isArray(args.times) || args.times.some((time) => typeof time !== "number" || !Number.isFinite(time) || time < 0)) throw new Error("times is a list of seconds into the effect, each 0 or more");
    if (args.times.length > 8) throw new Error("times: at most 8 moments a look");
    times = args.times as number[];
  }
  const fps = app.store.get(projectId)!.project.settings.fps;
  // detail "full": each still at the frame's own size, for small text and fine edges.
  const full = args.detail === "full";
  const look = await effects.look(app, projectId, name, times, full ? 0 : 960);
  const out: Content[] = [];
  for (const still of look.stills) out.push(...image(still.picture, `${name} at ${fixed(still.time, 2)} s${full ? ", at full size" : ""}`, still.mime));
  const lines = [`${name}: ${look.duration > 0 ? `${fixed(look.duration, 2)} s long` : "no length (window.duration)"}.`];
  // What it leaves unpainted plays over what's beneath it: said, so a background left out by mistake is seen as one.
  if (look.stills.some((still) => still.seeThrough)) lines.push("See-through where the checkerboard shows: there it plays over whatever is beneath it on the timeline. Paint a background if it should fill the frame.");
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
  return text(`${name} is media ${added.media}: ${fixed(added.duration, 2)} s (${Math.round(added.duration * fps)} frames). Place it like a video (add_clip or apply_edit_plan with media ${added.media}); the viewer plays its page live wherever its clip is, and a change to its code shows there at once. Edit's frames (render_frame, contact_sheet) show it once its render lands, a few seconds after its code stops changing.`);
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

/** A library kind as the agent names it: effect (a template) or sound. */
function kindArg(value: unknown): "template" | "sound" {
  if (value === "effect") return "template";
  if (value === "sound") return "sound";
  throw new Error('kind is effect or sound');
}

const keyOf = (kind: "template" | "sound", name: string) => (kind === "template" ? v2cloud.templateKey(name) : v2cloud.soundKey(name));

/** A name the library takes: lower-case letters, digits and hyphens. */
function libraryName(value: unknown, what: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,59}$/.test(value)) throw new Error(`${what} is lower-case letters, digits and hyphens: "${String(value)}" isn't`);
  return value;
}

async function library({ app, args, projectId }: ToolCall): Promise<Content[]> {
  named(app, projectId, { name: "-" });
  cloudOn();
  const kind = kindArg(args.kind);
  const words = typeof args.query === "string" ? args.query.toLowerCase().split(/\s+/).filter(Boolean) : [];
  const listed = (await v2cloud.list(kind, args.archived === true)).filter((one) => {
    const said = `${one.name} ${one.category ?? ""} ${one.note ?? ""}`.toLowerCase();
    return words.every((word) => said.includes(word));
  });
  const what = kind === "template" ? "effects" : "sounds";
  if (listed.length === 0) return text(words.length === 0 ? `No ${what} in V2's cloud yet: write one, and it's kept when the person says to.` : `No ${what} match "${String(args.query)}".`);
  return text(listed.map((one) => `- ${one.name}${one.archived ? " (put away)" : ""} [${one.category ?? "no category"}]: ${one.note ?? ""}${one.brief ? ` To change it: ${one.brief}` : ""}`).join("\n"));
}

async function useFromLibrary({ app, args, projectId }: ToolCall): Promise<Content[]> {
  named(app, projectId, { name: "-" });
  cloudOn();
  const kind = kindArg(args.kind);
  const name = libraryName(args.name, "name");
  const as = args.as === undefined ? name : libraryName(args.as, "as");
  const into = effects.folder(app.store, projectId, as);
  if (fs.existsSync(into)) throw new Error(`there's a folder called ${as} already: give another with as`);
  const n = typeof args.version === "number" && Number.isInteger(args.version) ? args.version : null;
  const from = await v2cloud.fetchInto(keyOf(kind, name), n, into);
  if (from === null) throw new Error(`no ${kind === "template" ? "effect" : "sound"} ${name}${n === null ? "" : ` version ${n}`} in the library`);
  return text(`effects/${as}/ is ${name} (version ${from.n}, ${from.files?.length ?? 0} files): yours to change.${kind === "sound" ? " make_sound renders it." : " Look at it, then add_effect."}`);
}

async function saveToLibrary({ app, args, projectId }: ToolCall): Promise<Content[]> {
  named(app, projectId, { name: "-" });
  cloudOn();
  teacherOnly("Keeping it in the library");
  const kind = kindArg(args.kind);
  const name = libraryName(args.name, "name");
  const as = args.as === undefined ? name : libraryName(args.as, "as");
  const line = (field: string, most: number) => {
    const value = args[field];
    if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
    if (value.length > most) throw new Error(`${field} is at most ${most} characters: keep it short`);
    return value.trim();
  };
  const dir = effects.folder(app.store, projectId, name);
  if (!fs.existsSync(join(dir, kind === "template" ? effects.ENTRY : effects.SOUND_ENTRY))) throw new Error(`effects/${name}/ has no ${kind === "template" ? effects.ENTRY : effects.SOUND_ENTRY}`);
  const kept = await v2cloud.save(keyOf(kind, as), as, dir, { category: line("category", 40), note: line("note", 160), brief: line("brief", 240), ...(typeof args.reason === "string" && args.reason !== "" ? { reason: args.reason } : {}) });
  return text(kept.made ? `${as} is version ${kept.n} in the library: what every project starts from.` : `${as} is already exactly this (version ${kept.n}).`);
}

async function archiveInLibrary({ app, args, projectId }: ToolCall): Promise<Content[]> {
  named(app, projectId, { name: "-" });
  cloudOn();
  teacherOnly("Putting it away");
  const name = libraryName(args.name, "name");
  if (args.kind === "skill" && name === v2cloud.GLOBAL) throw new Error("the global skill stays: it's Edit's own");
  const key = args.kind === "skill" ? v2cloud.skillKey(name) : keyOf(kindArg(args.kind), name);
  const archived = args.archived !== false;
  await v2cloud.archive(key, archived);
  if (args.kind === "skill") v2cloud.forgetSkills();
  return text(archived ? `${name} is put away: out of every list, its versions kept (archived: false brings it back).` : `${name} is back.`);
}

/** A memory is a line or two; a part of the edit (a skill with a note, read when needed) is longer, and still short. */
const MEMORY_MOST = 400;
const SKILL_MOST = 2_400;

async function remember({ app, args, projectId }: ToolCall): Promise<Content[]> {
  named(app, projectId, { name: "-" });
  cloudOn();
  teacherOnly("Remembering it for every Bodycam HQ agent");
  const skill = libraryName(args.skill, "skill");
  if (skill === v2cloud.GLOBAL) throw new Error("the global skill is Edit's own: give your own a name");
  if (typeof args.text !== "string" || args.text.trim() === "") throw new Error("text is required");
  if (typeof args.reason !== "string" || args.reason.trim() === "") throw new Error("reason is required: what the person said");
  const note = typeof args.note === "string" && args.note.trim() !== "" ? args.note.trim() : undefined;
  if (note !== undefined && note.length > 160) throw new Error("note is at most 160 characters: when to read it");
  await v2cloud.refreshSkills();
  // A part's skill, or one already longer than a memory (the house rules, always in mind): saved whole again with the change.
  const before = v2cloud.skill(skill);
  const part = note !== undefined || before?.note !== undefined || (before?.text.length ?? 0) > MEMORY_MOST;
  const most = part ? SKILL_MOST : MEMORY_MOST;
  if (args.text.length > most) throw new Error(`at most ${most} characters (this is ${args.text.length}): ${part ? "keep the part's skill short: its rules, not their history" : "a line or two, in the person's words"}`);
  const saved = await v2cloud.saveSkill(skill, args.text.trim(), args.reason.trim(), note);
  v2cloud.forgetSkills();
  return text(`Remembered as ${skill} (version ${saved.n}): every Bodycam HQ agent has it from its next turn.`);
}

async function readSkill({ app, args, projectId }: ToolCall): Promise<Content[]> {
  named(app, projectId, { name: "-" });
  const name = libraryName(args.name, "name");
  await v2cloud.refreshSkills();
  const found = v2cloud.skill(name);
  if (found === undefined) throw new Error(`no skill ${name}: the ones there are listed in your instructions`);
  return text(found.text);
}

async function makeSound({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const name = named(app, projectId, args);
  const made = await effects.makeSound(app, projectId, name);
  return text(`${name} is media ${made.media}: ${fixed(made.duration, 2)} s. Place it as an audio clip; make_sound again after changing its code (the same media plays the new sound).`);
}

/** A box [x0, y0, x1, y1] from the agent, or the error that says what one is. */
function boxOf(value: unknown, what: string): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4 || value.some((one) => typeof one !== "number" || !Number.isFinite(one))) throw new Error(`${what} is [x0, y0, x1, y1] in project pixels from the top-left`);
  return value as [number, number, number, number];
}

async function effectTrack({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const name = named(app, projectId, args);
  if (typeof args.time !== "number" || !Number.isFinite(args.time) || args.time < 0) throw new Error("time is required: the timeline second the boxes are as given");
  if (!Array.isArray(args.points)) throw new Error("points is a list of {name, box, boxes?}");
  const points = (args.points as unknown[]).map((given, at): effectInputs.Point => {
    const point = (typeof given === "object" && given !== null ? given : {}) as Record<string, unknown>;
    if (typeof point.name !== "string") throw new Error(`points[${at}] needs a name`);
    const boxes = Array.isArray(point.boxes)
      ? (point.boxes as unknown[]).map((more) => {
          const one = (typeof more === "object" && more !== null ? more : {}) as Record<string, unknown>;
          if (typeof one.time !== "number") throw new Error(`${point.name}'s boxes are {time, box}`);
          return { time: one.time, box: boxOf(one.box, `${point.name}'s box at ${one.time}`) };
        })
      : [];
    return { name: point.name, box: boxOf(point.box, `${point.name}'s box`), boxes };
  });
  const span: [number | null, number | null] = [typeof args.from === "number" ? args.from : null, typeof args.to === "number" ? args.to : null];
  return text(await effectInputs.track(app, projectId, name, args.time, points, span, typeof args.as === "string" ? args.as : "track"));
}

async function effectBeneath({ app, args, projectId }: ToolCall): Promise<Content[]> {
  const name = named(app, projectId, args);
  const made = await effectInputs.beneath(app, projectId, name);
  return text(
    `effects/${name}/${effectInputs.BENEATH}: what the tracks below ${name}'s clip show over its ${fixed(made.seconds, 2)} s (no sound), second t of it at second t of the effect${made.made ? "" : " (already of what's there now)"}. ` +
      `Play it in the page (a <video> you seek to t and wait for, as effect_footage's) and draw it as you like: blurred, bent, refracted, cut up. Edit makes it again by itself when what's beneath changes, or the clip moves; the effect is rendered again after it.`,
  );
}

const TOOLS: [string, (call: ToolCall) => Promise<Content[]>][] = [
  ["effect_track", effectTrack],
  ["effect_beneath", effectBeneath],
  ["effect_versions", effectVersions],
  ["restore_effect", restoreEffect],
  ["library", library],
  ["use_from_library", useFromLibrary],
  ["save_to_library", saveToLibrary],
  ["archive_in_library", archiveInLibrary],
  ["remember", remember],
  ["read_skill", readSkill],
  ["make_sound", makeSound],
  ["effect_footage", effectFootage],
  ["look_at_effect", lookAtEffect],
  ["add_effect", addEffect],
  ["effect_picture", effectPicture],
];

/** Registers the effects' tools with the MCP server (once; later calls do nothing). */
export function registerEffectTools(): void {
  effectInputs.start();
  for (const [name, handler] of TOOLS) {
    if (handlerFor(name)?.handler === handler) continue;
    registerTool(name, handler);
  }
}
