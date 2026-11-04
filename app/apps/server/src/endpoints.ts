// Where Edit's direct calls to Google (Drive, Docs, sign-in) go: the real
// services, or a stand-in for tests.
//
// - `EDIT_GOOGLE_API_URL=http://127.0.0.1:7900` sends `https://<host>/<path>`
//   for every Google host to `http://127.0.0.1:7900/<host>/<path>` (one mock
//   can answer all of them and still tell them apart).
//
// Unset (always, outside tests), nothing changes. A stand-in over plain http
// is allowed only while one is set.

/** A stand-in's base URL, as given (no trailing slash), if one is set. */
export function base(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed === "" ? null : trimmed;
}

/**
 * The relay's Google gateway (`<relay>/v1/google`), or null when this Mac
 * signs in to Google itself (GOOGLE_DRIVE_* set: a developer's Mac). Nov 4,
 * the security audit: the team's Google token never leaves the relay, so
 * every call to Google's API goes through it with the person's own Edit
 * sign-in, and only the calls Edit makes are made (relay's google.ts).
 * library.ts says which.
 */
let gateway: () => string | null = () => null;
export function useGateway(at: () => string | null): void {
  gateway = at;
}

const API = "https://www.googleapis.com/";

/** `url` (a Google `https://` URL) as this run reaches it: a stand-in's, the relay's gateway for Google's API, or Google itself. */
export function google(url: string): string {
  const stand = base(process.env.EDIT_GOOGLE_API_URL);
  if (stand !== null) return googleThrough(stand, url);
  const through = gateway();
  if (through !== null && url.startsWith(API)) return `${through}/${url.slice("https://".length)}`;
  return url;
}

/** Whether `url` is Google's API as this run reaches it: where the sign-in may go. */
export function isGoogleApi(url: string): boolean {
  return url.startsWith(google(API));
}

export function googleThrough(stand: string | null, url: string): string {
  if (stand !== null && url.startsWith("https://")) return `${stand}/${url.slice("https://".length)}`;
  return url;
}

/** The protocols curl may use for Google calls (`--proto`): HTTPS only, unless a stand-in over http is set. */
export function googleProto(): string {
  return protocols(base(process.env.EDIT_GOOGLE_API_URL) ?? gateway());
}

export function protocols(stand: string | null): string {
  return stand !== null && stand.startsWith("http://") ? "=http,https" : "=https";
}
