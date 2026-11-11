// A recording's words as both modes and every Mac share them, in Edit's
// analysis (`edit/analysis/<kind>/<id>[/<s>-<e>]/`). A file Scribe heard
// whole is `transcript.json`, as it's always been; one heard only in its kept
// stretches (kept_hearing.ts: `heard`, the rest the free first words) is
// `transcript-kept.json`, which builds from before Nov 11 never read: they'd
// take its Apple words for Scribe's, with no voices, and subtitle them. They
// hear the file their own way instead. This build reads both and takes the
// whole hearing when there is one, else the most heard.

import * as fs from "node:fs";

import * as cloud from "./cloud.ts";
import { asKept } from "./kept_hearing.ts";
import { join } from "./paths.ts";
import type { Transcript } from "./transcribe.ts";

/** A whole hearing's name in the analysis. */
export const WHOLE = "transcript.json";
/** The name of one heard only in its kept stretches. */
export const KEPT = "transcript-kept.json";

/** Whether `transcript` is Scribe's of the whole file. */
export const isWhole = (transcript: Transcript): boolean => transcript.heard === undefined && transcript.model.startsWith("scribe");

/** How much of a transcript Scribe heard (seconds; a whole hearing all of it). */
const heardSeconds = (transcript: Transcript): number =>
  transcript.heard === undefined ? Number.POSITIVE_INFINITY : transcript.heard.reduce((sum, [from, to]) => sum + to - from, 0);

/** The name `transcript` is shared under. */
export const nameOf = (transcript: Transcript): string => (Array.isArray(transcript.heard) ? KEPT : WHOLE);

async function one(key: string, scratch: string): Promise<Transcript | null> {
  const copy = join(scratch, `.shared-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  try {
    if (!(await cloud.has(key))) return null;
    fs.mkdirSync(scratch, { recursive: true });
    await cloud.download(key, copy);
    const found = JSON.parse(fs.readFileSync(copy, "utf8")) as Transcript;
    if (typeof found.model !== "string" || !Array.isArray(found.words)) return null;
    if (!Array.isArray(found.heard)) delete found.heard;
    return asKept(found);
  } catch {
    return null;
  } finally {
    fs.rmSync(copy, { force: true });
    fs.rmSync(cloud.partialPath(copy), { force: true });
  }
}

/** The best words shared under `prefix` (ends in "/"): a whole hearing, else whichever has more heard; null when none. */
export async function read(prefix: string, scratch: string): Promise<Transcript | null> {
  const whole = await one(`${prefix}${WHOLE}`, scratch);
  if (whole !== null && isWhole(whole)) return whole;
  const kept = await one(`${prefix}${KEPT}`, scratch);
  if (whole === null) return kept;
  if (kept === null) return whole;
  return heardSeconds(kept) >= heardSeconds(whole) ? kept : whole;
}

/** Shares `transcript` under `prefix`, by the name for what it is. */
export async function write(prefix: string, transcript: Transcript, text: string): Promise<void> {
  await cloud.uploadStream(cloud.bytesSource(new TextEncoder().encode(text)), `${prefix}${nameOf(transcript)}`, text.length);
}
