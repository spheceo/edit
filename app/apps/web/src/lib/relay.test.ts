import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useKeys } from "../../../relay/src/auth";
import { presign, validKey, validPrefix, writerReadable } from "../../../relay/src/cloud";
import relay, { TranscriptionBudget, type Env } from "../../../relay/src/index";

/** A signed-in person's token (every permission), checked against a key of the test's own. */
let PERSON = "";
/** The same person's token with their name, email and Google photo. */
let NAMED = "";
/** Kinds of video (contract v2): a subtitler, a bodycam editor (the same person-t), an admin. */
let SUBS = "";
let EDITOR = "";
let ADMIN = "";
/** Script mode (Writer's capabilities in Edit): an interrogation writer who shares reviews, and an Edit-only editor. */
let WRITER = "";
let USE_ONLY = "";
beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  useKeys(createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "t1", alg: "RS256" }] }));
  PERSON = await new SignJWT({ perms: ["use", "cloud", "drive", "ai", "export", "edit.bodycam"], admin: false }).setProtectedHeader({ alg: "RS256", kid: "t1" }).setIssuer("https://accounts.spheceo.com").setAudience("edit").setSubject("person-t").setIssuedAt().setExpirationTime("1h").sign(privateKey);
  NAMED = await new SignJWT({ perms: ["use", "edit.bodycam"], admin: false, name: "Some One", email: "someone@gmail.com", picture: "https://lh3.googleusercontent.com/a/someone=s96-c" }).setProtectedHeader({ alg: "RS256", kid: "t1" }).setIssuer("https://accounts.spheceo.com").setAudience("edit").setSubject("person-t").setIssuedAt().setExpirationTime("1h").sign(privateKey);
  const sign = (claims: Record<string, unknown>, sub = "person-t") => new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "t1" }).setIssuer("https://accounts.spheceo.com").setAudience("edit").setSubject(sub).setIssuedAt().setExpirationTime("1h").sign(privateKey);
  SUBS = await sign({ perms: ["use", "video.subtitles"], admin: false }, "person-s");
  EDITOR = await sign({ perms: ["use", "edit.bodycam", "video.subtitles"], admin: false });
  ADMIN = await sign({ perms: ["use"], admin: true }, "person-a");
  WRITER = await sign({ perms: ["use", "scripts.interrogation", "review.share"], admin: false }, "person-w");
  USE_ONLY = await sign({ perms: ["use", "cloud", "drive"], admin: false }, "person-u");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => useKeys(null));

describe("relay atomic spend reservations", () => {
  it("counts concurrent in-flight requests before permitting more spend", async () => {
    const values = new Map<string, number>();
    let chain = Promise.resolve();
    type Storage = ConstructorParameters<typeof TranscriptionBudget>[0]["storage"];
    const storage: Storage = {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: number) => { values.set(key, value); },
      transaction: <T>(callback: (store: Storage) => Promise<T>): Promise<T> => {
        const result = chain.then(() => callback(storage));
        chain = result.then(() => {}); return result;
      },
      setAlarm: async () => {}, deleteAll: async () => { values.clear(); },
    };
    const budget = new TranscriptionBudget({ storage }, { DAILY_BYTES_PER_IP: "100", DAILY_BYTES_TOTAL: "120", MAX_UPLOAD_BYTES: "100" } as Env);
    const reserve = (client: string, size: number) => budget.fetch(new Request("https://budget/reserve", { method: "POST", body: JSON.stringify({ client: client.repeat(64), size }) }));
    const responses = await Promise.all([reserve("a", 70), reserve("a", 70), reserve("b", 70)]);
    expect(responses.map(response => response.status)).toEqual([200, 429, 429]);
    expect(values.get("all")).toBe(70);
    expect((await reserve("b", 50)).status).toBe(200);
    expect(values.get("all")).toBe(120);
    await budget.alarm(); expect(values.size).toBe(0);
  });

  it("holds each AI call's reserve before it runs, so calls at once can't pass the budget together, and settles it at the real cost", async () => {
    const values = new Map<string, number>();
    let chain = Promise.resolve();
    type Storage = ConstructorParameters<typeof TranscriptionBudget>[0]["storage"];
    const storage: Storage = {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: number) => { values.set(key, value); },
      transaction: <T>(callback: (store: Storage) => Promise<T>): Promise<T> => {
        const result = chain.then(() => callback(storage));
        chain = result.then(() => {}); return result;
      },
      setAlarm: async () => {}, deleteAll: async () => { values.clear(); },
    };
    const budget = new TranscriptionBudget({ storage }, { DAILY_LOOKUPS_PER_IP: "2", DAILY_LOOKUPS_TOTAL: "3" } as Env);
    const ai = (phase: string, cost = 0) => budget.fetch(new Request("https://budget/ai", { method: "POST", body: JSON.stringify({ client: "a".repeat(64), phase, cost, reserve: 0.1, perIp: 0.25, total: 10 }) }));
    expect((await Promise.all([ai("check"), ai("check"), ai("check")])).map((answer) => answer.status)).toEqual([200, 200, 429]);
    expect(values.get("ai")).toBeCloseTo(0.2);
    // One cost 0.01, one failed (0): both holds given back but the cost.
    await ai("spend", 0.01);
    await ai("spend", 0);
    expect(values.get("ai")).toBeCloseTo(0.01);
    expect((await ai("check")).status).toBe(200);
    // Map lookups: two a day for this account, three for everyone.
    const lookup = (client: string) => budget.fetch(new Request("https://budget/lookups", { method: "POST", body: JSON.stringify({ client: client.repeat(64) }) }));
    expect([(await lookup("a")).status, (await lookup("a")).status, (await lookup("a")).status, (await lookup("b")).status, (await lookup("c")).status]).toEqual([200, 200, 429, 200, 429]);
  });

  it("hearing footage again for its names gets only a share of the day; new footage still gets the rest", async () => {
    const values = new Map<string, number>();
    type Storage = ConstructorParameters<typeof TranscriptionBudget>[0]["storage"];
    const storage: Storage = {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: number) => { values.set(key, value); },
      transaction: <T>(callback: (store: Storage) => Promise<T>) => callback(storage),
      setAlarm: async () => {}, deleteAll: async () => { values.clear(); },
    };
    const budget = new TranscriptionBudget({ storage }, { DAILY_BYTES_PER_IP: "100", DAILY_BYTES_TOTAL: "100", DAILY_REHEAR_BYTES: "30", MAX_UPLOAD_BYTES: "100" } as Env);
    const reserve = (size: number, again: boolean) => budget.fetch(new Request("https://budget/reserve", { method: "POST", body: JSON.stringify({ client: "a".repeat(64), size, again }) }));
    expect((await reserve(20, true)).status).toBe(200);
    expect((await reserve(20, true)).status).toBe(429);
    expect((await reserve(70, false)).status).toBe(200);
    expect(values.get("all")).toBe(90);
  });
});

describe("relay cloud endpoints", () => {
  const env = {
    CLOUD_TOKEN: "cloud-secret",
    R2_ACCOUNT_ID: "account",
    R2_ACCESS_KEY_ID: "AKID",
    R2_SECRET_ACCESS_KEY: "SECRET",
    R2_BUCKET: "bucket",
    CONVEX_URL: "https://example.convex.cloud/",
    CONVEX_SERVICE_TOKEN: "service-token",
  } as Env;
  const call = (route: string, body: unknown, options: { token?: string | null; env?: Env; method?: string } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = options.token === undefined ? PERSON : options.token;
    if (token !== null) headers.authorization = `Bearer ${token}`;
    const method = options.method ?? "POST";
    return relay.fetch(new Request(`https://relay.test/v1/cloud/${route}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body) }), options.env ?? env);
  };
  afterEach(() => { vi.unstubAllGlobals(); });

  it("refuses every request without a signed-in person's token, the old shared one included", async () => {
    const upstream = vi.fn(); vi.stubGlobal("fetch", upstream);
    const body = { key: "edit/a.mp4", method: "GET" };
    expect((await call("r2/url", body, { token: null })).status).toBe(401);
    expect((await call("r2/url", body, { token: "wrong" })).status).toBe(401);
    // The retired shared token, even on a relay that still had it set.
    expect((await call("r2/url", body, { token: "cloud-secret" })).status).toBe(401);
    expect((await call("r2/url", body, { token: "" })).status).toBe(401);
    expect((await call("convex", { kind: "query", path: "edit:get" }, { token: "wrong" })).status).toBe(401);
    expect((await call("r2/url", body, { method: "GET" })).status).toBe(405);
    expect((await call("r2/url", body)).status).toBe(200);
    expect((await call("r2/constructor", body)).status).toBe(404);
    expect((await call("r2/head", { key: "edit/a" }, { env: { ...env, R2_BUCKET: undefined } })).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("reads Writer's scripts for the handoff, never writes them, and calls only edit:, reviews: and Writer's two reads", async () => {
    const upstream = vi.fn(async () => new Response(JSON.stringify({ status: "success", value: 1 }))); vi.stubGlobal("fetch", upstream);
    expect(writerReadable("writer/scripts/abc/body/3-ff.json")).toBe(true);
    for (const key of ["writer/lessons.json", "writer/scripts/../x", "writer/scripts/a//b", "repack/scripts/a"]) expect(writerReadable(key)).toBe(false);
    expect((await call("r2/url", { key: "writer/scripts/abc/body/3-ff.json" })).status).toBe(200);
    expect((await call("r2/url", { key: "writer/scripts/abc/body/3-ff.json", method: "PUT" })).status).toBe(400);
    expect((await call("convex", { kind: "query", path: "writer:getScript", args: {} })).status).toBe(200);
    expect((await call("convex", { kind: "mutation", path: "writer:commitScript", args: {} })).status).toBe(403);
    expect((await call("convex", { kind: "mutation", path: "records:anything", args: {} })).status).toBe(403);
    // A review call is always Edit's, whatever it says.
    expect((await call("convex", { kind: "mutation", path: "reviews:publish", args: { app: "writer" } })).status).toBe(200);
    // Only the reviews functions Edit calls, each as its kind.
    expect((await call("convex", { kind: "mutation", path: "reviews:setAccess", args: {} })).status).toBe(403);
    expect((await call("convex", { kind: "mutation", path: "reviews:get", args: {} })).status).toBe(403);
    expect((await call("convex", { kind: "query", path: "reviews:get", args: {} })).status).toBe(200);
    const [, init] = upstream.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).args.app).toBe("edit");
  });

  it("Script mode's cloud keeps Writer's rules: reads for anyone, writes for script work of the script's kind, reviews as Writer", async () => {
    const upstream = vi.fn(async (url: string, init?: RequestInit) => {
      const sent = init?.body ? JSON.parse(String(init.body)) : {};
      // The relay looking a script up before a delete: an interrogation script.
      if (String(url).includes("/api/query") && sent.path === "writer:getScript") return new Response(JSON.stringify({ status: "success", value: { summary: { kind: "interrogation" } } }));
      return new Response(JSON.stringify({ status: "success", value: 1 }));
    });
    vi.stubGlobal("fetch", upstream);
    const writer = (route: string, body: unknown, token: string) => call(`writer/${route}`, body, { token });
    // Reading is open to anyone who may use Edit.
    expect((await writer("r2/url", { key: "writer/scripts/a/body/1-ff.json" }, EDITOR)).status).toBe(200);
    expect((await writer("convex", { kind: "query", path: "writer:listScripts" }, EDITOR)).status).toBe(200);
    // Writing needs script work: an Edit-only editor can't, a writer can.
    expect((await writer("r2/url", { key: "writer/scripts/a/body/2-ff.json", method: "PUT" }, EDITOR)).status).toBe(403);
    expect((await writer("r2/url", { key: "writer/scripts/a/body/2-ff.json", method: "PUT" }, WRITER)).status).toBe(200);
    // The shared lessons need review.lessons.
    expect((await writer("r2/url", { key: "writer/lessons.json", method: "PUT" }, WRITER)).status).toBe(403);
    expect((await writer("r2/url", { key: "writer/lessons.json", method: "PUT" }, ADMIN)).status).toBe(200);
    // `use` with no capability is no one's admin: it reads, and writes nothing.
    expect((await writer("convex", { kind: "query", path: "writer:listScripts" }, USE_ONLY)).status).toBe(200);
    expect((await writer("convex", { kind: "mutation", path: "writer:commitScript", args: { summary: { kind: "interrogation" } } }, USE_ONLY)).status).toBe(403);
    expect((await writer("r2/url", { key: "writer/lessons.json", method: "PUT" }, USE_ONLY)).status).toBe(403);
    // A commit of the writer's own kind goes through; another kind's doesn't.
    expect((await writer("convex", { kind: "mutation", path: "writer:commitScript", args: { summary: { kind: "interrogation" } } }, WRITER)).status).toBe(200);
    expect((await writer("convex", { kind: "mutation", path: "writer:commitScript", args: { summary: { kind: "courtroom" } } }, WRITER)).status).toBe(403);
    expect((await writer("convex", { kind: "mutation", path: "writer:commitScript", args: { summary: { kind: "interrogation" } } }, EDITOR)).status).toBe(403);
    // A delete is judged by what the script is in the cloud.
    expect((await writer("convex", { kind: "mutation", path: "writer:deleteScript", args: { scriptId: "a" } }, WRITER)).status).toBe(200);
    // Reviews: shared by who may share, always as Writer.
    expect((await writer("convex", { kind: "mutation", path: "reviews:publish", args: { app: "edit" } }, EDITOR)).status).toBe(403);
    expect((await writer("convex", { kind: "mutation", path: "reviews:publish", args: { app: "edit" } }, WRITER)).status).toBe(200);
    const [, init] = upstream.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).args.app).toBe("writer");
    // Nothing else is reachable, and keys stay under writer/ (or Edit's shared footage, never deleted from here).
    expect((await writer("convex", { kind: "mutation", path: "edit:deleteProject", args: {} }, ADMIN)).status).toBe(403);
    expect((await writer("r2/url", { key: "edit/projects/p/project.json" }, WRITER)).status).toBe(400);
    expect((await writer("r2/url", { key: "edit/originals/youtube/x/a.mp4", method: "PUT" }, WRITER)).status).toBe(200);
    expect((await writer("r2/delete", { keys: ["edit/originals/youtube/x/a.mp4"] }, WRITER)).status).toBe(400);
    expect((await writer("r2/list", { prefix: "edit/" }, ADMIN)).status).toBe(400);
    // Problem reports: anyone puts one, only an admin reads them.
    expect((await writer("r2/url", { key: "writer/reports/r1.json", method: "PUT" }, EDITOR)).status).toBe(200);
    expect((await writer("r2/url", { key: "writer/reports/r1.json" }, WRITER)).status).toBe(403);
    expect((await writer("r2/url", { key: "writer/reports/r1.json" }, ADMIN)).status).toBe(200);
  });

  it("Script mode's cloud has its own limit, not the 4 a minute of maps and lookups", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "success", value: [] }))));
    const read = (limits: Partial<Env>) => call("writer/convex", { kind: "query", path: "writer:listScripts" }, { env: { ...env, ...limits } as Env });
    const no = { limit: async () => ({ success: false }) };
    const yes = { limit: async () => ({ success: true }) };
    expect((await read({ BURST: no, CLOUD_BURST: yes } as Partial<Env>)).status).toBe(200);
    expect((await read({ BURST: yes, CLOUD_BURST: no } as Partial<Env>)).status).toBe(429);
  });

  it("publishes Script mode's capabilities with Edit's, their ids unchanged", async () => {
    const answer = await relay.fetch(new Request("https://relay.test/.well-known/spheceo-app.json"), env);
    const ids = ((await answer.json()) as { capabilities: { id: string }[] }).capabilities.map((one) => one.id);
    for (const id of ["edit.bodycam", "scripts.interrogation", "scripts.commentary", "review.share", "review.lessons"]) expect(ids).toContain(id);
  });

  it("only touches keys under edit/", async () => {
    const upstream = vi.fn(); vi.stubGlobal("fetch", upstream);
    for (const key of ["edit/a.mp4", "edit/projects/p1/media/clip-1.mov", "edit/test/a b+c.mov"]) expect(validKey(key)).toBe(true);
    for (const key of ["", "edit", "edit/", "edit//a", "edit/a/", "edit/../repack/x", "edit/a/../../b", "edit/./a", "/edit/a", "repack/a", "editor/a", "edit/a\nb", "edit\\a", 7, null]) {
      expect(validKey(key)).toBe(false);
      expect((await call("r2/url", { key })).status).toBe(400);
      expect((await call("r2/head", { key })).status).toBe(400);
      expect((await call("r2/multipart/create", { key })).status).toBe(400);
    }
    expect((await call("r2/delete", { keys: ["edit/a", "repack/b"] })).status).toBe(400);
    expect(validPrefix("edit/")).toBe(true);
    expect(validPrefix("edit/test/")).toBe(true);
    expect(validPrefix("edit/test/clip-")).toBe(true);
    for (const prefix of ["", "e", "edit", "repack/", "edit/../", "edit//", "edit/a/../"]) expect(validPrefix(prefix)).toBe(false);
    expect((await call("r2/list", { prefix: "repack/" })).status).toBe(400);
    expect((await call("r2/list", { prefix: "" })).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("presigns R2 URLs with default and capped lifetimes", async () => {
    const answer = async (body: unknown) => new URL(((await (await call("r2/url", body)).json()) as { url: string }).url);
    const get = await answer({ key: "edit/test/a b.mp4" });
    expect(get.origin).toBe("https://account.r2.cloudflarestorage.com");
    expect(get.pathname).toBe("/bucket/edit/test/a%20b.mp4");
    expect(get.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(get.searchParams.get("X-Amz-Credential")).toMatch(/^AKID\/\d{8}\/auto\/s3\/aws4_request$/);
    expect(get.href).not.toContain("SECRET");
    expect((await answer({ key: "edit/originals/sha256/ab/a.mp4", method: "PUT" })).searchParams.get("X-Amz-Expires")).toBe("3600");
    // At most an hour (the audit, Oct 23: links lasted 7 days); a GET of footage up to 6 h, for FFmpeg reading a whole original.
    expect((await answer({ key: "edit/a", expires: 30 * 86400 })).searchParams.get("X-Amz-Expires")).toBe("3600");
    expect((await answer({ key: "edit/originals/drive/f1/a.mp4", expires: 30 * 86400 })).searchParams.get("X-Amz-Expires")).toBe(String(6 * 3600));
    expect((await answer({ key: "edit/originals/drive/f1/a.mp4", method: "PUT", expires: 30 * 86400 })).searchParams.get("X-Amz-Expires")).toBe("3600");
    expect((await call("r2/url", { key: "edit/a", method: "DELETE" })).status).toBe(400);
    expect((await call("r2/url", { key: "edit/a", expires: -1 })).status).toBe(400);
  });

  it("signs exactly as AWS SigV4 does (AWS's documented example)", async () => {
    const url = await presign({
      method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", expires: 86400, date: new Date("2013-05-24T00:00:00Z"),
    });
    expect(new URL(url).searchParams.get("X-Amz-Signature")).toBe("aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  });

  it("forwards only edit: Convex functions, with the service token the caller can't override", async () => {
    const upstream = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ status: "success", value: { id: 1 }, logLines: [] }));
    vi.stubGlobal("fetch", upstream);
    for (const path of ["repack:list", "editor:get", "edit/sub:get", "edit:", "edit:get/x", ":edit:get", "users:edit", "Edit:get", 3]) {
      expect((await call("convex", { kind: "query", path })).status).toBe(403);
    }
    expect((await call("convex", { kind: "internalQuery", path: "edit:get" })).status).toBe(400);
    expect((await call("convex", { kind: "query", path: "edit:getMedia", args: [1] })).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();

    const answer = await call("convex", { kind: "mutation", path: "edit:putMedia", args: { project: "p1", token: "forged" } });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ status: "success", value: { id: 1 } });
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe("https://example.convex.cloud/api/mutation");
    expect(JSON.parse(String(init.body))).toEqual({ path: "edit:putMedia", args: { project: "p1", token: "service-token" }, format: "json" });
  });

  it("a project's first commit records who started it from the token, never from the caller, once switched on", async () => {
    const upstream = vi.fn(async () => Response.json({ status: "success", value: { rev: 1 } })); vi.stubGlobal("fetch", upstream);
    const sent = () => JSON.parse(String((upstream.mock.calls.at(-1) as unknown as [string, RequestInit])[1].body)).args;
    const commit = { kind: "mutation", path: "edit:commitProject", args: { projectId: "p1", baseRev: 0, actor: { sub: "forged", name: "Someone Else" } } };
    // Off (until Repack's commitProject takes it): nothing new reaches Convex, and a caller's actor never does.
    await call("convex", commit, { token: NAMED });
    expect(sent()).toEqual({ projectId: "p1", baseRev: 0, token: "service-token" });
    const on = { ...env, STAMP_CREATOR: "1" } as Env;
    await call("convex", commit, { token: NAMED, env: on });
    expect(sent()).toEqual({ projectId: "p1", baseRev: 0, actor: { sub: "person-t", name: "Some One", email: "someone@gmail.com", picture: "https://lh3.googleusercontent.com/a/someone=s96-c" }, token: "service-token" });
    // A token without a name: its sub, and an empty name (the UI shows nothing for that).
    await call("convex", commit, { env: on });
    expect(sent().actor).toEqual({ sub: "person-t", name: "" });
    // Other calls are left as they were.
    await call("convex", { kind: "mutation", path: "edit:putMedia", args: { actor: 1 } }, { token: NAMED, env: on });
    expect(sent()).toEqual({ actor: 1, token: "service-token" });
  });

  it("passes Convex's errors on", async () => {
    // A function's error (or no such function): Convex's own shape, as 200.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "error", errorMessage: "Server Error\nCould not find public function for 'edit:listMedia'.\n" })));
    const missing = await call("convex", { kind: "query", path: "edit:listMedia" });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ status: "error", errorMessage: "Server Error\nCould not find public function for 'edit:listMedia'." });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "error", errorMessage: "Uncaught Error: no", errorData: { why: 1 } }, { status: 560 })));
    expect(await (await call("convex", { kind: "query", path: "edit:getMedia" })).json()).toEqual({ status: "error", errorMessage: "Uncaught Error: no", errorData: { why: 1 } });
    // A request Convex refused: a relay error with Convex's status.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "BadJsonBody", message: "nope" }, { status: 400 })));
    const refused = await call("convex", { kind: "query", path: "edit:getMedia" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "Convex: BadJsonBody: nope" });
  });

  /** Convex answering `edit:getProject` with `card` (null: not in the cloud), every other call with `value`; R2 with 204. */
  const cloudWith = (card: Record<string, unknown> | null, value: unknown = { ok: 1 }) => {
    const upstream = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("cloudflarestorage.com")) return new Response(url.includes("list-type") ? "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>" : null, { status: url.includes("list-type") ? 200 : 204 });
      const sent = JSON.parse(String(init?.body ?? "{}")) as { path?: string };
      return Response.json({ status: "success", value: sent.path === "edit:getProject" ? card : value });
    });
    vi.stubGlobal("fetch", upstream);
    const paths = () => upstream.mock.calls.map(([url, init]) => (String(url).includes("convex") ? JSON.parse(String(init?.body)).path : "r2"));
    return { upstream, paths };
  };
  const bodycam = { projectId: "p1", summary: { style: "bodycam", subtitles: false, footageOnly: false }, createdBy: { sub: "person-t", name: "T" } };

  it("calls only the edit: functions Edit uses, each as its kind", async () => {
    cloudWith(null);
    for (const [kind, path] of [["mutation", "edit:deleteMedia"], ["mutation", "edit:sweepUploads"], ["mutation", "edit:getProject"], ["query", "edit:commitProject"]]) {
      expect((await call("convex", { kind, path, args: {} })).status).toBe(403);
    }
    expect((await call("convex", { kind: "query", path: "edit:listMedia", args: {} })).status).toBe(200);
  });

  it("keeps a project outside the caller's kinds of video from being read or changed", async () => {
    const { paths } = cloudWith(bodycam, [bodycam, { projectId: "p2", summary: { style: "bodycam", subtitles: true } }, { projectId: "p3", summary: { footageOnly: true } }]);
    // A subtitler: the bodycam edit is left out of the list, refused when opened, locked or saved.
    const listed = (await (await call("convex", { kind: "query", path: "edit:listProjects", args: {} }, { token: SUBS })).json()) as { value: { projectId: string }[] };
    expect(listed.value.map((card) => card.projectId)).toEqual(["p2", "p3"]);
    expect((await call("convex", { kind: "query", path: "edit:getProject", args: { projectId: "p1" } }, { token: SUBS })).status).toBe(403);
    expect((await call("convex", { kind: "mutation", path: "edit:acquireLock", args: { projectId: "p1", holder: "x", force: true } }, { token: SUBS })).status).toBe(403);
    expect((await call("convex", { kind: "mutation", path: "edit:commitProject", args: { projectId: "p1", baseRev: 3, summary: { subtitles: true } } }, { token: SUBS })).status).toBe(403);
    expect(paths().filter((path) => path !== "edit:getProject")).toEqual(["edit:listProjects"]);
    // Its review's files and cover too.
    expect((await call("r2/url", { key: "edit/reviews/p1/abc/video.mp4" }, { token: SUBS })).status).toBe(403);
    expect((await call("r2/url", { key: "edit/covers/p1.jpg", method: "PUT" }, { token: SUBS })).status).toBe(403);
    // The bodycam editor may; and anyone may start a project of their own kind.
    expect((await call("convex", { kind: "mutation", path: "edit:acquireLock", args: { projectId: "p1", holder: "x" } }, { token: EDITOR })).status).toBe(200);
    expect((await call("r2/url", { key: "edit/reviews/p1/abc/video.mp4" }, { token: EDITOR })).status).toBe(200);
    cloudWith(null);
    expect((await call("convex", { kind: "mutation", path: "edit:commitProject", args: { projectId: "p9", baseRev: 0, summary: { style: "bodycam", footageOnly: true } } }, { token: SUBS })).status).toBe(200);
    expect((await call("convex", { kind: "mutation", path: "edit:commitProject", args: { projectId: "p9", baseRev: 0, summary: { style: "courtroom" } } }, { token: EDITOR })).status).toBe(403);
  });

  it("deletes a project only for who started it, or an admin", async () => {
    cloudWith({ ...bodycam, createdBy: { sub: "someone-else" } });
    expect((await call("convex", { kind: "mutation", path: "edit:deleteProject", args: { projectId: "p1" } }, { token: EDITOR })).status).toBe(403);
    // An older project (no creator): an admin's to delete.
    cloudWith({ ...bodycam, createdBy: null });
    expect((await call("convex", { kind: "mutation", path: "edit:deleteProject", args: { projectId: "p1" } }, { token: EDITOR })).status).toBe(403);
    cloudWith(bodycam);
    expect((await call("convex", { kind: "mutation", path: "edit:deleteProject", args: { projectId: "p1" } }, { token: EDITOR })).status).toBe(200);
    const { paths } = cloudWith({ ...bodycam, createdBy: { sub: "someone-else" } });
    expect((await call("convex", { kind: "mutation", path: "edit:deleteProject", args: { projectId: "p1" } }, { token: ADMIN })).status).toBe(200);
    expect(paths()).toEqual(["edit:deleteProject"]);
  });

  it("cancels a Drive copy only for who started it, or an admin", async () => {
    const values = new Map<string, unknown>();
    type Storage = ConstructorParameters<typeof TranscriptionBudget>[0]["storage"];
    const storage = {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { values.set(key, value); },
      transaction: <T>(callback: (store: Storage) => Promise<T>) => callback(storage as Storage),
      setAlarm: async () => {}, deleteAll: async () => { values.clear(); },
    };
    const owners = new TranscriptionBudget({ storage: storage as Storage }, env);
    const terminated: string[] = [];
    let found: { id: string; status(): Promise<{ status: string }>; terminate(): Promise<void> } | null = null;
    const jobs = { ...env, GOOGLE_DRIVE_CLIENT_ID: "c", GOOGLE_DRIVE_CLIENT_SECRET: "s", GOOGLE_DOCS_REFRESH_TOKEN: "r",
      BUDGET: { idFromName: (name: string) => name, get: () => owners },
      DRIVE_TO_R2: {
        async get() { if (!found) throw new Error("not found"); return found; },
        async create({ id }: { id: string }) { found = { id, status: async () => ({ status: "running" }), terminate: async () => { terminated.push(id); } }; return found; },
      } } as unknown as Env;
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "t" });
      return Response.json({ name: "a.mp4", size: "10", md5Checksum: "v1" });
    });
    const started = (await (await call("jobs/drive", { file: "FILEabcdefgh", key: "edit/originals/drive/FILEabcdefgh/a.mp4" }, { token: EDITOR, env: jobs })).json()) as { id: string };
    // Another project joining the same copy doesn't make it theirs.
    await call("jobs/drive", { file: "FILEabcdefgh", key: "edit/originals/drive/FILEabcdefgh/a.mp4" }, { token: SUBS, env: jobs });
    expect((await call("jobs/cancel", { id: started.id }, { token: SUBS, env: jobs })).status).toBe(403);
    expect(terminated).toEqual([]);
    expect((await call("jobs/cancel", { id: started.id }, { token: EDITOR, env: jobs })).status).toBe(200);
    expect((await call("jobs/cancel", { id: started.id }, { token: ADMIN, env: jobs })).status).toBe(200);
    expect(terminated.length).toBe(2);
  });

  it("writes keys only where Edit writes them; deletes and lists beyond the analysis only for an admin", async () => {
    cloudWith(null);
    for (const key of ["edit/projects/p1.json", "edit/exports/results/x.mp4", "edit/test/a.mp4"]) {
      expect((await call("r2/url", { key, method: "PUT" })).status).toBe(403);
      expect((await call("r2/multipart/create", { key })).status).toBe(403);
    }
    expect((await call("r2/url", { key: "edit/exports/results/x.mp4" })).status).toBe(200);
    expect((await call("r2/multipart/abort", { key: "edit/exports/results/x.mp4", uploadId: "u1" })).status).toBe(403);
    expect((await call("r2/url", { key: "edit/test/a.mp4", method: "PUT" }, { token: ADMIN })).status).toBe(200);
    expect((await call("r2/delete", { keys: ["edit/originals/drive/f/a.mp4"] })).status).toBe(403);
    expect((await call("r2/delete", { keys: ["edit/originals/drive/f/a.mp4"] }, { token: ADMIN })).status).toBe(200);
    expect((await call("r2/list", { prefix: "edit/" })).status).toBe(403);
    expect((await call("r2/list", { prefix: "edit/reviews/" })).status).toBe(403);
    expect((await call("r2/list", { prefix: "edit/analysis/drive/f/" })).status).toBe(200);
    expect((await call("r2/list", { prefix: "edit/" }, { token: ADMIN })).status).toBe(200);
  });
});

describe("relay cloud jobs: Drive → R2", () => {
  it("joins concurrent imports of the same Drive version without aborting another upload", async () => {
    const { driveJob } = await import("../../../relay/src/jobs");
    const r2 = { host: "acct.r2.cloudflarestorage.com", bucket: "bucket", accessKeyId: "key", secret: "secret" };
    let found: { id: string; status(): Promise<{ status: string }>; terminate(): Promise<void> } | null = null;
    let starts = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "t" });
      if (url.hostname === "www.googleapis.com") return Response.json({ name: "a.mp4", size: "10", md5Checksum: "version1" });
      throw new Error("starting a shared copy must not sweep R2 multipart uploads");
    });
    const env = { GOOGLE_DRIVE_CLIENT_ID: "c", GOOGLE_DRIVE_CLIENT_SECRET: "s", GOOGLE_DOCS_REFRESH_TOKEN: "r", DRIVE_TO_R2: {
      async get() { if (!found) throw new Error("not found"); return found; },
      async create({ id }: { id: string }) { starts++; if (found) throw new Error("already exists"); found = { id, status: async () => ({ status: "queued" }), terminate: async () => {} }; return found; },
    } };
    try {
      const results = await Promise.all([driveJob({ file: "FILEabcdefgh", key: "edit/test/a.mp4" }, env, r2), driveJob({ file: "FILEabcdefgh", key: "edit/test/a.mp4" }, env, r2)]);
      expect(results[0].id).toBe(results[1].id);
      expect(starts).toBeGreaterThanOrEqual(1);
      expect(results.every(result => result.status === "queued")).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it("copies a Drive file part by part into an R2 multipart upload, checks its size and registers it", async () => {
    const { DriveToR2 } = await import("../../../relay/src/jobs");
    const file = new Uint8Array(25).map((_, index) => index);
    const parts = new Map<number, Uint8Array>();
    const calls: string[] = [];
    let registered: unknown = null;
    vi.stubGlobal("FixedLengthStream", class { readable: ReadableStream; writable: WritableStream; constructor() { const pipe = new TransformStream(); this.readable = pipe.readable; this.writable = pipe.writable; } });
    vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? "GET";
      calls.push(`${method} ${url.host}${url.pathname}${url.searchParams.has("partNumber") ? `#${url.searchParams.get("partNumber")}` : ""}`);
      if (url.host === "oauth2.googleapis.com") return Response.json({ access_token: "t" });
      if (url.pathname.endsWith("/files/FILEabcdefgh") && !url.searchParams.has("alt")) return Response.json({ name: "a.mp4", size: "25", md5Checksum: "v1" });
      if (url.searchParams.get("alt") === "media") {
        const [from, to] = new Headers(init.headers).get("range")!.slice(6).split("-").map(Number);
        return new Response(file.slice(from, to + 1), { status: 206 });
      }
      if (url.host.endsWith("r2.cloudflarestorage.com")) {
        if (method === "HEAD") return parts.size === 3 && registered === null && calls.some((call) => call.startsWith("POST") && call.includes("complete")) ? new Response(null, { headers: { "content-length": "25" } }) : new Response(null, { status: 404 });
        if (method === "POST" && url.searchParams.has("uploads")) return new Response("<InitiateMultipartUploadResult><UploadId>U1</UploadId></InitiateMultipartUploadResult>");
        if (method === "PUT") {
          parts.set(Number(url.searchParams.get("partNumber")), new Uint8Array(await new Response(init.body).arrayBuffer()));
          return new Response(null, { headers: { etag: `"e${url.searchParams.get("partNumber")}"` } });
        }
        if (method === "POST" && url.searchParams.get("uploadId") === "U1") {
          calls.push("POST complete");
          return new Response("<CompleteMultipartUploadResult><ETag>\"all\"</ETag></CompleteMultipartUploadResult>");
        }
      }
      if (url.pathname === "/api/mutation") {
        registered = JSON.parse(String(init.body));
        return Response.json({ status: "success", value: null });
      }
      return new Response("unexpected", { status: 500 });
    });
    const env = { GOOGLE_DRIVE_CLIENT_ID: "c", GOOGLE_DRIVE_CLIENT_SECRET: "s", GOOGLE_DOCS_REFRESH_TOKEN: "r", R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "x", R2_BUCKET: "b", CONVEX_URL: "https://convex.test", CONVEX_SERVICE_TOKEN: "svc" };
    const steps: string[] = [];
    const step = { do: async (name: string, config: unknown, work?: () => Promise<unknown>) => { steps.push(name); return (work ?? (config as () => Promise<unknown>))(); } };
    // The runtime constructs it with (ctx, env); its base class is the runtime's.
    const Job = DriveToR2 as unknown as new (ctx: unknown, env: unknown) => InstanceType<typeof DriveToR2>;
    const job = new Job({}, env);
    const done = await job.run({ payload: { file: "FILEabcdefgh", key: "edit/originals/drive/FILEabcdefgh/a.mp4", name: "a.mp4", size: 25, version: "v1", part: 10 } }, step as never);
    expect(done).toEqual({ key: "edit/originals/drive/FILEabcdefgh/a.mp4", size: 25, name: "a.mp4" });
    expect(steps).toEqual(["check the file", "look for a finished copy", "start the upload", "part 1 of 3", "part 2 of 3", "part 3 of 3", "verify the source version", "finish the upload", "register"]);
    expect([...parts.keys()].sort()).toEqual([1, 2, 3]);
    expect(Array.from(parts.get(3)!)).toEqual([20, 21, 22, 23, 24]);
    expect(registered).toMatchObject({ path: "edit:putMedia", args: { source: "drive:FILEabcdefgh", originalKey: "edit/originals/drive/FILEabcdefgh/a.mp4", size: 25, originalReady: true, token: "svc" } });
  });
});

describe("relay cloud: Google sign-in and the AI Gateway", () => {
  const env = { CLOUD_TOKEN: "cloud-secret", GOOGLE_DRIVE_CLIENT_ID: "c", GOOGLE_DRIVE_CLIENT_SECRET: "s", GOOGLE_DOCS_REFRESH_TOKEN: "r", AI_GATEWAY_API_KEY: "gw-key" } as Env;
  const post = (route: string, body: string, token = "", given: Env = env) =>
    relay.fetch(new Request(`https://relay.test/v1/cloud/${route}`, { method: "POST", headers: { authorization: `Bearer ${token || PERSON}`, "content-type": "application/json", "content-length": String(body.length) }, body }), given);
  afterEach(() => { vi.unstubAllGlobals(); });

  it("hands Edit a short-lived Google access token, only to a signed-in person", async () => {
    const upstream = vi.fn(async () => Response.json({ access_token: "ya29.x", expires_in: 3599 }));
    vi.stubGlobal("fetch", upstream);
    expect((await post("google/token", "{}", "wrong")).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
    const answer = await post("google/token", "{}");
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ access_token: "ya29.x", expires_in: 3599 });
    expect((await post("google/token", "{}", "", { ...env, GOOGLE_DOCS_REFRESH_TOKEN: undefined })).status).toBe(502);
  });

  it("passes a chat completion through with the relay's key and returns the gateway's answer as it is", async () => {
    let sent: { url: string; auth: string | null; body: string } | null = null;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
      sent = { url: String(input), auth: new Headers(init.headers).get("authorization"), body: await new Response(init.body).text() };
      return Response.json({ error: { message: "slow down" } }, { status: 429 });
    });
    const asked = '{"model":"google/gemini-3.8-flash"}';
    expect((await post("ai/chat", asked, "wrong")).status).toBe(401);
    expect(sent).toBeNull();
    const answer = await post("ai/chat", asked);
    expect(answer.status).toBe(429);
    expect(await answer.json()).toEqual({ error: { message: "slow down" } });
    // The body as sent, with the answer's length bounded (the audit, Oct 23).
    expect(sent).toEqual({ url: "https://ai-gateway.vercel.sh/v1/chat/completions", auth: "Bearer gw-key", body: '{"model":"google/gemini-3.8-flash","max_tokens":32768}' });
    expect((await post("ai/chat", "{}", "", { ...env, AI_GATEWAY_API_KEY: undefined })).status).toBe(503);
  });

  it("asks the gateway only for Edit's models, never streaming, within a burst limit and the day's budget counted from its usage.cost", async () => {
    // The audit, Oct 23: any model, any body, no limit.
    const spent: number[] = [];
    let allowance = true;
    const budget = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          const asked = (await request.json()) as { phase: string; cost: number };
          if (asked.phase === "spend") spent.push(asked.cost);
          return asked.phase === "check" && !allowance ? Response.json({ error: { message: "used up" } }, { status: 429 }) : Response.json({ ok: true });
        },
      }),
    };
    let burst = true;
    const limited = { ...env, BUDGET: budget, BURST: { limit: async () => ({ success: burst }) } } as unknown as Env;
    const upstream = vi.fn(async () => Response.json({ choices: [], usage: { cost: 0.0123 } }));
    vi.stubGlobal("fetch", upstream);
    expect((await post("ai/chat", '{"model":"openai/gpt-7"}', undefined, limited)).status).toBe(403);
    expect((await post("ai/chat", '{"model":"google/gemini-3.8-flash","stream":true}', undefined, limited)).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    expect((await post("ai/chat", '{"model":"google/gemini-3.8-flash"}', undefined, limited)).status).toBe(200);
    expect(spent).toEqual([0.0123]);
    allowance = false;
    expect((await post("ai/chat", '{"model":"google/gemini-3.8-flash"}', undefined, limited)).status).toBe(429);
    allowance = true;
    burst = false;
    expect((await post("ai/chat", '{"model":"google/gemini-3.8-flash"}', undefined, limited)).status).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

describe("relay transcription", () => {
  const env = {
    ELEVENLABS_MAIN_KEY: "xi-key", MAX_UPLOAD_BYTES: "1000", DAILY_BYTES_PER_IP: "1000", DAILY_BYTES_TOTAL: "1000",
    BURST: { limit: async () => ({ success: true }) },
    TRANSCRIBE_BURST: { limit: async () => ({ success: true }) },
    BUDGET: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response("{}") }) },
  } as unknown as Env;
  const transcribe = (query: string, given: Env = env, token: string | null = "") =>
    relay.fetch(new Request(`https://relay.test/v1/transcribe${query}`, { method: "POST", headers: { "content-type": "audio/ogg", "content-length": "4", ...(token === null ? {} : { authorization: `Bearer ${token || PERSON}` }) }, body: "OggS" }), given);
  afterEach(() => { vi.unstubAllGlobals(); });

  it("needs a signed-in person's token; the retired shared one is told to update", async () => {
    vi.stubGlobal("FixedLengthStream", class extends TransformStream<Uint8Array, Uint8Array> { constructor(_length: number) { super(); } });
    vi.stubGlobal("fetch", async () => Response.json({ words: [] }));
    expect((await transcribe("", env, null)).status).toBe(401);
    const old = await transcribe("", { ...env, CLOUD_TOKEN: "cloud-secret" } as Env, "cloud-secret");
    expect([old.status, (await old.text()).includes("out of date")]).toEqual([401, true]);
    expect((await transcribe("", env)).status).toBe(200);
  });

  it("uses main for transcription ahead of the legacy key", async () => {
    vi.stubGlobal("FixedLengthStream", class extends TransformStream<Uint8Array, Uint8Array> { constructor(_length: number) { super(); } });
    let key: string | null = null;
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      key = new Headers(init.headers).get("xi-api-key");
      await new Response(init.body).text();
      return Response.json({ words: [] });
    });
    expect((await transcribe("", { ...env, ELEVENLABS_MAIN_KEY: "main-key" })).status).toBe(200);
    expect(key).toBe("main-key");
  });

  // The interrogation's "John Ruetten" was heard as "John Rutten" and "John Bruton" without them.
  it("tells Scribe the case's names to listen for, each its own keyterms field", async () => {
    vi.stubGlobal("FixedLengthStream", class extends TransformStream<Uint8Array, Uint8Array> { constructor(_length: number) { super(); } });
    let sent = "";
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init: RequestInit = {}) => {
      sent = await new Response(init.body).text();
      return Response.json({ words: [] });
    });
    expect((await transcribe("?keyterm=John%20Ruetten&keyterm=Sherri%20Rasmussen")).status).toBe(200);
    const fields = [...sent.matchAll(/name="keyterms"\r\n\r\n([^\r]*)\r\n/g)].map((match) => match[1]);
    expect(fields).toEqual(["John Ruetten", "Sherri Rasmussen"]);
    expect(sent).toContain('name="model_id"');
    expect(sent).toContain("OggS");
    expect((await transcribe("?keyterm=%7Bbad%7D")).status).toBe(400);
    expect((await transcribe(`?keyterm=${"a".repeat(50)}`)).status).toBe(400);
  });
});


describe("relay ElevenLabs accounts", () => {
  const house = "gUABw7pXQjhjt0kNFBTF";
  const extra = "NewVoice1234";
  const env = {
    ELEVENLABS_MAIN_KEY: "main-key", ELEVENLABS_VOICES_KEY: "voices-key",
    ELEVENLABS_VOICES_IDS: ` ${extra}, `,
    MAX_SPEECH_CHARS: "5000", DAILY_SPEECH_CHARS_PER_IP: "50000", DAILY_SPEECH_CHARS_TOTAL: "150000",
    SPEECH_BURST: { limit: async () => ({ success: true }) },
    BUDGET: { idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json({}) }) },
  } as unknown as Env;
  const speak = (voice: string, given = env) => relay.fetch(new Request("https://relay.test/v1/speech", {
    method: "POST", headers: { authorization: `Bearer ${EDITOR}`, "content-type": "application/json" },
    body: JSON.stringify({ voice_id: voice, text: "Hello." }),
  }), given);
  afterEach(() => vi.unstubAllGlobals());

  it("routes the house voice to main and configured voice IDs to voices", async () => {
    const keys: string[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      keys.push(new Headers(init.headers).get("xi-api-key")!);
      return new Response("audio");
    });
    expect((await speak(house)).status).toBe(200);
    expect((await speak(extra)).status).toBe(200);
    expect(keys).toEqual(["main-key", "voices-key"]);
    expect((await speak(house, { ...env, ELEVENLABS_MAIN_KEY: undefined })).status).toBe(503);
    expect((await speak(extra, { ...env, ELEVENLABS_VOICES_KEY: undefined })).status).toBe(503);
    expect(keys).toHaveLength(2);
  });

  it("lists both accounts with the same routing, pagination and no duplicate IDs", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
      const key = new Headers(init.headers).get("xi-api-key")!;
      calls.push(key);
      if (key === "main-key") return Response.json({ voices: [{ voice_id: house, name: "House" }, { voice_id: extra, name: "Wrong account" }] });
      if (!url.searchParams.has("next_page_token")) return Response.json({ voices: [{ voice_id: house, name: "Duplicate house" }], has_more: true, next_page_token: "next" });
      return Response.json({ voices: [{ voice_id: extra, name: "New" }, { voice_id: extra, name: "Duplicate new" }, { voice_id: "Unconfigured", name: "Other" }] });
    });
    const answer = await relay.fetch(new Request("https://relay.test/v1/voices", { headers: { authorization: `Bearer ${EDITOR}` } }), env);
    expect(answer.status).toBe(200);
    const body = await answer.json() as { voices: { voice_id: string; name: string }[] };
    expect(body.voices.map(voice => [voice.voice_id, voice.name])).toEqual([[house, "House"], [extra, "New"]]);
    expect(calls).toEqual(["main-key", "voices-key", "voices-key"]);
  });
});
