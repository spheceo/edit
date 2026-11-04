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

import { assetRef, FONTS, HEIGHT, WIDTH, type Design, type Layer, type Thumbnail, type ThumbImage, type ThumbRun, type ThumbTool, type ThumbTrace, type ThumbTurn } from "@edit/types/thumbnails";

import { thumbnailsGuide } from "../agent_text.ts";
import * as diag from "../diag.ts";
import { native } from "../native/index.ts";
import { join } from "../paths.ts";
import * as claude from "../writer/claude.ts";
import * as live from "../writer/live.ts";
import * as assets from "./assets.ts";
import * as cloud from "./cloud.ts";
import { canonical, checkStacked, commentOf, describe, describeComments, designOf, layerOf, makeVersion, openComments, record, removeVersion, step, switchVersion, takeFinal } from "./design.ts";
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
  cutout: (input: string, output: string, point: [number, number] | null) => native().subjectCutout(input, output, point),
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

export function liveOf(id: string): Pick<ThumbRun, "said" | "tools" | "step" | "trace"> | null {
  const run = runs.get(id);
  if (run === undefined) return null;
  return { said: run.turn.text, tools: toolsOf(run.turn), trace: traceOf(run.turn), step: run.step };
}

export const isRunning = (id: string): boolean => runs.has(id);

export function stop(id: string): boolean {
  const run = runs.get(id);
  if (run === undefined) return false;
  run.abort.abort();
  return true;
}

const toolOf = (call: { id: string; tool?: string; label: string; state: ThumbTool["state"]; detail?: string }): ThumbTool => ({
  id: call.id,
  name: call.tool ?? call.label,
  state: call.state,
  ...(call.detail ? { detail: call.detail } : {}),
});

const toolsOf = (turn: live.Turn): ThumbTool[] => turn.trace.flatMap((group) => group.calls.map(toolOf));

/** The live turn in order: reasoning, words, then the tools that followed them. */
const traceOf = (turn: live.Turn): ThumbTrace[] =>
  live.partsOf(turn).map((part) => (part.kind === "tools" ? { kind: "tools", calls: part.calls.map(toolOf) } : part));

// ---------------------------------------------------------------- the tools

type Session = { id: string; by: string; context: Context; folder: string; signal: AbortSignal; looked: boolean; changed: boolean; made: number; asked: string };
const sessions = new Map<string, Session>();

/**
 * The model a picture is made on when Claude names none, in the team's order
 * (Sphe, Nov 3): Nano Banana Pro for a new or complex picture, Nano Banana 2
 * for a touch-up of a picture given (cleaning a base, a small fix on top),
 * and Seedream Pro when Pro's look isn't wanted. The first of these OpenArt
 * has (and the account can afford) wins, so a renamed or new model is picked
 * up from OpenArt's own list.
 */
export const COMPLEX_MODELS = [/nano[\s-]?banana[\s-]?pro/i, /seedream.*pro/i, /seedream/i, /nano[\s-]?banana[\s-]?2/i, /nano[\s-]?banana/i, /gpt[\s-]?image/i, /flux.*kontext/i];
export const TOUCH_UP_MODELS = [/nano[\s-]?banana[\s-]?2/i, /nano[\s-]?banana[\s-]?pro/i, /seedream.*pro/i, /seedream/i, /nano[\s-]?banana/i, /gpt[\s-]?image/i, /flux.*kontext/i];

const LAYER_SCHEMA = {
  type: "object",
  description:
    'A layer. Picture: {kind:"image", source (an image id, or asset:<id> for a library overlay), x, y, width, height (canvas px; the canvas is 1280×720), fit ("cover" | "contain" | "stretch"), zoom (cover: 1+), focusX/focusY (cover: 0…1, the point kept in the middle), flip, rotation, opacity (0…100), adjust {exposure in stops (-5…+5, as +0.60), contrast, saturation, vibrance, warmth, shadows, highlights: -100…100; vignette, sharpen: 0…100}, shadow}. Text: {kind:"text", text (shown in lower case unless casing is "keep" or "upper"), x, y (its centre), width (wraps there), font, weight (100…900), size (px), color, align, lineHeight, casing ("keep" | "upper"; left out is lower case), italic, rotation, box {color, opacity, padX, padY, radius} (a solid box behind it), stroke {color, width}, shadow {color, opacity, angle, distance, spread (0…100), size}}. White and red (no box) is Arabic-font-2013 with no stroke and the house shadow (opacity 100, spread 36, size 32, angle 90): do not send stroke (one sent, or already on the layer, is dropped). Leave shadow out. A black box is ITC Avant Garde Gothic. Give id and name to keep track; anything left out keeps its value (a change) or the default.',
  additionalProperties: true,
};

export const TOOLS = [
  {
    name: "make_picture",
    description:
      'Make a picture on OpenArt (the team\'s account in use; it costs credits, so make what you mean to use). From the prompt alone, or from pictures you give (references: the thumbnail\'s image ids or asset:<id>): an edit of one ("remove every overlay, caption, logo and bodycam text; keep everything else exactly as it is"), or a new picture using them. A small detail added to the scene already on the canvas ("add children in the background") takes that base image\'s id as the only reference and a prompt that adds the detail and keeps everything else exactly as it is. Left unnamed, the model is the house\'s: Nano Banana Pro for a new or complex picture, Nano Banana 2 for a touch-up of a picture given; name Seedream Pro (from openart_models) when Pro\'s look isn\'t wanted. It\'s added to the thumbnail\'s images; Read the file it names before you use it. A main subject in it looks at us (into the eyes of the POV, about 15 cm above the lens) unless the person asked otherwise: say so in the prompt.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string" },
        references: { type: "array", items: { type: "string" }, maxItems: 6 },
        model: { type: "string", description: "An OpenArt model id from openart_models; left out, the house's default (Nano Banana Pro, or Nano Banana 2 for a touch-up of a picture given)." },
        aspect_ratio: { type: "string", description: 'Default "16:9".' },
        name: { type: "string", description: 'What it is, for the images list ("base, overlays removed").' },
        options: { type: "object", description: "The model's own options (model_options names them)." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "picture_prompt",
    description:
      "A made picture's stored prompts, pulled again at any time (long after the chat has moved on): the person's own request that turn, and the exact OpenArt prompt and model that made it. For a different moment, framing or scene, start from that exact prompt and change the one thing asked, not a new prompt from memory. A small detail added to the scene that's already there is not this: make_picture with that picture as the only reference.",
    inputSchema: { type: "object", additionalProperties: false, properties: { image: { type: "string", description: "The picture's image id." } }, required: ["image"] },
  },
  {
    name: "new_version",
    description:
      "Start another version of this thumbnail (V2, then V3…): the layout as it stands is kept as V1 if it isn't a version yet, and a copy of it becomes the new version, showing. Each version keeps its own layers from there. Only when the person asks for another version.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "switch_version",
    description: "Work on another version of this thumbnail (its name, V1 / V2…): your tools change and draw that one from here. The person's own view doesn't move, so look at or compare other versions freely. The one left keeps its layers. Draws it: Read it.",
    inputSchema: { type: "object", additionalProperties: false, properties: { version: { type: "string" } }, required: ["version"] },
  },
  {
    name: "remove_version",
    description: "Remove a version when the person asks (its name, V1 / V2…). The ones after it move down a number (remove V1 and V2 becomes V1), so use the new names from then on. If it was showing, the one beside it shows; if it was final, the one showing becomes final. Draws what's showing: Read it.",
    inputSchema: { type: "object", additionalProperties: false, properties: { version: { type: "string" } }, required: ["version"] },
  },
  {
    name: "take_final",
    description: "Take a version as the final one (what the team ships), whichever is showing: its name, V1 / V2…. Only when the person picks it.",
    inputSchema: { type: "object", additionalProperties: false, properties: { version: { type: "string" } }, required: ["version"] },
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
    description: "Lay the thumbnail out: its whole list of layers, bottom first (the picture, then overlays, then text). One editable layer per thing: the picture's adjustments live on its layer, a caption is its own text layer. Layers you name by id keep what you leave out. Draws it and names the file: Read it.",
    inputSchema: { type: "object", additionalProperties: false, properties: { layers: { type: "array", items: LAYER_SCHEMA, maxItems: 40 } }, required: ["layers"] },
  },
  {
    name: "change_layers",
    description: "Change some layers in place (each by id, only what you give), add some on top (add), remove some (remove: ids), or reorder them all (order: every id, bottom first). To change a picture's grade or a caption's words or style, change its layer by id — never add a copy on top of it. Draws it and names the file: Read it.",
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
    description: "The thumbnail drawn as it is now: the version you're working on, or another (version: V1…) without switching to it. grid: true adds a grid every 160 px across and 120 down, labelled, for placing things exactly; comments: true marks the open comments' pins on it, numbered. Read the file it names.",
    inputSchema: { type: "object", additionalProperties: false, properties: { version: { type: "string" }, grid: { type: "boolean" }, comments: { type: "boolean" } } },
  },
  {
    name: "compare",
    description:
      'Two to four pictures side by side, the same area of each blown up and labelled: to check an edit against what it had to keep. Each is an image id, a version\'s name (V1…) as it\'s drawn, or "showing". area: {x, y, width, height} in canvas px (1280×720) — the part to judge (his eyes, a face, a caption) — or comment: "#5" for the area round its pin; left out, the whole frame. Read the file it names, and judge each point plainly ("gaze: up-left in the first, straight ahead in the second").',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        pictures: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4 },
        area: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } }, required: ["x", "y", "width", "height"] },
        comment: { type: "string" },
      },
      required: ["pictures"],
    },
  },
  {
    name: "comments",
    description: "The open comments on the thumbnail as they are now (the team may pin one while you work): each with its number, version, pin and replies, and the version showing drawn with its pins. Run it before you finish any turn that changed the thumbnail: do what's new on the version showing; ask about those on other versions.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "remove_comment",
    description: "Take a comment off the thumbnail for good (#3), only when the person asks to remove or delete it. One that's done is settled, not removed.",
    inputSchema: { type: "object", additionalProperties: false, properties: { comment: { type: "string" } }, required: ["comment"] },
  },
  {
    name: "look_at_comment",
    description: "A close look at the area a comment is pinned to (#3): that part of its version blown up to the whole size, the pin marked. Read the file it names.",
    inputSchema: { type: "object", additionalProperties: false, properties: { comment: { type: "string" } }, required: ["comment"] },
  },
  {
    name: "reply_to_comment",
    description: "Answer a comment on the thumbnail (#3), shown under it for the person: when you can't quite do what it asks, or need to say what you did differently and why. The comment stays open. Say it in your message too.",
    inputSchema: { type: "object", additionalProperties: false, properties: { comment: { type: "string" }, text: { type: "string" } }, required: ["comment", "text"] },
  },
  {
    name: "settle_comment",
    description: "Settle a comment (#3) once what it asks is done and you've looked at it done: it's kept, and leaves the page. note: what you did, in a line.",
    inputSchema: { type: "object", additionalProperties: false, properties: { comment: { type: "string" }, note: { type: "string" } }, required: ["comment"] },
  },
  {
    name: "cut_out",
    description:
      "Lift a picture's subject out exactly, its own pixels (Photos' \"Copy Subject\", on this Mac, no credits): the rest of the picture transparent, at the picture's own size, added to the thumbnail's images. point: [x, y] from 0 to 1 across and down the picture, on the subject you want (his face), else every subject in it. For \"bring him over from V2\", \"he's perfect there\": never ask OpenArt to redraw a subject the person likes — cut him out and lay him over the other base as an image layer. The same box as the layer of the picture he came from puts him where he was; move or size him to sit right. Grade him to the scene's light on his own layer, then compare close: his edges, and none of the old subject showing behind (size him a touch bigger to cover, or make the base clean of the old subject first with make_picture). Read the file it names.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        image: { type: "string", description: "The picture's image id (a version's base: its layers name it)." },
        point: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
        name: { type: "string" },
      },
      required: ["image"],
    },
  },
  {
    name: "save_overlay",
    description:
      "Add a picture to the team's overlay library, for every thumbnail from now on, when the person asks (\"save this as an overlay\", \"add this to our overlays\"): the image id of a picture they gave, a short name, a note you will read later on what it is and where it goes (\"a red arrow: beside the evidence it points at\"), and covers: true when it goes over the whole canvas (a viewfinder, a frame), false for a sticker placed somewhere. It needs transparency where the picture should show through: Read it first, and say so if it has none.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { image: { type: "string" }, name: { type: "string" }, note: { type: "string" }, covers: { type: "boolean" } },
      required: ["image", "name", "note", "covers"],
    },
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

/**
 * After a change, the comments on the version showing that Claude hasn't
 * settled or answered (Sphe, Nov 4: the agent "should probably quickly run the
 * comments tool to see if there are some changes not listed in the prompt"),
 * so one pinned while it works isn't left behind.
 */
async function stillOpen(id: string): Promise<string> {
  const found = await cloud.get(id).catch(() => null);
  if (found === null) return "";
  const left = openComments(found.thumb).filter((one) => !(one.replies ?? []).some((reply) => reply.by === "claude"));
  if (left.length === 0) return "";
  return `\nOpen comments on this version not yet settled or answered: ${left.map((one) => `#${one.n} (${one.x}, ${one.y}) ${one.by}: ${one.text}`).join("; ")}. They're the team's asks too: do them, settle each one done, or answer why not.`;
}

/** The thumbnail drawn with the open comments' pins on it, for Claude to read. */
async function marked(session: Session, thumb: Thumbnail): Promise<string> {
  const marks = openComments(thumb).map((one) => ({ x: one.x, y: one.y, n: one.n }));
  const { bytes } = await hooks.draw(session.context.origin, session.id, thumb.design, { marks });
  const path = join(session.folder, `comments-${Date.now()}.png`);
  fs.writeFileSync(path, bytes);
  return path;
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
        ...(session.asked.trim() !== "" ? { request: session.asked.trim().slice(0, 4000) } : {}),
        ...(made.credits !== null ? { credits: made.credits } : {}),
        account: made.account,
        at: Date.now(),
        by: session.by,
      };
      await cloud.change(session.id, session.by, (thumb) => {
        thumb.images = [...thumb.images, image].slice(-60);
      });
      session.made++;
      return `Made ${image.id} (${size.width}×${size.height}) on ${model}${made.credits !== null ? `, about ${made.credits} credits` : ""}. Read it: ${await fileOf(session, image)}\nCheck, close (compare on the face), that the main subject looks at us — just above the lens, not off into the distance — unless the person asked otherwise; and that what had to hold did.`;
    }
    case "openart_models": {
      const list = await openart.imageModels(session.signal);
      const complex = pickModel(list, false);
      const touchUp = pickModel(list, true);
      return list
        .map((one) => `- ${one.id}: ${one.name}${one.credits !== null ? `, ${one.credits} credits` : ""}${one.edits ? ", edits pictures" : ""}${one.affordable ? "" : ", NOT affordable now"}${one.id === complex && one.id === touchUp ? " (the default)" : one.id === complex ? " (default for a new or complex picture)" : one.id === touchUp ? " (default for a touch-up)" : ""}`)
        .join("\n");
    }
    case "model_options": {
      if (typeof args.model !== "string") throw new Error("model is an OpenArt model id.");
      const form = await openart.formOf(args.model, args.edits === true, session.signal);
      return [`Aspect ratios: ${form.aspects.join(", ") || "not set"}`, `Pictures it takes: ${form.maxReferences}`, "Options:", ...form.options.map((one) => `- ${one}`)].join("\n");
    }
    case "picture_prompt": {
      const found = await cloud.get(session.id);
      if (found === null) throw new cloud.Missing("This thumbnail was deleted.");
      const image = found.thumb.images.find((one) => one.id === args.image);
      if (image === undefined) throw new Error(`There's no image ${String(args.image)}: give one of the thumbnail's image ids.`);
      if (image.prompt === undefined) return `${image.id} “${image.name}” wasn't made on OpenArt here, so no prompt is stored for it.`;
      return [
        `The person's request: ${image.request ?? "(not kept — made before requests were kept)"}`,
        `The exact OpenArt prompt (${image.model ?? "unknown model"}): ${image.prompt}`,
        ...(image.references !== undefined && image.references.length > 0 ? [`Made from: ${image.references.join(", ")}`] : []),
        `A small detail added to this scene (“add children in the background”) is not a new prompt from this: make_picture with ${image.id} as the only reference, and a prompt that adds the detail and keeps everything else exactly as it is. Start from this prompt only for a different moment, framing or scene.`,
      ].join("\n");
    }
    case "new_version": {
      let name = "";
      let design: Design | null = null;
      await cloud.change(session.id, session.by, (thumb) => {
        name = makeVersion(thumb, "claude").name;
        design = thumb.design;
      });
      session.changed = true;
      const path = await drawn(session, design!, false);
      return `Started ${name}: a copy of how it stands, now showing; the one before is kept as it was.\n${describe(design!)}\nRead the drawing: ${path}`;
    }
    case "switch_version": {
      if (typeof args.version !== "string") throw new Error("version is a version's name (V1, V2…).");
      let design: Design | null = null;
      let name = "";
      await cloud.change(session.id, session.by, (thumb) => {
        const taken = switchVersion(thumb, args.version as string);
        if (taken === null) throw new Error(`There's no version ${String(args.version)} to show: ${(thumb.versions ?? []).map((one) => one.name).join(", ") || "this thumbnail has one version"}.`);
        name = taken.name;
        design = thumb.design;
        return true;
      });
      session.changed = true;
      const path = await drawn(session, design!, false);
      return `Showing ${name}.\n${describe(design!)}\nRead the drawing: ${path}`;
    }
    case "remove_version": {
      if (typeof args.version !== "string") throw new Error("version is a version's name (V1, V2…).");
      const taken: { result?: ReturnType<typeof removeVersion>; design?: Design } = {};
      await cloud.change(session.id, session.by, (thumb) => {
        if ((thumb.versions ?? []).length < 2) throw new Error("This thumbnail has one version: there's nothing to remove it in favour of.");
        taken.result = removeVersion(thumb, args.version as string);
        taken.design = thumb.design;
      });
      const result = taken.result!;
      const design = taken.design!;
      session.changed = true;
      const path = await drawn(session, design, false);
      const moved = result.renamed.map(([from, to]) => `${from} is now ${to}`).join(", ");
      const left = result.showing === null ? "It has one version again." : `Showing ${result.showing}; ${result.final} is final.`;
      return `Removed ${result.removed}.${moved ? ` ${moved}.` : ""} ${left}\nRead the drawing: ${path}`;
    }
    case "take_final": {
      if (typeof args.version !== "string") throw new Error("version is a version's name (V1, V2…).");
      let name = "";
      await cloud.change(session.id, session.by, (thumb) => {
        const taken = takeFinal(thumb, args.version as string);
        if (taken === null) throw new Error(`There's no version ${String(args.version)}: ${(thumb.versions ?? []).map((one) => one.name).join(", ") || "this thumbnail has one version"}.`);
        name = taken.name;
      });
      return `${name} is the final version.`;
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
      return `Laid out:\n${describe(design!)}\nRead the drawing: ${path}${await stillOpen(session.id)}`;
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
      const thumb = found.thumb;
      if (typeof args.version === "string" && args.version.trim() !== "") {
        const version = thumb.versions?.find((one) => one.name.toLowerCase() === (args.version as string).trim().toLowerCase());
        if (version === undefined) throw new Error(`There's no version ${args.version}: ${(thumb.versions ?? []).map((one) => one.name).join(", ") || "it has one version"}.`);
        if (version.id !== thumb.activeVersion) {
          const marks = args.comments === true ? (thumb.comments ?? []).filter((one) => one.settled === undefined && one.version === version.id).map((one) => ({ x: one.x, y: one.y, n: one.n })) : [];
          const { bytes } = await hooks.draw(session.context.origin, session.id, version.design, { grid: args.grid === true, marks });
          const path = join(session.folder, `look-${version.name}-${Date.now()}.png`);
          fs.writeFileSync(path, bytes);
          return `${version.name}, as it stands (you're still working on ${thumb.versions?.find((one) => one.id === thumb.activeVersion)?.name}). Read it: ${path}`;
        }
      }
      if (args.comments === true) return `Read it: ${await marked(session, thumb)}`;
      const path = await drawn(session, thumb.design, args.grid === true);
      return `Read it: ${path}`;
    }
    case "compare": {
      const found = await cloud.get(session.id);
      if (found === null) throw new cloud.Missing("This thumbnail was deleted.");
      const thumb = found.thumb;
      const asked = Array.isArray(args.pictures) ? args.pictures.filter((one): one is string => typeof one === "string") : [];
      if (asked.length < 2 || asked.length > 4) throw new Error("pictures is two to four: image ids, version names (V1…) or \"showing\".");
      const panels = asked.map((one) => {
        const key = one.trim();
        const image = thumb.images.find((each) => each.id === key);
        if (image !== undefined) return { design: { layers: [{ id: "picture", name: image.name, kind: "image" as const, source: image.id, x: 0, y: 0, width: WIDTH, height: HEIGHT, fit: "cover" as const, opacity: 100 }] }, label: `${image.id} · ${image.name}`.slice(0, 70) };
        if (key.toLowerCase() === "showing") return { design: thumb.design, label: "showing" };
        const version = thumb.versions?.find((each) => each.name.toLowerCase() === key.toLowerCase());
        if (version !== undefined) return { design: version.id === thumb.activeVersion ? thumb.design : version.design, label: version.name };
        throw new Error(`There's no picture or version ${key}: give image ids, version names (${(thumb.versions ?? []).map((each) => each.name).join(", ") || "it has one version"}) or "showing".`);
      });
      let area: render.Area = { x: 0, y: 0, width: WIDTH, height: HEIGHT };
      if (typeof args.comment === "string" && args.comment.trim() !== "") {
        const comment = commentOf(thumb, args.comment);
        const width = WIDTH / 2;
        const height = HEIGHT / 2;
        area = { x: Math.min(WIDTH - width, Math.max(0, comment.x - width / 2)), y: Math.min(HEIGHT - height, Math.max(0, comment.y - height / 2)), width, height };
      } else if (args.area !== null && typeof args.area === "object") {
        const given = args.area as Record<string, unknown>;
        const x = Math.min(WIDTH - 16, Math.max(0, Number(given.x) || 0));
        const y = Math.min(HEIGHT - 16, Math.max(0, Number(given.y) || 0));
        area = { x, y, width: Math.min(WIDTH - x, Math.max(16, Number(given.width) || WIDTH)), height: Math.min(HEIGHT - y, Math.max(16, Number(given.height) || HEIGHT)) };
      }
      const { bytes, missing } = await render.compare(session.context.origin, session.id, panels, area);
      const path = join(session.folder, `compare-${Date.now()}.png`);
      fs.writeFileSync(path, bytes);
      return `${panels.map((one) => one.label).join(" | ")}, the area from (${Math.round(area.x)}, ${Math.round(area.y)}) to (${Math.round(area.x + area.width)}, ${Math.round(area.y + area.height)}).${missing.length > 0 ? ` (Not drawn, missing: ${missing.join(", ")})` : ""} Read it: ${path}`;
    }
    case "comments": {
      const found = await cloud.get(session.id);
      if (found === null) throw new cloud.Missing("This thumbnail was deleted.");
      const listed = describeComments(found.thumb);
      if (listed === "") return "No open comments.";
      return `${listed}${openComments(found.thumb).length > 0 ? `\nWith their pins (Read it): ${await marked(session, found.thumb)}` : ""}`;
    }
    case "remove_comment": {
      let n = 0;
      await cloud.change(session.id, session.by, (thumb) => {
        const comment = commentOf(thumb, args.comment);
        n = comment.n;
        thumb.comments = (thumb.comments ?? []).filter((one) => one !== comment);
      });
      return `Removed #${n}.`;
    }
    case "look_at_comment": {
      const found = await cloud.get(session.id);
      if (found === null) throw new cloud.Missing("This thumbnail was deleted.");
      const comment = commentOf(found.thumb, args.comment);
      const design = comment.version === undefined || comment.version === found.thumb.activeVersion ? found.thumb.design : found.thumb.versions?.find((one) => one.id === comment.version)?.design;
      if (design === undefined) throw new Error(`#${comment.n}'s version was removed.`);
      // A quarter of the canvas around the pin (half across, half down), kept inside it.
      const width = WIDTH / 2;
      const height = HEIGHT / 2;
      const area = { x: Math.min(WIDTH - width, Math.max(0, comment.x - width / 2)), y: Math.min(HEIGHT - height, Math.max(0, comment.y - height / 2)), width, height };
      const { bytes } = await hooks.draw(session.context.origin, session.id, design, { marks: [{ x: comment.x, y: comment.y, n: comment.n }], area });
      const path = join(session.folder, `comment-${comment.n}-${Date.now()}.png`);
      fs.writeFileSync(path, bytes);
      return `#${comment.n} (${comment.by}): ${comment.text}\nThe area from (${area.x}, ${area.y}) to (${area.x + width}, ${area.y + height}), twice its size, the pin at (${comment.x}, ${comment.y}). Read it: ${path}`;
    }
    case "reply_to_comment":
    case "settle_comment": {
      const text = typeof args.text === "string" ? args.text.trim().slice(0, 2000) : typeof args.note === "string" ? args.note.trim().slice(0, 400) : "";
      if (name === "reply_to_comment" && text === "") throw new Error("text is your answer.");
      let n = 0;
      await cloud.change(session.id, session.by, (thumb) => {
        const comment = commentOf(thumb, args.comment);
        n = comment.n;
        if (name === "reply_to_comment") comment.replies = [...(comment.replies ?? []), { by: "claude", text, at: Date.now() }];
        else if (comment.settled === undefined) comment.settled = { by: "claude", at: Date.now(), ...(text !== "" ? { note: text } : {}) };
        else return false;
      });
      return name === "reply_to_comment" ? `Answered #${n}; it stays open.` : `Settled #${n}.`;
    }
    case "cut_out": {
      const found = await cloud.get(session.id);
      if (found === null) throw new cloud.Missing("This thumbnail was deleted.");
      const source = found.thumb.images.find((one) => one.id === args.image);
      if (source === undefined) throw new Error(`There's no image ${String(args.image)}: give one of the thumbnail's image ids.`);
      const point = Array.isArray(args.point) && args.point.length === 2 && args.point.every((one) => typeof one === "number" && one >= 0 && one <= 1) ? ([args.point[0], args.point[1]] as [number, number]) : null;
      if (args.point !== undefined && point === null) throw new Error("point is [x, y], each from 0 to 1 across and down the picture.");
      const input = await fileOf(session, source);
      const output = join(session.folder, `cutout-${Date.now()}.png`);
      const box = await hooks.cutout(input, output, point);
      const bytes = new Uint8Array(fs.readFileSync(output));
      const key = await cloud.put(session.id, bytes, "image/png", "png");
      const image: ThumbImage = {
        id: newId(),
        name: typeof args.name === "string" && args.name.trim() !== "" ? args.name.trim().slice(0, 80) : `${source.name.slice(0, 50)}, subject cut out`,
        key,
        from: "cutout",
        cutFrom: source.id,
        width: source.width,
        height: source.height,
        at: Date.now(),
        by: session.by,
      };
      await cloud.change(session.id, session.by, (thumb) => {
        thumb.images = [...thumb.images, image].slice(-60);
      });
      const shown = `${box.map((one) => one.toFixed(2)).join(", ")}`;
      return `Cut out ${image.id} from ${source.id} (${source.width}×${source.height}, transparent but for the subject; the subject spans ${shown} of it, x0, y0, x1, y1 from the top left). Over the canvas as its picture's layer was (cover, 0, 0, 1280×720) he sits where he was. Read it: ${output}`;
    }
    case "save_overlay": {
      const found = await cloud.get(session.id);
      if (found === null) throw new cloud.Missing("This thumbnail was deleted.");
      const image = found.thumb.images.find((one) => one.id === args.image);
      if (image === undefined) throw new Error(`There's no image ${String(args.image)}: give one of the thumbnail's image ids.`);
      const name = typeof args.name === "string" ? args.name.trim().slice(0, 80) : "";
      if (name === "") throw new Error("name is a few words.");
      const type = assets.typeOf(image.key);
      const extension = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
      const asset = await assets.add({ bytes: await assets.cached(session.context.cacheDir, image.key), type, extension, width: image.width, height: image.height }, name, typeof args.note === "string" ? args.note : "", args.covers === false ? "sticker" : "overlay", session.by);
      return `Saved to the team's library as asset:${asset.id} “${asset.name}”.`;
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
  checkStacked(layers);
  return { layers };
}

/**
 * What a turn is told about the picture already on the canvas (Sphe, Nov 3:
 * “try add children in the background” means this exact scene again, with
 * that detail — the base goes to OpenArt as the reference). A different
 * moment, framing or scene is the only time to start from the stored prompt.
 */
export function baseBrief(thumb: Thumbnail): string {
  const layer = thumb.design.layers.find((one) => one.kind === "image" && !one.source.startsWith("asset:"));
  if (layer === undefined || layer.kind !== "image") return "";
  const image = thumb.images.find((one) => one.id === layer.source);
  const who = image !== undefined ? `${layer.source} “${image.name}”` : layer.source;
  const edit = `A small detail added to this exact scene (“add children in the background”, “try add one or two kids”) is an edit of it: make_picture with ${layer.source} as the only reference and a prompt that adds the detail and keeps everything else exactly as it is, then point layer ${layer.id} at the new picture (change its source by id; never stack the new picture on top). Only a different moment, framing or scene is a fresh generation.`;
  const scene = `# The picture on the canvas\nThe scene is ${who}, layer ${layer.id}. ${edit}`;
  if (image?.prompt === undefined) return scene;
  return [
    scene,
    `# The base picture's stored prompts (still here after the chat has moved on)\nThe person's request: ${image.request ?? "(not kept)"}\nThe exact OpenArt prompt (${image.model ?? "?"}): ${image.prompt}\nFor a different moment, framing or scene, start from that exact prompt and change the one thing asked — never write a fresh prompt from memory of it.`,
  ].join("\n\n");
}

/** The house's pick from OpenArt's models: a touch-up (a picture given) takes Nano Banana 2 first, a new or complex picture Nano Banana Pro. */
export function pickModel(list: openart.Model[], edits: boolean): string | null {
  const usable = list.filter((one) => one.affordable && (!edits || one.edits));
  for (const pattern of edits ? TOUCH_UP_MODELS : COMPLEX_MODELS) {
    const found = usable.find((one) => pattern.test(one.id) || pattern.test(one.name));
    if (found !== undefined) return found.id;
  }
  return usable[0]?.id ?? null;
}

async function defaultModel(edits: boolean, signal: AbortSignal): Promise<string> {
  const picked = pickModel(await openart.imageModels(signal), edits);
  if (picked === null) throw new Error("OpenArt has no image model the team's account can use now.");
  return picked;
}

// ---------------------------------------------------------------- the prompt

async function prompt(session: Session, thumb: Thumbnail, asked: string, given: string[]): Promise<string> {
  const library = await assets.all().catch(() => assets.BUILT_IN);
  const images: string[] = [];
  for (const image of thumb.images.slice(-24)) {
    const path = await fileOf(session, image).catch(() => null);
    images.push(`- ${image.id} “${image.name}” (${image.from}${image.model ? `, ${image.model}` : ""}, ${image.width}×${image.height})${image.references !== undefined && image.references.length > 0 ? `, made from ${image.references.join(", ")}` : ""}${image.prompt !== undefined ? `, its OpenArt prompt is stored (picture_prompt ${image.id})` : ""}${given.includes(image.id) ? " — given with this message" : ""}${path !== null ? `: ${path}` : ""}`);
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
    baseBrief(thumb),
    (thumb.versions ?? []).length > 1 ? `# Versions: ${(thumb.versions ?? []).map((one) => `${one.name}${one.id === thumb.activeVersion ? " (the person is looking at it: yours to work on)" : ""}${one.id === thumb.finalVersion ? " (final)" : ""}`).join(", ")}\nLook at or compare another with look / compare (version), without switching; switch_version only to change another. The person's view never moves with yours.` : "",
    current !== null ? `# As it looks now (Read it)\n${current}` : "",
    await commentsBrief(session, thumb),
    (thumb.history ?? []).length > 0 ? `# Recent changes to the layout (newest last; undo steps back through them)\n${(thumb.history ?? []).slice(-8).map((one) => `- ${one.by === "claude" ? "you" : one.by}: ${one.label}`).join("\n")}` : "",
    `# The library (asset:<id> as a layer's source or a reference)\n${library.map((one) => `- asset:${one.id} “${one.name}” (${one.kind}, ${one.width}×${one.height}${one.builtIn ? "" : `, the team's`}): ${one.note}`).join("\n")}`,
    `# Fonts\n${FONTS.map((one) => `- ${one.family}: ${one.note}`).join("\n")}`,
    recent.length > 0 ? `# The conversation so far\n${recent.join("\n\n")}` : "",
    `# The person asks\n${asked}`,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

/**
 * The open comments, for every turn (Sphe, Nov 4: "we shouldn't expect the
 * user to insert some sort of specific prompt… we need to give the agents
 * access to the comments"): each with its number, version, pin and replies,
 * and the version showing drawn with its pins.
 */
async function commentsBrief(session: Session, thumb: Thumbnail): Promise<string> {
  const listed = describeComments(thumb);
  if (listed === "") return "";
  const pins = openComments(thumb).length > 0 ? await marked(session, thumb).catch(() => null) : null;
  return [`# Comments the team pinned on it (open)\n${listed}`, pins !== null ? `With their pins, numbered (Read it): ${pins}` : ""].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------- turns

type Ending = { state: ThumbRun["state"]; error?: string; text: string };

/**
 * A turn of the conversation: answers once it's queued. `version`: the one the
 * person is looking at as they send, which the turn works on ("this one").
 */
export async function chat(context: Context, id: string, text: string, images: string[], version?: string): Promise<void> {
  const asked = text.trim();
  if (asked === "" && images.length === 0) throw new Error("Write what you'd like.");
  if ([...asked].length > 4000) throw new Error("Keep the message under 4,000 characters.");
  if (runs.has(id)) throw new Error("Claude is already working on this thumbnail: wait for it, or stop it.");
  // Taken before the cloud is written, so a second message sent at once finds it taken.
  runs.set(id, { turn: { text: "", trace: [], startedAt: Date.now() }, abort: new AbortController(), step: "Waiting for a turn" });
  try {
    await cloud.change(id, context.by, (thumb) => {
      const other = thumb.run;
      if (other !== null && (other.state === "running" || other.state === "queued") && other.holder !== context.holder && Date.now() - other.startedAt < 20 * 60_000) {
        throw new Error(`Claude is working on this thumbnail on ${other.holder}: wait for it there.`);
      }
      if (version !== undefined && version !== thumb.activeVersion && (thumb.versions ?? []).some((one) => one.id === version)) switchVersion(thumb, version);
      thumb.run = { state: "queued", holder: context.holder, by: context.by, startedAt: Date.now(), step: "Waiting for a turn" };
      thumb.chat = [...thumb.chat, { role: "you" as const, text: asked, at: Date.now(), by: context.by, ...(images.length > 0 ? { images } : {}) }].slice(-KEPT_TURNS);
    });
  } catch (error) {
    runs.delete(id);
    throw error;
  }
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
      const session: Session = { id, by: context.by, context, folder, signal, looked: false, changed: false, made: 0, asked };
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
