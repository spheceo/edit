// Thumbnails (Nov 2 2026): the server's /api/thumbnails, for the thumbnails
// list and a thumbnail's page. A thumbnail is the team's (mamagi, through the
// relay); this Mac's server runs Claude on it and draws it.

import type { OpenArtState, Thumbnail, ThumbRow } from "@edit/types/thumbnails";

export type * from "@edit/types/thumbnails";

async function call<T>(method: string, path: string, body?: unknown, raw?: { bytes: Blob; type: string }): Promise<T> {
  const response = await fetch(path, {
    method,
    ...(raw !== undefined ? { headers: { "content-type": raw.type }, body: raw.bytes } : body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const said = parsed !== null && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string" ? (parsed as { error: string }).error : text || `${response.status}`;
    throw new Error(said);
  }
  return parsed as T;
}

const base = (id: string) => `/api/thumbnails/${encodeURIComponent(id)}`;

export const thumbnailsApi = {
  list: () => call<{ thumbnails: ThumbRow[] }>("GET", "/api/thumbnails"),
  create: (title = "", brief = "") => call<{ id: string }>("POST", "/api/thumbnails", { title, brief }),
  get: (id: string) => call<{ thumb: Thumbnail; rev: number }>("GET", base(id)),
  change: (id: string, change: { title?: string; brief?: string }) => call<{ thumb: Thumbnail; rev: number }>("PUT", base(id), change),
  remove: (id: string) => call<void>("DELETE", base(id)),
  chat: (id: string, text: string, images: string[]) => call<{ ok: true }>("POST", `${base(id)}/chat`, { text, images }),
  stop: (id: string) => call<{ stopped: boolean }>("POST", `${base(id)}/stop`),
  switchVersion: (id: string, version: string) => call<{ thumb: Thumbnail; rev: number }>("POST", `${base(id)}/versions/switch`, { version }),
  takeFinal: (id: string, version: string) => call<{ thumb: Thumbnail; rev: number }>("POST", `${base(id)}/versions/final`, { version }),
  /** The team's OpenArt accounts with their credits, and the one in use on this Mac. */
  openart: () => call<OpenArtState>("GET", "/api/thumbnails/openart"),
  useOpenart: (account: string) => call<OpenArtState>("PUT", "/api/thumbnails/openart", { account }),
};

/** Where a layer's picture is: the thumbnail's image, or the library's. */
export const sourceUrl = (id: string, source: string): string =>
  source.startsWith("asset:") ? `/api/thumbnails/assets/${encodeURIComponent(source.slice(6))}/file` : `${base(id)}/images/${encodeURIComponent(source)}`;

export const renderUrl = (id: string, at: number | null | undefined): string => `${base(id)}/render?at=${at ?? 0}`;

export const working = (thumb: Thumbnail): boolean => thumb.run !== null && (thumb.run.state === "running" || thumb.run.state === "queued");
