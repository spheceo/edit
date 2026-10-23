import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportJobs, exportRoute, validateManifest } from "../../../relay/src/exports";
import type { CloudEnv } from "../../../relay/src/cloud";
import { WORKER_INPUT_LIMIT } from "@edit/types/worker";

const digest = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), b => b.toString(16).padStart(2, "0")).join("");

function fixture(budget = "10") {
  const values = new Map<string, unknown>();
  const objects = new Map<string, string>();
  const calls: Record<string, unknown>[] = [];
  let serial = Promise.resolve();
  type Context = ConstructorParameters<typeof ExportJobs>[0];
  const ctx: Context = {
    storage: {
      get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
      put: async (key, value) => { values.set(key, structuredClone(value)); },
      list: async <T>({ prefix }: { prefix: string }) => new Map([...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value) as T])),
      delete: async key => values.delete(key), setAlarm: async () => {},
    },
    blockConcurrencyWhile: <T>(work: () => Promise<T>) => {
      const result = serial.then(work);
      serial = result.then(() => {}, () => {});
      return result;
    },
  };
  const env: CloudEnv = { CLOUD_TOKEN: "client", MODAL_WORKER_TOKEN: "worker", MODAL_EXPORT_URL: "https://edit-test.modal.run", MODAL_RENDER_VERSION: "build1", MODAL_DAILY_BUDGET_USD: budget,
    R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "bucket" };
  const coordinator = new ExportJobs(ctx, env);
  const post = (route: string, body: unknown, instance = coordinator) => instance.fetch(new Request(`https://jobs/${route}`, { method: "POST", body: JSON.stringify(body) }));
  vi.stubGlobal("fetch", async (input: string | Request | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.hostname.endsWith("modal.run")) {
      calls.push(JSON.parse(String(init.body)));
      return Response.json({ call: "fc-1" });
    }
    const key = decodeURIComponent(url.pathname.slice("/bucket/".length));
    if (init.method === "HEAD") return objects.has(key) ? new Response(null, { headers: { "content-length": String(objects.get(key)!.length) } }) : new Response(null, { status: 404 });
    if (init.method === "POST" && url.searchParams.has("uploads")) return new Response("<UploadId>upload1</UploadId>");
    if (init.method === "POST" && url.searchParams.has("uploadId")) { objects.set(key, "1234567890"); return new Response("<CompleteMultipartUploadResult/>"); }
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return objects.has(key) ? new Response(objects.get(key)) : new Response(null, { status: 404 });
  });
  const submit = async (name: string, request?: string) => {
    const text = JSON.stringify({ version: 1, project: { id: "p", name, media: [] }, options: { format: "h264" }, assets: [] });
    const hash = await digest(text);
    const key = `edit/exports/manifests/${hash}.json`;
    objects.set(key, text);
    return post("start", { manifest: key, digest: hash, request });
  };
  return { values, objects, calls, ctx, env, coordinator, post, submit };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("durable cloud export admission", () => {
  it("restarts never retry paid failures; a new user request can retry once and is reusable", async () => {
    const f = fixture();
    const first = await (await f.submit("one", "request-one")).json();
    await f.coordinator.alarm();
    const worker = f.calls[0]!;
    await f.post("worker/claim", worker);
    await f.post("worker/fail", { ...worker, error: "transient failure" });
    expect(await (await f.submit("one", "request-one")).json()).toMatchObject({ id: first.id, status: "failed" });
    const retry = await (await f.submit("one", "request-two")).json();
    expect(retry.id).not.toBe(first.id);
    expect(await (await f.submit("one", "request-two")).json()).toMatchObject({ id: retry.id });
    expect(await (await f.submit("one", "request-three")).json()).toMatchObject({ id: retry.id });
    await f.coordinator.alarm();
    expect(f.calls).toHaveLength(2);
    expect([...f.values.keys()].filter(key => key.startsWith("job:"))).toHaveLength(2);
  });

  it("deduplicates concurrent submissions, persists state and dispatches only three", async () => {
    const f = fixture();
    const repeats = await Promise.all([f.submit("one"), f.submit("one")]);
    const ids = await Promise.all(repeats.map(r => r.json()));
    expect(ids[0].id).toBe(ids[1].id);
    await f.submit("two"); await f.submit("three"); await f.submit("four");
    expect([...f.values.keys()].filter(key => key.startsWith("job:"))).toHaveLength(4);
    await f.coordinator.alarm();
    expect(f.calls).toHaveLength(3);
    const job = f.calls[0]!;
    expect((await f.post("worker/claim", job)).status).toBe(200);
    expect((await f.post("worker/claim", job)).status).toBe(409);
    const restarted = new ExportJobs(f.ctx, f.env);
    expect(await (await f.post("status", { id: job.id }, restarted)).json()).toMatchObject({ status: "running" });
    await f.post("cancel", { id: job.id });
    await restarted.alarm();
    expect(f.calls).toHaveLength(3); // Cancellation holds its slot until stopped.
    expect((await f.post("worker/heartbeat", job)).status).toBe(409);
    expect(await (await f.post("worker/fail", { ...job, error: "cancelled" })).json()).toMatchObject({ status: "cancelled" });
    await restarted.alarm();
    expect(f.calls).toHaveLength(4);
  });

  it("enforces daily reservations, fails closed, and does not reserve twice", async () => {
    const f = fixture("0.67");
    expect((await f.submit("one")).status).toBe(200);
    expect((await f.submit("one")).status).toBe(200);
    expect((await f.submit("two")).status).toBe(429);
    f.env.MODAL_DAILY_BUDGET_USD = "0";
    expect((await f.submit("three")).status).toBe(503);
    expect([...f.values.entries()].filter(([key]) => key.startsWith("budget:"))[0]?.[1]).toBe(0.67);
  });

  it("reserves the full RTX PRO 6000 allocation and dispatches that GPU", async () => {
    const f = fixture("2.01");
    f.env.MODAL_GPU = "RTX-PRO-6000";
    expect(await (await f.submit("one")).json()).toMatchObject({ gpu: "RTX-PRO-6000", reservedUsd: 2.01 });
    expect((await f.submit("two")).status).toBe(429);
    await f.coordinator.alarm();
    expect(f.calls[0]).toMatchObject({ gpu: "RTX-PRO-6000" });
  });

  it("fences expired and wrong-version workers, without automatic paid retry", async () => {
    const f = fixture();
    await f.submit("one"); await f.coordinator.alarm();
    const job = f.calls[0]!;
    expect((await f.post("worker/claim", { ...job, permit: "wrong" })).status).toBe(409);
    expect((await f.post("worker/claim", { ...job, build: "old" })).status).toBe(409);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 40 * 60_000);
    await f.coordinator.alarm();
    expect((await f.post("worker/claim", job)).status).toBe(409);
    expect(await (await f.post("status", { id: job.id })).json()).toMatchObject({ status: "failed" });
    await f.submit("one"); await f.coordinator.alarm();
    expect(f.calls).toHaveLength(1);
  });

  it("publishes only an exact-size complete upload; completion can be repeated", async () => {
    const f = fixture();
    await f.submit("one"); await f.coordinator.alarm();
    const job = f.calls[0]!;
    await f.post("worker/claim", job);
    expect((await f.post("worker/complete", { ...job, parts: [] })).status).toBe(400);
    const upload = await (await f.post("worker/upload", { ...job, bytes: 10, first: 1 })).json();
    expect(upload.urls[0].url).toContain(`edit/exports/results/${job.id}.mp4`);
    const complete = { ...job, parts: [{ number: 1, etag: '"part"' }] };
    expect(await (await f.post("worker/complete", complete)).json()).toMatchObject({ status: "done", output: { size: 10 } });
    expect(await (await f.post("worker/complete", complete)).json()).toMatchObject({ status: "done" });
    expect((await f.post("worker/heartbeat", job)).status).toBe(409);
  });

  it("keeps worker credentials out of the general cloud API and limits inputs", async () => {
    const f = fixture();
    const request = new Request("https://relay/v1/cloud/exports/worker/claim", { method: "POST", headers: { authorization: "Bearer client" }, body: "{}" });
    expect((await exportRoute(request, new URL(request.url), f.env)).status).toBe(401);
    expect(() => validateManifest({ version: 1, project: {}, options: { format: "h264" }, assets: [{ media: "m", key: "repack/private", size: 1, etag: "x" }] })).toThrow();
    expect(() => validateManifest({ version: 1, project: {}, options: { format: "h264" }, assets: [{ media: "m", key: "edit/a", size: WORKER_INPUT_LIMIT + 1, etag: "x" }] })).toThrow();
  });
});

describe("who may cancel a cloud export", () => {
  it("only who started it, or an admin; one started before starters were kept, anyone", async () => {
    const f = fixture();
    const text = JSON.stringify({ version: 1, project: { id: "p", name: "mine", media: [] }, options: { format: "h264" }, assets: [] });
    const hash = await digest(text);
    f.objects.set(`edit/exports/manifests/${hash}.json`, text);
    const job = await (await f.post("start", { manifest: `edit/exports/manifests/${hash}.json`, digest: hash, caller: { sub: "a", admin: false } })).json() as { id: string };
    expect((await f.post("cancel", { id: job.id, caller: { sub: "b", admin: false } })).status).toBe(403);
    expect((await f.post("cancel", { id: job.id, caller: null })).status).toBe(403);
    expect((await f.post("cancel", { id: job.id, caller: { sub: "admin", admin: true } })).status).toBe(200);
    expect((await f.post("cancel", { id: job.id, caller: { sub: "a", admin: false } })).status).toBe(200);
    const older = await (await f.submit("older")).json() as { id: string };
    expect((await f.post("cancel", { id: older.id, caller: { sub: "b", admin: false } })).status).toBe(200);
  });
});
