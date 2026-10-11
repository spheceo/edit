import INSTALL_SH from "./install.sh";

/**
 * Edit's relay. Holds the ElevenLabs key so Edit installs never do.
 *
 *   POST /v1/transcribe   body: audio (e.g. audio/ogg Opus), Content-Length required
 *                          → ElevenLabs Scribe v2 JSON (words with timings + speaker ids)
 *   GET  /v1/releases/latest?target=<triple>
 *                          → { tag, version, asset, size, sha256, url } or { tag: null }
 *   GET  /v1/releases/download/<tag|latest>/<asset>
 *                          → 302 to a short-lived GitHub download URL
 *   GET  /install.sh       → the installer (`curl -fsSL <relay>/install.sh | sh`)
 *   GET  /health
 *
 * Releases live on the private spheceo/edit repo; the relay reads them with a
 * read-only GITHUB_TOKEN so installs (and the updater) never need one.
 *
 * Spend is bounded three ways: a burst limit per IP, a daily byte quota per
 * IP and a daily byte cap across everyone (KV counters). The audio streams
 * straight through to ElevenLabs and the answer streams straight back, so the
 * Worker never buffers or parses either (keeps CPU tiny on any plan).
 */

export interface Env {
  ELEVENLABS_API_KEY?: string;
  /** Fine-grained token with read access to the repo's contents (releases). */
  GITHUB_TOKEN?: string;
  RELEASES_REPO: string;
  /** If set, transcription requests must send `authorization: Bearer <token>`. */
  CLIENT_TOKEN?: string;
  USAGE: KVNamespace;
  BURST: { limit(options: { key: string }): Promise<{ success: boolean }> };
  DAILY_BYTES_PER_IP: string;
  DAILY_BYTES_TOTAL: string;
  MAX_UPLOAD_BYTES: string;
}

const SCRIBE = "https://api.elevenlabs.io/v1/speech-to-text";
const MODEL = "scribe_v2";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json(200, { ok: true, transcription: Boolean(env.ELEVENLABS_API_KEY), releases: Boolean(env.GITHUB_TOKEN) });
    }
    if (url.pathname === "/install.sh") {
      return new Response(INSTALL_SH.replaceAll("__RELAY__", url.origin), { headers: { "content-type": "text/x-shellscript" } });
    }
    if (url.pathname.startsWith("/v1/releases/")) return releasesRoute(request, url, env);
    if (url.pathname !== "/v1/transcribe") return json(404, { error: "not found" });
    if (request.method !== "POST") return json(405, { error: "POST audio to /v1/transcribe" });

    if (env.CLIENT_TOKEN && request.headers.get("authorization") !== `Bearer ${env.CLIENT_TOKEN}`) {
      return json(401, { error: "This relay needs a client token." });
    }
    if (!env.ELEVENLABS_API_KEY) return json(503, { error: "Transcription is not configured on the relay yet." });

    const type = request.headers.get("content-type") ?? "";
    if (!type.startsWith("audio/")) return json(415, { error: "Send audio (e.g. audio/ogg)." });
    const size = Number(request.headers.get("content-length"));
    if (!Number.isFinite(size) || size <= 0) return json(411, { error: "Content-Length is required." });
    if (size > Number(env.MAX_UPLOAD_BYTES)) return json(413, { error: "That recording is too long for one request." });

    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    if (!(await env.BURST.limit({ key: ip })).success) {
      return json(429, { error: "Too many transcriptions at once; try again in a minute." });
    }
    const day = new Date().toISOString().slice(0, 10);
    const ipKey = `ip:${ip}:${day}`;
    const allKey = `all:${day}`;
    const [ipUsed, allUsed] = await Promise.all([env.USAGE.get(ipKey), env.USAGE.get(allKey)]).then((values) => values.map(Number));
    if ((ipUsed || 0) + size > Number(env.DAILY_BYTES_PER_IP)) {
      return json(429, { error: "Today's transcription allowance for this connection is used up; it resets at midnight UTC." });
    }
    if ((allUsed || 0) + size > Number(env.DAILY_BYTES_TOTAL)) {
      return json(429, { error: "Edit's shared transcription budget for today is used up; it resets at midnight UTC." });
    }

    const language = url.searchParams.get("language");
    const form = multipart(request.body!, size, type, {
      model_id: MODEL,
      diarize: "true",
      timestamps_granularity: "word",
      tag_audio_events: "false",
      ...(language ? { language_code: language } : {}),
    });
    const upstream = await fetch(SCRIBE, {
      method: "POST",
      headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "content-type": form.contentType },
      body: form.body,
    });

    if (upstream.ok) {
      // Count what was paid for. KV is eventually consistent; good enough for a budget.
      ctx.waitUntil(
        Promise.all([
          env.USAGE.put(ipKey, String((ipUsed || 0) + size), { expirationTtl: 2 * 86400 }),
          env.USAGE.put(allKey, String((allUsed || 0) + size), { expirationTtl: 2 * 86400 }),
        ]),
      );
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "x-edit-model": MODEL },
    });
  },
};

interface GithubAsset {
  id: number;
  name: string;
  size: number;
  /** "sha256:<hex>", which GitHub computes on upload. */
  digest?: string | null;
}

interface GithubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: GithubAsset[];
}

/** A new tag reaches updaters within this long (per Worker isolate). */
const RELEASES_TTL_MS = 5 * 60_000;
let releasesCache: { at: number; releases: GithubRelease[] } | null = null;

async function releasesRoute(request: Request, url: URL, env: Env): Promise<Response> {
  if (!env.GITHUB_TOKEN) return json(503, { error: "Releases are not configured on the relay yet." });
  if (request.method !== "GET") return json(405, { error: "GET only" });
  let releases: GithubRelease[];
  try {
    releases = await listReleases(env);
  } catch (error) {
    return json(502, { error: `could not read releases: ${error instanceof Error ? error.message : error}` });
  }

  const parts = url.pathname.split("/").slice(3);
  if (parts.length === 1 && parts[0] === "latest") {
    const target = url.searchParams.get("target") ?? "";
    if (!/^[a-z0-9_-]+$/.test(target)) return json(400, { error: "?target=<rust target triple> is required." });
    const name = `edit-${target}.tar.gz`;
    const found = newest(releases, name);
    if (!found) return json(200, { tag: null });
    const { release, asset } = found;
    const sha256 = asset.digest?.startsWith("sha256:")
      ? asset.digest.slice("sha256:".length)
      : await checksumAsset(env, release, name);
    if (!sha256) return json(502, { error: `${release.tag_name} has no checksum for ${name}` });
    return json(200, {
      tag: release.tag_name,
      version: release.tag_name.replace(/^v/, ""),
      asset: name,
      size: asset.size,
      sha256,
      url: `${url.origin}/v1/releases/download/${release.tag_name}/${name}`,
    });
  }
  if (parts.length === 3 && parts[0] === "download") {
    const [, tag, name] = parts;
    const release = tag === "latest" ? newest(releases, name)?.release : releases.find((release) => release.tag_name === tag);
    const asset = release?.assets.find((asset) => asset.name === name);
    if (!asset) return json(404, { error: `no ${name} in ${tag}` });
    const location = await assetLocation(env, asset);
    return location ? Response.redirect(location, 302) : json(502, { error: "GitHub did not hand out a download link" });
  }
  return json(404, { error: "not found" });
}

async function listReleases(env: Env): Promise<GithubRelease[]> {
  if (releasesCache && Date.now() - releasesCache.at < RELEASES_TTL_MS) return releasesCache.releases;
  const response = await github(env, "/releases?per_page=50");
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  const releases = (await response.json()) as GithubRelease[];
  releasesCache = { at: Date.now(), releases };
  return releases;
}

/** The highest stable version that has `asset` (not GitHub's "latest" flag, which follows publish order). */
function newest(releases: GithubRelease[], name: string) {
  let best: { version: number[]; release: GithubRelease; asset: GithubAsset } | null = null;
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const version = parseVersion(release.tag_name);
    const asset = release.assets.find((asset) => asset.name === name);
    if (!version || !asset) continue;
    if (!best || compare(version, best.version) > 0) best = { version, release, asset };
  }
  return best;
}

function parseVersion(tag: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return match ? match.slice(1).map(Number) : null;
}

function compare(a: number[], b: number[]) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** GitHub answers an asset download with a redirect to a signed URL that lasts a few minutes. */
async function assetLocation(env: Env, asset: GithubAsset): Promise<string | null> {
  const response = await github(env, `/releases/assets/${asset.id}`, { accept: "application/octet-stream", redirect: "manual" });
  return response.headers.get("location");
}

/** The `<asset>.sha256` file CI uploads, for assets GitHub has no digest for. */
async function checksumAsset(env: Env, release: GithubRelease, name: string): Promise<string | null> {
  const file = release.assets.find((asset) => asset.name === `${name}.sha256`);
  const location = file && (await assetLocation(env, file));
  if (!location) return null;
  const response = await fetch(location);
  if (!response.ok) return null;
  return (await response.text()).trim().split(/\s+/)[0]?.toLowerCase() || null;
}

function github(env: Env, path: string, options: { accept?: string; redirect?: RequestRedirect } = {}) {
  return fetch(`https://api.github.com/repos/${env.RELEASES_REPO}${path}`, {
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: options.accept ?? "application/vnd.github+json",
      "user-agent": "edit-relay",
      "x-github-api-version": "2022-11-28",
    },
    redirect: options.redirect ?? "follow",
  });
}

/**
 * A multipart/form-data body that streams `audio` between text fields, with an
 * exact Content-Length (FixedLengthStream) so nothing is buffered.
 */
function multipart(audio: ReadableStream<Uint8Array>, audioSize: number, audioType: string, fields: Record<string, string>) {
  const boundary = `edit-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const head = encoder.encode(
    Object.entries(fields)
      .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
      .join("") +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.ogg"\r\nContent-Type: ${audioType}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const { readable, writable } = new FixedLengthStream(head.length + audioSize + tail.length);
  const writer = writable.getWriter();
  (async () => {
    await writer.write(head);
    const reader = audio.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writer.write(value);
    }
    await writer.write(tail);
    await writer.close();
  })().catch((error) => writer.abort(error));
  return { body: readable, contentType: `multipart/form-data; boundary=${boundary}` };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
