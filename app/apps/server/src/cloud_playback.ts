// Stable, credential-free inputs for native decoders. The server forwards
// byte ranges from R2; no proxy is downloaded or written to the Mac.

export const PLAYBACK_ROUTE = "/api/cloud/preview";

export function playbackPath(key: string, port: number): string {
  return `http://127.0.0.1:${port}${PLAYBACK_ROUTE}?key=${encodeURIComponent(key)}`;
}

export function playbackKey(path: string): string | null {
  if (!path.startsWith("http://127.0.0.1:")) return null;
  try {
    const url = new URL(path);
    return url.pathname === PLAYBACK_ROUTE ? url.searchParams.get("key") : null;
  } catch {
    return null;
  }
}
