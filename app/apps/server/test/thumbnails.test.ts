import { expect, test } from "bun:test";

import { designOf, labelOf, layerOf, record, step } from "../src/thumbnails/design.ts";
import { fresh } from "../src/thumbnails/run.ts";
import { paramsOf, stateOf } from "../src/thumbnails/openart.ts";
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
