// accounts.ts's tests: signing in to Edit (PKCE through the loopback), renewing, signing out,
// against a stand-in for accounts.spheceo.com's /app/* (its plan's contract).

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import * as accounts from "../src/accounts.ts";
import type { App } from "../src/app.ts";
import * as relay from "../src/relay.ts";
import { baseRouter, respond } from "../src/http/server.ts";
import * as windowFocus from "../src/window_focus.ts";
import { fixtureHome } from "./helpers/home.ts";

const dir = fs.mkdtempSync(join(os.tmpdir(), "edit-accounts-"));
const app = { store: { home: join(dir, "home") }, port: 7799 } as unknown as App;
const challenges = new Map<string, string>();
const seen: { path: string; body: Record<string, string> }[] = [];
let refreshes = 0;
const devices: string[] = [];
const polls = new Map<string, number>();
/** What the site answers each poll of a device sign-in, in turn ("ok" signs in). */
let deviceScript: string[] = [];
let deviceExpires = 600;
let server: ReturnType<typeof Bun.serve>;

/** An access token as the site makes one (its signature isn't checked here: the relay does that). */
function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", kid: "k1" })}.${part({ iss: "https://accounts.test", aud: "edit", sub: "person-1", exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.c2ln`;
}

beforeAll(() => {
  process.env.EDIT_KEYCHAIN_FILE = join(dir, "keychain.json");
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = (await request.json().catch(() => ({}))) as Record<string, string>;
      seen.push({ path: url.pathname, body });
      if (url.pathname.startsWith("/app/") && !/^Edit\/\S+ \((macOS|linux)(; [a-z ]+)?\)$/u.test(request.headers.get("user-agent") ?? "")) return Response.json({ error: "no user agent" }, { status: 400 });
      if (url.pathname === "/app/revoke") return Response.json({});
      if (url.pathname === "/app/device") {
        devices.push(request.headers.get("user-agent") ?? "");
        const code = `dev-${devices.length}`;
        polls.set(code, 0);
        return Response.json({ device_code: code, user_code: "BCDF-GHJK", verification_uri: "https://accounts.test/device", verification_uri_complete: "https://accounts.test/device?code=BCDF-GHJK", expires_in: deviceExpires, interval: 0.02 });
      }
      // Standing in for the relay too: what a tile request carried.
      if (url.pathname.startsWith("/v1/3dtiles/")) return Response.json({ bearer: request.headers.get("authorization"), query: url.search }, { headers: { "cache-control": "max-age=60" } });
      if (url.pathname !== "/app/token") return new Response("not found", { status: 404 });
      if (body.client_id !== "edit") return Response.json({ error: "invalid_client" }, { status: 400 });
      if (body.grant_type === "authorization_code") {
        const challenge = challenges.get(body.code ?? "");
        const sent = createHash("sha256").update(body.code_verifier ?? "").digest("base64url");
        if (challenge === undefined || challenge !== sent || body.redirect_uri !== "http://127.0.0.1:7799/callback") return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({ access_token: jwt({ perms: ["use", "cloud"], email: "someone@gmail.com", name: "Some One", picture: "https://lh3.googleusercontent.com/a/someone=s96-c" }), token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-1-aaaaaaaa", user: { email: "someone@gmail.com", name: "Someone", image: null } });
      }
      if (body.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
        const n = (polls.get(body.device_code ?? "") ?? 0) + 1;
        polls.set(body.device_code ?? "", n);
        const script = deviceScript[n - 1] ?? "ok";
        if (script === "ok") return Response.json({ access_token: jwt({ perms: ["use"], email: "someone@gmail.com" }), token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-device-aaaaaaaa", user: { email: "someone@gmail.com", name: "Someone", image: null } });
        return Response.json({ error: script }, { status: 400 });
      }
      if (body.grant_type === "refresh_token") {
        if (body.refresh_token === "dead-token-aaaaaaaa") return Response.json({ error: "invalid_grant", error_description: "Signed out elsewhere." }, { status: 400 });
        if (body.refresh_token === "busy-token-aaaaaaaa") return Response.json({ error: "temporarily_unavailable" }, { status: 429, headers: { "retry-after": "60" } });
        refreshes += 1;
        return Response.json({ access_token: jwt({ perms: ["use"], email: "someone@gmail.com" }), token_type: "Bearer", expires_in: 3600, refresh_token: `refresh-${refreshes + 1}-aaaaaaaa`, user: { email: "someone@gmail.com", name: "Someone", image: null } });
      }
      return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    },
  });
  process.env.EDIT_ACCOUNTS_URL = `http://127.0.0.1:${server.port}`;
});

afterEach(() => accounts.resetForTests());
afterAll(() => {
  void server.stop(true);
  delete process.env.EDIT_KEYCHAIN_FILE;
  delete process.env.EDIT_ACCOUNTS_URL;
  fs.rmSync(dir, { recursive: true, force: true });
});

const kept = () => JSON.parse(fs.readFileSync(join(dir, "keychain.json"), "utf8")) as Record<string, string>;

test("signs in with PKCE through the loopback, keeps the refresh token in the keychain, and the relay sends the person's token", async () => {
  const authorize = new URL(accounts.begin(app));
  expect(authorize.pathname).toBe("/app/authorize");
  expect(Object.fromEntries(authorize.searchParams)).toMatchObject({ client_id: "edit", redirect_uri: "http://127.0.0.1:7799/callback", code_challenge_method: "S256", response_type: "code" });
  // The site keeps the challenge with the code it hands out.
  challenges.set("code-1", authorize.searchParams.get("code_challenge")!);
  // Someone else's callback (another state) is turned away.
  expect((await accounts.finish(app, new URLSearchParams({ code: "code-1", state: "wrong" }))).ok).toBe(false);
  accounts.begin(app);
  const again = new URL(accounts.begin(app));
  challenges.set("code-2", again.searchParams.get("code_challenge")!);
  const done = await accounts.finish(app, new URLSearchParams({ code: "code-2", state: again.searchParams.get("state")! }));
  expect(done).toEqual({ ok: true, message: "Signed in as someone@gmail.com." });
  expect(accounts.status()).toMatchObject({ signed_in: true, person: { email: "someone@gmail.com", name: "Someone" }, perms: ["use", "cloud"] });
  expect(Object.values(kept())).toEqual(["refresh-1-aaaaaaaa"]);
  expect(relay.token()).toBe(accounts.accessToken());
  expect(relay.authHeaders().authorization).toMatch(/^Bearer eyJ/);
});

test("renews with the kept refresh token and keeps the rotated one; a refused one signs out", async () => {
  await accounts.renew(app.store.home);
  expect(accounts.status()).toMatchObject({ signed_in: true, perms: ["use"] });
  expect(Object.values(kept())).toEqual(["refresh-2-aaaaaaaa"]);
  // Two renewals at once are one request (a refresh token rotates on use).
  const before = seen.length;
  await Promise.all([accounts.renew(app.store.home), accounts.renew(app.store.home)]);
  expect(seen.length - before).toBe(1);
  // The site's per-minute limit (429): still signed in, the refresh token kept, tried again later.
  const keep = Object.keys(kept());
  fs.writeFileSync(join(dir, "keychain.json"), JSON.stringify(Object.fromEntries(keep.map((key) => [key, "busy-token-aaaaaaaa"]))));
  await accounts.renew(app.store.home);
  expect(accounts.status()).toMatchObject({ signed_in: true });
  expect(Object.values(kept())).toEqual(["busy-token-aaaaaaaa"]);
  // Refused: signed out, the token forgotten, the shared token back for the relay.
  fs.writeFileSync(join(dir, "keychain.json"), JSON.stringify(Object.fromEntries(Object.keys(kept()).map((key) => [key, "dead-token-aaaaaaaa"]))));
  await accounts.renew(app.store.home);
  expect(accounts.status()).toMatchObject({ signed_in: false, problem: "Signed out elsewhere." });
  expect(Object.values(kept())).toEqual([]);
  expect(relay.token()).toBe(relay.envToken());
});

test("signing out revokes the refresh token there and forgets it here", async () => {
  fs.writeFileSync(join(dir, "keychain.json"), JSON.stringify({}));
  const authorize = new URL(accounts.begin(app));
  challenges.set("code-3", authorize.searchParams.get("code_challenge")!);
  await accounts.finish(app, new URLSearchParams({ code: "code-3", state: authorize.searchParams.get("state")! }));
  await accounts.signOut(app);
  expect(seen.at(-1)).toEqual({ path: "/app/revoke", body: { token: "refresh-1-aaaaaaaa" } });
  expect(accounts.status()).toMatchObject({ signed_in: false, person: null });
  expect(Object.values(kept())).toEqual([]);
});

test("session observers see sign-in and sign-out and can unsubscribe", async () => {
  fs.writeFileSync(join(dir, "keychain.json"), JSON.stringify({}));
  const owners: (string | null)[] = [];
  const unsubscribe = accounts.onSessionChange(() => owners.push(accounts.creator()?.sub ?? null));
  try {
    const authorize = new URL(accounts.begin(app));
    challenges.set("observer-code", authorize.searchParams.get("code_challenge")!);
    await accounts.finish(app, new URLSearchParams({ code: "observer-code", state: authorize.searchParams.get("state")! }));
    await accounts.signOut(app);
    expect(owners).toEqual(["person-1", null]);
    unsubscribe();
    accounts.resetForTests();
    expect(owners).toHaveLength(2);
  } finally { unsubscribe(); }
});

test("a refusal from the site (not on the list) is said, not signed in", async () => {
  const authorize = new URL(accounts.begin(app));
  const done = await accounts.finish(app, new URLSearchParams({ error: "access_denied", error_description: "Ask an admin to add you.", state: authorize.searchParams.get("state")! }));
  expect(done).toEqual({ ok: false, message: "Ask an admin to add you." });
  expect(accounts.status()).toMatchObject({ signed_in: false, problem: "Ask an admin to add you." });
});

test("the map page's tiles go through Edit's server to the relay with the person's token", async () => {
  fs.writeFileSync(join(dir, "keychain.json"), JSON.stringify({}));
  const authorize = new URL(accounts.begin(app));
  challenges.set("code-4", authorize.searchParams.get("code_challenge")!);
  await accounts.finish(app, new URLSearchParams({ code: "code-4", state: authorize.searchParams.get("state")! }));
  process.env.EDIT_RELAY_URL = process.env.EDIT_ACCOUNTS_URL;
  try {
    const asked = new URL("http://127.0.0.1:7799/v1/3dtiles/datasets/x/files/y.glb?session=s1");
    const answer = await relay.forwardTiles(new Request(asked.toString()), asked);
    expect(answer.headers.get("cache-control")).toBe("max-age=60");
    expect(await answer.json()).toEqual({ bearer: `Bearer ${accounts.accessToken()}`, query: "?session=s1" });
  } finally {
    delete process.env.EDIT_RELAY_URL;
  }
});

test("a device sign-in (headless, over Tailscale): a code to type, polled through pending and slow_down until it's approved", async () => {
  fs.writeFileSync(join(dir, "keychain.json"), JSON.stringify({}));
  deviceScript = ["authorization_pending", "slow_down", "authorization_pending", "ok"];
  const device = await accounts.beginDevice(app, "edit serve");
  expect([device.userCode, device.uri, device.complete]).toEqual(["BCDF-GHJK", "https://accounts.test/device", "https://accounts.test/device?code=BCDF-GHJK"]);
  expect(devices.at(-1)).toMatch(/^Edit\/\S+ \((macOS|linux); edit serve\)$/u);
  expect(accounts.status()).toMatchObject({ signing_in: true, device: { user_code: "BCDF-GHJK" } });
  // A second ask while it waits is the same code.
  expect((await accounts.beginDevice(app, "edit serve")).userCode).toBe("BCDF-GHJK");
  expect(devices.length).toBe(1);
  await accounts.devicePolling();
  expect(accounts.status()).toMatchObject({ signed_in: true, device: null, person: { email: "someone@gmail.com" } });
  expect(Object.values(kept())).toEqual(["refresh-device-aaaaaaaa"]);
}, 20_000);

test("a device sign-in turned down or run out stops and says so", async () => {
  fs.writeFileSync(join(dir, "keychain.json"), JSON.stringify({}));
  deviceScript = ["authorization_pending", "access_denied"];
  await accounts.beginDevice(app, "remote");
  expect(devices.at(-1)).toMatch(/; remote\)$/u);
  await accounts.devicePolling();
  expect(accounts.status()).toMatchObject({ signed_in: false, device: null, signing_in: false });
  expect(String(accounts.status().problem)).toContain("turned down");
  accounts.resetForTests();
  deviceScript = ["expired_token"];
  await accounts.beginDevice(app, "remote");
  await accounts.devicePolling();
  expect(String(accounts.status().problem)).toContain("ran out");
});

test("the browser lands on a calm page: the code out of the address bar, Edit's window asked to the front, the tab closed if it may be", async () => {
  fs.writeFileSync(join(dir, "keychain.json"), JSON.stringify({}));
  const routes = baseRouter();
  accounts.routes(routes);
  const host = { ...app, allowedHosts: ["127.0.0.1"] } as unknown as App;
  const visit = async (code: string) => {
    const authorize = new URL(accounts.begin(app));
    challenges.set(code, authorize.searchParams.get("code_challenge")!);
    const request = new Request(`http://127.0.0.1:7799/callback?code=${code}&state=${authorize.searchParams.get("state")}`, {
      headers: { host: "127.0.0.1:7799", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" },
    });
    return (await respond(host, routes, request, null))!;
  };
  // Edit's window is open (it's polling): it's told to come forward, and the tab tries to close.
  const polled = windowFocus.next(5_000);
  const page = await (await visit("code-5")).text();
  expect(await polled).toBe(true);
  expect(page).toContain(`history.replaceState(null, "", "/callback")`);
  expect(page).toContain("Signed in as someone@gmail.com. Back to Edit…");
  expect(page).toContain(`<a href="/">Open Edit</a>`);
  expect(page).toContain("window.close()");
  // Headless (no window asking): the button, no close.
  windowFocus.resetForTests();
  await accounts.signOut(app);
  const headless = await (await visit("code-6")).text();
  expect(headless).toContain("You can go back to Edit.");
  expect(headless).not.toContain("window.close()");
});

test("a project made while signed in records who started it; signed out, nobody", async () => {
  const fixture = fixtureHome("accounts-creator");
  try {
    fs.writeFileSync(join(dir, "keychain.json"), JSON.stringify({}));
    const authorize = new URL(accounts.begin(app));
    challenges.set("code-4", authorize.searchParams.get("code_challenge")!);
    await accounts.finish(app, new URLSearchParams({ code: "code-4", state: authorize.searchParams.get("state")! }));
    const by = { sub: "person-1", name: "Someone", picture: "https://lh3.googleusercontent.com/a/someone=s96-c" };
    expect(accounts.creator()).toEqual(by);
    const made = fixture.store.createAs("Trial", "bodycam", { width: 1920, height: 1080, fps: 30 });
    expect(made.project.created_by).toEqual(by);
    expect(fixture.store.list().find((one) => one.id === made.project.id)?.created_by).toEqual(by);
    await accounts.signOut(app);
    expect(accounts.creator()).toBeNull();
    expect(fixture.store.createAs("Later", "bodycam", { width: 1920, height: 1080, fps: 30 }).project.created_by).toBeUndefined();
    // Still the first project's, signed out or not.
    expect(fixture.store.get(made.project.id)?.project.created_by).toEqual(by);
  } finally {
    fixture.cleanup();
  }
});
