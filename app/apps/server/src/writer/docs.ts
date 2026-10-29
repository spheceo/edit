// A script exported to a new Google Doc, as Repack exports one: the page lays
// it out as a Word file with a comment on each timestamp, and the Doc is made
// from it in the "Writer scripts" folder of the account that owns script
// Docs, open to anyone with its link. That account is the team's Google
// sign-in Edit already holds (drive.ts), so Docs Writer exported list here
// too. A full export is remembered as the script's Doc; a draft ("(DRAFT) …")
// is not.

import type { Script } from "@edit/types/writer";

import * as diag from "../diag.ts";
import * as drive from "./drive.ts";
import * as jobs from "./jobs.ts";
import * as store from "./store.ts";

const FOLDER = "Writer scripts";
const DOC_MIME = "application/vnd.google-apps.document";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const API = "https://www.googleapis.com/drive/v3/";
const MAX_DOCX_BYTES = 8_000_000;

/** One exported Doc, as the page lists it. */
export interface DocFile {
  id: string;
  url: string;
  name: string;
  draft: boolean;
  createdAt: string | null;
  state: "live" | "trashed";
}

async function google(path: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(path, API);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${await drive.hooks.accessToken()}`);
  if (init.body && typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
  const answer = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(120_000) });
  if (!answer.ok) {
    const reason = ((await answer.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? "";
    throw new Error(`Google ${answer.status}: ${reason.slice(0, 300) || "request failed"}`);
  }
  return answer;
}

const quoted = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
const docUrl = (id: string) => `https://docs.google.com/document/d/${id}/edit`;

/** The one folder in the owner's Drive that holds every exported script. */
async function folder(): Promise<string> {
  const params = new URLSearchParams({ q: `name = '${FOLDER}' and mimeType = '${FOLDER_MIME}' and 'root' in parents and trashed = false`, fields: "files(id)", pageSize: "1" });
  const found = (await (await google(`files?${params}`)).json()) as { files?: { id: string }[] };
  if (found.files?.[0]?.id) return found.files[0].id;
  return ((await (await google("files?fields=id", { method: "POST", body: JSON.stringify({ name: FOLDER, mimeType: FOLDER_MIME }) })).json()) as { id: string }).id;
}

const exporting = new Set<string>();

/**
 * A new Doc each time, never synced into an old one: Docs anchors comments
 * only when they arrive in an imported file, and numbers their anchors from
 * zero on every import (Repack's reasoning).
 */
export async function exportDoc(data: string, id: string, draft: boolean, docxBase64: string): Promise<DocFile> {
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  const docx = Buffer.from(docxBase64, "base64");
  if (docx.length === 0 || docx.length > MAX_DOCX_BYTES) throw new Error("That script is too large to export.");
  if (exporting.has(id)) throw new Error("This script is already being exported. Try again in a moment.");
  exporting.add(id);
  const began = Date.now();
  try {
    const metadata = { name: draft ? `(DRAFT) ${script.title}` : script.title, mimeType: DOC_MIME, appProperties: { writerScript: id, writerKind: draft ? "draft" : "script" }, parents: [await folder()] };
    const boundary = `edit-${crypto.randomUUID()}`;
    const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${DOCX_MIME}\r\n\r\n`, docx, `\r\n--${boundary}--`]);
    const made = (await (await google("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,createdTime", { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body })).json()) as { id: string; name: string; createdTime?: string };
    // Anyone with the link can edit; nobody can find it by searching, as Repack shares.
    await google(`files/${made.id}/permissions?fields=id&supportsAllDrives=true`, { method: "POST", body: JSON.stringify({ type: "anyone", role: "writer", allowFileDiscovery: false }) });
    const doc: DocFile = { id: made.id, url: docUrl(made.id), name: made.name, draft, createdAt: made.createdTime ?? null, state: "live" };
    diag.info("writer", `${jobs.named(id, script.title)}: ${draft ? "draft" : "full"} Google Doc made in ${Math.round((Date.now() - began) / 1000)} s: ${doc.url}`);
    // Read again: an edit made while Google worked stays.
    if (!draft) store.update(dir, (now: Script) => void (now.docExport = { id: doc.id, url: doc.url, revision: now.revision, exportedAt: Date.now() }));
    return doc;
  } catch (error) {
    diag.error("writer", `${jobs.named(id, script.title)}: Google Doc export failed after ${Math.round((Date.now() - began) / 1000)} s: ${diag.messageOf(error)}`);
    throw error;
  } finally {
    exporting.delete(id);
  }
}

/** Every Doc exported from a script, newest first, as Drive has them now. */
export async function listDocs(id: string): Promise<DocFile[]> {
  const params = new URLSearchParams({
    q: `'${await folder()}' in parents and mimeType = '${DOC_MIME}' and appProperties has { key='writerScript' and value='${quoted(id)}' }`,
    fields: "files(id,name,createdTime,trashed,appProperties)",
    orderBy: "createdTime desc",
    pageSize: "200",
  });
  const found = (await (await google(`files?${params}`)).json()) as { files?: { id: string; name: string; createdTime?: string; trashed?: boolean; appProperties?: Record<string, string> }[] };
  return (found.files ?? []).map((file) => ({ id: file.id, url: docUrl(file.id), name: file.name, draft: file.appProperties?.writerKind === "draft", createdAt: file.createdTime ?? null, state: file.trashed ? "trashed" : "live" }));
}

/** The comments people left on the script's latest Doc, or on one named: only a Doc this script exported. */
export async function docComments(data: string, id: string, given: string | null): Promise<{ doc: string; comments: unknown[] }> {
  let doc = given;
  if (doc === null) {
    const live = (await listDocs(id)).find((one) => one.state === "live")?.id;
    doc = live ?? store.read(store.scriptDir(data, id)).docExport?.id ?? null;
    if (doc === null) throw new Error("This script has no exported Doc to read comments from.");
  }
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(doc)) throw new Error("Which Doc?");
  const file = (await (await google(`files/${doc}?fields=appProperties,parents`)).json()) as { appProperties?: Record<string, string>; parents?: string[] };
  if (file.appProperties?.writerScript !== id || !file.parents?.includes(await folder())) throw new Error("That Doc is not one of this script's exports.");
  const comments: unknown[] = [];
  let page = "";
  do {
    const params = new URLSearchParams({ fields: "nextPageToken,comments(id,author(displayName),content,quotedFileContent(value),resolved,deleted,createdTime,replies(author(displayName),content,deleted))", pageSize: "100", includeDeleted: "false", ...(page ? { pageToken: page } : {}) });
    const found = (await (await google(`files/${doc}/comments?${params}`)).json()) as { comments?: unknown[]; nextPageToken?: string };
    comments.push(...(found.comments ?? []));
    page = found.nextPageToken ?? "";
  } while (page !== "" && comments.length < 2000);
  return { doc, comments };
}
