// A commentary's sources' texts, each in `sources/<id>.txt` beside the script
// (ids are S1, S2…: anything else names no file).

import * as fs from "node:fs";

import { writeAtomic } from "../files.ts";
import { join } from "../paths.ts";

/** One source's text, at most. */
export const MAX_SOURCE_BYTES = 3_000_000;
export const MAX_SOURCES = 40;

const sourcesDir = (dir: string): string => join(dir, "sources");

export function textPath(dir: string, id: string): string {
  return /^[A-Za-z0-9]{1,16}$/.test(id) ? join(sourcesDir(dir), `${id}.txt`) : join(sourcesDir(dir), "invalid-source-id.txt");
}

export function readText(dir: string, id: string): string {
  try {
    return fs.readFileSync(textPath(dir, id), "utf8");
  } catch {
    throw new Error(`Source ${id}'s text is missing. Remove it and add it again.`);
  }
}

/** A source's text replaced (spelling.ts corrects names in it). */
export function writeText(dir: string, id: string, text: string): void {
  if (!fs.existsSync(textPath(dir, id))) throw new Error(`Source ${id}'s text is missing.`);
  writeAtomic(textPath(dir, id), text);
}

/** A new source's text. */
export function putText(dir: string, id: string, text: string): void {
  fs.mkdirSync(sourcesDir(dir), { recursive: true });
  fs.writeFileSync(textPath(dir, id), text);
}

export function removeText(dir: string, id: string): void {
  fs.rmSync(textPath(dir, id), { force: true });
}
