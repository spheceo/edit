import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecodeRequest, DecodeResponse } from "./decoder.protocol";

const decoding = vi.hoisted(() => ({
  gate: null as Promise<void> | null,
  closed: vi.fn(), disposed: vi.fn(), iteratorClosed: vi.fn(), audioRanges: vi.fn(),
}));
vi.mock("mediabunny", () => ({
  ALL_FORMATS: [],
  UrlSource: class {},
  Input: class {
    dispose = decoding.disposed;
    async getPrimaryVideoTrack() { return { canDecode: async () => true, getFirstTimestamp: async () => 0 }; }
    async getPrimaryAudioTrack() { return { canDecode: async () => true }; }
  },
  VideoSampleSink: class {
    async *samplesAtTimestamps(times: number[]) {
      try {
        for (const time of times) {
          if (time === 0 && decoding.gate) await decoding.gate;
          yield { close: () => decoding.closed(time), toVideoFrame: () => ({ timestamp: time * 1e6 }) };
        }
      } finally { decoding.iteratorClosed(); }
    }
  },
  AudioSampleSink: class {
    async *samples(start: number, end: number) {
      decoding.audioRanges(start, end);
      for (let timestamp = Math.floor(start / 0.04) * 0.04; timestamp < end; timestamp += 0.04) {
        yield { timestamp, duration: 0.04, numberOfFrames: 40, numberOfChannels: 2, sampleRate: 1000,
          close: () => decoding.closed(timestamp),
          copyTo: (destination: Float32Array, options: { planeIndex: number; frameOffset: number }) => {
            for (let i = 0; i < destination.length; i++) destination[i] = Math.round(timestamp * 1000) + options.frameOffset + i + options.planeIndex * 1000;
          } };
      }
    }
  },
}));

describe("decoder worker scheduling and PCM boundaries", () => {
  let messages: DecodeResponse[];
  let scope: { onmessage: ((event: MessageEvent<DecodeRequest>) => void) | null; postMessage: (data: DecodeResponse) => void };
  const send = (data: DecodeRequest) => scope.onmessage!({ data } as MessageEvent<DecodeRequest>);
  beforeEach(async () => {
    vi.resetModules(); vi.clearAllMocks(); decoding.gate = null; messages = [];
    scope = { onmessage: null, postMessage: (data) => messages.push(data) };
    vi.stubGlobal("self", scope);
    await import("./decode.worker");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("finishes one obsolete picture for responsive dragging, then decodes only the newest request", async () => {
    let release!: () => void;
    decoding.gate = new Promise<void>((resolve) => { release = resolve; });
    send({ type: "video", id: 1, key: "file", url: "/file", lane: "v:clip", times: [0, 0.1, 0.2] });
    send({ type: "video", id: 2, key: "file", url: "/file", lane: "v:clip", times: [3] });
    send({ type: "video", id: 3, key: "file", url: "/file", lane: "v:clip", times: [5, 5.1] });
    release();
    await vi.waitFor(() => expect(messages.some((m) => m.type === "done" && m.id === 3)).toBe(true));
    expect(messages.filter((m) => m.type === "video").map((m) => m.time)).toEqual([0, 5, 5.1]);
    expect(decoding.closed).toHaveBeenCalledWith(0.1);
    expect(decoding.iteratorClosed).toHaveBeenCalledTimes(2);
  });

  it("cancels obsolete lanes and disposes their input during source replacement", async () => {
    let release!: () => void;
    decoding.gate = new Promise<void>((resolve) => { release = resolve; });
    send({ type: "video", id: 1, key: "old", url: "/old", lane: "v:clip", times: [0, 0.1] });
    send({ type: "forget", key: "old" });
    release();
    await vi.waitFor(() => expect(messages.some((m) => m.type === "done")).toBe(true));
    expect(messages.some((m) => m.type === "video")).toBe(false);
    expect(decoding.disposed).toHaveBeenCalledOnce();
  });

  it("trims AAC samples that straddle chunk boundaries without shifting their timing", async () => {
    send({ type: "audio", id: 1, key: "file", url: "/file", lane: "a:clip", chunks: [1], speed: 1 });
    await vi.waitFor(() => expect(messages.some((m) => m.type === "done")).toBe(true));
    const response = messages.find((m) => m.type === "audio");
    if (response?.type !== "audio") throw new Error("No PCM");
    expect(response.pcm.start).toBe(0.5);
    expect(response.pcm.channels[0].length).toBe(500);
    expect([...response.pcm.channels[0].slice(0, 20)]).toEqual(Array.from({ length: 20 }, (_, i) => i + 500));
    expect(response.pcm.channels[0][499]).toBe(999);
    expect(response.pcm.channels[1][0]).toBe(1500);
    expect(decoding.closed).toHaveBeenCalledTimes(21);
    expect(decoding.audioRanges).toHaveBeenCalledWith(0.35, 1.15);
  });
  it("keeps one audio decoder alive across multiple storage chunks and primes its overlap window", async () => {
    send({ type: "audio", id: 1, key: "file", url: "/file", lane: "a:clip", chunks: [1, 2, 3], speed: 1 });
    await vi.waitFor(() => expect(messages.some((m) => m.type === "done")).toBe(true));
    expect(decoding.audioRanges).toHaveBeenCalledOnce();
    expect(decoding.audioRanges).toHaveBeenCalledWith(0.35, 2.15);
    const pcm = messages.filter((m) => m.type === "audio");
    expect(pcm.map((m) => m.chunk)).toEqual([1, 2, 3]);
    for (const response of pcm) {
      expect(response.pcm.channels[0][0]).toBe(response.chunk * 500);
      expect(response.pcm.channels[0][499]).toBe((response.chunk + 1) * 500 - 1);
    }
  });

});
