// The parts of captions the subtitles package needs, here to break the cycle
// between it and the captions package: a media's transcript (`transcriptOf`),
// "#rrggbb" as a colour (`hex`), a speaker's short name (`subtitleName`) and a
// caption's rough size (`captionSize`, which faces' audit uses). The captions
// seam hands these out.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { ioMessage } from "./files.ts";
import type { Media, Project, Rgba, TextStyle } from "./model.ts";
import { covers, joined } from "./names.ts";
import * as seams from "./seams.ts";
import { charCount, f32, F32_MAX, parseHex, serdeParse, splitWhitespace, trim } from "./rust.ts";
import type { Transcript } from "./transcribe.ts";

/** How long a transcript wait pauses between looks (tests make it instant). */
export const timing = {
  sleep: (ms: number) => Bun.sleep(ms),
  now: () => performance.now(),
};

/** How long `transcriptOf` waits for a transcription before giving up. */
const TRANSCRIBE_LIMIT_MS = 20 * 60 * 1000;

/** Files heard again for a set of names in this run: a failed one isn't asked again and again. */
const reheard = new Set<string>();

/**
 * A media's transcript, transcribing it first if needed. Given the project,
 * Scribe listens for the case's names (names.ts: from its research and
 * script), and a transcript heard without some of them is heard again with
 * them (and the names it had), once: the team's interrogation subtitles said
 * "John Rutten" and "John Bruton" for John Ruetten, who's in every article.
 */
export async function transcriptOf(app: App, media: Media, project?: Project): Promise<Transcript> {
  const path = media.path;
  const names = project === undefined || !media.has_audio ? [] : await seams.research.caseNames(app, project);
  app.media.transcribe(path, media.has_audio, names);
  const started = timing.now();
  for (;;) {
    switch (app.media.status(path).transcript) {
      case "ready": {
        let text: string;
        try {
          text = fs.readFileSync(app.media.paths(path).transcript, "utf8");
        } catch (error) {
          throw new Error(ioMessage(error));
        }
        const transcript = parseTranscript(text);
        const asked = `${path}\n${names.map((name) => name.toLowerCase()).sort().join("\n")}`;
        if (!covers(transcript.keyterms, names) && !reheard.has(asked)) {
          reheard.add(asked);
          diag.info("media", `${media.name}: heard again with the case's names (${names.length})`);
          app.media.transcribe(path, true, joined(names, transcript.keyterms ?? []), true);
          continue;
        }
        return transcript;
      }
      case "failed":
        throw new Error(`${media.name} couldn't be transcribed`);
      default:
        if (timing.now() - started > TRANSCRIBE_LIMIT_MS) throw new Error("transcription took too long");
        await timing.sleep(2000);
    }
  }
}

/**
 * A transcript file as serde reads Edit's transcript files: `model` and
 * `words` required, each word's text and times; the maps default to empty.
 */
export function parseTranscript(text: string): Transcript {
  let value: unknown;
  try {
    value = serdeParse(text);
  } catch (error) {
    throw new Error((error as Error).message);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid type: expected struct Transcript");
  }
  const object = value as Record<string, unknown>;
  if (typeof object.model !== "string") throw new Error("missing field `model`");
  if (!Array.isArray(object.words)) throw new Error("missing field `words`");
  for (const word of object.words as unknown[]) {
    const w = word as Record<string, unknown> | null;
    if (typeof w !== "object" || w === null) throw new Error("invalid type: expected struct Word");
    if (typeof w.text !== "string") throw new Error("missing field `text`");
    if (typeof w.start !== "number") throw new Error("missing field `start`");
    if (typeof w.end !== "number") throw new Error("missing field `end`");
    if (w.speaker === null) delete w.speaker;
  }
  for (const field of ["speakers", "roles", "colors", "looks"] as const) {
    if (object[field] === undefined || object[field] === null) object[field] = {};
  }
  if (!Array.isArray(object.keyterms)) delete object.keyterms;
  return object as unknown as Transcript;
}

/** "#00e5c7" → a colour. */
export function hex(text: string): Rgba | null {
  if (!text.startsWith("#")) return null;
  const value = parseHex(text.slice(1));
  if (value === null) return null;
  const channel = (shift: number) => f32(f32((value >>> shift) & 0xff) / 255);
  return [channel(16), channel(8), channel(0), 1];
}

/** A known speaker's first name; retain a short role when no name is known. */
export function subtitleName(given: string): string {
  const name = trim(given.split(" (")[0] ?? given).replace(/:+$/, "");
  const words = splitWhitespace(name);
  const first = words[0] ?? "Speaker";
  // "Child 2" is another person than "Child": the number stays.
  const rest = words.slice(1);
  if (rest.length > 0 && rest.every((word) => [...word].every((ch) => ch >= "0" && ch <= "9"))) return name;
  if (["Officer", "Deputy", "Detective", "Sergeant", "Sgt.", "Det."].includes(first)) {
    const next = words[1];
    return next !== undefined && ![...next].every((ch) => ch >= "0" && ch <= "9") ? next : name;
  }
  return first;
}

/** A caption's rough size (project pixels): wrapped at the style's width. */
export function captionSize(text: string, style: TextStyle): [number, number] {
  const size = f32(style.size);
  const width = charCount(text) * size * 0.56;
  const max = f32(style.max_width ?? F32_MAX);
  const lines = Math.max(Math.ceil(width / max), 1);
  const pad: [number, number] =
    style.background == null ? [0, 0] : [f32(style.background.pad_x), f32(style.background.pad_y)];
  return [Math.min(width, max) + pad[0] * 2, lines * size * f32(style.line_height) + pad[1] * 2];
}
