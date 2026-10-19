// Where Edit's direct calls to Google (Drive, Docs, sign-in) and to the AI
// Gateway go: the real services, or a stand-in for tests.
//
// - `EDIT_GOOGLE_API_URL=http://127.0.0.1:7900` sends `https://<host>/<path>`
//   for every Google host to `http://127.0.0.1:7900/<host>/<path>` (one mock
//   can answer all of them and still tell them apart).
// - `EDIT_AI_GATEWAY_URL=http://127.0.0.1:7901` posts chat completions to
//   `http://127.0.0.1:7901/v1/chat/completions`.
//
// Unset (always, outside tests), nothing changes. A stand-in over plain http
// is allowed only while one is set.

/** The Vercel AI Gateway Edit asks models through (watch, seats). */
const GATEWAY = "https://ai-gateway.vercel.sh";

/** A stand-in's base URL, as given (no trailing slash), if one is set. */
export function base(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed === "" ? null : trimmed;
}

/** `url` (a Google `https://` URL) as this run reaches it. */
export function google(url: string): string {
  return googleThrough(base(process.env.EDIT_GOOGLE_API_URL), url);
}

export function googleThrough(stand: string | null, url: string): string {
  if (stand !== null && url.startsWith("https://")) return `${stand}/${url.slice("https://".length)}`;
  return url;
}

/** The protocols curl may use for Google calls (`--proto`): HTTPS only, unless a stand-in over http is set. */
export function googleProto(): string {
  return protocols(base(process.env.EDIT_GOOGLE_API_URL));
}

/** The AI Gateway's chat completions URL. */
export function gateway(): string {
  return gatewayThrough(base(process.env.EDIT_AI_GATEWAY_URL));
}

export function gatewayThrough(stand: string | null): string {
  return `${stand ?? GATEWAY}/v1/chat/completions`;
}

export function protocols(stand: string | null): string {
  return stand !== null && stand.startsWith("http://") ? "=http,https" : "=https";
}
