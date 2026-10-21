// Gemini's own API in place of the AI Gateway, for a machine with a Gemini
// key and no gateway credit (`EDIT_AI_PROVIDER=gemini`, `GEMINI_API_KEY`):
// the gateway's chat-completions request (text, images and video as data
// URLs, a JSON schema for the answer) becomes a generateContent request, and
// its answer comes back shaped as the gateway's, so every caller of
// watch.post works unchanged. The free tier counts requests a minute and a
// day per model, so calls go a few at a time, a minute's 429 or a 503 waits
// and asks again, and a model whose day is used up hands over to the next
// Flash model (each has its own free quota) until midnight Pacific time.

import { Semaphore } from "./media.ts";
import { serdeParse, trim } from "./rust.ts";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = 240_000;
const AT_ONCE = Number(process.env.EDIT_GEMINI_AT_ONCE ?? "4");
const ATTEMPTS = 8;
const lane = new Semaphore(Number.isFinite(AT_ONCE) && AT_ONCE > 0 ? AT_ONCE : 4);
/** The Flash models to fall back on, best first (`EDIT_GEMINI_MODELS` overrides). */
const MODELS = (process.env.EDIT_GEMINI_MODELS ?? "gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3-flash-preview,gemini-2.5-flash,gemini-flash-latest,gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-2.5-flash-lite,gemini-flash-lite-latest")
  .split(",")
  .map((model) => model.trim())
  .filter((model) => model !== "");
/** Models whose free day is used up, and when it's over (ms). */
const spent = new Map<string, number>();

/** The models to try for a request, the one asked for first, none whose day is spent. */
export function order(asked: string, now = Date.now()): string[] {
  const all = [asked, ...MODELS.filter((model) => model !== asked)];
  return all.filter((model) => (spent.get(model) ?? 0) <= now);
}

/** The next midnight in California, when the free quotas reset. */
function nextReset(now = Date.now()): number {
  const pacific = new Date(new Date(now).toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const offset = now - pacific.getTime();
  pacific.setHours(24, 5, 0, 0);
  return pacific.getTime() + offset;
}

type Json = Record<string, unknown>;

/** A data URL's type and base64 body, or null. */
function dataUrl(url: unknown): { mime_type: string; data: string } | null {
  if (typeof url !== "string") return null;
  const match = /^data:([^;,]+);base64,(.*)$/su.exec(url);
  return match === null ? null : { mime_type: match[1]!, data: match[2]! };
}

/** One chat message's content as Gemini parts. */
function parts(content: unknown): Json[] {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [];
  const out: Json[] = [];
  for (const raw of content as Json[]) {
    if (raw.type === "text" && typeof raw.text === "string") out.push({ text: raw.text });
    else if (raw.type === "image_url") {
      const inline = dataUrl((raw.image_url as Json | undefined)?.url);
      if (inline !== null) out.push({ inline_data: inline });
    } else if (raw.type === "file") {
      const inline = dataUrl((raw.file as Json | undefined)?.file_data);
      if (inline !== null) out.push({ inline_data: inline });
    }
  }
  return out;
}

/** The gateway's request as Gemini's generateContent body, and the model to call. */
export function translate(request: Json): { model: string; body: Json } {
  const given = typeof request.model === "string" ? request.model : "gemini-flash-latest";
  const model = trim(process.env.EDIT_GEMINI_MODEL ?? "") || given.replace(/^google\//u, "");
  const contents: Json[] = [];
  const system: Json[] = [];
  for (const message of (Array.isArray(request.messages) ? request.messages : []) as Json[]) {
    if (message.role === "system") system.push(...parts(message.content));
    else contents.push({ role: message.role === "assistant" ? "model" : "user", parts: parts(message.content) });
  }
  const config: Json = {};
  const format = request.response_format as Json | undefined;
  if (format?.type === "json_schema" || format?.type === "json_object") {
    config.responseMimeType = "application/json";
    const schema = (format.json_schema as Json | undefined)?.schema;
    if (schema !== undefined) config.responseJsonSchema = schema;
  }
  const body: Json = { contents, generationConfig: config };
  if (system.length > 0) body.systemInstruction = { parts: system };
  return { model, body };
}

/** Gemini's answer shaped as the gateway's: choices[0].message.content. */
export function answer(value: unknown): Json {
  const candidate = ((value as Json | null)?.candidates as Json[] | undefined)?.[0];
  const text = (((candidate?.content as Json | undefined)?.parts as Json[] | undefined) ?? [])
    .filter((part) => typeof part.text === "string" && part.thought !== true)
    .map((part) => part.text as string)
    .join("");
  return { choices: [{ message: { content: text } }], usage: { cost: 0 } };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Posts a gateway request (its bytes) to Gemini and answers as the gateway would. */
export async function post(bytes: Uint8Array): Promise<unknown> {
  const key = trim(process.env.GEMINI_API_KEY ?? "");
  if (key === "") throw new Error("EDIT_AI_PROVIDER is gemini but GEMINI_API_KEY isn't set");
  const { model: asked, body } = translate(serdeParse(new TextDecoder().decode(bytes)) as Json);
  const release = await lane.acquire();
  try {
    let last = "no Gemini model left today";
    for (const model of order(asked)) {
      let sent = JSON.stringify(body);
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        let status: number;
        let text: string;
        try {
          const response = await fetch(`${BASE}/${encodeURIComponent(model)}:generateContent`, {
            method: "POST",
            headers: { "x-goog-api-key": key, "content-type": "application/json" },
            body: sent,
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          status = response.status;
          text = await response.text();
        } catch (error) {
          last = `couldn't reach Gemini: ${error instanceof Error ? error.message : String(error)}`;
          await pause(2_000 * attempt);
          continue;
        }
        if (status === 200) return answer(serdeParse(text));
        let message = text.slice(0, 300);
        try {
          const error = (serdeParse(text) as Json).error as Json | undefined;
          if (typeof error?.message === "string") message = error.message;
        } catch {
          // the body isn't JSON
        }
        last = `Gemini (${model}) answered ${status}: ${message}`;
        // A schema Gemini can't take: ask for plain JSON instead.
        if (status === 400 && /schema/iu.test(text) && (body.generationConfig as Json).responseJsonSchema !== undefined) {
          delete (body.generationConfig as Json).responseJsonSchema;
          sent = JSON.stringify(body);
          continue;
        }
        // The day's quota for this model: on to the next one.
        if (status === 429 && /per ?day|PerDay|daily/iu.test(text)) {
          spent.set(model, nextReset());
          break;
        }
        // A model this key can't use (no free quota, not found): the next one.
        if (status === 404 || (status === 429 && /limit: 0\b/iu.test(text)) || status === 403) {
          spent.set(model, nextReset());
          break;
        }
        if (status === 429 || status >= 500) {
          await pause(Math.min(60_000, 4_000 * 2 ** (attempt - 1)));
          continue;
        }
        throw new Error(last);
      }
    }
    throw new Error(last);
  } finally {
    release();
  }
}
