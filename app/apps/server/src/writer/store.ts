// Script mode's scripts on disk: `<home>/writer/scripts/<id>/script.json`
// beside the script's own files (footage, the preview, transcripts, research,
// versions, chat), the same body and layout Writer kept, so its cloud copies
// and this Mac's old Writer folder both read here as they are.

import * as fs from "node:fs";

import type { Script, Summary } from "@edit/types/writer";

import * as diag from "../diag.ts";
import { writeAtomic } from "../files.ts";
import { join } from "../paths.ts";
import { BUILD } from "../version.ts";
import { isCutIn } from "./blocks.ts";
import * as chat from "./chat.ts";
import { draftWords } from "./paragraphs.ts";
import { partLinks } from "./parts.ts";

/** Script mode's data folder in Edit's home. */
export const dataDir = (home: string): string => join(home, "writer");

export const scriptsRoot = (data: string): string => join(data, "scripts");

/** A script id is Writer's UUID (hex and hyphens). */
export function idOk(id: string): boolean {
  return id.length > 0 && id.length <= 80 && /^[0-9a-fA-F-]+$/.test(id);
}

export function scriptDir(data: string, id: string): string {
  if (!idOk(id)) throw new Error("Unknown script.");
  return join(scriptsRoot(data), id);
}

export const proxyPath = (dir: string): string => join(dir, "proxy.mp4");

/** Goes up whenever a script arrives, goes or changes other than through the open page, so the library follows. */
let library = 0;
export const libraryVersion = (): number => library;
export function libraryChanged(): void {
  library++;
}

/** The shared keys a save keeps (the cloud's, set when it starts). */
export const hooks = {
  withSharedKeys: (_dir: string, script: Script): Script => script,
  /** A script saved on this Mac (not a cloud pull): its edit follows (script_sync.ts). */
  written: (_script: Script): void => {},
  /** Throws when another computer holds the script's cloud lock (locks.ts: 423, saying who). */
  mayWrite: (_id: string): void => {},
};

export function read(dir: string): Script {
  let text: string;
  try {
    text = fs.readFileSync(join(dir, "script.json"), "utf8");
  } catch {
    throw new Error("That script is missing.");
  }
  let script: Script;
  try {
    script = JSON.parse(text) as Script;
  } catch {
    throw new Error("That script could not be read.");
  }
  script.words ??= [];
  script.clips ??= [];
  script.overview ??= [];
  // A script joined before its recordings kept their links gets them from the import's own list.
  const parts = script.parts ?? [];
  if (parts.some((part) => part.url === undefined)) {
    const links = partLinks(dir, script);
    if (links !== null) parts.forEach((part, index) => (part.url ??= links[index]));
  }
  return script;
}

/** The body as saved: no `proxyPath`, `archive` or `speakerCheck` (they're this Mac's, worked out on reading). */
export function body(script: Script): Script {
  const { proxyPath: _proxy, archive: _archive, speakerCheck: _check, ...rest } = script as Script & { archive?: unknown; speakerCheck?: unknown };
  return rest as Script;
}

export function write(dir: string, script: Script): void {
  hooks.mayWrite(script.id);
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, "script.json"), JSON.stringify(body(hooks.withSharedKeys(dir, script)), null, 2));
  hooks.written(script);
}

/**
 * Claude's last run on a script, when it ended without finishing: the chat's
 * last answer marked failed ("Claude stopped: …"). Read from the chat, which
 * syncs, so a run that failed on another Mac shows here too (the user, Oct 30:
 * "projects that have failed like this deserve a needs you").
 */
export function runFailed(dir: string): { at: number; error: string } | null {
  const last = chat.read(dir).findLast((turn) => turn.role === "editor");
  return last?.failed === true ? { at: last.at, error: last.text } : null;
}

/**
 * A file still being made (a download, an encode): never synced, and never
 * left to the cloud. A preview piece is encoded as "<name>.partial.mp4"
 * (imports.ts encodePiece), which the old ".partial" test missed: Nov 1, a
 * 498 MB half-encoded piece of an 83-minute recording went up with its script.
 */
export const inTheMaking = (name: string): boolean => name.startsWith(".") || /\.(tmp|partial)$/iu.test(name) || /\.partial\.[^./]+$/iu.test(name);

/** A script's row in the lists; with its folder, also whether Claude's last run on it failed. */
export function summary(script: Script, dir?: string): Summary {
  const cutIns = script.clips.filter(isCutIn).length;
  const failed = dir === undefined ? null : runFailed(dir);
  return {
    id: script.id,
    title: script.title,
    status: script.status,
    stage: script.stage,
    progress: script.progress,
    // Kept short: the cloud refuses a summary over 64 KB, and one long error kept a script out of it (diag.gist).
    error: script.error !== null && script.error.length > 2000 ? diag.gist(script.error, 2000) : script.error,
    durationMs: script.durationMs,
    updatedAt: script.updatedAt,
    wordCount: script.words.length,
    clipCount: script.clips.length - cutIns,
    cutInCount: cutIns,
    building: false,
    sourceKind: script.sourceKind,
    ...(script.decision ? { decision: script.decision } : {}),
    ...(script.dismissedAt ? { dismissedAt: script.dismissedAt } : {}),
    ...(script.firstBuild ? { firstBuild: true } : {}),
    ...(script.status === "error" && script.stuckOn === BUILD ? { retryHelps: false as const } : {}),
    draftWords: script.commentary?.draft ? draftWords(script.commentary.draft) : 0,
    compilation: script.compilation ?? false,
    // Said either way once the folder's read (null: its last run finished), so the cloud's row shows it was looked at.
    ...(dir === undefined ? {} : { runFailed: failed }),
    ...(script.docExport ? { docExportedAt: script.docExport.exportedAt } : {}),
    docBehind: script.docExport !== undefined && script.docExport.revision < script.revision,
    createdAt: script.createdAt,
    kind: script.kind ?? "interrogation",
    ...(script.createdBy ? { createdBy: script.createdBy } : {}),
    ...(() => {
      const note = dir === undefined ? "" : readNote(dir);
      return note === "" ? {} : { note };
    })(),
  };
}

/**
 * A note left on a script from Home's ⋯ (JJ, Nov 8: "to make it easier for one
 * to write a note to self when we're at scale"). Its own file, not a field of
 * script.json: an import or a build writes the script it holds back whole, and
 * would take a note left meanwhile away. It syncs as the script's other files do.
 */
export const NOTE_FILE = "note.json";
export const NOTE_LIMIT = 500;

export function readNote(dir: string): string {
  try {
    const kept = JSON.parse(fs.readFileSync(join(dir, NOTE_FILE), "utf8")) as { note?: unknown };
    return typeof kept.note === "string" ? kept.note : "";
  } catch {
    return "";
  }
}

/** Sets (or, empty, clears) the note; kept as an empty note rather than deleted, so the clearing syncs too. */
export function writeNote(dir: string, note: string): string {
  const given = note.replace(/\p{Cc}+/gu, " ").trim();
  if ([...given].length > NOTE_LIMIT) throw new Error(`Keep a note to ${NOTE_LIMIT} characters.`);
  if (!fs.existsSync(join(dir, "script.json"))) throw new Error("That script isn't on this computer.");
  if (given === "" && !fs.existsSync(join(dir, NOTE_FILE))) return given;
  writeAtomic(join(dir, NOTE_FILE), JSON.stringify({ note: given, at: Date.now() }));
  libraryChanged();
  return given;
}

/** Every script here, newest change first; footage a commentary was written from carries that commentary's title. */
/**
 * A script's row and the scripts its commentary uses, read again only when
 * its script.json or chat.json has changed (inode, size, mtime in ns). Every
 * list parsed every script (Nov 7, Sphe's Mac: 89 scripts, 217 MB of JSON),
 * and Home asks for it every few seconds (the scripts and the handoff): with
 * Edit's other state it held the server 7–20 s at a time.
 */
const listedCache = new Map<string, { stamp: string; row: Summary; title: string; sources: string[] }>();

function stampOf(path: string): string {
  try {
    const stats = fs.statSync(path, { bigint: true });
    return `${stats.ino}:${stats.size}:${stats.mtimeNs}`;
  } catch {
    return "none";
  }
}

function listedIn(dir: string): { row: Summary; title: string; sources: string[] } | null {
  const stamp = `${stampOf(join(dir, "script.json"))}|${stampOf(join(dir, "chat.json"))}|${stampOf(join(dir, NOTE_FILE))}`;
  const had = listedCache.get(dir);
  if (had !== undefined && had.stamp === stamp) return had;
  let script: Script;
  try {
    script = read(dir);
  } catch {
    listedCache.delete(dir);
    return null;
  }
  const sources = (script.commentary?.sources ?? []).flatMap((source) => (source.origin.startsWith("writer:") ? [source.origin.slice("writer:".length)] : []));
  const kept = { stamp, row: summary(script, dir), title: script.title, sources };
  listedCache.set(dir, kept);
  return kept;
}

export function list(data: string, archived: (id: string) => Summary["archive"] | undefined = () => undefined): Summary[] {
  const root = scriptsRoot(data);
  fs.mkdirSync(root, { recursive: true });
  const rows: Summary[] = [];
  const usedBy = new Map<string, string>();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const listed = listedIn(dir);
    if (listed === null) continue;
    for (const id of listed.sources) if (!usedBy.has(id)) usedBy.set(id, listed.title);
    // A copy: callers add to their rows.
    const row = { ...listed.row };
    const archive = archived(row.id);
    if (archive) row.archive = archive;
    rows.push(row);
  }
  for (const row of rows) {
    const title = usedBy.get(row.id);
    if (title !== undefined) row.inCommentary = title;
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The files scripts here play from (their originals), wherever they are. */
export function originals(data: string): Set<string> {
  const out = new Set<string>();
  for (const id of ids(data)) {
    try {
      const script = read(scriptDir(data, id));
      if (script.originalPath) out.add(script.originalPath);
    } catch {
      // Not a script any more.
    }
  }
  return out;
}

/** Every script's id here. */
export function ids(data: string): string[] {
  try {
    return fs.readdirSync(scriptsRoot(data), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() && idOk(entry.name) ? [entry.name] : []));
  } catch {
    return [];
  }
}

/**
 * The imports that died with the server (still importing on disk): their ids,
 * each carried on by itself (index.ts `carryOn`). They stay importing
 * meanwhile, where they said "The import stopped when Edit closed. Retry…"
 * for the seconds until they were started again (Nov 10: updates go through
 * mid-import).
 */
export function markInterrupted(data: string): string[] {
  const cut: string[] = [];
  for (const id of ids(data)) {
    try {
      if (read(join(scriptsRoot(data), id)).status === "processing") cut.push(id);
    } catch {
      continue;
    }
  }
  return cut;
}

export const STOPPED_WHEN_CLOSED = "The import stopped when Edit closed. Retry: what finished is kept.";

/** An import a restart cut off that didn't carry on: stopped, for Retry, as before (none running on it here). */
export function markStopped(data: string, id: string, why = STOPPED_WHEN_CLOSED): void {
  const dir = join(scriptsRoot(data), id);
  let script: Script;
  try {
    script = read(dir);
  } catch {
    return;
  }
  if (script.status !== "processing") return;
  script.status = "error";
  script.error = why;
  script.updatedAt = Date.now();
  write(dir, script);
}

export function remove(data: string, id: string): void {
  fs.rmSync(scriptDir(data, id), { recursive: true, force: true });
}

/** Saves a change to a script read fresh from disk: `change` edits it; the revision goes up unless `keepRevision`. */
export function update(dir: string, change: (script: Script) => void, keepRevision = false): Script {
  const script = read(dir);
  change(script);
  if (!keepRevision) script.revision++;
  script.updatedAt = Date.now();
  write(dir, script);
  return script;
}

/**
 * Brings this Mac's Writer scripts in the first time Script mode starts: its
 * folder is copied (APFS clones, so no space is taken until either copy
 * changes), never moved, so Writer still opens them while both are in use.
 */
export function adoptWriterFolder(data: string, writerFolder: string): number {
  const root = scriptsRoot(data);
  const from = join(writerFolder, "scripts");
  if (fs.existsSync(root) || !fs.existsSync(from)) return 0;
  fs.mkdirSync(data, { recursive: true });
  const staging = `${root}.adopting`;
  fs.rmSync(staging, { recursive: true, force: true });
  const copied = Bun.spawnSync(["cp", "-cR", from, staging], { stdout: "ignore", stderr: "pipe" });
  if (copied.exitCode !== 0) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`couldn't copy Writer's scripts: ${copied.stderr.toString().trim()}`);
  }
  for (const file of ["lessons.json"]) {
    const path = join(writerFolder, file);
    if (fs.existsSync(path)) fs.copyFileSync(path, join(data, file));
  }
  fs.renameSync(staging, root);
  return ids(data).length;
}
