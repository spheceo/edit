import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { cache, hasGpu, home, logs, native, solidProject } from "./native";

let gpu = false;
// Up to 30 s: the first Vulkan device a debug build opens on a runner (no GPU: the software one) took past
// the default 5 (Check on Linux, Nov 11).
beforeAll(async () => {
  gpu = await hasGpu();
}, 30_000);

/** A PNG's size, from its header. */
function pngSize(png: Buffer): [number, number] {
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

/** The middle pixel of a PNG (RGB), decoded by FFmpeg. */
function middle(png: Buffer, [width, height]: [number, number]): number[] {
  const run = Bun.spawnSync(
    [process.env.EDIT_FFMPEG || "ffmpeg", "-v", "error", "-f", "png_pipe", "-i", "-", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { stdin: png },
  );
  const at = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 3;
  return [...run.stdout.subarray(at, at + 3)];
}

describe("frame renders", () => {
  test("a fixture frame renders on the GPU (skipped without one)", async () => {
    if (!gpu) return;
    const [image] = await native.renderFrames({
      project: { json: JSON.stringify(solidProject("p-render")) },
      frames: [10],
      maxSide: 0,
      priority: "agent",
      encode: "png",
    });
    expect(image.mime).toBe("image/png");
    expect([image.width, image.height]).toEqual([320, 180]);
    expect(pngSize(image.data)).toEqual([320, 180]);
    const [r, g, b] = middle(image.data, [320, 180]);
    expect(r).toBeGreaterThan(240);
    expect(g).toBeLessThan(15);
    expect(b).toBeLessThan(15);
    // The render was timed through the log callback.
    await Bun.sleep(20);
    expect(logs.some((line) => line.timing && line.name === "render: frame")).toBe(true);
  });

  test("frames by ref, as one sheet, encoded for an agent", async () => {
    if (!gpu) return;
    native.projectKeep(native.projectPrepare("p-sheet", JSON.stringify(solidProject("p-sheet"))).token, 4);
    const images = await native.renderFrames({
      project: { ref: { id: "p-sheet", rev: 4 } },
      frames: [0, 15, 30, 45],
      maxSide: 160,
      priority: "agent",
      encode: "agent",
      sheet: { labels: ["1", "2", "3", "4"], times: [0, 0.5, 1, 1.5], budget: 120, columns: 2 },
    });
    expect(images.length).toBe(1);
    // Two across, two down, on the model's 28 px patches, within 120 tokens.
    const [w, h] = [images[0].width, images[0].height];
    expect([w % 28, h % 28]).toEqual([0, 0]);
    expect((w / 28) * (h / 28)).toBeLessThanOrEqual(120);
    expect([w, h]).toEqual([336, 224]);
    expect(images[0].mime).toBe(process.platform === "darwin" ? "image/jpeg" : "image/png");
  });

  test("a sheet of raw pictures", async () => {
    const red = Buffer.alloc(4 * 4 * 4, 0);
    for (let i = 0; i < 16; i++) red.set([255, 0, 0, 255], i * 4);
    const sheet = await native.composeSheet(
      [
        { width: 4, height: 4, pixels: red },
        { width: 4, height: 4, pixels: red },
      ],
      { labels: ["1", "2"] },
      "png",
    );
    // Never enlarged: each in a one-patch cell, side by side.
    expect(pngSize(sheet.data)).toEqual([56, 28]);
    expect(native.SHEET_BUDGET).toBe(1300);
    expect(native.composeSheet([{ width: 4, height: 4, pixels: Buffer.alloc(3) }], { labels: [] }, "png")).rejects.toThrow(
      "needs 64 bytes",
    );
  });
});

describe("export", () => {
  test("a 2 s fixture exports, reporting progress through the callback", async () => {
    if (!gpu) return;
    const project = solidProject("p-export", 60);
    const options = { ...native.exportDefaults(), hardware: false };
    const { plan, fps } = native.exportPlan({ json: JSON.stringify(project) }, options);
    expect(fps).toBe(30);
    expect([plan.start, plan.end, plan.audio]).toEqual([0, 60, false]);
    const output = native.withExtension(join(home, "export.mov"), options.format);
    expect(output).toBe(join(home, "export.mp4"));
    const progress: number[] = [];
    const job = native.ExportJob.start(
      { project: { json: JSON.stringify(project) }, options, plan, output, cacheDir: cache },
      (value) => progress.push(value),
    );
    const done = await job.wait();
    expect(done.bytes).toBeGreaterThan(1000);
    expect(statSync(output).size).toBe(done.bytes);
    // Progress comes every 200 ms: a 2 s export of a solid is quicker than that.
    for (const value of progress) expect(value).toBeLessThanOrEqual(1);
    // Nothing is left beside it.
    expect(readdirSync(home).filter((name) => name.includes(".partial."))).toEqual([]);
    const probe = await native.probe(output);
    expect(probe.kind).toBe("video");
    expect(Math.abs(probe.duration - 2)).toBeLessThan(0.1);
    expect([probe.width, probe.height]).toEqual([320, 180]);
  }, 60_000);

  test("a longer export reports progress as it goes", async () => {
    if (!gpu) return;
    // Long enough to outlast a 200 ms report: with Linux's 4:2:0 made on the GPU (d282fe28), 40 s of a solid finished in ~0.3 s, before the first.
    const project = solidProject("p-progress", 30 * 240);
    const options = { ...native.exportDefaults(), hardware: false };
    const { plan } = native.exportPlan({ json: JSON.stringify(project) }, options);
    const output = join(home, "progress.mp4");
    const progress: number[] = [];
    const job = native.ExportJob.start(
      { project: { json: JSON.stringify(project) }, options, plan, output, cacheDir: cache },
      (value) => progress.push(value),
    );
    await job.wait();
    await Bun.sleep(20);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    // The last report can land as it finishes.
    expect(Math.max(...progress)).toBeLessThanOrEqual(1);
    expect(job.wait()).rejects.toThrow("already waited");
  }, 120_000);

  test("a cancelled export rejects with \"cancelled\" and leaves nothing", async () => {
    if (!gpu) return;
    const project = solidProject("p-cancel", 30 * 60);
    const options = { ...native.exportDefaults(), hardware: false };
    const { plan } = native.exportPlan({ json: JSON.stringify(project) }, options);
    const output = join(home, "cancelled.mp4");
    const job = native.ExportJob.start(
      { project: { json: JSON.stringify(project) }, options, plan, output, cacheDir: cache },
      () => job.cancel(),
    );
    expect(job.wait()).rejects.toThrow("cancelled");
    await Bun.sleep(500);
    expect(existsSync(output)).toBe(false);
    expect(readdirSync(home).filter((name) => name.includes("cancelled.mp4."))).toEqual([]);
  }, 60_000);

  test("what can't be exported says why", () => {
    const empty = { ...solidProject("p-empty"), clips: [] };
    expect(() => native.exportPlan({ json: JSON.stringify(empty) }, native.exportDefaults())).toThrow(
      "the timeline is empty",
    );
    const sound = { ...native.exportDefaults(), format: "wav" as const };
    expect(() => native.exportPlan({ json: JSON.stringify(solidProject()) }, sound)).toThrow(
      "there's no sound to export in that span",
    );
  });
});
