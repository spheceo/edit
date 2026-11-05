// The relay's sign-in gate (apps/relay/src/auth.ts): a person's token from accounts.spheceo.com,
// checked against its JWKS, or the old shared token, per route permission.

import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, type JWK } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { allow, budgetKey, caller, CHECK_MS, forgetKeys, readCutOffsWith, useKeys } from "../../../relay/src/auth";
import { cloud } from "../../../relay/src/cloud";
import { reportRefused, WRITABLE } from "../../../relay/src/authz";
import relay, { type Env } from "../../../relay/src/index";

const ISSUER = "https://accounts.example.test";
let privateKey: CryptoKey;
let other: CryptoKey;
let jwk: JWK;
let otherJwk: JWK;

beforeAll(async () => {
  // Nobody cut off (the accounts site's list), unless a test says so.
  readCutOffsWith(async () => Response.json({ at: Date.now(), revoked: [] }));
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
    expect(found).toEqual({ kind: "person", sub: "person-1", perms: ["use", "cloud"], admin: false, name: "Someone", email: "someone@gmail.com" });
    const line = String(logged.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({ route: "transcribe", who: "person-1" });
    expect(line).not.toContain("eyJ");
    expect(line).not.toContain("someone@");
  });

  it("refuses a person without the permission (403), and a bad, expired or other app's token (401)", async () => {
    useKeys(createLocalJWKSet({ keys: [jwk] }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(((await allow(asked(await token({ perms: ["cloud"] })), env(), "use", "transcribe")) as Response).status).toBe(403);
    expect(((await allow(asked(await token({}, { exp: Math.floor(Date.now() / 1000) - 120 })), env(), "use", "transcribe")) as Response).status).toBe(401);
    expect(((await allow(asked(await token({}, { aud: "writer" })), env(), "use", "transcribe")) as Response).status).toBe(401);
    expect(((await allow(asked(await token({}, { iss: "https://evil.test" })), env(), "use", "transcribe")) as Response).status).toBe(401);
    expect(((await allow(asked(await token({}, { key: other })), env(), "use", "transcribe")) as Response).status).toBe(401);
    expect(((await allow(asked("not-a-token"), env(), "use", "transcribe")) as Response).status).toBe(401);
    // An admin may use everything.
    expect(await allow(asked(await token({ perms: [], admin: true })), env(), "use", "cloud/r2/url")).toMatchObject({ kind: "person" });
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

  it("gives the YouTube proxy to signed-in people with a kind of work only", async () => {
    useKeys(createLocalJWKSet({ keys: [jwk] }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const proxied = env({ PROXY_URL: "http://login:secret@gateway.test:823" });
    const none = await relay.fetch(asked(null, "https://relay/v1/proxy"), proxied);
    expect(none.status).toBe(401);
    expect((await relay.fetch(asked(await token({ perms: ["use"] }), "https://relay/v1/proxy"), proxied)).status).toBe(403);
    const given = await relay.fetch(asked(await token({ perms: ["use", "edit.bodycam"] }), "https://relay/v1/proxy"), proxied);
    expect([given.status, await given.json()]).toEqual([200, { proxyUrl: "http://login:secret@gateway.test:823" }]);
    // Without one set: none, said plainly.
    expect(await (await relay.fetch(asked(await token({ perms: ["use", "edit.bodycam"] }), "https://relay/v1/proxy"), env())).json()).toEqual({ proxyUrl: null });
  });

  it("refuses a token made before an admin cut its person off, within a minute, and only for Edit", async () => {
    useKeys(createLocalJWKSet({ keys: [jwk] }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const made = await token();
    const listed = (revoked: unknown[]) => readCutOffsWith(async (url) => {
      expect(url).toBe(`${ISSUER}/app/revoked`);
      return Response.json({ at: Date.now(), revoked });
    });
    listed([]);
    expect(await caller(asked(made), env())).not.toBeNull();
    // Signed out everywhere after this token was made: refused, as if signed out.
    listed([{ sub: "person-1", at: Date.now() + 1_000 }]);
    expect(await caller(asked(made), env())).toBeNull();
    // Signed in again after the cut-off: a new token is fine.
    listed([{ sub: "person-1", at: Date.now() - 120_000 }]);
    expect(await caller(asked(made), env())).not.toBeNull();
    // Another app's access taken away isn't Edit's.
    listed([{ sub: "person-1", at: Date.now() + 1_000, aud: "writer" }]);
    expect(await caller(asked(made), env())).not.toBeNull();
    // The list unreadable: nobody is refused for it (the relay never goes down with the accounts site).
    readCutOffsWith(async () => new Response("down", { status: 503 }));
    expect(await caller(asked(made), env())).not.toBeNull();
    readCutOffsWith(async () => Response.json({ at: Date.now(), revoked: [] }));
  });

  it("reads Trello for people who edit or write scripts, the key kept on the relay", async () => {
    useKeys(createLocalJWKSet({ keys: [jwk] }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const trello = env({ TRELLO_API_KEY: "k", TRELLO_TOKEN: "t" });
    const asked_ = vi.fn(async (url: string) => {
      expect(url.startsWith("https://api.trello.com/1/cards/AbC123x?")).toBe(true);
      return Response.json({ id: "AbC123x", name: "Case", desc: "https://youtu.be/dQw4w9WgXcQ", url: "https://trello.com/c/AbC123x", attachments: [] });
    });
    vi.stubGlobal("fetch", asked_);
    const route = "https://relay/v1/trello/card?card=AbC123x";
    expect((await relay.fetch(asked(null, route), trello)).status).toBe(401);
    expect((await relay.fetch(asked(await token({ perms: ["use"] }), route), trello)).status).toBe(403);
    const answer = await relay.fetch(asked(await token({ perms: ["use", "edit.bodycam"] }), route), trello);
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as { name: string; desc: string }).name).toBe("Case");
    expect(asked_).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("lists a script's Google Docs for the review page's signed-in reviewers only, from the same Drive folder", async () => {
    useKeys(createLocalJWKSet({ keys: [jwk] }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const docs = env({ GOOGLE_DRIVE_CLIENT_ID: "c", GOOGLE_DRIVE_CLIENT_SECRET: "s", GOOGLE_DOCS_REFRESH_TOKEN: "r", DOCS_BURST: { limit: async () => ({ success: true }) } } as Partial<Env>);
    const google = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "a", expires_in: 3600 });
      if (url.includes("name+%3D+%27Writer+scripts%27") || url.includes("name = 'Writer scripts'") || decodeURIComponent(url).includes("name = 'Writer scripts'")) return Response.json({ files: [{ id: "folder1" }] });
      expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain("appProperties has { key='writerScript' and value='abcdef12' }");
      return Response.json({ files: [{ id: "doc1", name: "(DRAFT) Case", createdTime: "2026-10-30T00:00:00Z", appProperties: { writerKind: "draft" } }] });
    });
    vi.stubGlobal("fetch", google);
    const route = "https://relay/v1/docs/exports?script=abcdef12";
    expect((await relay.fetch(asked(null, route), docs)).status).toBe(401);
    // An Edit sign-in is the wrong app for this route.
    expect((await relay.fetch(asked(await token(), route), docs)).status).toBe(401);
    const answer = await relay.fetch(asked(await token({}, { aud: "feedback" }), route), docs);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual([{ id: "doc1", url: "https://docs.google.com/document/d/doc1/edit", name: "(DRAFT) Case", draft: true, createdAt: "2026-10-30T00:00:00Z", state: "live" }]);
    vi.unstubAllGlobals();
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

  it("never waits on a read another request began: one that never comes back holds up nobody else", async () => {
    // Nov 4: on Workers a cancelled request's read never settles, and every request after it that awaited it hung.
    useKeys(createLocalJWKSet({ keys: [jwk] }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const made = await token();
    let reader: (url: string) => Promise<Response> = async () => Response.json({ at: Date.now(), revoked: [] });
    readCutOffsWith((url) => reader(url));
    expect(await caller(asked(made), env())).not.toBeNull();
    // A minute on, the list is old, and the next read never comes back.
    const reads = vi.fn(() => new Promise<Response>(() => {}));
    reader = reads;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    void caller(asked(made), env());
    await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
    // The next request is answered from the list held, not left waiting on that read.
    const next = await Promise.race([caller(asked(made), env()), new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 200))]);
    expect(next).toMatchObject({ kind: "person" });
    expect(reads).toHaveBeenCalledTimes(1);
    readCutOffsWith(async () => Response.json({ at: Date.now(), revoked: [] }));
  });

  it("answers 503 (Edit asks again) when the sign-in can't be checked in time, instead of hanging", async () => {
    forgetKeys();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // The accounts site's keys never come back.
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
      const answer = allow(asked(await token()), env(), "use", "convex");
      await vi.advanceTimersByTimeAsync(CHECK_MS + 1);
      const found = await answer;
      expect(found).toBeInstanceOf(Response);
      expect((found as Response).status).toBe(503);
      expect((found as Response).headers.get("retry-after")).toBe("1");
    } finally {
      vi.useRealTimers();
      forgetKeys();
    }
  });

  it("keeps each person's budget apart, and connections apart for anyone else", async () => {
    const one = await budgetKey(asked(null), { kind: "person", sub: "a", perms: [], admin: false });
    const two = await budgetKey(asked(null), { kind: "person", sub: "b", perms: [], admin: false });
    const shared = await budgetKey(asked(null), { kind: "open" });
    expect(new Set([one, two, shared]).size).toBe(3);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
  });

  it("needs only use on every cloud route (contract v2), ignoring ids it doesn't know", async () => {
    useKeys(createLocalJWKSet({ keys: [jwk] }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const call = async (route: string, perms: string[]) =>
      (await cloud(asked(await token({ perms }), `https://relay/v1/cloud/${route}`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), new URL(`https://relay/v1/cloud/${route}`), env())).status;
    // Without use: refused before anything runs.
    expect(await call("r2/url", ["cloud", "video.subtitles"])).toBe(403);
    // With use, whatever else (v1's names, capability ids, ones it's never heard of): past the gate.
    for (const route of ["google/token", "r2/url", "convex"]) {
      expect(await call(route, ["use"])).not.toBe(403);
      expect(await call(route, ["use", "ai", "video.subtitles", "made.up-thing"])).not.toBe(403);
    }
  });

  it("lets anyone signed in send a problem report (Edit writes there), and only an admin read one", () => {
    const person = { kind: "person" as const, sub: "a", perms: ["use", "edit.bodycam"], admin: false };
    const admin = { ...person, admin: true };
    const key = "edit/reports/2026-10-28/kenobi-1.txt";
    expect(WRITABLE.some((prefix) => key.startsWith(prefix))).toBe(true);
    expect(reportRefused(person, key)).toBe("Only an admin reads problem reports.");
    expect(reportRefused(admin, key)).toBeNull();
    expect(reportRefused(person, "edit/covers/p1.jpg")).toBeNull();
  });

  it("gives voice generation (paid) to editing: any edit style or an admin; not subtitles alone, nor Edit with nothing ticked", async () => {
    useKeys(createLocalJWKSet({ keys: [jwk] }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const speak = async (claims: Record<string, unknown>) =>
      (await relay.fetch(asked(await token(claims), "https://relay/v1/speech", { method: "POST", body: JSON.stringify({ text: "Hi.", voice_id: "abcdefgh12" }), headers: { "content-type": "application/json" } }), env())).status;
    // v2: subtitles only.
    expect(await speak({ perms: ["use", "video.subtitles"] })).toBe(403);
    // Edit with no capability (Nov 5: v2 since, so no token is from before it).
    expect(await speak({ perms: ["use"] })).toBe(403);
    expect(await speak({ perms: ["use", "cloud", "ai"] })).toBe(403);
    // Any edit style or an admin: past the gate (no key configured here: 503).
    expect(await speak({ perms: ["use", "edit.courtroom"] })).not.toBe(403);
    expect(await speak({ perms: ["use", "video.subtitles", "edit.bodycam"] })).not.toBe(403);
    expect(await speak({ perms: ["use"], admin: true })).not.toBe(403);
  });

  it("asks for a signed-in token on a paid route at the front door", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const answer = await relay.fetch(asked(null, "https://relay/v1/voices"), env());
    expect(answer.status).toBe(401);
    expect(await answer.text()).toContain("Sign in");
  });
});
