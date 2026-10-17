import { afterEach, describe, expect, it, vi } from "vitest";
import { presign, validKey, validPrefix } from "../../../relay/src/cloud";
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
