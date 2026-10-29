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
import { writeAtomic } from "../files.ts";
import { isFile, join } from "../paths.ts";
import { serialize, type Transcript } from "../transcribe.ts";
import * as drive from "./drive.ts";
import * as hearing from "./hearing.ts";
import { named } from "./jobs.ts";
import * as media from "./media.ts";
import { partSources } from "./parts.ts";
import * as store from "./store.ts";
import { recordings } from "./transcription.ts";

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

/** A file from disk, named by its content as Edit names it. */
export async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** One recording to share: its own file, its source and name, where it sits on the script's clock, its voices' mark ("2:" in a joined case) and its hearing's key. */
interface Shared {
  file: string;
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
  const out: Shared[] = [];
  for (const [index, recording] of all.entries()) {
    if (recording.span !== null || !isFile(recording.file)) continue;
    let found = sources[index] ?? null;
    const folderCase = script.sourceKind === "compilation" && drive.isDrive(script.parts?.[index]?.url ?? "") && drive.parse(script.parts![index]!.url!).kind === "folder";
    if (found === null && (script.sourceKind === "file" || folderCase)) found = [`sha256:${await sha256Of(recording.file)}`, recording.file.split("/").pop() ?? "footage.mp4"];
    if (found === null) continue;
    out.push({ file: recording.file, source: found[0], name: found[1], offsetMs: recording.offsetMs, lengthMs: recording.lengthMs, tag: all.length > 1 ? String(index + 1) : null, key: recording.key });
  }
  return out;
}

/** A recording's words in Edit's format: as the script has them, with the voices settled and named, unless a hearing made after them says otherwise. */
function transcriptOf(dir: string, script: Script, recording: Shared): Transcript {
  const heard = hearing.cached(join(dir, "transcript", recording.key));
  const strip = (speaker: string): string | null => (recording.tag === null ? speaker : speaker.startsWith(`${recording.tag}:`) ? speaker.slice(recording.tag.length + 1) : null);
  const end = recording.offsetMs + recording.lengthMs;
  const words = script.words
    .filter((word) => word.startMs >= recording.offsetMs && word.startMs < end)
    .map((word) => {
      const speaker = word.speaker == null ? null : strip(word.speaker);
      return { text: word.text, start: (word.startMs - recording.offsetMs) / 1000, end: Math.max(word.endMs - recording.offsetMs, 0) / 1000, ...(speaker !== null ? { speaker } : {}) };
    });
  const derived = heard !== null && heard.words.length === words.length && heard.words.every((word, at) => word.text === words[at]!.text);
  if (heard !== null && heard.words.length > 0 && !derived) return heard;
  const speakers = Object.fromEntries(Object.entries(script.speakers ?? {}).flatMap(([label, name]) => (strip(label) === null ? [] : [[strip(label)!, name]])));
  return { model: heard?.model || "scribe_v2", language: heard?.language ?? null, words, speakers, ...(heard?.keyterms ? { keyterms: heard.keyterms } : {}) };
}

/** What of the script is in Edit's originals: its file (by its path in the script's folder), source and key. */
function keepShared(dir: string, file: string, source: string, key: string): void {
  const path = join(dir, "edit-shared.json");
  let kept: { source: string; key: string; file: string | null }[] = [];
  try {
    kept = JSON.parse(fs.readFileSync(path, "utf8")) as typeof kept;
  } catch {
    kept = [];
  }
  const relative = file.startsWith(`${dir}/`) ? file.slice(dir.length + 1) : null;
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
    const at = transcriptKey(recording.source);
    // Words only where the script has them, and never for words only YouTube's captions gave (Edit reads the captions itself).
    const captioned = isFile(join(dir, "transcript", recording.key, "captions.json")) && hearing.cached(join(dir, "transcript", recording.key)) === null;
    if (script.words.length > 0 && !captioned && !(await editCloud.has(at))) {
      const text = serialize(transcriptOf(dir, script, recording));
      await editCloud.uploadStream(editCloud.bytesSource(new TextEncoder().encode(text)), at, text.length);
      done.push(`shared the words of ${recording.name}`);
    }
  }
  if (done.length > 0) diag.info("writer", `${name}: shared with Edit: ${done.join("; ")}`);
  return list.length === 0 ? "no footage on this Mac to share" : done.length === 0 ? "Edit has every recording and transcript already." : done.join("; ");
}

const sharing = new Set<string>();

/** Shares the script with Edit in the background, once at a time; a failure is kept for the next try. */
export function shareSoon(data: string, id: string): void {
  if (sharing.has(id)) return;
  sharing.add(id);
  void share(data, id)
    .catch((error: unknown) => {
      try {
        fs.writeFileSync(join(store.scriptDir(data, id), "edit-share-error.txt"), diag.messageOf(error));
      } catch {
        // The script's gone.
      }
    })
    .finally(() => sharing.delete(id));
}
