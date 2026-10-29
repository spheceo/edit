// A producer's brief as it's pasted: a title, notes on the case, and links,
// each under whatever line names it ("Part 3:", "Surveillance Footage:",
// "More on the text messages etc:"). No two briefs are laid out alike, so this
// reads them roughly: a line ending in a colon, or the words on a link's own
// line, label the links that follow; prose is the producer's notes. Each link
// gets a role from its label so the build knows what it's looking at:
//
// - `hearing`: the case's main footage, in order ("Part 1", "Day 2", "the
//   trial", "sentencing", or a link with no label);
// - `supporting`: other footage of the case (surveillance, bodycam, an
//   interrogation, a 911 call), shown where the story reaches it;
// - `background`: a video about the case ("More on…", news, an explainer),
//   read for its facts and shown only where nothing else has the moment;
// - `article`: a web page, read for the case's facts.
//
// The import joins the videos as one case (hearing first, by part, then
// supporting, then background) and keeps each one's label with the script
// (`Script.labels`), which the evidence names beside each recording.

import type { Brief, BriefLink, BriefRole, Label } from "@edit/types/writer";

const ORDER: Record<BriefRole, number> = { hearing: 0, supporting: 1, background: 2, article: 3 };

/** The videos to import, in the order they join: the hearing by part (then as listed), then supporting, then background. */
export function videosOf(brief: Brief): BriefLink[] {
  return brief.links
    .filter((link) => link.role !== "article")
    .map((link, index) => ({ link, index }))
    .sort((a, b) => ORDER[a.link.role] - ORDER[b.link.role] || (a.link.part ?? Infinity) - (b.link.part ?? Infinity) || a.index - b.index)
    .map(({ link }) => link);
}

export const articlesOf = (brief: Brief): BriefLink[] => brief.links.filter((link) => link.role === "article");

/** How the evidence names a recording beside its words. */
export function describe(label: Label, hearingParts: number): string {
  const named = label.label === "" ? "" : `"${label.label}": `;
  const role =
    label.role === "hearing"
      ? hearingParts > 1
        ? `the hearing, part ${label.part ?? "?"} of ${hearingParts}`
        : "the hearing"
      : label.role === "supporting"
        ? "supporting footage, not the hearing: show it where the story reaches it (or where the court plays it), or in the intro clips"
        : label.role === "background"
          ? "background on the case, not the hearing: read it for facts; show it only for a moment nothing else has"
          : "an article";
  return `${named}${role}`;
}

export function parse(text: string): Brief {
  const brief: Brief = { title: "", notes: "", links: [] };
  const notes: string[] = [];
  // The line naming the links below it, until the next one.
  let heading = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*•]+/u, "").trim();
    if (line === "") continue;
    const urls = urlsIn(line);
    if (urls.length === 0) {
      const label = line.endsWith(":") || line.endsWith("：") ? line.slice(0, -1).trim() : null;
      if (brief.title === "" && label === null && !isLabel(line)) brief.title = [...line].slice(0, 180).join("");
      else if (label !== null && [...label].length <= 80) heading = label;
      else if (isLabel(line)) heading = line;
      else notes.push(line);
      continue;
    }
    // Words beside a link on its own line name it; otherwise the heading does.
    let rest = line;
    for (const url of urls) rest = rest.replaceAll(url, " ");
    const beside = rest.trim().replace(/^[:\-–—() ]+|[:\-–—() ]+$/gu, "").trim();
    const label = beside === "" ? heading : beside;
    for (const found of urls) {
      const url = clean(found);
      if (brief.links.some((link) => link.url === url)) continue;
      const [role, part] = classify(label, isVideo(url));
      brief.links.push({ url, label, role, ...(part === null ? {} : { part }) });
    }
  }
  brief.notes = notes.join("\n\n");
  // A brief with no hearing has its first video as the case ("Context: … <link>").
  if (!brief.links.some((link) => link.role === "hearing")) {
    const first = brief.links.find((link) => link.role !== "article");
    if (first !== undefined) first.role = "hearing";
  }
  // Hearing parts with no number of their own are numbered as listed.
  const hearing = brief.links.filter((link) => link.role === "hearing");
  if (hearing.every((link) => link.part === undefined)) hearing.forEach((link, index) => (link.part = index + 1));
  return brief;
}

const BACKGROUND = ["more on", "more about", "background", "context", "news", "article", "explainer", "explained", "documentary", "report", "coverage", "breakdown", "text messages", "texts"];
const SUPPORTING = ["surveillance", "cctv", "security footage", "security camera", "bodycam", "body cam", "body-cam", "dashcam", "dash cam", "interrogation", "interview", "911", "jail call", "phone call", "arrest", "doorbell", "ring camera", "cell phone", "footage"];
const HEARING = ["trial", "hearing", "sentencing", "verdict", "court", "testimony", "arraignment", "full case"];

/** A short line naming what follows ("Surveillance Footage", "Part 2"). */
function isLabel(line: string): boolean {
  const lower = line.toLowerCase();
  return [...line].length <= 40 && !/[.!?]$/u.test(line) && (partNumber(lower) !== null || [...SUPPORTING, ...BACKGROUND].some((word) => lower.includes(word)));
}

function classify(label: string, video: boolean): [BriefRole, number | null] {
  if (!video) return ["article", null];
  const lower = label.toLowerCase();
  const part = partNumber(lower);
  if (part !== null || HEARING.some((word) => lower.includes(word))) return ["hearing", part];
  if (BACKGROUND.some((word) => lower.includes(word))) return ["background", null];
  if (SUPPORTING.some((word) => lower.includes(word))) return ["supporting", null];
  return ["hearing", null];
}

const NUMBERS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/** "part 3", "pt. 3", "day 3", "3 of 6", "part three". */
export function partNumber(lower: string): number | null {
  const words = lower.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== "");
  for (const [index, word] of words.entries()) {
    const next = words[index + 1] ?? "";
    if (["part", "pt", "day", "session"].includes(word)) {
      if (/^\d+$/.test(next)) return Number(next);
      const at = NUMBERS.indexOf(next);
      if (at >= 0) return at + 1;
    }
    if (next === "of" && /^\d+$/.test(words[index + 2] ?? "") && /^\d+$/.test(word)) return Number(word);
  }
  return null;
}

function urlsIn(line: string): string[] {
  return line.split(/[\s<>"]+/u).flatMap((token) => {
    const at = token.search(/https?:\/\//);
    if (at < 0) return [];
    const url = token.slice(at).replace(/[.,)\];]+$/, "");
    return url.length > 10 ? [url] : [];
  });
}

function isVideo(url: string): boolean {
  const host = url.split("://")[1]?.split(/[/?]/)[0] ?? "";
  return !url.includes("docs.google.com/") && (host.endsWith("youtube.com") || host === "youtu.be" || host === "drive.google.com");
}

/** A YouTube link with only its video and start time: the brief's playlist and search parameters go. */
function clean(url: string): string {
  if (!url.includes("youtube.com/watch")) return url;
  const at = url.indexOf("?");
  if (at < 0) return url;
  const kept = (url.slice(at + 1).split("#")[0] ?? "").split("&").filter((pair) => pair.startsWith("v=") || pair.startsWith("t="));
  return kept.length === 0 ? url : `${url.slice(0, at)}?${kept.join("&")}`;
}
