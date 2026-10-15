import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "./types";

const engine = vi.hoisted(() => ({
  free: vi.fn(), addFont: vi.fn(), setProject: vi.fn(), forgetVideo: vi.fn(),
  resize: vi.fn(), render: vi.fn(), uploadFrame: vi.fn(), isLost: vi.fn(() => false), sections: vi.fn(() => "null"), setPeaks: vi.fn(), clearPeaks: vi.fn(),
  sources: vi.fn((_frame: number) => "[]"),
}));
vi.mock("../engine/pkg/edit_wasm", () => ({ default: vi.fn(), createEngine: vi.fn(async () => engine) }));
vi.mock("./api", () => ({ fetchRetrying: vi.fn(async () => new Response(new Uint8Array())), mediaUrl: (p: string, m: string) => `/${p}/${m}` }));

const decoding = vi.hoisted(() => ({
  frames: new Map<string, object>(), sound: new Map<number, object>(), near: undefined as object | undefined,
  requestVideo: vi.fn(), requestRough: vi.fn(), requestAudio: vi.fn(), requestImage: vi.fn(), forget: vi.fn(), dispose: vi.fn(),
}));
vi.mock("./decoder", async (original) => {
  const actual = await original<typeof import("./decoder")>();
  return { ...actual, Decoder: class {
    stats = {}; pictures = { bytes: 0, size: 0 }; sound = { bytes: 0 };
    picture(key: string, time: number) { return decoding.frames.get(`${key}:${time.toFixed(6)}`); }
    pcm(_key: string, chunk: number) { return decoding.sound.get(chunk); }
    requestVideo = decoding.requestVideo;
    requestRough = decoding.requestRough;
    requestAudio = decoding.requestAudio;
    requestImage = decoding.requestImage;
    forget = decoding.forget;
    nearbyPicture() { return decoding.near; }
    retain() {}
    dispose() { decoding.dispose(); decoding.frames.clear(); }
  } };
});

class AudioClock {
  currentTime = 0;
  state = "running";
  destination = {};
  nodes: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];
  resume() { return Promise.resolve(); }
  createBuffer(channels: number, length: number, sampleRate: number) {
    return { numberOfChannels: channels, length, sampleRate, copyToChannel: vi.fn() };
  }
  createGain() {
    return { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      connect: () => ({ connect: vi.fn() }), disconnect: vi.fn() };
  }
  createBufferSource() {
    const node = { buffer: null, playbackRate: { value: 1 }, start: vi.fn(), stop: vi.fn(),
      connect: () => ({ connect: vi.fn() }), disconnect: vi.fn(), onended: null };
    this.nodes.push(node);
    return node;
  }
}

const fixture = (id = "p1"): Project => ({
  version: 1, id, name: "Test", next_id: 3, settings: { width: 320, height: 180, fps: 30 },
  tracks: [{ id: "v1", kind: "video", hidden: false, muted: false, locked: false }],
  media: [{ id: "m1", name: "Video", path: "/video.mp4", kind: "video", duration: 10, width: 320, height: 180, fps: 30, has_audio: false }],
  clips: [{ id: "c1", track: "v1", start: 0, duration: 90, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m1", source_in: 2, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 }],
});

describe("preview seeks and lifetime", () => {
  let clock: AudioClock;
  let frames: Map<number, FrameRequestCallback>;
  let storage: Map<string, string>;
  let preview: typeof import("./playback").preview;
  let playhead: typeof import("./playback").playhead;
  const draw = () => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(performance.now()); };

  beforeEach(async () => {
    vi.resetModules(); vi.clearAllMocks(); decoding.near = undefined; decoding.frames.clear(); decoding.sound.clear(); frames = new Map(); storage = new Map(); clock = new AudioClock();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("document", doc); vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("navigator", { gpu: {} }); vi.stubGlobal("location", { hostname: "localhost", protocol: "http:" });
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    let next = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { const id = ++next; frames.set(id, callback); return id; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.stubGlobal("AudioContext", class { constructor() { return clock; } });
    ({ preview, playhead } = await import("./playback"));
    engine.sources.mockImplementation((frame = 0) => JSON.stringify(frame < 90 ? [{ clip: "c1", media: "m1", time: 2 + frame / 30 }] : []));
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

  const complete = async (frame: number, version = "source") => {
    const { videoTime } = await import("./decoder");
    const time = videoTime(2 + frame / 30, 30, 10);
    decoding.frames.set(`/p1/m1?v=${version}:${time.toFixed(6)}`, { frame });
    preview.invalidate(); draw();
  };

  it("shows completed scrub scenes while the newest seek is still decoding, then lands exactly", async () => {
    preview.setProject(fixture(), {}); draw();
    expect(engine.render).not.toHaveBeenCalled();
    preview.seek(15); draw();
    await complete(0);
    expect(engine.render).toHaveBeenLastCalledWith(0);
    expect(playhead.frame).toBe(15);
    await complete(15);
    expect(engine.render).toHaveBeenLastCalledWith(15);
  });

  it("does not jump back to older completed requests during a continuous drag", async () => {
    preview.setProject(fixture(), {}); draw();
    preview.seek(10); draw(); preview.seek(20); draw(); preview.seek(30); draw();
    await complete(20);
    expect(engine.render).toHaveBeenLastCalledWith(20);
    const renders = engine.render.mock.calls.length;
    await complete(10);
    expect(engine.render).toHaveBeenCalledTimes(renders);
    await complete(30);
    expect(engine.render).toHaveBeenLastCalledWith(30);
  });

  it("mid-drag asks for keyframes and shows the nearest one at the wanted frame, then the exact frame once it rests", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      preview.setProject(fixture(), {}); draw();
      preview.seek(10); draw();
      // A single seek (a click) asks for its exact frame straight away.
      expect(decoding.requestRough).not.toHaveBeenCalled();
      preview.seek(20); draw();
      expect(decoding.requestRough).toHaveBeenCalled();
      const exact = decoding.requestVideo.mock.calls.length;
      decoding.near = { keyframe: true };
      preview.invalidate(); draw();
      expect(engine.render).toHaveBeenLastCalledWith(20);
      vi.advanceTimersByTime(300); draw();
      expect(decoding.requestVideo.mock.calls.length).toBeGreaterThan(exact);
    } finally { vi.useRealTimers(); }
  });

  it("does not upload or composite the same cached picture twice", async () => {
    preview.setProject(fixture(), {}); draw(); await complete(0);
    const uploads = engine.uploadFrame.mock.calls.length;
    const renders = engine.render.mock.calls.length;
    preview.invalidate(); draw();
    expect(engine.uploadFrame).toHaveBeenCalledTimes(uploads);
    expect(engine.render).toHaveBeenCalledTimes(renders);
  });

  it("invalidates the source cache when its proxy becomes available", async () => {
    preview.setProject(fixture(), {}); draw();
    preview.setProject(fixture(), { m1: "proxy" }); draw();
    expect(decoding.forget).toHaveBeenCalledWith("/p1/m1?v=source");
    await complete(0, "source"); expect(engine.render).not.toHaveBeenCalled();
    await complete(0, "proxy"); expect(engine.render).toHaveBeenCalledWith(0);
  });

  it("prefetches separate moments of the same source before a cut", () => {
    const p = fixture(); const first = p.clips[0];
    if (first.type !== "video") throw new Error("fixture");
    first.duration = 15;
    p.clips.push({ ...first, id: "c2", start: 15, source_in: 8 });
    preview.setProject(p, {}); draw(); preview.play(); draw();
    expect(decoding.requestVideo.mock.calls.map((call) => call[2])).toEqual(["v:c1", "v:c1", "v:c2"]);
    expect(decoding.requestVideo.mock.calls[2][3]).toBeCloseTo(8);
  });

  it("runs picture and sound on the audio clock, and stops scheduled sound on a seek", () => {
    const p = fixture(); p.media[0].has_audio = true;
    p.tracks.push({ id: "a1", kind: "audio", hidden: false, muted: false, locked: false });
    p.clips.push({ id: "a", type: "audio", track: "a1", media: "m1", start: 0, duration: 90,
      source_in: 2, speed: 0.5, volume_db: -6, fade_in: 3, fade_out: 3, color: "blue" });
    engine.sources.mockReturnValue("[]");
    for (let chunk = 4; chunk < 8; chunk++) decoding.sound.set(chunk,
      { start: chunk * 0.5, sampleRate: 48000, channels: [new Float32Array(24000)] });
    preview.setProject(p, {}); draw(); preview.play(); draw();
    expect(clock.nodes.length).toBeGreaterThan(0);
    const nodes = [...clock.nodes];
    clock.currentTime = 0.55; draw();
    expect(playhead.frame).toBeCloseTo(15);
    preview.seek(30);
    expect(nodes.every((node) => node.stop.mock.calls.length === 1)).toBe(true);
    expect(playhead.frame).toBe(30);
    preview.pause();
    expect(playhead.playing).toBe(false);
  });

  it("does not stop or replay audio when a video frame is late", async () => {
    const p = fixture(); p.media[0].has_audio = true;
    p.tracks.push({ id: "a1", kind: "audio", hidden: false, muted: false, locked: false });
    p.clips.push({ id: "a", type: "audio", track: "a1", media: "m1", start: 0, duration: 90,
      source_in: 2, speed: 1, volume_db: 0, fade_in: 0, fade_out: 0, color: "blue" });
    for (let chunk = 4; chunk < 10; chunk++) decoding.sound.set(chunk,
      { start: chunk * 0.5, sampleRate: 48000, channels: [new Float32Array(24000)] });
    preview.setProject(p, {}); draw(); await complete(0); preview.play(); draw();
    const nodes = [...clock.nodes];
    clock.currentTime = 0.2; draw(); // Missing frame 4 must not rewind the audio clock.
    expect(playhead.frame).toBeCloseTo(4.5);
    expect(nodes.every((node) => node.stop.mock.calls.length === 0)).toBe(true);
    await complete(4);
    clock.currentTime = 0.3; draw();
    expect(playhead.frame).toBeCloseTo(7.5);
    expect(nodes.every((node) => node.stop.mock.calls.length === 0)).toBe(true);
  });

  it("does not decode audio or upcoming cuts while scrubbing, then cues sound where the playhead rests", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const p = fixture(); p.media[0].has_audio = true;
      p.tracks.push({ id: "a1", kind: "audio", hidden: false, muted: false, locked: false });
      p.clips.push({ id: "a", type: "audio", track: "a1", media: "m1", start: 0, duration: 90,
        source_in: 2, speed: 1, volume_db: 0, fade_in: 0, fade_out: 0, color: "blue" });
      preview.setProject(p, {}); preview.seek(10); draw(); preview.seek(15); draw();
      expect(decoding.requestAudio).not.toHaveBeenCalled();
      expect(decoding.requestVideo.mock.calls.every((call) => call[7] === false)).toBe(true);
      vi.advanceTimersByTime(300); draw();
      expect(decoding.requestAudio).toHaveBeenCalledOnce();
      expect(decoding.requestAudio.mock.calls[0][2]).toBe("a:a");
      expect(decoding.requestAudio.mock.calls[0][3]).toBeCloseTo(2.5);
    } finally { vi.useRealTimers(); }
  });

  it("freezes both clocks when decoded audio is missing", () => {
    const p = fixture(); p.media[0].has_audio = true;
    p.tracks.push({ id: "a1", kind: "audio", hidden: false, muted: false, locked: false });
    p.clips.push({ id: "a", type: "audio", track: "a1", media: "m1", start: 0, duration: 90,
      source_in: 2, speed: 1, volume_db: 0, fade_in: 0, fade_out: 0, color: "blue" });
    engine.sources.mockReturnValue("[]"); preview.setProject(p, {}); draw(); preview.play(); draw();
    clock.currentTime = 10; draw();
    expect(playhead.frame).toBe(0);
    expect(clock.nodes).toHaveLength(0);
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
    const p = fixture(); p.clips = []; // wall-clock graphics, with a short edit
    p.clips.push({ id: "solid", type: "solid", track: "v1", start: 0, duration: 2, color: "blue", fill: [1, 0, 0, 1], opacity: 1, fade_in: 0, fade_out: 0 });
    engine.sources.mockReturnValue("[]"); preview.setProject(p, {}); draw(); preview.play();
    draw(); clock.currentTime = 1; draw();
    expect(playhead.playing).toBe(false);
    draw(); engine.render.mockClear(); preview.seek(0); draw();
    expect(engine.render).toHaveBeenCalledWith(0);
  });
});
