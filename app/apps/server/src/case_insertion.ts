// A case is prepared after the existing script, then inserted in one store
// transaction. Its receipt lives with the script so a restart can resume it.
import type { Project, ScriptBlock } from "./model.ts";
import type { Parsed } from "./seams.ts";
import { clipEnd, clipOf, duration, insertTime, mediaOf } from "./project.ts";

const PENDING = "edit:pending-case:v1 ";
export const CASE = "Added compilation case: ";
interface Insertion { id: string; at: number; before: number; count: number; number: number; title: string; anchor?: string }
const tag = (id: string) => `${CASE}${id}`;

export function pendingCase(project: Project): Insertion | null {
  const note = project.script?.blocks.flatMap((block) => block.notes ?? []).find((note) => note.startsWith(PENDING));
  if (!note) return null;
  const value = JSON.parse(note.slice(PENDING.length)) as Insertion;
  if (!/^[\w-]{1,80}$/u.test(value.id) || ![value.at, value.before, value.count, value.number].every(Number.isSafeInteger)
    || value.at < 0 || value.before < 0 || value.count < 1 || value.number < 1) throw new Error("The pending case insertion receipt is invalid.");
  return value;
}

export function hasCase(project: Project, id: string): boolean {
  return project.script?.blocks.some((block) => block.notes?.includes(tag(id))) ?? false;
}

function boundary(project: Project, at: number): void {
  if (at < 0 || at > duration(project)) throw new Error("Choose a case boundary inside this timeline (frames).");
  const crossing = project.clips.filter((clip) => clip.start < at && clipEnd(clip) > at &&
    (clip.type === "video" || (clip.type === "audio" && mediaOf(project, clip.media)?.kind !== "audio")));
  if (crossing.length) throw new Error(`The insertion crosses footage or its sound (${crossing.map((clip) => clip.id).join(", ")}). Split at a clean case boundary first.`);
}

export function queueCase(project: Project, parsed: Parsed, options: { id: string; at: number; number: number; title?: string; intro?: string; before?: number }): boolean {
  if (!/^[\w-]{1,80}$/u.test(options.id)) throw new Error("request_id must contain 1–80 letters, digits, underscores or hyphens.");
  if (hasCase(project, options.id)) return false;
  if (pendingCase(project)) throw new Error("Finish or retry the case already importing before adding another.");
  if (!project.script || !project.clips.length) throw new Error("Import and lay out the original script first.");
  if (![options.at, options.number].every(Number.isSafeInteger) || options.number < 1) throw new Error("at and case_number must be whole numbers (at is timeline frames).");
  boundary(project, options.at);
  let before = options.before ?? project.script.blocks.findIndex((block) => {
    const clip = block.clip ? clipOf(project, block.clip) : undefined;
    return clip && clip.start >= options.at;
  });
  if (before === -1) before = project.script.blocks.length;
  if (!Number.isSafeInteger(before) || before < 0 || before > project.script.blocks.length) throw new Error("before_block is outside the existing script (zero-based).");
  const blocks = structuredClone(parsed.blocks);
  if (!blocks.some((block) => block.kind === "footage")) throw new Error("The case has no footage ranges.");
  if (options.intro?.trim()) blocks.unshift({ kind: "narration", text: options.intro.trim() });
  for (const block of blocks) {
    delete block.clip;
    if (block.kind === "narration") delete block.voiceover;
    else { delete block.media; delete block.media_start; }
    block.notes = [...(block.notes ?? []), tag(options.id), `Compilation case ${options.number}: ${options.title ?? parsed.title}`];
  }
  const anchor = project.clips.find((clip) => clip.start === options.at && (clip.type === "video" || clip.type === "solid"))?.id;
  const receipt: Insertion = { id: options.id, at: options.at, before, count: blocks.length, number: options.number, title: options.title ?? parsed.title, ...(anchor ? { anchor } : {}) };
  blocks[0]!.notes!.push(PENDING + JSON.stringify(receipt));
  project.script.blocks.push(...blocks);
  return true;
}

/** Called in the same atomic save as layOut, before anyone sees the tail. */
export function finishCase(project: Project, previousClips: Set<string>): void {
  const receipt = pendingCase(project);
  if (!receipt || !project.script) return;
  const first = project.script.blocks.findIndex((block) => block.notes?.includes(tag(receipt.id)));
  const added = project.script.blocks.slice(first);
  if (first < 0 || added.length !== receipt.count || added.some((block) => !block.notes?.includes(tag(receipt.id))) || receipt.before > first) throw new Error("The script changed while the case was importing; retry after restoring its insertion boundary.");
  if (added.some((block) => !block.clip || !clipOf(project, block.clip))) throw new Error("Some of the new case's footage is not ready; retry its import.");
  const created = project.clips.filter((clip) => !previousClips.has(clip.id));
  if (!created.length) throw new Error("The new case has no timeline clips to insert.");
  const from = Math.min(...created.map((clip) => clip.start));
  const end = Math.max(...created.map(clipEnd));
  const at = receipt.anchor ? clipOf(project, receipt.anchor)?.start : receipt.at;
  if (at === undefined) throw new Error("The case insertion anchor was deleted while importing; restore it before retrying.");
  project.clips = project.clips.filter((clip) => previousClips.has(clip.id));
  boundary(project, at);
  const segments = structuredClone(project.segments ?? []);
  insertTime(project, at, end - from, new Set(), new Set());
  const length = end - from;
  project.segments = segments.flatMap((segment) => {
    if (segment.end <= at) return [segment];
    if (segment.start >= at) return [{ ...segment, start: segment.start + length, end: segment.end + length }];
    return [{ ...segment, end: at }, { ...segment, start: at + length, end: segment.end + length }];
  });
  for (const clip of created) clip.start += at - from;
  project.clips.push(...created);
  (project.markers ??= []).push({ frame: at, name: `Case ${receipt.number} · ${receipt.title}`, note: tag(receipt.id) });
  // Preserve an existing segment map, adding the new case's footage and
  // cut-ins so subtitle/watch work includes it without touching old spans.
  if (project.segments.length) for (const block of added) {
    const clip = block.clip ? clipOf(project, block.clip) : undefined;
    if (clip) project.segments.push({ start: clip.start, end: clipEnd(clip), kind: block.kind === "footage" ? "footage" : "narration", note: tag(receipt.id) });
  }
  project.segments.sort((a, b) => a.start - b.start);
  for (const block of added) block.notes = block.notes?.filter((note) => !note.startsWith(PENDING));
  project.script.blocks.splice(first);
  project.script.blocks.splice(receipt.before, 0, ...added);
}

export function caseNarration(project: Project, id: string): Extract<ScriptBlock, { kind: "narration" }>[] {
  return (project.script?.blocks ?? []).filter((block): block is Extract<ScriptBlock, { kind: "narration" }> =>
    block.kind === "narration" && (block.notes ?? []).includes(tag(id)) && (!block.voiceover || !clipOf(project, block.voiceover)));
}
