// Scripts: read a Google Doc (footage ranges linked to Google
// Drive files and the narration between them), download the footage from
// Drive, and lay the edit out in order: each range as a clip, each narration
// as a cut-in card.
//
// Requests go out through Bun's fetch. Redirects are followed by hand so a Google
// call never leaves https (unless a stand-in over http is set, endpoints.ts),
// as curl's `--proto` / `--proto-redir` held it. Drive's "can't scan this
// file for viruses" page is skipped with `confirm=t`, or by following its form.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import { parseTranscript } from "./captions_core.ts";
import { clipFrom, textStyleFrom } from "./clips.ts";
import * as diag from "./diag.ts";
import * as endpoints from "./endpoints.ts";
import { nowMs } from "./files.ts";
import { catchBugsAsync, crashed, isBug } from "./guard.ts";
import { importMade, importPaths } from "./import.ts";
import * as mediaModule from "./media.ts";
import { cloudEnabled } from "./relay.ts";
import type { ClipColor, Project, Script, ScriptBlock, ScriptJob, TextStyle, TrackKind } from "./model.ts";
import { addTrack, clipOf, duration as projectDuration, fps as fpsOf, freshId, marksCut, mediaOf, REUSE_LABEL } from "./project.ts";
import { fileName, fileStem, extension as pathExtension, join, parent } from "./paths.ts";
import { byteLength, charCount, display, f32, isAlphanumeric, isWhitespace, parseHex, round, splitWhitespace, takeChars, trim } from "./rust.ts";
import * as seams from "./seams.ts";
import type { DriveHead, Excerpt, Parsed } from "./seams.ts";
import * as tools from "./tools.ts";
import type { Word } from "./transcribe.ts";
import * as youtube from "./youtube.ts";

export type { DriveHead, Excerpt, Parsed } from "./seams.ts";

/** How long a cut-in card holds when there's no voice-over yet. */
export const CUT_IN_SECONDS = 3.0;

/** Waits (tests make them instant). */
export const timing = {
  sleep: (ms: number) => Bun.sleep(ms),
  now: () => performance.now(),
};

// ---------------------------------------------------------------------------
// Reading the Doc.

/** The document id in a Google Docs link. */
export function docId(url: string): string | null {
  const at = url.indexOf("/document/d/");
  if (at < 0) return null;
  const id = idChars(url.slice(at + "/document/d/".length));
  return id.length > 10 ? id : null;
}

/** The file id in a Google Drive link (`/file/d/ID/…`, `open?id=ID`, `uc?id=ID`). */
export function driveFileId(url: string): string | null {
  if (!url.includes("drive.google.com") && !url.includes("drive.usercontent.google.com")) return null;
  const at = url.indexOf("/file/d/");
  let id: string;
  if (at >= 0) {
    id = idChars(url.slice(at + "/file/d/".length));
  } else {
    const value = query(url, "id");
    if (value === null) return null;
    id = idChars(value);
  }
  return id.length > 10 ? id : null;
}

function idChars(text: string): string {
  let out = "";
  for (const c of text) {
    if (/^[A-Za-z0-9_-]$/.test(c)) out += c;
    else break;
  }
  return out;
}

/**
 * A query parameter's raw value. A query value runs to the next `&` (Docs
 * leaves the `?` inside `q=` unescaped).
 */
export function query(url: string, key: string): string | null {
  const question = url.indexOf("?");
  if (question < 0) return null;
  const search = url.slice(question + 1).split("#")[0]!;
  const needle = `${key}=`;
  let from = 0;
  for (;;) {
    const at = search.indexOf(needle, from);
    if (at < 0) return null;
    const before = at === 0 ? undefined : search[at - 1];
    if (before === undefined || before === "&" || before === "?") {
      return search.slice(at + needle.length).split("&")[0]!;
    }
    from = at + 1;
  }
}

/**
 * Fetches `url` (a Google call), following redirects by hand so none leaves
 * the protocols curl's `--proto` / `--proto-redir` allowed.
 */
async function googleFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const allowHttp = endpoints.googleProto() === "=http,https";
  let current = url;
  for (let hops = 0; hops <= 50; hops++) {
    const scheme = current.slice(0, current.indexOf(":")).toLowerCase();
    if (!(scheme === "https" || (allowHttp && scheme === "http"))) {
      throw new Error(`Protocol "${scheme}" not supported or disabled in libcurl`);
    }
    const response = await fetch(current, { ...init, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      void response.body?.cancel();
      current = new URL(location, current).toString();
      continue;
    }
    Object.defineProperty(response, "url", { value: current });
    return response;
  }
  throw new Error("Maximum (50) redirects followed");
}

/** A response's body as bytes, giving up past `max` bytes (curl's --max-filesize). */
async function boundedBody(response: Response, max: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > max) {
    void response.body?.cancel();
    throw new Error("Maximum file size exceeded");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body !== null) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > max) throw new Error("Maximum file size exceeded");
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

/**
 * Fetches a Doc that's shared with anyone who has the link, as HTML (which
 * keeps each link's target), and its title (the export's file name).
 */
export async function fetchDoc(id: string): Promise<[html: string, title: string]> {
  const url = endpoints.google(`https://docs.google.com/document/d/${id}/export?format=html`);
  const problem = "Couldn't read that Google Doc. Share it so anyone with the link can view, then try again.";
  let body: string;
  let code: number;
  let effective: string;
  let disposition: string;
  try {
    const response = await googleFetch(url, { signal: AbortSignal.timeout(30_000) });
    code = response.status;
    effective = response.url;
    disposition = response.headers.get("content-disposition") ?? "";
    body = new TextDecoder().decode(await boundedBody(response, 20_000_000));
  } catch {
    throw new Error(problem);
  }
  if (code !== 200 || effective.includes("accounts.google.com") || !body.includes("<body")) throw new Error(problem);
  let title = dispositionName(disposition) ?? "";
  while (title.endsWith(".html")) title = title.slice(0, -".html".length);
  return [body, title];
}

/**
 * One paragraph of the Doc: its text, which ranges of it link where, and the
 * comment markers ([a], [b]…) at their offsets.
 */
interface Para {
  text: string;
  links: [number, number, string][];
  refs: [number, string][];
}

function newPara(): Para {
  return { text: "", links: [], refs: [] };
}

/** Google Docs' HTML export: paragraphs, links, and the comments at the end. */
function readHtml(html: string): [string, Para[], Map<string, string>] {
  let title = "";
  const paras: Para[] = [];
  const comments = new Map<string, string>();
  const addComment = (id: string, text: string) => comments.set(id, (comments.get(id) ?? "") + text);
  let current: Para | null = null;
  let link: [number, string] | null = null;
  let marker = false;
  let comment: string | null = null;
  let inTitle = false;
  let hidden = false;
  let rest = html;
  while (rest !== "") {
    if (rest.startsWith("<")) {
      const open = rest.slice(1);
      const close = open.indexOf(">");
      const tag = close < 0 ? open : open.slice(0, close);
      rest = close < 0 ? "" : open.slice(close + 1);
      const closing = tag.startsWith("/");
      let name = "";
      for (const c of tag.replace(/^\/+/, "")) {
        if (/^[A-Za-z0-9]$/.test(c)) name += c;
        else break;
      }
      name = name.toLowerCase();
      switch (name) {
        case "title":
          inTitle = !closing;
          break;
        case "style":
        case "script":
          hidden = !closing;
          break;
        case "p":
        case "li":
        case "h1":
        case "h2":
        case "h3":
        case "h4":
        case "h5":
        case "h6": {
          if (current !== null) {
            const para: Para = current;
            current = null;
            if (comment !== null) addComment(comment, "\n");
            else paras.push(para);
          }
          if (!closing) current = newPara();
          break;
        }
        case "br":
          if (current !== null) current.text += "\n";
          break;
        case "a": {
          if (closing) {
            if (marker) {
              marker = false;
            } else if (link !== null && current !== null) {
              const [start, href] = link;
              link = null;
              current.links.push([start, current.text.length, href]);
            } else {
              link = null;
            }
            break;
          }
          const rawHref = attribute(tag, "href");
          const href = rawHref === null ? null : decodeEntities(rawHref);
          const id = attribute(tag, "id");
          if (href !== null && id !== null && href.startsWith("#cmnt_ref")) {
            // A comment's own text starts here (href back to its marker).
            comment = id;
            marker = true;
          } else if (href !== null && id !== null && href.startsWith("#cmnt")) {
            // A comment marker in the text.
            if (current !== null) current.refs.push([current.text.length, href.startsWith("#") ? href.slice(1) : href]);
            marker = true;
          } else if (href !== null && !href.startsWith("#")) {
            const start = current === null ? 0 : current.text.length;
            link = [start, unwrapGoogleRedirect(href)];
          }
          break;
        }
        default:
          break;
      }
    } else {
      const end = rest.indexOf("<");
      const raw = end < 0 ? rest : rest.slice(0, end);
      rest = end < 0 ? "" : rest.slice(end);
      const text = decodeEntities(raw);
      if (hidden || marker) continue;
      if (inTitle) title += text;
      else if (comment !== null) addComment(comment, text);
      else if (current !== null) current.text += text;
    }
  }
  if (current !== null && comment === null) paras.push(current);
  return [trim(title), paras, comments];
}

/** An attribute's raw value in a tag (` name="…"`). */
function attribute(tag: string, name: string): string | null {
  const needle = ` ${name}="`;
  const at = tag.indexOf(needle);
  if (at < 0) return null;
  const rest = tag.slice(at + needle.length);
  const end = rest.indexOf('"');
  return end < 0 ? null : rest.slice(0, end);
}

/** Docs wraps links as google.com/url?q=<target>. */
function unwrapGoogleRedirect(href: string): string {
  if (href.includes("google.com/url?")) {
    const target = query(href, "q");
    if (target !== null) return percentDecode(target);
  }
  return href;
}

/** `%xx` escapes decoded byte by byte (a `%` not followed by two hex digits stays). */
export function percentDecode(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  const out: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const byte = bytes[i]!;
    if (byte === 0x25 && i + 2 < bytes.length) {
      // Not two hex digits (or not even whole characters): a plain `%`.
      const high = bytes[i + 1]!;
      const low = bytes[i + 2]!;
      const decoded = high < 0x80 && low < 0x80 ? parseHex(String.fromCharCode(high, low), 0xff) : null;
      if (decoded !== null) {
        out.push(decoded);
        i += 3;
        continue;
      }
    }
    out.push(byte);
    i += 1;
  }
  return new TextDecoder().decode(new Uint8Array(out));
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
  ndash: "–",
  mdash: "—",
  hellip: "…",
};

/** A decimal or hex number as `u32::from_str` / `from_str_radix` read it (an optional `+`). */
function parseU32(text: string, radix: 10 | 16): number | null {
  if (radix === 16) return parseHex(text);
  if (!/^\+?[0-9]+$/.test(text)) return null;
  const value = Number(text.startsWith("+") ? text.slice(1) : text);
  return value <= 0xffff_ffff ? value : null;
}

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  let out = "";
  let rest = text;
  for (;;) {
    const amp = rest.indexOf("&");
    if (amp < 0) break;
    out += rest.slice(0, amp);
    const after = rest.slice(amp + 1);
    // An entity is short: its `;` comes within the next few bytes.
    const semi = after.indexOf(";");
    if (semi < 0 || byteLength(after.slice(0, semi)) >= 11) {
      out += "&";
      rest = after;
      continue;
    }
    const entity = after.slice(0, semi);
    const tail = after.slice(semi + 1);
    let decoded: string | null = Object.hasOwn(NAMED, entity) ? NAMED[entity]! : null;
    if (decoded === null) {
      let code: number | null = null;
      if (entity.startsWith("#x")) code = parseU32(entity.slice(2), 16);
      if (code === null && entity.startsWith("#")) code = parseU32(entity.slice(1), 10);
      if (code !== null && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) decoded = String.fromCodePoint(code);
    }
    if (decoded !== null) {
      out += decoded === " " ? " " : decoded;
      rest = tail;
    } else {
      out += "&";
      rest = after;
    }
  }
  return out + rest;
}

/** A "mm:ss - mm:ss" (or h:mm:ss) range in text: its span and seconds. */
interface Range {
  start: number;
  end: number;
  from: number;
  to: number;
}

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

function countDigits(text: string, from: number): number {
  let count = 0;
  while (isDigit(text[from + count])) count += 1;
  return count;
}

/** Parses "m:ss" / "mm:ss" / "h:mm:ss" at `at` in `text`: (seconds, characters used). */
function timestamp(text: string, at: number): [number, number] | null {
  const parts: number[] = [];
  let used = 0;
  for (;;) {
    const digits = countDigits(text, at + used);
    if (digits === 0 || digits > 2 || (parts.length > 0 && digits !== 2)) return null;
    parts.push(Number(text.slice(at + used, at + used + digits)));
    used += digits;
    if (parts.length < 3 && text[at + used] === ":" && isDigit(text[at + used + 1])) used += 1;
    else break;
  }
  if (parts.length < 2 || parts.slice(1).some((part) => part >= 60)) return null;
  return [parts.reduce((total, part) => total * 60 + part, 0), used];
}

const DASHES = ["-", "–", "—", "‑", "‐", "−"];

export function findRanges(text: string): Range[] {
  const ranges: Range[] = [];
  let at = 0;
  while (at < text.length) {
    let start = -1;
    for (let index = at; index < text.length; index++) {
      if (isDigit(text[index])) {
        start = index;
        break;
      }
    }
    if (start < 0) break;
    const before = start > 0 ? text[start - 1] : undefined;
    const afterDigit = isDigit(before) || before === ":";
    const first = afterDigit ? null : timestamp(text, start);
    if (first !== null) {
      const [from, used] = first;
      let cursor = start + used;
      const skip = () => {
        for (;;) {
          const c = text.codePointAt(cursor);
          if (c === undefined) return;
          const char = String.fromCodePoint(c);
          if (!(isWhitespace(char) || char === " ")) return;
          cursor += char.length;
        }
      };
      skip();
      const dash = text[cursor];
      if (dash !== undefined && DASHES.includes(dash)) {
        cursor += 1;
        skip();
        const second = timestamp(text, cursor);
        if (second !== null) {
          const [to, used2] = second;
          const end = cursor + used2;
          if (to > from) ranges.push({ start, end, from, to });
          at = end;
          continue;
        }
      }
    }
    at = start + Math.max(countDigits(text, start), 1);
  }
  return ranges;
}

function collapse(text: string): string {
  let out = "";
  text.split("\n").forEach((raw, index) => {
    const line = splitWhitespace(raw).join(" ");
    if (index > 0 && line !== "" && out !== "") out += "\n";
    out += line;
  });
  return trim(out);
}

/**
 * The comments on a stretch of text, minus resolved ones: a reply of
 * "fixed"/"done" closes the note before it.
 */
function notes(refs: [number, string][], comments: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [, id] of refs) {
    const raw = comments.get(id);
    if (raw === undefined) continue;
    const text = collapse(raw);
    if (text === "") continue;
    const lower = text.replace(/[A-Z]/g, (c) => c.toLowerCase()).replace(/[.!]+$/, "");
    if (["fixed", "done", "resolved", "ok", "okay"].includes(lower)) out.pop();
    else out.push(text);
  }
  return out;
}

/** The label of a footage block that plays a reused video whole (a narration's "Reuse: <link>" note). */
export const REUSE = REUSE_LABEL;

/**
 * A narration's note naming another case's script ("Edit case 2 based on
 * this script here: <Doc link>"): the Doc's id, else null.
 */
export function caseScript(note: string): string | null {
  if (!/\bscript\b/i.test(note)) return null;
  const link = /https:\/\/docs\.google\.com\/document\/d\/[\w-]+\S*/.exec(note)?.[0];
  return link === undefined ? null : docId(link);
}

/**
 * Reads a compilation's case scripts in, each after the narration whose note
 * named it (that Doc's title and heading dropped, its notes on further cases
 * not followed), and clears `cases`.
 */
export async function joinCases(parsed: Parsed, read: (id: string) => Promise<string> = async (id) => (await fetchDoc(id))[0]): Promise<Parsed> {
  const cases = parsed.cases ?? [];
  delete parsed.cases;
  for (const { after, doc } of [...cases].reverse()) {
    const blocks = parse(await read(doc)).blocks;
    if (!blocks.some((block) => block.kind === "footage")) throw new Error(`The case script ${doc} has no footage timestamps linked to Google Drive or YouTube.`);
    parsed.blocks.splice(after, 0, ...blocks);
  }
  return parsed;
}

/** The script file a footage link names: a Drive file id, or `youtube:<id>`. */
export function footageFile(url: string): string | null {
  return driveFileId(url) ?? youtube.fileOf(url);
}

/** A link's `t=` in seconds: Drive's `91.506`, YouTube's `86`, `86s` or `1m26s`. */
function linkStart(url: string): number | null {
  const t = query(url, "t");
  if (t === null) return null;
  return youtube.videoId(url) !== null ? youtube.startOf(t) : parseF64(t.replace(/s+$/, ""));
}

/**
 * The narration in text beside ranges in one paragraph (a Doc that runs the
 * cut-ins on from the ranges, "…the investigation. (0:42 - 2:52)The
 * investigation proved…"): words, not the brackets and pluses between ranges.
 */
function besideRanges(text: string): string | null {
  const words = text.match(/\p{L}[\p{L}'’]*/gu) ?? [];
  if (words.length < 3) return null;
  const cleaned = collapse(text)
    .replace(/^[\s()[\]+&,]+/u, "")
    .replace(/[\s([+&,]+$/u, "");
  return cleaned === "" ? null : cleaned;
}

/** Reads a script Doc's HTML export into footage ranges and narration. */
export function parse(html: string): Parsed {
  const [title, paras, comments] = readHtml(html);
  // A range without its own link belongs to the last linked file (or the only one).
  const files: [string, string][] = [];
  for (const para of paras) {
    for (const [, , url] of para.links) {
      const id = footageFile(url);
      if (id !== null) files.push([url, id]);
    }
  }
  const only = new Set(files.map(([, id]) => id)).size === 1 ? (files[0] ?? null) : null;
  let last: [string, string] | null = only;
  const blocks: ScriptBlock[] = [];
  const cases: { after: number; doc: string }[] = [];
  let seenFootage = false;
  // "Reuse: <link>" on a narration: a finished video of ours plays after it,
  // whole (its range is set to the whole file once it's downloaded).
  const reuse = (found: string[]) => {
    for (const note of found) {
      const link = /^reuse:\s*(\S+)/i.exec(note)?.[1];
      const file = link === undefined ? null : footageFile(link);
      if (link === undefined || file === null) continue;
      blocks.push({ kind: "footage", url: link, file, start: 0, end: 1, label: REUSE, notes: [note] });
    }
  };
  // "Edit case 2 based on this script here: <Doc>": that case comes next,
  // and the narration after it is a cut-in of its own.
  let caseBreak = false;
  const caseNotes = (found: string[]) => {
    for (const note of found) {
      const doc = caseScript(note);
      if (doc === null) continue;
      cases.push({ after: blocks.length, doc });
      caseBreak = true;
    }
  };
  // Paragraphs of narration one after another are one cut-in; narration
  // written on from ranges starts its own (`own`): a hook paragraph followed
  // by a paragraph that runs the setup on into the hearing is two cut-ins.
  const narrate = (text: string, found: string[], own = false) => {
    const previous = blocks[blocks.length - 1];
    const after = caseBreak;
    caseBreak = false;
    if (!own && !after && previous !== undefined && previous.kind === "narration") {
      previous.text += `\n\n${text}`;
      previous.notes = [...(previous.notes ?? []), ...found];
    } else {
      blocks.push({ kind: "narration", text, notes: found });
    }
  };
  for (const para of paras) {
    const ranges = findRanges(para.text);
    if (ranges.length === 0) {
      const text = collapse(para.text);
      // The video opens on the first timestamp: anything before it is the
      // Doc's heading (title, "Assets:", durations), never a cut-in.
      // A line of no words ("—", "__") only separates parts of the Doc.
      if (text === "" || !seenFootage || !/[\p{L}\p{N}]/u.test(text)) continue;
      const found = notes(para.refs, comments);
      narrate(text, found);
      reuse(found);
      caseNotes(found);
      continue;
    }
    // Narration written on from the ranges in the same paragraph: before,
    // between and after them, in order.
    const said = (from: number, to: number) => (seenFootage ? besideRanges(para.text.slice(from, to)) : null);
    const gaps = ranges.map((range, index) => said(index === 0 ? 0 : ranges[index - 1]!.end, range.start));
    const tail = ranges.length > 0 ? said(ranges[ranges.length - 1]!.end, para.text.length) : null;
    seenFootage = true;
    ranges.forEach((range, index) => {
      const gap = gaps[index];
      const gapFrom = index === 0 ? 0 : ranges[index - 1]!.end;
      if (gap !== null && gap !== undefined) {
        narrate(gap, notes(para.refs.filter(([at]) => at >= gapFrom && at < range.start), comments), true);
      }
      let linked: [string, string] | null = null;
      for (const [start, end, url] of para.links) {
        if (start < range.end && end > range.start) {
          const id = footageFile(url);
          if (id !== null) {
            linked = [url, id];
            break;
          }
        }
      }
      const chosen: [string, string] | null = linked ?? last;
      if (chosen === null) return;
      const [url, file] = chosen;
      last = [url, file];
      // The link's ?t= is the exact start (the text rounds to the second).
      const exact = linkStart(url);
      const start = exact !== null && Math.abs(exact - range.from) <= 2 ? exact : range.from;
      // Its notes: from the range (or the paragraph's start) to the next range or narration.
      const nextGap = gaps[index + 1];
      const next =
        index + 1 < ranges.length
          ? nextGap !== null && nextGap !== undefined
            ? range.end
            : ranges[index + 1]!.start
          : tail !== null
            ? range.end
            : Number.MAX_SAFE_INTEGER;
      const from = index === 0 && (gap === null || gap === undefined) ? 0 : range.start;
      const refs = para.refs.filter(([at]) => at >= from && at < next);
      const rangeNotes = notes(refs, comments);
      const block: ScriptBlock = {
        kind: "footage",
        url,
        file,
        start,
        end: Math.max(range.to, start + 0.1),
        label: collapse(para.text.slice(range.start, range.end)).replace(/[‑–—]/g, "-"),
        notes: rangeNotes,
      };
      const words = cueWords(rangeNotes);
      if (words !== null) block.words = words;
      blocks.push(block);
    });
    if (tail !== null) {
      const after = ranges[ranges.length - 1]!.end;
      const found = notes(para.refs.filter(([at]) => at >= after), comments);
      narrate(tail, found, true);
      reuse(found);
      caseNotes(found);
    }
  }
  return cases.length > 0 ? { title, blocks, cases } : { title, blocks };
}

/** `str::parse::<f64>`: the whole text a decimal number (or inf/NaN), else null. */
export function parseF64(text: string): number | null {
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return Number(text);
  const lower = text.toLowerCase().replace(/^[+-]/, "");
  if (lower === "inf" || lower === "infinity") return text.startsWith("-") ? -Infinity : Infinity;
  if (lower === "nan") return Number.NaN;
  return null;
}

/**
 * The first and last words of a range's "first words....last words" comment
 * (editors write where a range starts and ends this way).
 */
export function cueWords(found: string[]): [string, string] | null {
  for (const note of found) {
    let split = note.indexOf("..");
    let width = 2;
    if (split < 0) {
      split = note.indexOf("…");
      width = 1;
    }
    if (split < 0) continue;
    const left = note.slice(0, split).replace(/\.+$/, "");
    const right = note.slice(split + width).replace(/^[.…]+/, "");
    const first = splitWhitespace(left)[0];
    const lastWord = splitWhitespace(right).at(-1);
    if (first === undefined || lastWord === undefined) continue;
    return [first, lastWord];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Precise cuts: the Doc rounds ranges to the second, so each range is cut at
// its first and last words as the transcript times them.

/** Room left before the first word and after the last, so cuts breathe. */
export const WORD_PAD = 0.08;
/**
 * Speech closer than this to the cut runs straight on: no room is left (it
 * would catch the next word), and the cut goes in the quietest instant
 * within `SETTLE` of the word's edge (transcript times are a little loose).
 */
const RUN_ON = 0.3;
const SETTLE = 0.06;
/** How far from the written time a cue word may be found. */
const CUE_SEARCH = 3.0;

function normalize(word: string): string {
  let out = "";
  for (const c of word) if (isAlphanumeric(c)) out += c.toLowerCase();
  return out;
}

/** A cue word that's spoken: "*Victim groans*" describes a sound, not a word. */
function spoken(word: string): string | null {
  if (/^[*([]/.test(word) || /[*)\]]$/.test(word)) return null;
  const normal = normalize(word);
  return normal === "" ? null : normal;
}

/**
 * How well a transcript word matches a cue word from the Doc: 0 the same, 1
 * the same word spelt a little differently (a plural or possessive, "priuses"
 * for "Prius", or a letter or two off), null not it. Short words must match
 * exactly.
 */
export function likeness(given: string, cue: string): number | null {
  const word = normalize(given);
  if (word === cue) return 0;
  const shortest = Math.min(charCount(word), charCount(cue));
  if (shortest < 4) return null;
  const stem = (text: string) => {
    let out = text;
    if (out.endsWith("es") && byteLength(out.slice(0, -2)) >= 3) out = out.slice(0, -2);
    if (out.endsWith("s") && byteLength(out.slice(0, -1)) >= 3) out = out.slice(0, -1);
    return out;
  };
  const a = stem(word);
  const b = stem(cue);
  const allowed = shortest >= 8 ? 2 : 1;
  return a === b || a === cue || b === word || editDistance(a, b) <= allowed ? 1 : null;
}

/** Levenshtein distance. */
function editDistance(a: string, b: string): number {
  const bs = [...b];
  const row = Array.from({ length: bs.length + 1 }, (_, index) => index);
  [...a].forEach((ca, i) => {
    let previous = i;
    let left = i + 1;
    for (let j = 1; j < row.length; j++) {
      const here = row[j]!;
      row[j] = Math.min(previous + (ca !== bs[j - 1] ? 1 : 0), left + 1, here + 1);
      previous = here;
      left = row[j]!;
    }
    row[0] = i + 1;
  });
  return row[row.length - 1] ?? 0;
}

/**
 * The quietest moment between `from` and `to` (seconds) in a media file's
 * peaks (one level per 1/`PEAKS_PER_SECOND` s), nearest `near` among equals.
 */
function quietest(peaks: Uint8Array, from: number, to: number, near: number): number | null {
  const rate = mediaModule.PEAKS_PER_SECOND;
  if (peaks.length === 0) return null;
  const first = Math.trunc(Math.max(Math.ceil(from * rate), 0));
  const last = Math.min(Math.trunc(Math.max(Math.floor(to * rate), 0)), peaks.length - 1);
  let best: [number, number] | null = null;
  for (let index = first; index <= last; index++) {
    const level = peaks[index];
    if (level === undefined) continue;
    const at = index / rate;
    if (best === null || level < best[0] || (level === best[0] && Math.abs(at - near) < Math.abs(best[1] - near))) {
      best = [level, at];
    }
  }
  return best === null ? null : best[1];
}

/**
 * Finds a range's first and last words near where it's written to start and
 * end (the same word, else the closest spelling of it), and returns where to
 * cut: just before the first, just after the last (never into a neighbouring
 * word; when speech runs straight on, right at the word, in the quietest
 * instant `peaks` show there). Times are in the transcript's clock.
 */
export function align(
  words: Word[],
  peaks: Uint8Array | null,
  cue: [string, string],
  start: number,
  end: number,
): [number | null, number | null] {
  const nearest = (wanted: string | null, time: number, at: (word: Word) => number): number | null => {
    if (wanted === null) return null;
    let best: [number, number, number] | null = null;
    words.forEach((word, index) => {
      const distance = Math.abs(at(word) - time);
      if (distance > CUE_SEARCH) return;
      const score = likeness(word.text, wanted);
      if (score === null) return;
      if (best === null || score < best[0] || (score === best[0] && distance < best[1])) best = [score, distance, index];
    });
    return best === null ? null : (best as [number, number, number])[2];
  };
  // A range written "…-02:03" ends somewhere in that second.
  const first = nearest(spoken(cue[0]), start, (word) => word.start);
  const last = nearest(spoken(cue[1]), end + 0.5, (word) => word.end);
  let cutIn: number | null = null;
  if (first !== null) {
    const word = words[first]!;
    const previous = first > 0 ? words[first - 1] : undefined;
    const before = previous !== undefined && previous.end <= word.start ? previous.end : null;
    let cut: number;
    if (before !== null && word.start - before < RUN_ON) {
      const found =
        peaks === null
          ? null
          : quietest(peaks, Math.max(word.start - SETTLE, before), word.start + Math.min(SETTLE, word.end - word.start) / 2, word.start);
      cut = found ?? word.start;
    } else {
      cut = Math.max(word.start - WORD_PAD, before ?? -Number.MAX_VALUE);
    }
    cutIn = Math.max(cut, 0);
  }
  let cutOut: number | null = null;
  if (last !== null) {
    const word = words[last]!;
    const next = words[last + 1];
    const after = next !== undefined && next.start >= word.end ? next.start : null;
    if (after !== null && after - word.end < RUN_ON) {
      const found =
        peaks === null
          ? null
          : quietest(peaks, word.end - Math.min(SETTLE, word.end - word.start) / 2, Math.min(word.end + SETTLE, after), word.end);
      cutOut = found ?? word.end;
    } else {
      cutOut = Math.min(word.end + WORD_PAD, after ?? Number.MAX_VALUE);
    }
  }
  // Out before in: one side matched the wrong word.
  if (cutIn !== null && cutOut !== null && cutIn >= cutOut) return [null, null];
  return [cutIn, cutOut];
}

// ---------------------------------------------------------------------------
// Downloading from Google Drive.

type FileJob = ScriptJob["files"][number];
type JobState = ScriptJob["state"];

const RUNNING: JobState[] = ["downloading", "transcribing", "placing", "voicing"];

/** A job as it's always been written: its fields in order, the unset ones left out. */
function shownJob(job: ScriptJob): ScriptJob {
  const files = job.files.map((file) => {
    const shown: Record<string, unknown> = { file: file.file };
    if (file.name !== undefined) shown.name = file.name;
    shown.bytes = file.bytes;
    if (file.total !== undefined) shown.total = file.total;
    shown.state = file.state;
    if (file.error !== undefined) shown.error = file.error;
    return shown as unknown as FileJob;
  });
  return job.error === undefined ? { state: job.state, files } : { state: job.state, error: job.error, files };
}

/** Script imports in progress, per project. */
export class Jobs {
  private jobs = new Map<string, ScriptJob>();

  get(project: string): ScriptJob | null {
    const job = this.jobs.get(project);
    return job === undefined ? null : shownJob(job);
  }

  /** Starts a job for `project` unless one is running; whether it did. */
  claim(app: App, project: string, job: ScriptJob): boolean {
    const current = this.jobs.get(project);
    if (current !== undefined && RUNNING.includes(current.state)) return false;
    this.jobs.set(project, structuredClone(job));
    app.store.emit({ type: "script", id: project, job: shownJob(job) });
    return true;
  }

  /** Changes `project`'s job (one is made if there's none) and says so. */
  set(app: App, project: string, edit: (job: ScriptJob) => void): void {
    let job = this.jobs.get(project);
    if (job === undefined) {
      job = { state: "downloading", files: [] };
      this.jobs.set(project, job);
    }
    edit(job);
    app.store.emit({ type: "script", id: project, job: shownJob(job) });
  }
}

/** Asks for the first byte: the final headers say whether Drive will send the file (and its name and size) or a page instead. */
async function probe(url: string, scratch: string): Promise<DriveHead> {
  let response: Response;
  try {
    response = await googleFetch(url, { headers: { range: "bytes=0-0" }, signal: AbortSignal.timeout(60_000) });
  } catch {
    fs.rmSync(scratch, { force: true });
    return { status: 0, html: false, name: null, total: null };
  }
  void response.body?.cancel();
  fs.rmSync(scratch, { force: true });
  const status = response.status;
  const header = (name: string) => {
    const value = response.headers.get(name);
    return value === null ? null : trim(value);
  };
  let total: number | null = null;
  const range = header("content-range");
  if (range !== null) {
    const after = range.split("/").at(-1);
    total = after !== undefined && /^\d+$/.test(trim(after)) ? Number(trim(after)) : null;
  }
  if (total === null && status === 200) {
    const length = header("content-length");
    total = length !== null && /^\d+$/.test(length) ? Number(length) : null;
  }
  const disposition = header("content-disposition");
  return {
    status,
    html: (header("content-type") ?? "").startsWith("text/html"),
    name: disposition === null ? null : dispositionName(disposition),
    total,
  };
}

export function dispositionName(value: string): string | null {
  const star = value.split("filename*=")[1];
  if (star !== undefined) {
    const encoded = trim(star.split(";")[0]!).replace(/^"+|"+$/g, "");
    return percentDecode(encoded.split("''")[1] ?? encoded);
  }
  const plain = value.split("filename=")[1];
  if (plain === undefined) return null;
  const name = trim(plain.split(";")[0]!).replace(/^"+|"+$/g, "");
  return name === "" ? null : name;
}

/** A file name safe to write: no separators or leading dots. */
export function safeName(name: string): string {
  const cleaned = trim(name.replace(/[/\\:\0]/g, "_")).replace(/^\.+/, "");
  return cleaned === "" ? "footage.mp4" : cleaned;
}

/** The download link behind Drive's "can't scan for viruses" page, if this is that page. */
export function confirmLink(page: string): string | null {
  const at = page.indexOf('id="download-form"');
  if (at < 0) return null;
  let form = page.slice(at);
  const close = form.indexOf(">");
  if (close < 0) return null;
  const tag = form.slice(0, close);
  const rawAction = attribute(tag, "action");
  if (rawAction === null) return null;
  const action = decodeEntities(rawAction);
  // A Drive upload can itself contain HTML. Never let its form direct a
  // download at an arbitrary URL, local file or service on the editor's network.
  if (action !== "https://drive.usercontent.google.com/download") return null;
  form = form.split("</form>")[0]!;
  const fields: string[] = [];
  for (const input of form.split("<input").slice(1)) {
    if (!input.includes('type="hidden"')) continue;
    const name = attribute(input, "name");
    if (name === null) continue;
    fields.push(`${name}=${decodeEntities(attribute(input, "value") ?? "")}`);
  }
  return endpoints.google(`${action}?${fields.join("&")}`);
}

export function pageProblem(page: string): string {
  if (page.includes("Too many users") || page.includes("quota")) {
    return "Google Drive's download limit for this file is used up for today. Try later, or upload a copy.";
  }
  if (page.includes("accounts.google.com") || page.includes("ServiceLogin")) {
    return "This Drive file isn't shared. Set it so anyone with the link can view.";
  }
  return "Google Drive sent a page instead of the file.";
}

/**
 * Stops a download left running by an earlier (Rust) server, which would
 * write over the resumed one. Only a curl writing into this folder is touched.
 */
async function stopStale(dir: string): Promise<void> {
  let pid: number;
  try {
    const text = trim(fs.readFileSync(join(dir, ".pid"), "utf8"));
    if (!/^\d+$/.test(text)) return;
    pid = Number(text);
  } catch {
    return;
  }
  fs.rmSync(join(dir, ".pid"), { force: true });
  try {
    const ps = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "ignore" });
    const command = new TextDecoder().decode(ps.stdout);
    if (command.includes("curl") && command.includes(dir)) {
      process.kill(pid);
      await timing.sleep(300);
    }
  } catch {
    // Gone already.
  }
}

const downloads = new Map<string, Promise<unknown>>();

/** Runs `work` once nothing else holds `key` (one download per folder at a time). */
async function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = downloads.get(key) ?? Promise.resolve();
  const run = before.catch(() => undefined).then(work);
  const held = run.catch(() => undefined);
  downloads.set(key, held);
  try {
    return await run;
  } finally {
    if (downloads.get(key) === held) downloads.delete(key);
  }
}

/** Statuses curl's `--retry` asks again after. */
const TRANSIENT = [408, 429, 500, 502, 503, 504, 522, 524];

/**
 * Downloads one Drive file into `dir` (resuming a partial download), calling
 * `progress(bytes, total, name)` as it goes. Finished files are reused.
 */
export function download(
  dir: string,
  file: string,
  progress: (bytes: number, total: number | null, name: string) => void,
): Promise<string> {
  return exclusive(dir, async () => {
    fs.mkdirSync(dir, { recursive: true });
    try {
      const done = join(dir, trim(fs.readFileSync(join(dir, ".done"), "utf8")));
      if (fs.existsSync(done)) return done;
    } catch {
      // Not downloaded yet.
    }
    const [url, head] = await resolve(file, join(dir, ".probe"));
    const name = safeName(head.name ?? `${file}.mp4`);
    const part = join(dir, ".download");
    await stopStale(dir);
    const sizeOf = () => {
      try {
        return fs.statSync(part).size;
      } catch {
        return 0;
      }
    };
    const failure = await fetchResuming(url, part, () => progress(sizeOf(), head.total, name));
    const size = sizeOf();
    if (failure !== null) throw new Error(`Download stopped (${failure}). It resumes where it left off when you retry.`);
    if (head.total !== null && head.total !== size) throw new Error("The download ended early. Retry to resume it.");
    progress(size, head.total, name);
    const path = join(dir, name);
    fs.renameSync(part, path);
    fs.writeFileSync(join(dir, ".done"), name);
    return path;
  });
}

/**
 * `curl -L --fail -C - --retry 5 --retry-delay 3 -o part url`: appends what's
 * left to `part`, asking again after a dropped connection or a busy answer.
 * What went wrong in curl's words (without "curl: "), or null when it's all there.
 */
async function fetchResuming(url: string, part: string, tick: () => void): Promise<string | null> {
  let failure: string | null = null;
  for (let attempt = 0; attempt <= 5; attempt++) {
    if (attempt > 0) await timing.sleep(3000);
    let have = 0;
    try {
      have = fs.statSync(part).size;
    } catch {
      have = 0;
    }
    let response: Response;
    try {
      response = await googleFetch(url, have > 0 ? { headers: { range: `bytes=${have}-` } } : {});
    } catch (error) {
      failure = `(7) ${diag.messageOf(error)}`;
      continue;
    }
    if (have > 0 && response.status === 416) {
      void response.body?.cancel();
      return null;
    }
    if (response.status >= 400) {
      void response.body?.cancel();
      failure = `(22) The requested URL returned error: ${response.status}`;
      if (TRANSIENT.includes(response.status)) continue;
      return failure;
    }
    if (have > 0 && response.status !== 206) {
      void response.body?.cancel();
      return "(33) HTTP server doesn't seem to support byte ranges. Cannot resume.";
    }
    const out = fs.openSync(part, have > 0 ? "a" : "w");
    const timer = setInterval(() => {
      try {
        tick();
      } catch {
        // Progress is only shown.
      }
    }, 400);
    try {
      if (response.body !== null) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) fs.writeSync(out, chunk);
      }
      return null;
    } catch (error) {
      failure = `(56) ${diag.messageOf(error)}`;
    } finally {
      clearInterval(timer);
      fs.closeSync(out);
    }
  }
  return failure;
}

/**
 * What Drive serves for a file: the URL that downloads it (past the "can't
 * scan for viruses" page) and its headers (name, size). `scratch` is a file
 * the first-byte probe may write (removed again).
 */
export async function resolve(file: string, scratch: string): Promise<[url: string, head: DriveHead]> {
  let url = endpoints.google(`https://drive.usercontent.google.com/download?id=${file}&export=download&confirm=t`);
  let head = await probe(url, scratch);
  if (head.html) {
    let page = "";
    try {
      const response = await googleFetch(url, { signal: AbortSignal.timeout(30_000) });
      page = new TextDecoder().decode(await boundedBody(response, 5_000_000));
    } catch {
      page = "";
    }
    const link = confirmLink(page);
    if (link === null) throw new Error(pageProblem(page));
    url = link;
    head = await probe(url, scratch);
    if (head.html) throw new Error(pageProblem(""));
  }
  if (head.status === 403 || head.status === 401) {
    throw new Error("This Drive file isn't shared. Set it so anyone with the link can view.");
  }
  if (head.status === 404) throw new Error("Google Drive can't find this file (deleted, or in the trash).");
  if (head.status >= 400 || head.status === 0) throw new Error(`Google Drive answered ${head.status}.`);
  return [url, head];
}

// ---------------------------------------------------------------------------
// Excerpts: police footage runs for hours and a script uses minutes of it.
// Only what the script uses (with room to trim) becomes media, so proxies stay
// small. Cut losslessly from a keyframe, so timing is exact.

/** Footage kept either side of a range, for trimming. */
const HANDLE_SECONDS = 10.0;
/** Ranges closer than this share one excerpt. */
const MERGE_SECONDS = 120.0;

/** Runs a tool to the end: its stdout and stderr, and whether it succeeded. */
async function runTool(command: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { ok: code === 0, stdout, stderr };
}

/** Seconds of a file (or a presigned URL's object). */
export async function durationOf(path: string): Promise<number> {
  let output: { stdout: string };
  try {
    output = await runTool([
      tools.ffprobe(),
      "-v",
      "error",
      "-protocol_whitelist",
      tools.protocols(path),
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      ...tools.urlArgs(path),
      path,
    ]);
  } catch (error) {
    throw new Error(`ffprobe: ${diag.messageOf(error)}`);
  }
  const seconds = parseF64(trim(output.stdout));
  if (seconds === null) throw new Error(tools.isUrl(path) ? "couldn't read the footage in the cloud" : `couldn't read ${path}`);
  return seconds;
}

/** The last keyframe at or before `time` (an excerpt must start on one to be cut without re-encoding). */
export async function keyframeBefore(path: string, time: number): Promise<number> {
  for (const window of [20.0, 120.0, 600.0]) {
    const from = Math.max(time - window, 0);
    let text = "";
    try {
      const output = await runTool([
        tools.ffprobe(),
        "-v",
        "error",
        "-protocol_whitelist",
        tools.protocols(path),
        "-select_streams",
        "v:0",
        "-skip_frame",
        "nokey",
        "-show_entries",
        "frame=pts_time",
        "-of",
        "csv=p=0",
        "-read_intervals",
        `${display(from)}%${display(time + 0.001)}`,
        ...tools.urlArgs(path),
        path,
      ]);
      text = output.stdout;
    } catch {
      text = "";
    }
    let best: number | null = null;
    for (const line of text.split("\n")) {
      const pts = parseF64(trim(line).replace(/,+$/, ""));
      if (pts === null || !(pts <= time + 1e-6)) continue;
      best = best === null ? pts : Math.max(best, pts);
    }
    if (best !== null) return best;
    if (from === 0) break;
  }
  return 0;
}

/** Merged, padded spans of a file that `ranges` (seconds) need. */
export function spans(ranges: [number, number][], duration: number): [number, number][] {
  const sorted = ranges
    .map(([from, to]): [number, number] => [Math.max(from - HANDLE_SECONDS, 0), Math.min(to + HANDLE_SECONDS, duration)])
    .filter(([from, to]) => to > from)
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && from - last[1] < MERGE_SECONDS) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

/** An f64's bits as 16 hex digits (`{:016x}` of `to_bits`). */
function bitsHex(value: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16).padStart(16, "0");
}

let nextCut = 0;

/**
 * The extension of an excerpt cut from a file with `ext`: its own, unless its
 * container can't hold copied picture with AAC sound (a DVD's VOB or another
 * MPEG program stream, WebM), then MP4, which takes their picture as it is.
 */
export function excerptExtension(ext: string): string {
  return ["vob", "mpg", "mpeg", "m2p", "ps", "dat", "webm", "ogv"].includes(ext.toLowerCase()) ? "mp4" : ext;
}

/**
 * Cuts the parts of `source` that `ranges` need into excerpt files beside it
 * (reused if already cut). Footage mostly used anyway stays whole. Picture is
 * copied from a keyframe; sound is re-encoded so it starts on that same
 * instant (copied audio would begin earlier and shift everything).
 */
export async function excerpts(source: string, ranges: [number, number][]): Promise<Excerpt[]> {
  const duration = await durationOf(source);
  const needed = spans(ranges, duration);
  const used = needed.reduce((total, [from, to]) => total + (to - from), 0);
  if (needed.length === 0 || used >= duration * 0.6) return [{ path: source, from: 0, to: duration, cloud: null }];
  const dir = join(parent(source) ?? ".", "excerpts");
  fs.mkdirSync(dir, { recursive: true });
  const stem = takeChars(fileStem(source) ?? "footage", 20);
  const sourceKey = mediaModule.mediaKey(source);
  const ext = excerptExtension(pathExtension(source) ?? "mp4");
  const out: Excerpt[] = [];
  for (const [from, to] of needed) {
    const start = await keyframeBefore(source, from);
    const path = join(dir, `${stem} ${clock(start)}-${clock(to)}-${sourceKey}-${bitsHex(start)}-${bitsHex(to)}.${ext}`);
    if (!fs.existsSync(path)) {
      const partial = join(dir, `.cutting-${process.pid}-${nowMs()}-${nextCut++}.${ext}`);
      fs.closeSync(fs.openSync(partial, "wx"));
      try {
        await cut(source, start, to, partial);
        fs.renameSync(partial, path);
      } finally {
        fs.rmSync(partial, { force: true });
      }
    }
    out.push({ path, from: start, to, cloud: null });
  }
  return out;
}

/**
 * Cuts `start`..`to` seconds of `source` (a file or a presigned URL: FFmpeg
 * seeks before reading, so only that stretch is fetched) into `out`: picture
 * copied from the keyframe at `start`, sound re-encoded to start with it.
 */
export async function cut(source: string, start: number, to: number, out: string): Promise<void> {
  let output: { ok: boolean; stderr: string };
  try {
    output = await runTool([
      tools.ffmpeg(),
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-ss",
      display(start),
      "-protocol_whitelist",
      tools.protocols(source),
      ...tools.urlArgs(source),
      "-i",
      source,
      "-t",
      display(to - start),
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      out,
    ]);
  } catch (error) {
    throw new Error(`ffmpeg: ${diag.messageOf(error)}`);
  }
  if (!output.ok) {
    // FFmpeg's words, without the URL (a credential) it may repeat.
    diag.warn("script", `cutting an excerpt: ${diag.scrub(trim(output.stderr))}`);
    throw new Error("Couldn't cut an excerpt from the footage.");
  }
}

/** `1h02m03s`: a time in an excerpt's name. */
export function clock(seconds: number): string {
  const whole = Math.max(round(seconds), 0) || 0;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${Math.floor(whole / 3600)}h${two(Math.floor(whole / 60) % 60)}m${two(whole % 60)}s`;
}

/** The ranges (seconds) a project's script plays from one file. */
function fileRanges(project: Project, file: string): [number, number][] {
  return (project.script?.blocks ?? []).flatMap((block): [number, number][] =>
    block.kind === "footage" && block.file === file ? [[block.start, block.label === REUSE ? Number.MAX_SAFE_INTEGER : block.end]] : [],
  );
}

// ---------------------------------------------------------------------------
// The import: download every file, then lay the edit out.

/** Footage files the script needs that aren't media in the project yet, in script order. */
function missingFiles(project: Project): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const block of project.script?.blocks ?? []) {
    if (block.kind !== "footage") continue;
    if (block.media !== undefined && block.media !== null && mediaOf(project, block.media) !== undefined) continue;
    if (seen.has(block.file)) continue;
    seen.add(block.file);
    out.push(block.file);
  }
  return out;
}

/** Whether the script still has footage to fetch or blocks to place. */
export function unfinished(project: Project): boolean {
  const script = project.script;
  if (script === undefined || script === null) return false;
  // Only blocks never placed: one placed and since removed was removed on purpose.
  return missingFiles(project).length > 0 || script.blocks.some((block) => !placed(project, block));
}

/**
 * Whether a block was ever put on the timeline (since removed counts: on
 * purpose). A cut-in whose card id was cleared (cover_cut_in once did) but
 * whose voice-over is on the timeline was placed.
 */
export function placed(project: Project, block: ScriptBlock): boolean {
  if (block.kind === "footage") return isSome(block.clip);
  return isSome(block.clip) || (isSome(block.voiceover) && clipOf(project, block.voiceover) !== undefined);
}

function isSome<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}

/** What the agent is asked once a script is first laid out. */
export const RESEARCH =
  "The script is imported and laid out. Research the case now (RESEARCH in your house style): start from the script and the transcripts, find the news articles about this case, check each matches and save it, then collect images of the scene, the people involved and the vehicles, and weed out anything off-target so only real candidates wait for review. Don't change the timeline. Finish with a short summary: the key facts the articles add, how many articles you saved and how many images are waiting.";

// Transfer slots are independent from local media work and cloud exports.
// Across projects, at most three Drive→R2 jobs are followed at once. Local
// excerpt encodes keep a lane of their own rather than fighting for the Mac.
const cloudDownloads = new mediaModule.Semaphore(3);
const cloudExcerptLane = new mediaModule.Semaphore(1);

/**
 * Downloads the script's footage and lays the edit out. Safe to call again:
 * finished downloads are reused and placed blocks are skipped. Returns the
 * work started (tests wait on it), or null when there's nothing to start.
 */
export function start(app: App, projectId: string, recut: boolean): Promise<void> | null {
  const live = app.store.get(projectId);
  if (live === null) return null;
  const files = missingFiles(live.project);
  const job: ScriptJob = {
    state: "downloading",
    files: files.map((file) => ({ file, bytes: 0, state: "queued" })),
  };
  if (!app.scripts.claim(app, projectId, job)) return null;
  const id = projectId;
  const work = async () => {
    // As tokio::spawn: the job runs after the caller has answered with it (files still queued).
    await Promise.resolve();
    const fetched: ([string, Excerpt[]] | undefined)[] = new Array(files.length);
    const fetchOne = async (index: number, file: string) => {
      setFileState(app, id, index, "downloading");
      try {
        const [bytes, name, cut] = cloudEnabled()
          ? await footageToCloud(app, id, index, file)
          : await footageToDisk(app, id, index, file);
        app.scripts.set(app, id, (job) => {
          const entry = job.files[index];
          if (entry === undefined) return;
          entry.state = "done";
          entry.bytes = bytes;
          entry.total = bytes;
          if (name === null) delete entry.name;
          else entry.name = name;
        });
        fetched[index] = [file, cut];
      } catch (error) {
        if (isBug(error)) throw error;
        app.scripts.set(app, id, (job) => {
          const entry = job.files[index];
          if (entry === undefined) return;
          entry.state = "failed";
          entry.error = diag.messageOf(error);
        });
      }
    };
    if (cloudEnabled() && process.env.EDIT_PARALLEL_DOWNLOADS === "1") {
      await Promise.all(files.map((file, index) => cloudDownloads.with(() => fetchOne(index, file))));
    } else {
      for (const [index, file] of files.entries()) await fetchOne(index, file);
    }
    const done = fetched.filter((file): file is [string, Excerpt[]] => file !== undefined);
    app.scripts.set(app, id, (job) => {
      job.state = "placing";
    });
    let result: string | null = null;
    try {
      await diag.timeAsync("script", "script: lay out", () => place(app, id, done, recut));
    } catch (error) {
      if (isBug(error)) throw error;
      result = diag.messageOf(error);
    }
    const laidOut = result === null;
    // Laid out: the cut-ins get their voice-over, spoken and split across them.
    // Not a courtroom video's: its narration is the user's recording (styles.ts).
    const now = app.store.get(id);
    const unvoiced = now !== null && now.project.style !== "courtroom" && !seams.voiceover.anyPlaced(now.project);
    if (laidOut && unvoiced) {
      app.scripts.set(app, id, (job) => {
        job.state = "voicing";
      });
      try {
        await diag.timeAsync("script", "script: voice-over", () => seams.voiceover.generate(app, id));
      } catch (error) {
        if (isBug(error)) throw error;
        result = `The voice-over couldn't be made: ${diag.messageOf(error)}`;
      }
    }
    app.scripts.set(app, id, (job) => {
      const failed = job.files.filter((file) => file.state === "failed").length;
      job.state = result !== null || failed > 0 ? "failed" : "done";
      const error = result ?? (failed > 0 ? `${failed} of ${job.files.length} files couldn't be downloaded.` : null);
      if (error === null) delete job.error;
      else job.error = error;
    });
    // A new edit starts with the case's research, so the articles and images
    // are waiting by the time the editing gets to them.
    const home = app.store.home;
    const researched = seams.research.articles(home, id).length > 0 || seams.research.items(home, id).length > 0;
    if (laidOut && !recut && !researched) {
      try {
        await seams.agentPanel(app).send(id, RESEARCH, null, null);
      } catch (error) {
        diag.warn("script", `research didn't start for ${id}: ${diag.messageOf(error)}`);
      }
    }
  };
  // A crash fails the import instead of leaving it mid-way for good.
  return catchBugsAsync("the script import", work).catch((error: unknown) => {
    app.scripts.set(app, id, (job) => {
      job.state = "failed";
      job.error = isBug(error) ? crashed("the script import", error) : diag.messageOf(error);
    });
  });
}

/** A file's download progress, into its row of the job (a few times a second). */
function fileProgress(app: App, id: string, index: number): (bytes: number, total: number | null, name: string) => void {
  let last = timing.now() - 1000;
  return (bytes, total, name) => {
    if (timing.now() - last < 350) return;
    last = timing.now();
    app.scripts.set(app, id, (job) => {
      const entry = job.files[index];
      if (entry === undefined) return;
      entry.bytes = bytes;
      if (total === null) delete entry.total;
      else entry.total = total;
      entry.name = name;
    });
  };
}

function setFileState(app: App, id: string, index: number, state: FileJob["state"]): void {
  app.scripts.set(app, id, (job) => {
    const entry = job.files[index];
    if (entry !== undefined) entry.state = state;
  });
}

/** What a fetched footage file gave: its bytes, its name and the excerpts the script plays from. */
type Fetched = [bytes: number, name: string | null, cut: Excerpt[]];

/** Downloads a Drive file to this machine and cuts the script's excerpts from it. */
async function footageToDisk(app: App, id: string, index: number, file: string): Promise<Fetched> {
  const progress = fileProgress(app, id, index);
  const video = youtube.idOf(file);
  const path = await diag.timeOnAsync("script", "script: download", video === null ? `Drive file ${file}` : `YouTube video ${video}`, async () => {
    // The media drive not connected: said, not downloaded elsewhere.
    if (video !== null) {
      const dir = join(app.store.driveDir(), "youtube", video);
      return (await youtube.download(app.store.home, video, dir, progress)).path;
    }
    const dir = join(app.store.driveDir(), file);
    return download(dir, file, progress);
  });
  // Then only the parts the script uses become media.
  setFileState(app, id, index, "cutting");
  const live = app.store.get(id);
  const ranges = live === null ? [] : fileRanges(live.project, file);
  const cutUp = await diag.timeOnAsync("script", "script: cut excerpts", path, () => excerpts(path, ranges));
  let bytes = 0;
  try {
    bytes = fs.statSync(path).size;
  } catch {
    bytes = 0;
  }
  return [bytes, fileName(path), cutUp];
}

/**
 * Cloud mode: streams the Drive file to R2 (never to this disk; skipped when
 * the registry has it already), then cuts the script's excerpts from R2 and
 * keeps only their proxies here (`cloud_media`).
 */
async function footageToCloud(app: App, id: string, index: number, file: string): Promise<Fetched> {
  const progress = fileProgress(app, id, index);
  const scratch = seams.cloudMedia.scratchDir(app.store.cacheDir());
  const [original, local] =
    youtube.idOf(file) !== null
      ? await diag.timeOnAsync("script", "script: youtube to cloud", file, () =>
          seams.cloudMedia.youtubeOriginal(app.store.home, file, scratch, progress),
        )
      : [
          await diag.timeOnAsync("script", "script: download to cloud", `Drive file ${file}`, () =>
            seams.cloudMedia.driveOriginal(file, scratch, progress),
          ),
          null,
        ];
  try {
    setFileState(app, id, index, "cutting");
    const live = app.store.get(id);
    const ranges = live === null ? [] : fileRanges(live.project, file);
    const cache = app.store.cacheDir();
    const cutUp = await diag.timeOnAsync("script", "script: cloud excerpts", original.key, () =>
      cloudExcerptLane.with(() => seams.cloudMedia.driveExcerpts(cache, original, ranges, local)),
    );
    return [original.size, original.name, cutUp];
  } finally {
    // A YouTube download is on R2 now: its copy here goes.
    if (local !== null) fs.rmSync(parent(local) ?? local, { recursive: true, force: true });
  }
}

/**
 * Imports the excerpts, transcribes the footage, finds each range's exact
 * cut from its cue words, and puts every block it can on the timeline.
 * `recut` first clears what an earlier layout placed.
 */
async function place(app: App, id: string, done: [string, Excerpt[]][], recut: boolean): Promise<void> {
  // Excerpts on this disk are imported as files; cloud ones come made.
  const all = done.flatMap(([, cutUp]) => cutUp);
  const made = all.filter((excerpt) => excerpt.cloud !== null);
  const paths = all.filter((excerpt) => excerpt.cloud === null);
  if (paths.length > 0) {
    const [, , errors] = await importPaths(
      app,
      id,
      paths.map((excerpt) => excerpt.path),
      false,
      "script",
    );
    if (errors[0] !== undefined) throw new Error(errors[0]);
  }
  if (made.length > 0) {
    await importMade(
      app,
      id,
      made.map((excerpt) => excerpt.cloud!),
      false,
      "script",
    );
  }
  const files = new Map(done);
  const [live] = await app.store.update(id, "script", (project) => {
    // Which media each range plays from.
    const byPath = new Map(project.media.map((media) => [media.path, media.id]));
    for (const block of project.script?.blocks ?? []) {
      if (block.kind !== "footage") continue;
      // Scripts read before cue words existed get them from their notes.
      if (block.words === undefined || block.words === null) {
        const words = cueWords(block.notes ?? []);
        if (words === null) delete block.words;
        else block.words = words;
      }
      const found = (files.get(block.file) ?? []).find(
        (excerpt) => excerpt.from <= block.start + 1e-6 && block.end <= excerpt.to + 1e-6,
      );
      if (found === undefined) continue;
      // A reused video plays to its end.
      if (block.label === REUSE && found.from === 0) block.end = found.to;
      const mediaId = byPath.get(found.path);
      if (mediaId === undefined) continue;
      block.media = mediaId;
      if (found.from > 0) block.media_start = found.from;
      else delete block.media_start;
    }
  });

  app.scripts.set(app, id, (job) => {
    job.state = "transcribing";
  });
  const heard = await transcripts(app, live.project);

  app.scripts.set(app, id, (job) => {
    job.state = "placing";
  });
  await app.store.update(id, "script", (project) => {
    for (const block of project.script?.blocks ?? []) {
      if (block.kind !== "footage" || !isSome(block.words)) continue;
      const media = isSome(block.media) ? heard.get(block.media) : undefined;
      if (media === undefined) continue;
      const offset = block.media_start ?? 0;
      const [cutIn, cutOut] = align(media.words, media.peaks, block.words, block.start - offset, block.end - offset);
      if (cutIn !== null || cutOut !== null) {
        block.cut = [cutIn === null ? block.start : cutIn + offset, cutOut === null ? block.end : cutOut + offset];
      } else {
        delete block.cut;
      }
    }
    // A range whose file only came in now (a resumed import) would land
    // after everything already placed: lay the whole script out again.
    if (recut || outOfOrder(project)) clearLayout(project);
    layOut(project);
  });
}

/**
 * Whether laying out now would put a range after blocks that follow it in the
 * script: one ready to place (its media in) before a block already placed.
 */
export function outOfOrder(project: Project): boolean {
  let waiting = false;
  for (const block of project.script?.blocks ?? []) {
    if (block.kind === "footage" && !isSome(block.clip) && isSome(block.media) && mediaOf(project, block.media) !== undefined) waiting = true;
    else if (waiting && (isSome(block.clip) || (block.kind === "narration" && isSome(block.voiceover)))) return true;
  }
  return false;
}

/**
 * Re-finds every placed range's first and last words (after matching improves
 * or a transcript arrives) and moves its clip's in and out points to them.
 * Everything after a clip that changes length moves with it, so the timeline
 * stays butted; effects ending on its cut (a shake into a cut-in) keep ending
 * on it. Returns what changed.
 */
export async function realign(app: App, id: string): Promise<unknown[]> {
  const live = app.store.get(id);
  if (live === null) throw new Error("no such project");
  const heard = await transcripts(app, live.project);
  const [, changed] = await app.store.update(id, "agent", (project) => {
    const fps = fpsOf(project);
    const changed: unknown[] = [];
    if (!isSome(project.script)) return changed;
    const blocks = structuredClone(project.script.blocks);
    for (const block of blocks) {
      if (block.kind !== "footage" || !isSome(block.media) || !isSome(block.words) || !isSome(block.clip)) continue;
      const media = heard.get(block.media);
      if (media === undefined) continue;
      const offset = block.media_start ?? 0;
      const [cutIn, cutOut] = align(media.words, media.peaks, block.words, block.start - offset, block.end - offset);
      const found: [number, number] = [cutIn === null ? block.start : cutIn + offset, cutOut === null ? block.end : cutOut + offset];
      if (cutIn !== null || cutOut !== null) block.cut = found;
      else delete block.cut;
      const original = clipOf(project, block.clip);
      if (original === undefined) continue;
      const clip = structuredClone(original);
      if (clip.type !== "video") continue;
      const sourceIn = clip.source_in;
      const speed = clip.speed;
      // The clip plays seconds of the media, which begins `offset` into the file.
      const newIn = found[0] - offset;
      const newOut = found[1] - offset;
      const oldOut = sourceIn + (clip.duration / fps) * speed;
      if (Math.abs(newIn - sourceIn) < 0.5 / fps && Math.abs(newOut - oldOut) < 0.5 / fps) continue;
      const length = Math.trunc(Math.max(round(((newOut - newIn) / speed) * fps), 1));
      const delta = length - clip.duration;
      const oldEnd = clip.start + clip.duration;
      for (const other of project.clips) {
        const partner = other.id === clip.id || (isSome(clip.link) && other.link === clip.link);
        if (partner) {
          if (other.type === "video" || other.type === "audio") other.source_in = newIn;
          other.duration = length;
        } else if (other.start >= oldEnd || marksCut(other, oldEnd)) {
          other.start += delta;
        } else if (delta < 0 && other.start >= clip.start && other.start + other.duration > oldEnd + delta) {
          // Over a clip that got shorter (a teaser's subtitle): it ends with it,
          // or, starting in the part cut away, moves up with what follows, so it
          // never overlaps the next one moved up (realign once refused on that).
          const newEnd = oldEnd + delta;
          if (other.start >= newEnd) other.start += delta;
          else other.duration = Math.max(newEnd - other.start, 1);
        }
      }
      changed.push({
        clip: clip.id,
        first_word_found: cutIn !== null,
        frames_longer: delta,
        last_word_found: cutOut !== null,
        now: [newIn, newOut],
        range: block.label,
        seconds: [sourceIn, oldOut],
      });
    }
    project.script.blocks = blocks;
    return changed;
  });
  return changed;
}

/** What's said in a media file, and how loud it is moment to moment. */
interface Heard {
  words: Word[];
  peaks: Uint8Array | null;
}

/**
 * Transcribes each media the script plays (through Edit's relay) and waits for
 * the words. Media without sound, or whose transcription fails, are left out:
 * their ranges keep the times the Doc wrote.
 */
async function transcripts(app: App, project: Project): Promise<Map<string, Heard>> {
  const used = new Set<string>();
  for (const block of project.script?.blocks ?? []) {
    if (block.kind === "footage" && isSome(block.media) && isSome(block.words)) used.add(block.media);
  }
  const media = project.media.filter((item) => used.has(item.id) && item.has_audio);
  // Listening for the case's names (names.ts: the script's narration and any research).
  const names = await seams.research.caseNames(app, project);
  for (const item of media) app.media.transcribe(item.path, true, names);
  const out = new Map<string, Heard>();
  const started = timing.now();
  for (const item of media) {
    for (;;) {
      const stage = app.media.status(item.path).transcript;
      if (stage === "ready") {
        let words: Word[] | null = null;
        try {
          words = parseTranscript(fs.readFileSync(app.media.paths(item.path).transcript, "utf8")).words;
        } catch {
          words = null;
        }
        if (words !== null) {
          let peaks: Uint8Array | null = null;
          try {
            peaks = new Uint8Array(fs.readFileSync(app.media.paths(item.path).peaks));
          } catch {
            peaks = null;
          }
          out.set(item.id, { words, peaks });
        }
        break;
      }
      if (stage === "failed") break;
      if (timing.now() - started > 30 * 60 * 1000) break;
      await timing.sleep(2000);
    }
  }
  return out;
}

/** Takes the script's clips (and their linked partners) off the timeline so it can be laid out again. */
function clearLayout(project: Project): void {
  const script = project.script;
  if (!isSome(script)) return;
  const placedClips = new Set<string>();
  for (const block of script.blocks) {
    if (block.kind === "narration" && isSome(block.voiceover)) {
      placedClips.add(block.voiceover);
      delete block.voiceover;
    }
    if (isSome(block.clip)) {
      placedClips.add(block.clip);
      delete block.clip;
    }
  }
  const links = new Set(
    project.clips.filter((clip) => placedClips.has(clip.id) && isSome(clip.link)).map((clip) => clip.link as string),
  );
  project.clips = project.clips.filter((clip) => !placedClips.has(clip.id) && !(isSome(clip.link) && links.has(clip.link)));
}

/** The cut-in card's text: sized so long narration still fits on screen. */
export function cutInStyle(width: number, height: number, text: string): TextStyle {
  const k = f32(f32(height) / 1080);
  const maxWidth = f32(f32(width) * 0.62);
  const chars = f32(Math.max(charCount(text), 1));
  const fit = f32(Math.sqrt(f32(f32(f32(0.75 * f32(height)) * maxWidth) / chars)));
  const size = round(Math.min(Math.max(fit, f32(22 * k)), f32(46 * k)));
  return textStyleFrom({
    font: "Geist",
    weight: 500,
    size,
    color: [1, 1, 1, 1],
    tracking: 0,
    line_height: 1.4,
    glow: { enabled: false, color: null, radius: 46, strength: 0.5 },
    max_width: round(maxWidth),
    align: "center",
  });
}

const FILE_COLORS: ClipColor[] = ["blue", "cyan", "green", "orange", "pink", "yellow"];

function tracksOf(project: Project, kind: TrackKind): string[] {
  return project.tracks.filter((track) => track.kind === kind).map((track) => track.id);
}

/** Places every block not on the timeline yet, in script order, after what's there. */
export function layOut(project: Project): void {
  const script: Script | undefined = project.script;
  if (!isSome(script)) return;
  while (tracksOf(project, "video").length < 2) addTrack(project, "video");
  if (tracksOf(project, "audio").length === 0) addTrack(project, "audio");
  const [lower, upper] = tracksOf(project, "video");
  const audio = tracksOf(project, "audio")[0];
  if (lower === undefined || upper === undefined || audio === undefined) return;
  const fps = fpsOf(project);
  const { width, height } = project.settings;
  const colors = new Map<string, ClipColor>();
  let cursor = projectDuration(project);
  let cutIns = 0;
  // Cut-ins (numbered from 1) whose voice-over is on the timeline: placed.
  const voiced = new Set<number>();
  script.blocks
    .filter((block) => block.kind === "narration")
    .forEach((block, index) => {
      if (block.kind === "narration" && isSome(block.voiceover) && clipOf(project, block.voiceover) !== undefined) {
        voiced.add(index + 1);
      }
    });
  for (const block of script.blocks) {
    if (block.kind === "footage") {
      // Placed once already: gone means removed on purpose (a cut-in card
      // replaced by B-roll), so it isn't put back. A re-cut clears these first.
      if (isSome(block.clip)) continue;
      const offset = block.media_start ?? 0;
      // The transcript's cut when there is one, else the Doc's times.
      const [start, end] = block.cut ?? [block.start, block.end];
      const media = isSome(block.media) ? mediaOf(project, block.media) : undefined;
      if (media === undefined) continue;
      const from = Math.min(Math.max(start - offset, 0), media.duration);
      const to = Math.min(end - offset, media.duration);
      if (to <= from) continue;
      let color = colors.get(block.file);
      if (color === undefined) {
        color = FILE_COLORS[colors.size % FILE_COLORS.length]!;
        colors.set(block.file, color);
      }
      const length = Math.max(Math.trunc(round((to - from) * fps)), 1);
      const link = media.has_audio ? freshId(project, "l") : null;
      const id = freshId(project, "c");
      project.clips.push(
        clipFrom({
          id,
          track: lower,
          start: cursor,
          duration: length,
          color,
          ...(link !== null ? { link } : {}),
          type: "video",
          media: media.id,
          source_in: from,
          speed: 1,
        }),
      );
      if (media.has_audio) {
        project.clips.push(
          clipFrom({
            id: freshId(project, "c"),
            track: audio,
            start: cursor,
            duration: length,
            color,
            ...(link !== null ? { link } : {}),
            type: "audio",
            media: media.id,
            source_in: from,
            speed: 1,
          }),
        );
      }
      block.clip = id;
      cursor += length;
    } else {
      cutIns += 1;
      if (isSome(block.clip) || voiced.has(cutIns)) continue;
      const length = Math.max(Math.trunc(round(CUT_IN_SECONDS * fps)), 1);
      const link = freshId(project, "l");
      const card = freshId(project, "c");
      project.clips.push(
        clipFrom({
          id: card,
          track: lower,
          start: cursor,
          duration: length,
          color: "purple",
          name: `Cut-in ${cutIns}`,
          link,
          type: "solid",
          fill: [0, 0, 0, 1],
          opacity: 1,
        }),
      );
      project.clips.push(
        clipFrom({
          id: freshId(project, "c"),
          track: upper,
          start: cursor,
          duration: length,
          color: "purple",
          link,
          type: "text",
          text: block.text,
          style: cutInStyle(width, height, block.text),
        }),
      );
      block.clip = card;
      cursor += length;
    }
  }
}

/** Attaches a Doc's script to a project (replacing any before). */
export function attach(project: Project, source: string, parsed: Parsed): void {
  project.script = { source, blocks: parsed.blocks };
}

/** How much a script holds, for the import dialog's preview. */
export function summary(parsed: Parsed): { files: number; footage: number; narration: number; seconds: number; title: string } {
  const files: string[] = [];
  let footage = 0;
  let narration = 0;
  let seconds = 0;
  for (const block of parsed.blocks) {
    if (block.kind === "footage") {
      footage += 1;
      seconds += block.end - block.start;
      if (!files.includes(block.file)) files.push(block.file);
    } else {
      narration += 1;
      seconds += CUT_IN_SECONDS;
    }
  }
  return { files: files.length, footage, narration, seconds, title: parsed.title };
}
