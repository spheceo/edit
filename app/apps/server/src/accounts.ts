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
import type { Creator } from "./model.ts";
import * as diag from "./diag.ts";
import { readJson, type Router } from "./http/router.ts";
import * as keychain from "./keychain.ts";
import * as windowFocus from "./window_focus.ts";
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
  /** The account's id (the token's `sub`). */
  sub: string;
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
  /** A refresh token was found kept (or one was just taken): a session, even while its access token is renewed. */
  kept: boolean;
  /** The sign-in in progress: its state and PKCE verifier. */
  pending: { state: string; verifier: string; redirect: string; at: number } | null;
  /** A device sign-in in progress (RFC 8628): what the person types or opens, and when it runs out. */
  device: { userCode: string; uri: string; complete: string | null; expires: number; via: string } | null;
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

const state: State = { home: null, access: null, expires: 0, person: null, perms: [], admin: false, kept: false, pending: null, device: null, problem: null, refreshing: null, timer: null };

/** Whether this Edit has a sign-in (signed in, or a kept one being renewed): the cloud is on. */
export function hasSession(): boolean {
  return state.access !== null || state.kept;
}

const base64url = (bytes: Buffer) => bytes.toString("base64url");

/** The access token's claims, read (not verified: the relay does that) for who and what. */
function claims(token: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Who's signed in, as a new project records its creator (`Project::created_by`); null signed out. */
export function creator(): Creator | null {
  const person = state.person;
  if (person === null || person.sub === "") return null;
  return { sub: person.sub, name: person.name || person.email.split("@")[0] || "", ...(person.image !== null ? { picture: person.image } : {}) };
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
    signing_in: (state.pending !== null && Date.now() - state.pending.at < PENDING_MS) || state.device !== null,
    device:
      state.device === null
        ? null
        : { user_code: state.device.userCode, verification_uri: state.device.uri, verification_uri_complete: state.device.complete, expires_in: Math.max(0, Math.round((state.device.expires - Date.now()) / 1000)) },
    problem: state.problem,
    accounts: accountsUrl(),
    // Tests and local relays (EDIT_RELAY_TOKEN) work without signing in.
    required: (process.env.EDIT_RELAY_TOKEN ?? "") === "",
  };
}

interface Tokens {
  device_code?: unknown;
  user_code?: unknown;
  verification_uri?: unknown;
  verification_uri_complete?: unknown;
  interval?: unknown;
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  user?: { email?: unknown; name?: unknown; image?: unknown };
  error?: unknown;
  error_description?: unknown;
}

/** One POST to the accounts site, JSON both ways. */
async function post(path: string, body: Record<string, string>, via = ""): Promise<{ status: number; value: Tokens; retryAfter: number | null }> {
  const answer = await fetch(`${accountsUrl()}${path}`, {
    method: "POST",
    // What admins see as "where" on the person's page.
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": userAgent(via) },
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

/** `Edit/<build> (macOS)`, or `(macOS; edit serve)` for a device sign-in: what admins and the approval page show. */
function userAgent(via: string): string {
  const system = process.platform === "darwin" ? "macOS" : process.platform;
  return `Edit/${BUILD.replace(/^v/u, "")} (${via === "" ? system : `${system}; ${via}`})`;
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
  state.kept = true;
  const found = claims(value.access_token);
  state.access = value.access_token;
  state.expires = Date.now() + seconds * 1000;
  state.perms = Array.isArray(found.perms) ? found.perms.filter((one): one is string => typeof one === "string") : [];
  state.admin = found.admin === true;
  const user = value.user ?? {};
  state.person = {
    sub: typeof found.sub === "string" ? found.sub : "",
    email: typeof user.email === "string" ? user.email : typeof found.email === "string" ? found.email : "",
    name: typeof user.name === "string" ? user.name : typeof found.name === "string" ? found.name : "",
    image: typeof user.image === "string" ? user.image : typeof found.picture === "string" ? found.picture : null,
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
  state.kept = false;
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
      state.kept = true;
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

/** Headless `edit serve` (no window, no browser): it signs in with a code printed on the terminal. */
let headless = false;
export function signInOnTerminal(on: boolean): void {
  headless = on;
}

/** At start: signed in before (a refresh token kept), renewed quietly; headless and signed out, a code to type. */
export async function start(app: App): Promise<void> {
  state.home = app.store.home;
  void checkAvailable();
  setInterval(() => void checkAvailable(), 10 * 60_000).unref?.();
  await renew(app.store.home);
  // Remote support connects only when this owner explicitly enabled it.
  const remote = await import("./remote_support.ts");
  remote.start(app);
  if (state.person !== null) diag.info("accounts", `signed in as ${state.person.email.split("@")[0]}`);
  if (headless) void codesOnTerminal(app);
}

/** Until someone signs in: a device code printed (on stderr, with Edit's other start-up lines: a stdout that's a file is buffered), and a new one when it runs out (or the site was unreachable). */
async function codesOnTerminal(app: App): Promise<void> {
  while (!hasSession()) {
    try {
      const device = await beginDevice(app, "edit serve");
      process.stderr.write(
        `\nedit: sign in to Edit: open ${device.uri} and enter ${device.userCode}` +
          (device.complete !== null ? `\n      (or open ${device.complete})` : "") +
          `\n      the code lasts ${Math.round((device.expires - Date.now()) / 60_000)} minutes\n\n`,
      );
      await devicePolling();
      if (hasSession()) process.stderr.write(`edit: signed in as ${state.person?.email ?? "you"}\n`);
      else if (state.problem !== null) {
        process.stderr.write(`edit: ${state.problem}\n`);
        await new Promise((resolve) => setTimeout(resolve, 30_000));
      }
    } catch (error) {
      process.stderr.write(`edit: couldn't start signing in (${diag.messageOf(error)}); trying again in a minute\n`);
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
  }
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

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** The device sign-in being polled (one at a time). */
let polling: Promise<void> | null = null;

/**
 * A sign-in for an Edit with no browser of its own (headless `edit serve`,
 * Edit used over Tailscale): RFC 8628's device grant. The accounts site
 * hands out a short code; the person opens its /device page anywhere and
 * types it (or opens the link with it filled in), and this polls
 * `/app/token` every `interval` seconds until they've said yes.
 * `authorization_pending` keeps polling, `slow_down` adds 5 s,
 * `access_denied` or `expired_token` stops and says so. One at a time: a
 * second call while one is waiting returns the same code.
 */
export async function beginDevice(app: App, via: string): Promise<NonNullable<State["device"]>> {
  state.home = app.store.home;
  if (state.device !== null && state.device.expires > Date.now() + 30_000) return state.device;
  const { status: code, value, retryAfter } = await post("/app/device", { client_id: CLIENT }, via);
  if (code !== 200 || typeof value.device_code !== "string" || typeof value.user_code !== "string" || typeof value.verification_uri !== "string") {
    const why = typeof value.error_description === "string" ? value.error_description : typeof value.error === "string" ? value.error : `the accounts site answered ${code}`;
    throw new Error(code === 429 ? `The accounts site is busy: try again in ${Math.round((retryAfter ?? 60_000) / 1000)} s.` : `Couldn't start a sign-in: ${why}`);
  }
  const seconds = typeof value.expires_in === "number" && value.expires_in > 0 ? value.expires_in : 600;
  const interval = typeof value.interval === "number" && value.interval > 0 ? value.interval : 5;
  state.device = {
    userCode: value.user_code,
    uri: value.verification_uri,
    complete: typeof value.verification_uri_complete === "string" ? value.verification_uri_complete : null,
    expires: Date.now() + seconds * 1000,
    via,
  };
  state.problem = null;
  const device = value.device_code;
  const started = state.device;
  polling = (async () => {
    let wait = interval * 1000;
    while (state.device === started && Date.now() < started.expires) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (state.device !== started) return;
      let answer: Awaited<ReturnType<typeof post>>;
      try {
        answer = await post("/app/token", { grant_type: DEVICE_GRANT, device_code: device, client_id: CLIENT }, via);
      } catch (error) {
        // Offline for a moment: keep asking while the code lasts.
        diag.warn("accounts", `waiting for the device sign-in: ${diag.messageOf(error)}`);
        continue;
      }
      if (answer.status === 200) {
        try {
          await take(app.store.home, answer.value);
          diag.info("accounts", `signed in as ${state.person?.email.split("@")[0] ?? "?"} (with a code)`);
        } catch (error) {
          state.problem = `Signing in failed: ${diag.messageOf(error)}`;
        }
        state.device = null;
        return;
      }
      const error = typeof answer.value.error === "string" ? answer.value.error : "";
      if (error === "authorization_pending") continue;
      if (error === "slow_down") {
        wait += 5_000;
        continue;
      }
      if (answer.status === 429) {
        wait = Math.max(wait, answer.retryAfter ?? 60_000);
        continue;
      }
      state.problem =
        error === "access_denied"
          ? typeof answer.value.error_description === "string"
            ? answer.value.error_description
            : "The sign-in was turned down (or your account can't use Edit yet: ask an admin)."
          : error === "expired_token"
            ? "The code ran out before it was used: start again."
            : `Signing in failed: ${error || `the accounts site answered ${answer.status}`}`;
      state.device = null;
      return;
    }
    if (state.device === started) {
      state.device = null;
      state.problem = "The code ran out before it was used: start again.";
    }
  })().finally(() => {
    polling = null;
  });
  return state.device;
}

/** The device sign-in being waited for, if any (tests wait on it). */
export function devicePolling(): Promise<void> | null {
  return polling;
}

/** Stops waiting for a device sign-in (signing in another way, or giving up). */
export function cancelDevice(): void {
  state.device = null;
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
    state.device = null;
    diag.info("accounts", `signed in as ${state.person?.email.split("@")[0] ?? "?"}`);
    return { ok: true, message: `Signed in as ${state.person?.email ?? "you"}.` };
  } catch (error) {
    state.problem = `Signing in failed: ${diag.messageOf(error)}`;
    diag.warn("accounts", state.problem);
    return { ok: false, message: state.problem };
  }
}

/** What runs before signing out (the cloud's locks let go), while the token still works. */
let before: (() => Promise<void>) | null = null;
export function beforeSignOut(work: () => Promise<void>): void {
  before = work;
}

/** Signs out: the cloud's locks let go, the refresh token revoked at the accounts site (best effort) and forgotten here. */
export async function signOut(app: App): Promise<void> {
  if (before !== null) {
    try {
      await before();
    } catch (error) {
      diag.warn("accounts", `letting go of the cloud's locks before signing out: ${diag.messageOf(error)}`);
    }
  }
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

const escape = (text: string) => text.replace(/[<>&"]/gu, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[ch]!);

/**
 * The page the browser lands on after signing in: in Edit's look (the spheceo
 * kit's colours, Inter where it's installed), the one-use code taken out of the address bar at once,
 * an "Open Edit" button to go back by hand, and, with Edit's window open (which
 * comes to the front by itself), a try at closing the tab (a browser may refuse:
 * Edit didn't open it).
 */
function page(ok: boolean, title: string, message: string, windowOpen: boolean): string {
  const close = ok && windowOpen;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
<script>history.replaceState(null, "", "/callback");</script>
<style>
:root{color-scheme:dark}
body{margin:0;height:100vh;display:grid;place-items:center;background:#0b0b0b;color:#ededed;font:14px/1.5 "Inter",ui-sans-serif,-apple-system,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{width:min(380px,calc(100vw - 48px));padding:28px;border:1px solid #242424;border-radius:14px;background:#111111;text-align:left}
.mark{display:flex;align-items:center;gap:10px;font-size:17px;font-weight:600}
.dot{width:8px;height:8px;border-radius:50%;background:${ok ? "#7fd18b" : "#f5a05a"}}
p{margin:10px 0 0;color:#969696}
a{display:inline-flex;margin-top:22px;height:34px;padding:0 12px;align-items:center;border-radius:8px;background:#ff0033;color:#fff;font-weight:500;text-decoration:none}
a:hover{background:#ff2a55}
</style></head><body><main>
<div class="mark"><span class="dot"></span>${escape(title)}</div>
<p>${escape(message)}</p>
<a href="/">Open Edit</a>
</main>${close ? `<script>setTimeout(() => window.close(), 1200);</script>` : ""}</body></html>`;
}

export function routes(router: Router<App>): void {
  router.get("/api/account", () => Response.json(status()));
  // Starts signing in: the browser opens on this Mac; the URL comes back too, for the page to offer.
  router.post("/api/account/sign-in", async (context) => {
    await readJson<unknown>(context).catch(() => ({}));
    const url = begin(context.app);
    openBrowser(url);
    return Response.json({ url });
  });
  // A sign-in with a code, for an Edit used from another device (Tailscale) or headless.
  router.post("/api/account/device", async (context) => {
    await readJson<unknown>(context).catch(() => ({}));
    try {
      await beginDevice(context.app, "remote");
    } catch (error) {
      return Response.json({ error: diag.messageOf(error) }, { status: 502 });
    }
    return Response.json(status());
  });
  router.post("/api/account/sign-out", async ({ app }) => {
    await signOut(app);
    return Response.json(status());
  });
  // The loopback redirect (RFC 8252): the accounts site sends the browser here with the code.
  router.get("/callback", async ({ app, request }) => {
    const done = await finish(app, new URL(request.url).searchParams);
    // Edit's window comes to the front by itself; headless, the page's button goes back.
    const windowOpen = done.ok && windowFocus.attached();
    if (done.ok) windowFocus.focus();
    const message = done.ok ? `Signed in as ${state.person?.email ?? "you"}. ${windowOpen ? "Back to Edit…" : "You can go back to Edit."}` : done.message;
    return new Response(page(done.ok, done.ok ? "Signed in to Edit" : "Couldn't sign in", message, windowOpen), {
      status: done.ok ? 200 : 400,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  });
}

/** Tests: back to signed out with nothing pending. */
/** Tests: someone signed in with these perms (kinds.ts reads them). */
export function signedInForTests(perms: string[], admin = false): void {
  state.person = { sub: "person-test", email: "test@example.com", name: "Test Person", image: null };
  state.perms = perms;
  state.admin = admin;
}

export function resetForTests(): void {
  forget(null);
  state.pending = null;
  state.device = null;
  state.home = null;
}
