// A thumbnail's conversation with the person's own Claude Code (Opus 5.5: the
// team's subscriptions pay; Sphe, Nov 2: "conversation with claude at the
// subscription subsidisation"). Claude makes pictures on the team's OpenArt
// account (drafts, a base cleaned of its overlays), lays the thumbnail out in
// layers (the picture, its adjustments, the team's overlays, captions with
// their box, stroke and drop shadow) and looks at it drawn as the person
// sees it (render.ts) before it says it's done. Its tools check and save at
// once, so the page shows each change as it's made. Two turns at a time on a
// Mac; a turn another Mac holds is that Mac's.

import * as fs from "node:fs";

import { assetRef, FONTS, HEIGHT, WIDTH, type Design, type Layer, type Thumbnail, type ThumbImage, type ThumbRun, type ThumbTool, type ThumbTurn } from "@edit/types/thumbnails";

import { thumbnailsGuide } from "../agent_text.ts";
import * as diag from "../diag.ts";
import { join } from "../paths.ts";
import * as claude from "../writer/claude.ts";
import * as live from "../writer/live.ts";
import * as assets from "./assets.ts";
import * as cloud from "./cloud.ts";
import { describe, designOf, layerOf, record, step } from "./design.ts";
import * as openart from "./openart.ts";
import * as render from "./render.ts";
import { sizeOf } from "./size.ts";

export const AT_ONCE = 2;
const SENT_TURNS = 14;
const KEPT_TURNS = 80;

export interface Context {
  /** Where this server answers, for Chrome's page (http://127.0.0.1:<port>). */
  origin: string;
  port: number;
  cacheDir: string;
  holder: string;
  by: string;
}

/** Test hooks: how Claude is asked, how a design is drawn, how OpenArt makes a picture. */
export const hooks = {
  ask: (question: claude.Question): Promise<claude.Answer> => claude.askPatiently(question),
  draw: render.draw,
  make: openart.make,
};

let busy = 0;
const waiting: (() => void)[] = [];
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (busy >= AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve));
  busy++;
  try {
    return await work();
  } finally {
    busy--;
    waiting.shift()?.();
  }
}

type Running = { turn: live.Turn; abort: AbortController; step: string };
const runs = new Map<string, Running>();

export function liveOf(id: string): Pick<ThumbRun, "said" | "tools" | "step"> | null {
  const run = runs.get(id);
  if (run === undefined) return null;
  return { said: run.turn.text, tools: toolsOf(run.turn), step: run.step };
}

export const isRunning = (id: string): boolean => runs.has(id);

export function stop(id: string): boolean {
  const run = runs.get(id);
  if (run === undefined) return false;
  run.abort.abort();
  return true;
}

const toolsOf = (turn: live.Turn): ThumbTool[] =>
  turn.trace.flatMap((group) => group.calls.map((call) => ({ name: call.tool ?? call.label, state: call.state, ...(call.detail ? { detail: call.detail } : {}) })));

// ---------------------------------------------------------------- the tools

type Session = { id: string; by: string; context: Context; folder: string; signal: AbortSignal; looked: boolean; changed: boolean; made: number };
const sessions = new Map<string, Session>();

/** The model a picture is made on when Claude names none: the first of these OpenArt has. */
export const PREFERRED_MODELS = [/nano[\s-]?banana[\s-]?pro/i, /nano[\s-]?banana/i, /gpt[\s-]?image/i, /seedream/i, /flux.*kontext/i];

const LAYER_SCHEMA = {
  type: "object",
  description:
    'A layer. Picture: {kind:"image", source (an image id, or asset:<id> for a library overlay), x, y, width, height (canvas px; the canvas is 1280×720), fit ("cover" | "contain" | "stretch"), zoom (cover: 1+), focusX/focusY (cover: 0…1, the point kept in the middle), flip, rotation, opacity (0…100), adjust {exposure, contrast, saturation, warmth, shadows, highlights: -100…100; vignette, sharpen: 0…100}, shadow}. Text: {kind:"text", text, x, y (its centre), width (wraps there), font, weight (100…900), size (px), color, align, lineHeight, uppercase, italic, rotation, box {color, opacity, padX, padY, radius} (a solid box behind it), stroke {color, width}, shadow {color, opacity, angle, distance, spread (0…100), size}}. Give id and name to keep track; anything left out keeps its value (a change) or the default.',
  additionalProperties: true,
};

export const TOOLS = [
  {
    name: "make_picture",
    description:
      'Make a picture on OpenArt (the team\'s account, mamagi-openart-1; it costs credits, so make what you mean to use). From the prompt alone, or from pictures you give (references: the thumbnail\'s image ids or asset:<id>): an edit of one ("remove every overlay, caption, logo and bodycam text; keep everything else exactly as it is"), or a new picture using them. It\'s added to the thumbnail\'s images; Read the file it names before you use it.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string" },
        references: { type: "array", items: { type: "string" }, maxItems: 6 },
        model: { type: "string", description: "An OpenArt model id from openart_models; left out, the house's default." },
        aspect_ratio: { type: "string", description: 'Default "16:9".' },
        name: { type: "string", description: 'What it is, for the images list ("base, overlays removed").' },
        options: { type: "object", description: "The model's own options (model_options names them)." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "openart_models",
    description: "OpenArt's image models on the team's account: id, name, credits a picture, whether it edits pictures you give it. Only when the default won't do.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "model_options",
    description: "One OpenArt model's options (its aspect ratios, quality, resolution…) for make_picture's options.",
    inputSchema: { type: "object", additionalProperties: false, properties: { model: { type: "string" }, edits: { type: "boolean" } }, required: ["model"] },
  },
  {
    name: "set_layers",
    description: "Lay the thumbnail out: its whole list of layers, bottom first (the picture, then overlays, then text). Layers you name by id keep what you leave out. Draws it and names the file: Read it.",
    inputSchema: { type: "object", additionalProperties: false, properties: { layers: { type: "array", items: LAYER_SCHEMA, maxItems: 40 } }, required: ["layers"] },
  },
  {
    name: "change_layers",
    description: "Change some layers in place (each by id, only what you give), add some on top (add), remove some (remove: ids), or reorder them all (order: every id, bottom first). Draws it and names the file: Read it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        changes: { type: "array", items: LAYER_SCHEMA },
        add: { type: "array", items: LAYER_SCHEMA },
        remove: { type: "array", items: { type: "string" } },
        order: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "undo",
    description: "Step the layout back (steps: how many, default 1): the person's changes and yours are one timeline, newest first, as “Recent changes” lists them. Draws it: Read it.",
    inputSchema: { type: "object", additionalProperties: false, properties: { steps: { type: "number" } } },
  },
  {
    name: "redo",
    description: "Take back an undo (steps: how many, default 1). Draws it: Read it.",
    inputSchema: { type: "object", additionalProperties: false, properties: { steps: { type: "number" } } },
  },
  {
    name: "look",
    description: "The thumbnail drawn as it is now. grid: true adds a grid every 160 px across and 120 down, labelled, for placing things exactly. Read the file it names.",
    inputSchema: { type: "object", additionalProperties: false, properties: { grid: { type: "boolean" } } },
  },
  {
    name: "rename",
    description: "Name the thumbnail (the video or idea it's for), as the list shows it.",
    inputSchema: { type: "object", additionalProperties: false, properties: { title: { type: "string" } }, required: ["title"] },
  },
];

type Args = Record<string, unknown>;

export async function call(token: string, name: string, args: Args): Promise<[string, boolean]> {
  const session = sessions.get(token);
  if (session === undefined) return ["This turn has ended.", true];
  try {
    return [await runTool(session, name, args), false];
  } catch (error) {
    return [diag.messageOf(error), true];
  }
}

const newId = () => Math.random().toString(36).slice(2, 10);

/** The pictures a layer may show: the thumbnail's images and the library's. */
async function sourcesOf(thumb: Thumbnail): Promise<Set<string>> {
  const library = await assets.all().catch(() => assets.BUILT_IN);
  return new Set([...thumb.images.map((one) => one.id), ...library.map((one) => assetRef(one.id))]);
}

/** A picture in the turn's folder, named by its id, for Claude to read. */
async function fileOf(session: Session, image: ThumbImage): Promise<string> {
  const extension = image.key.split(".").pop() ?? "png";
  const path = join(session.folder, `${image.id}.${extension}`);
  if (!fs.existsSync(path)) fs.copyFileSync(await assets.localPath(session.context.cacheDir, image.key), path);
  return path;
}

/** A value as JSON with its keys in order: Convex keeps an object's keys sorted, so a design read back isn't written as it was saved. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : inner,
  );
}

/** The design drawn into the turn's folder (and, without the grid, kept as the thumbnail's render). */
async function drawn(session: Session, design: Design, grid: boolean): Promise<string> {
  const { bytes, missing } = await hooks.draw(session.context.origin, session.id, design, { grid });
  const path = join(session.folder, `look-${Date.now()}${grid ? "-grid" : ""}.png`);
  fs.writeFileSync(path, bytes);
  session.looked = true;
  if (!grid) {
    const key = await cloud.put(session.id, bytes, "image/png", "png");
    await cloud.change(session.id, session.by, (thumb) => {
      if (canonical(thumb.design) !== canonical(design)) return false;
      thumb.render = { key, at: Date.now() };
    });
  }
  return `${path}${missing.length > 0 ? `\n(Not drawn, missing: ${missing.join(", ")})` : ""}`;
}

async function runTool(session: Session, name: string, args: Args): Promise<string> {
  switch (name) {
    case "make_picture": {
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (prompt === "" || prompt.length > 3000) throw new Error("prompt is the picture's description, up to 3,000 characters.");
      const found = await cloud.get(session.id);
      if (found === null) throw new cloud.Missing("This thumbnail was deleted.");
      const asked = Array.isArray(args.references) ? args.references.filter((one): one is string => typeof one === "string") : [];
      const references: openart.Reference[] = [];
      for (const ref of asked) {
        const asset = ref.startsWith("asset:") ? ref.slice(6) : null;
        if (asset !== null) {
          const { bytes, type } = await assets.bytesOf(session.context.cacheDir, asset);
          references.push({ bytes, type, name: asset });
          continue;
        }
        const image = found.thumb.images.find((one) => one.id === ref);
        if (image === undefined) throw new Error(`There's no image ${ref}: give the thumbnail's image ids, or asset:<id>.`);
        references.push({ bytes: await assets.cached(session.context.cacheDir, image.key), type: assets.typeOf(image.key), name: image.name });
      }
      const model = typeof args.model === "string" && args.model.trim() !== "" ? args.model.trim() : await defaultModel(references.length > 0, session.signal);
      const aspect = typeof args.aspect_ratio === "string" && args.aspect_ratio.trim() !== "" ? args.aspect_ratio.trim() : "16:9";
      const options = args.options !== null && typeof args.options === "object" && !Array.isArray(args.options) ? (args.options as Args) : {};
      const made = await hooks.make({ prompt, model, aspect, references, options }, session.signal);
      const extension = made.type === "image/jpeg" ? "jpg" : made.type === "image/webp" ? "webp" : "png";
      const key = await cloud.put(session.id, made.bytes, made.type, extension);
      const size = sizeOf(made.bytes) ?? { width: WIDTH, height: HEIGHT };
      const image: ThumbImage = {
        id: newId(),
        name: typeof args.name === "string" && args.name.trim() !== "" ? args.name.trim().slice(0, 80) : prompt.slice(0, 60),
        key,
        from: "openart",
        width: size.width,
        height: size.height,
        prompt,
        model,
        ...(asked.length > 0 ? { references: asked } : {}),
        at: Date.now(),
        by: session.by,
      };
      await cloud.change(session.id, session.by, (thumb) => {
        thumb.images = [...thumb.images, image].slice(-60);
      });
      session.made++;
      return `Made ${image.id} (${size.width}×${size.height}) on ${model}${made.credits !== null ? `, about ${made.credits} credits` : ""}. Read it: ${await fileOf(session, image)}`;
    }
    case "openart_models": {
      const list = await openart.imageModels(session.signal);
      const fallback = await defaultModel(true, session.signal).catch(() => "");
      return list
        .map((one) => `- ${one.id}: ${one.name}${one.credits !== null ? `, ${one.credits} credits` : ""}${one.edits ? ", edits pictures" : ""}${one.affordable ? "" : ", NOT affordable now"}${one.id === fallback ? " (the default)" : ""}`)
        .join("\n");
    }
    case "model_options": {
      if (typeof args.model !== "string") throw new Error("model is an OpenArt model id.");
      const form = await openart.formOf(args.model, args.edits === true, session.signal);
      return [`Aspect ratios: ${form.aspects.join(", ") || "not set"}`, `Pictures it takes: ${form.maxReferences}`, "Options:", ...form.options.map((one) => `- ${one}`)].join("\n");
    }
    case "set_layers":
    case "change_layers": {
      let design: Design | null = null;
      const found = await cloud.get(session.id);
      if (found === null) throw new cloud.Missing("This thumbnail was deleted.");
      const sources = await sourcesOf(found.thumb);
      let same = false;
      await cloud.change(session.id, session.by, (thumb) => {
        const next = name === "set_layers" ? designOf(args.layers, thumb.design, sources) : changed(thumb.design, args, sources);
        design = next;
        same = !record(thumb, next, "claude");
        return !same;
      });
      if (same) return `Nothing changed: the layout is already that.\n${describe(design!)}`;
      session.changed = true;
      const path = await drawn(session, design!, false);
      return `Laid out:\n${describe(design!)}\nRead the drawing: ${path}`;
    }
    case "undo":
    case "redo": {
      const times = typeof args.steps === "number" && Number.isInteger(args.steps) ? Math.min(10, Math.max(1, args.steps)) : 1;
      const taken: string[] = [];
      let design: Design | null = null;
      await cloud.change(session.id, session.by, (thumb) => {
        taken.length = 0;
        for (let index = 0; index < times; index++) {
          const one = step(thumb, name === "undo");
          if (one === null) break;
          taken.push(`${one.label} (${one.by === "claude" ? "you" : one.by})`);
        }
        design = thumb.design;
        return taken.length > 0;
      });
      if (taken.length === 0) throw new Error(name === "undo" ? "There's nothing to undo." : "There's nothing to redo.");
      session.changed = true;
      const path = await drawn(session, design!, false);
      return `${name === "undo" ? "Undid" : "Redid"}: ${taken.join("; ")}.\n${describe(design!)}\nRead the drawing: ${path}`;
    }
    case "look": {
      const found = await cloud.get(session.id);
      if (found === null) throw new cloud.Missing("This thumbnail was deleted.");
      const path = await drawn(session, found.thumb.design, args.grid === true);
      return `Read it: ${path}`;
    }
    case "rename": {
      const title = typeof args.title === "string" ? args.title.trim().slice(0, 120) : "";
      if (title === "") throw new Error("title is words.");
      await cloud.change(session.id, session.by, (thumb) => {
        thumb.title = title;
      });
      return `Named “${title}”.`;
    }
    default:
      throw new Error(`There's no tool called ${name}.`);
  }
}

/** change_layers on a design: changes in place, layers added on top, some removed, a new order. */
export function changed(design: Design, args: Args, sources: Set<string>): Design {
  let layers: Layer[] = design.layers.map((one) => structuredClone(one));
  const changes = Array.isArray(args.changes) ? (args.changes as Args[]) : [];
  for (const change of changes) {
    const at = layers.findIndex((one) => one.id === change.id);
    if (at < 0) throw new Error(`There's no layer ${String(change.id)}: ${layers.map((one) => one.id).join(", ") || "no layers yet"}.`);
    layers[at] = layerOf(change, layers[at], sources);
  }
  const removed = Array.isArray(args.remove) ? new Set(args.remove as string[]) : new Set<string>();
  for (const id of removed) if (!layers.some((one) => one.id === id)) throw new Error(`There's no layer ${id} to remove.`);
  layers = layers.filter((one) => !removed.has(one.id));
  for (const one of Array.isArray(args.add) ? (args.add as Args[]) : []) {
    const layer = layerOf(one, undefined, sources);
    if (layers.some((other) => other.id === layer.id)) layer.id = newId();
    layers.push(layer);
  }
  if (Array.isArray(args.order)) {
    const order = args.order as string[];
    if (order.length !== layers.length || layers.some((one) => !order.includes(one.id))) throw new Error(`order names every layer once, bottom first: ${layers.map((one) => one.id).join(", ")}.`);
    layers = order.map((id) => layers.find((one) => one.id === id)!);
  }
  if (layers.length > 40) throw new Error("At most 40 layers.");
  return { layers };
}

async function defaultModel(edits: boolean, signal: AbortSignal): Promise<string> {
  const list = (await openart.imageModels(signal)).filter((one) => one.affordable && (!edits || one.edits));
  for (const pattern of PREFERRED_MODELS) {
    const found = list.find((one) => pattern.test(one.id) || pattern.test(one.name));
    if (found !== undefined) return found.id;
  }
  if (list[0] === undefined) throw new Error("OpenArt has no image model the team's account can use now.");
  return list[0].id;
}

// ---------------------------------------------------------------- the prompt

async function prompt(session: Session, thumb: Thumbnail, asked: string, given: string[]): Promise<string> {
  const library = await assets.all().catch(() => assets.BUILT_IN);
  const images: string[] = [];
  for (const image of thumb.images.slice(-24)) {
    const path = await fileOf(session, image).catch(() => null);
    images.push(`- ${image.id} “${image.name}” (${image.from}${image.model ? `, ${image.model}` : ""}, ${image.width}×${image.height})${given.includes(image.id) ? " — given with this message" : ""}${path !== null ? `: ${path}` : ""}`);
  }
  const current = thumb.render !== null ? await assets.localPath(session.context.cacheDir, thumb.render.key).then((path) => {
    const copy = join(session.folder, "current.png");
    fs.copyFileSync(path, copy);
    return copy;
  }).catch(() => null) : null;
  const recent = thumb.chat.slice(-SENT_TURNS - 1, -1).map((turn) => `${turn.role === "you" ? (turn.by ?? "Producer") : "You (Claude)"}: ${turn.text}`);
  return [
    `# The thumbnail: “${thumb.title || "New thumbnail"}”${thumb.brief ? `\nFor: ${thumb.brief}` : ""}`,
    `Canvas ${WIDTH}×${HEIGHT}.`,
    images.length > 0 ? `# Its images (Read the ones you use)\n${images.join("\n")}` : "# Its images\nNone yet.",
    `# The layers now, bottom first\n${describe(thumb.design)}`,
    current !== null ? `# As it looks now (Read it)\n${current}` : "",
    (thumb.history ?? []).length > 0 ? `# Recent changes to the layout (newest last; undo steps back through them)\n${(thumb.history ?? []).slice(-8).map((one) => `- ${one.by === "claude" ? "you" : one.by}: ${one.label}`).join("\n")}` : "",
    `# The library (asset:<id> as a layer's source or a reference)\n${library.map((one) => `- asset:${one.id} “${one.name}” (${one.kind}, ${one.width}×${one.height}${one.builtIn ? "" : `, the team's`}): ${one.note}`).join("\n")}`,
    `# Fonts\n${FONTS.map((one) => `- ${one.family}: ${one.note}`).join("\n")}`,
    recent.length > 0 ? `# The conversation so far\n${recent.join("\n\n")}` : "",
    `# The person asks\n${asked}`,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

// ---------------------------------------------------------------- turns

type Ending = { state: ThumbRun["state"]; error?: string; text: string };

/** A turn of the conversation: answers once it's queued. */
export async function chat(context: Context, id: string, text: string, images: string[]): Promise<void> {
  const asked = text.trim();
  if (asked === "" && images.length === 0) throw new Error("Write what you'd like.");
  if ([...asked].length > 4000) throw new Error("Keep the message under 4,000 characters.");
  if (runs.has(id)) throw new Error("Claude is already working on this thumbnail: wait for it, or stop it.");
  await cloud.change(id, context.by, (thumb) => {
    const other = thumb.run;
    if (other !== null && (other.state === "running" || other.state === "queued") && other.holder !== context.holder && Date.now() - other.startedAt < 20 * 60_000) {
      throw new Error(`Claude is working on this thumbnail on ${other.holder}: wait for it there.`);
    }
    thumb.run = { state: "queued", holder: context.holder, by: context.by, startedAt: Date.now(), step: "Waiting for a turn" };
    thumb.chat = [...thumb.chat, { role: "you" as const, text: asked, at: Date.now(), by: context.by, ...(images.length > 0 ? { images } : {}) }].slice(-KEPT_TURNS);
  });
  runs.set(id, { turn: { text: "", trace: [], startedAt: Date.now() }, abort: new AbortController(), step: "Waiting for a turn" });
  void work(context, id, asked || "Here are pictures for the thumbnail.", images);
}

async function work(context: Context, id: string, asked: string, given: string[]): Promise<void> {
  const running = runs.get(id)!;
  const signal = running.abort.signal;
  let ending: Ending;
  const folder = join(context.cacheDir, "thumbnails", `run-${id}-${Date.now()}`);
  try {
    ending = await slot(async () => {
      if (signal.aborted) return { state: "stopped" as const, text: "Stopped." };
      running.step = "Claude is working";
      const found = await cloud.change(id, context.by, (thumb) => {
        if (thumb.run === null || thumb.run.holder !== context.holder) return false;
        thumb.run = { ...thumb.run, state: "running", step: running.step };
      });
      fs.mkdirSync(folder, { recursive: true });
      const session: Session = { id, by: context.by, context, folder, signal, looked: false, changed: false, made: 0 };
      const token = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
      sessions.set(token, session);
      try {
        const ask = await prompt(session, found.thumb, asked, given);
        const answer = await live.within(running.turn, () =>
          hooks.ask({ model: claude.OPUS, system: thumbnailsGuide("guide"), prompt: ask, tools: `http://127.0.0.1:${context.port}/mcp/thumbnails/${token}`, read: folder, maxTurns: 60, effort: "medium", timeoutMs: 25 * 60_000, label: `Thumbnail ${id}`, signal }),
        );
        const said = (answer.text ?? running.turn.text).trim();
        return { state: "done" as const, text: said || (session.changed ? "Done." : "Nothing changed.") };
      } finally {
        sessions.delete(token);
      }
    });
  } catch (error) {
    const message = signal.aborted ? "Stopped." : diag.messageOf(error);
    if (!signal.aborted) diag.warn("thumbnails", `${id}: turn failed: ${message}`);
    ending = { state: signal.aborted ? "stopped" : "failed", error: message, text: message };
  }
  const tools = toolsOf(running.turn);
  const workedMs = Date.now() - running.turn.startedAt;
  fs.rmSync(folder, { recursive: true, force: true });
  try {
    await cloud.change(id, context.by, (thumb) => {
      if (thumb.run !== null && thumb.run.holder !== context.holder) return false;
      thumb.run = { state: ending.state, holder: context.holder, by: context.by, startedAt: thumb.run?.startedAt ?? Date.now(), endedAt: Date.now(), ...(ending.error ? { error: ending.error } : {}), ...(tools.length > 0 ? { tools } : {}) };
      const turn: ThumbTurn = { role: "claude", text: ending.text, at: Date.now(), workedMs, ...(tools.length > 0 ? { tools } : {}), ...(ending.state === "failed" || ending.state === "stopped" ? { failed: true } : {}) };
      thumb.chat = [...thumb.chat, turn].slice(-KEPT_TURNS);
    });
  } catch (error) {
    diag.warn("thumbnails", `${id}: saving how the turn ended: ${diag.messageOf(error)}`);
  } finally {
    runs.delete(id);
  }
}

/** Turns this Mac had going when Edit stopped: marked stopped. */
export async function markInterrupted(holder: string): Promise<void> {
  for (const row of await cloud.list()) {
    if (row.summary.run !== "running" && row.summary.run !== "queued") continue;
    await cloud
      .change(row.id, holder, (thumb) => {
        if (thumb.run === null || thumb.run.holder !== holder || (thumb.run.state !== "running" && thumb.run.state !== "queued") || runs.has(thumb.id)) return false;
        thumb.run = { ...thumb.run, state: "stopped", endedAt: Date.now(), error: "Edit restarted before Claude finished. Ask again." };
      })
      .catch((error: unknown) => diag.warn("thumbnails", `${row.id}: marking its turn stopped: ${diag.messageOf(error)}`));
  }
}

/** The MCP answer to one JSON-RPC message, on the thumbnail tools. */
export async function answerTo(token: string, message: unknown): Promise<unknown> {
  if (typeof message !== "object" || message === null) return null;
  const { id, method, params } = message as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const failure = (code: number, text: string) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
  switch (method) {
    case "initialize":
      return reply({ protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "thumbnails", version: "1" } });
    case "ping":
      return reply({});
    case "tools/list":
      return sessions.has(token) ? reply({ tools: TOOLS }) : failure(-32001, "This turn has ended.");
    case "tools/call": {
      if (!sessions.has(token)) return id === undefined ? null : failure(-32001, "This turn has ended.");
      const name = typeof params?.name === "string" ? params.name : "";
      const args = (typeof params?.arguments === "object" && params.arguments !== null ? params.arguments : {}) as Args;
      const [text, refused] = await call(token, name, args);
      return reply({ content: [{ type: "text", text }], isError: refused });
    }
    default:
      return id === undefined ? null : failure(-32601, `Thumbnails has no method ${String(method)}.`);
  }
}

/** A fresh thumbnail. */
export function fresh(id: string, by: string, title: string, brief: string): Thumbnail {
  return { id, title, brief, images: [], design: { layers: [] }, render: null, chat: [], run: null, createdAt: Date.now(), createdBy: by, updatedAt: Date.now() };
}
