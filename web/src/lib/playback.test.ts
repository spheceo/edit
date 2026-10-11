import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "./types";

const engine = vi.hoisted(() => ({
  free: vi.fn(), addFont: vi.fn(), setProject: vi.fn(), forgetVideo: vi.fn(),
  resize: vi.fn(), render: vi.fn(), uploadFrame: vi.fn(), isLost: vi.fn(() => false), sections: vi.fn(() => "null"), setPeaks: vi.fn(), clearPeaks: vi.fn(),
  sources: vi.fn(() => "[]"),
}));
vi.mock("../engine/pkg/edit_wasm", () => ({ default: vi.fn(), createEngine: vi.fn(async () => engine) }));
vi.mock("./api", () => ({ fetchRetrying: vi.fn(async () => new Response(new Uint8Array())), mediaUrl: (p: string, m: string) => `/${p}/${m}` }));

class Video extends EventTarget {
  preload = "metadata"; playsInline = true; muted = true; crossOrigin = "";
  src = ""; playbackRate = 1; volume = 0; duration = 10;
  readyState = 4; paused = true; ended = false; seeking = false;
  private time = 0;
  private callbacks = new Map<number, VideoFrameRequestCallback>();
  private next = 0;
  get currentTime() { return this.time; }
  set currentTime(value: number) { this.time = value; this.seeking = true; }
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
  removeAttribute() { this.src = ""; }
  load() {}
  requestVideoFrameCallback(callback: VideoFrameRequestCallback) { const id = ++this.next; this.callbacks.set(id, callback); return id; }
  cancelVideoFrameCallback(id: number) { this.callbacks.delete(id); }
  present(time = this.time) {
    const callbacks = [...this.callbacks.values()]; this.callbacks.clear();
    for (const callback of callbacks) callback(0, { mediaTime: time } as VideoFrameCallbackMetadata);
  }
  settle() { this.seeking = false; this.present(); this.dispatchEvent(new Event("seeked")); }
}

const fixture = (id = "p1"): Project => ({
  version: 1, id, name: "Test", next_id: 3, settings: { width: 320, height: 180, fps: 30 },
  tracks: [{ id: "v1", kind: "video", hidden: false, muted: false, locked: false }],
  media: [{ id: "m1", name: "Video", path: "/video.mp4", kind: "video", duration: 10, width: 320, height: 180, fps: 30, has_audio: false }],
  clips: [{ id: "c1", track: "v1", start: 0, duration: 90, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m1", source_in: 2, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 }],
});

describe("preview seeks and lifetime", () => {
  let videos: Video[];
  let frames: Map<number, FrameRequestCallback>;
  let storage: Map<string, string>;
  let preview: typeof import("./playback").preview;
  let playhead: typeof import("./playback").playhead;
  const draw = () => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(performance.now()); };

  beforeEach(async () => {
    vi.resetModules(); vi.clearAllMocks(); videos = []; frames = new Map(); storage = new Map();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible", createElement: () => { const video = new Video(); videos.push(video); return video; } });
    vi.stubGlobal("document", doc); vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("navigator", { gpu: {} }); vi.stubGlobal("location", { hostname: "localhost", protocol: "http:" });
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    let next = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { const id = ++next; frames.set(id, callback); return id; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.stubGlobal("VideoFrame", class { close() {} });
    ({ preview, playhead } = await import("./playback"));
    engine.sources.mockReturnValue(JSON.stringify([{ media: "m1", time: 2 }]));
    await preview.attach({ width: 320, height: 180 } as HTMLCanvasElement);
  });
  afterEach(() => { preview.detach(); vi.unstubAllGlobals(); });

  it("restores each project's playhead and checkpoints before leaving", () => {
    preview.setProject(fixture(), {}); preview.seek(42);
    preview.setProject(fixture("p2"), {}); expect(playhead.frame).toBe(0);
    preview.seek(75); preview.setProject(fixture(), {}); expect(playhead.frame).toBe(42);
    playhead.frame = 48.4; window.dispatchEvent(new Event("pagehide"));
    expect(storage.get("edit.playhead.p1")).toBe("48");
    expect(storage.get("edit.playhead.p2")).toBe("75");
  });

  it("holds the displayed scene until the latest scrub has decoded", () => {
    preview.setProject(fixture(), {}); draw();
    expect(engine.uploadFrame).not.toHaveBeenCalled(); expect(engine.render).not.toHaveBeenCalled();
    preview.seek(15); engine.sources.mockReturnValue(JSON.stringify([{ media: "m1", time: 2.5 }])); draw();
    videos[0].settle(); // finishes the old seek and starts the queued one
    draw(); expect(engine.uploadFrame).not.toHaveBeenCalled();
    videos[0].settle(); draw();
    expect(videos[0].currentTime).toBeCloseTo(2.5 + 0.5 / 30);
    expect(engine.uploadFrame).toHaveBeenCalledOnce(); expect(engine.render).toHaveBeenCalledWith(15);
  });

  it("does not upload or composite the same decoded picture twice", () => {
    preview.setProject(fixture(), {}); draw(); videos[0].settle(); draw();
    const uploads = engine.uploadFrame.mock.calls.length;
    const renders = engine.render.mock.calls.length;
    preview.invalidate(); draw();
    expect(engine.uploadFrame).toHaveBeenCalledTimes(uploads); expect(engine.render).toHaveBeenCalledTimes(renders);
  });

  it("clears an in-progress seek when the proxy replaces the source", () => {
    preview.setProject(fixture(), {}); draw();
    expect(videos[0].seeking).toBe(true);
    preview.setProject(fixture(), { m1: "proxy" }); videos[0].settle(); draw();
    if (videos[0].seeking) { videos[0].settle(); draw(); }
    expect(engine.uploadFrame).toHaveBeenCalled();
  });

  it("ignores invalid saved positions and works when storage is blocked", () => {
    storage.set("edit.playhead.p1", "Infinity"); preview.setProject(fixture(), {}); expect(playhead.frame).toBe(0);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } });
    expect(() => preview.seek(30)).not.toThrow();
    preview.seek(NaN); expect(playhead.frame).toBe(30);
  });

  it("keeps the last valid preview during a transient invalid drag", () => {
    preview.setProject(fixture(), {});
    const calls = engine.setProject.mock.calls.length;
    const p = fixture(); p.clips.push({ ...p.clips[0], id: "overlap" });
    preview.setProject(p, {});
    expect(engine.setProject).toHaveBeenCalledTimes(calls);
    expect(preview.error).toBeNull();
    preview.setProject(fixture(), {});
    expect(engine.setProject).toHaveBeenCalledTimes(calls + 1);
  });

  it("keeps scrubbing responsive after playback reaches the end", () => {
    vi.stubGlobal("AudioContext", class { resume() { return Promise.resolve(); } });
    const p = fixture(); p.clips = []; // wall-clock graphics, with a short edit
    p.clips.push({ id: "solid", type: "solid", track: "v1", start: 0, duration: 2, color: "blue", fill: [1, 0, 0, 1], opacity: 1, fade_in: 0, fade_out: 0 });
    engine.sources.mockReturnValue("[]"); preview.setProject(p, {}); draw(); preview.play();
    const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(performance.now() + 1000);
    expect(playhead.playing).toBe(false);
    draw(); engine.render.mockClear(); preview.seek(0); draw();
    expect(engine.render).toHaveBeenCalledWith(0);
  });
});
