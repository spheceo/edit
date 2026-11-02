// Claude's work on an idea, on this Mac with the person's own Claude Code
// (Opus 5.5: the team's subscriptions pay, not the AI gateway): a
// repackaging (the case's titles and thumbnail guide) or a turn of the
// conversation about it. Everything Claude needs is read in code first
// (sources.ts, board.ts) and goes in one prompt; Claude writes through the
// tools below, each checked (policy.ts) and saved to the cloud at once, so
// the page shows titles as they come and a refusal is fixed in the same turn.
// Three runs at a time on a Mac; a run another Mac holds is that Mac's.

import * as fs from "node:fs";

import { NICHES, type Idea, type IdeaFrame, type IdeaImage, type IdeaRun, type IdeaTool, type IdeaTurn, type Niche, type Workspace } from "@edit/types/ideas";

import { ideasGuide } from "../agent_text.ts";
import * as diag from "../diag.ts";
import { join } from "../paths.ts";
import * as claude from "../writer/claude.ts";
import * as live from "../writer/live.ts";
import * as board from "./board.ts";
import * as cloud from "./cloud.ts";
import * as frames from "./frames.ts";
import { cleanGuide, cleanTitle, closest, framesProblem, guideProblem, ORDINALS, identity, lengthStyle, sourceProblem, summaryProblem, titleProblem, type LengthStyle } from "./policy.ts";
import * as sources from "./sources.ts";

/** Runs at once on one Mac. */
export const AT_ONCE = 3;
/** Turns of the conversation that go back to Claude. */
const SENT_TURNS = 12;
/** Turns kept with the idea. */
const KEPT_TURNS = 60;

export interface Context {
  home: string;
  port: number;
  /** This Mac, as teammates see it. */
  holder: string;
  /** Who is asking (the signed-in person's name). */
  by: string;
}

/** Test hook: how Claude is asked (writer/claude.ts). */
export const asking = { ask: (question: claude.Question): Promise<claude.Answer> => claude.askPatiently(question) };

// ---------------------------------------------------------------- the queue

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
/** The runs on this Mac, by idea: their live turn (what Claude has said, its tools) and how to stop them. */
const runs = new Map<string, Running>();

/** What a run on this Mac is doing now, for the page. */
export function liveOf(id: string): Pick<IdeaRun, "said" | "tools" | "step"> | null {
  const run = runs.get(id);
  if (run === undefined) return null;
  return { said: run.turn.text, tools: toolsOf(run.turn), step: run.step };
}

export const isRunning = (id: string): boolean => runs.has(id);

/** Stops this Mac's run on an idea. */
export function stop(id: string): boolean {
  const run = runs.get(id);
  if (run === undefined) return false;
  run.abort.abort();
  return true;
}

const toolsOf = (turn: live.Turn): IdeaTool[] =>
  turn.trace.flatMap((group) => group.calls.map((call) => ({ name: call.tool ?? call.label, state: call.state, ...(call.detail ? { detail: call.detail } : {}) })));

// ---------------------------------------------------------------- the tools

type Session = {
  id: string;
  mode: "repackage" | "chat";
  by: string;
  style: LengthStyle | null;
  /** The approved thumbnails Claude may take as the base, by card link. */
  bases: Map<string, { title: string; image: string }>;
  /** The case's own YouTube thumbnail, put on the card only when the guide takes the subject from it. */
  caseThumbnail: string | null;
  home: string;
  /** The case's YouTube video, looked at for frames: looked up once, on the first look. */
  video: { id: string; found: Promise<frames.Video> | null } | null;
  /** Where this run's pictures are (Claude reads them there). */
  folder: string;
  /** The frames grabbed this run, by the time they show ("4:12"). */
  grabbed: Map<string, { at: number; path: string }>;
  skipped: string | null;
  saved: { titles: boolean; guide: boolean; summary: boolean };
  calls: number;
};

const sessions = new Map<string, Session>();

const TITLES = { type: "array", items: { type: "string" }, minItems: 1, maxItems: 12 };

export const TOOLS = [
  {
    name: "save_titles",
    description:
      'Save titles, strongest first (the first names the card). mode "replace" (a repackaging\'s default) replaces the titles you wrote before; titles the person wrote stay. mode "add" adds to them. Each title is checked: the banned word, a dash, a quoted line, the team\'s length; refused ones are named with why.',
    inputSchema: { type: "object", additionalProperties: false, properties: { titles: TITLES, niche: { type: "string", enum: [...NICHES] }, mode: { type: "string", enum: ["replace", "add"] } }, required: ["titles"] },
  },
  {
    name: "remove_titles",
    description: "Remove titles, by their words.",
    inputSchema: { type: "object", additionalProperties: false, properties: { titles: TITLES }, required: ["titles"] },
  },
  {
    name: "rename_title",
    description: "Reword one saved title in place, by its words: it keeps its place, and stays the main title if it was. The new words are checked as save_titles checks them.",
    inputSchema: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, to: { type: "string" } }, required: ["title", "to"] },
  },
  {
    name: "set_main_title",
    description: "Make one of the saved titles the main one: it names the card.",
    inputSchema: { type: "object", additionalProperties: false, properties: { title: { type: "string" } }, required: ["title"] },
  },
  {
    name: "scan_video",
    description:
      `Look through the case's YouTube video as its storyboard: sheets of small pictures, one every few seconds, nine to a sheet. Without from and to, the whole video (spread over ${frames.MAX_SHEETS} sheets when it's longer than about thirteen minutes); with them ("m:ss"), that stretch. Read the sheets it names, then grab_frames at the moments you want.`,
    inputSchema: { type: "object", additionalProperties: false, properties: { from: { type: "string" }, to: { type: "string" } } },
  },
  {
    name: "grab_frames",
    description: `Full-size frames of the case's YouTube video (up to 1080p) at these times (\"m:ss\", 1–${frames.MAX_FRAMES}): each the sharpest within a second of the time asked. Read the files it names. save_thumbnail_guide's frames name them by the time it gives back.`,
    inputSchema: { type: "object", additionalProperties: false, properties: { times: { type: "array", items: { type: "string" }, minItems: 1, maxItems: frames.MAX_FRAMES } }, required: ["times"] },
  },
  {
    name: "save_thumbnail_guide",
    description:
      "Save the thumbnail guide for the main title: in lowercase, where the editor gets the subject's picture (“take the woman from the original thumbnail.”, “find an image of the woman.”, or “take the father from the second frame.”), then the edits to the base (this case's subject as the evidence supports, at most two scene elements seen in the base, then the caption kept, removed or changed to one to four words, in “quotes”). subject_from: \"case_thumbnail\" when the case's subject is clearly in the case's own YouTube thumbnail (it goes on the card), \"video\" when they come from frames you grabbed, \"find\" when neither has them. frames: the grabbed frames the guide takes (at most 4), each by the time grab_frames gave it (at), as the scene (use \"base\"), a person (\"subject\", with who: \"the father\"), or both in one frame (\"base_and_subject\"); the card shows them in this order, the base first, and the guide names each by its place, never its time (“use the first frame as the base. take the father from the second frame.”). base_card: the link of the approved card whose thumbnail is the base (with a base frame, the one whose idea it follows), from the list in the message.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        guide: { type: "string" },
        subject_from: { type: "string", enum: ["case_thumbnail", "video", "find"] },
        frames: {
          type: "array",
          maxItems: 4,
          items: { type: "object", additionalProperties: false, properties: { at: { type: "string" }, use: { type: "string", enum: ["base", "subject", "base_and_subject"] }, who: { type: "string" } }, required: ["at", "use"] },
        },
        base_card: { type: "string" },
      },
      required: ["guide", "subject_from"],
    },
  },
  {
    name: "save_summary",
    description: "Save the summary: one compact paragraph of 35–55 words, at most three sentences. Only when the message asks for one.",
    inputSchema: { type: "object", additionalProperties: false, properties: { summary: { type: "string" } }, required: ["summary"] },
  },
  {
    name: "skip_case",
    description: "Skip the case when there is no usable transcript or article to write from: say why. Nothing else is saved.",
    inputSchema: { type: "object", additionalProperties: false, properties: { reason: { type: "string" } }, required: ["reason"] },
  },
];

type Args = Record<string, unknown>;

const words = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${what} must be words.`);
  return value;
};

const list = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length === 0) throw new Error("titles must be a list of titles.");
  return value.map((one) => cleanTitle(words(one, "Each title")));
};

const newId = () => Math.random().toString(36).slice(2, 10);

/** One tool call: the answer's text, and whether it's a refusal. */
export async function call(token: string, name: string, args: Args): Promise<[string, boolean]> {
  const session = sessions.get(token);
  if (session === undefined) return ["This run has ended.", true];
  session.calls++;
  try {
    return [await run(session, name, args), false];
  } catch (error) {
    return [diag.messageOf(error), true];
  }
}

async function run(session: Session, name: string, args: Args): Promise<string> {
  switch (name) {
    case "scan_video": {
      const found = await videoOf(session);
      const from = args.from === undefined ? 0 : frames.secondsOf(args.from);
      const to = args.to === undefined ? found.duration : frames.secondsOf(args.to);
      if (from === null || to === null || to <= from) throw new Error("from and to are times in the video (\"m:ss\"), from before to.");
      const sheets = await frames.scan(found, session.folder, from, Math.min(to, found.duration));
      if (sheets.length === 0) throw new Error(`The video is ${frames.clock(found.duration)} long: nothing there.`);
      const spread = sheets.length === frames.MAX_SHEETS && found.sheets.filter((one) => one.start + one.tiles * found.every > from && one.start < to).length > frames.MAX_SHEETS;
      return [
        `The video (${frames.clock(found.duration)}) as ${sheets.length} storyboard ${sheets.length === 1 ? "sheet" : "sheets"}${spread ? ", spread over the stretch: scan a shorter stretch for the sheets between" : ""}. Read each:`,
        ...sheets.map((one) => `- ${frames.sheetText(found, one)}`),
      ].join("\n");
    }
    case "grab_frames": {
      const asked = Array.isArray(args.times) ? args.times.map(frames.secondsOf) : [];
      if (asked.length === 0 || asked.length > frames.MAX_FRAMES || asked.some((one) => one === null)) throw new Error(`times are 1–${frames.MAX_FRAMES} times in the video, as "m:ss".`);
      const found = await videoOf(session);
      const late = (asked as number[]).filter((one) => one > found.duration);
      if (late.length > 0) throw new Error(`The video is ${frames.clock(found.duration)} long: ${late.map(frames.clock).join(", ")} is past its end.`);
      const got = await frames.grab(found, asked as number[], session.folder);
      for (const one of got) session.grabbed.set(frames.clock(one.at), { at: one.at, path: one.path });
      return ["Read each frame:", ...got.map((one) => `- the frame at ${frames.clock(one.at)}${frames.clock(one.at) === frames.clock(one.asked) ? "" : ` (asked ${frames.clock(one.asked)})`}: ${one.path}`)].join("\n");
    }
    case "save_titles":
      return saveTitles(session, list(args.titles), args.niche, args.mode === "add" ? "add" : args.mode === "replace" ? "replace" : session.mode === "repackage" ? "replace" : "add");
    case "remove_titles": {
      const gone = new Set(list(args.titles).map(identity));
      let removed = 0;
      await cloud.change(session.id, session.by, (idea) => {
        const kept = idea.titles.filter((one) => !gone.has(identity(one.text)));
        removed = idea.titles.length - kept.length;
        if (removed === 0) return false;
        idea.titles = kept;
        if (idea.main !== null && !kept.some((one) => one.text === idea.main)) idea.main = kept[0]?.text ?? null;
      });
      if (removed === 0) throw new Error("None of those titles is saved: name them by their words.");
      return `Removed ${removed} ${removed === 1 ? "title" : "titles"}.`;
    }
    case "rename_title": {
      const wanted = identity(words(args.title, "title"));
      const to = cleanTitle(words(args.to, "The new title"));
      const problem = titleProblem(to, session.style);
      if (problem !== null) throw new Error(`“${to}” ${problem}.`);
      let from: string | null = null;
      let clash = false;
      await cloud.change(session.id, session.by, (idea) => {
        const found = idea.titles.find((one) => identity(one.text) === wanted);
        from = found?.text ?? null;
        clash = idea.titles.some((one) => one !== found && identity(one.text) === identity(to));
        if (found === undefined || clash || found.text === to) return false;
        if (idea.main === found.text) idea.main = to;
        found.text = to;
        found.at = Date.now();
      });
      if (from === null) throw new Error("That title isn't saved: name a saved one by its words.");
      if (clash) throw new Error(`“${to}” is already saved: remove one instead.`);
      return `Renamed “${from}” to “${to}”.`;
    }
    case "set_main_title": {
      const wanted = identity(words(args.title, "title"));
      let found: string | null = null;
      await cloud.change(session.id, session.by, (idea) => {
        found = idea.titles.find((one) => identity(one.text) === wanted)?.text ?? null;
        if (found === null || idea.main === found) return false;
        idea.main = found;
      });
      if (found === null) throw new Error("That title isn't saved: save it first, or name a saved one.");
      return `The main title is now: ${found}`;
    }
    case "save_thumbnail_guide": {
      const guide = cleanGuide(words(args.guide, "guide"));
      const taken = framesOf(session, args.frames);
      const problem = guideProblem(guide, taken.length);
      if (problem !== null) throw new Error(`The guide ${problem}. Save it again.`);
      // Where the subject's picture comes from, said on purpose (the user, Nov 1: the original video's thumbnail was
      // "just automatically passed through"; "let's try to find an image of the woman", or "we take the woman from
      // the original thumbnail here"; Nov 2: or from frames of the video).
      const from = args.subject_from;
      if (from !== "case_thumbnail" && from !== "find" && from !== "video") throw new Error('subject_from is "case_thumbnail" (the subject is in the case\'s own thumbnail), "video" (they come from frames you grabbed) or "find" (neither has them).');
      if (from === "case_thumbnail" && session.caseThumbnail === null) throw new Error('This case has no YouTube thumbnail to take the subject from: use subject_from "video" or "find".');
      if (from === "video" && !taken.some((one) => one.frame.use !== "base")) throw new Error('subject_from "video" takes the subject from a frame: give it in frames with use "subject" (and who) or "base_and_subject".');
      const said = sourceProblem(guide, from) ?? framesProblem(guide, taken.length);
      if (said !== null) throw new Error(`The guide ${said}. Save it again.`);
      // The frames on the card: put in the idea's folder on R2 before the guide is saved.
      const framed: IdeaImage[] = [];
      for (const one of taken) {
        const key = await cloud.putPicture(session.id, new Uint8Array(fs.readFileSync(one.path)), "image/jpeg", "jpg");
        const label = one.frame.use === "base" ? "base" : one.frame.use === "base_and_subject" ? `base, ${one.frame.who ?? "the subject"}` : (one.frame.who ?? "the subject");
        framed.push({ id: newId(), name: `${one.label} frame · ${label} · ${frames.clock(one.frame.at)}`, key, from: "frame", frame: one.frame });
      }
      const baseFrame = framed.find((one) => one.frame?.use !== "subject") ?? null;
      const baseLink = typeof args.base_card === "string" && args.base_card.trim() !== "" ? args.base_card.trim() : null;
      const base = baseLink === null ? undefined : session.bases.get(baseLink);
      if (baseLink !== null && base === undefined) throw new Error("That base isn't one of the approved thumbnails in the message: name one of their links, or leave base_card out.");
      let kept = false;
      await cloud.change(session.id, session.by, (idea) => {
        // A guide someone wrote by hand outranks Claude's on a fresh run (Sphe Research's rule).
        if (session.mode === "repackage" && idea.guideBy !== "claude" && idea.thumbnailGuide.trim() !== "") {
          kept = true;
          return false;
        }
        idea.thumbnailGuide = guide;
        idea.guideBy = "claude";
        if (base !== undefined && baseLink !== null) idea.base = { title: base.title, cardUrl: baseLink, image: base.image };
        // The base first (the card's cover: a base frame, else the approved thumbnail), the subjects' frames, the approved
        // thumbnail it follows when a frame is the base, the case's thumbnail only when the subject comes from it, then the
        // person's pictures. A new guide's frames replace the last one's.
        const baseImage = idea.images.find((one) => one.from === "base") ?? null;
        const approvedImage = base !== undefined ? { id: newId(), name: baseFrame !== null ? "reference" : "base", url: base.image, from: "base" as const } : baseImage;
        const pictures = idea.images.filter((one) => one.from !== "base" && one.from !== "video" && one.from !== "frame");
        idea.images = [
          ...(baseFrame === null && approvedImage !== null ? [approvedImage] : []),
          ...framed,
          ...(baseFrame !== null && approvedImage !== null ? [approvedImage] : []),
          ...(from === "case_thumbnail" && session.caseThumbnail !== null ? [{ id: newId(), name: "original thumbnail", url: session.caseThumbnail, from: "video" as const }] : []),
          ...pictures,
        ].slice(0, 8);
      });
      session.saved.guide = true;
      return kept
        ? "The person wrote this idea's guide by hand, so theirs stays. Carry on."
        : `Thumbnail guide saved${baseFrame !== null ? `, on the first frame` : ""}${base !== undefined ? `${baseFrame !== null ? ", following" : ", on the base from"} “${base.title}”` : ""}${framed.length > 0 ? `, with ${framed.length} ${framed.length === 1 ? "frame" : "frames"} on the card` : ""}.`;
    }
    case "save_summary": {
      const summary = words(args.summary, "summary").trim().replace(/\s+/g, " ");
      const problem = summaryProblem(summary);
      if (problem !== null) throw new Error(`The summary ${problem}. Save it again.`);
      await cloud.change(session.id, session.by, (idea) => {
        idea.summary = summary;
      });
      session.saved.summary = true;
      return "Summary saved.";
    }
    case "skip_case": {
      const reason = words(args.reason, "reason").trim().slice(0, 400);
      session.skipped = reason;
      await cloud.change(session.id, session.by, (idea) => {
        idea.skipped = reason;
      });
      return "Skipped. End your turn now.";
    }
    default:
      throw new Error(`There's no tool called ${name}.`);
  }
}

/** The case's video, looked up on the first look of a run. */
function videoOf(session: Session): Promise<frames.Video> {
  if (session.video === null) return Promise.reject(new Error("This case has no YouTube video to look at."));
  if (session.video.found === null) {
    const looking = frames.video(session.home, session.video.id);
    // A failed look is tried again on the next call.
    looking.catch(() => {
      if (session.video !== null && session.video.found === looking) session.video.found = null;
    });
    session.video.found = looking;
  }
  return session.video.found;
}

/** The frames save_thumbnail_guide was given, each one grabbed this run. */
function framesOf(session: Session, given: unknown): { frame: IdeaFrame; path: string; label: string }[] {
  if (given === undefined) return [];
  if (!Array.isArray(given)) throw new Error("frames is a list of the frames the guide takes.");
  if (given.length > 4) throw new Error("At most 4 frames: the base and the people the guide takes.");
  const out: { frame: IdeaFrame; path: string; label: string }[] = [];
  for (const one of given as Args[]) {
    const at = frames.secondsOf(one.at);
    if (at === null) throw new Error('Each frame\'s at is its time as grab_frames gave it ("4:12").');
    // Its time as given back, else the grabbed frame within a second of it.
    const shown = session.grabbed.get(frames.clock(at)) ?? [...session.grabbed.values()].find((grabbed) => Math.abs(grabbed.at - at) <= 1);
    if (shown === undefined) throw new Error(`No frame at ${frames.clock(at)} was grabbed in this run: grab_frames first, and name it by the time it gives back.`);
    const use = one.use;
    if (use !== "base" && use !== "subject" && use !== "base_and_subject") throw new Error('Each frame\'s use is "base", "subject" or "base_and_subject".');
    const who = typeof one.who === "string" && one.who.trim() !== "" ? one.who.trim().toLowerCase().slice(0, 40) : undefined;
    if (use !== "base" && who === undefined) throw new Error(`The frame at ${frames.clock(at)} is a person: say who (who: "the father").`);
    // Named as the card shows it, in this order: "the first frame".
    out.push({ frame: { at: shown.at, use, ...(who !== undefined ? { who } : {}) }, path: shown.path, label: ORDINALS[out.length]! });
  }
  if (out.filter((one) => one.frame.use !== "subject").length > 1) throw new Error("One base frame at most: the scene the thumbnail is built on.");
  if (out.length > 1 && out.slice(1).some((one) => one.frame.use !== "subject")) throw new Error("The base frame goes first in frames: the card shows the frames in this order, the base first.");
  return out;
}

async function saveTitles(session: Session, given: string[], niche: unknown, mode: "replace" | "add"): Promise<string> {
  const refused: string[] = [];
  const good: string[] = [];
  let total = 0;
  await cloud.change(session.id, session.by, (idea) => {
    refused.length = 0;
    good.length = 0;
    const keep = mode === "replace" ? idea.titles.filter((one) => one.by !== "claude") : idea.titles;
    const seen = new Set(keep.map((one) => identity(one.text)));
    for (const title of given) {
      const problem = titleProblem(title, session.style) ?? (seen.has(identity(title)) ? "is already saved" : null);
      if (problem !== null) {
        refused.push(`“${title}” ${problem}`);
        continue;
      }
      seen.add(identity(title));
      good.push(title);
    }
    if (good.length === 0) return false;
    const added = good.map((text) => ({ id: newId(), text, by: "claude", at: Date.now() }));
    idea.titles = mode === "replace" ? [...added, ...keep] : [...keep, ...added];
    if (typeof niche === "string" && (NICHES as readonly string[]).includes(niche)) idea.niche = niche as Niche;
    // The strongest of a fresh set names the card, unless the person chose one that's still there.
    if (idea.main === null || !idea.titles.some((one) => one.text === idea.main) || (mode === "replace" && idea.titles.find((one) => one.text === idea.main)?.by === "claude")) idea.main = idea.titles[0]?.text ?? null;
    idea.skipped = null;
    total = idea.titles.length;
  });
  if (good.length > 0) session.saved.titles = true;
  const parts = [good.length > 0 ? `Saved ${good.length} ${good.length === 1 ? "title" : "titles"}; the idea has ${total}.` : "Nothing saved."];
  if (refused.length > 0) parts.push(`Refused: ${refused.join("; ")}. Fix them and save them again with mode "add".`);
  if (session.mode === "repackage" && good.length > 0 && (total < 3 || total > 5)) parts.push(`A repackaging has 3 to 5 titles: ${total < 3 ? "add" : "remove"} some.`);
  return parts.join(" ");
}

// ---------------------------------------------------------------- the prompt

const views = (count: number | null) => (count === null ? "unknown views" : count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M views` : count >= 1000 ? `${Math.round(count / 1000)}K views` : `${count} views`);

const clock = (seconds: number | null) => {
  if (seconds === null) return "unknown";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
};

type Prepared = { caseText: string; examples: string[]; style: LengthStyle | null; folder: string; bases: Map<string, { title: string; image: string }>; caseThumbnail: string | null; pictures: string };

/** What Claude reads of the case: its source, the transcript or article, the team's approved titles, the thumbnails. */
async function prepare(context: Context, idea: Idea, step: (text: string) => Promise<void>, signal: AbortSignal): Promise<Prepared | string> {
  const parts: string[] = [];
  let title = "";
  let description = "";
  for (const source of idea.sources) {
    if (source.kind === "youtube") {
      const video = await sources.video(source.videoId).catch((error: unknown) => {
        throw new Error(`YouTube's details: ${diag.messageOf(error)}`);
      });
      title ||= video.title;
      description ||= video.description;
      parts.push(
        `## YouTube video ${video.url}`,
        `Title: ${video.title}`,
        `Channel: ${video.channel} · ${views(video.views)} · outlier ${video.outlier} · published ${video.publishedAt?.slice(0, 10) ?? "unknown"} · ${clock(video.durationSeconds)}`,
        `Description: ${video.description.trim() || "(none)"}`,
      );
      await step("Reading the captions");
      const words = await sources.transcript(context.home, source.videoId, signal);
      if (words === null) return "YouTube has no English captions for this video, so it wasn't repackaged: titles come from the transcript, never from the title alone.";
      parts.push("", `### Transcript${words.truncated ? " (the first part)" : ""}`, words.text, "");
    } else {
      await step("Reading the article");
      const read = await sources.article(source.url);
      title ||= read.source.title;
      parts.push(`## Article ${source.url}`, `Title: ${read.source.title}`, `Outlet: ${read.source.outlet}`, "", "### Its text", read.text, "");
    }
  }
  await step("Reading the approved titles");
  const approved = await board.approved(idea.workspace).catch((error: unknown) => {
    diag.warn("ideas", `the approved titles: ${diag.messageOf(error)}`);
    return [];
  });
  const titles = approved.map((one) => one.title);
  const near = closest(titles, title, description, 12);
  const recent = titles.filter((one) => !near.includes(one)).slice(0, 40);
  const style = lengthStyle(titles);
  // The pictures Claude may look at: the case's thumbnail, and the closest approved titles' covers.
  const folder = join(context.home, "cache", "ideas", `run-${idea.id}-${Date.now()}`);
  fs.mkdirSync(folder, { recursive: true });
  const pictures: string[] = [];
  const youtube = idea.sources.find((one) => one.kind === "youtube");
  const thumbnail = youtube?.kind === "youtube" ? youtube.thumbnail : null;
  const caseThumbnail = thumbnail !== null && (await sources.picture(thumbnail, join(folder, "case-thumbnail.jpg"))) ? thumbnail : null;
  if (caseThumbnail !== null) pictures.push(`The case's own YouTube thumbnail (on the card only with subject_from "case_thumbnail"): ${join(folder, "case-thumbnail.jpg")}`);
  const bases = new Map<string, { title: string; image: string }>();
  const covered = approved.filter((one) => one.cover !== null && near.includes(one.title)).slice(0, 4);
  for (const [index, one] of covered.entries()) {
    const path = join(folder, `base-${index + 1}.jpg`);
    if (!(await sources.picture(one.cover!, path))) continue;
    bases.set(one.url, { title: one.title, image: one.cover! });
    pictures.push(`Approved: “${one.title}” (${one.url}): ${path}`);
  }
  const lengths = style === null ? "" : `Their usual length is ${style.typicalWords[0]}–${style.typicalWords[1]} words; at most ${style.maxWords} words and ${style.maxCharacters} characters.`;
  const approvedText = [
    `# The team's approved titles (${titles.length} on the board)`,
    near.length > 0 ? "Closest to this case:" : "",
    ...near.map((one) => `- ${one}`),
    recent.length > 0 ? "Most recent:" : "",
    ...recent.map((one) => `- ${one}`),
    lengths,
  ].filter((line) => line !== "");
  const pictureText = [
    pictures.length > 0 ? ["# Thumbnails (Read them)", ...pictures.map((one) => `- ${one}`)].join("\n") : "",
    youtube !== undefined ? "# The case's video\nIts frames can go in the thumbnail: scan_video shows it as storyboard sheets, grab_frames gives full-size frames at the times you choose (the thumbnail guide's “From the case's video”)." : "",
  ]
    .filter((part) => part !== "")
    .join("\n\n");
  return { caseText: ["# The case", ...parts].join("\n"), examples: approvedText, style, folder, bases, caseThumbnail, pictures: pictureText };
}

/** The idea as it stands, for a chat turn or changes: its titles (who wrote each), the main one, the guide, the summary. */
function ideaText(idea: Idea): string {
  return [
    "# The idea now",
    idea.niche === null ? "" : `Niche: ${idea.niche}`,
    "Titles:",
    ...idea.titles.map((one) => `- ${one.text}${one.text === idea.main ? " (main)" : ""}${one.by === "claude" ? "" : ` (written by ${one.by})`}`),
    `Thumbnail Guide: ${idea.thumbnailGuide || "(none)"}${idea.guideBy !== "claude" && idea.thumbnailGuide !== "" ? ` (written by ${idea.guideBy})` : ""}`,
    idea.base === null ? "" : `${idea.images.some((one) => one.from === "frame" && one.frame?.use !== "subject") ? "Reference" : "Base"} thumbnail: “${idea.base.title}” (${idea.base.cardUrl})`,
    ...idea.images.flatMap((one) => (one.from === "frame" ? [`On the card: ${one.name}`] : [])),
    idea.summary === "" ? "" : `Summary: ${idea.summary}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** The workspace's craft (agent/ideas/<workspace>.md): Repack's Interrogation teachings, or bodycam's adaptation of them. */
const system = (workspace: Workspace) => ideasGuide(workspace);

// ---------------------------------------------------------------- runs

/** How a run ended, said in one line for the page. */
type Ending = { state: IdeaRun["state"]; error?: string; text: string };

/**
 * Repackages an idea: its sources read, the board asked whether it already
 * has the video (unless the person asked to improve the card, or it's the
 * reviewers' changes), then Claude writes. Answers once it's queued.
 */
export async function repackage(context: Context, id: string, options: { improve?: boolean; changes?: boolean } = {}): Promise<void> {
  if (runs.has(id)) throw new Error("Claude is already working on this idea.");
  await begin(context, id, "repackage", (idea) => {
    const asked = options.changes ? "Make the changes the reviewers asked for." : options.improve ? "Improve this case's titles: it's already on the board." : "Repackage this case.";
    idea.chat = [...idea.chat, { role: "you" as const, text: idea.steer && !options.changes ? `${asked} Angle: ${idea.steer}` : asked, at: Date.now(), by: context.by }].slice(-KEPT_TURNS);
  });
  void work(context, id, "repackage", options, null);
}

/** A turn of the conversation about an idea. */
export async function chat(context: Context, id: string, text: string): Promise<void> {
  const asked = text.trim();
  if (asked === "") throw new Error("Write what you'd like changed.");
  if ([...asked].length > 4000) throw new Error("Keep the message under 4,000 characters.");
  if (runs.has(id)) throw new Error("Claude is already working on this idea: wait for it, or stop it.");
  await begin(context, id, "chat", (idea) => {
    idea.chat = [...idea.chat, { role: "you" as const, text: asked, at: Date.now(), by: context.by }].slice(-KEPT_TURNS);
  });
  void work(context, id, "chat", {}, asked);
}

/** Marks the run queued in the cloud (refused while another Mac runs one). */
async function begin(context: Context, id: string, what: IdeaRun["what"], also: (idea: Idea) => void): Promise<void> {
  await cloud.change(id, context.by, (idea) => {
    const other = idea.run;
    if (other !== null && (other.state === "running" || other.state === "queued") && other.holder !== context.holder && Date.now() - other.startedAt < 20 * 60_000) {
      throw new Error(`Claude is working on this idea on ${other.holder}: wait for it there.`);
    }
    idea.run = { what, state: "queued", holder: context.holder, by: context.by, startedAt: Date.now(), step: "Waiting for a turn" };
    also(idea);
  });
  runs.set(id, { turn: { text: "", trace: [], startedAt: Date.now() }, abort: new AbortController(), step: "Waiting for a turn" });
}

async function work(context: Context, id: string, what: IdeaRun["what"], options: { improve?: boolean; changes?: boolean }, asked: string | null): Promise<void> {
  const running = runs.get(id)!;
  const signal = running.abort.signal;
  let ending: Ending;
  let folder: string | null = null;
  try {
    ending = await slot(async () => {
      if (signal.aborted) return { state: "stopped" as const, text: "Stopped." };
      const step = async (text: string) => {
        running.step = text;
        await cloud.change(id, context.by, (idea) => {
          if (idea.run === null || idea.run.holder !== context.holder) return false;
          idea.run = { ...idea.run, state: "running", step: text };
        });
      };
      await step(what === "chat" ? "Reading the idea" : "Reading the case");
      const found = await cloud.get(id);
      if (found === null) throw new cloud.Missing("This idea was deleted.");
      const idea = found.idea;
      if (idea.sources.length === 0) return { state: "failed" as const, error: "This idea has no video or article to repackage.", text: "This idea has no video or article to repackage." };
      // The board first: a video already there is a decision for the person, not a run (Sphe Research's duplicate question).
      if (what === "repackage" && !options.improve && !options.changes && idea.card === null) {
        await step("Checking the board");
        const ids = idea.sources.flatMap((one) => (one.kind === "youtube" ? [one.videoId] : []));
        const found = await board.duplicates(ids, idea.workspace);
        const hit = ids.map((one) => found[one]).find((one) => one !== undefined);
        if (hit !== undefined) {
          await cloud.change(id, context.by, (fresh) => {
            fresh.duplicate = { cardId: hit.cardId, name: hit.name, url: hit.url, list: hit.list };
          });
          return { state: "done" as const, text: `It's already on the board as “${hit.name}” (${hit.list || "archived"}). Improve it, or leave it.` };
        }
      }
      const prepared = await prepare(context, idea, step, signal);
      if (typeof prepared === "string") {
        await cloud.change(id, context.by, (fresh) => {
          fresh.skipped = prepared;
        });
        return { state: "done" as const, text: prepared };
      }
      folder = prepared.folder;
      await step(what === "chat" ? "Claude is working" : "Writing titles");
      const youtube = idea.sources.find((one) => one.kind === "youtube");
      const session: Session = {
        id,
        mode: what,
        by: context.by,
        style: prepared.style,
        bases: prepared.bases,
        caseThumbnail: prepared.caseThumbnail,
        home: context.home,
        video: youtube?.kind === "youtube" ? { id: youtube.videoId, found: null } : null,
        folder: prepared.folder,
        grabbed: new Map(),
        skipped: null,
        saved: { titles: false, guide: false, summary: false },
        calls: 0,
      };
      const token = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
      sessions.set(token, session);
      const recent = idea.chat.slice(-SENT_TURNS - 1, -1).map((turn) => `${turn.role === "you" ? `${turn.by ?? "Producer"}` : "You (Claude)"}: ${turn.text}`);
      const ask = [
        prepared.caseText,
        prepared.examples.join("\n"),
        prepared.pictures,
        what === "chat" || idea.titles.length > 0 ? ideaText(idea) : "",
        idea.duplicate !== null && options.improve ? `# Already on the board\nThe card is “${idea.duplicate.name}” (${idea.duplicate.list}). The person wants this case improved: that title is the bad version.` : "",
        options.changes && idea.changes !== null ? `# The reviewers' comments on its card\n${idea.changes.comments.map((one) => `- ${one.author}: ${one.text}`).join("\n")}` : "",
        recent.length > 0 ? `# The conversation so far\n${recent.join("\n\n")}` : "",
        what === "chat"
          ? `# The person asks\n${asked}`
          : `# The task\n${options.changes ? "Make the changes the reviewers asked for." : "Repackage this case."} Steer: ${idea.steer.trim() || "none"}. Summary: ${idea.wantsSummary ? "asked for" : "not asked for"}.`,
      ]
        .filter((part) => part !== "")
        .join("\n\n");
      try {
        const answer = await live.within(running.turn, () =>
          asking.ask({ model: claude.OPUS, system: system(idea.workspace), prompt: ask, tools: `http://127.0.0.1:${context.port}/mcp/ideas/${token}`, read: prepared.folder, maxTurns: 40, effort: "medium", timeoutMs: 20 * 60_000, label: `Ideas ${id}`, signal }),
        );
        const said = (answer.text ?? running.turn.text).trim();
        if (session.skipped !== null) return { state: "done" as const, text: session.skipped };
        if (what === "chat") return { state: "done" as const, text: said || "Done." };
        const now = await cloud.get(id);
        const count = now?.idea.titles.length ?? 0;
        const guide = (now?.idea.thumbnailGuide ?? "").trim() !== "";
        if (count >= 3 && guide) return { state: "done" as const, text: said || `${count} titles and the thumbnail guide are written.` };
        const missing = [count < 3 ? "3–5 titles" : "", guide ? "" : "the thumbnail guide"].filter(Boolean).join(" and ");
        return { state: "failed" as const, error: `Claude stopped before saving ${missing}.`, text: said || `Claude stopped before saving ${missing}.` };
      } finally {
        sessions.delete(token);
      }
    });
  } catch (error) {
    const message = signal.aborted ? "Stopped." : diag.messageOf(error);
    if (!signal.aborted) diag.warn("ideas", `${id}: ${what} failed: ${message}`);
    ending = { state: signal.aborted ? "stopped" : "failed", error: message, text: message };
  }
  const tools = toolsOf(running.turn);
  const workedMs = Date.now() - running.turn.startedAt;
  if (folder !== null) fs.rmSync(folder, { recursive: true, force: true });
  // Still running until its ending is saved: dropped first, a look in between saw it not running with its run still "running".
  try {
    await cloud.change(id, context.by, (idea) => {
      if (idea.run !== null && idea.run.holder !== context.holder) return false;
      idea.run = { what, state: ending.state, holder: context.holder, by: context.by, startedAt: idea.run?.startedAt ?? Date.now(), endedAt: Date.now(), ...(ending.error ? { error: ending.error } : {}), ...(tools.length > 0 ? { tools } : {}) };
      const turn: IdeaTurn = { role: "claude", text: ending.text, at: Date.now(), workedMs, ...(tools.length > 0 ? { tools } : {}), ...(ending.state === "failed" || ending.state === "stopped" ? { failed: true } : {}) };
      idea.chat = [...idea.chat, turn].slice(-KEPT_TURNS);
    });
  } catch (error) {
    diag.warn("ideas", `${id}: saving how the run ended: ${diag.messageOf(error)}`);
  } finally {
    runs.delete(id);
  }
}

/** Runs this Mac had going when Edit stopped: stopped, to be started again by hand. */
export async function markInterrupted(holder: string): Promise<void> {
  const rows = await cloud.list();
  for (const row of rows) {
    if (row.summary.run !== "running" && row.summary.run !== "queued") continue;
    await cloud
      .change(row.id, holder, (idea) => {
        if (idea.run === null || idea.run.holder !== holder || (idea.run.state !== "running" && idea.run.state !== "queued") || runs.has(idea.id)) return false;
        idea.run = { ...idea.run, state: "stopped", endedAt: Date.now(), error: "Edit restarted before Claude finished. Ask again." };
      })
      .catch((error: unknown) => diag.warn("ideas", `${row.id}: marking its run stopped: ${diag.messageOf(error)}`));
  }
}

/** The MCP answer to one JSON-RPC message (Script mode's endpoint, build.ts, on Ideas' tools). */
export async function answerTo(token: string, message: unknown): Promise<unknown> {
  if (typeof message !== "object" || message === null) return null;
  const { id, method, params } = message as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const failure = (code: number, text: string) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
  switch (method) {
    case "initialize":
      return reply({ protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ideas", version: "1" } });
    case "ping":
      return reply({});
    case "tools/list":
      return sessions.has(token) ? reply({ tools: TOOLS }) : failure(-32001, "This run has ended.");
    case "tools/call": {
      if (!sessions.has(token)) return id === undefined ? null : failure(-32001, "This run has ended.");
      const name = typeof params?.name === "string" ? params.name : "";
      const args = (typeof params?.arguments === "object" && params.arguments !== null ? params.arguments : {}) as Args;
      const [text, refused] = await call(token, name, args);
      return reply({ content: [{ type: "text", text }], isError: refused });
    }
    default:
      return id === undefined ? null : failure(-32601, `Ideas has no method ${String(method)}.`);
  }
}

/** A fresh idea for these sources. */
export function fresh(id: string, by: string, given: Pick<Idea, "sources" | "steer" | "wantsSummary"> & Partial<Pick<Idea, "images" | "footage" | "workspace">>): Idea {
  // No picture by itself: the case's thumbnail goes on only when the guide takes the subject from it (save_thumbnail_guide).
  const images: IdeaImage[] = given.images ?? [];
  return {
    id,
    workspace: given.workspace ?? "interrogation",
    sources: given.sources,
    steer: given.steer,
    wantsSummary: given.wantsSummary,
    niche: null,
    titles: [],
    main: null,
    thumbnailGuide: "",
    guideBy: "claude",
    base: null,
    images,
    summary: "",
    footage: given.footage ?? "",
    notes: "",
    status: "draft",
    skipped: null,
    duplicate: null,
    card: null,
    changes: null,
    run: null,
    chat: [],
    createdAt: Date.now(),
    createdBy: by,
    updatedAt: Date.now(),
  };
}

