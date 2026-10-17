import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "./types";

const api = vi.hoisted(() => ({ saveProject: vi.fn(() => new Promise(() => {})), project: vi.fn() }));
vi.mock("./api", () => ({ api, ApiError: class extends Error {}, useConnection: { setState: vi.fn() } }));
vi.mock("./agent", () => ({ applyAgentEvent: vi.fn(), openAgent: vi.fn() }));
const project: Project = { version: 1, id: "p", name: "p", next_id: 1, settings: { width: 320, height: 180, fps: 30 }, clips: [], media: [], tracks: [] };

describe("in and out points", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("are undoable edits of the project", async () => {
    const { useEditor } = await import("./store");
    const { clearInOut, markIn, markOut, pointsOf } = await import("./inOut");
    const points = () => pointsOf(useEditor.getState().project);
    useEditor.getState().load(1, project);
    markIn(30);
    markOut(89);
    expect(points()).toEqual({ in: 30, out: 89 });
    clearInOut();
    expect(points()).toEqual({ in: null, out: null });
    useEditor.getState().undo();
    expect(points()).toEqual({ in: 30, out: 89 });
    useEditor.getState().undo();
    expect(points()).toEqual({ in: 30, out: null });
    useEditor.getState().redo();
    expect(points()).toEqual({ in: 30, out: 89 });
    // Marking the same frame again isn't another undo step.
    const steps = useEditor.getState().past.length;
    markOut(89);
    expect(useEditor.getState().past.length).toBe(steps);
  });

  it("drop the other point when they'd cross, and make a span", async () => {
    const { inOutSpan, setIn, setOut } = await import("./inOut");
    const draft: Project = { ...project };
    setIn(draft, 120);
    setOut(draft, 10);
    expect([draft.mark_in, draft.mark_out]).toEqual([undefined, 10]);
    expect(inOutSpan(300, { in: null, out: 10 })).toEqual([0, 11]);
    expect(inOutSpan(300, { in: 30, out: null })).toEqual([30, 300]);
    expect(inOutSpan(300, { in: null, out: null })).toBeNull();
  });
});

describe("changes the server makes for us", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("are one undo step each, even when the live event bumped rev first", async () => {
    const { useEditor } = await import("./store");
    useEditor.getState().load(1, project);
    const imported: Project = { ...project, media: [{ id: "m1", name: "a.mp4", path: "/a.mp4", kind: "video", duration: 5, width: 0, height: 0, fps: 0, has_audio: true }] };
    useEditor.setState({ rev: 2 }); // our own event, ahead of the response
    useEditor.getState().adopt(2, imported);
    expect(useEditor.getState().project?.media.length).toBe(1);
    useEditor.getState().adopt(2, structuredClone(imported)); // the same change again: nothing new
    expect(useEditor.getState().past.length).toBe(1);
    useEditor.getState().undo();
    expect(useEditor.getState().project?.media.length).toBe(0);
  });
});
