// A compilation's pasted sources, in case order. Docs are existing scripts;
// only an explicitly marked video is a finished, untouched reused section.
import type { App } from "./app.ts";
import * as script from "./script.ts";
import { folderId, videosIn } from "./drive_import.ts";
import * as relay from "./relay.ts";
import type { Parsed } from "./seams.ts";
import type { ScriptBlock } from "./model.ts";
import { REUSED_SCRIPT_NOTE, WHOLE_SOURCE_LABEL } from "./project.ts";

export const WHOLE_SOURCE = WHOLE_SOURCE_LABEL;
export const REUSED_SCRIPT = REUSED_SCRIPT_NOTE;
export interface CompilationSource { url: string; kind: "script" | "video" | "folder" | "trello"; reuse: boolean; case: string; earlier?: string }

function cleaned(url: string): string { return url.replace(/[)\]},.;]+$/u, ""); }
export function sourceKind(value: string): CompilationSource["kind"] | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.replace(/^www\./, "");
  if (host === "docs.google.com" && script.docId(value)) return "script";
  if (host === "drive.google.com" && folderId(value)) return "folder";
  if ((host === "drive.google.com" || host === "drive.usercontent.google.com" || host === "youtube.com" || host === "youtu.be") && script.footageFile(value)) return "video";
  if (host === "trello.com" && /^\/c\/[a-zA-Z0-9]+(?:\/|$)/u.test(url.pathname)) return "trello";
  return null;
}

/** Markdown links, plain links and labelled case lists use the same parser. */
export function sourceLines(text: string): CompilationSource[] {
  const out: CompilationSource[] = [];
  let section = false;
  let marked = false;
  let currentCase = "";
  const lines = text.replace(/(\S)[\t ]+(?=(?:case\s*(?:#|no\.?\s*)?\d+\s*[:(\[]|reuse:?\s+https?:))/giu, "$1\n").split(/\r?\n/u);
  const caseHeading = /^\s*[-*#\s]*case\s*(?:#|no\.?\s*)?(\d+)\b/iu;
  let active = !lines.some((line) => caseHeading.test(line));
  for (const [index, line] of lines.entries()) {
    const heading = caseHeading.exec(line);
    if (heading) { currentCase = heading[1]!; section = false; marked = false; active = true; }
    const words = line.replace(/https?:\/\/[^\s<>"\]]+/gu, " ");
    const reuse = /\bre-?use(?:d)?\b/iu.test(words);
    if (!heading && currentCase && /^\s*[-*#\s]*(?:thumb(?:nail)?|reference|footage|article|source|video|script)\s*:/iu.test(words)
      && out.some((one) => one.case === currentCase)) active = false;
    if (!active) continue;
    if (heading && reuse) section = true;
    const urls = [...line.matchAll(/https?:\/\/[^\s<>"\]]+/gu)].map((match) => cleaned(match[0]));
    if (!urls.length) {
      if (reuse) { marked = true; section = /:\s*$/u.test(line.trim()); }
      else if (/^\s*#{1,6}\s|^[^:]{1,40}:\s*$/u.test(line)) { section = false; marked = false; }
      continue;
    }
    for (const url of urls) {
      const kind = sourceKind(url);
      if (!kind) continue;
      const previous = out.at(-1);
      // `REUSE <finished video> <earlier Doc> case N` retains the Doc as
      // reference instead of inserting both the video and its script.
      if ((kind === "script" || kind === "trello") && previous?.kind === "video" && previous.reuse && previous.case === (currentCase || `line-${index}`)) {
        previous.earlier = url;
        continue;
      }
      // A repeated attachment is one source; a numbered case using the same
      // recording again keeps its own place.
      const name = currentCase || `line-${index}`;
      if (out.some((one) => one.url === url && one.case === name)) continue;
      out.push({ url, kind, reuse: kind === "script" || reuse || marked || section, case: name });
    }
    marked = false;
  }
  return out;
}

export interface TrelloCard { name?: string; desc?: string; attachmentLabels?: string[]; attachments?: unknown[]; checklists?: unknown[]; comments?: unknown[] }
export function cardSources(card: TrelloCard): CompilationSource[] {
  const description = sourceLines(card.desc ?? "");
  const strings = (items: unknown[]): string[] => items.flatMap((item): string[] => {
    if (typeof item === "string") return [item];
    if (!item || typeof item !== "object") return [];
    const one = item as { url?: unknown; text?: unknown; name?: unknown; checkItems?: unknown[] };
    return [one.name, one.url, one.text].filter((value): value is string => typeof value === "string").concat(strings(one.checkItems ?? []));
  });
  const reference = /^(?:\s*(?:thumbnail|thumb|cover)\b|\s*reference\b)/iu;
  const excluded = new Set((card.attachmentLabels ?? []).filter((label) => reference.test(label)).flatMap(sourceLines).map((source) => source.url));
  const labeled = [...(card.attachmentLabels ?? []), ...(card.attachments ?? [])].flatMap((item): string[] => {
    if (typeof item === "string" && (reference.test(item) || excluded.has(item))) return [];
    if (!item || typeof item !== "object") return strings([item]);
    const one = item as { name?: string; url?: string };
    if (/\b(?:thumb(?:nail)?|cover)\b|^\s*reference\b/iu.test(one.name ?? "")) return [];
    return [`${one.name ?? ""} ${one.url ?? ""}`];
  });
  // Parse items separately so a description's last case/reuse marker cannot
  // relabel an unrelated attachment. Numbered attachments fill their case slot.
  const extra = [...labeled, ...strings([...(card.checklists ?? []), ...(card.comments ?? [])])].flatMap(sourceLines);
  const out = [...description];
  for (const item of extra) {
    const numbered = /^\d+$/u.test(item.case);
    const duplicate = out.find((one) => one.url === item.url && (!numbered || one.case === item.case));
    if (duplicate) { duplicate.reuse ||= item.reuse; continue; }
    const before = numbered ? out.findIndex((one) => /^\d+$/u.test(one.case) && Number(one.case) > Number(item.case)) : -1;
    if (before < 0) out.push(item); else out.splice(before, 0, item);
  }
  return out;
}

export async function readCard(url: string): Promise<TrelloCard> {
  const id = new URL(url).pathname.split("/")[2]!;
  const service = process.env.EDIT_WRITER_RELAY_URL ?? "https://writer-relay.sphe-g-personal.workers.dev";
  const response = await fetch(`${service.replace(/\/$/u, "")}/v1/trello/card?card=${encodeURIComponent(id)}`, {
    headers: relay.authHeaders(), redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  const value = await response.json() as TrelloCard & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Trello import refused (${response.status})`);
  return value;
}

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Writer keeps the complete Doc text, with each link as `label <URL>`.
 * Recreate the linked paragraphs, then use the normal Doc range parser. */
export function parseScriptText(text: string, title = ""): Parsed {
  const paragraphs = text.split(/\r?\n/u).map((line) => {
    let at = 0;
    let html = "";
    for (const match of line.matchAll(/<\s*(https?:\/\/[^\s<>]+)\s*>/gu)) {
      html += `<a href="${escape(match[1]!)}">${escape(line.slice(at, match.index))}</a>`;
      at = match.index! + match[0].length;
    }
    return `<p>${html}${escape(line.slice(at))}</p>`;
  });
  return script.parse(`<html><head><title>${escape(title)}</title></head><body>${paragraphs.join("\n")}</body></html>`);
}

export function markReusedScript(parsed: Parsed, url: string): Parsed {
  for (const block of parsed.blocks) {
    block.notes = [...(block.notes ?? []), `${REUSED_SCRIPT}${url}`];
    if (block.kind === "footage") { delete block.cut; delete block.words; }
  }
  return parsed;
}

export interface CompilationReaders {
  doc(id: string): Promise<[string, string]>;
  folder(id: string): Promise<{ id: string; name: string }[]>;
  card(url: string): Promise<TrelloCard>;
}

/** Resolve every source before saving: failures never create a partial script. */
export async function readCompilation(input: string, app: App, overrides: Partial<CompilationReaders> = {}): Promise<Parsed> {
  const readers: CompilationReaders = { doc: script.fetchDoc, folder: (id) => videosIn(app, id), card: readCard, ...overrides };
  let sources = sourceLines(input);
  if (!sources.length) throw new Error("Paste Google Docs scripts, Google Drive folders or files, YouTube videos, or a Trello card.");
  if (sources.length > 40) throw new Error("Import at most 40 cases at a time.");
  const ordinaryDoc = sources.length === 1 && sources[0]!.kind === "script" && !/\bre-?use\b/iu.test(input);
  const blocks: ScriptBlock[] = [];
  const reused: NonNullable<Parsed["reused"]> = [];
  const skipped: NonNullable<Parsed["skipped"]> = [];
  let title = "";
  let style: Parsed["style"];
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i]!;
    if (source.kind === "trello") {
      const card = await readers.card(source.url);
      if (!title) title = card.name?.trim() ?? "";
      const found = cardSources(card).filter((one) => one.kind !== "trello");
      if (!found.length) throw new Error("That Trello card has no supported case links.");
      if (sources.length - 1 + found.length > 40) throw new Error("Import at most 40 cases at a time.");
      sources.splice(i, 1, ...found); i--; continue;
    }
    if (source.kind === "script") {
      const [html, name] = await readers.doc(script.docId(source.url)!);
      const parsed = script.parse(html);
      if (!parsed.title) parsed.title = name;
      await script.joinCases(parsed, async (id) => (await readers.doc(id))[0], new Set([script.docId(source.url)!]));
      if (!parsed.blocks.some((block) => block.kind === "footage")) throw new Error(`The script ${parsed.title || source.url} has no linked footage ranges.`);
      // The normal single-Doc entry point remains an ordinary edit. In a
      // multi-source compilation a Doc is an already-written reused case.
      if (!ordinaryDoc) markReusedScript(parsed, source.url);
      if (!title) title = parsed.title;
      style ??= parsed.style;
      blocks.push(...parsed.blocks);
      reused.push(...(parsed.reused ?? []));
      skipped.push(...(parsed.skipped ?? []));
      continue;
    }
    const files = source.kind === "folder"
      ? (await readers.folder(folderId(source.url)!)).map((file) => ({ url: `https://drive.google.com/file/d/${file.id}/view`, name: file.name }))
      : [{ url: source.url, name: "" }];
    if (!files.length) throw new Error("There's no video in that Drive folder.");
    if (source.reuse && files.length > 1) throw new Error("For a finished reused video, paste its file link rather than a folder of recordings.");
    for (const file of files) blocks.push({ kind: "footage", url: file.url, file: script.footageFile(file.url)!, start: 0, end: 1,
      label: source.reuse ? script.REUSE : WHOLE_SOURCE, notes: [`Case ${source.case}: ${source.url}`, ...(source.earlier ? [`Earlier script: ${source.earlier}`] : []), ...(file.name ? [`Source: ${file.name}`] : [])] });
  }
  return {
    title: title || (sources.length > 1 ? "Compilation" : "Imported footage"),
    blocks,
    ...(reused.length > 0 ? { reused } : {}),
    ...(skipped.length > 0 ? { skipped } : {}),
    ...(style ? { style } : {}),
  };
}
