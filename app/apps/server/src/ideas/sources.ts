// What an idea is made from, read in code before Claude is asked (one prompt,
// no round trips for fetching): a YouTube video's details from the YouTube
// Data API on the relay (its key never leaves it), its words from
// youtube_words.ts (captions through the YouTube proxy first), and an article
// read as Script mode reads one. The user, Oct 31: "try not to do research
// locally to not risk ip bans, try and do it through the api and api key":
// nothing here crawls, and YouTube is asked from the Mac's own address only
// for a case's captions when it turns the proxy's away (Nov 10).

import * as fs from "node:fs";

import type { IdeaSource } from "@edit/types/ideas";

import * as diag from "../diag.ts";
import * as relay from "../relay.ts";
import type { Transcript } from "../transcribe.ts";
import * as youtube from "../youtube.ts";
import * as youtubeWords from "../youtube_words.ts";
import * as research from "../writer/research.ts";

/** How much of a transcript goes to Claude (Sphe Research's cap: the hook is rarely in the tail). */
export const TRANSCRIPT_CHARS = 60_000;

export type Video = Extract<IdeaSource, { kind: "youtube" }> & { description: string };

/** A link's YouTube video id, or null. */
export const videoIdOf = (url: string): string | null => youtube.videoId(url.trim());

/** A video's details: title, description, channel, views, its outlier score and thumbnail. */
export async function video(id: string): Promise<Video> {
  const found = await relay.json<{ title: string; description: string; channel: string; views: number | null; outlier: string; publishedAt: string | null; durationSeconds: number | null; thumbnail: string | null }>(
    "GET",
    `/v1/ideas/youtube?id=${encodeURIComponent(id)}`,
    null,
    "YouTube's details",
    30,
  );
  return {
    kind: "youtube",
    url: `https://www.youtube.com/watch?v=${id}`,
    videoId: id,
    title: found.title,
    description: found.description,
    channel: found.channel,
    views: found.views,
    outlier: found.outlier,
    publishedAt: found.publishedAt,
    durationSeconds: found.durationSeconds,
    thumbnail: found.thumbnail,
  };
}

/** Test hook: where a video's words come from (youtube_words.ts, as an idea reads them). */
export const captions = {
  words: (home: string, id: string, signal?: AbortSignal, onStage?: (text: string) => void): Promise<Transcript> => youtubeWords.words(home, id, youtubeWords.USES.idea, signal, onStage),
};

/**
 * A video's words as Claude reads them: a line a speaker's turn (a new line
 * every ~60 words in a long one), each with its time. They come from
 * youtube_words.ts, the one reader an import uses too, so captions fetched
 * for either serve the other. Throws its `NoWords` when there are none to be
 * had, saying why (YouTube turning Edit away is not "no captions").
 */
export async function transcript(home: string, id: string, signal?: AbortSignal, onStage?: (text: string) => void): Promise<{ text: string; words: number; truncated: boolean }> {
  const found = await captions.words(home, id, signal, onStage);
  const text = readable(found);
  const truncated = text.length > TRANSCRIPT_CHARS;
  return { text: truncated ? `${text.slice(0, TRANSCRIPT_CHARS)}\n\n[Transcript truncated: this is the first part of a long video.]` : text, words: found.words.length, truncated };
}

const clock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
};

/** Words as lines: each turn its own, its time first. */
export function readable(transcript: Transcript): string {
  const lines: string[] = [];
  let line: string[] = [];
  let speaker: string | undefined;
  let start = 0;
  const flush = () => {
    if (line.length > 0) lines.push(`[${clock(start)}] ${line.join(" ")}`);
    line = [];
  };
  for (const word of transcript.words) {
    if (word.speaker !== speaker || line.length >= 60) {
      flush();
      speaker = word.speaker;
      start = word.start;
    }
    line.push(word.text);
  }
  flush();
  return lines.join("\n");
}

/** An article: what it is and its readable text. */
export async function article(url: string): Promise<{ source: Extract<IdeaSource, { kind: "article" }>; text: string }> {
  const page = await research.read(url).catch((error: unknown) => {
    throw new Error(`Couldn't read that article: ${diag.messageOf(error)}`);
  });
  if (page === null) throw new Error("Couldn't read that article: check the link opens without a sign-in.");
  return { source: { kind: "article", url, title: page.title, outlet: page.outlet }, text: page.text };
}

/** A picture's bytes into `path`: a YouTube thumbnail (its CDN), or a Trello attachment (through the relay, which holds the key). */
export const picture = (url: string, path: string): Promise<boolean> => pictures.fetch(url, path);

/** How a picture is fetched (tests give their own, as with `captions`). */
export const pictures = { fetch: fetchPicture };

async function fetchPicture(url: string, path: string): Promise<boolean> {
  try {
    let bytes: Uint8Array;
    if (/^https:\/\/i\.ytimg\.com\//.test(url)) {
      const answer = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!answer.ok) return false;
      bytes = new Uint8Array(await answer.arrayBuffer());
    } else {
      const out = `${path}.part`;
      await relay.call("GET", `/v1/ideas/trello/image?url=${encodeURIComponent(url)}`, null, out, "a card's picture");
      bytes = new Uint8Array(fs.readFileSync(out));
      fs.rmSync(out, { force: true });
    }
    if (bytes.length === 0) return false;
    fs.writeFileSync(path, bytes);
    return true;
  } catch (error) {
    diag.warn("ideas", `a picture for Claude (${url.split("?")[0]}): ${diag.messageOf(error)}`);
    return false;
  }
}
