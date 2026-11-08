// What a script's comments link, and whether the edit shows it. A Doc whose
// comments direct each line (the horror Doc of Nov 8: 280 of them, "Animation
// 4: LAist article, highlight …: <link>", "B-roll: … <YouTube link> (0:08-0:20)",
// "Show the Youtube channel screenshot from drive here") names a source in
// most of them, and Sphe: "ESPECIALLY comments are so important we need to
// implement every single one perfectly". The sources the agent brought in are
// in research/<project>/broll.json (import_broll's ranges and posts,
// capture_evidence's pages, the references); a link whose source no clip uses
// is `note_link_unused`, which Edit's follow-ups count until it's done or said.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import type { Project } from "./model.ts";
import { join } from "./paths.ts";
import { driveFileId } from "./script.ts";
import * as youtube from "./youtube.ts";

/** A link in a note, as the audit matches it. */
export type Link =
  | { kind: "youtube"; id: string; start: number | null; url: string }
  | { kind: "drive"; id: string; url: string }
  | { kind: "page"; key: string; url: string };

const URL_IN_TEXT = /https?:\/\/[^\s)<>"'\]]+/gu;

/** A page's link as it's compared: host without www, path without a trailing slash, an archived page's own address. */
export function pageKey(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.replace(/[.,;:!?]+$/u, ""));
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^(www|m|mobile)\./u, "");
  let path = decodeURIComponent(parsed.pathname).replace(/\/+$/u, "");
  if (host === "web.archive.org") {
    // web/<timestamp or *>/<the page>: any capture of that page is it.
    const archived = /^\/web\/[^/]+\/(.+)$/u.exec(path)?.[1];
    if (archived !== undefined) return pageKey(/^https?:\/\//u.test(archived) ? archived : `https://${archived}`);
  }
  // X's status links: the post id is the post, whoever's handle is written.
  const status = /^\/[^/]+\/status\/(\d+)/u.exec(path)?.[1];
  if ((host === "x.com" || host === "twitter.com") && status !== undefined) return `x.com/status/${status}`;
  if (host === "twitter.com") return `x.com${path.toLowerCase()}`;
  if (host === "x.com") path = path.toLowerCase();
  return `${host}${path}`;
}

/** The links a note names, each once. */
export function linksIn(note: string): Link[] {
  const out: Link[] = [];
  const seen = new Set<string>();
  for (const raw of note.match(URL_IN_TEXT) ?? []) {
    const url = raw.replace(/[.,;:!?]+$/u, "");
    const video = youtube.videoId(url);
    const drive = video === null ? driveFileId(url) : null;
    let link: Link | null = null;
    if (video !== null) {
      const t = new URL(url).searchParams.get("t");
      link = { kind: "youtube", id: video, start: t === null ? null : youtube.startOf(t), url };
    } else if (drive !== null) link = { kind: "drive", id: drive, url };
    else {
      const key = pageKey(url);
      if (key !== null) link = { kind: "page", key, url };
    }
    if (link === null) continue;
    const id = link.kind === "page" ? link.key : `${link.kind}:${link.id}:${link.kind === "youtube" ? link.start : ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(link);
  }
  return out;
}

/** A note that's only a link (the writer's source for the line, with no direction): not asked to be shown. */
function bare(note: string): boolean {
  return note.replace(URL_IN_TEXT, "").replace(/[\s()[\].,;:*-]/gu, "") === "";
}

interface Found {
  url?: unknown;
  asked?: unknown;
  media?: unknown;
  avatar?: unknown;
  /** A post's words (tweet_reference): shown when a clip carries them (commentary_tweet). */
  text?: unknown;
  start?: unknown;
  end?: unknown;
}

/** Whether a found source is this link. */
function matches(link: Link, key: string, found: Found): boolean {
  const urls = [found.url, found.asked].filter((one): one is string => typeof one === "string");
  if (link.kind === "youtube") {
    const fromKey = /^range:([\w-]{11}):([\d.]+):([\d.]+)$/u.exec(key);
    const id = fromKey?.[1] ?? urls.map((url) => youtube.videoId(url)).find((one) => one !== null) ?? null;
    if (id !== link.id) return false;
    if (link.start === null) return true;
    const start = fromKey !== null ? Number(fromKey[2]) : typeof found.start === "number" ? found.start : null;
    const end = fromKey !== null ? Number(fromKey[3]) : typeof found.end === "number" ? found.end : null;
    // The range asked for starts within the one brought in (a second's slack either way).
    return start === null || end === null || (link.start >= start - 1.5 && link.start <= end + 1);
  }
  if (link.kind === "drive") return urls.some((url) => driveFileId(url) === link.id);
  return urls.some((url) => pageKey(url) === link.key);
}

/** The media a found source brought in. */
function mediaOf(found: Found): string[] {
  return [found.media, found.avatar].filter((one): one is string => typeof one === "string");
}

/** Every media id a clip uses, however deep (a card's photo, a desktop window's video, a profile's picture). */
function usedMedia(project: Project): Set<string> {
  const ids = new Set(project.media.map((media) => media.id));
  const used = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === "string") {
      if (ids.has(value)) used.add(value);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(project.clips);
  return used;
}

/** The sources this project's agent brought in (research/<project>/broll.json). */
export function foundSources(app: App, project: string): [string, Found][] {
  try {
    const saved = JSON.parse(fs.readFileSync(join(app.store.home, "research", project, "broll.json"), "utf8")) as Record<string, Found>;
    return Object.entries(saved).filter(([, value]) => value !== null && typeof value === "object");
  } catch {
    return [];
  }
}

/**
 * Every link a script's directing notes name whose source no clip shows: one
 * flag per link, with its note, its block's words and where that block plays.
 */
export function unusedNoteLinks(app: App, project: Project): Record<string, unknown>[] {
  const blocks = project.script?.blocks ?? [];
  if (blocks.length === 0) return [];
  const found = foundSources(app, project.id);
  const used = usedMedia(project);
  const words = JSON.stringify(project.clips);
  const shown = (one: Found) =>
    mediaOf(one).some((media) => used.has(media)) || (typeof one.text === "string" && one.text.length >= 12 && words.includes(JSON.stringify(one.text.slice(0, 40)).slice(1, -1)));
  const clipStart = new Map(project.clips.map((clip) => [clip.id, clip.start]));
  const out: Record<string, unknown>[] = [];
  blocks.forEach((block, index) => {
    for (const note of block.notes ?? []) {
      if (bare(note)) continue;
      for (const link of linksIn(note)) {
        const sources = found.filter(([key, one]) => matches(link, key, one));
        if (sources.some(([, one]) => shown(one))) continue;
        out.push({
          kind: "note_link_unused",
          block: index,
          ...(block.clip !== undefined && clipStart.has(block.clip) ? { start: clipStart.get(block.clip) } : {}),
          link: link.url,
          note: note.length > 260 ? `${note.slice(0, 257)}…` : note,
          ...(block.kind === "narration" ? { words: block.text.length > 120 ? `${block.text.slice(0, 117)}…` : block.text } : {}),
          state: sources.length === 0 ? "not brought in" : "brought in, not on the timeline",
          fix:
            link.kind === "youtube"
              ? "import_broll that range, look at it frame by frame (look_at_media over the range), then place it at the note's words as the note says (crop, punch-in, blur, speed)"
              : link.kind === "drive"
                ? "import_broll the Drive link (it comes back as a picture or a clip), then do what the note says with it at its words"
                : "capture_evidence the page (its phrase for a highlight; an X post: tweet_reference and commentary_tweet), then do what the note says at its words; a page that won't load: say so",
        });
      }
    }
  });
  return out;
}
