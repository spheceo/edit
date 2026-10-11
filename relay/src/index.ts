declare const FixedLengthStream: { new(size: number): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } };

/**
 * Edit's relay. Holds the ElevenLabs key so Edit installs never do.
 *
 *   POST /v1/transcribe   body: audio (e.g. audio/ogg Opus), Content-Length required
 *                          → ElevenLabs Scribe v2 JSON (words with timings + speaker ids)
 *   GET  /v1/3dtiles/…     Google Photorealistic 3D Tiles (map stills)
 *   GET  /v1/geocode?address=… | ?latlng=… | ?place_id=…  Google Geocoding
 *   GET  /v1/outline?lat=…&lon=…  the building there (Google Geocoding v4 destinations)
 *   GET  /health
 *
 * Spend is bounded three ways: a burst limit per IP, a daily byte quota per
 * IP and a daily byte cap across everyone (atomic reservations). The audio streams
 * straight through to ElevenLabs and the answer streams straight back, so the
 * Worker never buffers or parses either (keeps CPU tiny on any plan).
 */

export interface Env {
  ELEVENLABS_API_KEY?: string;
  /** Google Map Tiles API key (Photorealistic 3D Tiles), for map stills. */
  GOOGLE_MAPS_KEY?: string;
  DAILY_MAP_SESSIONS_PER_IP: string;
  DAILY_MAP_SESSIONS_TOTAL: string;
  /** If set, requests must send `authorization: Bearer <token>`. */
  CLIENT_TOKEN?: string;
  BUDGET: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
  BURST: { limit(options: { key: string }): Promise<{ success: boolean }> };
  DAILY_BYTES_PER_IP: string;
  DAILY_BYTES_TOTAL: string;
  MAX_UPLOAD_BYTES: string;
}

const SCRIBE = "https://api.elevenlabs.io/v1/speech-to-text";
const MODEL = "scribe_v2";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json(200, { ok: true, transcription: Boolean(env.ELEVENLABS_API_KEY), maps: Boolean(env.GOOGLE_MAPS_KEY) });
    if (url.pathname.startsWith("/v1/3dtiles/")) return withCors(await tiles(request, url, env));
    if (url.pathname === "/v1/geocode") return geocode(request, url, env);
    if (url.pathname === "/v1/outline") return outline(request, url, env);
    if (url.pathname !== "/v1/transcribe") return json(404, { error: "not found" });
    if (request.method !== "POST") return json(405, { error: "POST audio to /v1/transcribe" });

    if (env.CLIENT_TOKEN && request.headers.get("authorization") !== `Bearer ${env.CLIENT_TOKEN}`) {
      return json(401, { error: "This relay needs a client token." });
    }
    if (!env.ELEVENLABS_API_KEY) return json(503, { error: "Transcription is not configured on the relay yet." });

    const type = request.headers.get("content-type") ?? "";
    if (!type.startsWith("audio/")) return json(415, { error: "Send audio (e.g. audio/ogg)." });
    const size = Number(request.headers.get("content-length"));
    if (!Number.isSafeInteger(size) || size <= 0) return json(411, { error: "Content-Length is required." });
    if (![env.MAX_UPLOAD_BYTES, env.DAILY_BYTES_PER_IP, env.DAILY_BYTES_TOTAL].every(value => Number.isSafeInteger(Number(value)) && Number(value) > 0)) return json(503, { error: "Transcription budget is misconfigured." });
    if (size > Number(env.MAX_UPLOAD_BYTES)) return json(413, { error: "That recording is too long for one request." });

    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    if (!(await env.BURST.limit({ key: ip })).success) {
      return json(429, { error: "Too many transcriptions at once; try again in a minute." });
    }
    const language = url.searchParams.get("language");
    if (language && !/^[a-zA-Z]{2,3}$/.test(language)) return json(400, { error: "Invalid language code." });
    const day = new Date().toISOString().slice(0, 10);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
    const client = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const budget = env.BUDGET.get(env.BUDGET.idFromName(day));
    const reserved = await budget.fetch(new Request("https://budget/reserve", { method: "POST", body: JSON.stringify({ client, size }) }));
    if (!reserved.ok) return reserved;

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

    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "x-edit-model": MODEL },
    });
  },
};

/**
 * Google's Photorealistic 3D Tiles with the key added here, so Edit's map
 * renderer never sees it. The tileset's own links are paths on this origin,
 * so every tile comes back through. Google bills per map session (a root
 * tileset request): those are rate-limited per connection and capped per day.
 */
async function tiles(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "GET") return json(405, { error: "GET tiles" });
  if (!env.GOOGLE_MAPS_KEY) return json(503, { error: "Maps are not configured on the relay yet." });
  if (url.pathname === "/v1/3dtiles/root.json") {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    if (!(await env.BURST.limit({ key: `maps:${ip}` })).success) return json(429, { error: "Too many maps at once; try again in a minute." });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
    const client = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const budget = env.BUDGET.get(env.BUDGET.idFromName(new Date().toISOString().slice(0, 10)));
    const reserved = await budget.fetch(new Request("https://budget/maps", { method: "POST", body: JSON.stringify({ client }) }));
    if (!reserved.ok) return reserved;
  }
  const upstream = new URL(`https://tile.googleapis.com${url.pathname}`);
  for (const [key, value] of url.searchParams) if (key !== "key") upstream.searchParams.set(key, value);
  upstream.searchParams.set("key", env.GOOGLE_MAPS_KEY);
  const answer = await fetch(upstream, { headers: { accept: request.headers.get("accept") ?? "*/*" } });
  const headers = new Headers();
  for (const name of ["content-type", "content-length", "cache-control", "etag"]) {
    const value = answer.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(answer.body, { status: answer.status, headers });
}

/** Where an address is, and the outline of the building there (Google's, since
 * only Google's geocoding may be shown with its tiles). */
async function geocode(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.method !== "GET") return json(405, { error: "GET /v1/geocode?address=…" });
  if (!env.GOOGLE_MAPS_KEY) return json(503, { error: "Maps are not configured on the relay yet." });
  if (!(await env.BURST.limit({ key: `geocode:${request.headers.get("cf-connecting-ip") ?? "unknown"}` })).success) return json(429, { error: "Too many lookups at once; try again in a minute." });
  const [name, value] = (["address", "latlng", "place_id"] as const).map((name) => [name, url.searchParams.get(name) ?? ""] as const).find(([, value]) => value) ?? ["", ""];
  if (!name || value.length > 300 || (name === "latlng" && !/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(value))) return json(400, { error: "Give an address, latlng or place_id." });
  const upstream = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  upstream.searchParams.set(name, value);
  upstream.searchParams.set("key", env.GOOGLE_MAPS_KEY);
  const answer = await fetch(upstream);
  return new Response(answer.body, { status: answer.status, headers: { "content-type": "application/json" } });
}

/** The building at a point, with its outline (GeoJSON in placeView.displayPolygon). */
async function outline(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.method !== "GET") return json(405, { error: "GET /v1/outline?lat=…&lon=…" });
  if (!env.GOOGLE_MAPS_KEY) return json(503, { error: "Maps are not configured on the relay yet." });
  const latitude = Number(url.searchParams.get("lat")), longitude = Number(url.searchParams.get("lon"));
  if (!url.searchParams.get("lat") || !url.searchParams.get("lon") || !(Math.abs(latitude) <= 90) || !(Math.abs(longitude) <= 180)) return json(400, { error: "Give lat and lon." });
  if (!(await env.BURST.limit({ key: `geocode:${request.headers.get("cf-connecting-ip") ?? "unknown"}` })).success) return json(429, { error: "Too many lookups at once; try again in a minute." });
  const answer = await fetch("https://geocode.googleapis.com/v4/geocode/destinations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": env.GOOGLE_MAPS_KEY,
      "x-goog-fieldmask": "destinations.primary,destinations.containingPlaces,destinations.subDestinations",
    },
    body: JSON.stringify({ locationQuery: { location: { latitude, longitude }, placeFilter: { structureType: "BUILDING", addressability: "ANY" } } }),
  });
  return new Response(answer.body, { status: answer.status, headers: { "content-type": "application/json" } });
}

/** Map pages run in a browser on another origin. */
function withCors(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-headers", "*");
  return new Response(response.body, { status: response.status, headers });
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

/** The namespace has one object per UTC day. Reserve before calling Scribe:
 * simultaneous requests cannot spend the same allowance. Failed requests keep
 * their reservation, because a network error cannot prove Scribe didn't bill.
 */
interface BudgetStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: number): Promise<void>;
  transaction<T>(callback: (storage: BudgetStorage) => Promise<T>): Promise<T>;
  setAlarm(time: number): Promise<void>;
  deleteAll(): Promise<void>;
}
interface BudgetState { storage: BudgetStorage }
export class TranscriptionBudget {
  constructor(private state: BudgetState, private env: Env) {}
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/maps") return this.mapSession(request);
    const { client, size } = await request.json() as { client: string; size: number };
    if (!/^[a-f0-9]{64}$/.test(client) || !Number.isSafeInteger(size) || size <= 0 || size > Number(this.env.MAX_UPLOAD_BYTES)) return json(400, { error: "Invalid budget reservation." });
    const answer = await this.state.storage.transaction(async storage => {
      const ipKey = `ip:${client}`;
      const ipUsed = await storage.get<number>(ipKey) ?? 0;
      const allUsed = await storage.get<number>("all") ?? 0;
      if (ipUsed + size > Number(this.env.DAILY_BYTES_PER_IP)) return json(429, { error: "Today's transcription allowance for this connection is used up; it resets at midnight UTC." });
      if (allUsed + size > Number(this.env.DAILY_BYTES_TOTAL)) return json(429, { error: "Edit's shared transcription budget for today is used up; it resets at midnight UTC." });
      await storage.put(ipKey, ipUsed + size);
      await storage.put("all", allUsed + size);
      return json(200, { ok: true });
    });
    await this.state.storage.setAlarm(Date.now() + 2 * 86400_000);
    return answer;
  }
  /** One map session (what Google bills), within today's caps. */
  async mapSession(request: Request): Promise<Response> {
    const { client } = await request.json() as { client: string };
    const perIp = Number(this.env.DAILY_MAP_SESSIONS_PER_IP);
    const total = Number(this.env.DAILY_MAP_SESSIONS_TOTAL);
    if (!/^[a-f0-9]{64}$/.test(client)) return json(400, { error: "Invalid map reservation." });
    if (![perIp, total].every((value) => Number.isSafeInteger(value) && value > 0)) return json(503, { error: "Map budget is misconfigured." });
    const answer = await this.state.storage.transaction(async storage => {
      const ipKey = `maps:${client}`;
      const ipUsed = await storage.get<number>(ipKey) ?? 0;
      const allUsed = await storage.get<number>("maps") ?? 0;
      if (ipUsed + 1 > perIp) return json(429, { error: "Today's map allowance for this connection is used up; it resets at midnight UTC." });
      if (allUsed + 1 > total) return json(429, { error: "Edit's shared map budget for today is used up; it resets at midnight UTC." });
      await storage.put(ipKey, ipUsed + 1);
      await storage.put("maps", allUsed + 1);
      return json(200, { ok: true });
    });
    await this.state.storage.setAlarm(Date.now() + 2 * 86400_000);
    return answer;
  }

  async alarm() { await this.state.storage.deleteAll(); }
}
