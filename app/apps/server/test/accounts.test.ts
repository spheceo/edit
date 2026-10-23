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

const dir = fs.mkdtempSync(join(os.tmpdir(), "edit-accounts-"));
const app = { store: { home: join(dir, "home") }, port: 7799 } as unknown as App;
const challenges = new Map<string, string>();
const seen: { path: string; body: Record<string, string> }[] = [];
let refreshes = 0;
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
      if (url.pathname.startsWith("/app/") && !/^Edit\/\S+ \((macOS|linux)\)$/u.test(request.headers.get("user-agent") ?? "")) return Response.json({ error: "no user agent" }, { status: 400 });
      if (url.pathname === "/app/revoke") return Response.json({});
      // Standing in for the relay too: what a tile request carried.
      if (url.pathname.startsWith("/v1/3dtiles/")) return Response.json({ bearer: request.headers.get("authorization"), query: url.search }, { headers: { "cache-control": "max-age=60" } });
      if (url.pathname !== "/app/token") return new Response("not found", { status: 404 });
      if (body.client_id !== "edit") return Response.json({ error: "invalid_client" }, { status: 400 });
      if (body.grant_type === "authorization_code") {
        const challenge = challenges.get(body.code ?? "");
        const sent = createHash("sha256").update(body.code_verifier ?? "").digest("base64url");
        if (challenge === undefined || challenge !== sent || body.redirect_uri !== "http://127.0.0.1:7799/callback") return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({ access_token: jwt({ perms: ["use", "cloud"], email: "someone@gmail.com" }), token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-1-aaaaaaaa", user: { email: "someone@gmail.com", name: "Someone", image: null } });
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
  server.stop(true);
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
  expect(done).toEqual({ ok: true, message: "Signed in as someone@gmail.com. You can close this tab and go back to Edit." });
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
  expect(relay.token()).toBe(relay.sharedToken());
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
