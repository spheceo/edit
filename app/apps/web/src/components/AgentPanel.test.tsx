// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/playback", () => ({ playhead: { frame: 0 } }));
vi.mock("../lib/upload", () => ({ projectUploader: () => async () => ({}) }));

// happy-dom's Web Animations reject when cancelled; motion animates by itself without them.
delete (Element.prototype as { animate?: unknown }).animate;

const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

/** A chat a few turns long, the last one live with an answer streaming in. */
function chat(turns: number) {
  const entries = [];
  let at = 1_000;
  for (let turn = 0; turn < turns; turn++) {
    entries.push({ id: `u${turn}`, kind: "user", text: `Change ${turn}`, at, updated: at });
    entries.push({ id: `t${turn}`, kind: "tool", tool: "update_clip", text: "Updated a clip", status: "done", at: at + 1, updated: at + 2 });
    entries.push({ id: `a${turn}`, kind: "assistant", text: `Done ${turn}.`, at: at + 3, updated: at + 4 });
    at += 10;
  }
  entries[entries.length - 1] = { id: "live", kind: "assistant", text: "", at, updated: at };
  return entries;
}

describe("the editor's chat as a turn ends", () => {
  let root: Root;
  const errors: unknown[] = [];

  beforeEach(() => {
    vi.resetModules();
    errors.length = 0;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/api/agent") return response({ ready: true, provider: "claude" });
      if (url === "/api/agent/models") return response({ models: [] });
      if (url.endsWith("/agent")) return new Promise(() => {}); // the chat as the page already has it
      return response({});
    });
  });
  afterEach(() => {
    act(() => root?.unmount());
    vi.unstubAllGlobals();
  });

  it("takes a backlog of streamed words and the turn's end without React giving up (#185)", async () => {
    const { useAgent, applyAgentEvent } = await import("../lib/agent");
    const { useEditor } = await import("../lib/store");
    const { AgentPanel } = await import("./AgentPanel");
    useEditor.setState({ project: { id: "p1", clips: [], media: [], tracks: [] } as never });
    useAgent.setState({ project: "p1", loaded: true, running: true, entries: chat(12) as never, status: { ready: true }, activityAt: Date.now() - 5_000 });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container, { onUncaughtError: (error) => errors.push(error) });
    act(() => root.render(<AgentPanel />));
    // Let the older turns' "quiet" timers settle, as they have by a turn's end.
    await new Promise((done) => setTimeout(done, 600));
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    // A websocket backlog: each message its own task, all queued before React's own work gets a turn.
    const events = [
      ...Array.from({ length: 80 }, (_, index) => ({ project: "p1", event: "delta", id: "live", text: `word${index} ` })),
      { project: "p1", event: "entry", entry: { id: "live", kind: "assistant", text: "", at: 2_000, updated: 2_100 } },
      { project: "p1", event: "status", running: false },
    ];
    await new Promise<void>((done) => {
      events.forEach((event, index) =>
        setImmediate(() => {
          try {
            applyAgentEvent(event);
          } catch (error) {
            errors.push(error);
          }
          if (index === events.length - 1) setTimeout(done, 50);
        }),
      );
    });
    await new Promise((done) => setTimeout(done, 100));
    expect(errors.map(String)).toEqual([]);
    expect(container.textContent).toContain("word79");
    expect(useAgent.getState().running).toBe(false);
  });
});
