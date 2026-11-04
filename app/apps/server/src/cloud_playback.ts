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

/**
 * Whether the preview path may stream `key`: proxies, originals, excerpts,
 * and a pieced proxy's address (proxy_pieces.ts: `edit/pieces/…/proxy.mp4`,
 * answered from its pieces; none of the pieces' own files).
 */
export function previewable(key: string): boolean {
  return /^edit\/(proxies|originals|excerpts)\//.test(key) || /^edit\/pieces\/(v\d+\/)?[^/]+\/[^/]+\/proxy\.mp4$/.test(key);
}
