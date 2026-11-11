/**
 * Who speaks when, from pyannoteAI (Precision-3), for Edit's voices (Sphe, Nov 8:
 * "scribe + pyannote for now, let's have it be a flag"). Scribe still hears the
 * words; its voice numbers drift on a long file (the Female Police Captain's
 * 84-minute interrogation, heard whole: Kimberly and the detective one voice
 * from 48:40 to 54:30, though the same 13 minutes heard alone came out right),
 * where pyannote kept every voice apart from start to end.
 *
 * Edit puts the audio in R2 (`edit/transcribe/<id>.ogg`, as for a Scribe job),
 * or names a recording already there (`edit/originals/…`: a YouTube video's
 * whole recording, so every excerpt of one case shares its voices), then:
 *
 *   POST /v1/diarize/jobs        {key}
 *        → 202 {id}: pyannote fetches the audio itself by a presigned link
 *   GET  /v1/diarize/jobs/<id>?key=<audio key>
 *        → 200 {model, segments: [{start, end, speaker}]} (an uploaded audio is
 *          deleted), 202 {pending: true}, or 502 {error} when pyannote failed
 *
 * The flag is `DIARIZE` ("pyannote" on, anything else off, wrangler.toml's
 * vars): /health says `diarize: true` only when it's on and the key is here,
 * and Edit asks it before each hearing, so turning it off is a relay deploy,
 * not an Edit release.
 */
import { allow, burstKey, type AuthEnv } from "./auth";
import { objectUrl, r2Config, r2Fetch, validKey, type CloudEnv } from "./cloud";
import { JOB_AUDIO } from "./transcribe_jobs";

export interface DiarizeEnv extends CloudEnv, AuthEnv {
  PYANNOTE_API_KEY?: string;
  /** "pyannote": voices from pyannote; anything else (or unset), Scribe's as before. */
  DIARIZE?: string;
  /** "pyannote": builds from Nov 11 on take pyannote's voices too (`voicesOf`); anything else, Scribe's alone. */
  VOICES?: string;
  TRANSCRIBE_BURST: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

const PYANNOTE = "https://api.pyannote.ai/v1";
export const DIARIZE_MODEL = "precision-3";
/** A recording already in the cloud whose voices are asked for as it is. */
const ORIGINAL = /^edit\/originals\//;
/** How long pyannote has to fetch the audio. */
const FETCH_SECONDS = 6 * 3600;
const ID = /^[A-Za-z0-9_-]{6,100}$/;

/** Whether this relay gives Edit pyannote's voices (the flag on, the key and R2 here). */
export function diarizeOn(env: DiarizeEnv): boolean {
  return env.DIARIZE === "pyannote" && Boolean(env.PYANNOTE_API_KEY) && r2Config(env) !== null;
}

/**
 * Whose voices Edit builds from Nov 11 on lay over Scribe's words (its
 * /health `voices`): "scribe" (Scribe's own) unless VOICES is "pyannote" and
 * pyannote is on. Apart from `diarize`, which older builds read: they keep
 * pyannote until they update (with it off, they'd hear each long file twice
 * in Scribe, in pieces and whole), then DIARIZE can go "off" too.
 */
export function voicesOf(env: DiarizeEnv): "pyannote" | "scribe" {
  return env.VOICES === "pyannote" && diarizeOn(env) ? "pyannote" : "scribe";
}

export async function diarizeJobs(request: Request, url: URL, env: DiarizeEnv): Promise<Response> {
  const found = await allow(request, env, "use", "diarize/jobs");
  if (found instanceof Response) return found;
  const r2 = r2Config(env);
  if (!diarizeOn(env) || r2 === null) return json(503, { error: "Voices from pyannote aren't on for this relay.", diarize: false });
  const auth = { authorization: `Bearer ${env.PYANNOTE_API_KEY}` };

  if (url.pathname === "/v1/diarize/jobs" && request.method === "POST") {
    let body: { key?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json(400, { error: "Send JSON: {key}." });
    }
    const audio = typeof body.key === "string" ? body.key : "";
    if (!JOB_AUDIO.test(audio) && !(ORIGINAL.test(audio) && validKey(audio))) return json(400, { error: "key must be edit/transcribe/<id>.ogg or a recording under edit/originals/." });
    const head = await r2Fetch(r2, "HEAD", audio, {}, { allow404: true });
    if (head.status === 404) return json(400, { error: "Upload the audio first." });
    if (!(await env.TRANSCRIBE_BURST.limit({ key: burstKey(request, found) })).success) return json(429, { error: "Too many hearings at once; try again in a minute." });
    const started = await fetch(`${PYANNOTE}/diarize`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ url: await objectUrl(r2, "GET", audio, {}, FETCH_SECONDS), model: DIARIZE_MODEL }),
    });
    const text = await started.text();
    if (!started.ok) {
      // Refused: nothing will fetch an upload of Edit's.
      if (JOB_AUDIO.test(audio)) await r2Fetch(r2, "DELETE", audio, {}, { allow404: true }).catch(() => undefined);
      return json(started.status === 429 ? 429 : 502, { error: `pyannote refused it (${started.status}): ${text.slice(0, 300)}` });
    }
    let answer: { jobId?: unknown } = {};
    try {
      answer = JSON.parse(text) as typeof answer;
    } catch {
      // Below: no id to follow.
    }
    if (typeof answer.jobId !== "string" || !ID.test(answer.jobId)) return json(502, { error: `pyannote took the recording but gave no job to follow (${text.slice(0, 200)}).` });
    console.log(JSON.stringify({ route: "diarize/jobs", started: answer.jobId, key: audio }));
    return json(202, { id: answer.jobId });
  }

  const match = /^\/v1\/diarize\/jobs\/([A-Za-z0-9_-]{6,100})$/.exec(url.pathname);
  if (match !== null && request.method === "GET") {
    const asked = await fetch(`${PYANNOTE}/jobs/${encodeURIComponent(match[1]!)}`, { headers: auth });
    if (!asked.ok) return json(asked.status === 404 ? 404 : 502, { error: `pyannote couldn't say how it's going (${asked.status}): ${(await asked.text()).slice(0, 200)}` });
    const job = (await asked.json().catch(() => ({}))) as { status?: unknown; output?: { diarization?: unknown; error?: unknown } };
    const audio = url.searchParams.get("key");
    const done = () => (audio !== null && JOB_AUDIO.test(audio) ? r2Fetch(r2, "DELETE", audio, {}, { allow404: true }).catch(() => undefined) : Promise.resolve());
    if (job.status === "failed" || job.status === "canceled") {
      await done();
      return json(502, { error: `pyannote couldn't hear it: ${typeof job.output?.error === "string" ? job.output.error : job.status}` });
    }
    if (job.status !== "succeeded") return json(202, { pending: true });
    const segments = Array.isArray(job.output?.diarization) ? job.output.diarization : null;
    if (segments === null) return json(502, { error: "pyannote said it was done but gave no voices." });
    await done();
    return json(200, { model: `pyannote-${DIARIZE_MODEL}`, segments });
  }
  return json(404, { error: "not found" });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
