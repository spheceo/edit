import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRetrying } from "./api";

describe("request retries", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it("does not replay a mutation after losing its response", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("connection reset")); vi.stubGlobal("fetch", fetch);
    await expect(fetchRetrying("/api/projects", { method: "POST", body: "{}" })).rejects.toThrow("connection reset");
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("retries a read after the server restarts", async () => {
    vi.useFakeTimers();
    const response = new Response("ok");
    const fetch = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(response); vi.stubGlobal("fetch", fetch);
    const request = fetchRetrying("/api/health"); await vi.advanceTimersByTimeAsync(250);
    expect(await request).toBe(response); expect(fetch).toHaveBeenCalledTimes(2);
  });
});
