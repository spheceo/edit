import { expect, test } from "bun:test";

import { addComment, canonical, commentOf, editComment, describeComments, designOf, labelOf, layerOf, makeVersion, openComments, record, removeVersion, step, switchVersion, takeFinal } from "../src/thumbnails/design.ts";
import { baseBrief, changed, fresh, pickModel } from "../src/thumbnails/run.ts";
import type { Model } from "../src/thumbnails/openart.ts";
import { paramsOf, stateOf } from "../src/thumbnails/openart.ts";
import * as cloud from "../src/thumbnails/cloud.ts";
import { withStops } from "../src/thumbnails/cloud.ts";
import * as jobs from "../src/jobs.ts";
import * as run from "../src/thumbnails/run.ts";
import { scratch } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";
import { HOUSE_SHADOW, NO_ADJUST, type ImageLayer, type Thumbnail } from "@edit/types/thumbnails";
import { adjustPixels, blurPixelsAlpha, captionShadow, shadowMetrics, shownText, type Context } from "@edit/types/thumbnail_render";
import { sizeOf } from "../src/thumbnails/size.ts";

const sources = new Set(["img1", "asset:bodycam-rec"]);

test("a layer as given takes the house's defaults and is checked", () => {
  const overlay = layerOf({ kind: "image", source: "asset:bodycam-rec" }, undefined, sources);
  expect(overlay).toMatchObject({ kind: "image", x: 0, y: 0, width: 1280, height: 720, fit: "stretch", opacity: 100 });
  const base = layerOf({ kind: "image", source: "img1", adjust: { contrast: 15, saturation: 400 } }, undefined, sources);
  expect(base).toMatchObject({ fit: "cover", adjust: { contrast: 15, saturation: 100, exposure: 0 } });
  const caption = layerOf({ kind: "text", text: "“He abused me”", box: true, shadow: { spread: 30 } }, undefined, sources);
  expect(caption).toMatchObject({ font: "ITC Avant Garde Gothic", weight: 700, color: "#ffffff", box: { color: "#000000" }, shadow: { spread: 30, size: 32, opacity: 100 } });
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

test("a box-less caption takes the house shadow and no stroke; a copy in the same place is refused", () => {
  const caption = layerOf({ kind: "text", text: "They’re" }, undefined, sources);
  expect(caption).toMatchObject({ font: "Arabic-font-2013", weight: 700, shadow: { color: "#000000", opacity: 100, spread: 36, size: 32, distance: 6, angle: 90 } });
  expect(caption.kind === "text" && caption.stroke).toBeUndefined();
  // A stroke sent with white and red, or left on an older caption, is dropped.
  const sent = layerOf({ kind: "text", text: "they're", stroke: { color: "#000000", width: 4 } }, undefined, sources);
  expect(sent.kind === "text" && sent.stroke).toBeUndefined();
  const older = { id: "cap", kind: "text" as const, name: "they're", opacity: 100, text: "they're", x: 640, y: 200, width: 900, font: "Arabic-font-2013", weight: 700, size: 120, color: "#ffffff", align: "center" as const, lineHeight: 1.05, stroke: { color: "#000000", width: 4 }, shadow: { color: "#000000", opacity: 70, angle: 120, distance: 6, spread: 20, size: 20 } };
  const kept = layerOf({ id: "cap", text: "they're evil" }, older, sources);
  expect(kept.kind === "text" && kept.stroke).toBeUndefined();
  expect(kept).toMatchObject({ shadow: { opacity: 100, spread: 36, size: 32, angle: 90, distance: 6 } });
  const custom = { ...older, shadow: { color: "#000000", opacity: 40, angle: 45, distance: 12, spread: 0, size: 8 } };
  expect(layerOf({ id: "cap", text: "they're evil" }, custom, sources)).toMatchObject({ shadow: { opacity: 40, angle: 45, distance: 12, size: 8 } });
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

test("captions are lower case unless asked otherwise, and the shadow is Photoshop's size", () => {
  expect(shownText({ text: "They're Evil!" })).toBe("they're evil!");
  expect(shownText({ text: "They're Evil!", casing: "upper" })).toBe("THEY'RE EVIL!");
  expect(shownText({ text: "They're Evil!", uppercase: true })).toBe("THEY'RE EVIL!");
  expect(shownText({ text: "They're Evil!", casing: "keep" })).toBe("They're Evil!");
  expect(layerOf({ kind: "text", text: "They're", casing: "keep" }, undefined, sources)).toMatchObject({ casing: "keep" });
  expect(layerOf({ kind: "text", text: "They're", casing: "upper" }, undefined, sources)).toMatchObject({ casing: "upper" });
  // Size 32 at 36% spread: 11.52px solid, the rest a blur a little tighter than a CSS box-shadow.
  const metrics = shadowMetrics(HOUSE_SHADOW);
  expect(HOUSE_SHADOW).toMatchObject({ opacity: 100, spread: 36, size: 32, angle: 90, distance: 6 });
  expect(metrics.spread).toBeCloseTo(11.52, 2);
  expect(metrics.sigma).toBeCloseTo(20.48 / (2 * 1.136364), 2);
  const earlier = { color: "#000000", opacity: 75, angle: 120, distance: 6, spread: 20, size: 18 };
  expect(captionShadow({ shadow: earlier })).toEqual(HOUSE_SHADOW);
  expect(captionShadow({ shadow: { color: "#000000", opacity: 100, angle: 120, distance: 6, spread: 36, size: 32 } })).toEqual(HOUSE_SHADOW);
  expect(captionShadow({ box: { color: "#000000", opacity: 100, padX: 22, padY: 10, radius: 0 }, shadow: earlier })).toEqual(earlier);
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

test("the OpenArt account in use: the first until another of the team's is picked, kept on this Mac", async () => {
  const openart = await import("../src/thumbnails/openart.ts");
  const fs = await import("node:fs");
  const home = fs.mkdtempSync(`${(await import("node:os")).tmpdir()}/openart-`);
  openart.useHome(home);
  expect(openart.current().id).toBe(openart.ACCOUNTS[0]!.id);
  expect(() => openart.choose("someone-elses")).toThrow("There's no OpenArt account someone-elses");
  openart.choose(openart.ACCOUNTS[0]!.id);
  expect(JSON.parse(fs.readFileSync(`${home}/openart-account.json`, "utf8"))).toEqual({ account: openart.ACCOUNTS[0]!.id });
  // A saved account the code no longer has falls back to the first.
  fs.writeFileSync(`${home}/openart-account.json`, JSON.stringify({ account: "gone" }));
  openart.useHome(home);
  expect(openart.current().id).toBe(openart.ACCOUNTS[0]!.id);
  fs.rmSync(home, { recursive: true, force: true });
});

test("removing a version: the ones after it move down a number, and what showed or was final moves to a neighbour", () => {
  const thumb = fresh("t9", "Sphe", "", "");
  thumb.design = designOf([{ id: "base", kind: "image", source: "img1" }], thumb.design, sources);
  makeVersion(thumb, "Sphe");
  const v3 = makeVersion(thumb, "Sphe");
  const v2 = thumb.versions![1]!;
  takeFinal(thumb, "V2");
  switchVersion(thumb, "V1");
  // V1 goes while showing: V2 (now V1) shows; the final one keeps its place.
  expect(removeVersion(thumb, "v1")).toEqual({ removed: "V1", renamed: [["V2", "V1"], ["V3", "V2"]], showing: "V1", final: "V1" });
  expect(thumb.versions?.map((one) => [one.id, one.name])).toEqual([[v2.id, "V1"], [v3.id, "V2"]]);
  expect(thumb.activeVersion).toBe(v2.id);
  expect(thumb.render).toBeNull();
  // The final one goes: the one showing is final. Down to one, no versions.
  switchVersion(thumb, "V2");
  expect(removeVersion(thumb, "V1")).toEqual({ removed: "V1", renamed: [["V2", "V1"]], showing: "V1", final: "V1" });
  expect(thumb.versions).toBeUndefined();
  expect(thumb.activeVersion).toBeUndefined();
  expect(thumb.finalVersion).toBeUndefined();
  expect(() => removeVersion(thumb, "V1")).toThrow("There's no version V1");
  // Versions again start from V1.
  expect(makeVersion(thumb, "Sphe").name).toBe("V2");
  expect(thumb.versions?.map((one) => one.name)).toEqual(["V1", "V2"]);
});

test("comments: pinned on the version showing, numbered for good, settled ones off the page and versions' bookkeeping", () => {
  const thumb = fresh("t10", "Sphe", "", "");
  thumb.design = designOf([{ id: "base", kind: "image", source: "img1" }], thumb.design, sources);
  const first = addComment(thumb, { x: 2000, y: 300.4 }, "  brighter face ", "Sphe");
  expect(first).toMatchObject({ n: 1, x: 1280, y: 300, text: "brighter face", by: "Sphe" });
  expect(first.version).toBeUndefined();
  expect(() => addComment(thumb, { x: 1, y: 1 }, "   ", "Sphe")).toThrow("Write the comment");
  // Versions made: what was said before is V1's; a new comment is on the one showing.
  makeVersion(thumb, "Sphe");
  const [v1, v2] = thumb.versions!;
  expect(first.version).toBe(v1!.id);
  const second = addComment(thumb, { x: 100, y: 100 }, "move the caption up", "Sphe");
  expect(second).toMatchObject({ n: 2, version: v2!.id });
  expect(openComments(thumb).map((one) => one.n)).toEqual([2]);
  expect(describeComments(thumb)).toContain("#2 (V2, showing; pinned at 100, 100) Sphe: move the caption up");
  // The one showing's are Claude's to do; another version's, only when the person says so.
  expect(describeComments(thumb)).toMatch(/On the version showing \(V2\), yours to do[^\n]*\n- #2 [\s\S]*On other versions, not yours to do unasked[^\n]*\n- #1 /);
  expect(describeComments(thumb)).toContain("#1 (V1; pinned at 1280, 300) Sphe: brighter face");
  expect(commentOf(thumb, "#2").id).toBe(second.id);
  expect(() => commentOf(thumb, 9)).toThrow("There's no comment 9");
  // Settled: kept, off the list; numbers aren't reused.
  second.settled = { by: "claude", at: 1 };
  expect(openComments(thumb)).toEqual([]);
  expect(addComment(thumb, { x: 5, y: 5 }, "and the red", "Sphe").n).toBe(3);
  // V1 removed: its open comment is settled with it; down to one, the rest belong to the thumbnail again.
  removeVersion(thumb, "V1");
  expect(first.settled).toMatchObject({ by: "Edit", note: "V1 was removed." });
  expect(thumb.versions).toBeUndefined();
  expect(thumb.comments!.filter((one) => one !== first).every((one) => one.version === undefined)).toBe(true);
  expect(openComments(thumb).map((one) => one.n)).toEqual([3]);
});

test("a picture layer's oval mask: given, kept when left out, taken off with null", () => {
  const masked = layerOf({ kind: "image", source: "img1", mask: { x: 0, y: 40, width: 520, height: 680, feather: 60 } }, undefined, sources);
  expect(masked).toMatchObject({ mask: { x: 0, y: 40, width: 520, height: 680, feather: 60 } });
  expect(layerOf({ kind: "image", source: "img1" }, masked, sources)).toMatchObject({ mask: { width: 520 } });
  expect((layerOf({ kind: "image", source: "img1", mask: { width: 300 } }, masked, sources) as ImageLayer).mask).toEqual({ x: 0, y: 40, width: 300, height: 680, feather: 60 });
  expect((layerOf({ kind: "image", source: "img1", mask: null }, masked, sources) as ImageLayer).mask).toBeUndefined();
  expect(() => layerOf({ kind: "image", source: "img1", mask: "oval" }, undefined, sources)).toThrow("mask is");
});

test("a comment's pin dragged elsewhere and its words changed: only what's given changes, kept on the canvas", () => {
  const thumb = fresh("t11", "Sphe", "", "");
  const one = addComment(thumb, { x: 100, y: 100 }, "brighter face", "Sphe");
  expect(editComment(thumb, one.id, { x: 640.6, y: 9000 })).toBe(true);
  expect(one).toMatchObject({ x: 641, y: 720, text: "brighter face" });
  expect(editComment(thumb, one.id, { text: "  warmer face " })).toBe(true);
  expect(one).toMatchObject({ x: 641, y: 720, text: "warmer face" });
  expect(editComment(thumb, one.id, { text: "warmer face" })).toBe(false);
  expect(() => editComment(thumb, one.id, { text: "  " })).toThrow("Write the comment");
  expect(() => editComment(thumb, "nope", { x: 1 })).toThrow("removed");
});

test("where the canvas won't blur (WebKit, the desktop window), the shadow's blur made by hand is a Gaussian's", () => {
  // Nov 5: a caption's shadow drawn hard in the desktop window. Across an edge, a Gaussian of sigma 6
  // leaves 84% one sigma inside, half at the edge, 16% one sigma out.
  const [width, height, sigma] = [80, 81, 6];
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width / 2; x++) data[(y * width + x) * 4 + 3] = 255;
  blurPixelsAlpha({ data, width, height }, sigma);
  const alpha = (x: number) => data[(40 * width + x) * 4 + 3]! / 255;
  expect(alpha(40 - sigma)).toBeCloseTo(0.84, 1);
  expect(alpha(40)).toBeCloseTo(0.5, 1);
  expect(alpha(40 + sigma)).toBeCloseTo(0.16, 1);
  expect(alpha(20)).toBeCloseTo(1, 1);
  expect(alpha(60)).toBeCloseTo(0, 1);
});

test("an update stops a thumbnail's turn without an ending, and the next start carries it on: the person's message once, the same turn done", async () => {
  // mamagi's thumbnails functions, in memory.
  const rows = new Map<string, { body: Thumbnail; rev: number }>();
  const mock = MockServer.start();
  const restore = mock.useEnv({ EDIT_RELAY_TOKEN: "test-token" });
  const { dir: home, cleanup } = scratch("thumbnail-restart");
  mock.on("POST", "/v1/ideas/convex", (request) => {
    const { path, args } = request.json<{ path: string; args: Record<string, unknown> }>();
    const ok = (value: unknown) => Response.json({ status: "success", value });
    const id = args.thumbId as string;
    if (path === "thumbnails:get") return ok(rows.has(id) ? rows.get(id)! : null);
    if (path === "thumbnails:listAssets") return ok([]);
    const rev = rows.get(id)?.rev ?? 0;
    if (args.baseRev !== rev) return Response.json({ status: "error", errorMessage: "conflict", errorData: { code: "conflict", message: "conflict" } });
    rows.set(id, { body: args.body as Thumbnail, rev: rev + 1 });
    return ok({ rev: rev + 1 });
  });
  const ask = run.hooks.ask;
  try {
    await cloud.commit(fresh("t-restart", "Sphe", "Mom Lies", ""), 0, "Sphe");
    const context = { origin: "http://127.0.0.1:7700", port: 7700, cacheDir: `${home}/cache`, home, holder: "test-mac", by: "Sphe" };
    let asks = 0;
    let prompt = "";
    // Claude, on the turn the update cuts: it works until it's stopped.
    run.hooks.ask = (question) => {
      asks++;
      prompt = question.prompt;
      return new Promise((_, reject) => question.signal?.addEventListener("abort", () => reject(new Error("Stopped by you. Completed work is saved.")), { once: true }));
    };
    await run.chat(context, "t-restart", "make him look guiltier", []);
    for (let tries = 0; tries < 200 && asks === 0; tries++) await Bun.sleep(10);
    const key = jobs.keyOf("thumbnail", "t-restart");
    const startedAt = rows.get("t-restart")!.body.run!.startedAt;
    try {
      await run.prepareRestart(2_000);
    } finally {
      run.restart.preparing = false;
    }
    expect(run.isRunning("t-restart")).toBe(false);
    expect(jobs.get(home, key)).toMatchObject({ state: "running", args: { holder: "test-mac", by: "Sphe", startedAt, asked: "make him look guiltier", images: [] } });
    expect(jobs.get(home, key)!.args.ending).toBeUndefined();
    expect(rows.get("t-restart")!.body.run).toMatchObject({ state: "running", holder: "test-mac", startedAt });
    // The next start: the same turn carried on, Claude told.
    run.hooks.ask = async (question) => {
      asks++;
      prompt = question.prompt;
      return { structured: null, text: "Darker eyes now.", session: null, costUsd: 0, result: {}, replies: 1, biggestReply: 0 };
    };
    await run.resumeRun({ origin: context.origin, port: context.port, cacheDir: context.cacheDir, home }, jobs.get(home, key)!);
    for (let tries = 0; tries < 200 && (run.isRunning("t-restart") || jobs.get(home, key) !== undefined); tries++) await Bun.sleep(10);
    expect(asks).toBe(2);
    expect(prompt).toContain("# Carrying on\nEdit restarted while you were on this turn.");
    expect(prompt).toContain("# The person asks\nmake him look guiltier");
    const thumb = rows.get("t-restart")!.body;
    expect(thumb.chat.map((turn) => [turn.role, turn.text])).toEqual([["you", "make him look guiltier"], ["claude", "Darker eyes now."]]);
    expect(thumb.run).toMatchObject({ state: "done", holder: "test-mac", startedAt });
    expect(jobs.get(home, key)).toBeUndefined();
  } finally {
    run.hooks.ask = ask;
    restore();
    mock.stop();
    cleanup();
  }
});
