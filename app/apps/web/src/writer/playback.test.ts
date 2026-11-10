// The script's player (playback.ts) over a decoder whose pictures arrive when
// the test says: the clock waits for the picture instead of running the cut
// over a black screen (Nov 4, JJ's Mac), holds when it falls behind, and the
// same cut read again every few seconds doesn't replay it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const decoding = vi.hoisted(() => ({ picture: false, sound: true }));
vi.mock("../lib/decoder", async (original) => {
  const actual = await original<typeof import("../lib/decoder")>();
  const frame = { codedWidth: 854, codedHeight: 480, displayWidth: 854, displayHeight: 480 };
  return {
    ...actual,
    Decoder: class {
      stats = { decodedFrames: 0 };
      picture() { return decoding.picture ? frame : undefined; }
      nearbyPicture() { return decoding.picture ? frame : undefined; }
      pcm() { return decoding.sound ? { channels: [new Float32Array(48)], sampleRate: 48_000 } : undefined; }
      requestVideo() {}
      requestRough() {}
      requestAudio() {}
      retain() {}
      dispose() {}
    },
  };
});

class AudioClock {
  currentTime = 0;
  state = "running";
  destination = {};
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createGain() { return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }; }
  createBuffer() { return { copyToChannel: vi.fn() }; }
  createBufferSource() { return { buffer: null, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null }; }
}

describe("the script's player", () => {
  let clock: AudioClock;
  let now = 0;
  let frames: Map<number, FrameRequestCallback>;
  let playback: typeof import("./playback");
  const clips = [{ id: "a", startMs: 60_000, endMs: 80_000 }, { id: "b", startMs: 5_000, endMs: 15_000 }] as never[];

  /** `ms` of wall time, a frame every 16 ms, the audio clock with it. */
  const run = (ms: number) => {
    for (let t = 0; t < ms; t += 16) {
      now += 16;
      clock.currentTime = now / 1000;
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback(now);
    }
  };

  beforeEach(async () => {
    vi.resetModules();
    decoding.picture = false;
    decoding.sound = true;
    now = 0;
    clock = new AudioClock();
    frames = new Map();
    let next = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.stubGlobal("AudioContext", class { constructor() { return clock; } });
    playback = await import("./playback");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function started() {
    const playhead = new playback.Playhead();
    const player = new playback.ScriptPlayer(clips, playhead);
    player.attach({ width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }) } as unknown as HTMLCanvasElement);
    player.setSource("/api/writer/scripts/s/proxy?v=1", 100_000);
    return { player, playhead };
  }

  it("waits for its first picture however long it takes, saying it's loading, then plays", () => {
    const { player, playhead } = started();
    player.play(0);
    run(5_000);
    // Five seconds without a picture: still at the start, never over a black screen.
    expect(playhead.ms).toBe(0);
    expect(player.framed).toBe(false);
    expect(player.buffering).toBe(true);
    decoding.picture = true;
    run(1_000);
    expect(player.framed).toBe(true);
    expect(player.buffering).toBe(false);
    expect(playhead.ms).toBeGreaterThan(800);
    expect(playhead.ms).toBeLessThan(1_000);
  });

  it("holds where it is when the picture falls behind, and goes on once it's in", () => {
    const { player, playhead } = started();
    decoding.picture = true;
    player.play(0);
    run(1_000);
    const before = playhead.ms;
    expect(before).toBeGreaterThan(800);
    decoding.picture = false;
    run(2_000);
    // Held within the stall's grace, not run on for two seconds.
    expect(playhead.ms - before).toBeLessThan(400);
    expect(player.buffering).toBe(true);
    expect(player.playing).toBe(true);
    const held = playhead.ms;
    decoding.picture = true;
    run(500);
    expect(player.buffering).toBe(false);
    expect(playhead.ms).toBeGreaterThan(held + 300);
  });

  it("starts without the sound after a short wait, but never without the picture", () => {
    const { player, playhead } = started();
    decoding.picture = true;
    decoding.sound = false;
    player.play(0);
    run(1_000);
    expect(playhead.ms).toBe(0);
    run(2_000);
    expect(playhead.ms).toBeGreaterThan(1_000);
  });

  it("plays on through the same cut read again (the script re-read every few seconds while it's saved)", () => {
    const { player, playhead } = started();
    decoding.picture = true;
    player.play(0);
    run(1_000);
    const before = playhead.ms;
    player.update(structuredClone(clips));
    run(500);
    // No replay: no pause, no re-seek, no start wait. The clock simply ran on.
    expect(playhead.ms - before).toBeGreaterThan(450);
    expect(player.buffering).toBe(false);
    // A real change still takes: the cut is shorter now.
    player.update([clips[0]]);
    expect(player.duration).toBe(20_000);
  });

  it("tells cuts apart by what they play", () => {
    const one = [{ id: "a", startMs: 0, endMs: 1_000 }] as never[];
    expect(playback.sameCut(one, structuredClone(one))).toBe(true);
    expect(playback.sameCut(one, [{ id: "a", startMs: 0, endMs: 1_200 }] as never[])).toBe(false);
    expect(playback.sameCut(one, [{ id: "a", startMs: 0, endMs: 1_000, kind: "cut-in" }] as never[])).toBe(false);
    expect(playback.sameCut(one, [...one, ...one])).toBe(false);
  });
});
