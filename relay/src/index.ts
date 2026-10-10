/**
 * Edit's relay. Holds the ElevenLabs key so Edit installs never do.
 *
 *   POST /v1/transcribe   body: audio (e.g. audio/ogg Opus), Content-Length required
 *                          → ElevenLabs Scribe v2 JSON (words with timings + speaker ids)
 *   GET  /health
 *
 * Spend is bounded three ways: a burst limit per IP, a daily byte quota per
 * IP and a daily byte cap across everyone (KV counters). The audio streams
 * straight through to ElevenLabs and the answer streams straight back, so the
 * Worker never buffers or parses either (keeps CPU tiny on any plan).
 */

export interface Env {
  ELEVENLABS_API_KEY?: string;
  /** If set, requests must send `authorization: Bearer <token>`. */
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
