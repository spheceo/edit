import { afterEach, describe, expect, it, vi } from "vitest";
import { presign, validKey, validPrefix, writerReadable } from "../../../relay/src/cloud";
import relay, { TranscriptionBudget, type Env } from "../../../relay/src/index";

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
    const token = options.token === undefined ? "cloud-secret" : options.token;
    if (token !== null) headers.authorization = `Bearer ${token}`;
    const method = options.method ?? "POST";
    return relay.fetch(new Request(`https://relay.test/v1/cloud/${route}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body) }), options.env ?? env);
  };
  afterEach(() => { vi.unstubAllGlobals(); });

  it("refuses every request without the right cloud token, and with no token configured at all", async () => {
    const upstream = vi.fn(); vi.stubGlobal("fetch", upstream);
    const body = { key: "edit/a.mp4", method: "GET" };
    expect((await call("r2/url", body, { token: null })).status).toBe(401);
    expect((await call("r2/url", body, { token: "wrong" })).status).toBe(401);
    expect((await call("r2/url", body, { env: { ...env, CLOUD_TOKEN: undefined } })).status).toBe(401);
    expect((await call("r2/url", body, { token: "", env: { ...env, CLOUD_TOKEN: "" } })).status).toBe(401);
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
    const [, init] = upstream.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).args.app).toBe("edit");
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
    expect(get.searchParams.get("X-Amz-Expires")).toBe(String(6 * 3600));
    expect(get.searchParams.get("X-Amz-Credential")).toMatch(/^AKID\/\d{8}\/auto\/s3\/aws4_request$/);
    expect(get.href).not.toContain("SECRET");
    expect((await answer({ key: "edit/a", method: "PUT" })).searchParams.get("X-Amz-Expires")).toBe("3600");
    expect((await answer({ key: "edit/a", expires: 30 * 86400 })).searchParams.get("X-Amz-Expires")).toBe(String(7 * 86400));
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
    expect((await call("convex", { kind: "query", path: "edit:get", args: [1] })).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();

    const answer = await call("convex", { kind: "mutation", path: "edit:save", args: { project: "p1", token: "forged" } });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ status: "success", value: { id: 1 } });
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe("https://example.convex.cloud/api/mutation");
    expect(JSON.parse(String(init.body))).toEqual({ path: "edit:save", args: { project: "p1", token: "service-token" }, format: "json" });
  });

  it("passes Convex's errors on", async () => {
    // A function's error (or no such function): Convex's own shape, as 200.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "error", errorMessage: "Server Error\nCould not find public function for 'edit:nope'.\n" })));
    const missing = await call("convex", { kind: "query", path: "edit:nope" });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ status: "error", errorMessage: "Server Error\nCould not find public function for 'edit:nope'." });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "error", errorMessage: "Uncaught Error: no", errorData: { why: 1 } }, { status: 560 })));
    expect(await (await call("convex", { kind: "action", path: "edit:run" })).json()).toEqual({ status: "error", errorMessage: "Uncaught Error: no", errorData: { why: 1 } });
    // A request Convex refused: a relay error with Convex's status.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "BadJsonBody", message: "nope" }, { status: 400 })));
    const refused = await call("convex", { kind: "query", path: "edit:get" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "Convex: BadJsonBody: nope" });
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
  const post = (route: string, body: string, token = "cloud-secret", given: Env = env) =>
    relay.fetch(new Request(`https://relay.test/v1/cloud/${route}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(body.length) }, body }), given);
  afterEach(() => { vi.unstubAllGlobals(); });

  it("hands Edit a short-lived Google access token, only with the cloud token", async () => {
    const upstream = vi.fn(async () => Response.json({ access_token: "ya29.x", expires_in: 3599 }));
    vi.stubGlobal("fetch", upstream);
    expect((await post("google/token", "{}", "wrong")).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
    const answer = await post("google/token", "{}");
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ access_token: "ya29.x", expires_in: 3599 });
    expect((await post("google/token", "{}", "cloud-secret", { ...env, GOOGLE_DOCS_REFRESH_TOKEN: undefined })).status).toBe(502);
  });

  it("passes a chat completion through with the relay's key and returns the gateway's answer as it is", async () => {
    let sent: { url: string; auth: string | null; body: string } | null = null;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
      sent = { url: String(input), auth: new Headers(init.headers).get("authorization"), body: await new Response(init.body).text() };
      return Response.json({ error: { message: "slow down" } }, { status: 429 });
    });
    expect((await post("ai/chat", '{"model":"m"}', "wrong")).status).toBe(401);
    expect(sent).toBeNull();
    const answer = await post("ai/chat", '{"model":"m"}');
    expect(answer.status).toBe(429);
    expect(await answer.json()).toEqual({ error: { message: "slow down" } });
    expect(sent).toEqual({ url: "https://ai-gateway.vercel.sh/v1/chat/completions", auth: "Bearer gw-key", body: '{"model":"m"}' });
    expect((await post("ai/chat", "{}", "cloud-secret", { ...env, AI_GATEWAY_API_KEY: undefined })).status).toBe(503);
  });
});

describe("relay transcription", () => {
  const env = {
    ELEVENLABS_API_KEY: "xi-key", MAX_UPLOAD_BYTES: "1000", DAILY_BYTES_PER_IP: "1000", DAILY_BYTES_TOTAL: "1000",
    BURST: { limit: async () => ({ success: true }) },
    TRANSCRIBE_BURST: { limit: async () => ({ success: true }) },
    BUDGET: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response("{}") }) },
  } as unknown as Env;
  const transcribe = (query: string, given: Env = env, token: string | null = null) =>
    relay.fetch(new Request(`https://relay.test/v1/transcribe${query}`, { method: "POST", headers: { "content-type": "audio/ogg", "content-length": "4", ...(token === null ? {} : { authorization: `Bearer ${token}` }) }, body: "OggS" }), given);
  afterEach(() => { vi.unstubAllGlobals(); });

  it("needs the cloud token (every release has it) once the relay has one", async () => {
    vi.stubGlobal("FixedLengthStream", class extends TransformStream<Uint8Array, Uint8Array> { constructor(_length: number) { super(); } });
    vi.stubGlobal("fetch", async () => Response.json({ words: [] }));
    const locked = { ...env, CLOUD_TOKEN: "cloud-secret" } as Env;
    expect((await transcribe("", locked)).status).toBe(401);
    expect((await transcribe("", locked, "wrong")).status).toBe(401);
    expect((await transcribe("", locked, "cloud-secret")).status).toBe(200);
    expect((await transcribe("", { ...locked, CLIENT_TOKEN: "client" } as Env, "client")).status).toBe(200);
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
