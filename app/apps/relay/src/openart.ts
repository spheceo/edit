// The team's OpenArt account (Nov 2: "the team shares one team account… add
// the account as mamagi-openart-1… we save the auth details to infisical and
// we use that"). Thumbnails make their pictures on OpenArt through its MCP
// server; Edit reaches it only through here, so no install holds the sign-in:
//
//   POST /v1/openart/mcp   an MCP message (Streamable HTTP), forwarded to
//                          https://mcp.openart.ai/mcp with the team's token;
//                          Mcp-Session-Id and the protocol version pass both ways
//   GET  /v1/openart/account   which account it is (its label), never a token
//
// The sign-in is OPENART_CLIENT_ID and OPENART_REFRESH_TOKEN (Infisical
// `/edit-relay`, put there by scripts/openart-connect.ts). OpenArt may hand a
// new refresh token with each renewal, so the live pair is kept in the BUDGET
// Durable Object (its "openart" instance), renewed one at a time; a new
// sign-in in Infisical (a different refresh token) starts it over from that.

export interface OpenArtEnv {
  OPENART_CLIENT_ID?: string;
  OPENART_REFRESH_TOKEN?: string;
  OPENART_ACCOUNT?: string;
  BUDGET: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
}

const MCP_URL = "https://mcp.openart.ai/mcp";
const METADATA = "https://openart.ai/.well-known/oauth-authorization-server";
const MAX_BODY = 2 * 1024 * 1024;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const openartReady = (env: OpenArtEnv): boolean => Boolean(env.OPENART_CLIENT_ID && env.OPENART_REFRESH_TOKEN);

/** The team's access token from the Durable Object; `stale` asks for a new one in its place. */
async function token(env: OpenArtEnv, stale: string | null): Promise<string> {
  const store = env.BUDGET.get(env.BUDGET.idFromName("openart"));
  const answer = await store.fetch(new Request("https://budget/openart", { method: "POST", body: JSON.stringify({ stale }) }));
  const body = (await answer.json()) as { token?: string; error?: string };
  if (!answer.ok || typeof body.token !== "string") throw new Error(body.error ?? `OpenArt's sign-in (${answer.status})`);
  return body.token;
}

export async function openartRoute(request: Request, url: URL, env: OpenArtEnv): Promise<Response> {
  if (!openartReady(env)) return json(503, { error: "OpenArt isn't connected on the relay yet: run scripts/openart-connect.ts and push its secrets." });
  const route = url.pathname.slice("/v1/openart/".length);
  if (route === "account" && request.method === "GET") return json(200, { account: env.OPENART_ACCOUNT ?? "OpenArt" });
  if (route !== "mcp") return json(404, { error: "not found" });
  if (request.method !== "POST" && request.method !== "DELETE") return json(405, { error: "POST /v1/openart/mcp" });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return json(413, { error: "Request too large." });
  const body = request.method === "POST" ? await request.text() : null;
  if (body !== null && body.length > MAX_BODY) return json(413, { error: "Request too large." });
  const forward = async (bearer: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${bearer}`, accept: request.headers.get("accept") ?? "application/json, text/event-stream" };
    if (body !== null) headers["content-type"] = "application/json";
    for (const name of ["mcp-session-id", "mcp-protocol-version"]) {
      const value = request.headers.get(name);
      if (value) headers[name] = value;
    }
    return fetch(MCP_URL, { method: request.method, headers, body });
  };
  let bearer: string;
  try {
    bearer = await token(env, null);
  } catch (error) {
    return json(502, { error: error instanceof Error ? error.message : String(error) });
  }
  let answer = await forward(bearer);
  // Refused: renewed once (another request may already have) and asked again.
  if (answer.status === 401) {
    try {
      answer = await forward(await token(env, bearer));
    } catch (error) {
      return json(502, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  const headers = new Headers();
  for (const name of ["content-type", "mcp-session-id", "mcp-protocol-version"]) {
    const value = answer.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(answer.body, { status: answer.status, headers });
}

type Stored = { access: string; refresh: string; expiresAt: number; seed: string };
interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

const hash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);

let renewing: Promise<Stored> | null = null;

/** In the Durable Object: the live access token, renewed when it's due or was refused (one renewal at a time). */
export async function openartToken(request: Request, storage: Storage, env: OpenArtEnv): Promise<Response> {
  const { stale } = (await request.json().catch(() => ({}))) as { stale?: string | null };
  if (!openartReady(env)) return json(503, { error: "OpenArt isn't connected on the relay yet." });
  const seed = await hash(env.OPENART_REFRESH_TOKEN!);
  let stored = await storage.get<Stored>("openart");
  if (stored !== undefined && stored.seed !== seed) stored = undefined;
  const fresh = stored !== undefined && stored.expiresAt > Date.now() + 60_000 && (stale === null || stale === undefined || stale !== stored.access);
  if (fresh) return json(200, { token: stored!.access });
  renewing ??= renew(storage, env, stored, seed).finally(() => {
    renewing = null;
  });
  try {
    return json(200, { token: (await renewing).access });
  } catch (error) {
    return json(502, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function renew(storage: Storage, env: OpenArtEnv, stored: Stored | undefined, seed: string): Promise<Stored> {
  const metadata = (await (await fetch(METADATA)).json()) as { token_endpoint?: string };
  const endpoint = metadata.token_endpoint ?? "";
  if (new URL(endpoint).hostname !== "openart.ai") throw new Error("OpenArt's sign-in answered from somewhere unexpected.");
  const refresh = stored?.refresh ?? env.OPENART_REFRESH_TOKEN!;
  const answer = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: env.OPENART_CLIENT_ID!, resource: MCP_URL }),
  });
  if (!answer.ok) {
    const said = (await answer.text()).slice(0, 200);
    throw new Error(answer.status === 400 || answer.status === 401 ? `OpenArt's team sign-in has ended (${said}): connect it again with scripts/openart-connect.ts.` : `OpenArt couldn't renew the sign-in (${answer.status}).`);
  }
  const tokens = (await answer.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (typeof tokens.access_token !== "string") throw new Error("OpenArt gave no access token.");
  const next: Stored = { access: tokens.access_token, refresh: tokens.refresh_token ?? refresh, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000, seed };
  await storage.put("openart", next);
  return next;
}
