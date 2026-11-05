// The team's Google Drive, through the relay (Nov 4, the security audit; Sphe:
// "if we've given someone X permissions, their account literally cannot access
// anything else"). Until then `/v1/cloud/google/token` handed every signed-in
// Edit the team account's access token: an hour of everything that account
// can do in Drive, kept even after the person was cut off. Now the token never
// leaves here. Edit sends its Google calls to
//
//   /v1/google/www.googleapis.com/<path>?<query>
//
// with the person's own Edit sign-in, and the relay makes the call with the
// team's token if it's one Edit makes:
//
//   GET    drive/v3/files                    a folder's or a search's files
//   GET    drive/v3/files/<id>               a file's details, or its bytes (alt=media, ranges)
//   GET    drive/v3/files/<id>/export        a Doc as HTML or text
//   GET    drive/v3/files/<id>/comments      a script's exported Doc's comments
//   POST   drive/v3/files                    the "Writer scripts" folder, made once
//   POST   upload/drive/v3/files             a new file in one of Edit's folders (a script's
//                                            Doc, multipart; an export, a resumable session)
//   PATCH  upload/drive/v3/files/<id>        new contents for a file in Edit's folders (a re-export)
//   POST   drive/v3/files/<id>/permissions   a file in Edit's folders shared by link
//
// Nothing else: no deletes, moves, renames or other sharing, and no write
// outside Edit's folders. An export's bytes go straight to Google: the upload
// session's address is its own grant, so they never pass through here. Each
// call is logged with who made it and the file, never a token.

import { allow, burstKey, type AuthEnv, type Caller } from "./auth";
import { docsFolder, docsToken } from "./docs";
import type { JobsEnv } from "./jobs";

export interface GoogleEnv extends JobsEnv, AuthEnv {
  CLOUD_BURST?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

const HOST = "www.googleapis.com";
/** Where Edit puts exports: subtitled videos (Repack's Subtitles), and edits before Oct 17 (Render). Edit's drive.ts names them. */
export const EXPORT_FOLDERS = ["12q4jbYhXI53BYZtTwOxzFEOJV2d1wJTk", "15Fp5Zq_RKwYRohpE5t_uEho8T2Q1RwwL"];
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOCS_FOLDER = "Writer scripts";
/** A script's Doc export (docx) with its metadata: well under this. */
const MAX_MULTIPART = 12 * 1024 * 1024;
const MAX_JSON = 64 * 1024;
const ID = "[A-Za-z0-9_-]{10,200}";
/** The query a write may carry: nothing that moves, transfers or re-parents a file. */
const WRITE_QUERY = new Set(["uploadType", "supportsAllDrives", "fields", "supportsTeamDrives"]);
/** The request headers passed on (the sign-in is replaced, never passed). */
const ASKED = ["accept", "range", "if-range", "content-type", "x-upload-content-type", "x-upload-content-length"];
/** The answer's headers passed back (the upload session's address among them). */
const ANSWERED = ["content-type", "content-length", "content-range", "content-disposition", "accept-ranges", "etag", "last-modified", "location"];

type Route =
  | { kind: "read" }
  | { kind: "folder" }
  | { kind: "create"; upload: "multipart" | "resumable" }
  | { kind: "replace"; file: string }
  | { kind: "share"; file: string };

/** Which of Edit's calls this is, or null. */
export function routeOf(method: string, path: string, query: URLSearchParams): Route | null {
  const read = method === "GET" || method === "HEAD";
  if (read && (path === "/drive/v3/files" || new RegExp(`^/drive/v3/files/${ID}(/export|/comments)?$`).test(path))) return { kind: "read" };
  const writable = [...query.keys()].every((key) => WRITE_QUERY.has(key));
  if (!writable) return null;
  if (method === "POST" && path === "/drive/v3/files") return { kind: "folder" };
  const upload = query.get("uploadType");
  if (method === "POST" && path === "/upload/drive/v3/files" && (upload === "multipart" || upload === "resumable")) return { kind: "create", upload };
  const replacing = new RegExp(`^/upload/drive/v3/files/(${ID})$`).exec(path);
  if (method === "PATCH" && replacing !== null && upload === "resumable") return { kind: "replace", file: replacing[1]! };
  const sharing = new RegExp(`^/drive/v3/files/(${ID})/permissions$`).exec(path);
  if (method === "POST" && sharing !== null) return { kind: "share", file: sharing[1]! };
  return null;
}

/**
 * The Drive searches Edit makes (drive_import, library, channel_marks, Script
 * mode's drive.ts and docs.ts): a folder's files, the scripts' Docs folder,
 * and a script's exported Docs. Nov 5 (the permissions check before a new
 * teammate): any `q` went through, so anyone with a kind of work could search
 * everything the team's account sees; now a teammate lists only a folder
 * they were given the id of (an admin, anything).
 */
const SEARCHES = [
  new RegExp(`^'${ID}' in parents and trashed = false$`),
  /^name = 'Writer scripts' and mimeType = 'application\/vnd\.google-apps\.folder' and 'root' in parents and trashed = false$/,
  new RegExp(`^'${ID}' in parents and mimeType = 'application/vnd\\.google-apps\\.document' and appProperties has \\{ key='writerScript' and value='[A-Za-z0-9-]{1,80}' \\}$`),
];

/** Whether a listing's `q` is one of Edit's searches. */
export function searchAllowed(query: URLSearchParams): boolean {
  const q = query.get("q");
  return q !== null && query.getAll("q").length === 1 && SEARCHES.some((search) => search.test(q));
}

/** Whether a person's work needs the team's Drive: any capability (editing, scripts, subtitles, ideas), or an admin. */
export function mayUseDrive(found: Caller): boolean {
  return found.kind === "person" && (found.admin || found.perms.some((perm) => perm.includes(".")));
}

export const NO_DRIVE = "Your account can't use the team's Google Drive: an admin can give you a kind of work at accounts.spheceo.com.";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

const refuse = (why: string) => json(403, { error: { code: 403, message: `Edit's relay doesn't make that Drive call: ${why}` } });

/** The folders Edit writes in: the export folders and the scripts' Docs folder. */
async function editFolders(env: GoogleEnv): Promise<Set<string>> {
  return new Set([...EXPORT_FOLDERS, await docsFolder(env)]);
}

/** Whether every parent named is one of Edit's folders (and at least one is named). */
async function inEditFolders(parents: unknown, env: GoogleEnv): Promise<boolean> {
  if (!Array.isArray(parents) || parents.length === 0 || !parents.every((one) => typeof one === "string")) return false;
  const folders = await editFolders(env);
  return parents.every((one) => folders.has(one));
}

/** Whether Drive file `id` sits in one of Edit's folders now. */
async function fileInEditFolders(id: string, token: string, env: GoogleEnv): Promise<boolean> {
  const answer = await fetch(`https://${HOST}/drive/v3/files/${id}?fields=parents&supportsAllDrives=true`, { headers: { authorization: `Bearer ${token}` } });
  if (!answer.ok) return false;
  const file = (await answer.json().catch(() => null)) as { parents?: unknown } | null;
  return inEditFolders(file?.parents, env);
}

/** A JSON body of at most `MAX_JSON`, or null. */
async function jsonBody(request: Request): Promise<{ text: string; value: Record<string, unknown> } | null> {
  const text = await request.text();
  if (text.length > MAX_JSON) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? { text, value: value as Record<string, unknown> } : null;
  } catch {
    return null;
  }
}

/** A multipart/related upload's metadata (its first part, JSON), with the whole body to send on. */
async function multipartBody(request: Request): Promise<{ body: ArrayBuffer; metadata: Record<string, unknown> } | null> {
  const declared = Number(request.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > MAX_MULTIPART) return null;
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_MULTIPART) return null;
  const boundary = /boundary="?([^";]+)"?/.exec(request.headers.get("content-type") ?? "")?.[1];
  if (boundary === undefined) return null;
  const head = new TextDecoder().decode(body.slice(0, Math.min(body.byteLength, MAX_JSON)));
  const part = head.split(`--${boundary}`)[1];
  const json = part === undefined ? undefined : part.slice(part.indexOf("\r\n\r\n") + 4).trim();
  try {
    const metadata: unknown = JSON.parse(json ?? "");
    return typeof metadata === "object" && metadata !== null && !Array.isArray(metadata) ? { body, metadata: metadata as Record<string, unknown> } : null;
  } catch {
    return null;
  }
}

/** `/v1/google/www.googleapis.com/…`: one of Edit's Drive calls, made with the team's sign-in. */
export async function google(request: Request, url: URL, env: GoogleEnv): Promise<Response> {
  const rest = url.pathname.slice("/v1/google/".length);
  const slash = rest.indexOf("/");
  const host = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? "/" : rest.slice(slash);
  const found = await allow(request, env, "use", "google", false, false);
  if (found instanceof Response) return found;
  if (!mayUseDrive(found)) return json(403, { error: { code: 403, message: NO_DRIVE } });
  if (host !== HOST || path.includes("..") || path.includes("//")) return refuse("only Google's Drive API is reached here.");
  const route = routeOf(request.method, path, url.searchParams);
  if (route === null) return refuse(`${request.method} ${path} isn't one of the calls Edit makes.`);
  if (path === "/drive/v3/files" && route.kind === "read" && !(found.kind === "person" && found.admin) && !searchAllowed(url.searchParams)) return refuse("only a folder's files are listed here, not a search of the whole Drive.");
  if (env.CLOUD_BURST !== undefined && !(await env.CLOUD_BURST.limit({ key: `google:${burstKey(request, found)}` })).success) return json(429, { error: { code: 429, message: "Too many Drive requests at once; try again in a minute." } });
  let token: string;
  try {
    token = await docsToken(env);
  } catch (error) {
    return json(502, { error: { code: 502, message: error instanceof Error ? error.message : String(error) } });
  }
  // What goes on: the request's own body, unless a write's had to be read to check it.
  let body: BodyInit | null = request.method === "GET" || request.method === "HEAD" ? null : request.body;
  if (route.kind === "folder") {
    const given = await jsonBody(request);
    const keys = given === null ? [] : Object.keys(given.value);
    if (given === null || given.value.name !== DOCS_FOLDER || given.value.mimeType !== FOLDER_MIME || keys.some((key) => key !== "name" && key !== "mimeType")) return refuse(`only the "${DOCS_FOLDER}" folder is made here.`);
    body = given.text;
  } else if (route.kind === "create" && route.upload === "resumable") {
    const given = await jsonBody(request);
    if (given === null || !(await inEditFolders(given.value.parents, env))) return refuse("a new file goes only into one of Edit's folders.");
    body = given.text;
  } else if (route.kind === "create") {
    const given = await multipartBody(request);
    if (given === null || !(await inEditFolders(given.metadata.parents, env))) return refuse("a new file goes only into one of Edit's folders.");
    body = given.body;
  } else if (route.kind === "replace" || route.kind === "share") {
    if (!(await fileInEditFolders(route.file, token, env))) return refuse("only a file in one of Edit's folders is changed or shared.");
    const given = await jsonBody(request);
    if (given === null) return refuse("send JSON.");
    if (route.kind === "replace" && Object.keys(given.value).some((key) => key !== "name")) return refuse("a re-export only names the file.");
    if (route.kind === "share") {
      const keys = Object.keys(given.value).sort().join(",");
      const reader = keys === "role,type" && given.value.type === "anyone" && given.value.role === "reader";
      const doc = keys === "allowFileDiscovery,role,type" && given.value.type === "anyone" && given.value.role === "writer" && given.value.allowFileDiscovery === false;
      if (!reader && !doc) return refuse("a file is shared only by link, as Edit shares exports and Docs.");
    }
    body = given.text;
  }
  const headers = new Headers({ authorization: `Bearer ${token}` });
  for (const name of ASKED) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  console.log(JSON.stringify({ route: "google", who: found.kind === "person" ? found.sub : found.kind, call: `${request.method} ${path}`, ...(route.kind === "read" ? {} : { writes: route.kind }) }));
  let answer: Response;
  try {
    answer = await fetch(`https://${HOST}${path}${url.search}`, { method: request.method, headers, body, redirect: "manual" });
  } catch (error) {
    return json(502, { error: { code: 502, message: `Google didn't answer: ${error instanceof Error ? error.message : String(error)}` } });
  }
  const back = new Headers();
  for (const name of ANSWERED) {
    const value = answer.headers.get(name);
    if (value !== null) back.set(name, value);
  }
  return new Response(request.method === "HEAD" ? null : answer.body, { status: answer.status, headers: back });
}
