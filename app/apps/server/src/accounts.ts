// Signing in to Edit with the team's accounts (accounts.spheceo.com, its
// `docs/plan.md` "contract"), so the relay answers a person, not a token
// every copy of Edit carries.
//
// As RFC 8252 has native apps do it: the authorization code with PKCE (S256)
// and `state`, the browser sent to `/app/authorize`, and the code back on
// this server's own loopback address (`http://127.0.0.1:<port>/callback`),
// exchanged at `/app/token`. The refresh token lives in the macOS Keychain
// (keychain.ts), one per Edit home; the access token (a JWT, an hour) only
// in memory, renewed quietly a few minutes before it runs out. Refresh
// tokens rotate on every use, so one refresh runs at a time. Signing out
// revokes the refresh token there and forgets it here.
//
// While the team moves over, a signed-out Edit still uses the shared token
// (relay.ts); once that goes, signing in is the only way in. Nothing here
// ever logs or prints a token.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { readJson, type Router } from "./http/router.ts";
import * as keychain from "./keychain.ts";
import { BUILD } from "./version.ts";

const DEFAULT_ACCOUNTS = "https://accounts.spheceo.com";
const CLIENT = "edit";
/** Renewed this long before it runs out. */
const EARLY_MS = 5 * 60_000;
/** A sign-in started and never finished is forgotten after this. */
const PENDING_MS = 10 * 60_000;
/**
 * After a failed renewal (offline, the site down), the next tries: three
 * 15 s apart (at 15, 30 and 45 s), all inside the 60 s in which the accounts
 * site still takes a refresh token it has just rotated (its answer may have
 * been lost on the way), then once a minute.
 */
const SOON_RETRY_MS = 15_000;
const SOON_RETRIES = 3;
const RETRY_MS = 60_000;
let failures = 0;

export function accountsUrl(): string {
  return (process.env.EDIT_ACCOUNTS_URL ?? DEFAULT_ACCOUNTS).replace(/\/+$/u, "");
}

export interface Person {
  email: string;
  name: string;
  image: string | null;
}

interface State {
  home: string | null;
  access: string | null;
  /** When the access token runs out (ms). */
  expires: number;
  person: Person | null;
  perms: string[];
  admin: boolean;
  /** The sign-in in progress: its state and PKCE verifier. */
  pending: { state: string; verifier: string; redirect: string; at: number } | null;
  /** Why the last sign-in or renewal failed, for the UI. */
  problem: string | null;
  refreshing: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Whether the accounts site answers (its JWKS): signing in is offered only then, so a build out before the site is never stuck on it. */
let available = false;

async function checkAvailable(): Promise<void> {
  try {
    const answer = await fetch(`${accountsUrl()}/.well-known/jwks.json`, { signal: AbortSignal.timeout(10_000) });
    available = answer.ok;
  } catch {
    available = false;
  }
}

const state: State = { home: null, access: null, expires: 0, person: null, perms: [], admin: false, pending: null, problem: null, refreshing: null, timer: null };

const base64url = (bytes: Buffer) => bytes.toString("base64url");

/** The access token's claims, read (not verified: the relay does that) for who and what. */
function claims(token: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The signed-in person's access token while it's good for another half minute, else null. */
export function accessToken(): string | null {
  if (state.access === null) return null;
  if (Date.now() >= state.expires - 30_000) {
    void renew();
    return null;
  }
  return state.access;
}

/** What the UI shows: who's signed in (or not), what they may use, and why a sign-in failed. */
export function status(): Record<string, unknown> {
  return {
    signed_in: state.person !== null && state.access !== null,
    available: available || state.person !== null,
    person: state.person,
    perms: state.perms,
    admin: state.admin,
    signing_in: state.pending !== null && Date.now() - state.pending.at < PENDING_MS,
    problem: state.problem,
    accounts: accountsUrl(),
  };
}

interface Tokens {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  user?: { email?: unknown; name?: unknown; image?: unknown };
  error?: unknown;
  error_description?: unknown;
}

/** One POST to the accounts site, JSON both ways. */
async function post(path: string, body: Record<string, string>): Promise<{ status: number; value: Tokens; retryAfter: number | null }> {
  const answer = await fetch(`${accountsUrl()}${path}`, {
    method: "POST",
    // What admins see as "where" on the person's page.
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": `Edit/${BUILD.replace(/^v/u, "")} (${process.platform === "darwin" ? "macOS" : process.platform})` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  let value: Tokens = {};
  try {
    value = (await answer.json()) as Tokens;
  } catch {
    value = {};
  }
  const after = Number(answer.headers.get("retry-after"));
  return { status: answer.status, value, retryAfter: Number.isFinite(after) && after > 0 ? after * 1000 : null };
}

/** A refusal that waits (the site's per-minute limit: 429 temporarily_unavailable) or a failure to try again after. */
class TryLater extends Error {
  constructor(
    message: string,
    readonly after: number | null,
  ) {
    super(message);
  }
}

/** Takes a token answer: the access token in memory, the new refresh token in the Keychain. */
async function take(home: string, value: Tokens): Promise<void> {
  if (typeof value.access_token !== "string" || typeof value.refresh_token !== "string") throw new Error("the accounts site's answer had no tokens");
  const seconds = typeof value.expires_in === "number" && value.expires_in > 0 ? value.expires_in : 3600;
  // Kept before it's used: a rotated token lost here would sign the person out.
  await keychain.set(home, value.refresh_token);
  const found = claims(value.access_token);
  state.access = value.access_token;
  state.expires = Date.now() + seconds * 1000;
  state.perms = Array.isArray(found.perms) ? found.perms.filter((one): one is string => typeof one === "string") : [];
  state.admin = found.admin === true;
  const user = value.user ?? {};
  state.person = {
    email: typeof user.email === "string" ? user.email : typeof found.email === "string" ? found.email : "",
    name: typeof user.name === "string" ? user.name : typeof found.name === "string" ? found.name : "",
    image: typeof user.image === "string" ? user.image : null,
  };
  state.problem = null;
  schedule(home);
}

function schedule(home: string): void {
  if (state.timer !== null) clearTimeout(state.timer);
  const wait = Math.max(state.expires - Date.now() - EARLY_MS, 5_000);
  state.timer = setTimeout(() => void renew(home), wait);
  state.timer.unref?.();
}

function forget(problem: string | null): void {
  state.access = null;
  state.expires = 0;
  state.person = null;
  state.perms = [];
  state.admin = false;
  state.problem = problem;
  if (state.timer !== null) clearTimeout(state.timer);
  state.timer = null;
}

/**
 * Renews the access token with the Keychain's refresh token, one at a time.
 * Refused (`invalid_grant`: signed out elsewhere, removed by an admin, the
 * token gone stale), the person is signed out here; offline, it tries again.
 */
export function renew(home: string | null = state.home): Promise<void> {
  if (home === null) return Promise.resolve();
  state.refreshing ??= (async () => {
    try {
      const refresh = await keychain.get(home);
      if (refresh === null) {
        forget(null);
        return;
      }
      const { status: code, value, retryAfter } = await post("/app/token", { grant_type: "refresh_token", refresh_token: refresh, client_id: CLIENT });
      if (code === 200) {
        failures = 0;
        await take(home, value);
        return;
      }
      // Only `invalid_grant` ends a sign-in (signed out elsewhere, removed, gone stale): anything
      // else, the per-minute limit's 429 above all, keeps the refresh token and tries again.
      if (value.error === "invalid_grant") {
        await keychain.remove(home);
        forget(typeof value.error_description === "string" ? value.error_description : "Your sign-in ended: sign in again.");
        diag.info("accounts", `sign-in ended (${typeof value.error === "string" ? value.error : code}); signed out`);
        return;
      }
      throw new TryLater(`the accounts site answered ${code}${typeof value.error === "string" ? ` (${value.error})` : ""}`, retryAfter);
    } catch (error) {
      state.problem = `Couldn't renew the sign-in: ${diag.messageOf(error)}`;
      const asked = error instanceof TryLater ? error.after : null;
      const wait = asked ?? (failures < SOON_RETRIES ? SOON_RETRY_MS : RETRY_MS);
      failures += 1;
      diag.warn("accounts", `renewing the sign-in: ${diag.messageOf(error)}; trying again in ${wait / 1000} s`);
      if (state.timer !== null) clearTimeout(state.timer);
      state.timer = setTimeout(() => void renew(home), wait);
      state.timer.unref?.();
    } finally {
      state.refreshing = null;
    }
  })();
  return state.refreshing;
}

/** At start: signed in before (a refresh token kept), renewed quietly. */
export async function start(app: App): Promise<void> {
  state.home = app.store.home;
  void checkAvailable();
  setInterval(() => void checkAvailable(), 10 * 60_000).unref?.();
  await renew(app.store.home);
  if (state.person !== null) diag.info("accounts", `signed in as ${state.person.email.split("@")[0]}`);
}

/** Starts a sign-in: the authorize URL for the browser, with a fresh state and PKCE verifier. */
export function begin(app: App): string {
  state.home = app.store.home;
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const nonce = base64url(randomBytes(16));
  const redirect = `http://127.0.0.1:${app.port}/callback`;
  state.pending = { state: nonce, verifier, redirect, at: Date.now() };
  state.problem = null;
  const query = new URLSearchParams({ client_id: CLIENT, redirect_uri: redirect, response_type: "code", state: nonce, code_challenge: challenge, code_challenge_method: "S256" });
  return `${accountsUrl()}/app/authorize?${query.toString()}`;
}

/** The browser back with a code (or a refusal): exchanged, and the person signed in. */
export async function finish(app: App, query: URLSearchParams): Promise<{ ok: boolean; message: string }> {
  const pending = state.pending;
  if (pending === null || Date.now() - pending.at > PENDING_MS || query.get("state") !== pending.state) {
    return { ok: false, message: "This sign-in isn't the one Edit started (or it took too long). Start it again from Edit." };
  }
  state.pending = null;
  const refused = query.get("error");
  if (refused !== null) {
    const why = query.get("error_description") ?? (refused === "access_denied" ? "Your account can't use Edit yet: ask an admin." : refused);
    state.problem = why;
    return { ok: false, message: why };
  }
  const code = query.get("code");
  if (code === null || code === "") return { ok: false, message: "The accounts site sent no code back." };
  try {
    const { status: answered, value } = await post("/app/token", { grant_type: "authorization_code", code, code_verifier: pending.verifier, redirect_uri: pending.redirect, client_id: CLIENT });
    if (answered !== 200) throw new Error(typeof value.error_description === "string" ? value.error_description : typeof value.error === "string" ? value.error : `the accounts site answered ${answered}`);
    await take(app.store.home, value);
    diag.info("accounts", `signed in as ${state.person?.email.split("@")[0] ?? "?"}`);
    return { ok: true, message: `Signed in as ${state.person?.email ?? "you"}. You can close this tab and go back to Edit.` };
  } catch (error) {
    state.problem = `Signing in failed: ${diag.messageOf(error)}`;
    diag.warn("accounts", state.problem);
    return { ok: false, message: state.problem };
  }
}

/** Signs out: the refresh token revoked at the accounts site (best effort) and forgotten here. */
export async function signOut(app: App): Promise<void> {
  const refresh = await keychain.get(app.store.home);
  if (refresh !== null) {
    try {
      const { status: code, retryAfter } = await post("/app/revoke", { token: refresh });
      // The per-minute limit: revoked once more after it, in the background (it's forgotten here now).
      if (code === 429) {
        const later = setTimeout(() => void post("/app/revoke", { token: refresh }).catch(() => {}), retryAfter ?? 60_000);
        later.unref?.();
      }
    } catch (error) {
      diag.warn("accounts", `revoking the sign-in: ${diag.messageOf(error)} (forgotten here anyway)`);
    }
  }
  await keychain.remove(app.store.home);
  forget(null);
  diag.info("accounts", "signed out");
}

/** Opens a URL in the Mac's browser (the sign-in page), never with a secret in it. */
function openBrowser(url: string): void {
  // EDIT_NO_BROWSER: a test drives the sign-in itself.
  if (process.platform !== "darwin" || process.env.EDIT_NO_BROWSER === "1") return;
  const child = spawn("/usr/bin/open", [url], { stdio: "ignore", detached: true });
  child.on("error", (error) => diag.warn("accounts", `opening the browser: ${diag.messageOf(error)}`));
  child.unref();
}

const PAGE = (title: string, message: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:16px -apple-system,system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0}main{max-width:28rem;text-align:center}h1{font-size:20px}</style><main><h1>${title}</h1><p>${message.replace(/[<>&]/gu, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[ch]!)}</p></main>`;

export function routes(router: Router<App>): void {
  router.get("/api/account", () => Response.json(status()));
  // Starts signing in: the browser opens on this Mac; the URL comes back too, for the page to offer.
  router.post("/api/account/sign-in", async (context) => {
    await readJson<unknown>(context).catch(() => ({}));
    const url = begin(context.app);
    openBrowser(url);
    return Response.json({ url });
  });
  router.post("/api/account/sign-out", async ({ app }) => {
    await signOut(app);
    return Response.json(status());
  });
  // The loopback redirect (RFC 8252): the accounts site sends the browser here with the code.
  router.get("/callback", async ({ app, request }) => {
    const done = await finish(app, new URL(request.url).searchParams);
    return new Response(PAGE(done.ok ? "Signed in to Edit" : "Couldn't sign in", done.message), {
      status: done.ok ? 200 : 400,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  });
}

/** Tests: back to signed out with nothing pending. */
export function resetForTests(): void {
  forget(null);
  state.pending = null;
  state.home = null;
}
