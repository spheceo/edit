// The relay's sign-in gate (apps/relay/src/auth.ts): a person's token from accounts.spheceo.com,
// checked against its JWKS, or the old shared token, per route permission.

import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, type JWK } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { allow, budgetKey, caller, useKeys } from "../../../relay/src/auth";
import { cloud } from "../../../relay/src/cloud";
import relay, { type Env } from "../../../relay/src/index";

const ISSUER = "https://accounts.example.test";
let privateKey: CryptoKey;
let other: CryptoKey;
let jwk: JWK;
let otherJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const second = await generateKeyPair("RS256", { extractable: true });
  other = second.privateKey;
  otherJwk = { ...(await exportJWK(second.publicKey)), kid: "k2", alg: "RS256", use: "sig" };
});

afterEach(() => {
  useKeys(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function token(claims: Record<string, unknown> = {}, options: { kid?: string; key?: CryptoKey; aud?: string; exp?: number; iss?: string } = {}) {
  return new SignJWT({ email: "someone@gmail.com", name: "Someone", perms: ["use", "cloud"], admin: false, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: options.kid ?? "k1" })
    .setIssuer(options.iss ?? ISSUER)
    .setAudience(options.aud ?? "edit")
    .setSubject("person-1")
    .setIssuedAt()
    .setExpirationTime(options.exp ?? Math.floor(Date.now() / 1000) + 3600)
    .sign(options.key ?? privateKey);
}

const env = (extra: Partial<Env> = {}) => ({ ACCOUNTS_ISSUER: ISSUER, CLOUD_TOKEN: "shared-cloud", ...extra }) as Env;
const asked = (bearer: string | null, path = "https://relay/v1/transcribe", init: RequestInit = {}) =>
  new Request(path, { ...init, headers: { ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }), "cf-connecting-ip": "1.2.3.4", ...(init.headers ?? {}) } });

describe("relay sign-in gate", () => {
  it("lets a signed-in person with the route's permission in, and names them in the log", async () => {
    useKeys(createLocalJWKSet({ keys: [jwk] }));
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const found = await allow(asked(await token()), env(), "use", "transcribe");
    expect(found).toEqual({ kind: "person", sub: "person-1", perms: ["use", "cloud"], admin: false });
    const line = String(logged.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({ route: "transcribe", who: "person-1" });
    expect(line).not.toContain("eyJ");
  });

  it("refuses a person without the permission (403), and a bad, expired or other app's token (401)", async () => {
    useKeys(createLocalJWKSet({ keys: [jwk] }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(((await allow(asked(await token()), env(), "export", "cloud/exports/start")) as Response).status).toBe(403);
    expect(((await allow(asked(await token({}, { exp: Math.floor(Date.now() / 1000) - 120 })), env(), "use", "transcribe")) as Response).status).toBe(401);
    expect(((await allow(asked(await token({}, { aud: "writer" })), env(), "use", "transcribe")) as Response).status).toBe(401);
    expect(((await allow(asked(await token({}, { iss: "https://evil.test" })), env(), "use", "transcribe")) as Response).status).toBe(401);
    expect(((await allow(asked(await token({}, { key: other })), env(), "use", "transcribe")) as Response).status).toBe(401);
    expect(((await allow(asked("not-a-token"), env(), "use", "transcribe")) as Response).status).toBe(401);
    // An admin may use everything.
    expect(await allow(asked(await token({ perms: [], admin: true })), env(), "export", "cloud/exports/start")).toMatchObject({ kind: "person" });
    // Inside the 60 s skew an expired token still passes.
    expect(await allow(asked(await token({}, { exp: Math.floor(Date.now() / 1000) - 20 })), env(), "use", "transcribe")).toMatchObject({ kind: "person" });
  });

  it("turns away the retired shared token (telling an old build to update and sign in) and no token, maps included", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const old = (await allow(asked("shared-cloud"), env(), "use", "transcribe")) as Response;
    expect(old.status).toBe(401);
    expect(await old.text()).toContain("out of date");
    const none = (await allow(asked(null), env(), "use", "transcribe")) as Response;
    expect([none.status, (await none.text()).includes("Sign in")]).toEqual([401, true]);
    expect(((await allow(asked(null), env(), "use", "maps", false)) as Response).status).toBe(401);
    // OPEN_MAPS = "1" would open them again.
    expect(await allow(asked(null), env({ OPEN_MAPS: "1" }), "use", "maps", true)).toEqual({ kind: "open" });
  });

  it("fetches the accounts site's keys, and again once for a key it hasn't seen", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      calls += 1;
      expect(String(url)).toBe(`${ISSUER}/.well-known/jwks.json`);
      return new Response(JSON.stringify({ keys: calls === 1 ? [jwk] : [jwk, otherJwk] }), { headers: { "content-type": "application/json" } });
    }));
    const issuer = `${ISSUER}`;
    expect(await caller(asked(await token()), { ACCOUNTS_ISSUER: issuer })).toMatchObject({ kind: "person" });
    expect(calls).toBe(1);
    // A rotated key: the cached set doesn't have k2, so it's fetched again (once), past the 5 s between fetches.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 6_000);
    expect(await caller(asked(await token({}, { kid: "k2", key: other })), { ACCOUNTS_ISSUER: issuer })).toMatchObject({ kind: "person" });
    expect(calls).toBe(2);
  });

  it("keeps each person's budget apart, and connections apart for anyone else", async () => {
    const one = await budgetKey(asked(null), { kind: "person", sub: "a", perms: [], admin: false });
    const two = await budgetKey(asked(null), { kind: "person", sub: "b", perms: [], admin: false });
    const shared = await budgetKey(asked(null), { kind: "open" });
    expect(new Set([one, two, shared]).size).toBe(3);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gates each cloud route by its permission", async () => {
    useKeys(createLocalJWKSet({ keys: [jwk] }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const call = async (route: string, perms: string[]) =>
      (await cloud(asked(await token({ perms }), `https://relay/v1/cloud/${route}`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), new URL(`https://relay/v1/cloud/${route}`), env())).status;
    // Without the permission: refused before anything runs.
    expect(await call("ai/chat", ["use", "cloud"])).toBe(403);
    expect(await call("google/token", ["use", "cloud"])).toBe(403);
    expect(await call("r2/url", ["use"])).toBe(403);
    expect(await call("exports/start", ["use", "cloud"])).toBe(403);
    // With it: past the gate (the relay has nothing configured here, so it says so instead).
    expect(await call("ai/chat", ["ai"])).not.toBe(403);
    expect(await call("r2/url", ["cloud"])).not.toBe(403);
    // Modal's worker routes take only the worker token, never a person's.
    expect(await call("exports/worker/claim", ["export"])).toBe(401);
  });

  it("asks for a signed-in token on a paid route at the front door", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const answer = await relay.fetch(asked(null, "https://relay/v1/voices"), env());
    expect(answer.status).toBe(401);
    expect(await answer.text()).toContain("Sign in");
  });
});
