// Files attached to a message in the editor's chat (Sphe, Nov 3: "wow it cant
// see the stuff i send it"). The page uploads each into the project first
// (uploads.ts: media, or one of the project's files) and sends the message
// with what each became. The chat keeps them on the person's entry, so the
// transcript shows them above the message; the model gets every picture as a
// picture (scaled to what it reads), and every file named with how to reach
// it: the name alone, as the first build sent, left it guessing.

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import { isFile, join } from "./paths.ts";

export type AttachedKind = "image" | "video" | "audio" | "file";

export interface Attached {
  /** The name it was attached with. */
  name: string;
  kind: AttachedKind;
  /** The media it became. */
  media?: string;
  /** Kept as one of the project's files (read_upload). */
  file?: string;
}

/** A message carries at most this many. */
const MOST = 20;
const KINDS: AttachedKind[] = ["image", "video", "audio", "file"];

/** The page's list (a JSON string, as the route's fields are), checked; nothing given is none. */
export function readAttached(given: string | null): Attached[] {
  if (given === null || given.trim() === "") return [];
  let value: unknown;
  try {
    value = JSON.parse(given);
  } catch {
    throw new Error("attachments: not JSON");
  }
  if (!Array.isArray(value)) throw new Error("attachments: expected a list");
  if (value.length > MOST) throw new Error(`attachments: at most ${MOST} files with one message`);
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null) throw new Error(`attachments[${index}]: expected a file`);
    const fields = item as Record<string, unknown>;
    if (typeof fields.name !== "string" || fields.name.trim() === "") throw new Error(`attachments[${index}]: missing its name`);
    const kind = KINDS.includes(fields.kind as AttachedKind) ? (fields.kind as AttachedKind) : "file";
    const out: Attached = { name: fields.name.slice(0, 200), kind };
    if (typeof fields.media === "string" && fields.media !== "") out.media = fields.media;
    if (typeof fields.file === "string" && fields.file !== "") out.file = fields.file;
    return out;
  });
}

/** An entry's saved list, read back leniently (a bad one is dropped, never the chat). */
export function savedAttached(value: unknown): Attached[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Attached[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const fields = item as Record<string, unknown>;
    if (typeof fields.name !== "string") continue;
    const one: Attached = { name: fields.name, kind: KINDS.includes(fields.kind as AttachedKind) ? (fields.kind as AttachedKind) : "file" };
    if (typeof fields.media === "string") one.media = fields.media;
    if (typeof fields.file === "string") one.file = fields.file;
    out.push(one);
  }
  return out.length > 0 ? out : undefined;
}

/** What the model reads after the message about them (the chat shows the files, not this). */
export function attachedText(list: Attached[], shown: Set<string>): string {
  if (list.length === 0) return "";
  const lines = list.map((one) => {
    if (one.media !== undefined) {
      const seen = shown.has(one.media) ? ", the picture above" : "";
      return `- "${one.name}": ${one.kind} media ${one.media}${seen} (in the project's media, uploaded just now)`;
    }
    return `- "${one.name}": a file (read_upload name "${one.file ?? one.name}")`;
  });
  return `\n\nThe person attached ${list.length === 1 ? "this file" : "these files"} to the message:\n${lines.join("\n")}`;
}

/** A picture the model is given with the message. */
export interface Picture {
  media: string;
  /** A JPEG this side of the model's size limit, kept for Codex (`localImage`). */
  path: string;
  data: string;
  mime: string;
}

/** Longest side the model is sent: Claude reads up to about this without scaling it down itself. */
const LONGEST = 1568;

/**
 * The attached pictures as JPEGs the model reads (`sips` scales and converts,
 * HEIC and PNG alike), written to `dir`. One that can't be read is left to the
 * words: the agent can still look at its media.
 */
export async function pictures(list: Attached[], media: { id: string; path: string; kind: string }[], dir: string): Promise<Picture[]> {
  const out: Picture[] = [];
  for (const one of list) {
    if (one.kind !== "image" || one.media === undefined) continue;
    const found = media.find((item) => item.id === one.media);
    if (found === undefined || !isFile(found.path)) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const path = join(dir, `${one.media}-${Date.now()}.jpg`);
      const made = Bun.spawn(["/usr/bin/sips", "-Z", String(LONGEST), "-s", "format", "jpeg", "-s", "formatOptions", "85", found.path, "--out", path], { stdout: "ignore", stderr: "pipe" });
      const timer = setTimeout(() => made.kill(), 20_000);
      const code = await made.exited;
      clearTimeout(timer);
      if (code !== 0 || !isFile(path)) throw new Error(`sips exited ${code}`);
      out.push({ media: one.media, path, data: fs.readFileSync(path).toString("base64"), mime: "image/jpeg" });
    } catch (error) {
      diag.warn("agent", `an attached picture (${one.name}) couldn't be given to the model: ${diag.messageOf(error)}`);
    }
  }
  return out;
}
