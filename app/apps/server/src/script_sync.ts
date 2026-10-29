// One project, two modes (Oct 29, the user: "once you make a change on the
// script and save it changes on the video as well, e.g a voice over
// regeneration of just that sentence… or the clip you added reflects and when
// you undo on script it undos on edit. they are synced"; and an Edit-mode
// change updates the script too: "yes").
//
// An edit made from a script keeps, on each of its blocks, the script clip it
// came from (`origin`), and the script keeps each clip as the two last agreed
// on (`script.edit`, in the script's body, so it travels with the script to
// every Mac). A script saved here is compared with that, clip by clip, and the
// edit follows:
//   - a cut-in reworded is spoken again, that line alone (voiceover.revoice:
//     fitted by speed, or the time at its end opened or closed when the new
//     take is too far from the old one); one not voiced yet has its card's
//     words changed;
//   - a range trimmed or lengthened at either end loses or gains that much
//     time there on every track (cutTime, insertTime);
//   - a clip taken out takes its time with it;
//   - a cut-in added goes in at the cut after the clip before it and is
//     voiced; a range added plays there from the footage the edit has.
// An edit saved here is read back the same way: a script-made range whose
// first in point or last out point moved, a cut-in reworded, or a script
// clip's blocks gone changes the script (a version by "The edit"). A range is
// read by its outer ends, so the agent tightening pauses inside it changes
// nothing. Changes go as deltas from what was agreed, never as absolute
// times, so the transcript's tighter cuts and the frame grid don't drift.
// Undo on either side is a save like any other, so it reaches the other.
//
// A script rewritten wholesale (most of its clips new: a rebuild) leaves the
// edit as it is and says so (`outOfStep`): a finished edit isn't remade under
// anyone; resetting the edit makes it follow the script again.

import * as fs from "node:fs";

import type { Clip as ScriptClip, EditLink, Script, SyncedClip } from "@edit/types/writer";

import type { App } from "./app.ts";
import { clipFrom } from "./clips.ts";
import * as diag from "./diag.ts";
import * as framing from "./framing.ts";
import type { Clip, Project, ScriptBlock } from "./model.ts";
import { join } from "./paths.ts";
import { clipEnd, clipOf, cutTime, fps as fpsOf, freshId, insertTime, mediaOf } from "./project.ts";
import { addCutIn } from "./script.ts";
import * as voiceover from "./voiceover.ts";
import { isCutIn } from "./writer/blocks.ts";
import * as writerJobs from "./writer/jobs.ts";
import * as writerStore from "./writer/store.ts";
import * as versions from "./writer/versions.ts";
import { recordingFiles, toParsed, type WriterScript } from "./writer_handoff.ts";

/** Edit saves the sync makes, so it doesn't read them back as the edit's own. */
export const ORIGIN = "script";
const SETTLE_MS = 1_500;
/** More than this share of the clips new at once is a rebuild, not an edit. */
const REWRITTEN = 0.5;

const syncedOf = (clip: ScriptClip, edit?: SyncedClip["edit"]): SyncedClip => ({
  id: clip.id,
  cutIn: isCutIn(clip),
  startMs: clip.startMs,
  endMs: clip.endMs,
  narration: isCutIn(clip) ? (clip.narration ?? "").trim() : null,
  ...(edit ? { edit } : {}),
});

/** Whether a script's edit follows it: a footage script's does; a commentary's edit is built from its paragraphs, not its clips. */
export const follows = (script: { sourceKind?: string; commentary?: unknown }): boolean => script.sourceKind !== "commentary" && !script.commentary;

/** The link a new edit starts with: the script's clips as they are, the edit's side filled in once it's laid out. */
export function linkOf(project: string, script: Script): EditLink {
  return { project, clips: script.clips.map((clip) => syncedOf(clip)) };
}

// ---- What the edit plays for one script clip ----

const blocksOf = (project: Project, origin: string): ScriptBlock[] => (project.script?.blocks ?? []).filter((block) => block.origin === origin);

type Played = Extract<Clip, { type: "video" | "audio" }>;

/** Seconds of the block's file where a clip of it starts and ends. */
function fileSpan(project: Project, block: ScriptBlock, clip: Played): [number, number] {
  const offset = block.kind === "footage" ? (block.media_start ?? 0) : 0;
  return [offset + clip.source_in, offset + clip.source_in + (clip.duration / fpsOf(project)) * clip.speed];
}

/**
 * A footage block's pieces on the timeline, in order: its clip and the clips
 * right after it playing on from the same media, later in it (the pieces
 * pauses were cut into), up to another block's clip. A sound-only recording's
 * card is read through its sound. With its first clip cut away in the edit,
 * whatever of its range still plays. Empty: none of it plays.
 */
function run(project: Project, block: ScriptBlock): Played[] {
  if (block.kind !== "footage") return [];
  const others = new Set((project.script?.blocks ?? []).flatMap((other) => (other !== block && other.clip ? [other.clip] : [])));
  const card = block.clip ? clipOf(project, block.clip) : undefined;
  const first = card?.type === "video" ? card : card?.link ? project.clips.find((clip): clip is Played => clip.type === "audio" && clip.link === card.link) : undefined;
  if (first !== undefined && (first.type === "video" || first.type === "audio")) {
    const same = project.clips.filter((clip): clip is Played => clip.type === first.type && clip.track === first.track && clip.media === first.media && clip.start >= clipEnd(first)).sort((a, b) => a.start - b.start);
    const pieces: Played[] = [first];
    for (const clip of same) {
      const last = pieces[pieces.length - 1]!;
      if (others.has(clip.id) || clip.start - clipEnd(last) > 1 || clip.source_in < last.source_in) break;
      pieces.push(clip);
    }
    return pieces;
  }
  if (!block.media) return [];
  const kind = mediaOf(project, block.media)?.kind === "audio" ? "audio" : "video";
  return project.clips
    .filter((clip): clip is Played => clip.type === kind && clip.media === block.media && !others.has(clip.id))
    .filter((clip) => {
      const [from, to] = fileSpan(project, block, clip);
      return to > block.start - 0.5 && from < block.end + 0.5;
    })
    .sort((a, b) => a.start - b.start);
}

/** The edit's side of one script clip: a range's outer ends (seconds of its first and last recording), or a cut-in's words; null when it has none. */
export function editSide(project: Project, origin: string): NonNullable<SyncedClip["edit"]> | null {
  const blocks = blocksOf(project, origin);
  if (blocks.length === 0) return null;
  const first = blocks[0]!;
  if (first.kind === "narration") return { head: 0, tail: 0, text: first.text.trim() };
  const lastBlock = blocks[blocks.length - 1]!;
  const heads = run(project, first).map((clip) => fileSpan(project, first, clip)[0]);
  const tails = run(project, lastBlock).map((clip) => fileSpan(project, lastBlock, clip)[1]);
  if (heads.length === 0 || tails.length === 0) return null;
  return { head: Math.min(...heads), tail: Math.max(...tails), text: null };
}

/** The timeline frames one script clip takes: its range's run, or its cut-in (its voice-over, else its card). */
function spanOf(project: Project, origin: string): [number, number] | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const block of blocksOf(project, origin)) {
    const clips: Clip[] = block.kind === "footage" ? [...run(project, block), ...(block.clip && clipOf(project, block.clip) ? [clipOf(project, block.clip)!] : [])] : [block.voiceover ? clipOf(project, block.voiceover) : undefined, block.clip ? clipOf(project, block.clip) : undefined].filter((clip): clip is Clip => clip !== undefined);
    for (const clip of clips) {
      start = Math.min(start, clip.start);
      end = Math.max(end, clipEnd(clip));
    }
  }
  return Number.isFinite(start) && end > start ? [start, end] : null;
}

/** The clips linked with `clip` (its sound, its picture). */
const linked = (project: Project, clip: Clip): string[] => project.clips.filter((other) => other.id === clip.id || (clip.link && other.link === clip.link)).map((other) => other.id);

// ---- The script's changes, in the edit ----

interface Change {
  removed: SyncedClip[];
  trimmed: [SyncedClip, ScriptClip][];
  reworded: [SyncedClip, ScriptClip][];
  added: [ScriptClip, string | null][];
}

/** What changed in the script since it and the edit last agreed: each kept clip by its id. */
export function changesOf(link: EditLink, script: Script): Change {
  const now = new Map(script.clips.map((clip) => [clip.id, clip]));
  const was = new Map(link.clips.map((clip) => [clip.id, clip]));
  const change: Change = { removed: [], trimmed: [], reworded: [], added: [] };
  for (const kept of link.clips) {
    const clip = now.get(kept.id);
    if (clip === undefined) change.removed.push(kept);
    else if (kept.cutIn && (clip.narration ?? "").trim() !== kept.narration) change.reworded.push([kept, clip]);
    else if (!kept.cutIn && (clip.startMs !== kept.startMs || clip.endMs !== kept.endMs)) change.trimmed.push([kept, clip]);
  }
  script.clips.forEach((clip, index) => {
    if (was.has(clip.id)) return;
    // After the clip before it that the edit has.
    const before = script.clips.slice(0, index).reverse().find((other) => was.has(other.id));
    change.added.push([clip, before?.id ?? null]);
  });
  return change;
}

const mmss = (seconds: number) => {
  const whole = Math.max(Math.round(seconds), 0);
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
};

const empty = (change: Change) => change.removed.length + change.trimmed.length + change.reworded.length + change.added.length === 0;

/** Footage for a range added in the script: the media the edit plays that recording from. */
function footageFor(project: Project, file: string): { media: string; offset: number; url: string } | null {
  for (const block of project.script?.blocks ?? []) {
    if (block.kind === "footage" && block.file === file && block.media) return { media: block.media, offset: block.media_start ?? 0, url: block.url };
  }
  return null;
}

/** The script's structural changes in one edit save: ranges trimmed, clips taken out and added. Answers the cut-ins to voice and to speak again. */
export function applyToEdit(project: Project, given: WriterScript, change: Change): { revoice: [string, string][]; voice: boolean; skipped: string[] } {
  const fps = fpsOf(project);
  const frames = (seconds: number) => Math.max(Math.round(Math.abs(seconds) * fps), 0);
  const out = { revoice: [] as [string, string][], voice: false, skipped: [] as string[] };
  // Taken out: latest first, so one cut never moves another's span.
  const gone = change.removed.map((kept) => [kept, spanOf(project, kept.id)] as const).filter(([, span]) => span !== null).sort((a, b) => b[1]![0] - a[1]![0]);
  for (const [kept, span] of gone) {
    cutTime(project, span![0], span![1]);
    if (project.script) project.script.blocks = project.script.blocks.filter((block) => block.origin !== kept.id);
  }
  // Trimmed or lengthened at either end, by as much as the script moved it.
  for (const [kept, clip] of change.trimmed) {
    const blocks = blocksOf(project, kept.id);
    const first = blocks[0];
    const last = blocks[blocks.length - 1];
    if (first === undefined || last === undefined) continue;
    const tailRun = run(project, last);
    const tail = tailRun.at(-1);
    const moveTail = (clip.endMs - kept.endMs) / 1000;
    if (tail !== undefined && moveTail !== 0) {
      const end = clipEnd(tail);
      // No further than its footage goes.
      const left = (mediaOf(project, tail.media)?.duration ?? Number.POSITIVE_INFINITY) - (tail.source_in + (tail.duration / fps) * tail.speed);
      const by = frames(Math.min(moveTail, moveTail > 0 ? left : Number.POSITIVE_INFINITY) / tail.speed);
      if (moveTail > 0) insertTime(project, end, by, new Set(linked(project, tail)), new Set());
      else cutTime(project, Math.max(end - by, tailRun[0]!.start), end);
    }
    const head = run(project, first)[0];
    const moveHead = (clip.startMs - kept.startMs) / 1000;
    if (head !== undefined && moveHead !== 0) {
      const by = frames(Math.max(moveHead, -head.source_in) / head.speed);
      if (moveHead < 0) insertTime(project, head.start, by, new Set(), new Set(linked(project, head)));
      else cutTime(project, head.start, Math.min(head.start + by, clipEnd(head)));
    }
    // The script's times, as the edit's script shows them.
    const now = blocksOf(project, kept.id);
    const [opening, closing] = [now[0], now[now.length - 1]];
    if (opening?.kind === "footage") opening.start = Math.max(opening.start + moveHead, 0);
    if (closing?.kind === "footage") closing.end = Math.max(closing.end + moveTail, closing.start);
    for (const block of now) if (block.kind === "footage") block.label = `${mmss(block.start)} - ${mmss(block.end)}`;
  }
  // Reworded: a voiced cut-in is spoken again after this save; a card alone takes the words now.
  for (const [kept, clip] of change.reworded) {
    const block = blocksOf(project, kept.id).find((one) => one.kind === "narration");
    if (block === undefined || block.kind !== "narration") continue;
    const text = (clip.narration ?? "").trim();
    if (block.voiceover && clipOf(project, block.voiceover)) {
      out.revoice.push([kept.id, text]);
      continue;
    }
    block.text = text;
    const card = block.clip ? clipOf(project, block.clip) : undefined;
    const words = card?.link ? project.clips.find((other) => other.link === card.link && other.type === "text") : undefined;
    if (words !== undefined && words.type === "text") words.text = text;
  }
  // Added: at the cut after the clip before it (the start, when it's first).
  const files = recordingFiles(given);
  for (const [clip, after] of change.added) {
    const span = after === null ? null : spanOf(project, after);
    const at = span?.[1] ?? 0;
    if (isCutIn(clip)) {
      const text = (clip.narration ?? "").trim();
      if (text === "" || clip.reuse) {
        out.skipped.push(`a cut-in with no words${clip.reuse ? " (a reused case)" : ""}`);
        continue;
      }
      const card = addCutIn(project, text, at);
      const block = project.script?.blocks.find((one) => one.kind === "narration" && one.clip === card);
      if (block !== undefined && block.kind === "narration") {
        block.origin = clip.id;
        block.notes = (block.notes ?? []).filter((note) => note !== "Added cut-in");
      }
      out.voice = true;
      continue;
    }
    const file = files.find((one) => clip.startMs >= one.start && clip.startMs < one.end);
    const footage = file === undefined ? null : footageFor(project, file.file);
    if (file === undefined || footage === null) {
      out.skipped.push(`a range of a recording the edit doesn't have yet`);
      continue;
    }
    const media = mediaOf(project, footage.media);
    if (media === undefined) continue;
    const start = (clip.startMs - file.start) / 1000;
    const end = (Math.min(clip.endMs, file.end) - file.start) / 1000;
    const from = Math.min(Math.max(start - footage.offset, 0), media.duration);
    const length = frames(Math.min(end - footage.offset, media.duration) - from);
    const lower = project.tracks.find((track) => track.kind === "video")?.id;
    const sound = project.tracks.find((track) => track.kind === "audio")?.id;
    if (length === 0 || lower === undefined) continue;
    insertTime(project, at, length, new Set(), new Set());
    const link = media.has_audio && sound !== undefined ? freshId(project, "l") : null;
    const id = freshId(project, "c");
    project.clips.push(clipFrom({ id, track: lower, start: at, duration: length, color: "blue", ...(link ? { link } : {}), type: "video", media: media.id, source_in: from, speed: 1, transform: { ...framing.fill(project, media), rotation: 0 } }));
    if (link !== null && sound !== undefined) project.clips.push(clipFrom({ id: freshId(project, "c"), track: sound, start: at, duration: length, color: "blue", link, type: "audio", media: media.id, source_in: from, speed: 1 }));
    const block: ScriptBlock = { kind: "footage", url: footage.url, file: file.file, start, end, label: "Added in the script", media: media.id, ...(footage.offset ? { media_start: footage.offset } : {}), clip: id, origin: clip.id };
    const blocks = project.script?.blocks ?? [];
    const index = after === null ? 0 : blocks.findLastIndex((one) => one.origin === after) + 1;
    blocks.splice(index, 0, block);
  }
  return out;
}

// ---- The edit's changes, in the script ----

/** The edit's changes to script-made clips since the two last agreed, applied to `script`'s clips; whether any were. */
export function applyToScript(project: Project, script: Script, link: EditLink): boolean {
  const frameMs = 1000 / fpsOf(project);
  let changed = false;
  const gone = new Set<string>();
  for (const kept of link.clips) {
    if (kept.edit === undefined) continue;
    const clip = script.clips.find((one) => one.id === kept.id);
    if (clip === undefined) continue;
    const now = editSide(project, kept.id);
    if (now === null) {
      // Its blocks are gone from the edit: taken out there.
      gone.add(kept.id);
      changed = true;
      continue;
    }
    if (kept.cutIn) {
      if (now.text !== null && now.text !== kept.edit.text) {
        clip.narration = now.text;
        changed = true;
      }
      continue;
    }
    const head = (now.head - kept.edit.head) * 1000;
    const tail = (now.tail - kept.edit.tail) * 1000;
    if (Math.abs(head) >= frameMs / 2 || Math.abs(tail) >= frameMs / 2) {
      clip.startMs = Math.max(Math.round(clip.startMs + head), 0);
      clip.endMs = Math.max(Math.round(clip.endMs + tail), clip.startMs + 100);
      changed = true;
    }
  }
  if (gone.size > 0) script.clips = script.clips.filter((clip) => !gone.has(clip.id));
  return changed;
}

/** The two as they agree now: the script's clips and, for each, the edit's side. */
function agreed(project: Project, script: Script, link: EditLink): EditLink {
  const { outOfStep: _gone, ...rest } = link;
  return { ...rest, clips: script.clips.map((clip) => syncedOf(clip, editSide(project, clip.id) ?? undefined)) };
}

// ---- Keeping them in step ----

const queued = new Map<string, ReturnType<typeof setTimeout>>();
const chains = new Map<string, Promise<void>>();

/** Runs `work` once `project`'s `side` has been still a moment, after any work for that project already under way (the two sides never run at once). */
function later(project: string, side: "script" | "edit", work: () => Promise<void>, wait = SETTLE_MS): void {
  const key = `${project} ${side}`;
  clearTimeout(queued.get(key));
  queued.set(
    key,
    setTimeout(() => {
      queued.delete(key);
      const next = (chains.get(project) ?? Promise.resolve()).then(work).catch((error: unknown) => diag.warn("script", `${project}: keeping the script and its edit in step: ${diag.messageOf(error)}`));
      chains.set(project, next);
    }, wait),
  );
}

const IMPORTING = ["downloading", "transcribing", "placing", "voicing"];
const importing = (app: App, project: string) => IMPORTING.includes(app.scripts.get(project)?.state ?? "");

/** Saves the agreed link into the script (no new revision: nothing of the script changed). */
function keepLink(dir: string, link: EditLink): void {
  writerStore.update(dir, (script) => void (script.edit = link), true);
}

/** The script saved on this Mac: its edit follows, as the module notes say. */
export async function fromScript(app: App, scriptId: string): Promise<void> {
  const data = writerStore.dataDir(app.store.home);
  const dir = writerStore.scriptDir(data, scriptId);
  const script = writerStore.read(dir);
  const link = script.edit;
  if (link === undefined || link.outOfStep !== undefined || !follows(script)) return;
  const live = app.store.get(link.project);
  if (live === null) return;
  // Still being made on either side: once it's done (its last save calls again).
  if (script.status !== "ready" || writerJobs.running(scriptId) || importing(app, link.project)) {
    if (writerJobs.running(scriptId) || importing(app, link.project)) later(link.project, "script", () => fromScript(app, scriptId), 10_000);
    return;
  }
  // The edit's side of clips it hadn't laid out yet, read before anything is compared.
  if (link.clips.some((kept) => kept.edit === undefined && editSide(live.project, kept.id) !== null)) {
    const filled = { ...link, clips: link.clips.map((kept) => (kept.edit === undefined ? { ...kept, ...(editSide(live.project, kept.id) ? { edit: editSide(live.project, kept.id)! } : {}) } : kept)) };
    keepLink(dir, filled);
    return fromScript(app, scriptId);
  }
  const change = changesOf(link, script);
  if (empty(change)) return;
  const kept = link.clips.length - change.removed.length;
  if (link.clips.length >= 4 && kept / link.clips.length < 1 - REWRITTEN) {
    const reason = `The script was rebuilt (${change.removed.length} of ${link.clips.length} clips replaced), so the edit wasn't changed to match it: it keeps the script it was made from.`;
    diag.warn("script", `${link.project}: ${reason}`);
    keepLink(dir, { ...link, outOfStep: reason });
    return;
  }
  const [saved, done] = await app.store.update(link.project, ORIGIN, (project) => applyToEdit(project, script as unknown as WriterScript, change));
  for (const [origin, text] of done.revoice) {
    const blocks = (app.store.get(link.project)?.project.script?.blocks ?? []).filter((block) => block.kind === "narration");
    const number = blocks.findIndex((block) => block.origin === origin) + 1;
    if (number > 0) await voiceover.revoice(app, link.project, number, text, true).catch((error: unknown) => diag.warn("script", `${link.project}: cut-in ${number} wasn't spoken again: ${diag.messageOf(error)}`));
  }
  if (done.voice) await voiceover.generate(app, link.project, true).catch((error: unknown) => diag.warn("script", `${link.project}: the added cut-in wasn't voiced: ${diag.messageOf(error)}`));
  const now = app.store.get(link.project)?.project ?? saved.project;
  keepLink(dir, agreed(now, writerStore.read(dir), link));
  const said = [
    change.trimmed.length ? `${change.trimmed.length} trimmed` : "",
    change.reworded.length ? `${change.reworded.length} reworded` : "",
    change.removed.length ? `${change.removed.length} taken out` : "",
    change.added.length - done.skipped.length > 0 ? `${change.added.length - done.skipped.length} added` : "",
  ].filter(Boolean);
  diag.info("script", `${link.project}: the edit follows its script (${said.join(", ")})${done.skipped.length ? `; not followed: ${done.skipped.join(", ")}` : ""}`);
}

/** The edit saved on this Mac (not by the sync, not a cloud pull): its script follows. */
export async function fromEdit(app: App, projectId: string): Promise<void> {
  const live = app.store.get(projectId);
  const source = live?.project.script?.source ?? "";
  if (live === null || !source.startsWith("writer:")) return;
  // Still laying out: once it's done, its clips are read as the two agree.
  if (importing(app, projectId)) return later(projectId, "edit", () => fromEdit(app, projectId), 10_000);
  const data = writerStore.dataDir(app.store.home);
  const dir = writerStore.scriptDir(data, source.slice("writer:".length));
  let script: Script;
  try {
    script = writerStore.read(dir);
  } catch {
    return;
  }
  const link = script.edit;
  if (link === undefined || link.project !== projectId || link.outOfStep !== undefined || !follows(script) || writerJobs.running(script.id)) return;
  const before = structuredClone(script);
  if (!applyToScript(live.project, script, link)) {
    // Nothing of the script's changed, but clips laid out since are now known.
    if (link.clips.some((kept) => kept.edit === undefined && editSide(live.project, kept.id) !== null)) keepLink(dir, agreed(live.project, script, link));
    return;
  }
  script.edit = agreed(live.project, script, link);
  script.revision++;
  script.updatedAt = Date.now();
  writerStore.write(dir, script);
  versions.keep(dir, "edit", before, script);
  writerStore.libraryChanged();
  diag.info("script", `${projectId}: its script follows the edit (${versions.summary(versions.snapshotOf(before), versions.snapshotOf(script))})`);
}

/**
 * An edit made from a script before blocks knew their script clips: linked
 * when its blocks are still the script's, one for one (the same recordings and
 * times within a second, the same words), so it follows the script from now
 * on. One that has moved on from its script is left as it is.
 */
export async function adopt(app: App, projectId: string): Promise<boolean> {
  const live = app.store.get(projectId);
  const source = live?.project.script?.source ?? "";
  if (live === null || !source.startsWith("writer:") || live.project.script!.blocks.some((block) => block.origin)) return false;
  const dir = writerStore.scriptDir(writerStore.dataDir(app.store.home), source.slice("writer:".length));
  let script: Script;
  let parsed: ScriptBlock[];
  try {
    script = writerStore.read(dir);
    parsed = toParsed(script as unknown as WriterScript).blocks;
  } catch {
    return false;
  }
  if (script.edit !== undefined || !follows(script)) return false;
  const blocks = live.project.script!.blocks;
  const same = blocks.length === parsed.length && blocks.every((block, index) => {
    const other = parsed[index]!;
    if (block.kind !== other.kind) return false;
    if (block.kind === "narration" && other.kind === "narration") return block.text.trim() === other.text.trim();
    return block.kind === "footage" && other.kind === "footage" && block.file === other.file && Math.abs(block.start - other.start) < 1 && Math.abs(block.end - other.end) < 1;
  });
  if (!same) return false;
  const [saved] = await app.store.update(projectId, ORIGIN, (project) => {
    project.script!.blocks.forEach((block, index) => {
      const origin = parsed[index]!.origin;
      if (origin) block.origin = origin;
    });
  });
  writerStore.update(dir, (kept) => void (kept.edit = agreed(saved.project, kept, linkOf(projectId, kept))), true);
  diag.info("script", `${projectId}: follows its script from now on`);
  return true;
}

/** Keeps every script and its edit in step while Edit runs. */
export function start(app: App): void {
  // Edits made from scripts before blocks knew their clips, linked once (a project file that doesn't say "writer:" isn't loaded).
  setTimeout(() => {
    void (async () => {
      for (const summary of app.store.list()) {
        let text = "";
        try {
          text = fs.readFileSync(join(app.store.home, "projects", `${summary.id}.json`), "utf8");
        } catch {
          continue;
        }
        if (text.includes('"writer:')) await adopt(app, summary.id).catch((error: unknown) => diag.warn("script", `${summary.id}: not linked to its script: ${diag.messageOf(error)}`));
      }
    })();
  }, 30_000);
  writerStore.hooks.written = (script) => {
    if (script.edit !== undefined && script.edit.outOfStep === undefined) later(script.edit.project, "script", () => fromScript(app, script.id));
  };
  app.store.subscribe((event) => {
    if (event.type !== "project" || event.origin === ORIGIN || event.origin === "cloud" || typeof event.id !== "string") return;
    const project = event.project as Project | undefined;
    if (!(project?.script?.source ?? "").startsWith("writer:")) return;
    const id = event.id;
    later(id, "edit", () => fromEdit(app, id));
  });
}
