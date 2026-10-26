import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchRetrying = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ fetchRetrying }));

describe("Claude recovery in the open conversation", () => {
  let ready: boolean;
  let resumed: boolean;
  const user = { id: "old-user", kind: "user", text: "Research this case" };
  const error = { id: "old-error", kind: "error", text: "Failed to authenticate. API Error: 401 OAuth access token is invalid" };
  const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

  beforeEach(() => {
    vi.resetModules();
    fetchRetrying.mockReset();
    ready = true;
    resumed = false;
    fetchRetrying.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/agent") return response({ ready, provider: "claude" });
      if (url === "/api/agent/models") return response({ models: [] });
      if (url === "/api/agent/claude") return response({ phase: ready ? "ready" : "checking", checkedAt: ready ? 100 : null, checks: [] });
      if (url === "/api/projects/p1/agent/retry-claude") {
        expect(JSON.parse(String(init?.body))).toEqual({ user: "old-user" });
        resumed = true;
        return response({ ok: true, resumed: true });
      }
      if (url === "/api/projects/p1/agent") return response({
        entries: [user, resumed ? { ...error, status: "done", text: "Claude sign-in restored. Continuing your message." } : error],
        running: resumed,
        auth_retry: ready && !resumed ? "old-user" : null,
      });
      throw new Error(`Unexpected request: ${url}`);
    });
  });

  it("adopts a pre-update authentication failure once and refreshes the resolved chat", async () => {
    const { openAgent, useAgent } = await import("./agent");
    await openAgent("p1");
    await openAgent("p1");
    expect(fetchRetrying.mock.calls.filter(([url]) => url.endsWith("retry-claude"))).toHaveLength(1);
    expect(useAgent.getState().entries.filter((entry) => entry.kind === "user")).toHaveLength(1);
    expect(useAgent.getState().entries.at(-1)).toMatchObject({ status: "done" });
    expect(useAgent.getState().running).toBe(true);
  });

  it("waits for successful verification before retrying the open conversation", async () => {
    const { openAgent, refreshClaudeSupport, useAgent } = await import("./agent");
    ready = false;
    await openAgent("p1");
    expect(resumed).toBe(false);
    ready = true;
    await refreshClaudeSupport();
    expect(resumed).toBe(true);
    expect(useAgent.getState().running).toBe(true);
  });

  it("does not loop when the server no longer considers the message retryable", async () => {
    const respond = fetchRetrying.getMockImplementation()!;
    fetchRetrying.mockImplementation((url: string, init?: RequestInit) => url.endsWith("retry-claude") ? Promise.resolve(response({ ok: true, resumed: false })) : respond(url, init));
    const { openAgent } = await import("./agent");
    await openAgent("p1");
    expect(fetchRetrying.mock.calls.filter(([url]) => url.endsWith("retry-claude"))).toHaveLength(1);
    expect(resumed).toBe(false);
  });
});
