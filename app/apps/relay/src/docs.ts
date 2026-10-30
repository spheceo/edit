// Google Docs exports of a script, for the review page (feedback.spheceo.com:
// its share dialog's "Export to Google Docs" and its list of earlier ones).
// Moved here from Writer's relay (Oct 30: the Writer app is being
// discontinued), the same team Google account, folder and markers, so the
// Docs made before still list. The account's token never leaves the relay.

import { googleSignIn, type JobsEnv } from "./jobs";

const DOCS_FOLDER = "Writer scripts";
const DOC_MIME = "application/vnd.google-apps.document";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DRIVE = "https://www.googleapis.com/drive/v3/";
const MAX_DOCX_BYTES = 8_000_000;

class Problem extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let cached: { token: string; until: number } | null = null;

/** The team account's access token, kept until five minutes before it runs out. */
async function docsToken(env: JobsEnv): Promise<string> {
  if (cached && cached.until > Date.now()) return cached.token;
  const signedIn = await googleSignIn(env);
  cached = { token: signedIn.access_token, until: Date.now() + (signedIn.expires_in - 300) * 1000 };
  return signedIn.access_token;
}

async function google(env: JobsEnv, path: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(path, DRIVE);
  if (url.hostname !== "www.googleapis.com") throw new Problem(500, "Unexpected Google API host.");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${await docsToken(env)}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const reason = ((await response.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? "";
    throw new Problem(response.status === 404 ? 404 : 502, `Google ${response.status}: ${reason.slice(0, 300) || "request failed"}`);
  }
  return response;
}

const quoted = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const scriptId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f-]{8,80}$/i.test(value);
const problem = (error: unknown) =>
  error instanceof Problem ? json(error.status, { error: error.message }) : json(502, { error: `Google Docs failed: ${String(error).slice(0, 200)}` });

/** One folder in the account's Drive holds every exported script. */
async function docsFolder(env: JobsEnv): Promise<string> {
  const params = new URLSearchParams({ q: `name = '${DOCS_FOLDER}' and mimeType = '${FOLDER_MIME}' and 'root' in parents and trashed = false`, fields: "files(id)", pageSize: "1" });
  const found = (await (await google(env, `files?${params}`)).json()) as { files?: { id: string }[] };
  if (found.files?.[0]?.id) return found.files[0].id;
  const made = (await (await google(env, "files?fields=id", { method: "POST", body: JSON.stringify({ name: DOCS_FOLDER, mimeType: FOLDER_MIME }) })).json()) as { id: string };
  return made.id;
}

/**
 * A new Doc each time, never synced into an old one (Docs anchors comments
 * only when they arrive in an imported file), shared as anyone with the link
 * may edit and nobody may find it.
 */
export async function exportDoc(request: Request, env: JobsEnv): Promise<Response> {
  const size = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(size) || size <= 0) return json(411, { error: "Content-Length is required." });
  if (size > MAX_DOCX_BYTES * 1.4) return json(413, { error: "That script is too large to export." });
  const body = (await request.json().catch(() => null)) as { name?: unknown; scriptId?: unknown; draft?: unknown; docx?: unknown } | null;
  if (!body || typeof body.name !== "string" || !body.name.trim() || body.name.length > 300 || !scriptId(body.scriptId) || typeof body.docx !== "string") {
    return json(400, { error: "Send name, scriptId, draft and docx." });
  }
  try {
    const docx = Uint8Array.from(atob(body.docx), (char) => char.charCodeAt(0));
    if (docx.length > MAX_DOCX_BYTES) return json(413, { error: "That script is too large to export." });
    const draft = body.draft === true;
    const metadata = {
      name: draft ? `(DRAFT) ${body.name}` : body.name,
      mimeType: DOC_MIME,
      appProperties: { writerScript: body.scriptId, writerKind: draft ? "draft" : "script" },
      parents: [await docsFolder(env)],
    };
    const boundary = `edit-${crypto.randomUUID()}`;
    const made = (await (await google(env, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,createdTime", {
      method: "POST",
      headers: { "content-type": `multipart/related; boundary=${boundary}` },
      body: new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${DOCX_MIME}\r\n\r\n`, docx, `\r\n--${boundary}--`]),
    })).json()) as { id: string; name: string; createdTime?: string };
    await google(env, `files/${made.id}/permissions?fields=id&supportsAllDrives=true`, { method: "POST", body: JSON.stringify({ type: "anyone", role: "writer", allowFileDiscovery: false }) });
    return json(200, { id: made.id, url: `https://docs.google.com/document/d/${made.id}/edit`, name: made.name, draft, createdAt: made.createdTime ?? null, state: "live" });
  } catch (error) {
    return problem(error);
  }
}

/** Every Doc exported from a script, newest first, as Drive has them now. */
export async function listDocs(script: string, env: JobsEnv): Promise<Response> {
  if (!scriptId(script)) return json(400, { error: "Which script?" });
  try {
    const params = new URLSearchParams({
      q: `'${await docsFolder(env)}' in parents and mimeType = '${DOC_MIME}' and appProperties has { key='writerScript' and value='${quoted(script)}' }`,
      fields: "files(id,name,createdTime,trashed,appProperties)",
      orderBy: "createdTime desc",
      pageSize: "200",
    });
    const found = (await (await google(env, `files?${params}`)).json()) as { files?: { id: string; name: string; createdTime?: string; trashed?: boolean; appProperties?: Record<string, string> }[] };
    return json(
      200,
      (found.files ?? []).map((file) => ({
        id: file.id,
        url: `https://docs.google.com/document/d/${file.id}/edit`,
        name: file.name,
        draft: file.appProperties?.writerKind === "draft",
        createdAt: file.createdTime ?? null,
        state: file.trashed ? "trashed" : "live",
      })),
    );
  } catch (error) {
    return problem(error);
  }
}
