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

describe("the chat's live events", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  it("applies a burst of streamed words as one store update", async () => {
    const { applyAgentEvent, flushAgentEvents, useAgent } = await import("./agent");
    useAgent.setState({ project: "p1", loaded: true, running: true, entries: [{ id: "a", kind: "assistant", text: "" }, { id: "b", kind: "tool", text: "Read", status: "done" }] });
    const tool = useAgent.getState().entries[1];
    let updates = 0;
    const off = useAgent.subscribe(() => updates++);
    for (let index = 0; index < 200; index++) applyAgentEvent({ project: "p1", event: "delta", id: "a", text: `${index} ` });
    applyAgentEvent({ project: "other", event: "delta", id: "a", text: "not this chat" });
    applyAgentEvent({ project: "p1", event: "status", running: false });
    expect(updates).toBe(0);
    flushAgentEvents();
    off();
    expect(updates).toBe(1);
    const state = useAgent.getState();
    expect(state.entries[0]!.text.endsWith("198 199 ")).toBe(true);
    expect(state.entries[1]).toBe(tool);
    expect(state.running).toBe(false);
  });

  it("goes on its own within a frame, or a tenth of a second where frames stop (a hidden tab)", async () => {
    const { applyAgentEvent, useAgent } = await import("./agent");
    useAgent.setState({ project: "p1", loaded: true, running: true, entries: [] });
    applyAgentEvent({ project: "p1", event: "status", running: false });
    await vi.advanceTimersByTimeAsync(100);
    expect(useAgent.getState().running).toBe(false);
  });

  it("shows a message as it's sent until the chat has it, and keeps it with why when it's refused", async () => {
    const { sendToAgent, applyAgentEvent, flushAgentEvents, useAgent } = await import("./agent");
    const { sending } = await import("./sentNow");
    fetchRetrying.mockReset();
    let refuse = false;
    fetchRetrying.mockImplementation(async () => (refuse ? new Response(JSON.stringify({ error: "the agent is still working" }), { status: 409 }) : new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } })));
    useAgent.setState({ project: "p1", loaded: true, running: false, entries: [] });
    await sendToAgent("make it shorter");
    expect(sending("p1", useAgent.getState().entries)).toBe(true);
    expect(useAgent.getState().running).toBe(true);
    applyAgentEvent({ project: "p1", event: "entry", entry: { id: "user-1", kind: "user", text: "make it shorter", at: Date.now() } });
    flushAgentEvents();
    expect(sending("p1", useAgent.getState().entries)).toBe(false);
    refuse = true;
    await sendToAgent("and louder");
    expect(sending("p1", useAgent.getState().entries)).toBe(false);
    expect(useAgent.getState().entries.map((entry) => [entry.kind, entry.text])).toEqual([["user", "make it shorter"], ["user", "and louder"], ["error", "the agent is still working"]]);
    expect(useAgent.getState().running).toBe(false);
  });
});

describe("a Bodycam HQ chat's queue, kept on the server", () => {
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const waiting = { id: "queued-1", text: "make it red", at: 1, playhead: 120 };

  beforeEach(() => {
    vi.resetModules();
    fetchRetrying.mockReset();
  });

  it("a message sent while the turn runs shows in the queue, not the conversation, and the turn goes on", async () => {
    const { sendToAgent, useAgent } = await import("./agent");
    const { sending } = await import("./sentNow");
    fetchRetrying.mockImplementation(async () => response({ ok: true, queued: waiting }));
    useAgent.setState({ project: "p1", loaded: true, running: true, entries: [{ id: "u", kind: "user", text: "make the board" }], queue: [] });
    await sendToAgent("make it red", 120, [], true);
    expect(JSON.parse(String(fetchRetrying.mock.calls[0]![1]!.body))).toEqual({ text: "make it red", playhead: "120" });
    expect(sending("p1", useAgent.getState().entries)).toBe(false);
    expect(useAgent.getState().entries.map((entry) => entry.text)).toEqual(["make the board"]);
    expect(useAgent.getState().queue).toEqual([waiting]);
    expect(useAgent.getState().running).toBe(true);
  });

  it("follows the server's queue events, and a new chat clears it", async () => {
    const { applyAgentEvent, flushAgentEvents, useAgent } = await import("./agent");
    useAgent.setState({ project: "p1", loaded: true, running: true, entries: [], queue: [] });
    applyAgentEvent({ project: "p1", event: "queue", queue: [waiting] });
    applyAgentEvent({ project: "other", event: "queue", queue: [] });
    flushAgentEvents();
    expect(useAgent.getState().queue).toEqual([waiting]);
    applyAgentEvent({ project: "p1", event: "reset" });
    flushAgentEvents();
    expect(useAgent.getState().queue).toEqual([]);
  });

  it("cancel and steer take the message out at once and ask the server", async () => {
    const { cancelQueued, steerQueued, useAgent } = await import("./agent");
    fetchRetrying.mockImplementation(async () => response({ ok: true }));
    const second = { ...waiting, id: "queued-2", text: "then a stamp" };
    useAgent.setState({ project: "p1", loaded: true, running: true, entries: [], queue: [waiting, second] });
    await cancelQueued("queued-1");
    expect(fetchRetrying.mock.calls.at(-1)).toEqual(["/api/projects/p1/agent/queue/queued-1/cancel", { method: "POST" }]);
    expect(useAgent.getState().queue).toEqual([second]);
    await steerQueued("queued-2");
    expect(fetchRetrying.mock.calls.at(-1)).toEqual(["/api/projects/p1/agent/queue/queued-2/steer", { method: "POST" }]);
    expect(useAgent.getState().queue).toEqual([]);
  });

  it("a refused steer says why and reads the chat again", async () => {
    const { steerQueued, useAgent } = await import("./agent");
    fetchRetrying.mockImplementation(async (url: string) => {
      if (url.endsWith("/steer")) return response({ error: "that message isn't queued any more" }, 400);
      if (url === "/api/agent") return response({ ready: true, provider: "claude" });
      if (url === "/api/agent/models") return response({ models: [] });
      return response({ entries: [], running: true, queue: [] });
    });
    useAgent.setState({ project: "p1", loaded: true, running: true, entries: [], queue: [waiting] });
    await expect(steerQueued("queued-1")).rejects.toThrow("that message isn't queued any more");
    expect(fetchRetrying.mock.calls.some(([url]) => url === "/api/projects/p1/agent")).toBe(true);
  });
});
