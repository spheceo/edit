import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "./types";

const api = vi.hoisted(() => ({ saveProject: vi.fn(), saveChanges: vi.fn(), project: vi.fn(), mediaStatus: vi.fn(), scriptJob: vi.fn() }));
vi.mock("./api", () => ({ api, ApiError: class extends Error { status = 409; body: unknown; }, useConnection: { setState: vi.fn() } }));
vi.mock("./agent", () => ({ applyAgentEvent: vi.fn(), openAgent: vi.fn() }));
// This browser's copy of unsaved edits (unsaved.ts), as a map; `failing` is storage that's full or blocked.
const unsaved = vi.hoisted(() => {
  const kept = new Map<string, unknown>();
  const state = { failing: false };
  return {
    kept, state,
    keepUnsaved: vi.fn(async (entry: { id: string }) => { if (state.failing) throw new Error("quota"); kept.set(entry.id, structuredClone(entry)); return true; }),
    readUnsaved: vi.fn(async (id: string) => kept.get(id) ?? null),
    forgetUnsaved: vi.fn(async (id: string) => { kept.delete(id); }),
  };
});
vi.mock("./unsaved", () => ({ keepUnsaved: unsaved.keepUnsaved, readUnsaved: unsaved.readUnsaved, forgetUnsaved: unsaved.forgetUnsaved }));
const project = (id: string): Project => ({ version: 1, id, name: id, style: "bodycam", next_id: 1, settings: { width: 320, height: 180, fps: 30 }, clips: [], media: [], tracks: [] });

describe("save isolation", () => {
  beforeEach(() => {
    vi.resetModules(); vi.useFakeTimers();
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
    // A save sends what changed; these tests answer it as they would a whole one.
    api.saveChanges.mockImplementation((...args: unknown[]) => api.saveProject(...args));
    unsaved.kept.clear(); unsaved.state.failing = false;
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

  it("ignores undo and redo mid-drag, so the drag stays one step and redo survives", async () => {
    const { useEditor } = await import("./store");
    const name = () => useEditor.getState().project?.name;
    const state = useEditor.getState;
    state().load(1, project("p1"));
    state().edit(draft => { draft.name = "first"; });
    state().edit(draft => { draft.name = "second"; });
    state().undo();
    expect(name()).toBe("first");
    state().beginGesture();
    state().gesture(draft => { draft.name = "dragging"; });
    state().undo(); state().redo();
    expect(name()).toBe("dragging");
    expect(state().future).toHaveLength(1);
    state().gesture(draft => { draft.name = "dragged"; });
    state().endGesture();
    expect(name()).toBe("dragged");
    state().undo(); expect(name()).toBe("first");
    state().undo(); expect(name()).toBe("p1");
    state().redo(); state().redo(); expect(name()).toBe("dragged");
  });

  it("keeps edits made during a conflicting save on top of the latest version", async () => {
    const { useEditor, flushSave } = await import("./store");
    const { ApiError } = await import("./api");
    let fail!: (error: Error) => void;
    api.saveProject.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
    api.saveProject.mockResolvedValue({ rev: 3 });
    useEditor.getState().load(1, project("p1"));
    useEditor.getState().edit(draft => { draft.name = "first edit"; });
    const saving = flushSave();
    useEditor.getState().edit(draft => { draft.name = "latest edit"; });
    // Someone else added a track meanwhile.
    const theirs = { ...project("p1"), tracks: [{ id: "v9", kind: "video" }] } as Project;
    fail(Object.assign(new ApiError("conflict", 409, null), { body: { rev: 2, project: theirs } }));
    await saving;
    expect(useEditor.getState().rev).toBe(2);
    expect(useEditor.getState().project?.name).toBe("latest edit");
    expect(useEditor.getState().project?.tracks.map(track => track.id)).toEqual(["v9"]);
    expect(useEditor.getState().dirty).toBe(true);
  });

  it("leaving saves an edit queued behind a save under way before it closes", async () => {
    const { useEditor, flushSave, leave, settled } = await import("./store");
    let finish!: (value: { rev: number }) => void;
    api.saveProject.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    api.saveProject.mockResolvedValue({ rev: 3 });
    useEditor.getState().load(1, project("p1"));
    useEditor.getState().edit(draft => { draft.name = "first"; });
    void flushSave();
    useEditor.getState().edit(draft => { draft.name = "second"; });
    const left = leave();
    // Still open until it's saved.
    expect(useEditor.getState().project?.name).toBe("second");
    finish({ rev: 2 });
    await left;
    await settled();
    expect(api.saveProject).toHaveBeenCalledTimes(2);
    expect(api.saveProject.mock.calls[1]![1]).toBe(2);
    expect(useEditor.getState().project).toBeNull();
  });

  it("leaving mid-drag saves the drag", async () => {
    const { useEditor, leave } = await import("./store");
    api.saveProject.mockResolvedValue({ rev: 2 });
    useEditor.getState().load(1, project("p1"));
    useEditor.getState().beginGesture();
    useEditor.getState().gesture(draft => { draft.name = "dragged"; });
    await leave();
    expect(api.saveProject).toHaveBeenCalledTimes(1);
    expect((api.saveProject.mock.calls[0]![2] as { set: { name: string } }).set.name).toBe("dragged");
  });

  it("an import's answer keeps an edit made while it ran", async () => {
    const { useEditor } = await import("./store");
    useEditor.getState().load(1, project("p1"));
    useEditor.getState().edit(draft => { draft.name = "renamed"; });
    const media = { id: "m1", name: "a.wav", path: "/a.wav", kind: "audio", duration: 1, width: 0, height: 0, fps: 0, has_audio: true };
    useEditor.getState().adopt(2, { ...project("p1"), media: [media] } as Project);
    expect(useEditor.getState().project?.name).toBe("renamed");
    expect(useEditor.getState().project?.media.map(item => item.id)).toEqual(["m1"]);
    expect(useEditor.getState().rev).toBe(2);
    expect(useEditor.getState().dirty).toBe(true);
    // Undo goes back to before the import.
    useEditor.getState().undo();
    expect(useEditor.getState().project?.media).toEqual([]);
  });

  it("saves only what changed since the server's version, and takes changes as patches", async () => {
    const { useEditor, flushSave, connectEvents } = await import("./store");
    api.saveProject.mockResolvedValue({ rev: 2 });
    useEditor.getState().load(1, project("p1"));
    useEditor.getState().edit(draft => { draft.name = "renamed"; });
    await flushSave();
    expect(api.saveChanges).toHaveBeenLastCalledWith("p1", 1, { set: { name: "renamed" }, unset: [], lists: {} }, expect.any(String));
    // Another client's change, as a patch against rev 2.
    const sockets: { onmessage?: (message: { data: string }) => void }[] = [];
    vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
    vi.stubGlobal("WebSocket", class { static OPEN = 1; readyState = 0; constructor() { sockets.push(this as never); } });
    connectEvents();
    const clip = { id: "c1", track: "t", type: "text", text: "hi", start: 0, duration: 10, source_in: 0 };
    sockets[0]!.onmessage!({ data: JSON.stringify({ type: "project", id: "p1", rev: 3, base_rev: 2, origin: "other", patch: { set: {}, unset: [], lists: { clips: { put: [clip], remove: [] } } } }) });
    expect(useEditor.getState().rev).toBe(3);
    expect(useEditor.getState().project?.clips).toEqual([clip]);
    expect(useEditor.getState().project?.name).toBe("renamed");
    // One that doesn't follow on from ours fetches the project whole.
    api.project.mockResolvedValue({ rev: 9, project: { ...project("p1"), name: "fetched" } });
    api.mediaStatus.mockResolvedValue({ media: {} });
    api.scriptJob.mockResolvedValue({ job: null });
    sockets[0]!.onmessage!({ data: JSON.stringify({ type: "project", id: "p1", rev: 9, base_rev: 8, origin: "other", patch: { set: { name: "x" }, unset: [], lists: {} } }) });
    await vi.waitFor(() => expect(useEditor.getState().project?.name).toBe("fetched"));
  });

  it("leaving offline keeps the edits on this browser and puts them back when the project opens", async () => {
    const { useEditor, leave } = await import("./store");
    api.saveProject.mockRejectedValue(new Error("Failed to fetch"));
    useEditor.getState().load(4, project("p1"));
    useEditor.getState().edit(draft => { draft.name = "offline edit"; });
    await leave();
    expect(useEditor.getState().project).toBeNull();
    expect(unsaved.kept.get("p1")).toMatchObject({ id: "p1", base_rev: 4, patch: { set: { name: "offline edit" } } });
    expect(useEditor.getState().toasts.at(-1)?.text).toMatch(/kept on this computer/);
    // Back online: the same version opens, the edit comes back, saves and is forgotten here.
    api.saveProject.mockReset(); api.saveProject.mockResolvedValue({ rev: 5 });
    useEditor.getState().load(4, project("p1"));
    await vi.waitFor(() => expect(useEditor.getState().project?.name).toBe("offline edit"));
    await vi.advanceTimersByTimeAsync(10);
    expect(api.saveProject).toHaveBeenCalledWith("p1", 4, expect.objectContaining({ set: { name: "offline edit" } }), expect.any(String));
    expect(useEditor.getState().dirty).toBe(false);
    await vi.waitFor(() => expect(unsaved.kept.has("p1")).toBe(false));
    // One undo step takes it back off.
    useEditor.getState().undo();
    expect(useEditor.getState().project?.name).toBe("p1");
  });

  it("kept edits go on top of a version that moved on since", async () => {
    const { useEditor } = await import("./store");
    api.saveProject.mockResolvedValue({ rev: 8 });
    unsaved.kept.set("p1", { id: "p1", base_rev: 4, patch: { set: { name: "offline edit" }, unset: [], lists: {} }, at: 0 });
    const theirs = { ...project("p1"), tracks: [{ id: "v9", kind: "video" }] } as Project;
    useEditor.getState().load(7, theirs);
    await vi.waitFor(() => expect(useEditor.getState().project?.name).toBe("offline edit"));
    expect(useEditor.getState().project?.tracks.map(track => track.id)).toEqual(["v9"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(api.saveProject).toHaveBeenCalledWith("p1", 7, expect.objectContaining({ set: { name: "offline edit" } }), expect.any(String));
    await vi.waitFor(() => expect(unsaved.kept.has("p1")).toBe(false));
  });

  it("kept edits that no longer fit stay kept and are said", async () => {
    const { useEditor } = await import("./store");
    // A clip on a track that's gone from the latest version.
    const clip = { id: "c1", track: "gone", type: "text", text: "hi", start: 0, duration: 10, source_in: 0 };
    unsaved.kept.set("p1", { id: "p1", base_rev: 4, patch: { set: {}, unset: [], lists: { clips: { put: [clip], remove: [] } } }, at: 0 });
    useEditor.getState().load(7, project("p1"));
    await vi.waitFor(() => expect(useEditor.getState().toasts.at(-1)?.text).toMatch(/don't fit/));
    expect(useEditor.getState().project?.clips).toEqual([]);
    expect(useEditor.getState().dirty).toBe(false);
    expect(unsaved.kept.has("p1")).toBe(true);
  });

  it("storage that fails still says the changes weren't saved, and leaving doesn't throw", async () => {
    const { useEditor, leave } = await import("./store");
    unsaved.state.failing = true;
    api.saveProject.mockRejectedValue(new Error("Failed to fetch"));
    useEditor.getState().load(4, project("p1"));
    useEditor.getState().edit(draft => { draft.name = "offline edit"; });
    await expect(leave()).resolves.toBeUndefined();
    expect(useEditor.getState().project).toBeNull();
    expect(useEditor.getState().toasts.at(-1)?.text).toBe("Your last changes couldn't be saved.");
  });

  it("an edit refused because another Mac holds the lock is kept and one undo away", async () => {
    const { useEditor, flushSave } = await import("./store");
    const { ApiError } = await import("./api");
    api.saveProject.mockRejectedValue(Object.assign(new ApiError("JJ is editing this project.", 423, null), { status: 423 }));
    api.project.mockResolvedValue({ rev: 6, project: { ...project("p1"), name: "theirs" } });
    useEditor.getState().load(4, project("p1"));
    useEditor.getState().edit(draft => { draft.name = "mine"; });
    await flushSave();
    expect(useEditor.getState().project?.name).toBe("theirs");
    expect(useEditor.getState().dirty).toBe(false);
    await vi.waitFor(() => expect(unsaved.kept.get("p1")).toMatchObject({ base_rev: 4, patch: { set: { name: "mine" } } }));
    useEditor.getState().undo();
    expect(useEditor.getState().project?.name).toBe("mine");
  });

  // Nov 8 audit (2b): the edit on screen won item by item over an agent's change
  // to the same clip, and Undo after a change from elsewhere saved the whole old
  // project over it.
  it("a hand edit meeting the agent's change to the same clip gives way, is kept on this browser, and Undo leaves the agent's change", async () => {
    const { useEditor, connectEvents } = await import("./store");
    const sockets: { onmessage?: (message: { data: string }) => void }[] = [];
    vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
    vi.stubGlobal("WebSocket", class { static OPEN = 1; readyState = 0; constructor() { sockets.push(this as never); } });
    api.saveProject.mockResolvedValue({ rev: 2 });
    const clip = (id: string, start: number) => ({ id, track: "t", type: "text", text: id, start, duration: 10, source_in: 0, fade_in: 0, fade_out: 0 });
    const base = { ...project("p1"), tracks: [{ id: "t", kind: "video" }], clips: [clip("a", 0), clip("b", 20)] } as unknown as Project;
    useEditor.getState().load(1, base);
    connectEvents();
    // Two hand edits, not saved yet: the name, then clip a moved.
    useEditor.getState().edit(draft => { draft.name = "renamed"; });
    useEditor.getState().edit(draft => { draft.clips[0]!.start = 5; });
    // The agent moves clip a too, and adds clip c.
    const theirs = { ...base, clips: [clip("a", 50), clip("b", 20), clip("c", 70)] } as unknown as Project;
    sockets[0]!.onmessage!({ data: JSON.stringify({ type: "project", id: "p1", rev: 2, origin: "agent", project: theirs }) });
    const now = useEditor.getState().project!;
    // The agent's clip a is kept; the hand edit to something else stays on top.
    expect(now.clips.map((one) => [one.id, one.start])).toEqual([["a", 50], ["b", 20], ["c", 70]]);
    expect(now.name).toBe("renamed");
    // The clashing edit is kept on this browser, offered back, never put back by itself.
    await vi.waitFor(() => expect(unsaved.kept.get("p1")).toMatchObject({ collided: true, patch: { lists: { clips: { put: [{ id: "a", start: 5 }] } } } }));
    expect(useEditor.getState().toasts.at(-1)?.action?.label).toBe("Use mine");
    // Undo steps back through this page's edits only: the rename goes, the agent's changes stay.
    useEditor.getState().undo();
    expect(useEditor.getState().project?.name).toBe("p1");
    expect(useEditor.getState().project?.clips.map((one) => [one.id, one.start])).toEqual([["a", 50], ["b", 20], ["c", 70]]);
    // Use mine puts the hand edit back on top, as one undo step.
    useEditor.getState().toasts.at(-1)!.action!.run();
    await vi.waitFor(() => expect(useEditor.getState().project?.clips[0]?.start).toBe(5));
  });
});
