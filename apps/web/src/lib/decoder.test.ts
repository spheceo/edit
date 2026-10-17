import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Decoder, videoTime } from "./decoder";
import type { DecodeJob, DecodeRequest, DecodeResponse } from "./decoder.protocol";

class WorkerStub {
  static workers: WorkerStub[] = [];
  messages: DecodeRequest[] = [];
  onmessage: ((event: MessageEvent<DecodeResponse>) => void) | null = null;
  terminate = vi.fn();
  constructor() { WorkerStub.workers.push(this); }
  postMessage(message: DecodeRequest) { this.messages.push(message); }
  emit(data: DecodeResponse) { this.onmessage?.({ data } as MessageEvent<DecodeResponse>); }
  get job() { return this.messages.filter((m): m is DecodeJob => m.type === "video" || m.type === "audio").at(-1)!; }
}
const frame = () => ({ allocationSize: () => 100, codedWidth: 10, codedHeight: 10, close: vi.fn() }) as unknown as VideoFrame;

describe("worker decoder client", () => {
  let decoder: Decoder;
  let changed: ReturnType<typeof vi.fn<() => void>>;
  beforeEach(() => {
    WorkerStub.workers = [];
    vi.stubGlobal("Worker", WorkerStub);
    changed = vi.fn(); decoder = new Decoder(changed, vi.fn());
  });
  afterEach(() => { decoder.dispose(); vi.unstubAllGlobals(); });

  it("selects the nearest source frame at fractional rates and clamps both ends", () => {
    expect(videoTime(0.49 / 30, 30, 10)).toBeCloseTo(0.01 / 30);
    expect(videoTime(0.5 / 30, 30, 10)).toBeCloseTo(1.01 / 30);
    expect(videoTime(17 / 29.97, 29.97, 10)).toBeCloseTo(17.01 / 29.97);
    expect(videoTime(-2, 30, 10)).toBe(0);
    expect(videoTime(20, 30, 10)).toBeLessThan(10);
  });

  it("coalesces in-flight requests, caches completed frames and batches refill work", () => {
    const time = videoTime(2, 30, 10);
    decoder.requestVideo("file", "/file", "v:c1", time, 30, 10);
    const worker = WorkerStub.workers[0];
    const job = worker.job;
    if (job.type !== "video") throw new Error("expected video");
    decoder.requestVideo("file", "/file", "v:c1", time, 30, 10);
    expect(worker.messages).toHaveLength(1);
    for (const t of job.times) worker.emit({ type: "video", id: job.id, key: job.key, time: t, frame: frame() });
    worker.emit({ type: "done", id: job.id, lane: job.lane });
    expect(decoder.picture("file", time)).toBeDefined();
    decoder.requestVideo("file", "/file", "v:c1", time, 30, 10);
    expect(worker.messages).toHaveLength(1);
    expect(changed).toHaveBeenCalled();
  });

  it("keeps completed old seeks usable, while a stale completion cannot clear the latest flight", () => {
    decoder.requestVideo("file", "/file", "v:c1", videoTime(2, 30, 10), 30, 10);
    const worker = WorkerStub.workers[0], old = worker.job;
    decoder.requestVideo("file", "/file", "v:c1", videoTime(8, 30, 10), 30, 10);
    const latest = worker.job;
    worker.emit({ type: "video", id: old.id, key: "file", time: videoTime(2, 30, 10), frame: frame() });
    worker.emit({ type: "done", id: old.id, lane: old.lane });
    decoder.requestVideo("file", "/file", "v:c1", videoTime(8, 30, 10), 30, 10);
    expect(worker.job.id).toBe(latest.id);
    expect(decoder.picture("file", videoTime(2, 30, 10))).toBeDefined();
  });

  it("closes late frames from replaced sources and terminated worker generations", () => {
    decoder.requestVideo("old", "/old", "v:c1", 0, 30, 10);
    const worker = WorkerStub.workers[0], job = worker.job;
    const late = frame(); decoder.forget("old");
    worker.emit({ type: "video", id: job.id, key: "old", time: 0, frame: late });
    expect(late.close).toHaveBeenCalledOnce();
    decoder.dispose(); decoder.requestVideo("old", "/old", "v:c1", 0, 30, 10);
    const stale = frame();
    worker.emit({ type: "video", id: job.id, key: "old", time: 0, frame: stale });
    expect(stale.close).toHaveBeenCalledOnce();
    expect(decoder.pictures.size).toBe(0);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("decodes audio independently and scales its lookahead for fast clips", () => {
    decoder.requestVideo("file", "/file", "v:c1", 0, 30, 100);
    decoder.requestAudio("file", "/file", "a:c1", 2, 100, 4);
    expect(WorkerStub.workers).toHaveLength(2);
    const worker = WorkerStub.workers[1], job = worker.job;
    if (job.type !== "audio") throw new Error("expected audio");
    expect(job.chunks[0]).toBe(4);
    expect(job.chunks.length).toBeGreaterThanOrEqual(10);
    const pcm = { start: 2, sampleRate: 48000, channels: [new Float32Array(24000)] };
    worker.emit({ type: "audio", id: job.id, key: job.key, chunk: 4, speed: 4, pcm });
    expect(decoder.pcm("file", 4, 4)).toBe(pcm);
    expect(decoder.sound.bytes).toBe(96000);
  });

  it("does not replace a playing audio batch each time one of its chunks arrives", () => {
    decoder.requestAudio("file", "/file", "a:c1", 2, 100);
    const worker = WorkerStub.workers[0], job = worker.job;
    if (job.type !== "audio") throw new Error("expected audio");
    worker.emit({ type: "audio", id: job.id, key: job.key, chunk: 4, speed: 1,
      pcm: { start: 2, sampleRate: 48000, channels: [new Float32Array(24000)] } });
    decoder.requestAudio("file", "/file", "a:c1", 2.1, 100);
    decoder.requestAudio("file", "/file", "a:c1", 2.6, 100);
    expect(worker.messages).toHaveLength(1);
    expect(job.chunks.length).toBeGreaterThanOrEqual(8);
  });

  it("only decodes the requested scrub frame, and prefetches playback at the clip's source stride", () => {
    decoder.requestVideo("file", "/file", "v:c1", 2.13, 30, 100);
    const worker = WorkerStub.workers[0];
    if (worker.job.type !== "video") throw new Error("expected video");
    expect(worker.job.times).toHaveLength(1);
    decoder.requestVideo("file", "/file", "v:c1", 5.13, 29.981, 100, 1, true, 2 / 30);
    const job = worker.job;
    if (job.type !== "video") throw new Error("expected video");
    expect(job.times.length).toBeGreaterThan(1);
    expect(job.times[1]).toBe(videoTime(5.13 + 2 / 30, 29.981, 100));
    const id = job.id;
    worker.emit({ type: "video", id, key: "file", time: job.times[0], frame: frame() });
    decoder.requestVideo("file", "/file", "v:c1", 5.13 + 2 / 30, 29.981, 100, 1, true, 2 / 30);
    expect(worker.job.id).toBe(id);
  });

  it("keeps nearby playback pictures inside the current clip's source interval", () => {
    for (const time of [2, 8, 8.1]) {
      decoder.requestVideo("file", "/file", "v:c1", time, 30, 100);
      const worker = WorkerStub.workers[0], job = worker.job;
      if (job.type !== "video") throw new Error("expected video");
      worker.emit({ type: "video", id: job.id, key: "file", time: job.times[0], frame: frame() });
      worker.emit({ type: "done", id: job.id, lane: job.lane });
    }
    expect(decoder.nearbyPicture("file", 8.08, 0.12, 8.02, 8.2)).toBeDefined();
    expect(decoder.nearbyPicture("file", 8.08, 0.12, 5, 6)).toBeUndefined();
    expect(decoder.nearbyPicture("file", 4, 0.12, 0, 10)).toBeUndefined();
  });

  it("tells the workers which lanes to keep only when that changes", () => {
    decoder.requestVideo("file", "/file", "v:c1", 2, 30, 10);
    decoder.requestAudio("file", "/file", "a:c1", 2, 10);
    const retains = () => WorkerStub.workers.map((worker) => worker.messages.filter((m) => m.type === "retain").length);
    decoder.retain(new Set(["v:c1", "a:c1"]));
    expect(retains()).toEqual([1, 1]);
    decoder.retain(new Set(["a:c1", "v:c1"]));
    expect(retains()).toEqual([1, 1]);
    decoder.retain(new Set(["v:c1"]));
    expect(retains()).toEqual([2, 2]);
  });
});
