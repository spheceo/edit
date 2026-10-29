// Cards waiting for a script on Repack's Trello lists, read through Edit's
// relay (its key and token stay there) and parsed as Repack's
// script-trello.ts and script.ts parse them. Nothing is written to Trello.
//
// The Raw Channels list holds one case a card: its footage is the first
// Drive folder (or Drive video), its article the first other web page. The
// compilation list holds a compilation a card: its cases' links, "case N"
// line by line. A compilation's case may be a YouTube video, a Drive video,
// or a Google Doc of a script the channel already made, which is a reused
// case (`imports.linesFor`).

import * as relay from "../relay.ts";
import { decode } from "../research.ts";
import * as drive from "./drive.ts";
import { isYoutube } from "./youtube.ts";

/** A card labelled this is passed over, as Repack's Raw Channels skips it. */
const SKIP_LABEL = "missing footage";

export interface Card {
  id: string;
  name: string;
  url: string;
  labels: string[];
  activity: string | null;
  /** `case` (Raw Channels), `compilation`, or `video` (a pasted card with one video). */
  kind: "case" | "compilation" | "video";
  /** A case card's Drive folder or video, and its article. */
  footage: string | null;
  article: string | null;
  /** A compilation card's lines, as the New script dialog takes them. */
  lines: string[];
  videos: number;
  reuses: number;
  /** Why the card can't start a script as it is. */
  problem: string | null;
  /** A script with the card's title already exists. */
  scripted: boolean;
}

export interface Cards {
  list: string;
  cards: Card[];
}

type Raw = Record<string, unknown>;
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const text = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const clip = (given: string, count: number): string => [...given].slice(0, count).join("");

/** One list's cards, `raw` or `comp`, each parsed for what a script needs; `titles` are the scripts already made, lowercased. */
export async function cards(list: string, titles: string[]): Promise<Cards> {
  if (list !== "raw" && list !== "comp") throw new Error("Choose the Raw Channels list or the compilation list.");
  const value = await relay.json<Raw>("GET", `/v1/writer/trello/cards?list=${list}`, null, "Trello", 60);
  const compilation = list === "comp";
  return { list: text(value.list, list), cards: (Array.isArray(value.cards) ? (value.cards as Raw[]) : []).flatMap((card) => parse(card, compilation, titles) ?? []) };
}

/** The card a pasted link names (trello.com/c/<id>/…): its videos, from wherever on the card they are, as a compilation's lines when there are two or more, or as one video's import. */
export async function card(link: string, titles: string[]): Promise<Card> {
  const id = cardId(link);
  if (id === null) throw new Error("That isn't a Trello card link (trello.com/c/…).");
  const value = await relay.json<Raw>("GET", `/v1/writer/trello/card?card=${id}`, null, "Trello", 60);
  return pastedCard(value, id, link, titles);
}

export function pastedCard(value: Raw, id: string, link: string, titles: string[]): Card {
  const name = clip(text(value.name, "Trello card").trim(), 180);
  const more = ["attachmentLabels", "attachments", "checklists", "comments"].flatMap((field) => strings(value[field]));
  // The description's cases first, as the compilation list reads them; then any video found elsewhere on the card.
  const links = cardLinks(text(value.desc), more);
  const videos = links.filter((one) => !one.reuse).length;
  const found: Card = {
    id: text(value.id, id),
    scripted: titles.includes(name.toLowerCase()),
    name,
    url: text(value.url, link),
    labels: strings(value.labels),
    activity: typeof value.activity === "string" ? value.activity : null,
    kind: links.length >= 2 ? "compilation" : "video",
    footage: null,
    article: null,
    lines: links.map(line),
    videos,
    reuses: links.length - videos,
    problem: null,
  };
  if (videos === 1) found.footage = links.find((one) => !one.reuse)?.url ?? null;
  if (videos === 0) found.problem = "No YouTube or Drive video on the card.";
  return found;
}

/** Cases in the description lead; supported sources elsewhere supplement them. Each attachment is read on its own, so an annotation can't leak to the next. */
export function cardLinks(description: string, more: string[]): Link[] {
  const sections = caseSections(description);
  // The relay sends both labelled attachment text and its plain URL.
  const excluded = more.filter(referenceLabel).flatMap(urls).map((url) => key(unwrapRedirect(url)));
  for (const given of more) {
    if (referenceLabel(given)) continue;
    const number = caseLine(given) ? caseNumber(given) : null;
    if (number !== null) {
      const section = sections.find(([known]) => known === number);
      if (section) section[1] += `\n${given}`;
      else {
        const at = sections.findIndex(([known]) => known !== null && known > number);
        sections.splice(at < 0 ? sections.length : at, 0, [number, given]);
      }
      continue;
    }
    for (const found of linksIn(given)) {
      if (excluded.includes(key(found.url))) continue;
      if (!sections.flatMap(([, body]) => linksIn(body)).some((known) => sameVideo(known.url, found.url))) sections.push([null, line(found)]);
    }
  }
  return sections.flatMap(([, body]) => linksIn(body));
}

const leadWord = (given: string): string => given.replace(/^[^\p{L}\p{N}]+/u, "");

function referenceLabel(given: string): boolean {
  const label = (leadWord(given).split(/[\s:]/)[0] ?? "").toLowerCase();
  return ["thumb", "thumbnail", "cover", "reference", "references", "article", "articles"].includes(label);
}

function sourceLabel(given: string): boolean {
  const rest = leadWord(given);
  if (!rest.includes(":")) return false;
  return ["footage", "source", "video", "script"].includes(rest.split(":")[0]!.trim().toLowerCase());
}

function caseSections(description: string): [number | null, string][] {
  const all = description.split("\n");
  if (!all.some(caseLine)) return [[null, description]];
  const sections: [number | null, string][] = [];
  let current: number | null = null;
  for (const given of all) {
    if (caseLine(given)) {
      sections.push([caseNumber(given), ""]);
      current = sections.length - 1;
    } else if (current !== null) {
      const hasSource = linksIn(sections[current]![1]).length > 0;
      if (referenceLabel(given) || (sourceLabel(given) && hasSource) || (headingLine(given) && !saysReuse(given) && !sourceLabel(given))) current = null;
    }
    if (current !== null) sections[current]![1] += `${given}\n`;
  }
  return sections;
}

/** The id in a card link: trello.com/c/<id>/<slug>. */
export function cardId(link: string): string | null {
  const at = link.trim().indexOf("trello.com/c/");
  if (at < 0) return null;
  const id = /^[A-Za-z0-9]*/.exec(link.trim().slice(at + "trello.com/c/".length))![0];
  return id.length >= 6 && id.length <= 32 ? id : null;
}

export function parse(given: Raw, compilation: boolean, titles: string[]): Card | null {
  if (typeof given.name !== "string") return null;
  const name = clip(given.name.trim(), 180);
  const labels = strings(given.labels);
  if (!compilation && labels.some((label) => label.trim().toLowerCase() === SKIP_LABEL)) return null;
  const desc = text(given.desc);
  const attachments = ["attachmentLabels", "attachments"].flatMap((field) => strings(given[field]));
  const found: Card = { id: text(given.id), scripted: titles.includes(name.toLowerCase()), name, url: text(given.url), labels, activity: typeof given.activity === "string" ? given.activity : null, kind: compilation ? "compilation" : "case", footage: null, article: null, lines: [], videos: 0, reuses: 0, problem: null };
  if (compilation) {
    const links = cardLinks(desc, attachments);
    found.videos = links.filter((one) => !one.reuse).length;
    found.reuses = links.length - found.videos;
    found.lines = links.map(line);
    if (found.videos === 0) found.problem = "No new footage links on the card.";
    else if (links.length < 2) found.problem = "A compilation needs at least two cases.";
  } else {
    const [footage, article] = caseLinks(desc, attachments);
    if (footage === null) found.problem = "No Google Drive footage on the card.";
    found.footage = footage;
    found.article = article;
  }
  return found;
}

export interface Link {
  url: string;
  reuse: boolean;
  /** A reused case's earlier script, as the card points to it: the earlier compilation's card (or Doc) and the case's number there. */
  earlier: string | null;
}

/** The line New script takes: "REUSE <video> <earlier card> case N". */
export const line = (link: Link): string => (link.reuse ? (link.earlier !== null ? `REUSE ${link.url} ${link.earlier}` : `REUSE ${link.url}`) : link.url);

/** "case 1 - Reuse:", "Case 4:", "**CASE #2**", "- case no. 3". */
function caseLine(given: string): boolean {
  const lower = leadWord(given).toLowerCase();
  if (!lower.startsWith("case")) return false;
  let rest = lower.slice(4).trimStart();
  for (const prefix of ["#", "no.", "no", "number"]) {
    if (rest.startsWith(prefix)) {
      rest = rest.slice(prefix.length);
      break;
    }
  }
  const digits = /^\d*/.exec(rest.trimStart())![0].length;
  return digits >= 1 && digits <= 2;
}

/** A line that only titles what follows it: "Thumb:", "## Notes". */
function headingLine(given: string): boolean {
  const trimmed = given.trimStart();
  const hashes = /^#*/.exec(trimmed)![0].length;
  if (hashes >= 1 && hashes <= 6 && /^\s/.test(trimmed.slice(hashes))) return true;
  const at = given.indexOf(":");
  if (at < 0) return false;
  const before = [...given.slice(0, at)].length;
  return before >= 1 && before <= 40 && ![...given.slice(at + 1)].some((c) => /[\p{L}\p{N}]/u.test(c));
}

/** A compilation card's links: every line from a "case N" line to the next heading, or, when the card numbers no cases, the whole description. */
export const compilationLinks = (description: string): Link[] => caseSections(description).flatMap(([, body]) => linksIn(body));

/** Whether a link is a Google Doc: a reused case given as its earlier script. */
export function isDoc(url: string): boolean {
  const prefix = "https://docs.google.com/document/d/";
  return url.startsWith(prefix) && (url.slice(prefix.length).split(/[/?#]/)[0] ?? "") !== "";
}

/**
 * The video and script links in some text, in order. A link is a reuse when
 * its line says so ("REUSE https://…"), the line above it holds that word and
 * no link, or it's under a heading that does ("Reused:"); a Google Doc is
 * always one. A reused video followed by another Trello card and "case N"
 * (or a Doc) is a case of that earlier compilation: where its script is.
 */
export function linksIn(given: string): Link[] {
  const found: Link[] = [];
  let marked = false;
  // Under a heading that says reuse, until the next heading.
  let section = false;
  // The last link found can still take the earlier card on a line after it.
  let open = false;
  let scope = 0;
  let numbered = false;
  let currentNumber: number | null = null;
  for (const row of given.split("\n")) {
    if (caseLine(row)) {
      const number = caseNumber(row);
      if (!numbered || number !== currentNumber) scope = found.length;
      currentNumber = number;
      numbered = true;
    } else if (!numbered) scope = found.length;
    const all = urls(row).map(unwrapRedirect);
    let words = row;
    for (const url of all) words = words.replaceAll(url, " ");
    const says = saysReuse(words);
    const wordy = /[\p{L}\p{N}]/u.test(words);
    if (all.length === 0) {
      // "Reused:" heads a section; "case 2 - Reuse:" only its own case.
      if (caseLine(row)) section = false;
      else if (headingLine(row)) section = says;
      // Blank lines between the word and its link change nothing.
      if (says) marked = true;
      else if (wordy) {
        marked = false;
        open = false;
      }
      continue;
    }
    const videos = all.filter((url) => isYoutube(url) || drive.isDrive(url));
    if (caseLine(row)) {
      section = false;
      marked = false;
    }
    const markedHere = says || marked || section;
    // A Doc beside a reused video is that case's earlier script; any other Doc is a reused case of its own.
    const allDocs = all.filter(isDoc);
    const beside = markedHere && videos.length > 0 ? allDocs : [];
    const docs = markedHere && videos.length > 0 ? [] : allDocs;
    // The earlier compilation this case was in: its card or Doc, and the case's number there.
    const card = all.flatMap((url) => {
      const id = url.includes("trello.com/c/") ? cardId(url) : null;
      return id === null ? [] : [`https://trello.com/c/${id}`];
    })[0];
    const base = card ?? beside[0] ?? null;
    const number = caseNumber(words);
    const earlier = base === null ? null : number !== null ? `${base} case ${number}` : base;
    if (videos.length === 0 && docs.length === 0 && beside.length === 0) {
      // "https://trello.com/c/… (Case 4)" under the reused video it belongs to.
      const last = found.at(-1);
      if (open && earlier !== null && last !== undefined && last.earlier === null && !isDoc(last.url) && (last.reuse || earlier.includes(" case "))) {
        last.reuse = true;
        last.earlier = earlier;
      }
      open = false;
      continue;
    }
    // Keep mixed sources in their pasted order, including Docs on the same line.
    for (const url of all) {
      const doc = docs.includes(url);
      if (!doc && !videos.includes(url)) continue;
      const reuse = doc || markedHere || (earlier !== null && earlier.includes(" case "));
      const known = found.slice(scope).find((one) => sameVideo(one.url, url));
      if (known !== undefined) {
        known.reuse ||= reuse;
        if (known.earlier === null && reuse && !doc) known.earlier = earlier;
      } else found.push({ url, reuse, earlier: reuse && !doc ? earlier : null });
    }
    open = videos.length > 0 && found.at(-1)?.earlier === null;
    marked = false;
  }
  return found;
}

/** "(Case 4)", "**case 2**", "case #3": the case's number in an earlier compilation. */
function caseNumber(words: string): number | null {
  let rest = words.toLowerCase();
  for (let at = rest.indexOf("case"); at >= 0; at = rest.indexOf("case")) {
    const after = rest.slice(at + 4).replace(/^[\s#*.:no]+/, "");
    const digits = /^\d*/.exec(after)![0];
    if (digits.length >= 1 && digits.length <= 2) return Number(digits) > 0 ? Number(digits) : null;
    rest = rest.slice(at + 4);
  }
  return null;
}

const saysReuse = (words: string): boolean => words.toLowerCase().split(/[^\p{L}\p{N}-]/u).some((word) => ["reuse", "re-use", "reused", "re-used", "reuses"].includes(word.replace(/^-+|-+$/g, "")));

/** The links in a line, without the punctuation a sentence leaves after one. */
export function urls(given: string): string[] {
  const out: string[] = [];
  let rest = given;
  for (let at = rest.indexOf("http"); at >= 0; at = rest.indexOf("http")) {
    const tail = rest.slice(at);
    if (!tail.startsWith("https://") && !tail.startsWith("http://")) {
      rest = rest.slice(at + 4);
      continue;
    }
    const end = tail.search(/[\s"'<>()[\]`]/);
    const url = (end < 0 ? tail : tail.slice(0, end)).replace(/[.,;:!?*_]+$/, "");
    if (url.length > "https://".length) out.push(url);
    rest = end < 0 ? "" : tail.slice(end);
  }
  return out;
}

/** Google's "https://www.google.com/url?q=…" redirect, taken off. */
export function unwrapRedirect(url: string): string {
  if (!url.includes("google.com/url?")) return url;
  const target = url.split(/[?&]/).find((pair) => pair.startsWith("q="));
  return target === undefined ? url : decode(target.slice(2));
}

/** The same video or Doc, however its link is written. */
function sameVideo(a: string, b: string): boolean {
  const hints = (url: string) => {
    const query = url.includes("?") ? url.slice(url.indexOf("?") + 1).split("#")[0]! : "";
    const value = (name: string) => query.split("&").find((pair) => pair.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
    return `${value("t")}|${value("start")}|${value("end")}`;
  };
  return key(a) === key(b) && hints(a) === hints(b);
}

function key(url: string): string {
  if (isDoc(url)) return `doc ${url.split("docs.google.com/document/d/")[1]!.split(/[/?#]/)[0]}`;
  try {
    const link = drive.parse(url);
    return `${link.kind === "file" ? "drive" : "folder"} ${link.id}`;
  } catch {
    // Not Drive.
  }
  const [path, query = ""] = url.split("?", 2) as [string, string?];
  const id = query.split("&").find((pair) => pair.startsWith("v="))?.slice(2);
  if (id !== undefined) return `yt ${id}`;
  return `yt ${path.replace(/\/+$/, "").split("/").pop() ?? path}`;
}

/** Hosts whose pages are never a case's article, as Repack's NOT_ARTICLE. */
const NOT_ARTICLE = ["google.com", "youtube.com", "youtu.be", "trello.com", "dropbox.com", "facebook.com", "instagram.com", "tiktok.com", "x.com", "twitter.com", "reddit.com", "evidence.com", "evidencelibrary.com", "justfoia.com", "nextrequest.com", "govqa.us", "visuallabsinc.com"];

/** A case card's footage (its first Drive folder, or failing that its first Drive video) and article (its first link to any other page). */
export function caseLinks(description: string, attachments: string[]): [string | null, string | null] {
  const all = [...description.split("\n").flatMap(urls), ...attachments.flatMap(urls)].map(unwrapRedirect);
  const driven = all.flatMap((url): [string, boolean][] => {
    try {
      const link = drive.parse(url);
      return [link.kind === "folder" ? [`https://drive.google.com/drive/folders/${link.id}`, true] : [`https://drive.google.com/file/d/${link.id}/view`, false]];
    } catch {
      return [];
    }
  });
  const footage = (driven.find(([, folder]) => folder) ?? driven[0])?.[0] ?? null;
  const article =
    all.find((url) => {
      if (!url.startsWith("https://")) return false;
      const rest = url.slice(8);
      const slash = rest.indexOf("/");
      const host = (slash < 0 ? rest : rest.slice(0, slash)).toLowerCase();
      const path = (slash < 0 ? "" : rest.slice(slash + 1)).split(/[?#]/)[0]!;
      return path !== "" && !NOT_ARTICLE.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
    }) ?? null;
  return [footage, article];
}
