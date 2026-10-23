// Who is calling, and may they: every route but /health asks here.
//
// A caller is a person signed in through accounts.spheceo.com (their access
// token: a JWT signed with the accounts site's key, checked against its JWKS
// for `iss`, `aud: "edit"` and `exp`, with the route's permission in its
// `perms`), or, while the team moves to signing in, the old shared token
// every Edit build carries (`CLOUD_TOKEN`, `CLIENT_TOKEN`). The maps routes
// took no token at all; `OPEN_MAPS = "1"` keeps them open to builds from
// before signing in until the old token goes.
//
// Budgets (transcription, voices, maps) are kept per caller: a person by
// their id, everyone else by connection, as before. The log says who made
// each request (the person's id), never their token.

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** What the accounts site hands out for Edit (`edit:<perm>` there). */
export type Permission = "use" | "cloud" | "export" | "ai" | "drive";

export interface AuthEnv {
  CLOUD_TOKEN?: string;
  CLIENT_TOKEN?: string;
  /** The accounts site (default https://accounts.spheceo.com): the tokens' issuer; its JWKS is at /.well-known/jwks.json. */
  ACCOUNTS_ISSUER?: string;
  /** "1": the maps routes answer without a token (builds from before signing in sent none). */
  OPEN_MAPS?: string;
}

export type Caller =
  | { kind: "person"; sub: string; perms: string[]; admin: boolean }
  | { kind: "shared" }
  | { kind: "open" };

const ISSUER = "https://accounts.spheceo.com";
/** Allowed clock skew between the accounts site and here (the contract's 60 s). */
const SKEW_SECONDS = 60;

/** The accounts site's keys, cached about ten minutes and fetched again at once for a `kid` not seen (jose's remote set). */
const remote = new Map<string, JWTVerifyGetKey>();
/** Tests verify against keys of their own. */
let given: JWTVerifyGetKey | null = null;
export function useKeys(keys: JWTVerifyGetKey | null): void {
  given = keys;
}

function issuer(env: AuthEnv): string {
  return (env.ACCOUNTS_ISSUER ?? ISSUER).replace(/\/+$/, "");
}

function keysOf(env: AuthEnv): JWTVerifyGetKey {
  if (given !== null) return given;
  const url = `${issuer(env)}/.well-known/jwks.json`;
  let keys = remote.get(url);
  if (keys === undefined) {
    keys = createRemoteJWKSet(new URL(url), { cacheMaxAge: 10 * 60_000, cooldownDuration: 5_000, timeoutDuration: 5_000 });
    remote.set(url, keys);
  }
  return keys;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** `sent` is `Bearer <token>`, compared in constant time. */
async function isBearer(sent: string, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const [a, b] = await Promise.all([sha256(sent), sha256(`Bearer ${token}`)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

/** What `authorization` says about the caller: a person, the shared token, or nothing usable (null). */
export async function caller(request: Request, env: AuthEnv): Promise<Caller | null> {
  const sent = request.headers.get("authorization") ?? "";
  if (sent === "") return null;
  if ((await isBearer(sent, env.CLOUD_TOKEN)) || (await isBearer(sent, env.CLIENT_TOKEN))) return { kind: "shared" };
  const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(sent)?.[1];
  if (token === undefined) return null;
  try {
    const { payload } = await jwtVerify(token, keysOf(env), { issuer: issuer(env), audience: "edit", clockTolerance: SKEW_SECONDS, algorithms: ["RS256"] });
    if (typeof payload.sub !== "string" || payload.sub === "" || typeof payload.exp !== "number") return null;
    const perms = Array.isArray(payload.perms) ? payload.perms.filter((one): one is string => typeof one === "string") : [];
    return { kind: "person", sub: payload.sub, perms, admin: payload.admin === true };
  } catch {
    return null;
  }
}

/** Who to put in the log line: a person's id, never their token or more than that. */
export function who(found: Caller): string {
  return found.kind === "person" ? found.sub : found.kind;
}

/**
 * The route's gate: the caller, or the response refusing them (401 with no
 * usable token, 403 without the permission). `open` lets a route answer
 * with no token at all (the maps while OPEN_MAPS holds, or a relay with no
 * shared token set, as `wrangler dev` runs).
 */
export async function allow(request: Request, env: AuthEnv, permission: Permission, route: string, open = false, log = true): Promise<Caller | Response> {
  const found = await caller(request, env);
  const noShared = !env.CLOUD_TOKEN && !env.CLIENT_TOKEN;
  const result: Caller | Response =
    found === null
      ? open || (noShared && request.headers.get("authorization") === null)
        ? { kind: "open" }
        : refuse(401, "Sign in to Edit (this relay needs a signed-in person's token).")
      : found.kind === "person" && !found.admin && !found.perms.includes(permission)
        ? refuse(403, `Your account can't use this yet: an admin can give you Edit's "${permission}" permission at accounts.spheceo.com.`)
        : found;
  if (log) console.log(JSON.stringify({ route, who: result instanceof Response ? (found === null ? "none" : who(found)) : who(result), ...(result instanceof Response ? { refused: result.status } : {}) }));
  return result;
}

function refuse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/** The key a caller's budgets are kept under: a person by their id, anyone else by connection (hex, as the budgets want). */
export async function budgetKey(request: Request, found: Caller): Promise<string> {
  const basis = found.kind === "person" ? `person:${found.sub}` : (request.headers.get("cf-connecting-ip") ?? "unknown");
  return Array.from(await sha256(basis), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The rate limiter's key for a caller (a person's id, else the connection). */
export function burstKey(request: Request, found: Caller): string {
  return found.kind === "person" ? `p:${found.sub}` : (request.headers.get("cf-connecting-ip") ?? "unknown");
}
