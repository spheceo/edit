// A captioned script's new footage, heard exactly after the revision that
// brought it in, not before it's done (Nov 5, JJ's Mac: Claude's revisions
// answered in 8 to 25 s, then waited a minute or two on the footage coming
// back and being heard; Repack's took about 30 s in all). The revision's
// clips show at once on the captions' times; this hears the footage they
// play that wasn't heard yet and moves them onto the exact times a moment
// later, a saved revision of its own.
//
// What's heard is read from the footage on this Mac or, when it was left to
// the cloud, from the cloud's preview a stretch at a time: FFmpeg asks for the
// bytes of each stretch, not the whole 280–700 MB preview first.
//
// One pass at a time a script, applied only once no job or import runs on it
// and only to the words it heard from: a build or another hearing that
// changed them meanwhile has the pass look again instead. Start the edit
// waits for it (`settle`), so an edit is never made from the captions' times.

import type { Clip, Script } from "@edit/types/writer";

import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import { isFile } from "../paths.ts";
import * as chat from "./chat.ts";
import * as cloud from "./cloud.ts";
import { checkClips } from "./edits.ts";
import * as exact from "./exact.ts";
import { importing } from "./imports.ts";
import * as jobs from "./jobs.ts";
import { clock } from "./paragraphs.ts";
import * as storage from "./storage.ts";
import * as store from "./store.ts";
import { readPeaks } from "./tidy.ts";
import * as versions from "./versions.ts";

/** How long a pass waits for a job on its script to end before giving up (the next revision or Start the edit asks again). */
const WAIT_MS = 2 * 3_600_000;

const going = new Map<string, Promise<void>>();
const again = new Set<string>();

/** The footage a script plays: its original where it's still on this Mac, else its preview. */
export const footagePath = (dir: string, script: Script): string => (script.originalPath !== "" && isFile(script.originalPath) ? script.originalPath : store.proxyPath(dir));

/** Where exact hearing reads a script's footage: its file here, else the preview in the cloud (read a stretch at a time), else brought back whole when the cloud has no preview. */
export async function footageFor(app: App | null, data: string, dir: string, id: string, job: jobs.Job | null): Promise<{ footage: string } | { away: string }> {
  const here = () => {
    const path = footagePath(dir, store.read(dir));
    return isFile(path) ? path : null;
  };
  const found = here();
  if (found !== null) return { footage: found };
  try {
    const url = await cloud.previewUrl(data, id);
    if (url !== null) return { footage: url };
    if (app === null) return { away: "its preview isn't in the cloud" };
    // No preview in the cloud (an older script): its preview made again here from the recordings, as before (Oct 30, When Teen Delinquents).
    job?.stage("Bringing the footage back to hear it");
    await storage.bringBack(app, data, id, job ?? undefined, true);
  } catch (error) {
    if (job?.signal.aborted) throw error;
    return { away: unsigned(diag.messageOf(error)) };
  }
  const back = here();
  return back !== null ? { footage: back } : { away: "its preview isn't in the cloud" };
}

/** An error without the presigned address FFmpeg was reading from. */
export const unsigned = (text: string): string => text.replace(/https?:\/\/\S+/g, "the cloud preview");

/** Whether a script's clips play footage not heard exactly yet. */
export function pending(data: string, id: string): boolean {
  try {
    const script = store.read(store.scriptDir(data, id));
    return exact.wanted(script) && exact.stretches(script, script.clips).length > 0;
  } catch {
    return false;
  }
}

/** Hears what the script's clips play that wasn't heard yet, in the background; a pass already going looks again when it ends. */
export function soon(data: string, id: string): void {
  if (going.has(id)) {
    again.add(id);
    return;
  }
  if (!pending(data, id)) return;
  const run = (async () => {
    do {
      again.delete(id);
      await once(data, id);
    } while (again.has(id));
  })()
    .catch((error: unknown) => diag.warn("writer", `${id.slice(0, 8)}: its new footage wasn't heard exactly: ${unsigned(diag.messageOf(error))}`))
    .finally(() => going.delete(id));
  going.set(id, run);
}

/** Hears whatever is left now and waits for it (Start the edit); a failure leaves the captions' times, as a revision's did. */
export async function settle(data: string, id: string): Promise<void> {
  soon(data, id);
  await going.get(id);
}

/** Waits for a pass under way (tests). */
export const idle = (id: string): Promise<void> => going.get(id) ?? Promise.resolve();

/** The words as heard from, to tell whether anything changed them meanwhile. */
const stamp = (words: { id: string; text: string; startMs: number; endMs: number; speaker?: string | null }[]): string => JSON.stringify(words.map((word) => [word.id, word.text, word.startMs, word.endMs, word.speaker ?? null]));

async function once(data: string, id: string): Promise<void> {
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  if (!exact.wanted(script)) return;
  const spans = exact.stretches(script, script.clips);
  if (spans.length === 0) return;
  const began = Date.now();
  const name = jobs.named(id, script.title);
  const source = await footageFor(null, data, dir, id, null);
  if ("away" in source) {
    diag.warn("writer", `${name}: its new footage wasn't heard exactly (${source.away}); its cuts follow YouTube's captions`);
    return;
  }
  const from = isFile(source.footage) ? "here" : "the cloud's preview";
  const heardFrom = stamp(script.words);
  const wordsBefore = structuredClone(script.words);
  const work = structuredClone(script);
  const report = await exact.run(work, dir, source.footage, work.clips, () => {});
  // A job or an import on the script writes it when it ends: the pass lands after it.
  const until = Date.now() + WAIT_MS;
  while (jobs.running(id) || importing(id)) {
    if (Date.now() > until) return;
    await Bun.sleep(1_000);
  }
  const latest = store.read(dir);
  if (stamp(latest.words) !== heardFrom) {
    // Something else heard or changed the words meanwhile: look again at what's left.
    again.add(id);
    return;
  }
  const before = structuredClone(latest);
  // Only clips playing what was just heard move: the rest (and any trimmed by hand) stay as they are.
  const touches = (clip: Clip) => spans.some(([from, to]) => clip.startMs < to && clip.endMs > from);
  const remapped = exact.remapFrom(wordsBefore, latest.clips, work.words, latest.durationMs).map((clip, index) => (touches(latest.clips[index]!) ? clip : latest.clips[index]!));
  const silent = new Set(exact.silent(remapped, readPeaks(dir) ?? new Float32Array()).filter((index) => touches(latest.clips[index]!)));
  latest.clips = checkClips(
    remapped.filter((_, index) => !silent.has(index)),
    latest.durationMs,
  );
  latest.words = work.words;
  latest.exact = work.exact;
  // People the hearing met are added; names given meanwhile stay.
  latest.speakers = { ...(work.speakers ?? {}), ...(latest.speakers ?? {}) };
  latest.revision++;
  latest.updatedAt = Date.now();
  store.write(dir, latest);
  versions.keep(dir, "claude", before, latest);
  if (silent.size > 0) chat.add(dir, "editor", `Heard the new footage exactly and dropped ${silent.size} ${silent.size === 1 ? "piece" : "pieces"} with no sound in ${silent.size === 1 ? "it" : "them"}.`);
  diag.info("writer", `${name}: new footage heard exactly from ${from} in ${Math.round((Date.now() - began) / 1000)} s: ${clock(report.heardMs)} in ${report.stretches} ${report.stretches === 1 ? "stretch" : "stretches"}, ${report.retimed} words retimed, ${report.respelled} respelled, ${report.relabelled} relabelled${silent.size > 0 ? `, ${silent.size} silent pieces dropped` : ""}`);
}
