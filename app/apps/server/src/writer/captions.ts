// YouTube's own captions as a recording's words, in place of hearing it:
// free, and minutes for a hearing of many hours. Used for every YouTube
// source, including compilation cases; other recordings fall back to hearing.
// The asking, the choice of track and the reading are youtube_words.ts's,
// shared with ideas and imports (its `script` use: manual cues will do, their
// words approximate until exact.ts hears the chosen footage). Each ">>" starts
// a turn of its own (`t0001`, `t0002`…), which the turns pass
// (caption_turns.ts) then gives to people by reading the conversation.
//
// Kept as `captions.json` beside the recording's hearing, never as its
// `transcript.json`, so it's never taken for heard words.

import * as fs from "node:fs";

import type { Script } from "@edit/types/writer";

import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import { writeAtomic } from "../files.ts";
import { join } from "../paths.ts";
import type { Transcript } from "../transcribe.ts";
import * as edit from "../youtube.ts";
import * as youtubeWords from "../youtube_words.ts";
import { isYoutube } from "./youtube.ts";

/** What a transcript made from captions is called (`Transcript.model`). */
export const MODEL = youtubeWords.MODEL;

/** Whether a script's footage takes YouTube's captions where they're there. */
export const wanted = (script: Script): boolean => script.sourceKind === "youtube" || (script.parts ?? []).some((part) => part.url !== undefined && part.url !== null && isYoutube(part.url));

/** A track as Script mode names its turns. */
export const parse = (value: youtubeWords.Json3): Transcript => youtubeWords.parse(value, (turn) => `t${String(turn).padStart(4, "0")}`);

/** The recording's words from YouTube's captions, kept in `work`; null when the video has no usable English captions, or YouTube can't be asked. */
export async function transcript(app: App, url: string, work: string, signal?: AbortSignal): Promise<Transcript | null> {
  const found = cached(work);
  if (found !== null) return found;
  const id = edit.videoId(url);
  if (id === null) return null;
  let chosen: youtubeWords.Track | null;
  try {
    chosen = await youtubeWords.track(app.store.home, id, youtubeWords.USES.script, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    diag.warn("writer", `YouTube's captions couldn't be read: ${diag.messageOf(error)}`);
    return null;
  }
  if (chosen === null) return null;
  const heard = parse(chosen.value);
  if (heard.words.length === 0) return null;
  fs.mkdirSync(work, { recursive: true });
  writeAtomic(join(work, "captions.json"), JSON.stringify(heard));
  return heard;
}

/** Captions read before, kept apart from a paid hearing. */
export function cached(work: string): Transcript | null {
  try {
    const found = JSON.parse(fs.readFileSync(join(work, "captions.json"), "utf8")) as Transcript;
    return found.model === MODEL && found.words.length > 0 ? found : null;
  } catch {
    return null;
  }
}
