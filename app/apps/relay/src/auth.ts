// Who is calling, and may they: every route but /health asks here.
//
// A caller is a person signed in through accounts.spheceo.com: their access
// token, a JWT signed with the accounts site's key, checked against its JWKS
// for `iss`, `aud: "edit"` and `exp`, with the route's permission in its
// `perms`. The shared token every Edit build used to carry was retired on
// Oct 23 (it's in every old build: burnt); a build still sending it is told
// to update and sign in. `OPEN_MAPS = "1"` would open the maps to anyone
// again (they're gated, "0", since then).
//
// Budgets (transcription, voices, maps) are kept per caller: a person by
// their id, everyone else by connection, as before. The log says who made
// each request (the person's id), never their token.

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

import { isEditing } from "./manifest";

/**
 * What a route needs. Since accounts' contract v2 every route needs only
 * `use` (has Edit at all): Edit enforces the kinds of work itself, from the
 * capabilities in `perms` (manifest.ts). The v1 names are accepted as words
 * and ignored, as any id the relay doesn't know is.
 */
export type Permission = "use";

export interface AuthEnv {
  /** The accounts site (default https://accounts.spheceo.com): the tokens' issuer; its JWKS is at /.well-known/jwks.json. */
  ACCOUNTS_ISSUER?: string;
  /** "1": the maps routes answer without a token (builds from before signing in sent none). */
  OPEN_MAPS?: string;
}

/** A person as their token names them (name, email and Google photo when the token carries them). */
export type Caller = { kind: "person"; sub: string; perms: string[]; admin: boolean; name?: string; email?: string; picture?: string } | { kind: "open" };

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

/** How often the accounts site's cut-offs are read (each running copy of the relay keeps them meanwhile). */
const CUT_OFFS_EVERY_MS = 60_000;

/** People whose sign-ins an admin ended (removed, signed out everywhere, an app taken away): when, by person, and for which app (`*`: every app). */
let cutOffs: { read: number; at: Map<string, Map<string, number>> } | null = null;
let reading: Promise<void> | null = null;

/** How the list is fetched (tests give their own). */
let fetchCutOffs = (url: string): Promise<Response> => fetch(url, { signal: AbortSignal.timeout(3_000) });

/** Tests: where the cut-offs come from, and forget the ones read so the next request reads them again. */
export function useCutOffs(read: ((url: string) => Promise<Response>) | null): void {
  fetchCutOffs = read ?? ((url) => fetch(url, { signal: AbortSignal.timeout(3_000) }));
  cutOffs = null;
  reading = null;
}

/** The accounts site's cut-offs (`/app/revoked`, the last two hours): one read a minute, the last list kept when it can't be read. */
async function readCutOffs(env: AuthEnv): Promise<void> {
  const at = new Map(cutOffs?.at ?? []);
  try {
    const answer = await fetchCutOffs(`${issuer(env)}/app/revoked`);
    if (!answer.ok) throw new Error(`the accounts site answered ${answer.status}`);
    const body = (await answer.json()) as { revoked?: { sub?: unknown; at?: unknown; aud?: unknown }[] };
    at.clear();
    for (const one of body.revoked ?? []) {
      if (typeof one.sub !== "string" || typeof one.at !== "number") continue;
      const app = typeof one.aud === "string" ? one.aud : "*";
      const apps = at.get(one.sub) ?? new Map<string, number>();
      apps.set(app, Math.max(apps.get(app) ?? 0, one.at));
      at.set(one.sub, apps);
    }
  } catch (error) {
    console.log(JSON.stringify({ route: "cut-offs", unread: String(error) }));
  }
  cutOffs = { read: Date.now(), at };
}

/**
 * Whether a person's token was issued before an admin ended their sign-ins:
 * the relay refuses it within a minute of the cut-off, not when the token
 * runs out an hour later (the user, Oct 30: a lost laptop's sign-in).
 */
async function cutOff(env: AuthEnv, sub: string, issuedAt: number, audience: string): Promise<boolean> {
  if (cutOffs === null || Date.now() - cutOffs.read > CUT_OFFS_EVERY_MS) {
    reading ??= readCutOffs(env).finally(() => {
      reading = null;
    });
    await reading;
  }
  // Cut off from every app, or from this one (another app's access taken away isn't this one's).
  const apps = cutOffs?.at.get(sub);
  const at = Math.max(apps?.get("*") ?? 0, apps?.get(audience) ?? 0);
  return at > 0 && issuedAt * 1000 <= at;
}

/** What `authorization` says about the caller: a person, or nothing usable (null). */
export async function caller(request: Request, env: AuthEnv, audience = "edit"): Promise<Caller | null> {
  const sent = request.headers.get("authorization") ?? "";
  if (sent === "") return null;
  const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(sent)?.[1];
  if (token === undefined) return null;
  try {
    const { payload } = await jwtVerify(token, keysOf(env), { issuer: issuer(env), audience, clockTolerance: SKEW_SECONDS, algorithms: ["RS256"] });
    if (typeof payload.sub !== "string" || payload.sub === "" || typeof payload.exp !== "number") return null;
    // Signed out by an admin since this token was made: as good as no token (they sign in again, if they still may).
    if (await cutOff(env, payload.sub, typeof payload.iat === "number" ? payload.iat : 0, audience)) return null;
    const perms = Array.isArray(payload.perms) ? payload.perms.filter((one): one is string => typeof one === "string") : [];
    const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
    const found: Caller = { kind: "person", sub: payload.sub, perms, admin: payload.admin === true };
    const name = text(payload.name);
    const email = text(payload.email);
    const picture = text(payload.picture);
    if (name !== undefined) found.name = name;
    if (email !== undefined) found.email = email;
    if (picture !== undefined && picture.startsWith("https://")) found.picture = picture;
    return found;
  } catch {
    return null;
  }
}

/**
 * Whether a person may make voice-overs (paid): they come with editing, so an
 * admin or anyone with an `edit.*` capability (manifest.ts); subtitles alone
 * don't. A token from before accounts' contract v2 carries no capability ids
 * at all (only `use` and v1's names): it keeps them until accounts switches
 * and grants each person their preset, so nobody loses them in between.
 */
export function mayVoice(found: Caller): boolean {
  if (found.kind !== "person") return false;
  if (found.admin || found.perms.some(isEditing)) return true;
  return !found.perms.some((one) => one.includes("."));
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
  const sent = request.headers.get("authorization") ?? "";
  // A bearer that isn't a person's token: an Edit from before signing in (the shared token).
  const stale = sent !== "" && !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(sent);
  const result: Caller | Response =
    found === null
      ? open
        ? { kind: "open" }
        : stale
          ? refuse(401, "This Edit is out of date: update it (Edit → Update, or reinstall from github.com/spheceo/edit) and sign in with your Google account.")
          : refuse(401, "Sign in to Edit (this relay answers signed-in people only).")
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
