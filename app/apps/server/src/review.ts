// A reviewer's comments on an export (Frame.io's share links), read into the
// edit: each comment at its timeline time with what's on screen there, so the
// agent can work through a round of feedback without anyone retyping it.
// Frame.io's print view (`…/share/<id>/print/comments/<asset>`) is rendered by
// its scripts, so it's read with the same headless Chrome as read_page.

import { clipEnd, fps as fpsOf, mediaOf } from "./project.ts";
import type { Clip, Project } from "./model.ts";
import { round, trim } from "./rust.ts";

/** One comment (or a reply under it: no number or timecode of its own). */
export interface Comment {
  number: number | null;
  /** As Frame.io shows it: HH:MM:SS:FF at the asset's rate. */
  timecode: string | null;
  author: string;
  date: string;
  text: string;
  replies: Comment[];
}

/** How long the print view's scripts get to load the comments (ms of virtual time). */
export const WAIT_MS = 25_000;

const DATE = /^\d{1,2}\/\d{1,2}\/\d{2,4} at \d{1,2}:\d{2} [AP]M$/;
const TIMECODE = /^(\d{2}):(\d{2}):(\d{2})[:;](\d{2})$/;
/** Where the comments end (the page's drag-and-drop help). */
const FOOTER = "To pick up a draggable item";

/** The print view's link for any Frame.io share link of one asset (`…/view/<asset>`, `…/print/comments/<asset>`). */
export function printUrl(url: string): string {
  const found = /^https:\/\/next\.frame\.io\/share\/([0-9a-f-]{36})(?:\/(?:view|print\/comments)\/([0-9a-f-]{36}))?/.exec(trim(url));
  if (found === null && /^https:\/\/next\.frame\.io\//.test(trim(url))) {
    throw new Error("that Frame.io link needs a sign-in; ask for the video's share link (Share → copy link: https://next.frame.io/share/…), or its comments pasted or exported as text");
  }
  if (found === null) throw new Error("give a Frame.io share link (https://next.frame.io/share/…)");
  const [, share, asset] = found;
  if (asset === undefined) throw new Error("give the link to one video's comments (…/share/<id>/view/<asset> or …/print/comments/<asset>)");
  return `https://next.frame.io/share/${share}/print/comments/${asset}`;
}

/** The page's text, one text node a line (scripts and styles dropped). */
function textLines(page: string): string[] {
  const body = page.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/gi, "");
  return body
    .split(/<[^>]*>/)
    .map((piece) => trim(unescape(piece)))
    .filter((piece) => piece !== "");
}

function unescape(text: string): string {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&");
}

/** The comments on the print view, in its order (by timecode), replies under theirs. */
export function comments(page: string): Comment[] {
  const lines = textLines(page);
  const footer = lines.findIndex((line) => line.startsWith(FOOTER));
  const end = footer < 0 ? lines.length : footer;
  // Each comment starts with its author's initial and name, then the date.
  const starts = lines.flatMap((line, index) => (index >= 1 && index < end && DATE.test(line) ? [index - 1] : []));
  const out: Comment[] = [];
  starts.forEach((authorAt, index) => {
    const next = starts[index + 1];
    // The next one's initial (the line before its name) isn't this one's text.
    const stop = next === undefined ? end : next - 1;
    let at = authorAt + 2;
    // A comment changed after it was posted says so before its number (JJ's of Oct 23 read as replies).
    if (lines[at] === "Edited" && lines[at + 1] === "#") at += 1;
    let number: number | null = null;
    let timecode: string | null = null;
    if (lines[at] === "#" && /^\d+$/.test(lines[at + 1] ?? "")) {
      number = Number(lines[at + 1]);
      at += 2;
      if (TIMECODE.test(lines[at] ?? "")) {
        timecode = lines[at]!;
        at += 1;
      }
    }
    const comment: Comment = {
      number,
      timecode,
      author: lines[authorAt]!,
      date: lines[authorAt + 1]!,
      text: lines.slice(at, stop).join("\n"),
      replies: [],
    };
    const parent = out.at(-1);
    if (number === null && parent !== undefined) parent.replies.push(comment);
    else out.push(comment);
  });
  return out;
}

/** The asset's frame rate as the page's data gives it (`"fps":30`), else null. */
export function assetFps(page: string): number | null {
  const found = /\\?"fps\\?":\s*([0-9.]+)/.exec(page);
  const fps = found === null ? NaN : Number(found[1]);
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

/** Seconds from the start of the video for a timecode at `fps`. */
export function seconds(timecode: string, fps: number): number {
  const found = TIMECODE.exec(timecode);
  if (found === null) throw new Error(`not a timecode: ${timecode}`);
  const [h, m, s, f] = found.slice(1).map(Number) as [number, number, number, number];
  return h * 3600 + m * 60 + s + f / fps;
}

/** A clip as one short line: what it is and where. */
function described(project: Project, clip: Clip): string {
  const label = clip.name ?? "";
  let what: string;
  if (clip.type === "text") what = `text "${clip.text.slice(0, 60)}"${label === "" ? "" : ` (${label})`}`;
  else if (clip.type === "video" || clip.type === "audio") {
    const media = mediaOf(project, clip.media);
    what = `${clip.type} ${label === "" ? (media?.name ?? clip.media) : label} @${round(clip.source_in * 10) / 10}s${clip.speed === 1 ? "" : ` ×${clip.speed}`}`;
  } else what = `${clip.type}${label === "" ? "" : ` ${label}`}`;
  return `${clip.id} ${clip.track} ${clip.start}–${clipEnd(clip)}: ${what}`;
}

/** What's on the timeline at `frame`, lowest track first: each clip's id, track, span and what it is. */
export function onScreen(project: Project, frame: number): string[] {
  const tracks = project.tracks.map((track) => track.id);
  return project.clips
    .filter((clip) => clip.start <= frame && frame < clipEnd(clip))
    .sort((a, b) => tracks.indexOf(a.track) - tracks.indexOf(b.track))
    .map((clip) => described(project, clip));
}

/**
 * The comments placed on `project`'s timeline (the export it reviews starts
 * at frame 0): each with its time and frame and the clips there.
 */
export function placed(project: Project, found: Comment[], rate: number | null): unknown[] {
  const fps = fpsOf(project);
  const one = (comment: Comment): Record<string, unknown> => {
    const out: Record<string, unknown> = { author: comment.author, text: comment.text };
    if (comment.number !== null) out.number = comment.number;
    if (comment.timecode !== null) {
      const at = seconds(comment.timecode, rate ?? fps);
      const frame = Math.round(at * fps);
      out.timecode = comment.timecode;
      out.time = round(at * 100) / 100;
      out.frame = frame;
      out.on_timeline = onScreen(project, frame);
    }
    if (comment.replies.length > 0) out.replies = comment.replies.map(one);
    return out;
  };
  return found.map(one);
}
