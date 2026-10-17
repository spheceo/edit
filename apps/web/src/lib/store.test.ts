import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "./types";

const api = vi.hoisted(() => ({ saveProject: vi.fn(), project: vi.fn() }));
vi.mock("./api", () => ({ api, ApiError: class extends Error { status = 409; body: unknown; }, useConnection: { setState: vi.fn() } }));
vi.mock("./agent", () => ({ applyAgentEvent: vi.fn(), openAgent: vi.fn() }));
const project = (id: string): Project => ({ version: 1, id, name: id, style: "bodycam", next_id: 1, settings: { width: 320, height: 180, fps: 30 }, clips: [], media: [], tracks: [] });

describe("save isolation", () => {
  beforeEach(() => {
    vi.resetModules(); vi.useFakeTimers();
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it("does not apply an old project's response after navigation", async () => {
    const { useEditor, flushSave } = await import("./store");
    let finish!: (value: { rev: number }) => void;
    api.saveProject.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    useEditor.getState().load(1, project("p1"));
    useEditor.getState().edit(draft => { draft.name = "changed"; });
    const saving = flushSave();
    useEditor.getState().close(); useEditor.getState().load(1, project("p2"));
    useEditor.getState().edit(draft => { draft.name = "second edit"; });
    finish({ rev: 99 }); await saving;
    expect(useEditor.getState().project?.id).toBe("p2");
    expect(useEditor.getState().project?.name).toBe("second edit");
    expect(useEditor.getState().rev).toBe(1);
    expect(useEditor.getState().dirty).toBe(true);
  });

  it("keeps edits made during a conflicting save recoverable with undo", async () => {
    const { useEditor, flushSave } = await import("./store");
    const { ApiError } = await import("./api");
    let fail!: (error: Error) => void;
    api.saveProject.mockReturnValue(new Promise((_, reject) => { fail = reject; }));
    useEditor.getState().load(1, project("p1"));
    useEditor.getState().edit(draft => { draft.name = "first edit"; });
    const saving = flushSave();
    useEditor.getState().edit(draft => { draft.name = "latest edit"; });
    fail(Object.assign(new ApiError("conflict", 409, null), { body: { rev: 2, project: project("p1") } }));
    await saving;
    expect(useEditor.getState().rev).toBe(2);
    useEditor.getState().undo();
    expect(useEditor.getState().project?.name).toBe("latest edit");
    expect(useEditor.getState().dirty).toBe(true);
  });
});
