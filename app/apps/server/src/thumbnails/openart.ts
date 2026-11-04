// OpenArt, for thumbnails' pictures: its MCP server on the team's accounts
// (ACCOUNTS, ours to add in code, never the person's), always through the
// relay, which holds each one's sign-in. Brought over from Thumb (`code/thumb`, its
// generations.ts): the model list and forms, a picture made from a prompt
// and the pictures it's given (uploaded to OpenArt first), waited on until
// it's done, and its bytes.

import * as fs from "node:fs";

import * as diag from "../diag.ts";
import { writeAtomic } from "../files.ts";
import { join } from "../paths.ts";
import * as relay from "../relay.ts";
import { BUILD } from "../version.ts";

const PROTOCOL = "2025-06-18";

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null);

/**
 * The team's OpenArt accounts (Sphe, Nov 4: "these are accounts that we are
 * going to add ourselves in the code"): each one's sign-in lives on the relay,
 * at its own route. Pictures are made on the one in use on this Mac (the
 * page's account menu; the first until someone picks another).
 */
export type Account = { id: string; name: string; route: string };
export const ACCOUNTS: Account[] = [{ id: "mamagi-openart-1", name: "OpenArt 1", route: "/v1/openart/mcp" }];

const CHOICE = "openart-account.json";
let home: string | null = null;
let chosen: Account = ACCOUNTS[0]!;

/** Where this Mac keeps which account is in use (`<home>/openart-account.json`). */
export function useHome(dir: string): void {
  home = dir;
  try {
    const saved = (JSON.parse(fs.readFileSync(join(dir, CHOICE), "utf8")) as { account?: unknown }).account;
    chosen = ACCOUNTS.find((one) => one.id === saved) ?? ACCOUNTS[0]!;
  } catch {
    chosen = ACCOUNTS[0]!;
  }
}

/** The account pictures are made on. */
export const current = (): Account => chosen;

/** Use another of the team's accounts on this Mac. */
export function choose(id: string): Account {
  const found = ACCOUNTS.find((one) => one.id === id);
  if (found === undefined) throw new Error(`There's no OpenArt account ${id}.`);
  chosen = found;
  if (home !== null) writeAtomic(join(home, CHOICE), JSON.stringify({ account: found.id }));
  return found;
}

/** Test hook: how a message reaches OpenArt (through the relay). */
export const transport = {
  post: async (body: unknown, session: string | null, signal?: AbortSignal, account: Account = chosen): Promise<Response> =>
    fetch(`${relay.url()}${account.route}`, {
      method: "POST",
      headers: { ...relay.authHeaders(), "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL, ...(session ? { "mcp-session-id": session } : {}) },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(120_000),
    }),
};

/** Each account's MCP session, kept ten minutes. */
const sessions = new Map<string, { id: string | null; at: number }>();
let next = 1;

/** One JSON-RPC answer out of a JSON or event-stream reply. */
async function answerOf(response: Response, id: number): Promise<Json> {
  const text = await response.text();
  if (!response.ok) {
    let said = text.slice(0, 300);
    try {
      const error = (JSON.parse(text) as { error?: unknown }).error;
      if (typeof error === "string") said = error;
    } catch {
      // As it came.
    }
    throw new Error(`OpenArt (${response.status}): ${said}`);
  }
  const messages: unknown[] = [];
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data === "") continue;
      try {
        messages.push(JSON.parse(data));
      } catch {
        // Not a message.
      }
    }
  } else if (text.trim() !== "") messages.push(JSON.parse(text));
  const found = messages.flat().map(record).find((one) => one !== null && one.id === id);
  if (found == null) throw new Error("OpenArt didn't answer the request.");
  const error = record(found.error);
  if (error !== null) throw new Error(`OpenArt: ${typeof error.message === "string" ? error.message : "refused"}`);
  return record(found.result) ?? {};
}

async function open(account: Account, signal?: AbortSignal): Promise<string | null> {
  const session = sessions.get(account.id);
  if (session !== undefined && Date.now() - session.at < 10 * 60_000) return session.id;
  const id = next++;
  const response = await transport.post({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "edit-thumbnails", version: BUILD } } }, null, signal, account);
  const sessionId = response.headers.get("mcp-session-id");
  await answerOf(response, id);
  await transport.post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId, signal, account).then((one) => one.body?.cancel());
  sessions.set(account.id, { id: sessionId, at: Date.now() });
  return sessionId;
}

/** One of OpenArt's tools, on the account in use unless another is named: its answer's data (structured, or its text as JSON). */
export async function tool(name: string, args: Json, signal?: AbortSignal, account: Account = chosen): Promise<Json> {
  for (let attempt = 0; ; attempt++) {
    const sessionId = await open(account, signal);
    const id = next++;
    const response = await transport.post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, sessionId, signal, account);
    // A session OpenArt forgot: opened again once.
    if ((response.status === 404 || response.status === 400) && attempt === 0 && sessionId !== null) {
      await response.body?.cancel();
      sessions.delete(account.id);
      continue;
    }
    sessions.set(account.id, { id: sessionId, at: Date.now() });
    return dataOf(await answerOf(response, id));
  }
}

function dataOf(result: Json): Json {
  const content = Array.isArray(result.content) ? (result.content as Json[]) : [];
  const text = content.find((part) => part?.type === "text" && typeof part.text === "string")?.text as string | undefined;
  let parsed = record(result.structuredContent);
  if (parsed === null && text !== undefined) {
    try {
      parsed = record(JSON.parse(text));
    } catch {
      parsed = { message: text };
    }
  }
  if (result.isError === true) {
    const message = parsed?.message ?? parsed?.error;
    throw new Error(typeof message === "string" ? `OpenArt: ${message}` : "OpenArt refused the request.");
  }
  return parsed ?? {};
}

// ---------------------------------------------------------------- models

export type Model = { id: string; name: string; description: string; credits: number | null; edits: boolean; affordable: boolean };

/** Each account's models (what it can afford differs). */
const models = new Map<string, { at: number; list: Model[] }>();

/** OpenArt's image models on the account in use: what each costs from a prompt, and whether it takes pictures (edits). Kept ten minutes. */
export async function imageModels(signal?: AbortSignal, account: Account = chosen): Promise<Model[]> {
  const kept = models.get(account.id);
  if (kept !== undefined && Date.now() - kept.at < 10 * 60_000) return kept.list;
  const data = await tool("openart_model_list", {}, signal, account);
  const list = (Array.isArray(data.models) ? data.models : []).flatMap((value): Model[] => {
    const model = record(value);
    const modes = record(model?.modes);
    const image = Array.isArray(modes?.image) ? (modes.image as unknown[]).map(record) : [];
    const text = image.find((mode) => mode?.mode === "text2image");
    const edit = image.find((mode) => mode?.mode === "image2image");
    if (model === null || typeof model.id !== "string" || (text === undefined && edit === undefined)) return [];
    const priced = text ?? edit;
    return [
      {
        id: model.id,
        name: typeof model.displayName === "string" ? model.displayName : model.id,
        description: typeof model.description === "string" ? model.description.slice(0, 240) : "",
        credits: typeof priced?.totalCredits === "number" ? priced.totalCredits : null,
        edits: edit !== undefined,
        affordable: priced?.affordable !== false,
      },
    ];
  });
  models.set(account.id, { at: Date.now(), list });
  return list;
}

/** An account's plan and the credits it has left. */
export async function account(signal?: AbortSignal, which: Account = chosen): Promise<{ plan: string | null; credits: number | null }> {
  const data = await tool("openart_account_get", {}, signal, which);
  return { plan: typeof data.plan === "string" ? data.plan : null, credits: typeof data.credits === "number" ? data.credits : null };
}

// ---------------------------------------------------------------- a picture

const ASPECT = /^aspect[_-]?ratio$/i;
const HIDDEN = new Set(["prompt", "visualreferences", "imagecount", "customwidth", "customheight", "lockaspectratio", "outputcompression", "outputformat", "resulttype", "seriesamount"]);

export type Reference = { bytes: Uint8Array; type: string; name: string };

/** A picture handed to OpenArt (sign, PUT, confirm): its reference for a request. */
async function upload(reference: Reference, signal: AbortSignal | undefined, account: Account): Promise<Json> {
  const label = reference.name.replace(/\.[^.]+$/, "").slice(0, 60) || "reference";
  const extension = reference.type === "image/png" ? "png" : reference.type === "image/webp" ? "webp" : "jpg";
  const signed = await tool("openart_upload_sign", { mediaType: "image", filename: `${label}.${extension}`, size: reference.bytes.byteLength, contentType: reference.type, label, purpose: "create-image" }, signal, account);
  if (typeof signed.signURL !== "string" || typeof signed.accessURL !== "string" || typeof signed.uploadId !== "string") throw new Error("OpenArt gave no upload address.");
  const put = await fetch(signed.signURL, { method: "PUT", headers: { "content-type": reference.type }, body: reference.bytes, signal: signal ?? AbortSignal.timeout(120_000) });
  if (!put.ok) throw new Error(`OpenArt refused the picture (${put.status}).`);
  const confirmed = await tool("openart_upload_metadata_get", { mediaUrl: signed.accessURL, mediaType: "image", uploadId: signed.uploadId, label }, signal, account);
  const found = record(confirmed.visualReference);
  if (found === null || typeof found.id !== "string" || typeof found.url !== "string") throw new Error("OpenArt didn't take the picture.");
  return { type: "image", id: found.id, url: found.url, label: typeof found.label === "string" ? found.label : label };
}

/** The request's params from the model's form: the prompt, the aspect it takes, its defaults. */
export function paramsOf(form: Json, prompt: string, aspect: string, references: Json[], options: Json): Json {
  const schema = record(form.jsonSchema);
  const properties = record(schema?.properties);
  if (properties === null || record(properties.prompt) === null) throw new Error("OpenArt's form for this model has no prompt.");
  const params: Json = { prompt };
  const aspectKey = Object.keys(properties).find((key) => ASPECT.test(key));
  if (aspectKey !== undefined) {
    const field = record(properties[aspectKey]);
    const allowed = Array.isArray(field?.enum) ? (field.enum as unknown[]).filter((one): one is string => typeof one === "string") : [];
    params[aspectKey] = allowed.length === 0 || allowed.includes(aspect) ? aspect : (allowed.find((one) => one === "16:9") ?? (typeof field?.default === "string" ? field.default : allowed[0]));
  }
  for (const [key, value] of Object.entries(options)) {
    const field = record(properties[key]);
    if (field === null || key === aspectKey || HIDDEN.has(key.toLowerCase())) continue;
    if (Array.isArray(field.enum) ? !(field.enum as unknown[]).includes(value) : field.type === "boolean" ? typeof value !== "boolean" : true) throw new Error(`This model doesn't take ${String(value)} for ${key}.`);
    params[key] = value;
  }
  if (references.length > 0) params.visualReferences = references;
  for (const key of Array.isArray(schema?.required) ? (schema.required as unknown[]) : []) {
    if (typeof key !== "string" || key in params) continue;
    const fallback = record(properties[key])?.default;
    if (fallback === undefined) throw new Error(`This model needs ${key}, which Edit doesn't set.`);
    params[key] = fallback;
  }
  return params;
}

/** The options a model's form offers (beyond the prompt and aspect), for Claude. */
export async function formOf(model: string, edits: boolean, signal?: AbortSignal): Promise<{ aspects: string[]; options: string[]; maxReferences: number }> {
  const form = await tool("openart_model_form_get", { model, mode: edits ? "image2image" : "text2image" }, signal);
  const properties = record(record(form.jsonSchema)?.properties) ?? {};
  const aspectKey = Object.keys(properties).find((key) => ASPECT.test(key));
  const aspects = aspectKey === undefined ? [] : ((record(properties[aspectKey])?.enum as string[] | undefined) ?? []);
  const options = Object.entries(properties).flatMap(([key, value]) => {
    const field = record(value);
    if (field === null || key === aspectKey || HIDDEN.has(key.toLowerCase())) return [];
    if (Array.isArray(field.enum)) return [`${key}: ${(field.enum as unknown[]).join(" | ")}${field.default !== undefined ? ` (default ${JSON.stringify(field.default)})` : ""}`];
    if (field.type === "boolean") return [`${key}: true | false${field.default !== undefined ? ` (default ${JSON.stringify(field.default)})` : ""}`];
    return [];
  });
  const references = record(properties.visualReferences);
  return { aspects, options, maxReferences: typeof references?.maxItems === "number" ? references.maxItems : references !== null ? 1 : 0 };
}

const INPUT_KEYS = /^(inputImages|visualReferences|references)$/i;

function findString(value: unknown, pattern: RegExp, depth = 0): string | undefined {
  if (value === null || value === undefined || depth > 6 || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findString(item, pattern, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const [key, item] of Object.entries(value)) if (pattern.test(key) && typeof item === "string") return item;
  for (const [key, item] of Object.entries(value)) {
    if (INPUT_KEYS.test(key)) continue;
    const found = findString(item, pattern, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findResources(value: unknown, depth = 0): Json[] | undefined {
  if (value === null || depth > 6 || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findResources(item, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const resources = (value as Json).resources;
  if (Array.isArray(resources)) return resources.map(record).filter((one): one is Json => one !== null && (one.mediaType === undefined || one.mediaType === "image"));
  for (const [key, item] of Object.entries(value)) {
    if (INPUT_KEYS.test(key)) continue;
    const found = findResources(item, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

const https = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
};

/** Where a request stands: done with its picture's address, still going (its id), or failed. */
export function stateOf(data: Json): { state: "done"; url: string } | { state: "running"; id: string | null } | { state: "failed"; error: string } {
  const resources = findResources(data);
  const resource = resources?.find((one) => https(one.url) !== null) ?? resources?.[0];
  const status = findString(data, /^(status|state)$/i)?.toLowerCase() ?? "";
  const running = /^(pending|queued|running|processing|still_running|generating)$/.test(status);
  const url = running ? null : resources !== undefined ? https(resource?.url) : https(findString(data, /^(image_url|imageUrl|output_url|outputUrl|result_url|resultUrl|resourceUrl|cdn_url|url)$/i));
  const id = findString(data, /^(historyId|history_id|creation_id|generation_id|job_id|task_id|id)$/i) ?? null;
  if (/^(failed|error|cancelled)$/.test(status)) return { state: "failed", error: findString(data, /^(error|message)$/i) ?? "OpenArt couldn't make the picture." };
  if (url !== null) return { state: "done", url };
  if (running || id !== null) return { state: "running", id };
  return { state: "failed", error: "OpenArt answered without a picture or a job." };
}

export type Made = { bytes: Uint8Array; type: string; model: string; credits: number | null; account: string };

/**
 * A picture made on OpenArt: from the prompt alone, or from the pictures given
 * (an edit: "remove every overlay and caption", "the same man, at night").
 * Waits until it's done (up to five minutes) and fetches it.
 */
export async function make(request: { prompt: string; model: string; aspect: string; references: Reference[]; options?: Json }, signal?: AbortSignal): Promise<Made> {
  // The whole picture on one account, whichever is picked while it's made.
  const account = chosen;
  const edits = request.references.length > 0;
  const mode = edits ? "image2image" : "text2image";
  const references: Json[] = [];
  for (const one of request.references) references.push(await upload(one, signal, account));
  const form = await tool("openart_model_form_get", { model: request.model, mode }, signal, account);
  const params = paramsOf(form, request.prompt, request.aspect, references, request.options ?? {});
  const started = Date.now();
  let state = stateOf(await tool("openart_generate_image", { model: request.model, mode, params }, signal, account));
  while (state.state === "running") {
    if (state.id === null) throw new Error("OpenArt started the picture without saying where to find it.");
    if (Date.now() - started > 5 * 60_000) throw new Error("OpenArt took over five minutes on the picture: ask again.");
    await Bun.sleep(3000);
    if (signal?.aborted) throw new Error("Stopped.");
    state = stateOf(await tool("openart_creation_get", { historyId: state.id }, signal, account));
  }
  if (state.state === "failed") throw new Error(state.error);
  const answer = await fetch(state.url, { signal: signal ?? AbortSignal.timeout(120_000) });
  if (!answer.ok) throw new Error(`OpenArt's picture didn't download (${answer.status}).`);
  const bytes = new Uint8Array(await answer.arrayBuffer());
  const type = answer.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  diag.info("thumbnails", `OpenArt made a picture on ${request.model} (${mode}) in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  const listed = models.get(account.id)?.list.find((one) => one.id === request.model);
  return { bytes, type, model: request.model, credits: listed?.credits ?? null, account: account.id };
}
