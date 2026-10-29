// Sharing a script for review on a Repack link (feedback.spheceo.com), and
// the notes reviewers leave there. Every call to Repack's `reviews:*`
// functions is here; the relay adds `app: "writer"` to each, so a script's
// review is the same one it was in Writer.
//
// Share snapshots script.json to R2 and publishes its blocks (blocks.ts);
// sharing again publishes the next version under the same link. While Edit
// runs it asks for changed notes every 45 seconds and keeps them in
// `reviews/notes.json` beside `scripts/` (each Mac its own copy).
//
// Notes are fixed when a reviewer clicks "Ready for changes", by the one
// computer an admin chose on accounts.spheceo.com's Fixing page: Edit checks
// in (`reviews:checkIn`) every 45 seconds, every 15 on the fixing computer;
// there it takes each waiting request (`reviews:takeFix`), fixes the notes
// (fixing.ts) and shares the next version. Fixing by hand works anywhere.

import * as fs from "node:fs";

import type { Script } from "@edit/types/writer";

import type { App } from "../app.ts";
import { creator, email } from "../accounts.ts";
import * as diag from "../diag.ts";
import { writeAtomic } from "../files.ts";
import * as machine from "../machine.ts";
import { isFile, join } from "../paths.ts";
import * as relay from "../relay.ts";
import { blocksOf, outline, targetMs, type Block, type Range } from "./blocks.ts";
import * as can from "./can.ts";
import * as cloud from "./cloud.ts";
import * as commentary from "./commentary.ts";
import * as fixing from "./fixing.ts";
import * as footage from "./footage.ts";
import { importing } from "./imports.ts";
import * as jobs from "./jobs.ts";
import { ensureIds } from "./paragraphs.ts";
import { audit } from "./plan.ts";
import * as store from "./store.ts";

const POLL_MS = 45_000;
/** How often the fixing computer checks for "Ready for changes"; others check in at POLL_MS. */
const CHECK_IN_CHOSEN_MS = 15_000;
/** The most a version's page data may be (Repack's cap is 512 KB). */
const META_BYTES = 480_000;
/** The text each block was last shared with, beside the script. */
const SHARED_TEXT = "review-text.json";

/** A reviewer's note, or a reply to one, as Script mode keeps it. */
export interface Note {
  id: string;
  reviewId: string;
  scriptId?: string | null;
  version: number;
  parentId?: string | null;
  /** `{kind: "text", blockId, start, end, quote}`, as the page sends it. */
  anchor: unknown;
  text: string;
  author: string;
  /** `open` or `done`. */
  status: string;
  doneInVersion?: number | null;
  changedRanges: Range[];
  fixSummary?: string | null;
  /** Someone (a Mac's run) has taken it to fix. */
  attempted: boolean;
  /** Written by an app, not a reviewer. */
  fromApp: boolean;
  deleted?: boolean;
  /** What the reviewer means it to change: wording, fact, cut, pacing, question, fyi, editor, suggestion. */
  intent?: string;
  scope?: string;
  suggestion?: string;
  /** A suggestion's replacement words ("" deletes them). */
  replacement?: string;
  context?: unknown;
  group?: string;
  outcome?: string;
  /** On a footage clip: `cut`, `extend` or `restore`. */
  action?: string;
  confirmed: boolean;
  confirmedBy?: string;
  notFixedAt?: number;
  notFixedVersion?: number;
  attemptAt?: number;
  createdAt: number;
  updatedAt: number;
}

export const isRoot = (note: Note): boolean => note.parentId == null;
export const isSuggestion = (note: Note): boolean => note.intent === "suggestion" || note.replacement !== undefined;
export const isOpen = (note: Note): boolean => note.status !== "done";
/** Open and nobody's to fix: never taken, or sent back as not fixed since it was. */
export const untaken = (note: Note): boolean => isOpen(note) && (!note.attempted || (note.notFixedAt !== undefined && (note.attemptAt === undefined || note.notFixedAt > note.attemptAt)));

/** A note as Repack sends it. */
export function noteOf(value: Record<string, unknown>): Note | null {
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : undefined);
  const number = (key: string) => (typeof value[key] === "number" ? Math.trunc(value[key] as number) : undefined);
  const id = text("_id") ?? text("id") ?? text("noteId");
  const reviewId = text("reviewId");
  if (id === undefined || reviewId === undefined) return null;
  const object = (key: string) => (typeof value[key] === "object" && value[key] !== null && !Array.isArray(value[key]) ? (value[key] as Record<string, unknown>) : null);
  const notFixed = object("notFixed");
  const attempt = object("attempt");
  const confirmed = object("confirmed");
  const note: Note = {
    id,
    reviewId,
    scriptId: text("sourceId") ?? null,
    version: Math.max(number("version") ?? 1, 1),
    parentId: text("parentId") ?? null,
    anchor: value.anchor ?? null,
    text: text("text") ?? "",
    author: text("author") ?? "Reviewer",
    status: text("status") ?? "open",
    doneInVersion: number("doneInVersion") ?? null,
    changedRanges: Array.isArray(value.changedRanges) ? (value.changedRanges as Range[]) : [],
    fixSummary: text("fixSummary") ?? null,
    attempted: attempt !== null,
    fromApp: value.fromApp === true,
    deleted: value.deleted === true,
    confirmed: confirmed !== null,
    createdAt: number("createdAt") ?? 0,
    updatedAt: number("updatedAt") ?? number("createdAt") ?? 0,
  };
  const intent = text("intent");
  if (intent !== undefined && intent.trim() !== "") note.intent = intent;
  for (const key of ["scope", "suggestion", "replacement", "outcome"] as const) if (text(key) !== undefined) note[key] = text(key);
  const group = text("group");
  if (group) note.group = group;
  const action = text("action");
  if (action !== undefined && action.trim() !== "") note.action = action;
  if (object("context") !== null) note.context = value.context;
  if (typeof confirmed?.by === "string") note.confirmedBy = confirmed.by;
  if (typeof notFixed?.at === "number") note.notFixedAt = Math.trunc(notFixed.at);
  if (typeof notFixed?.version === "number") note.notFixedVersion = Math.trunc(notFixed.version);
  if (typeof attempt?.at === "number") note.attemptAt = Math.trunc(attempt.at);
  return note;
}

/** A review's approved version: the link takes no more notes, and Repack deletes the other versions' files (their notes stay). */
export interface Approval {
  version: number;
  by: string;
  at: number;
}

export function approvalOf(value: unknown): Approval | null {
  if (typeof value !== "object" || value === null || typeof (value as { version?: unknown }).version !== "number") return null;
  const given = value as { version: number; by?: unknown; at?: unknown };
  return { version: Math.trunc(given.version), by: typeof given.by === "string" ? given.by : "", at: typeof given.at === "number" ? Math.trunc(given.at) : 0 };
}

// ---- The contract: Repack's reviews:* functions ----

async function call(kind: "query" | "mutation", path: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const answer = await cloud.convex(kind, path, args);
  if (!answer.ok) throw new Error(`The cloud refused ${path}: ${String(answer.data.message ?? answer.code)}`);
  return (answer.value ?? {}) as Record<string, unknown>;
}

/** Who shares, claims and replies, as Repack shows it. */
const by = (): string => `Edit on ${machine.name()}`;

/** Every note and reply written or changed after `cursor` (Repack numbers each write), and the cursor to ask from next. */
async function changes(cursor: number): Promise<[Note[], number]> {
  const notes: Note[] = [];
  let at = cursor;
  // A page at a time, while Repack says there's more.
  for (let page = 0; page < 50; page++) {
    const value = await call("query", "reviews:changes", { cursor: at });
    notes.push(...(Array.isArray(value.notes) ? (value.notes as Record<string, unknown>[]) : []).flatMap((note) => noteOf(note) ?? []));
    if (typeof value.cursor === "number") at = Math.trunc(value.cursor);
    if (value.more !== true) break;
  }
  return [notes, at];
}

/** Takes notes to fix: the ids this Mac got (not replies, done, or under another run's claim). Once a computer is chosen to fix, Repack gives notes only to it, unless they're fixed by hand (`manual`). */
export async function claim(noteIds: string[], manual: boolean): Promise<string[]> {
  const value = await call("mutation", "reviews:claim", { noteIds: noteIds.slice(0, 100), by: by(), machine: machine.id(), manual });
  return (Array.isArray(value.claimed) ? value.claimed : []).filter((id): id is string => typeof id === "string");
}

/** Lets go of notes a run couldn't get to, so a later run may take them. */
export const release = async (noteIds: string[]): Promise<void> => void (await call("mutation", "reviews:release", { noteIds, by: by() }));

/** Approves the script's latest shared version: the link takes no more notes; every note stays. */
export async function approve(data: string, scriptId: string): Promise<Approval> {
  const script = store.read(store.scriptDir(data, scriptId));
  if (!script.review) throw new Error("Share the script before approving it.");
  const value = await call("mutation", "reviews:approve", { sourceId: scriptId, version: script.review.version, by: by() });
  const approval = approvalOf(value.approved);
  if (approval === null) throw new Error("Repack approved it but didn't say which version.");
  diag.info("writer", `${jobs.named(scriptId, script.title)}: v${approval.version} approved`);
  change(data, (known) => void (known.approved[scriptId] = approval));
  return approval;
}

/** Takes an approval back: the link takes notes again (deleted files stay deleted). */
export async function unapprove(data: string, scriptId: string): Promise<void> {
  await call("mutation", "reviews:unapprove", { sourceId: scriptId });
  change(data, (known) => void delete known.approved[scriptId]);
}

export const approval = (data: string, scriptId: string): Approval | null => load(data).approved[scriptId] ?? null;

export async function resolve(noteId: string, version: number, ranges: Range[], summary: string, outcome?: "accepted" | "rejected"): Promise<void> {
  await call("mutation", "reviews:resolve", { noteId, version, changedRanges: ranges, fixSummary: summary, ...(outcome ? { outcome } : {}) });
}

/** What a note left from Edit says beyond its text: the words it's on, its intent, and a suggestion's replacement. */
export interface NoteDetails {
  anchor?: Record<string, unknown> | null;
  intent?: string | null;
  replacement?: string | null;
}

/** A note left from Edit on the script's latest review version, as a reviewer leaves one, fixed on Ready for changes like any other. */
export async function addNote(data: string, id: string, given: string, details: NoteDetails): Promise<void> {
  const text = given.trim();
  if (text === "" && details.intent !== "suggestion") throw new Error("Write the note first.");
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  const link = script.review;
  if (!link) throw new Error("Share the script for review first: notes live on its review page.");
  const args: Record<string, unknown> = { reviewId: link.reviewId, version: link.version, text };
  if (details.anchor) {
    await sharedTextFromCloud(dir, id, link);
    args.anchor = sharedAnchor(dir, link, script.revision, details.anchor);
  }
  if (details.intent) args.intent = details.intent;
  if (details.replacement != null) args.replacement = details.replacement;
  // Signed with the person's name, as a reply is; a Repack from before `author` refuses it, and then it goes unsigned.
  const author = (creator()?.name ?? "").trim();
  if (author !== "") {
    try {
      await call("mutation", "reviews:note", { ...args, author: [...author].slice(0, 200).join("") });
      await poll(data).catch(() => false);
      return;
    } catch (error) {
      if (!diag.messageOf(error).includes("author")) throw error;
    }
  }
  await call("mutation", "reviews:note", args);
  await poll(data).catch(() => false);
}

/** A person's word on a fix: confirmed, or sent back (the note opens again), with what still isn't right as a reply. */
export async function check(data: string, noteId: string, verdict: string, given: string | null): Promise<void> {
  if (verdict !== "confirmed" && verdict !== "notFixed") throw new Error("A fix is confirmed or sent back.");
  const author = [...(creator()?.name ?? "Edit")].slice(0, 200).join("");
  const text = given?.trim() ?? "";
  try {
    await call("mutation", "reviews:check", { noteId, author, verdict, ...(text !== "" ? { text } : {}) });
  } catch (error) {
    const message = diag.messageOf(error);
    throw new Error(message.includes("Could not find public function") || message.includes("reviews:check") ? "Checking a fix from Edit needs Repack's latest update; do it on the review page for now." : message);
  }
  await poll(data).catch(() => false);
}

/** How a "Ready for changes" on the script's review is going, and whether the fixing computer is on: the review page's own shapes, or nulls. */
export async function fixState(scriptId: string): Promise<{ fix: unknown; computer: unknown }> {
  try {
    const value = await call("query", "reviews:get", { sourceId: scriptId });
    return { fix: value.fix ?? null, computer: value.computer ?? null };
  } catch {
    return { fix: null, computer: null };
  }
}

type SharedText = { version: number; blocks: Record<string, string> };

function readShared(dir: string): SharedText | null {
  try {
    return JSON.parse(fs.readFileSync(join(dir, SHARED_TEXT), "utf8")) as SharedText;
  } catch {
    return null;
  }
}

/** The shared text for a version shared before it was kept here: read from the snapshot each share puts up. */
async function sharedTextFromCloud(dir: string, id: string, link: NonNullable<Script["review"]>): Promise<void> {
  if (readShared(dir)?.version === link.version) return;
  const bytes = await cloud.getBytes(`writer/reviews/${id}/v${link.version}/script.json`).catch(() => null);
  if (bytes === null) return;
  try {
    const snapshot = JSON.parse(new TextDecoder().decode(bytes)) as Script;
    writeAtomic(join(dir, SHARED_TEXT), JSON.stringify({ version: link.version, blocks: Object.fromEntries(blocksOf(snapshot).map((block) => [block.id, block.text])) }));
  } catch {
    // An unreadable snapshot: the anchor is checked against the script as shared, below.
  }
}

/**
 * A comment's words named in the shared version's text, as the review page
 * anchors them: where they were picked when that text still reads so, else
 * where the same words are found once in the block as shared.
 */
export function sharedAnchor(dir: string, link: NonNullable<Script["review"]>, revision: number, anchor: Record<string, unknown>): Record<string, unknown> {
  const block = typeof anchor.blockId === "string" ? anchor.blockId : "";
  const quote = typeof anchor.quote === "string" ? anchor.quote : "";
  const [start, end] = [Number(anchor.start ?? 0), Number(anchor.end ?? 0)];
  const shared = readShared(dir);
  const text = shared?.version === link.version ? shared.blocks[block] : undefined;
  if (text === undefined) {
    // Shared before the text was kept: only the script as it was shared can be named.
    if (revision === link.revision) return anchor;
    throw new Error(`Share again to comment on these words: v${link.version} on the review page is from before the script's latest edits.`);
  }
  const at = (from: number) => text.slice(from, from + quote.length) === quote;
  let found: number | null = null;
  if (end === start + quote.length && at(start)) found = start;
  else {
    const hits: number[] = [];
    for (let from = text.indexOf(quote); from >= 0 && quote !== ""; from = text.indexOf(quote, from + 1)) hits.push(from);
    if (hits.length === 1) found = hits[0]!;
  }
  if (found === null || quote === "") throw new Error(`Those words aren't on the review page as v${link.version} reads. Share again to comment on them.`);
  return { kind: "text", blockId: block, start: found, end: found + quote.length, quote };
}

/** A reply under a note, signed with `author`. */
export async function replyAs(data: string, noteId: string, given: string, author: string): Promise<void> {
  const text = given.trim();
  if (text === "") throw new Error("Write the reply first.");
  await call("mutation", "reviews:reply", { noteId, text, author });
  await poll(data).catch(() => false);
}

export const reply = (data: string, noteId: string, text: string): Promise<void> => replyAs(data, noteId, text, creator()?.name || "Edit");

/** Deletes a note left from Edit (never a reviewer's), with its replies. */
export async function deleteNote(data: string, noteId: string): Promise<void> {
  await call("mutation", "reviews:deleteNote", { noteId });
  await poll(data).catch(() => false);
}

// ---- Sharing ----

/** The review page plays the preview from the cloud, so sharing waits until that preview is verified there. */
async function previewInCloud(data: string, id: string, dir: string, script: Script): Promise<void> {
  if (script.commentary) return;
  const kept = cloud.fileKey(data, id, "proxy.mp4");
  if (kept !== null) {
    let found: number | null;
    try {
      found = await cloud.head(kept.key);
    } catch (error) {
      throw new Error(`Couldn't verify its preview in the cloud (${diag.messageOf(error)}). Check the connection, then share again.`);
    }
    if (found !== kept.size) throw new Error("Its preview hasn't reached the cloud yet. Wait for the sync to finish, then share again.");
  } else if (isFile(store.proxyPath(dir))) throw new Error("Its preview hasn't reached the cloud yet. Wait for the sync to finish, then share again.");
}

/** A commentary's paragraphs get the ids notes anchor to; refused when there's nothing to share. */
function shareable(dir: string, script: Script): Block[] {
  if (script.status !== "ready") throw new Error("Share a script once its import has finished.");
  if (script.commentary) {
    if (!script.commentary.draft) throw new Error("Write the script before sharing it.");
    if (ensureIds(script.commentary.draft)) store.write(dir, script);
  }
  const found = blocksOf(script);
  if (found.length === 0) throw new Error("There's nothing in the script to share yet.");
  return found;
}

const keepShared = (dir: string, version: number, found: Block[]) => writeAtomic(join(dir, SHARED_TEXT), JSON.stringify({ version, blocks: Object.fromEntries(found.map((block) => [block.id, block.text])) }));

/** Publishes the script as it stands: its first version, or the next under the same link. */
export async function share(app: App, data: string, id: string): Promise<Script> {
  if (jobs.running(id)) throw new Error("Claude is still working on this script. Share it when that's done.");
  return shareNext(app, data, id);
}

/** Shares the next version, also from inside the fix that made it (still the script's running job). */
export async function shareNext(app: App, data: string, id: string): Promise<Script> {
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  const found = shareable(dir, script);
  await previewInCloud(data, id, dir, script);
  const next = (script.review?.version ?? 0) + 1;
  // The review's id is Repack's to give, on the first publish: snapshots are kept by the script's id instead.
  const key = `writer/reviews/${id}/v${next}/script.json`;
  await cloud.putBytes(key, JSON.stringify(script));
  const meta = await metaOf(data, id, script, found);
  let value: Record<string, unknown>;
  try {
    value = await call("mutation", "reviews:publish", { sourceId: id, title: script.title, kind: "script", key, meta, sourceRev: script.revision, by: by() });
  } catch (error) {
    diag.error("writer", `${jobs.named(id, script.title)}: couldn't share: ${diag.messageOf(error)}`);
    throw error;
  }
  if (typeof value.reviewId !== "string" || typeof value.url !== "string") throw new Error("Repack published the review but sent no link.");
  const version = typeof value.version === "number" ? Math.trunc(value.version) : 1;
  diag.info("writer", `${jobs.named(id, script.title)}: shared as v${version} (${found.length} blocks) at ${value.url}`);
  // What the team would flag, said where a share by the fixing computer is seen.
  const flags = script.commentary ? commentary.checks(dir, script)[1] : audit(script);
  if (flags.length > 0) diag.warn("writer", `${jobs.named(id, script.title)}: v${version} shared with ${flags.length} things the team would flag: ${flags.map((flag) => [...flag].slice(0, 160).join("")).join(" | ")}`);
  const now = store.read(dir);
  now.review = { reviewId: value.reviewId, token: typeof value.token === "string" ? value.token : "", url: value.url, version, revision: script.revision, sharedAt: Date.now() };
  store.write(dir, now);
  keepShared(dir, version, found);
  change(data, (known) => {
    known.links[value.reviewId as string] = id;
    // A version shared after an approval is the next round, unapproved.
    delete known.approved[id];
  });
  // A commentary's review page plays its clips from stretches put up beside it.
  if (now.commentary) footage.soon(app, data, id);
  pollSoon();
  return now;
}

/** Replaces the latest shared version with the commentary as it is now, on the same link and number (`reviews:setMeta`). */
export async function replaceLatest(app: App, data: string, id: string): Promise<Script> {
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  const link = script.review;
  if (!link) throw new Error("Share the script first: there's no version to replace.");
  if (!script.commentary) throw new Error("Only a commentary's version can be replaced in place.");
  const found = shareable(dir, script);
  await cloud.putBytes(`writer/reviews/${id}/v${link.version}/script.json`, JSON.stringify(script));
  const meta = await metaOf(data, id, script, found);
  await call("mutation", "reviews:setMeta", { sourceId: id, version: link.version, meta });
  diag.info("writer", `${jobs.named(id, script.title)}: v${link.version} replaced in place (${found.length} blocks, revision ${script.revision}) at ${link.url}`);
  const now = store.read(dir);
  now.review = { ...link, revision: script.revision, sharedAt: Date.now() };
  store.write(dir, now);
  keepShared(dir, link.version, found);
  footage.soon(app, data, id);
  pollSoon();
  return now;
}

/** Makes the script as it is now the review's only version, v1, on the same link (`reviews:compress`): later versions go, every note moves onto v1. */
export async function compress(app: App, data: string, id: string): Promise<Script> {
  if (jobs.running(id)) throw new Error("Claude is still working on this script. Make it v1 when that's done.");
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  const link = script.review;
  if (!link) throw new Error("Share the script first: there's no review to make v1.");
  const found = shareable(dir, script);
  await previewInCloud(data, id, dir, script);
  const key = `writer/reviews/${id}/v1/script.json`;
  await cloud.putBytes(key, JSON.stringify(script));
  const meta = await metaOf(data, id, script, found);
  let answer: Record<string, unknown>;
  try {
    answer = await call("mutation", "reviews:compress", { sourceId: id, key, meta, sourceRev: script.revision, by: by() });
  } catch (error) {
    throw new Error(diag.messageOf(error).includes("Could not find public function") ? "Making a review v1 needs Repack's latest update." : diag.messageOf(error));
  }
  const removed = (Array.isArray(answer.removed) ? answer.removed : []).filter((one): one is number => typeof one === "number");
  diag.info("writer", `${jobs.named(id, script.title)}: made v1 on the same link (${found.length} blocks, revision ${script.revision}), removing v${removed.join(", v")} at ${link.url}`);
  const now = store.read(dir);
  now.review = { ...link, version: 1, revision: script.revision, sharedAt: Date.now() };
  store.write(dir, now);
  keepShared(dir, 1, found);
  if (now.commentary) footage.soon(app, data, id);
  change(data, (known) => void delete known.approved[id]);
  pollSoon();
  return now;
}

/**
 * What the review page shows and plays: the blocks, the outline rail with
 * running times against the format's target, and the preview the clips play
 * from. Word timings that would take it past Repack's cap go in a file of
 * their own (`wordsKey`).
 */
async function metaOf(data: string, id: string, script: Script, found: Block[]): Promise<Record<string, unknown>> {
  const isFootage = !script.commentary;
  const meta: Record<string, unknown> = { format: isFootage ? "footage" : "commentary", revision: script.revision, outline: outline(script, found) };
  const target = targetMs(script);
  if (target !== null) {
    meta.targetMs = target[1];
    meta.targetRangeMs = [target[0], target[2]];
  }
  if (isFootage) {
    // The preview the clips play from, put under the review (the review page serves only writer/reviews/ keys); sent again only when it changed.
    const proxy = await cloud.fetchPreview(data, id);
    const size = fs.statSync(proxy).size;
    const key = `writer/reviews/${id}/preview.mp4`;
    if ((await cloud.head(key)) !== size) await cloud.putFile(id, key, proxy);
    meta.preview = { key, durationMs: script.durationMs, sizeBytes: size };
  }
  meta.blocks = found;
  if (JSON.stringify(meta).length > META_BYTES) {
    const words = Object.fromEntries(found.flatMap((block) => (block.words && block.words.length > 0 ? [[block.id, block.words]] : [])));
    const key = `writer/reviews/${id}/${crypto.randomUUID()}/words.json`;
    await cloud.putBytes(key, JSON.stringify(words));
    meta.blocks = found.map(({ words: _words, ...rest }) => rest);
    meta.wordsKey = key;
    if (JSON.stringify(meta).length > META_BYTES) throw new Error("This script is too long to share in one review page.");
  }
  return meta;
}

// ---- What this Mac knows ----

interface Known {
  /** Where `reviews:changes` carries on from. */
  cursor: number;
  notes: Record<string, Note>;
  /** Review id → script id. */
  links: Record<string, string>;
  /** Notes this Mac has started fixing, so a run is never repeated. */
  tried: Record<string, number>;
  /** How many runs each note has had here. */
  attempts: Record<string, number>;
  /** Script id → its approved version, as Repack's reviews:open says. */
  approved: Record<string, Approval>;
}

const knownPath = (data: string) => join(data, "reviews", "notes.json");

function load(data: string): Known {
  try {
    const kept = JSON.parse(fs.readFileSync(knownPath(data), "utf8")) as Partial<Known>;
    return { cursor: kept.cursor ?? 0, notes: kept.notes ?? {}, links: kept.links ?? {}, tried: kept.tried ?? {}, attempts: kept.attempts ?? {}, approved: kept.approved ?? {} };
  } catch {
    return { cursor: 0, notes: {}, links: {}, tried: {}, attempts: {}, approved: {} };
  }
}

/** Changes what's known (one change at a time: JavaScript runs them in turn). */
function change(data: string, edit: (known: Known) => void): void {
  const known = load(data);
  edit(known);
  fs.mkdirSync(join(data, "reviews"), { recursive: true });
  writeAtomic(knownPath(data), JSON.stringify(known));
}

/** Every script's link, read from the scripts themselves: for a review shared on another Mac. */
function scanLinks(data: string): Record<string, string> {
  const links: Record<string, string> = {};
  for (const id of store.ids(data)) {
    try {
      const slim = JSON.parse(fs.readFileSync(join(store.scriptDir(data, id), "script.json"), "utf8")) as { id: string; review?: { reviewId?: string } };
      if (slim.review?.reviewId) links[slim.review.reviewId] = slim.id;
    } catch {
      // Not readable: passed over.
    }
  }
  return links;
}

/** Open notes per script, for the cards' badges; approvals; whether this Mac fixes. */
export function counts(data: string): { open: Record<string, number>; approved: Record<string, Approval>; fixesHere: boolean } {
  const known = load(data);
  const open: Record<string, number> = {};
  for (const note of Object.values(known.notes).filter((one) => isRoot(one) && isOpen(one))) {
    const script = note.scriptId ?? known.links[note.reviewId];
    if (script !== undefined) open[script] = (open[script] ?? 0) + 1;
  }
  return { open, approved: known.approved, fixesHere: chosen };
}

/** A script's notes, oldest first, with their replies. */
export function notesOf(data: string, scriptId: string): Note[] {
  const known = load(data);
  return Object.values(known.notes)
    .filter((note) => (note.scriptId ?? known.links[note.reviewId]) === scriptId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** A note fixed here: done in the next version, with what changed. */
export function markFixed(data: string, noteId: string, version: number, ranges: Range[], summary: string): void {
  change(data, (known) => {
    const note = known.notes[noteId];
    if (note) Object.assign(note, { status: "done", doneInVersion: version, changedRanges: ranges, fixSummary: summary, updatedAt: Date.now() });
  });
}

export function markTried(data: string, noteIds: string[]): void {
  change(data, (known) => {
    for (const id of noteIds) {
      known.tried[id] = Date.now();
      known.attempts[id] = (known.attempts[id] ?? 0) + 1;
    }
  });
}

/** A script's open notes, for fixing them by hand. */
export const openNotes = (data: string, scriptId: string): string[] => notesOf(data, scriptId).filter((note) => isRoot(note) && isOpen(note)).map((note) => note.id);
export const note = (data: string, id: string): Note | null => load(data).notes[id] ?? null;
/** The replies under a note, oldest first. */
export const replies = (data: string, id: string): Note[] => Object.values(load(data).notes).filter((one) => one.parentId === id).sort((a, b) => a.createdAt - b.createdAt);

// ---- Asking for changes, and fixing ----

let pollNow = false;
export const pollSoon = (): void => void (pollNow = true);
/** This Mac is the fixing computer, as the last check-in said. */
let chosen = false;

/** Asks for changed notes while Edit runs, checks in as this computer, and on the fixing computer takes each "Ready for changes". */
export function start(app: App, data: string): void {
  let lastPoll = 0;
  let lastCheck = 0;
  let busyNow = false;
  setInterval(() => {
    if (busyNow || !relay.cloudEnabled()) return;
    busyNow = true;
    void (async () => {
      if (pollNow || Date.now() - lastPoll >= POLL_MS) {
        pollNow = false;
        lastPoll = Date.now();
        await poll(data).catch((error: unknown) => diag.warn("writer", `review notes: ${diag.messageOf(error)}`));
      }
      if (Date.now() - lastCheck >= (chosen ? CHECK_IN_CHOSEN_MS : POLL_MS)) {
        lastCheck = Date.now();
        await checkIn(app, data);
      }
    })().finally(() => (busyNow = false));
  }, 3_000);
}

/** One round of changes; says whether anything changed. */
export async function poll(data: string): Promise<boolean> {
  // Approvals, made here or on Repack's page: only reviews:open carries them.
  const rows = await call("query", "reviews:open", {}).then((value) => (Array.isArray(value) ? value : []) as Record<string, unknown>[], () => [] as Record<string, unknown>[]);
  const approved: Record<string, Approval> = {};
  for (const row of rows) {
    const found = approvalOf(row.approved);
    if (typeof row.sourceId === "string" && found !== null) approved[row.sourceId] = found;
  }
  let moved = false;
  change(data, (known) => {
    moved = JSON.stringify(known.approved) !== JSON.stringify(approved);
    known.approved = approved;
  });
  const cursor = load(data).cursor;
  const [notes, next] = await changes(cursor);
  if (notes.length === 0 && next === cursor) return moved;
  diag.info("writer", `${notes.length} notes changed on review links (${notes.filter((one) => isRoot(one) && !one.deleted).length} notes, ${notes.filter((one) => !isRoot(one)).length} replies, ${notes.filter((one) => one.deleted).length} deleted)`);
  const before = load(data);
  const scanned = notes.some((one) => !one.scriptId && before.links[one.reviewId] === undefined) ? scanLinks(data) : {};
  let changed = moved;
  change(data, (known) => {
    Object.assign(known.links, scanned);
    for (const given of notes) {
      // Deleted by its guest: gone, with its replies, never a phantom open note.
      if (given.deleted) {
        const count = Object.keys(known.notes).length;
        for (const [id, kept] of Object.entries(known.notes)) if (id === given.id || kept.parentId === given.id) delete known.notes[id];
        delete known.tried[given.id];
        changed ||= Object.keys(known.notes).length !== count;
        continue;
      }
      const one = { ...given, scriptId: given.scriptId ?? known.links[given.reviewId] ?? null };
      delete one.deleted;
      const kept = known.notes[one.id];
      const same = kept !== undefined && kept.updatedAt === one.updatedAt && kept.status === one.status;
      // Sent back as not fixed (or opened again): a new note to fix.
      const reopened = kept !== undefined && ((!isOpen(kept) && isOpen(one)) || kept.notFixedAt !== one.notFixedAt);
      if (reopened && untaken(one)) delete known.tried[one.id];
      if (!same) {
        known.notes[one.id] = one;
        changed = true;
      }
    }
    known.cursor = next;
  });
  return changed;
}

/** Says this Mac is open (for accounts' Fixing page) and, on the fixing computer, takes each waiting "Ready for changes" whose script is here. */
async function checkIn(app: App, data: string): Promise<void> {
  let answer: Record<string, unknown>;
  try {
    answer = await call("mutation", "reviews:checkIn", { machine: machine.id(), name: machine.name(), email: email() });
  } catch (error) {
    diag.warn("writer", `checking in for fixing: ${diag.messageOf(error)}`);
    return;
  }
  const now = answer.chosen === true;
  if (now !== chosen) diag.info("writer", now ? "this Mac is the fixing computer: it takes Ready for changes" : "this Mac isn't the fixing computer");
  chosen = now;
  if (!chosen || !can.has(can.SHARE)) return;
  const requests = (Array.isArray(answer.requests) ? answer.requests : []) as Record<string, unknown>[];
  if (requests.length === 0) return;
  // The notes it fixes are read from what this Mac has heard: hear them first.
  await poll(data).catch(() => false);
  for (const request of requests) {
    if (typeof request.reviewId !== "string" || typeof request.sourceId !== "string") continue;
    await take(app, data, request.reviewId, request.sourceId, typeof request.title === "string" ? request.title : "");
  }
}

/** Takes one request and starts its fix, or says why it couldn't. */
async function take(app: App, data: string, reviewId: string, scriptId: string, title: string): Promise<void> {
  const name = jobs.named(scriptId, title);
  let here = false;
  try {
    here = store.read(store.scriptDir(data, scriptId)).status === "ready";
  } catch {
    here = false;
  }
  // A script this Mac hasn't got yet (the sync brings it) or is busy with waits for a later check-in.
  if (!here || jobs.running(scriptId) || importing(scriptId)) {
    diag.info("writer", `${name}: Ready for changes waits: the script ${here ? "is busy" : "isn't on this Mac yet"}`);
    return;
  }
  let taken: Record<string, unknown>;
  try {
    taken = await call("mutation", "reviews:takeFix", { machine: machine.id(), reviewId });
  } catch (error) {
    diag.warn("writer", `${name}: couldn't take Ready for changes: ${diag.messageOf(error)}`);
    return;
  }
  if (taken.ok !== true) {
    diag.info("writer", `${name}: Ready for changes not taken (${String(taken.reason ?? "?")})`);
    return;
  }
  const notes = (Array.isArray(taken.noteIds) ? taken.noteIds : []).filter((one): one is string => typeof one === "string");
  diag.info("writer", `${name}: Ready for changes: fixing ${notes.length} ${notes.length === 1 ? "note" : "notes"}`);
  markTried(data, notes);
  try {
    // A fix as a job on the script; the next version is shared after (fixing.ts).
    jobs.start(data, scriptId, title || store.read(store.scriptDir(data, scriptId)).title, { kind: "review", notes, ready: reviewId }, (job) => fixing.run(app, data, scriptId, notes, reviewId, job));
  } catch (error) {
    await progress(reviewId, { state: "failed", error: diag.messageOf(error) });
  }
}

/** How a "Ready for changes" is going, for its review page: `state` fixing, sharing, done or failed. Best effort. */
export async function progress(reviewId: string, given: { state?: string; stage?: string; done?: number; total?: number; error?: string }): Promise<void> {
  try {
    await call("mutation", "reviews:fixProgress", { machine: machine.id(), reviewId, ...given });
  } catch (error) {
    diag.warn("writer", `saying how the fix is going: ${diag.messageOf(error)}`);
  }
}
