// Script mode's scripts on disk: `<home>/writer/scripts/<id>/script.json`
// beside the script's own files (footage, the preview, transcripts, research,
// versions, chat), the same body and layout Writer kept, so its cloud copies
// and this Mac's old Writer folder both read here as they are.

import * as fs from "node:fs";

import type { Script, Summary } from "@edit/types/writer";

import { writeAtomic } from "../files.ts";
import { join } from "../paths.ts";
import { isCutIn } from "./blocks.ts";
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
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, "script.json"), JSON.stringify(body(hooks.withSharedKeys(dir, script)), null, 2));
}

export function summary(script: Script): Summary {
  const cutIns = script.clips.filter(isCutIn).length;
  return {
    id: script.id,
    title: script.title,
    status: script.status,
    stage: script.stage,
    progress: script.progress,
    error: script.error,
    durationMs: script.durationMs,
    updatedAt: script.updatedAt,
    wordCount: script.words.length,
    clipCount: script.clips.length - cutIns,
    cutInCount: cutIns,
    building: false,
    sourceKind: script.sourceKind,
    ...(script.decision ? { decision: script.decision } : {}),
    draftWords: script.commentary?.draft ? draftWords(script.commentary.draft) : 0,
    compilation: script.compilation ?? false,
    ...(script.docExport ? { docExportedAt: script.docExport.exportedAt } : {}),
    docBehind: script.docExport !== undefined && script.docExport.revision < script.revision,
    createdAt: script.createdAt,
    kind: script.kind ?? "interrogation",
    ...(script.createdBy ? { createdBy: script.createdBy } : {}),
  };
}

/** Every script here, newest change first; footage a commentary was written from carries that commentary's title. */
export function list(data: string, archived: (id: string) => Summary["archive"] | undefined = () => undefined): Summary[] {
  const root = scriptsRoot(data);
  fs.mkdirSync(root, { recursive: true });
  const rows: Summary[] = [];
  const usedBy = new Map<string, string>();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let script: Script;
    try {
      script = read(join(root, entry.name));
    } catch {
      continue;
    }
    for (const source of script.commentary?.sources ?? []) {
      const id = source.origin.startsWith("writer:") ? source.origin.slice("writer:".length) : null;
      if (id !== null && !usedBy.has(id)) usedBy.set(id, script.title);
    }
    const row = summary(script);
    const archive = archived(script.id);
    if (archive) row.archive = archive;
    rows.push(row);
  }
  for (const row of rows) {
    const title = usedBy.get(row.id);
    if (title !== undefined) row.inCommentary = title;
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Every script's id here. */
export function ids(data: string): string[] {
  try {
    return fs.readdirSync(scriptsRoot(data), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() && idOk(entry.name) ? [entry.name] : []));
  } catch {
    return [];
  }
}

/** An import that died with the server is not still running. */
export function markInterrupted(data: string): void {
  for (const id of ids(data)) {
    const dir = join(scriptsRoot(data), id);
    let script: Script;
    try {
      script = read(dir);
    } catch {
      continue;
    }
    if (script.status !== "processing") continue;
    script.status = "error";
    script.error = "The import stopped when Edit closed. Retry: what finished is kept.";
    script.updatedAt = Date.now();
    write(dir, script);
  }
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
