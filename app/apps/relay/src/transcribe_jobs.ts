/**
 * Long recordings heard without holding a connection open (Nov 1: Mathias's
 * 6 h 20 min and 7 h 43 min FOIA recordings were sent whole through
 * `/v1/transcribe`, which waits on Scribe; the connection dropped before Scribe
 * answered, three times each, and both imports stopped).
 *
 * Edit puts the audio in R2 under `edit/transcribe/`, then:
 *
 *   POST /v1/transcribe/jobs        {key, keyterms?, language?, again?}
 *        → 202 {id, request}: Scribe fetches the audio itself (a presigned
 *          URL, `cloud_storage_url`: up to 2 GB, so no 45 MB cap and no
 *          squeezed bitrate) and answers our webhook when it's done
 *   GET  /v1/transcribe/jobs/<id>?request=<request id>&key=<audio key>
 *        → 200 Scribe's JSON (the audio is deleted), 202 {pending: true}, or
 *          502 {error} when Scribe said it failed
 *   POST /v1/transcribe/webhook     ElevenLabs' callback (HMAC-signed): a
 *          failure is kept for the GET to say; a success needs nothing, the
 *          GET reads the transcript from Scribe
 *
 * Spend is reserved as `/v1/transcribe` reserves it, by the audio's bytes.
 */
import { allow, budgetKey, burstKey, type AuthEnv } from "./auth";
import { objectUrl, r2Config, r2Fetch, type CloudEnv } from "./cloud";

export interface JobsEnv extends CloudEnv, AuthEnv {
  ELEVENLABS_MAIN_KEY?: string;
  /** The workspace webhook ElevenLabs answers (POST /v1/workspace/webhooks, its url this relay's /v1/transcribe/webhook). */
  ELEVENLABS_WEBHOOK_ID?: string;
  /** Its HMAC secret, to check a callback is ElevenLabs'. */
  ELEVENLABS_WEBHOOK_SECRET?: string;
  BUDGET: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
  TRANSCRIBE_BURST: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

const SCRIBE = "https://api.elevenlabs.io/v1/speech-to-text";
const MODEL = "scribe_v2";
/** Where Edit puts a recording to be heard this way. */
export const JOB_AUDIO = /^edit\/transcribe\/[A-Za-z0-9_-]{8,100}\.ogg$/;
/** What Scribe said of a job that failed, by its request (and transcription) id. */
const FAILED = "edit/transcribe/failed/";
/** Scribe fetches by URL up to 2 GB. */
export const MAX_JOB_BYTES = 2_000_000_000;
/** How long Scribe has to fetch the audio. */
const FETCH_SECONDS = 6 * 3600;
const ID = /^[A-Za-z0-9_-]{6,100}$/;
/** A callback older than this is refused (a replay). */
const SIGNATURE_MAX_AGE_S = 30 * 60;

export async function transcribeJobs(request: Request, url: URL, env: JobsEnv): Promise<Response> {
  if (url.pathname === "/v1/transcribe/webhook" && request.method === "POST") return webhook(request, env);
  const found = await allow(request, env, "use", "transcribe/jobs");
  if (found instanceof Response) return found;
  const key = env.ELEVENLABS_MAIN_KEY;
  const r2 = r2Config(env);
  // Not set up here (or an older relay): Edit hears the file the old way.
  if (!key || !env.ELEVENLABS_WEBHOOK_ID || !r2) return json(503, { error: "Long transcriptions aren't set up on this relay yet.", jobs: false });

  if (url.pathname === "/v1/transcribe/jobs" && request.method === "POST") {
    let body: { key?: unknown; keyterms?: unknown; language?: unknown; again?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json(400, { error: "Send JSON: {key, keyterms?, language?, again?}." });
    }
    const audio = typeof body.key === "string" ? body.key : "";
    if (!JOB_AUDIO.test(audio)) return json(400, { error: "key must be edit/transcribe/<id>.ogg." });
    const keyterms = Array.isArray(body.keyterms) ? body.keyterms : [];
    if (keyterms.length > 100 || keyterms.some((term) => typeof term !== "string" || term.length < 1 || term.length >= 50 || /[<>{}[\]\\\u0000-\u001f]/.test(term))) {
      return json(400, { error: "Invalid keyterms: at most 100, each under 50 characters." });
    }
    const language = typeof body.language === "string" ? body.language : null;
    if (language !== null && !/^[a-zA-Z]{2,3}$/.test(language)) return json(400, { error: "Invalid language code." });
    const head = await r2Fetch(r2, "HEAD", audio, {}, { allow404: true });
    if (head.status === 404) return json(400, { error: "Upload the audio first." });
    const size = Number(head.headers.get("content-length"));
    if (!Number.isSafeInteger(size) || size <= 0) return json(400, { error: "The audio is empty." });
    if (size > MAX_JOB_BYTES) return json(413, { error: "That recording is too long even to hear by link (2 GB)." });
    if (!(await env.TRANSCRIBE_BURST.limit({ key: burstKey(request, found) })).success) return json(429, { error: "Too many transcriptions at once; try again in a minute." });
    const budget = env.BUDGET.get(env.BUDGET.idFromName(new Date().toISOString().slice(0, 10)));
    const reserved = await budget.fetch(new Request("https://budget/reserve", { method: "POST", body: JSON.stringify({ client: await budgetKey(request, found), size, again: body.again === true, job: true }) }));
    if (!reserved.ok) return reserved;

    const form = new FormData();
    for (const [name, value] of [["model_id", MODEL], ["diarize", "true"], ["timestamps_granularity", "word"], ["tag_audio_events", "false"]]) form.set(name, value!);
    if (language !== null) form.set("language_code", language);
    for (const term of keyterms as string[]) form.append("keyterms", term);
    form.set("cloud_storage_url", await objectUrl(r2, "GET", audio, {}, FETCH_SECONDS));
    form.set("webhook", "true");
    form.set("webhook_id", env.ELEVENLABS_WEBHOOK_ID);
    form.set("webhook_metadata", JSON.stringify({ key: audio }));
    const started = await fetch(SCRIBE, { method: "POST", headers: { "xi-api-key": key }, body: form });
    const text = await started.text();
    if (!started.ok) {
      // Refused: nothing will fetch the audio (Nov 1, the first live test left one behind when Scribe refused the job).
      await r2Fetch(r2, "DELETE", audio, {}, { allow404: true }).catch(() => undefined);
      return new Response(text, { status: started.status, headers: { "content-type": started.headers.get("content-type") ?? "application/json" } });
    }
    let answer: { transcription_id?: unknown; request_id?: unknown } = {};
    try {
      answer = JSON.parse(text) as typeof answer;
    } catch {
      // Below: no id to follow.
    }
    const id = typeof answer.transcription_id === "string" ? answer.transcription_id : typeof answer.request_id === "string" ? answer.request_id : null;
    if (id === null) return json(502, { error: `Scribe took the recording but gave no id to follow (${text.slice(0, 200)}).` });
    return json(202, { id, request: typeof answer.request_id === "string" ? answer.request_id : id });
  }

  const match = /^\/v1\/transcribe\/jobs\/([A-Za-z0-9_-]{6,100})$/.exec(url.pathname);
  if (match !== null && request.method === "GET") {
    const id = match[1]!;
    const requestId = url.searchParams.get("request");
    const audio = url.searchParams.get("key");
    for (const one of [id, requestId]) {
      if (one === null || !ID.test(one)) continue;
      const failed = await r2Fetch(r2, "GET", `${FAILED}${one}.json`, {}, { allow404: true });
      if (failed.status === 200) {
        const said = (await failed.json().catch(() => ({}))) as { error?: string };
        return json(502, { error: `Scribe couldn't hear it: ${said.error ?? "it failed"}` });
      }
    }
    const asked = await fetch(`${SCRIBE}/transcripts/${encodeURIComponent(id)}`, { headers: { "xi-api-key": key } });
    if (asked.status === 200) {
      // Heard: the audio has done its work.
      if (audio !== null && JOB_AUDIO.test(audio)) await r2Fetch(r2, "DELETE", audio, {}, { allow404: true }).catch(() => undefined);
      return new Response(asked.body, { status: 200, headers: { "content-type": asked.headers.get("content-type") ?? "application/json", "x-edit-model": MODEL } });
    }
    // Not there yet (Scribe answers 404 until it's done).
    if (asked.status === 404) return json(202, { pending: true });
    return new Response(await asked.text(), { status: asked.status, headers: { "content-type": asked.headers.get("content-type") ?? "application/json" } });
  }
  return json(404, { error: "not found" });
}

/** ElevenLabs' callback: checked against the secret, a failure kept for the GET. */
async function webhook(request: Request, env: JobsEnv): Promise<Response> {
  const secret = env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret) return json(503, { error: "not set up" });
  const raw = await request.text();
  if (!(await signed(raw, request.headers.get("elevenlabs-signature"), secret))) {
    console.log(JSON.stringify({ route: "transcribe/webhook", refused: "signature" }));
    return json(401, { error: "bad signature" });
  }
  let event: { type?: unknown; request_id?: unknown; error_message?: unknown; webhook_metadata?: unknown; data?: { request_id?: unknown; transcription_id?: unknown; webhook_metadata?: unknown } };
  try {
    event = JSON.parse(raw) as typeof event;
  } catch {
    return json(400, { error: "not JSON" });
  }
  const r2 = r2Config(env);
  if (event.type === "webhook_error" && r2 !== null) {
    const ids = [event.request_id, event.data?.request_id, event.data?.transcription_id].filter((one): one is string => typeof one === "string" && ID.test(one));
    const error = typeof event.error_message === "string" ? event.error_message.slice(0, 500) : "it failed";
    for (const one of new Set(ids)) await r2Fetch(r2, "PUT", `${FAILED}${one}.json`, {}, { body: JSON.stringify({ error, at: Date.now() }), headers: { "content-type": "application/json" } });
    const audio = metadataKey(event.webhook_metadata ?? event.data?.webhook_metadata);
    if (audio !== null) await r2Fetch(r2, "DELETE", audio, {}, { allow404: true }).catch(() => undefined);
    console.log(JSON.stringify({ route: "transcribe/webhook", failed: ids, error }));
  }
  return json(200, { ok: true });
}

function metadataKey(value: unknown): string | null {
  const object = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })() : value;
  const key = typeof object === "object" && object !== null ? (object as { key?: unknown }).key : undefined;
  return typeof key === "string" && JOB_AUDIO.test(key) ? key : null;
}

/**
 * ElevenLabs' signature: `t=<unix seconds>,v0=<hex HMAC-SHA256 of "<t>.<raw body>">`,
 * refused when older than half an hour.
 */
export async function signed(raw: string, header: string | null, secret: string, now = Date.now()): Promise<boolean> {
  if (header === null) return false;
  const parts = Object.fromEntries(header.split(",").map((part) => part.trim().split("=", 2) as [string, string]));
  const at = Number(parts.t);
  const given = parts.v0;
  if (!Number.isFinite(at) || typeof given !== "string" || Math.abs(now / 1000 - at) > SIGNATURE_MAX_AGE_S) return false;
  const mac = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", mac, new TextEncoder().encode(`${parts.t}.${raw}`)));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hex.length !== given.length) return false;
  let difference = 0;
  for (let i = 0; i < hex.length; i++) difference |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return difference === 0;
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
