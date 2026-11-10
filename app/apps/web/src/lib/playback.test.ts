import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "./types";

const engine = vi.hoisted(() => ({
  free: vi.fn(), addFont: vi.fn(), setProject: vi.fn(), applyPatch: vi.fn(), forgetVideo: vi.fn(),
  resize: vi.fn(), render: vi.fn(), uploadFrame: vi.fn(), isLost: vi.fn(() => false), sections: vi.fn(() => "null"), setPeaks: vi.fn(), clearPeaks: vi.fn(),
  sources: vi.fn((_frame: number) => "[]"),
}));
vi.mock("../engine/pkg/edit_wasm", () => ({ default: vi.fn(), createEngine: vi.fn(async () => engine) }));
const nativeApi = vi.hoisted(() => ({ nativeSources: vi.fn(async () => ({ cache: "/cache", sources: { m1: "/video.mp4" } })) }));
vi.mock("./api", () => ({ api: nativeApi, fetchRetrying: vi.fn(async () => new Response(new Uint8Array())), mediaUrl: (p: string, m: string) => `/${p}/${m}`, mediaHost: (path: string) => path, request: vi.fn(() => new Promise(() => {})) }));

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
  gains: { gain: { setValueAtTime: ReturnType<typeof vi.fn>; linearRampToValueAtTime: ReturnType<typeof vi.fn> } }[] = [];
  resume() { return Promise.resolve(); }
  createBuffer(channels: number, length: number, sampleRate: number) {
    return { numberOfChannels: channels, length, sampleRate, copyToChannel: vi.fn() };
  }
  createGain() {
    const node = { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      connect: () => ({ connect: vi.fn() }), disconnect: vi.fn() };
    this.gains.push(node);
    return node;
  }
  createBufferSource() {
    const node = { buffer: null, playbackRate: { value: 1 }, start: vi.fn(), stop: vi.fn(),
      connect: () => ({ connect: vi.fn() }), disconnect: vi.fn(), onended: null };
    this.nodes.push(node);
    return node;
  }
}

const fixture = (id = "p1"): Project => ({
  version: 1, id, name: "Test", style: "bodycam", next_id: 3, settings: { width: 320, height: 180, fps: 30 },
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

  it("shows a project whose people's colours the page's own rule doubts (the server and engine police them)", () => {
    // Judge EXPLODES: the page's copy of the rule lacked the courtroom's white subtitles and showed nothing.
    const white = { ...fixture(), people: [{ id: "x1", name: "Mother", label: "Mother:", role: "suspect", color: "#ffffff", names: [] }] } as unknown as Project;
    preview.setProject(white, {}); draw();
    expect(preview.error).toBeNull();
    expect(engine.setProject).toHaveBeenCalled();
  });

  it("says on the preview when the page's own rules refuse a project, never a black frame", () => {
    const overlapping = fixture();
    overlapping.clips = [...overlapping.clips, { ...overlapping.clips[0], id: "c9" }];
    preview.setProject(overlapping, {}); draw();
    expect(preview.error).toContain("can't show this project");
    preview.setProject(fixture("p2"), {}); draw();
    expect(preview.error).toBeNull();
  });

  it("says on the preview when the engine refuses a project, and clears it when one is taken", () => {
    // A page older than the server checks the project with older rules.
    engine.setProject.mockImplementationOnce(() => { throw new Error("Bystander (p43) can't be white or a near-white grey"); });
    preview.setProject(fixture(), {}); draw();
    expect(preview.error).toContain("can't show this project: Bystander (p43)");
    expect(preview.error).toContain("reload the page");
    preview.setProject(fixture("p2"), {}); draw();
    expect(preview.error).toBeNull();
  });

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

  it("plays at 2× on the page's clock: twice the frames a second, the sound asked for and placed at twice the speed", () => {
    // JJ, Nov 10: "a button where we can speed up when watching the video. like in premiere".
    const p = fixture(); p.media[0].has_audio = true;
    p.tracks.push({ id: "a1", kind: "audio", hidden: false, muted: false, locked: false });
    p.clips.push({ id: "a", type: "audio", track: "a1", media: "m1", start: 0, duration: 90,
      source_in: 2, speed: 1, volume_db: 0, fade_in: 0, fade_out: 0, color: "blue" });
    engine.sources.mockReturnValue("[]");
    // What the decoder hands back for 2×: each half second of the recording in a quarter second of sound.
    for (let chunk = 4; chunk < 12; chunk++) decoding.sound.set(chunk,
      { start: chunk * 0.5, sampleRate: 48000, channels: [new Float32Array(12000)] });
    const told = vi.fn(); preview.onStatus(told);
    preview.setSpeed(2);
    expect(preview.speed).toBe(2);
    expect(told).toHaveBeenCalled();
    preview.setProject(p, {}); draw(); preview.play(); draw();
    expect(decoding.requestAudio.mock.calls.at(-1)![5]).toBe(2);
    // The first half second of the recording, heard in a quarter second.
    const [at, offset, length] = clock.nodes[0].start.mock.calls[0];
    expect(at).toBeCloseTo(0.05); expect(offset).toBeCloseTo(0); expect(length).toBeCloseTo(0.25);
    // Half a second on the speaker's clock is a second of the edit.
    clock.currentTime = 0.55; draw();
    expect(playhead.frame).toBeCloseTo(30);
    // Back to 1× while it plays: on from where it is, the sound placed again at the recording's own speed.
    const nodes = [...clock.nodes];
    preview.setSpeed(1);
    expect(nodes.every((node) => node.stop.mock.calls.length === 1)).toBe(true);
    for (let chunk = 4; chunk < 12; chunk++) decoding.sound.set(chunk,
      { start: chunk * 0.5, sampleRate: 48000, channels: [new Float32Array(24000)] });
    draw();
    expect(playhead.playing).toBe(true);
    expect(playhead.frame).toBeCloseTo(30);
    expect(decoding.requestAudio.mock.calls.at(-1)![5]).toBe(1);
    clock.currentTime = 1.1; draw();
    expect(playhead.frame).toBeCloseTo(45);
    preview.pause();
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
    preview.setProject(fixture(), {}); draw();
    const calls = engine.setProject.mock.calls.length;
    const p = fixture(); p.clips.push({ ...p.clips[0], id: "overlap" });
    preview.setProject(p, {}); draw();
    expect(engine.setProject).toHaveBeenCalledTimes(calls);
    expect(engine.applyPatch).not.toHaveBeenCalled();
    expect(preview.error).toBeNull();
    // The next valid step reaches the engine (as a patch of the clip that moved).
    const next = fixture(); next.clips[0].start = 3;
    preview.setProject(next, {}); draw();
    expect(engine.applyPatch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(engine.applyPatch.mock.calls[0]![0])).lists.clips.put[0].start).toBe(3);
  });

  it("sends a drag's changes to the engine once per frame, as one patch of what changed", async () => {
    const { produce } = await import("immer");
    let p = fixture();
    preview.setProject(p, {}); draw();
    const calls = engine.setProject.mock.calls.length;
    for (let start = 1; start <= 3; start++) {
      p = produce(p, (draft) => { draft.clips[0].start = start; });
      preview.setProject(p, {});
    }
    expect(engine.setProject).toHaveBeenCalledTimes(calls);
    expect(engine.applyPatch).not.toHaveBeenCalled();
    draw();
    expect(engine.setProject).toHaveBeenCalledTimes(calls);
    expect(engine.applyPatch).toHaveBeenCalledTimes(1);
    const patch = JSON.parse(String(engine.applyPatch.mock.calls[0]![0]));
    expect(patch.lists.clips.put).toEqual([JSON.parse(JSON.stringify(p.clips[0]))]);
    draw();
    expect(engine.applyPatch).toHaveBeenCalledTimes(1);
  });

  const withSound = () => {
    const p = fixture(); p.media[0].has_audio = true;
    p.tracks.push({ id: "a1", kind: "audio", hidden: false, muted: false, locked: false });
    p.clips.push({ id: "a", type: "audio", track: "a1", media: "m1", start: 0, duration: 90,
      source_in: 2, speed: 1, volume_db: 0, fade_in: 3, fade_out: 0, color: "blue" });
    for (let chunk = 4; chunk < 10; chunk++) decoding.sound.set(chunk,
      { start: chunk * 0.5, sampleRate: 48000, channels: [new Float32Array(24000)] });
    engine.sources.mockReturnValue("[]");
    return p;
  };

  it("keeps sound playing through edits that don't touch it, and restarts it when its clip changes", async () => {
    const { produce } = await import("immer");
    let p = withSound();
    preview.setProject(p, {}); draw(); preview.play(); draw();
    const nodes = [...clock.nodes];
    expect(nodes.length).toBeGreaterThan(0);
    // The agent changes the picture and adds a title; the sound's clip is the same object.
    p = produce(p, (draft) => {
      const video = draft.clips[0];
      if (video.type === "video") video.opacity = 0.5;
      draft.clips.push({ id: "t", type: "solid", track: "v1", start: 90, duration: 30, color: "blue", fill: [1, 0, 0, 1], opacity: 1, fade_in: 0, fade_out: 0 });
    });
    preview.setProject(p, { m1: "source" });
    clock.currentTime = 0.3; draw();
    expect(playhead.frame).toBeCloseTo(7.5); // the clock ran on: no re-buffering
    expect(nodes.every((node) => node.stop.mock.calls.length === 0)).toBe(true);
    // Now the sound itself changes.
    const playing = [...clock.nodes];
    p = produce(p, (draft) => { const clip = draft.clips.find((candidate) => candidate.id === "a")!; if (clip.type === "audio") clip.volume_db = -6; });
    preview.setProject(p, {});
    expect(playing.every((node) => node.stop.mock.calls.length === 1)).toBe(true);
  });

  it("restarts sound when its track is muted", async () => {
    const { produce } = await import("immer");
    let p = withSound();
    preview.setProject(p, {}); draw(); preview.play(); draw();
    const nodes = [...clock.nodes];
    p = produce(p, (draft) => { draft.tracks[1].muted = true; });
    preview.setProject(p, {});
    expect(nodes.every((node) => node.stop.mock.calls.length === 1)).toBe(true);
  });

  it("fades sound in from silence on the clip's first frame, as the export does", () => {
    preview.setProject(withSound(), {}); draw(); preview.play(); draw();
    const { gain } = clock.gains[0];
    expect(gain.setValueAtTime.mock.calls[0][0]).toBeCloseTo(0);
    expect(gain.linearRampToValueAtTime.mock.calls.slice(0, 3).map((call) => call[0])).toEqual([1 / 3, 2 / 3, 1].map((value) => expect.closeTo(value)));
  });

  it("plays and scrubs the rendered edit while it shows what's on screen, and draws live once it doesn't", async () => {
    // The team, Oct 31: "currently super laggy! we have too many loading frame issues".
    const listeners = new Map<string, () => void>();
    const video = {
      src: "", currentTime: 0, paused: true, ended: false, muted: true,
      getAttribute(name: string) { return name === "src" ? this.src || null : null; },
      play: vi.fn(function (this: { paused: boolean }) { this.paused = false; return Promise.resolve(); }),
      pause: vi.fn(function (this: { paused: boolean }) { this.paused = true; }),
      addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    };
    preview.attachVideo(video as unknown as HTMLVideoElement);
    preview.setProject(fixture(), {}); draw();
    engine.render.mockClear();
    preview.setSmooth("/api/projects/p1/playback.mp4?v=a");
    expect(video.src).toBe("/api/projects/p1/playback.mp4?v=a");
    expect(preview.smoothShown).toBe(true);
    // A seek moves the video, a hair into its frame, and nothing is decoded or drawn live.
    decoding.requestVideo.mockClear();
    preview.seek(30); draw();
    expect(video.currentTime).toBeCloseTo(30.25 / 30, 6);
    expect(engine.render).not.toHaveBeenCalled();
    expect(decoding.requestVideo).not.toHaveBeenCalled();
    // What's on screen is the video's frame: none while it seeks there, then the one asked for.
    Object.assign(video, { seeking: true, readyState: 1 });
    expect(preview.diagnostics.renderedFrame).toBeNull();
    Object.assign(video, { seeking: false, readyState: 4 });
    expect(preview.diagnostics.renderedFrame).toBe(30);
    // Play runs the video; its clock moves the playhead.
    preview.play();
    expect(video.play).toHaveBeenCalled();
    video.currentTime = 2.0; draw();
    expect(playhead.frame).toBeCloseTo(59.75, 6);
    // At 2× the video itself plays at twice the speed, its own clock still the playhead's.
    preview.setSpeed(2);
    expect((video as unknown as { playbackRate: number }).playbackRate).toBe(2);
    expect(playhead.playing).toBe(true);
    preview.setSpeed(1);
    expect((video as unknown as { playbackRate: number }).playbackRate).toBe(1);
    // An edit since: the video stops where it was and the canvas draws live.
    preview.setSmooth(null); draw();
    expect(video.pause).toHaveBeenCalled();
    expect(playhead.playing).toBe(false);
    expect(preview.smoothShown).toBe(false);
    expect(decoding.requestVideo).toHaveBeenCalled();
  });

  it("stops the rendered video and its sound when a scrub moves past its chunks, so they never play on under the live sound", async () => {
    // Nov 3, watching: paused, scrubbed back and forth, it glitched, played on by itself, two sounds at once.
    class FakeMediaSource { addEventListener() {} }
    class FakeSound {
      currentTime = 0; paused = true; seeking = false; playbackRate = 1; src = "";
      play = vi.fn(async () => { this.paused = false; });
      pause = vi.fn(() => { this.paused = true; });
      removeAttribute() {}
    }
    vi.stubGlobal("MediaSource", FakeMediaSource);
    vi.stubGlobal("Audio", FakeSound);
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => "blob:render");
    const listeners = new Map<string, () => void>();
    const video = {
      src: "", currentTime: 0, paused: true, ended: false, muted: true,
      getAttribute(name: string) { return name === "src" ? this.src || null : null; },
      play: vi.fn(function (this: { paused: boolean }) { this.paused = false; return Promise.resolve(); }),
      pause: vi.fn(function (this: { paused: boolean }) { this.paused = true; }),
      addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    };
    preview.attachVideo(video as unknown as HTMLVideoElement);
    preview.setProject(fixture(), {}); draw();
    preview.setSmooth("stream:p1:1");
    type Internals = { stream: { info: unknown; appended: Map<number, string> } | null; streamSound: FakeSound };
    const internals = preview as unknown as Internals;
    const stream = internals.stream!;
    stream.info = { segments: [{ start: 0, end: 90, key: "a", ready: true }], codec: null, sound: "ready", soundUrl: "/sound" };
    stream.appended.set(0, "a");
    preview.seek(30);
    expect(preview.smoothShown).toBe(true);
    // Playing, picture and sound both live.
    video.paused = false;
    internals.streamSound.paused = false;
    // The scrub lands where the render has nothing (its chunks changed): both stop, there and then.
    stream.info = { segments: [{ start: 0, end: 90, key: "b", ready: true }], codec: null, sound: "ready", soundUrl: "/sound" };
    preview.seek(60);
    expect(preview.smoothShown).toBe(false);
    expect(video.pause).toHaveBeenCalled();
    expect(internals.streamSound.pause).toHaveBeenCalled();
    expect(internals.streamSound.paused).toBe(true);
    // And playing live from there never brings the render's sound back under it.
    preview.play(); draw();
    expect(internals.streamSound.paused).toBe(true);
  });

  // Edit.app's window (lib/nativePreview.ts): its calls answered as crates/edit-window/src/preview.rs does.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  // The window's clock, as the page sees it: `preview_position` says this frame while playing.
  const windowClock = { frame: 0, playing: false, ended: false };
  const inWindow = async (refuse: (command: string) => string | null = () => null) => {
    const calls: [string, Record<string, unknown>][] = [];
    windowClock.frame = 0; windowClock.playing = false; windowClock.ended = false;
    const invoke = vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
      calls.push([command, args]);
      const refused = refuse(command);
      if (refused !== null) throw refused;
      if (command === "preview_open") return true;
      if (command === "preview_project" || command === "preview_patch") return args.revision;
      if (command === "preview_frame") return { revision: 0, drawn: true, skipped: false, ms: 4, decode: 3, composite: 0.5, present: 0.3, opens: 0, seeks: 0, ffmpeg: 0 };
      if (command === "preview_play") { windowClock.frame = Number(args.frame); windowClock.playing = true; return null; }
      if (command === "preview_pause") { windowClock.playing = false; return Math.floor(windowClock.frame); }
      if (command === "preview_position") return { frame: windowClock.frame, playing: windowClock.playing, ended: windowClock.ended, drawn: 1, skipped: 0, slow: 0, draws: [2.5], starved: 0 };
      return null;
    });
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke };
    vi.stubGlobal("navigator", { gpu: {}, platform: "MacIntel" });
    preview.detach();
    await preview.attach({ width: 320, height: 180 } as HTMLCanvasElement);
    expect(preview.native).toBe(true);
    return (command: string) => calls.filter(([name]) => name === command).map(([, args]) => args);
  };

  it("sends the window the edit whole once, then only what changed, and hears the revision it draws", async () => {
    const { produce } = await import("immer");
    let refusePatch = false;
    const sent = await inWindow((command) => (refusePatch && command === "preview_patch" ? "the window has revision 0, not 2" : null));
    let p = fixture();
    preview.setProject(p, {}); await settle(); draw(); await settle();
    expect(sent("preview_project")).toHaveLength(1);
    expect(sent("preview_project")[0]!.revision).toBe(1);
    // A drag's move: the clip that moved, not the edit.
    p = produce(p, (draft) => { draft.clips[0].start = 5; });
    preview.setProject(p, {}); draw(); await settle();
    expect(sent("preview_patch")).toHaveLength(1);
    expect(sent("preview_patch")[0]).toMatchObject({ base: 1, revision: 2 });
    const patch = JSON.parse(String(sent("preview_patch")[0]!.patch));
    expect(patch.lists.clips.put).toEqual([JSON.parse(JSON.stringify(p.clips[0]))]);
    expect(preview.diagnostics.nativeFrames.accepted).toBe(2);
    // Out of step: the whole edit next.
    refusePatch = true;
    p = produce(p, (draft) => { draft.clips[0].start = 6; });
    preview.setProject(p, {}); draw(); await settle(); draw(); await settle();
    expect(sent("preview_project")).toHaveLength(2);
    expect(JSON.parse(String(sent("preview_project")[1]!.json)).clips[0].start).toBe(6);
    expect(preview.diagnostics.nativeFrames.accepted).toBe(4);
    expect(preview.native).toBe(true);
  });

  it("draws in the page when the window refuses the edit, and says why", async () => {
    await inWindow((command) => (command === "preview_project" ? "unknown media m9" : null));
    preview.setProject(fixture(), {}); await settle(); draw(); await settle();
    expect(preview.native).toBe(false);
    expect(preview.diagnostics.nativeFrames.off).toContain("refused edit");
    expect(preview.diagnostics.nativeFrames.off).toContain("unknown media m9");
  });

  it("keeps each window frame's time for the reports", async () => {
    await inWindow();
    preview.setProject(fixture(), {}); await settle(); draw(); await settle();
    preview.seek(10); draw(); await settle();
    const report = preview.diagnostics.nativeFrames;
    expect(report.drawn).toBe(2);
    expect(report.drawMs.p50).toBe(4);
    expect(report.decodeMs.p50).toBe(3);
  });

  it("plays on the window's clock: the sound is the window's, the playhead follows its position, and its end pauses here", async () => {
    const sent = await inWindow();
    preview.setProject(withSound(), {}); await settle(); draw(); await settle();
    decoding.requestAudio.mockClear();
    preview.seek(10); draw(); await settle();
    preview.play(); await settle();
    expect(sent("preview_play")).toEqual([{ frame: 10 }]);
    expect(playhead.playing).toBe(true);
    // Nothing decoded in the page: no sound asked for, no frame asked of the window while it plays.
    expect(decoding.requestAudio).not.toHaveBeenCalled();
    const framesAsked = sent("preview_frame").length;
    windowClock.frame = 12.5; draw(); await settle();
    expect(playhead.frame).toBe(12.5);
    expect(sent("preview_frame")).toHaveLength(framesAsked);
    expect(preview.diagnostics.nativeFrames.played).toBe(1);
    // A seek while playing plays on from there.
    preview.seek(40); await settle();
    expect(sent("preview_play").at(-1)).toEqual({ frame: 40 });
    // The end: the window says so, the page pauses on that frame.
    windowClock.frame = 89; windowClock.ended = true; windowClock.playing = false; draw(); await settle();
    expect(playhead.playing).toBe(false);
    expect(playhead.frame).toBe(89);
    expect(sent("preview_pause").length).toBeGreaterThanOrEqual(1);
  });

  it("plays at 2× on the window's clock: the window is told the speed before it plays, and at once when it changes mid-play", async () => {
    const calls: string[] = [];
    const sent = await inWindow((command) => { calls.push(command); return null; });
    preview.setProject(withSound(), {}); await settle(); draw(); await settle();
    preview.setSpeed(2); await settle();
    expect(sent("preview_rate")).toEqual([{ rate: 2 }]);
    preview.play(); await settle();
    expect(sent("preview_play")).toEqual([{ frame: 0 }]);
    expect(calls.indexOf("preview_rate")).toBeLessThan(calls.indexOf("preview_play"));
    // Mid-play: the window carries on from where its clock is; nothing is played again.
    preview.setSpeed(1); await settle();
    expect(sent("preview_rate")).toEqual([{ rate: 2 }, { rate: 1 }]);
    expect(sent("preview_play")).toHaveLength(1);
    expect(playhead.playing).toBe(true);
  });

  it("a window opened again is told the speed again before it plays (a new one plays at 1×)", async () => {
    await inWindow();
    preview.setProject(withSound(), {}); await settle(); draw(); await settle();
    preview.setSpeed(2); await settle();
    const sent = await inWindow();
    preview.setProject(withSound(), {}); await settle(); draw(); await settle();
    preview.play(); await settle();
    expect(sent("preview_rate")).toEqual([{ rate: 2 }]);
    expect(sent("preview_play")).toEqual([{ frame: 0 }]);
  });

  it("a window with no speeds plays at 1×, and the speed button says so", async () => {
    const sent = await inWindow((command) => (command === "preview_rate" ? "command preview_rate not found" : null));
    preview.setProject(withSound(), {}); await settle(); draw(); await settle();
    // At 1× nothing is said of it: that window plays at 1× anyway.
    preview.play(); await settle();
    expect(sent("preview_play")).toEqual([{ frame: 0 }]);
    expect(playhead.playing).toBe(true);
    preview.setSpeed(2); await settle();
    expect(preview.speed).toBe(1);
    expect(playhead.playing).toBe(true);
  });

  it("patches the page's engine with a clips-only change instead of sending the edit whole", async () => {
    const { produce } = await import("immer");
    let p = fixture();
    preview.setProject(p, {}); draw();
    expect(engine.setProject).toHaveBeenCalledTimes(1);
    p = produce(p, (draft) => { draft.clips[0].start = 5; });
    preview.setProject(p, {}); draw();
    expect(engine.setProject).toHaveBeenCalledTimes(1);
    expect(engine.applyPatch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(engine.applyPatch.mock.calls[0]![0])).lists.clips.put[0].start).toBe(5);
    // A change beyond the clips (a setting) goes whole.
    p = produce(p, (draft) => { draft.name = "Renamed"; });
    preview.setProject(p, {}); draw();
    expect(engine.setProject).toHaveBeenCalledTimes(2);
    // A step the engine's rules refuse keeps the last picture and no error shows.
    engine.applyPatch.mockImplementationOnce(() => { throw new Error("clips a and b overlap"); });
    p = produce(p, (draft) => { draft.clips[0].start = 6; });
    preview.setProject(p, {}); draw();
    expect(preview.error).toBeNull();
    // The next step is cut from what the engine holds, not from the refused one.
    p = produce(p, (draft) => { draft.clips[0].start = 7; });
    preview.setProject(p, {}); draw();
    const last = JSON.parse(String(engine.applyPatch.mock.calls.at(-1)![0]));
    expect(last.lists.clips.put[0].start).toBe(7);
  });

  it("asks for no scrub pieces while the window draws: a drag is the window's whole copies, the scrub tier the page player's", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { fetched.push(String(url)); return new Response("{}", { status: 200 }); }));
    // The page player asks for the pieces around the playhead as a drag starts (its asks are a few seconds apart at most).
    const asks = preview as unknown as { scrubAskedAt: number; scrubLookedAt: number };
    asks.scrubAskedAt = -1e9; asks.scrubLookedAt = -1e9;
    preview.setProject(fixture(), {}); draw();
    preview.seek(10); preview.seek(12); draw();
    expect(fetched.some((url) => url.includes("/scrub"))).toBe(true);
    fetched.length = 0;
    await inWindow();
    asks.scrubAskedAt = -1e9; asks.scrubLookedAt = -1e9;
    preview.setProject(fixture(), {}); await settle(); draw(); await settle();
    preview.seek(20); preview.seek(22); draw(); await settle();
    expect(fetched.some((url) => url.includes("/scrub"))).toBe(false);
  });

  it("in full screen while the window plays, the page plays on from where it was", async () => {
    await inWindow();
    preview.setProject(fixture(), {}); await settle(); draw(); await settle();
    preview.play(); await settle();
    windowClock.frame = 20; draw(); await settle();
    preview.setNativeAllowed(false); await settle();
    expect(preview.native).toBe(false);
    expect(playhead.playing).toBe(true);
    draw(); await settle(); draw();
    expect(decoding.requestVideo).toHaveBeenCalled();
  });

  it("asks where the window reads from again when the server's cleaner took a copy, or a frame failed", async () => {
    await inWindow();
    preview.setProject(fixture(), {}); await settle(); draw(); await settle();
    const asked = nativeApi.nativeSources.mock.calls.length;
    window.dispatchEvent(new Event("edit:native-sources")); await settle();
    expect(nativeApi.nativeSources.mock.calls.length).toBe(asked + 1);
  });

  it("in full screen the page draws, still as Edit.app's window's picture (no smooth-playback render asked for), and says why", async () => {
    await inWindow();
    preview.setProject(fixture(), {}); await settle(); draw(); await settle();
    preview.setNativeAllowed(false);
    expect(preview.native).toBe(false);
    // Viewer asks for a render only when neither holds (it took a place in the export line and the encoder).
    expect(preview.nativeHere).toBe(true);
    expect(preview.diagnostics.nativeFrames.off).toBe("full screen");
    preview.setNativeAllowed(true); await settle();
    expect(preview.native).toBe(true);
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
