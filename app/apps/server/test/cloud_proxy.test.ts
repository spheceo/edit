import { expect, test } from "bun:test";

import { proxyBitrate, proxyJob, requestProxy } from "../src/cloud_proxy.ts";

test("proxy bitrate mirrors the engine clamp", () => {
  expect(proxyBitrate(1920, 1080)).toBe(4_000_000);
  expect(proxyBitrate(3840, 2160)).toBe(4_000_000);
  expect(proxyBitrate(640, 360)).toBe(800_000);
  expect(proxyBitrate(1280, 720)).toBeGreaterThan(800_000);
});

test("requestProxy is ready when R2 holds the proxy, preparing when the worker accepts", async () => {
  const job = proxyJob("sha256:abc", "edit/originals/sha256/abc/a.mp4", "edit/proxies/sha256/abc.mp4", 1920, 1080);
  const ready = await requestProxy(job, { head: async () => ({ size: 1 }), uploadManifest: async () => {}, request: async () => ({ accepted: true }) });
  expect(ready).toEqual({ state: "ready", proxyKey: job.proxyKey });
  const preparing = await requestProxy(job, { head: async () => null, uploadManifest: async () => {}, request: async () => ({ accepted: true }) });
  expect(preparing.state).toBe("preparing");
  const unavailable = await requestProxy(job, { head: async () => null, uploadManifest: async () => {}, request: async () => { throw new Error("no worker"); } });
  expect(unavailable.state).toBe("unavailable");
});
