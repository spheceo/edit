import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRetrying, mediaHostFor, mediaUrl } from "./api";

describe("media host", () => {
  it("reads media from the other loopback name, so media and API get separate connection pools", () => {
    expect(mediaHostFor("/api/projects/p/media/m/proxy", "127.0.0.1", "7700")).toBe("http://localhost:7700/api/projects/p/media/m/proxy");
    expect(mediaHostFor("/api/projects/p/media/m/proxy", "localhost", "7700")).toBe("http://127.0.0.1:7700/api/projects/p/media/m/proxy");
    expect(mediaHostFor("/api/projects/p/media/m/proxy", "::1", "7700")).toBe("http://127.0.0.1:7700/api/projects/p/media/m/proxy");
    // Off this Mac (Tailscale), or the Vite dev UI (proxied, no cross-origin answers): same host as the page.
    expect(mediaHostFor("/api/projects/p/media/m/proxy", "kenobi.tailnet.ts.net", "7700")).toBe("/api/projects/p/media/m/proxy");
    expect(mediaHostFor("/api/projects/p/media/m/proxy", "127.0.0.1", "5173")).toBe("/api/projects/p/media/m/proxy");
    expect(mediaHostFor("/api/projects/p/media/m/proxy", "127.0.0.1", "")).toBe("/api/projects/p/media/m/proxy");
    // No page (tests, workers without a location): untouched, and mediaUrl with it.
    expect(mediaUrl("p", "m", "proxy")).toBe("/api/projects/p/media/m/proxy");
  });
});

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
