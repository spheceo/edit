import { expect, test } from "bun:test";

import { designOf, labelOf, layerOf, makeVersion, record, step, switchVersion, takeFinal } from "../src/thumbnails/design.ts";
import { baseBrief, fresh, pickModel } from "../src/thumbnails/run.ts";
import type { Model } from "../src/thumbnails/openart.ts";
import { paramsOf, stateOf } from "../src/thumbnails/openart.ts";
import { withStops } from "../src/thumbnails/cloud.ts";
import { NO_ADJUST } from "@edit/types/thumbnails";
import { adjustPixels, type Context } from "@edit/types/thumbnail_render";
import { canonical, changed } from "../src/thumbnails/run.ts";
import { sizeOf } from "../src/thumbnails/size.ts";

const sources = new Set(["img1", "asset:bodycam-rec"]);

test("a layer as given takes the house's defaults and is checked", () => {
  const overlay = layerOf({ kind: "image", source: "asset:bodycam-rec" }, undefined, sources);
  expect(overlay).toMatchObject({ kind: "image", x: 0, y: 0, width: 1280, height: 720, fit: "stretch", opacity: 100 });
  const base = layerOf({ kind: "image", source: "img1", adjust: { contrast: 15, saturation: 400 } }, undefined, sources);
  expect(base).toMatchObject({ fit: "cover", adjust: { contrast: 15, saturation: 100, exposure: 0 } });
  const caption = layerOf({ kind: "text", text: "“He abused me”", box: true, shadow: { spread: 30 } }, undefined, sources);
  expect(caption).toMatchObject({ font: "Montserrat", weight: 800, color: "#ffffff", box: { color: "#000000" }, shadow: { spread: 30, size: 18 } });
  expect(() => layerOf({ kind: "image", source: "nope" }, undefined, sources)).toThrow("There's no picture nope");
  expect(() => layerOf({ kind: "text", text: "x", color: "url(evil)" }, undefined, sources)).toThrow("colour");
  expect(() => layerOf({ kind: "text", text: "x", font: 'a"; }' }, undefined, sources)).toThrow("font");
});

test("a change keeps what it leaves out; adding, removing and reordering", () => {
  const design = designOf([{ id: "base", kind: "image", source: "img1" }, { id: "cap", kind: "text", text: "Hi", size: 90 }], { layers: [] }, sources);
  const next = changed(design, { changes: [{ id: "cap", text: "Bye" }], add: [{ id: "rec", kind: "image", source: "asset:bodycam-rec" }], order: ["base", "rec", "cap"] }, sources);
  expect(next.layers.map((one) => one.id)).toEqual(["base", "rec", "cap"]);
  expect(next.layers[2]).toMatchObject({ text: "Bye", size: 90 });
  expect(changed(next, { remove: ["rec"] }, sources).layers.map((one) => one.id)).toEqual(["base", "cap"]);
  expect(() => changed(next, { changes: [{ id: "gone" }] }, sources)).toThrow("There's no layer gone");
  expect(() => changed(next, { changes: [{ id: "cap", kind: "image", source: "img1" }] }, sources)).toThrow("remove it and add another");
});

test("a design read back with its keys sorted is the same design", () => {
  expect(canonical({ layers: [{ b: 1, a: { d: 2, c: 3 } }] })).toBe(canonical({ layers: [{ a: { c: 3, d: 2 }, b: 1 }] }));
});

test("a picture's size from its first bytes", () => {
  const png = new Uint8Array(32);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(png.buffer).setUint32(16, 1832);
  new DataView(png.buffer).setUint32(20, 1015);
  expect(sizeOf(png)).toEqual({ width: 1832, height: 1015 });
  expect(sizeOf(new Uint8Array([1, 2, 3]))).toBeNull();
});

test("OpenArt's answers: a picture done, a job still going, a failure; a form's params", () => {
  expect(stateOf({ resources: [{ url: "https://cdn.openart.ai/x.png", mediaType: "image" }], status: "completed" })).toEqual({ state: "done", url: "https://cdn.openart.ai/x.png" });
  expect(stateOf({ historyId: "h1", status: "processing", visualReferences: [{ url: "https://cdn/ref.png" }] })).toEqual({ state: "running", id: "h1" });
  expect(stateOf({ status: "failed", message: "nope" })).toEqual({ state: "failed", error: "nope" });
  const form = { jsonSchema: { properties: { prompt: { type: "string" }, aspectRatio: { enum: ["1:1", "16:9"] }, quality: { enum: ["low", "high"], default: "low" } }, required: ["prompt", "quality"] } };
  expect(paramsOf(form, "a door", "16:9", [], {})).toEqual({ prompt: "a door", aspectRatio: "16:9", quality: "low" });
  expect(paramsOf(form, "a door", "21:9", [{ id: "r" }], { quality: "high" })).toEqual({ prompt: "a door", aspectRatio: "16:9", quality: "high", visualReferences: [{ id: "r" }] });
});

test("a box-less caption takes the house border and shadow; a copy in the same place is refused", () => {
  const caption = layerOf({ kind: "text", text: "They’re", font: "Helvetica Neue", weight: 900 }, undefined, sources);
  expect(caption).toMatchObject({ stroke: { color: "#000000", width: 4 }, shadow: { opacity: 70, spread: 20, size: 20 } });
  const plain = layerOf({ kind: "text", text: "Plain", stroke: null, shadow: null }, undefined, sources);
  expect(plain.kind === "text" && plain.stroke).toBeUndefined();
  expect(plain.kind === "text" && plain.shadow).toBeUndefined();
  const boxed = layerOf({ kind: "text", text: "“He abused me”", box: true }, undefined, sources);
  expect(boxed.kind === "text" && boxed.stroke).toBeUndefined();
  const design = designOf([{ id: "base", kind: "image", source: "img1" }, { id: "cap", kind: "text", text: "They’re", x: 640, y: 200 }], { layers: [] }, sources);
  expect(() => changed(design, { add: [{ kind: "text", text: "They’re", x: 640, y: 200 }] }, sources)).toThrow("change that layer");
  expect(() => changed(design, { add: [{ kind: "image", source: "img1", x: 0, y: 0, width: 1280, height: 720 }] }, sources)).toThrow("change that layer instead");
  // The same words or picture somewhere else, or a change to the layer that's there, is fine.
  expect(changed(design, { changes: [{ id: "cap", color: "#ff0000" }] }, sources).layers).toHaveLength(2);
  expect(changed(design, { add: [{ kind: "text", text: "They’re", x: 300, y: 600 }] }, sources).layers).toHaveLength(3);
});

test("the Camera Raw recipe parses, and vibrance lifts muted colour more than vivid", () => {
  const layer = layerOf({ kind: "image", source: "img1", adjust: { exposure: 0.6, contrast: 17, highlights: -67, vibrance: 42, saturation: 19, sharpen: 98 } }, undefined, sources);
  expect(layer).toMatchObject({ adjust: { exposure: 0.6, contrast: 17, highlights: -67, vibrance: 42, saturation: 19, sharpen: 98 } });
  // Two pixels, muted then vivid: vibrance widens the muted one's spread further.
  const pixels = (red: number, green: number, blue: number) => {
    const data = new Uint8ClampedArray([red, green, blue, 255]);
    const context = { getImageData: () => ({ data, width: 1, height: 1 }), putImageData: () => {} } as unknown as Context;
    adjustPixels(context, { ...NO_ADJUST, vibrance: 100 }, 1, 1);
    return Math.max(data[0]!, data[1]!, data[2]!) - Math.min(data[0]!, data[1]!, data[2]!);
  };
  expect(pixels(110, 90, 90) / 20).toBeGreaterThan(pixels(220, 40, 40) / 180);
  // Exposure is in stops: +0.60 multiplies a mid pixel by 2^0.6.
  const data = new Uint8ClampedArray([100, 100, 100, 255]);
  const context = { getImageData: () => ({ data, width: 1, height: 1 }), putImageData: () => {} } as unknown as Context;
  adjustPixels(context, { ...NO_ADJUST, exposure: 0.6 }, 1, 1);
  expect(data[0]).toBe(Math.round(100 * Math.pow(2, 0.6)));
});

test("an old thumbnail's exposure is read in the stops it meant", () => {
  const thumb = fresh("t9", "Sphe", "", "");
  thumb.design = designOf([{ id: "base", kind: "image", source: "img1", adjust: { exposure: 30 } }, { id: "mid", kind: "image", source: "img1", x: 10, adjust: { exposure: 0.6 } }], thumb.design, sources);
  // designOf now clamps to stops, so put the old units back as they were stored.
  (thumb.design.layers[0] as { adjust: { exposure: number } }).adjust.exposure = 30;
  withStops(thumb);
  expect(thumb.design.layers.map((one) => (one.kind === "image" ? one.adjust?.exposure : undefined))).toEqual([0.6, 0.6]);
});

test("versions: V1 kept, a copy starts as V2, switching keeps each one's layers", () => {
  const thumb = fresh("t7", "Sphe", "", "");
  thumb.design = designOf([{ id: "base", kind: "image", source: "img1", adjust: { contrast: 10 } }], thumb.design, sources);
  const v2 = makeVersion(thumb, "Sphe");
  expect(thumb.versions?.map((one) => one.name)).toEqual(["V1", "V2"]);
  expect(thumb.activeVersion).toBe(v2.id);
  // Change V2 in place (as a change is recorded): V1 keeps its own.
  record(thumb, changed(thumb.design, { changes: [{ id: "base", adjust: { exposure: 0.4 } }] }, sources), "Sphe");
  expect(thumb.versions?.find((one) => one.name === "V2")?.design.layers[0]).toMatchObject({ adjust: { exposure: 0.4 } });
  expect(switchVersion(thumb, "V1")?.name).toBe("V1");
  expect(thumb.design.layers[0]).toMatchObject({ adjust: { contrast: 10 } });
  expect(switchVersion(thumb, "V2")?.name).toBe("V2");
  expect(thumb.design.layers[0]).toMatchObject({ adjust: { exposure: 0.4 } });
  expect(switchVersion(thumb, "V9")).toBeNull();
  // V1 is final until another is taken; taking one doesn't change what's showing.
  expect(thumb.finalVersion).toBe(thumb.versions?.find((one) => one.name === "V1")?.id);
  switchVersion(thumb, "V1");
  expect(takeFinal(thumb, "V2")?.name).toBe("V2");
  expect(thumb.finalVersion).toBe(v2.id);
  expect(thumb.activeVersion).toBe(thumb.versions?.find((one) => one.name === "V1")?.id);
  expect(takeFinal(thumb, "V9")).toBeNull();
});

test("a small detail is an edit of the picture already on the canvas", () => {
  const made = fresh("t8", "Sphe", "Kids", "");
  made.images = [{ id: "img1", name: "the house", key: "k", from: "openart", width: 1280, height: 720, prompt: "a house at night", model: "nano-banana-pro", request: "make the house", at: 1, by: "Sphe" }];
  made.design = designOf([{ id: "base", kind: "image", source: "img1" }], made.design, sources);
  const brief = baseBrief(made);
  expect(brief).toContain("img1 as the only reference");
  expect(brief).toContain("add children in the background");
  expect(brief).toContain("a house at night");
  expect(brief).toContain("layer base");
  expect(brief).toContain("different moment, framing or scene");
  // An uploaded base has no stored prompt, and still goes to OpenArt as the reference.
  const uploaded = fresh("t8b", "Sphe", "Kids", "");
  uploaded.images = [{ id: "up1", name: "frame", key: "k", from: "upload", width: 1280, height: 720, at: 1, by: "Sphe" }];
  uploaded.design = designOf([{ id: "base", kind: "image", source: "up1" }], uploaded.design, new Set([...sources, "up1"]));
  const plain = baseBrief(uploaded);
  expect(plain).toContain("up1 as the only reference");
  expect(plain).not.toContain("stored prompts");
  expect(baseBrief(fresh("t8c", "Sphe", "", ""))).toBe("");
});

test("the default model: Nano Banana Pro for a new picture, Nano Banana 2 for a touch-up", () => {
  const model = (id: string, name: string, extra: Partial<Model> = {}): Model => ({ id, name, description: "", credits: null, edits: true, affordable: true, ...extra });
  const list = [model("seedream-5-pro", "Seedream 5 Pro"), model("nano-banana-2", "Nano Banana 2"), model("nano-banana-pro", "Nano Banana Pro")];
  expect(pickModel(list, false)).toBe("nano-banana-pro");
  expect(pickModel(list, true)).toBe("nano-banana-2");
  // Without Pro, the complex pick falls to the latest Seedream Pro OpenArt lists; a touch-up falls to Pro.
  expect(pickModel(list.filter((one) => one.id !== "nano-banana-pro"), false)).toBe("seedream-5-pro");
  expect(pickModel(list.filter((one) => one.id !== "nano-banana-2"), true)).toBe("nano-banana-pro");
  // A model the account can't afford, or one that can't edit, is never the touch-up pick.
  expect(pickModel([model("nano-banana-2", "Nano Banana 2", { affordable: false }), model("nano-banana-pro", "Nano Banana Pro")], true)).toBe("nano-banana-pro");
  expect(pickModel([model("nano-banana-2", "Nano Banana 2", { edits: false }), model("nano-banana-pro", "Nano Banana Pro")], true)).toBe("nano-banana-pro");
  expect(pickModel([], false)).toBeNull();
});

test("undo and redo walk one timeline, the person's changes and Claude's alike", () => {
  const thumb = fresh("t1", "Sphe", "", "");
  const base = designOf([{ id: "base", kind: "image", source: "img1" }], thumb.design, sources);
  expect(record(thumb, base, "Sphe")).toBe(true);
  expect(record(thumb, base, "Sphe")).toBe(false);
  const captioned = changed(base, { add: [{ id: "cap", kind: "text", text: "She smiled" }] }, sources);
  record(thumb, captioned, "claude");
  expect(thumb.history?.map((one) => [one.by, one.label])).toEqual([["Sphe", "added picture"], ["claude", "added “She smiled”"]]);
  expect(step(thumb, true)?.label).toBe("added “She smiled”");
  expect(thumb.design.layers.map((one) => one.id)).toEqual(["base"]);
  expect(step(thumb, false)?.by).toBe("claude");
  expect(thumb.design.layers.map((one) => one.id)).toEqual(["base", "cap"]);
  step(thumb, true);
  // A new change after an undo drops what redo had.
  record(thumb, changed(base, { changes: [{ id: "base", adjust: { contrast: 10 } }] }, sources), "Sphe");
  expect(thumb.future).toEqual([]);
  expect(step(thumb, false)).toBeNull();
  expect(labelOf(base, changed(base, { add: [{ kind: "text", text: "“He abused me”" }] }, sources))).toBe("added “He abused me”");
  expect(labelOf(captioned, { layers: [...captioned.layers].reverse() })).toBe("reordered the layers");
});
