// A script's footage and words, shared with Edit mode: one footage registry
// and one transcript per recording, so a recording is downloaded and heard
// once for both modes. Each recording goes to Edit's R2 originals and Convex
// registry under the source Edit names it by (`drive:<id>`, `youtube:<id>`,
// `sha256:<hex>` for a file from disk), and its words, as the script has
// them (the voices the watcher and naming settled), to
// `edit/analysis/<source>/transcript.json` in Edit's format (cloud_media.ts
// has the layout). `edit-shared.json` beside the script lists what's there,
// so the script's own sync leaves those files to the registry.

import * as fs from "node:fs";
import { createHash } from "node:crypto";

import type { Script } from "@edit/types/writer";

import * as editCloud from "../cloud.ts";
import * as diag from "../diag.ts";
import * as log from "../hearing_log.ts";
import * as sharedWords from "../shared_words.ts";
import { writeAtomic } from "../files.ts";
import { isFile, join } from "../paths.ts";
import { hearsAll, MODEL as SCRIBE, serialize, type Transcript } from "../transcribe.ts";
import * as drive from "./drive.ts";
import * as hearing from "./hearing.ts";
import { named } from "./jobs.ts";
import * as media from "./media.ts";
import { partSources, partTargets } from "./parts.ts";
import * as store from "./store.ts";
import * as captions from "./captions.ts";
import { appleCached, editCached, recordings, roughOnly } from "./transcription.ts";
import { THIS_MACHINE } from "../machine.ts";

/** A source's place in Edit's keys: `drive/<id>`, `youtube/<id>`, `sha256/<hex>`. */
const sourcePath = (source: string): string => source.replace(":", "/");

/** A file name as Edit keeps it in a key: no slashes or control characters, at most 120 characters (a long one keeps its extension). */
export function segment(name: string): string {
  const cleaned = [...name.replace(/[/\\:\0]/g, "_").replace(/^\.+/, "")].filter((c) => !/\p{Cc}/u.test(c)).join("").trim() || "footage.mp4";
  if ([...cleaned].length <= 120) return cleaned;
  const ext = cleaned.includes(".") && cleaned.split(".").pop()!.length < 10 ? `.${cleaned.split(".").pop()}` : "";
  return `${[...cleaned].slice(0, 110).join("").trim()}${ext}`;
}

export const originalKey = (source: string, name: string): string => `edit/originals/${sourcePath(source)}/${segment(name)}`;
export const transcriptKey = (source: string): string => `edit/analysis/${sourcePath(source)}/transcript.json`;
/** Where a recording's analysis is (shared_words.ts names its words there). */
export const analysisOf = (source: string): string => `edit/analysis/${sourcePath(source)}/`;

/** A file from disk, named by its content as Edit names it. */
export async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** One recording to share: its own file, its source and name, where it sits on the script's clock, its voices' mark ("2:" in a joined case) and its hearing's key. */
export interface Shared {
  /** Null: streamed to Edit's originals when imported (writer/streamed.ts), never on this Mac. */
  file: string | null;
  source: string;
  name: string;
  offsetMs: number;
  lengthMs: number;
  tag: string | null;
  key: string;
}

/** The script's recordings that have their own file and a source. */
async function shared(dir: string, script: Script): Promise<Shared[]> {
  const all = recordings(dir, script);
  const sources = partSources(dir, script);
  const streamed = streamedSources(dir);
  const out: Shared[] = [];
  for (const [index, recording] of all.entries()) {
    let found = sources[index] ?? null;
    // Streamed to the cloud when imported: heard from the preview, its footage already in Edit's originals.
    if (found !== null && streamed.has(found[0]) && (recording.file === store.proxyPath(dir) || recording.span !== null || !isFile(recording.file))) {
      out.push({ file: null, source: found[0], name: found[1], offsetMs: recording.offsetMs, lengthMs: recording.lengthMs, tag: all.length > 1 ? String(index + 1) : null, key: recording.key });
      continue;
    }
    if (recording.span !== null || !isFile(recording.file)) continue;
    if (found === null && (script.sourceKind === "file" || folderPart(script, index))) found = [`sha256:${await sha256Of(recording.file)}`, recording.file.split("/").pop() ?? "footage.mp4"];
    if (found === null) continue;
    out.push({ file: recording.file, source: found[0], name: found[1], offsetMs: recording.offsetMs, lengthMs: recording.lengthMs, tag: all.length > 1 ? String(index + 1) : null, key: recording.key });
  }
  return out;
}

/**
 * A recording's words in Edit's format: as the script has them, with the
 * voices settled and named, unless a hearing made after them says otherwise.
 * A recording whose words are rough (captions or Apple's) gives them all,
 * Scribe's over the stretches heard exactly (exact.ts, `Script.exact`) and
 * `heard` saying which; voices only there. Edit's agent cuts on the rough
 * words and Scribe hears only what it keeps (kept_hearing.ts).
 */
export function transcriptOf(dir: string, script: Script, recording: Shared): Transcript {
  const work = join(dir, "transcript", recording.key);
  const whole = hearing.cached(work);
  const rough = roughOnly(work);
  // A voice marked with its recording ("2:speaker_0") is that recording's; one with no mark is the script's own
  // person ("p1" from the turns pass, which reads every recording at once), the same in each recording it speaks in.
  // Taking only marked ones dropped every name of a script's first recording once a linked video made it one of two.
  const strip = (speaker: string): string | null =>
    recording.tag === null ? speaker : speaker.startsWith(`${recording.tag}:`) ? speaker.slice(recording.tag.length + 1) : speaker.includes(":") ? null : speaker;
  const end = recording.offsetMs + recording.lengthMs;
  const exact = (script.exact ?? []).flatMap(([from, to]): [number, number][] => (to <= recording.offsetMs || from >= end ? [] : [[Math.max(from, recording.offsetMs), Math.min(to, end)]]));
  const words = script.words
    .filter((word) => word.startMs >= recording.offsetMs && word.startMs < end)
    .map((word) => {
      // Rough words have no voices Edit keeps: who speaks there waits for Scribe (kept_hearing.ts).
      const heardHere = !rough || exact.some(([from, to]) => (word.startMs + word.endMs) / 2 >= from && (word.startMs + word.endMs) / 2 < to);
      const speaker = word.speaker == null || !heardHere ? null : strip(word.speaker);
      return { text: word.text, start: (word.startMs - recording.offsetMs) / 1000, end: Math.max(word.endMs - recording.offsetMs, 0) / 1000, ...(speaker !== null ? { speaker } : {}) };
    });
  const derived = whole !== null && whole.words.length === words.length && whole.words.every((word, at) => word.text === words[at]!.text);
  if (whole !== null && whole.words.length > 0 && !derived) return whole;
  // The names of the voices that speak here.
  const here = new Set(words.flatMap((word) => (word.speaker === undefined ? [] : [word.speaker])));
  const speakers = Object.fromEntries(Object.entries(script.speakers ?? {}).flatMap(([label, name]) => { const id = strip(label); return id === null || (recording.tag !== null && !here.has(id)) ? [] : [[id, name]]; }));
  if (rough) {
    const heard = exact.map(([from, to]): [number, number] => [(from - recording.offsetMs) / 1000, (to - recording.offsetMs) / 1000]);
    const keyterms = heard.length > 0 ? (script.exactKeyterms ?? []) : [];
    const first = captions.cached(work)?.model ?? appleCached(work)?.model ?? editCached(work)?.rough ?? "youtube-captions";
    const model = heard.length > 0 ? SCRIBE : first;
    return { model, language: null, words, speakers, ...(keyterms.length > 0 ? { keyterms } : {}), heard, rough: first };
  }
  return { model: whole?.model || SCRIBE, language: whole?.language ?? null, words, speakers, ...(whole?.keyterms ? { keyterms: whole.keyterms } : {}) };
}

/** The parts of a script `folderPart` reads: Script mode's own, or Writer's as the handoff has it. */
type Cases = { sourceKind?: string; parts?: { url?: string; mediaSource?: string }[] };

/** A compilation's case that is a Drive folder: its recordings joined into one master, its link the folder's (never a file Edit can fetch). */
export function folderPart(script: Cases, index: number): boolean {
  const url = script.parts?.[index]?.url ?? "";
  return script.sourceKind === "compilation" && drive.isDrive(url) && drive.parse(url).kind === "folder";
}

/** Whether a folder case doesn't yet name its master in Edit's originals, so Start the edit can't find its footage. */
export const unsharedFolder = (script: Cases): boolean =>
  (script.parts ?? []).some((part, index) => part.mediaSource === undefined && folderPart(script, index));

/**
 * The script with each Drive folder case naming its master as Edit's
 * originals have it (`mediaSource`, `originalKey`, from `edit-shared.json`),
 * which Start the edit reads on any Mac (writer_handoff.recordingFiles).
 * Every save applies it (store.hooks.withSharedKeys). Nothing wrote them
 * before Nov 4, so a compilation with a folder case couldn't start its edit
 * ("751) Predator Teacher Gets the Surprise of His Life" has no Drive or
 * YouTube link).
 */
export function withSharedKeys(dir: string, script: Script): Script {
  if (!unsharedFolder(script)) return script;
  let kept: { source?: unknown; key?: unknown; file?: unknown }[];
  try {
    kept = JSON.parse(fs.readFileSync(join(dir, "edit-shared.json"), "utf8")) as typeof kept;
  } catch {
    return script;
  }
  const targets = partTargets(dir, script);
  let changed = false;
  const parts = (script.parts ?? []).map((part, index) => {
    const target = targets[index];
    if (part.mediaSource !== undefined || !folderPart(script, index) || target == null || !target.startsWith(`${dir}/`)) return part;
    // Only a master the handoff takes: a sha256 source and its own key under Edit's originals.
    const entry = kept.find((one) => one.file === target.slice(dir.length + 1) && typeof one.source === "string" && /^sha256:[a-fA-F0-9]{64}$/u.test(one.source) && typeof one.key === "string" && one.key.startsWith(`edit/originals/sha256/${one.source.slice(7)}/`) && !one.key.includes(".."));
    if (entry === undefined) return part;
    changed = true;
    return { ...part, mediaSource: entry.source as string, originalKey: entry.key as string };
  });
  return changed ? { ...script, parts } : script;
}

/** Saves the script once if a folder case can name its master now; true if it did. */
export function stampShared(dir: string): boolean {
  const script = store.read(dir);
  const stamped = withSharedKeys(dir, script);
  if (stamped === script) return false;
  store.write(dir, stamped);
  return true;
}

/** The sources streamed to Edit's originals when imported: in `edit-shared.json` with no file here. */
function streamedSources(dir: string): Set<string> {
  try {
    const kept = JSON.parse(fs.readFileSync(join(dir, "edit-shared.json"), "utf8")) as { source: string; file: string | null }[];
    return new Set(kept.filter((entry) => entry.file === null).map((entry) => entry.source));
  } catch {
    return new Set();
  }
}

/** What of the script is in Edit's originals: its file (by its path in the script's folder; null for one streamed there, never here), source and key. */
export function keepShared(dir: string, file: string | null, source: string, key: string): void {
  const path = join(dir, "edit-shared.json");
  let kept: { source: string; key: string; file: string | null }[] = [];
  try {
    kept = JSON.parse(fs.readFileSync(path, "utf8")) as typeof kept;
  } catch {
    kept = [];
  }
  const relative = file !== null && file.startsWith(`${dir}/`) ? file.slice(dir.length + 1) : null;
  writeAtomic(path, JSON.stringify([...kept.filter((entry) => entry.source !== source), { source, key, file: relative }], null, 2));
}

/**
 * Puts the script's recordings and their words where Edit mode finds them:
 * each original uploaded and registered unless the registry has it ready,
 * each transcript unless one is there. Answers what it did.
 */
export async function share(data: string, id: string): Promise<string> {
  if (!editCloud.enabled()) return "Sign in to share footage with Edit.";
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  const list = await shared(dir, script);
  const done: string[] = [];
  const name = named(id, script.title);
  for (const recording of list) {
    if (recording.file === null) {
      await shareWords(dir, script, recording, done);
      continue;
    }
    const size = fs.statSync(recording.file).size;
    const duration = await media.streams(recording.file).then((found) => found.durationMs / 1000, () => null);
    let record = (await editCloud.query("edit:getMedia", { source: recording.source })) as Record<string, unknown> | null;
    if (record?.originalReady !== true) {
      const key = typeof record?.originalKey === "string" ? record.originalKey : originalKey(recording.source, recording.name);
      if (record === null) await editCloud.mutation("edit:putMedia", { source: recording.source, name: recording.name, originalKey: key, size });
      diag.info("writer", `${name}: uploading ${recording.name} (${recording.source}, ${Math.round(size / 1e6)} MB) to Edit's originals`);
      await editCloud.uploadFile(recording.file, key);
      record = (await editCloud.mutation("edit:putMedia", { source: recording.source, originalReady: true, size, ...(duration !== null ? { duration } : {}) })) as Record<string, unknown> | null;
      done.push(`uploaded ${recording.name}`);
    }
    keepShared(dir, recording.file, recording.source, typeof record?.originalKey === "string" ? record.originalKey : originalKey(recording.source, recording.name));
    await shareWords(dir, script, recording, done);
  }
  // Words go even for a recording whose footage isn't on this Mac (cleared, or streamed): they need only its source.
  const listed = new Set(list.map((recording) => recording.source));
  for (const recording of wordRecordings(dir, script)) if (!listed.has(recording.source)) await shareWords(dir, script, recording, done);
  if (done.length > 0) diag.info("writer", `${name}: shared with Edit: ${done.join("; ")}`);
  // A folder case's master named in the script itself, so it syncs and every Mac's Start the edit finds it.
  if (stampShared(dir)) diag.info("writer", `${name}: its Drive folder cases name their masters in Edit's originals`);
  return list.length === 0 && done.length === 0 ? `no footage on ${THIS_MACHINE} to share` : done.length === 0 ? "Edit has every recording and transcript already." : done.join("; ");
}

/**
 * A recording's words to Edit's analysis, where the script has them: heard
 * whole, or rough with the stretches heard exactly since, `heard` naming
 * them (Edit hears what it keeps before subtitles or the watch read it). A
 * whole hearing there stays; rough words shared before are replaced when
 * more was heard.
 */
async function shareWords(dir: string, script: Script, recording: Shared, done: string[]): Promise<void> {
  if (script.words.length === 0) return;
  const prefix = analysisOf(recording.source);
  const words = transcriptOf(dir, script, recording);
  // A whole hearing there is never replaced; one that heard as much as these words, or more, stays.
  const there = await sharedWords.read(prefix, dir);
  if (there !== null && (sharedWords.isWhole(there) || (words.heard !== undefined && hearsAll(there, words.heard)))) return;
  await sharedWords.write(prefix, words, serialize(words));
  const heardS = (words.heard ?? []).reduce((sum, [from, to]) => sum + to - from, 0);
  log.line(
    words.heard === undefined
      ? `${recording.source}: Script mode's words to Edit, ${log.said(words.model)} for all of it (${log.count(words.words.length)} words)`
      : `${recording.source}: Script mode's words to Edit, ${log.said(SCRIBE)} over ${words.heard.length} stretches (${log.clock(heardS)} of ${log.clock(recording.lengthMs / 1000)}), ${log.said(words.rough)} the rest (${log.count(words.words.length)} words)`,
  );
  done.push(words.heard === undefined ? `shared the words of ${recording.name}` : `shared the words of ${recording.name}'s chosen stretches`);
}

/**
 * Only the script's words to Edit's analysis, before Start the edit makes the
 * edit (writer_handoff.ts): its excerpts then take them, and Scribe hears
 * only what the edit keeps beyond what Script mode paid for. The footage's
 * own share runs on its own (`shareSoon`). Answers what it did.
 */
export async function shareWordsNow(data: string, id: string): Promise<string[]> {
  if (!editCloud.enabled()) return [];
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  const done: string[] = [];
  for (const recording of wordRecordings(dir, script)) await shareWords(dir, script, recording, done);
  return done;
}

/** The script's recordings by their sources, for their words: the footage needn't be on this Mac (cleared, or streamed). */
function wordRecordings(dir: string, script: Script): Shared[] {
  const all = recordings(dir, script);
  const sources = partSources(dir, script);
  let kept: { source?: unknown; file?: unknown }[] = [];
  try {
    kept = JSON.parse(fs.readFileSync(join(dir, "edit-shared.json"), "utf8")) as typeof kept;
  } catch {
    kept = [];
  }
  return all.flatMap((recording, index): Shared[] => {
    const relative = recording.file.startsWith(`${dir}/`) ? recording.file.slice(dir.length + 1) : null;
    const source = sources[index]?.[0] ?? kept.find((entry) => entry.file === relative && typeof entry.source === "string")?.source;
    if (typeof source !== "string") return [];
    return [{ file: null, source, name: sources[index]?.[1] ?? source, offsetMs: recording.offsetMs, lengthMs: recording.lengthMs, tag: all.length > 1 ? String(index + 1) : null, key: recording.key }];
  });
}

const sharing = new Map<string, Promise<string>>();

/** Shares the script with Edit, once at a time: a share under way is joined, not started twice. */
export function shareNow(data: string, id: string): Promise<string> {
  const running = sharing.get(id);
  if (running !== undefined) return running;
  const run = share(data, id).finally(() => sharing.delete(id));
  sharing.set(id, run);
  return run;
}

/** Shares the script with Edit in the background; a failure is kept for the next try. */
export function shareSoon(data: string, id: string): void {
  if (sharing.has(id)) return;
  void shareNow(data, id).catch((error: unknown) => {
    try {
      fs.writeFileSync(join(store.scriptDir(data, id), "edit-share-error.txt"), diag.messageOf(error));
    } catch {
      // The script's gone.
    }
  });
}

/** Scripts saved before Nov 4 whose folder cases were shared but never named their masters: named once, at start. */
export function stampAll(data: string): void {
  let ids: string[];
  try {
    ids = store.ids(data);
  } catch {
    return;
  }
  for (const id of ids) {
    try {
      if (stampShared(store.scriptDir(data, id))) diag.info("writer", `${named(id, store.read(store.scriptDir(data, id)).title)}: its Drive folder cases name their masters in Edit's originals`);
    } catch (error) {
      diag.warn("writer", `${id}: its folder cases weren't named: ${diag.messageOf(error)}`);
    }
  }
}
