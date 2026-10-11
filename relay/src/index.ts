declare const FixedLengthStream: { new(size: number): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } };

/**
 * Edit's relay. Holds the ElevenLabs key so Edit installs never do.
 *
 *   POST /v1/transcribe   body: audio (e.g. audio/ogg Opus), Content-Length required
 *                          → ElevenLabs Scribe v2 JSON (words with timings + speaker ids)
 *   GET  /health
 *
 * Spend is bounded three ways: a burst limit per IP, a daily byte quota per
 * IP and a daily byte cap across everyone (atomic reservations). The audio streams
 * straight through to ElevenLabs and the answer streams straight back, so the
 * Worker never buffers or parses either (keeps CPU tiny on any plan).
 */

export interface Env {
  ELEVENLABS_API_KEY?: string;
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
    if (url.pathname === "/health") return json(200, { ok: true, transcription: Boolean(env.ELEVENLABS_API_KEY) });
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
  async alarm() { await this.state.storage.deleteAll(); }
}
