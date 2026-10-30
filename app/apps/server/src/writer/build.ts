// A footage script built by Opus with Script mode's tools: it reads the same
// evidence and guides as Repack's one-answer build, then writes the plan with
// tools, a section at a time, so no reply has to hold the whole plan (the "ran
// out of room" a long script can hit). The draft lives here and the tools are
// served over MCP on Edit's own server (`/mcp/writer/<token>`, a random token
// per build: nothing else can call them). Each item is checked as it arrives,
// as `plan.itemClip` checks it; `review_plan` and `finish` check the whole plan
// as it will be saved. Repairs are targeted calls on items by id.
//
// The fast build (everyone's) goes in three phases on the same tools: Opus
// outlines the script, writes its sections at once (one call each), then
// reviews and finishes the joined plan. Every phase reads the same system
// prompt, tools and evidence, so the sections and the finish read the
// outline's from the prompt cache. Without an outline it builds in steps.

import type { Clip, Research, Script } from "@edit/types/writer";

import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import { json, empty } from "../http/errors.ts";
import { readJson, type Router } from "../http/router.ts";
import { isCutIn } from "./blocks.ts";
import * as claude from "./claude.ts";
import type { Format } from "./formats.ts";
import { isFoia } from "./formats.ts";
import { pageCount } from "./pages.ts";
import { clock } from "./paragraphs.ts";
import { cleanupLine, compile, evidence, formatOfScript, itemClip, offTarget, reportOf, systemPrompt, wordAt, type Compiled, type Item, type Plan } from "./plan.ts";

/** Items one call may add or replace: small replies, whatever the script's length. */
const MAX_ITEMS_PER_CALL = 40;
/** Turns before the build stops (each tool call is one). */
const MAX_TURNS = 90;
/** Sections a fast build's outline may have: as many calls at once. */
const MAX_SECTIONS = 8;

/** A finished build: the cut, the report for the producer, its cost, the plan it was compiled from (to cut again once heard exactly), and how it went. */
export interface Built {
  clips: Clip[];
  report: string;
  costUsd: number;
  plan: Plan;
  stats: Record<string, unknown>;
}

/** Which part of a build a draft is for: the whole build in steps, or a fast build's outline, one of its sections, or its finish. */
type Phase = "steps" | "outline" | "section" | "finish";

interface Section {
  title: string;
  plan: string;
  seconds: number;
}

/** A fast build's outline: its sections in timeline order. */
interface Outline {
  sections: Section[];
  opening: string | null;
  report: string;
}

export interface Draft {
  phase: Phase;
  script: Script;
  format: Format;
  peaks: ArrayLike<number>;
  /** The plan so far, in timeline order: each item with its id ("i12"). */
  items: [string, Item][];
  opening: string | null;
  next: number;
  calls: number;
  refused: number;
  /** The biggest single tool call's arguments, in bytes: no reply holds more. */
  biggestCall: number;
  /** The plan as saved, once `finish` passes. */
  done: [Compiled, string] | null;
  /** A plan that passed but missed its target, kept if no better comes. */
  best: [Compiled, string, string] | null;
  /** `finish` called on an off-target plan: a second one keeps it. */
  offTargetFinishes: number;
  /** A fast build's section that a cut-in comes before (every one but the first). */
  afterCutIn: boolean;
  outline: Outline | null;
  /** A section's note for the finish, once `finish_section` is called. */
  sectionNote: string | null;
}

export function newDraft(phase: Phase, script: Script, peaks: ArrayLike<number>): Draft {
  return { phase, script, format: formatOfScript(script), peaks, items: [], opening: null, next: 0, calls: 0, refused: 0, biggestCall: 0, done: null, best: null, offTargetFinishes: 0, afterCutIn: false, outline: null, sectionNote: null };
}

const drafts = new Map<string, Draft>();

/** The system prompt: the one-answer build's, word for word, but for how the plan is written. */
export function stepsSystem(script: Script, format: Format): string {
  const base = systemPrompt(script, format)
    .replace("then answer ONCE with the complete plan.", "then write the complete plan with Writer's tools, a section at a time.")
    .replace(
      "Here there are none and you need none: the complete transcript is in the message, your answer is the build_script plan.",
      "Here you have Writer's own tools instead (below): the complete transcript is in the message, and you write the plan with them.",
    )
    .replace(' Also give opening: "one-run" or "two-split".', ' Also set the opening (set_opening): "one-run" or "two-split".');
  const opening = isFoia(format) ? " Call set_opening once with how this FOIA script opens." : "";
  return `${base}

WRITING THE PLAN WITH WRITER'S TOOLS
Write the plan in timeline order with add_section: one call per footage block and its cut-in, or two, at most ${MAX_ITEMS_PER_CALL} items a call. Each call adds after the last item unless you name \`after\` (an item ID). Each item is checked as it arrives (its word IDs in order, recording boundaries, narration, em dashes, reused cases); if one is refused, the call adds nothing: fix that item and call again.${opening} When the whole plan is in, call review_plan: it checks the whole script as the app will save it (its shape, the intro replay, the format's rules and length targets) and gives the totals. Fix what it reports with replace_items or remove_items, naming items by ID; never send the whole plan again. Then call finish with your report. Only the tools save the plan: don't write it out in a reply. If finish says the length is off target, fix it once; calling finish again keeps it as it is.`;
}

const ITEM = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["clip", "cut-in"] },
    firstWordId: { type: "string", description: "firstWordId" },
    lastWordId: { type: "string", description: "lastWordId" },
    narration: { type: "string", description: "narration" },
    reuseLink: { type: "string", description: "reuseLink" },
  },
  required: ["kind"],
};

const ITEMS = { type: "array", minItems: 1, maxItems: MAX_ITEMS_PER_CALL, items: ITEM };

const empty_ = { type: "object", additionalProperties: false, properties: {} };

/** The tools of a build in steps. */
const STEPS_TOOLS = [
  {
    name: "add_section",
    description: "description",
    inputSchema: { type: "object", additionalProperties: false, properties: { items: ITEMS, after: { type: "string", description: "inputSchema" } }, required: ["items"] },
  },
  {
    name: "replace_items",
    description: "description",
    inputSchema: { type: "object", additionalProperties: false, properties: { from: { type: "string" }, to: { type: "string" }, items: ITEMS }, required: ["from", "to", "items"] },
  },
  {
    name: "remove_items",
    description: "description",
    inputSchema: { type: "object", additionalProperties: false, properties: { ids: { type: "array", items: { type: "string" }, minItems: 1 } }, required: ["ids"] },
  },
  {
    name: "set_opening",
    description: "description",
    inputSchema: { type: "object", additionalProperties: false, properties: { opening: { type: "string", enum: ["one-run", "two-split"] } }, required: ["opening"] },
  },
  { name: "read_plan", description: "description", inputSchema: empty_ },
  { name: "review_plan", description: "description", inputSchema: empty_ },
  {
    name: "finish",
    description: "description",
    inputSchema: { type: "object", additionalProperties: false, properties: { report: { type: "string", description: "inputSchema" } }, required: ["report"] },
  },
];

/** The fast build's own two, listed in every phase so the tools stay in the prompt cache from one to the next. */
const FAST_TOOLS = [
  {
    name: "set_outline",
    description: "description",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sections: {
          type: "array",
          minItems: 1,
          maxItems: MAX_SECTIONS,
          items: {
            type: "object",
            additionalProperties: false,
            properties: { title: { type: "string" }, plan: { type: "string", description: "plan" }, footageSeconds: { type: "integer", minimum: 0 } },
            required: ["title", "plan", "footageSeconds"],
          },
        },
        opening: { type: "string", enum: ["one-run", "two-split"], description: "opening" },
        report: { type: "string", description: "report" },
      },
      required: ["sections", "report"],
    },
  },
  {
    name: "finish_section",
    description: "description",
    inputSchema: { type: "object", additionalProperties: false, properties: { note: { type: "string" } } },
  },
];

/** The tools, as MCP lists them. */
export function toolsOf(draft: Draft): unknown[] {
  return draft.phase === "steps" ? STEPS_TOOLS : [...STEPS_TOOLS, ...FAST_TOOLS];
}

type Args = Record<string, unknown>;

/** One tool call: the text to answer with, and whether it's a refusal. */
export function call(draft: Draft, name: string, args: Args): [string, boolean] {
  draft.calls++;
  draft.biggestCall = Math.max(draft.biggestCall, JSON.stringify(args).length);
  try {
    const refusal = outOfPhase(draft.phase, name);
    if (refusal !== null) throw new Error(refusal);
    return [run(draft, name, args), false];
  } catch (error) {
    draft.refused++;
    return [diag.messageOf(error), true];
  }
}

function run(draft: Draft, name: string, args: Args): string {
  switch (name) {
    case "add_section":
      return add(draft, args);
    case "replace_items":
      return replace(draft, args);
    case "remove_items":
      return remove(draft, args);
    case "set_opening":
      if (args.opening !== "one-run" && args.opening !== "two-split") throw new Error("Give opening as one-run or two-split.");
      draft.opening = args.opening;
      return `Opening set: ${args.opening}.`;
    case "read_plan":
      return read(draft);
    case "review_plan":
      return review(draft)[0];
    case "finish":
      return finish(draft, typeof args.report === "string" ? args.report : "");
    case "set_outline":
      return setOutline(draft, args);
    case "finish_section":
      return finishSection(draft, args);
    default:
      throw new Error(`Writer has no tool called ${name}.`);
  }
}

/** Why a tool isn't this phase's, if it isn't. */
function outOfPhase(phase: Phase, name: string): string | null {
  const allowed =
    name === "set_outline"
      ? phase === "outline"
      : name === "finish_section"
        ? phase === "section"
        : ["review_plan", "finish", "set_opening"].includes(name)
          ? phase === "steps" || phase === "finish"
          : phase !== "outline";
  const what = phase === "steps" || phase === "finish" ? "review_plan, fix it, then finish" : phase === "outline" ? "set the outline with set_outline, adding no items" : "write your section with add_section, then call finish_section";
  return allowed ? null : `${name} isn't part of this phase: ${what}.`;
}

function setOutline(draft: Draft, args: Args): string {
  const given = Array.isArray(args.sections) ? (args.sections as Args[]) : [];
  if (given.length === 0) throw new Error("Give at least one section.");
  if (given.length > MAX_SECTIONS) throw new Error(`At most ${MAX_SECTIONS} sections: join some.`);
  const sections = given.map((section, index) => {
    const text = (key: string) => (typeof section[key] === "string" ? (section[key] as string).trim() : "");
    if (text("title") === "" || text("plan") === "") throw new Error(`Section ${index + 1} needs a title and a plan.`);
    return { title: text("title"), plan: text("plan"), seconds: typeof section.footageSeconds === "number" ? Math.max(0, Math.floor(section.footageSeconds)) : 0 };
  });
  let opening: string | null = null;
  if (args.opening !== undefined && args.opening !== "") {
    if (args.opening !== "one-run" && args.opening !== "two-split") throw new Error("Give opening as one-run or two-split.");
    opening = args.opening;
  }
  if (isFoia(draft.format) && opening === null) throw new Error("Give the FOIA script's opening: one-run or two-split.");
  const report = typeof args.report === "string" ? args.report.trim() : "";
  if (report === "") throw new Error("Give your report for the producer.");
  draft.outline = { sections, opening, report };
  return `Outline set: ${sections.length} sections. End your turn now.`;
}

function finishSection(draft: Draft, args: Args): string {
  if (draft.items.length === 0) throw new Error("Your section has no items yet: add them with add_section first.");
  draft.sectionNote = typeof args.note === "string" ? args.note.trim() : "";
  return "Section saved. End your turn now.";
}

/** The items a call brings, each checked where it will sit. */
function checked(draft: Draft, at: number, given: unknown): Item[] {
  const items = Array.isArray(given) ? (given as Item[]) : [];
  if (items.length === 0) throw new Error("Give at least one item.");
  if (items.length > MAX_ITEMS_PER_CALL) throw new Error(`At most ${MAX_ITEMS_PER_CALL} items a call: split it.`);
  if (draft.items.length + items.length > 500) throw new Error("A plan holds at most 500 items.");
  let opened = draft.afterCutIn || draft.items.slice(0, at).some(([, item]) => item.kind === "cut-in");
  for (const [index, item] of items.entries()) {
    let clip: Clip;
    try {
      clip = itemClip(draft.script, draft.format, item, opened);
    } catch (error) {
      throw new Error(`Item ${index + 1} of this call was refused, so nothing was added: ${diag.messageOf(error)}`);
    }
    opened ||= isCutIn(clip);
  }
  return items;
}

function position(draft: Draft, id: string): number {
  const at = draft.items.findIndex(([known]) => known === id);
  if (at < 0) throw new Error(`There's no item ${id} in the plan (read_plan lists them).`);
  return at;
}

function insert(draft: Draft, at: number, items: Item[]): string {
  const lines = items.map((item, offset) => {
    const id = `i${++draft.next}`;
    draft.items.splice(at + offset, 0, [id, item]);
    return line(draft.script, id, item);
  });
  return `${lines.length} added (${draft.items.length} items in the plan now):\n${lines.join("\n")}`;
}

function add(draft: Draft, args: Args): string {
  const after = typeof args.after === "string" ? args.after : "";
  const at = after === "" ? draft.items.length : after === "start" ? 0 : position(draft, after) + 1;
  return insert(draft, at, checked(draft, at, args.items));
}

function replace(draft: Draft, args: Args): string {
  const from = position(draft, typeof args.from === "string" ? args.from : "");
  const to = position(draft, typeof args.to === "string" ? args.to : "");
  if (to < from) throw new Error("`from` comes after `to`: name the first item, then the last.");
  const kept = draft.items.splice(from, to - from + 1);
  try {
    return `Replaced ${kept.length} items. ${insert(draft, from, checked(draft, from, args.items))}`;
  } catch (error) {
    // Nothing changes when a replacement is refused.
    draft.items.splice(from, 0, ...kept);
    throw error;
  }
}

function remove(draft: Draft, args: Args): string {
  const ids = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === "string") : [];
  for (const id of ids) position(draft, id);
  draft.items = draft.items.filter(([id]) => !ids.includes(id));
  return `Removed ${ids.join(", ")} (${draft.items.length} items in the plan now).`;
}

/** An item as the agent reads it back. */
function line(script: Script, id: string, item: Item): string {
  if (item.kind === "cut-in") {
    const narration = (item.narration ?? "").trim();
    const reuse = typeof item.reuseLink === "string" ? ` (reused case ${item.reuseLink})` : "";
    return `${id} cut-in${reuse}, ${narration.split(/\s+/u).filter(Boolean).length} words: ${narration}`;
  }
  const first = wordAt(script.words, item.firstWordId);
  const last = wordAt(script.words, item.lastWordId);
  if (first === null || last === null || first > last) return `${id} clip ${JSON.stringify(item.firstWordId ?? null)} to ${JSON.stringify(item.lastWordId ?? null)}`;
  const words = script.words.slice(first, last + 1);
  const text = (range: typeof words) => range.map((word) => word.text).join(" ");
  const start = words[0]!.startMs;
  const end = words.at(-1)!.endMs;
  const ending = words.length > 6 ? ` … ${text(words.slice(-6))}` : "";
  return `${id} clip ${words[0]!.id}–${words.at(-1)!.id} [${clock(start)}–${clock(end)}] ${Math.floor(Math.max(0, end - start) / 1000)} s: "${text(words.slice(0, 6))}${ending}"`;
}

function read(draft: Draft): string {
  if (draft.items.length === 0) return "The plan is empty.";
  const opening = draft.opening === null ? "" : `Opening: ${draft.opening}.\n`;
  return `${opening}${draft.items.map(([id, item]) => line(draft.script, id, item)).join("\n")}`;
}

function planOf(draft: Draft, report: string): Plan {
  return { items: draft.items.map(([, item]) => item), report, ...(draft.opening === null ? {} : { opening: draft.opening }) };
}

/** The whole plan checked as it will be saved: what to say, and the compiled cut and how it misses its target if it passed. */
function review(draft: Draft): [string, [Compiled, string | null] | null] {
  if (draft.items.length === 0) return ["The plan is empty: add the sections first.", null];
  let done: Compiled;
  try {
    done = compile(draft.script, planOf(draft, ""), draft.peaks);
  } catch (error) {
    return [`Not yet: ${diag.messageOf(error)}`, null];
  }
  const footage = done.clips.filter((clip) => !isCutIn(clip)).reduce((sum, clip) => sum + Math.max(0, clip.endMs - clip.startMs), 0);
  const cutIns = done.clips.filter(isCutIn).length;
  const words = done.clips.reduce((sum, clip) => sum + (clip.narration ?? "").split(/\s+/u).filter(Boolean).length, 0);
  const pages = pageCount(draft.script, done.clips);
  const miss = offTarget(draft.script, draft.format, done);
  const totals = `${clock(footage)} of footage in ${done.clips.length - cutIns} clips, ${cutIns} cut-ins (${words} words), about ${pages} Letter pages. ${cleanupLine(done)}`;
  return [miss === null ? `It passes: ${totals}` : `It passes, but off target: ${miss} ${totals}`, [done, miss]];
}

function finish(draft: Draft, given: string): string {
  const report = given.trim();
  if (report === "") throw new Error("Give your report for the producer.");
  const [said, outcome] = review(draft);
  if (outcome === null) throw new Error(said);
  const [done, miss] = outcome;
  const saved = reportOf(planOf(draft, report));
  if (miss === null) {
    draft.done = [done, saved];
    return "Saved. The script is done: end your turn now.";
  }
  draft.offTargetFinishes++;
  draft.best = [done, saved, miss];
  if (draft.offTargetFinishes >= 2) return "Kept as it is, off target. The script is done: end your turn now.";
  throw new Error(`${said} Fix the length with replace_items or remove_items, then call finish again (a second finish keeps it as it is).`);
}

/** The request after the evidence, once the note is checked. */
function request(script: Script, note: string): string {
  if (script.words.length === 0) throw new Error("Transcribe the footage before building the script.");
  const given = note.trim();
  if ([...given].length > 2_000) throw new Error("Keep the note under 2,000 characters.");
  return given === "" ? "Start the scripts workflow." : `Start the scripts workflow. ${given}`;
}

/** A draft served under a new random token. */
function open(draft: Draft): string {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
  drafts.set(token, draft);
  return token;
}

function close(token: string): Draft | null {
  const draft = drafts.get(token) ?? null;
  drafts.delete(token);
  return draft;
}

/** Edit's port, for the tools' address. */
let port = 7700;

/** One Opus turn on a draft's tools, asked twice more (20 s, then a minute later) when it failed before any tool call: Claude busy, or the connection lost for a moment. */
async function ask(system: string, prompt: string, token: string, effort: claude.Question["effort"] | null, maxTurns: number, label: string, signal?: AbortSignal): Promise<claude.Answer> {
  const question: claude.Question = { model: claude.OPUS, system, prompt, tools: `http://127.0.0.1:${port}/mcp/writer/${token}`, maxTurns, label, ...(effort ? { effort } : {}), ...(signal ? { signal } : {}) };
  for (const wait of [20_000, 60_000, null]) {
    try {
      return await claude.ask(question);
    } catch (error) {
      if (wait === null || !(error instanceof claude.Trouble) || !error.again || (drafts.get(token)?.calls ?? 1) > 0) throw error;
      diag.warn("writer", `${label}: ${error.message} Trying again in ${wait / 1000} s.`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, wait);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new claude.Trouble("Stopped by you. Completed work is saved."));
        }, { once: true });
      });
    }
  }
  throw new Error("unreachable");
}

const outputTokens = (answer: claude.Answer | null): number => ((answer?.result.usage ?? {}) as { output_tokens?: number }).output_tokens ?? 0;
const turnsOf = (answer: claude.Answer | null): number => (typeof answer?.result.num_turns === "number" ? answer.result.num_turns : 0);

const outcomeOf = (draft: Draft): string => (draft.done !== null ? "finished" : draft.best !== null ? "kept off target" : "not finished");

/** What a finished draft built: the plan that passed, else the one kept off target, else why not. */
function built(draft: Draft, answer: claude.Answer | null, failure: unknown, cost: number, stats: Record<string, unknown>): Built {
  const planned = planOf(draft, "");
  if (draft.done !== null) {
    const [done, report] = draft.done;
    return { clips: done.clips, report: `${report}\n\n${cleanupLine(done)}`, costUsd: cost, plan: planned, stats };
  }
  if (draft.best !== null) {
    const [done, report, miss] = draft.best;
    return { clips: done.clips, report: `${report}\n\n${cleanupLine(done)}\n\n${miss}`, costUsd: cost, plan: planned, stats };
  }
  if (failure !== null) throw failure;
  throw claude.stoppedShort(answer?.result ?? {}) ?? new Error("Claude stopped before the plan was finished. Build again; nothing was changed.");
}

async function settle(promise: Promise<claude.Answer>): Promise<[claude.Answer | null, unknown]> {
  try {
    return [await promise, null];
  } catch (error) {
    return [null, error];
  }
}

/** Builds the script in steps. Nothing is saved to it unless a plan passes. */
export async function buildInSteps(script: Script, note: string, research: Research | null, peaks: ArrayLike<number>, signal?: AbortSignal): Promise<Built> {
  const prompt = `${evidence(script, research)}\n\n${request(script, note)}`;
  const token = open(newDraft("steps", script, peaks));
  const [answer, failure] = await settle(ask(stepsSystem(script, formatOfScript(script)), prompt, token, null, MAX_TURNS, "Claude opus building in steps", signal));
  const draft = close(token);
  if (draft === null) throw new Error("Edit lost track of the build. Build again; nothing was changed.");
  diag.info("writer", `steps build: ${draft.calls} tool calls, ${draft.refused} refused, the biggest ${draft.biggestCall} bytes, ${draft.items.length} items in the draft, ${outcomeOf(draft)}`);
  const stats = { engine: "sdk", toolCalls: draft.calls, refused: draft.refused, biggestCallBytes: draft.biggestCall, outputTokens: outputTokens(answer), turns: turnsOf(answer) };
  return built(draft, answer, failure, answer?.costUsd ?? 0, stats);
}

/** How hard a fast build's Opus thinks, the same in every phase so the cache holds: `WRITER_FAST_EFFORT`, or medium. */
function fastEffort(): NonNullable<claude.Question["effort"]> {
  const given = process.env.WRITER_FAST_EFFORT;
  return given === "low" || given === "high" || given === "xhigh" || given === "max" ? given : "medium";
}

/** The fast build, everyone's; `WRITER_SCRIPT_BUILD=steps` asks for the build in steps instead (for comparisons). */
export const fastChosen = (): boolean => process.env.WRITER_SCRIPT_BUILD !== "steps";

function fastSystem(script: Script, format: Format): string {
  return `${stepsSystem(script, format)}

A FAST BUILD
This build goes in three phases, each its own turn with these same tools, and the end of the message says which is yours. The outline: plan the whole script and set it with set_outline, adding no items. A section: write only your section's items with add_section (fixing them with replace_items or remove_items), then call finish_section. The finish: the sections are joined into the plan; review it, fix it and finish it as above.`;
}

const outlineList = (outline: Outline): string => outline.sections.map((section, index) => `${index + 1}. ${section.title} (about ${section.seconds} s of footage): ${section.plan}`).join("\n");

export function outlinePhase(): string {
  return `YOUR PHASE: THE OUTLINE
Plan the whole script as you would write it: which moments, in what order, the intro, what each cut-in tells, the format's length targets. Then split it, in timeline order, into 2 to ${MAX_SECTIONS} sections of about equal work for writers working at the same time, each seeing only this evidence and your outline: the first holds the opening (the intro clips and the intro cut-in), the last the ending (the outro); a compilation's case is one section, or two when it's long. For each give a title; its plan, specific enough to write from without guessing (the moments it uses as [m:ss] and the word IDs where each clip starts and ends, what each cut-in tells and what the viewer already knows by then, what it must not repeat); and its footage in seconds, so the sections add up to the format's target. Call set_outline once, then end your turn.`;
}

export function sectionPhase(outline: Outline, index: number): string {
  const count = outline.sections.length;
  const last = index + 1 === count;
  const place =
    index === 0 && last
      ? "It is the whole script: it opens with the intro clips and ends with the outro."
      : index === 0
        ? "It opens the script, with the intro clips; section 2's items come after yours."
        : last
          ? `It ends the script, with the outro; it comes after section ${index}'s items, so a cut-in has already come before it.`
          : `It comes after section ${index}'s items and before section ${index + 2}'s, so a cut-in has already come before it.`;
  return `YOUR PHASE: SECTION ${index + 1} OF ${count}
The outline, written from this evidence:
${outlineList(outline)}

You write section ${index + 1} only: ${outline.sections[index]!.title}. ${place} The other sections are written at the same time by writers who don't see yours: keep to your plan's moments and length, and don't tell what another section tells. Write your items in timeline order with add_section. When they're in, call finish_section, with a note if the joining needs to know something, then end your turn.`;
}

export function finishPhase(outline: Outline, sectionNotes: string[], empty: number[]): string {
  const kept = sectionNotes.flatMap((note, index) => (note === "" ? [] : [`- Section ${index + 1}: ${note}`]));
  const notes = kept.length === 0 ? "" : `\n\nThe sections' notes:\n${kept.join("\n")}`;
  const names = empty.map((index) => String(index + 1)).join(", ");
  const missing = empty.length === 0 ? "" : `

Section ${names} came back empty: write it first, with add_section after the item before it.`;
  return `YOUR PHASE: THE FINISH
The sections were written at once from this outline and joined in order; the whole plan is in (read_plan lists it).
${outlineList(outline)}${notes}${missing}

Call review_plan and fix what it reports by ID. Read the cut-ins where the sections meet: their writers didn't see each other's words, so cut a fact told twice and make each one follow on from what came before. Then call finish with the outline's report, corrected if the plan changed: ${outline.report}`;
}

/**
 * Builds the script fast: an outline, its sections written at once, then a
 * finish on the joined plan; without an outline, in steps instead. Nothing
 * is saved to the script unless a plan passes.
 */
export async function buildFast(script: Script, note: string, research: Research | null, peaks: ArrayLike<number>, signal?: AbortSignal, stage: (text: string) => void = () => {}): Promise<Built> {
  const ask_ = request(script, note);
  const format = formatOfScript(script);
  const system_ = fastSystem(script, format);
  const base = `${evidence(script, research)}\n\n${ask_}`;
  const effort = fastEffort();
  const began = Date.now();
  const totals = { cost: 0, tokens: 0, turns: 0, calls: 0, refused: 0, biggest: 0 };
  const count = (answer: claude.Answer | null, draft: Draft | null) => {
    totals.cost += answer?.costUsd ?? 0;
    totals.tokens += outputTokens(answer);
    totals.turns += turnsOf(answer);
    if (draft !== null) {
      totals.calls += draft.calls;
      totals.refused += draft.refused;
      totals.biggest = Math.max(totals.biggest, draft.biggestCall);
    }
  };

  stage("Outlining the script");
  const outlining = open(newDraft("outline", script, peaks));
  const [outlined, outlineFailure] = await settle(ask(system_, `${base}\n\n${outlinePhase()}`, outlining, effort, 12, "Claude opus outlining", signal));
  const outlineDraft = close(outlining);
  count(outlined, outlineDraft);
  const outline = outlineDraft?.outline ?? null;
  if (outline === null) {
    if (signal?.aborted) throw outlineFailure ?? new Error("Stopped by you.");
    diag.info("writer", "fast build: no outline came back; building in steps instead");
    stage("Writing the script");
    return buildInSteps(script, note, research, peaks, signal);
  }
  const outlinedAt = Date.now();

  // The sections at once, each on its own draft.
  stage(`Writing ${outline.sections.length} sections at once`);
  const sections = await Promise.all(
    outline.sections.map(async (_, index): Promise<[Draft | null, claude.Answer | null]> => {
      const draft = newDraft("section", script, peaks);
      draft.afterCutIn = index > 0;
      const token = open(draft);
      const [answer] = await settle(ask(system_, `${base}\n\n${sectionPhase(outline, index)}`, token, effort, 40, `Claude opus writing section ${index + 1} of ${outline.sections.length}`, signal));
      return [close(token), answer];
    }),
  );
  const writtenAt = Date.now();

  // Joined in the outline's order, with new ids.
  const joined = newDraft("finish", script, peaks);
  joined.opening = outline.opening;
  const notes: string[] = [];
  const missing: number[] = [];
  for (const [index, [draft, answer]] of sections.entries()) {
    count(answer, draft);
    const kept = draft !== null && draft.items.length > 0 ? draft : null;
    if (kept === null) missing.push(index);
    notes.push(kept?.sectionNote ?? "");
    for (const [, item] of kept?.items ?? []) joined.items.push([`i${++joined.next}`, item]);
  }
  diag.info("writer", `fast build: outline in ${Math.round((outlinedAt - began) / 1000)} s, ${outline.sections.length} sections in ${Math.round((writtenAt - outlinedAt) / 1000)} s (${missing.length} empty), ${joined.items.length} items joined`);

  stage("Reviewing the joined script");
  const finishing = open(joined);
  const [answer, failure] = await settle(ask(system_, `${base}\n\n${finishPhase(outline, notes, missing)}`, finishing, effort, MAX_TURNS, "Claude opus finishing", signal));
  const draft = close(finishing);
  if (draft === null) throw new Error("Edit lost track of the build. Build again; nothing was changed.");
  count(answer, draft);
  const finishedAt = Date.now();
  diag.info("writer", `fast build: finished in ${Math.round((finishedAt - writtenAt) / 1000)} s, ${totals.calls} tool calls in all, ${totals.refused} refused, the biggest ${totals.biggest} bytes, ${draft.items.length} items in the draft, ${outcomeOf(draft)}`);
  const stats = {
    engine: "fast",
    effort,
    sections: outline.sections.length,
    emptySections: missing.length,
    toolCalls: totals.calls,
    refused: totals.refused,
    biggestCallBytes: totals.biggest,
    outputTokens: totals.tokens,
    turns: totals.turns,
    outlineSeconds: (outlinedAt - began) / 1000,
    sectionsSeconds: (writtenAt - outlinedAt) / 1000,
    finishSeconds: (finishedAt - writtenAt) / 1000,
  };
  return built(draft, answer, failure, totals.cost, stats);
}

/** Builds a footage script the way everyone does now (fast; in steps when asked for). */
export function build(script: Script, note: string, research: Research | null, peaks: ArrayLike<number>, signal?: AbortSignal, stage?: (text: string) => void): Promise<Built> {
  return fastChosen() ? buildFast(script, note, research, peaks, signal, stage) : buildInSteps(script, note, research, peaks, signal);
}

/** The tools' MCP endpoint (JSON-RPC over HTTP, JSON answers), one draft per token. */
export function routes(router: Router<App>): void {
  router.post("/mcp/writer/{token}", async (context) => {
    port = context.app.port;
    const token = context.params.token ?? "";
    const body = await readJson<unknown>(context);
    const answers = (Array.isArray(body) ? body : [body]).map((message) => answerTo(token, message)).filter((one) => one !== null);
    if (answers.length === 0) return empty(202);
    return json(Array.isArray(body) ? answers : answers[0]);
  });
}

/** Edit's port for the tools' address, set when the server starts. */
export function usePort(given: number): void {
  port = given;
}

function answerTo(token: string, message: unknown): unknown {
  if (typeof message !== "object" || message === null) return null;
  const { id, method, params } = message as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const failure = (code: number, text: string) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
  const draft = drafts.get(token);
  switch (method) {
    case "initialize":
      return reply({ protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "writer", version: "1" } });
    case "ping":
      return reply({});
    case "tools/list":
      return draft === undefined ? failure(-32001, "This build has ended.") : reply({ tools: toolsOf(draft) });
    case "tools/call": {
      if (draft === undefined) return id === undefined ? null : failure(-32001, "This build has ended.");
      const name = typeof params?.name === "string" ? params.name : "";
      const args = (typeof params?.arguments === "object" && params.arguments !== null ? params.arguments : {}) as Args;
      const [text, refused] = call(draft, name, args);
      return reply({ content: [{ type: "text", text }], isError: refused });
    }
    default:
      return id === undefined ? null : failure(-32601, `Writer has no method ${String(method)}.`);
  }
}
