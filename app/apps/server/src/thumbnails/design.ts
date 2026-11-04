// A thumbnail's layers as given (by Claude's tools or the editor), checked and
// filled in: every number in its range, a picture that's the thumbnail's own
// or the library's, a colour a colour. What's left out takes the house's
// defaults, so "a REC overlay" or "white caption, black box" is a short ask.

import { captionShadow } from "@edit/types/thumbnail_render";
import { assetOf, BLACK_BOX_FONT, HEIGHT, HOUSE_SHADOW, NO_ADJUST, WHITE_RED_FONT, WIDTH, type Adjust, type Box, type Design, type ImageLayer, type Layer, type Shadow, type Step, type Stroke, type TextLayer, type Thumbnail, type ThumbComment, type ThumbVersion } from "@edit/types/thumbnails";

type Args = Record<string, unknown>;

const isRecord = (value: unknown): value is Args => value !== null && typeof value === "object" && !Array.isArray(value);

function number(value: unknown, fallback: number, low: number, high: number, what: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${what} must be a number.`);
  return Math.min(high, Math.max(low, value));
}

const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]{3,20})$/i;
function color(value: unknown, fallback: string, what: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !COLOR.test(value.trim())) throw new Error(`${what} must be a colour ("#ffffff", "rgba(0,0,0,0.8)", "red").`);
  return value.trim();
}

const newId = () => Math.random().toString(36).slice(2, 10);

function adjustOf(given: unknown, before: Adjust | undefined): Adjust | undefined {
  if (given === undefined) return before;
  if (given === null) return undefined;
  if (!isRecord(given)) throw new Error("adjust is an object: exposure in stops (-5…+5), contrast, saturation, vibrance, warmth, shadows, highlights (-100…100), vignette, sharpen (0…100).");
  const base = before ?? NO_ADJUST;
  const out: Adjust = { ...base };
  for (const key of Object.keys(NO_ADJUST) as (keyof Adjust)[]) {
    // Exposure is in stops, as Camera Raw's (-5…+5, to two decimals); the rest are -100…100.
    const low = key === "exposure" ? -5 : key === "vignette" || key === "sharpen" ? 0 : -100;
    const high = key === "exposure" ? 5 : 100;
    out[key] = number(given[key], base[key], low, high, `adjust.${key}`);
  }
  return out;
}

function shadowOf(given: unknown, before: Shadow | undefined): Shadow | undefined {
  if (given === undefined) return before;
  if (given === null || given === false) return undefined;
  const base = before ?? HOUSE_SHADOW;
  if (given === true) return base;
  if (!isRecord(given)) throw new Error("shadow is an object: color, opacity (0…100), angle (degrees), distance (px), spread (0…100), size (px); or null for none.");
  return {
    color: color(given.color, base.color, "shadow.color"),
    opacity: number(given.opacity, base.opacity, 0, 100, "shadow.opacity"),
    angle: number(given.angle, base.angle, -360, 360, "shadow.angle"),
    distance: number(given.distance, base.distance, 0, 200, "shadow.distance"),
    spread: number(given.spread, base.spread, 0, 100, "shadow.spread"),
    size: number(given.size, base.size, 0, 250, "shadow.size"),
  };
}

function boxOf(given: unknown, before: Box | undefined): Box | undefined {
  if (given === undefined) return before;
  if (given === null || given === false) return undefined;
  const base = before ?? { color: "#000000", opacity: 100, padX: 22, padY: 10, radius: 0 };
  if (given === true) return base;
  if (!isRecord(given)) throw new Error("box is an object: color, opacity (0…100), padX, padY, radius (px); or null for none.");
  return {
    color: color(given.color, base.color, "box.color"),
    opacity: number(given.opacity, base.opacity, 0, 100, "box.opacity"),
    padX: number(given.padX, base.padX, 0, 200, "box.padX"),
    padY: number(given.padY, base.padY, 0, 200, "box.padY"),
    radius: number(given.radius, base.radius, 0, 200, "box.radius"),
  };
}

function strokeOf(given: unknown, before: Stroke | undefined): Stroke | undefined {
  if (given === undefined) return before;
  if (given === null || given === false) return undefined;
  const base = before ?? { color: "#000000", width: 4 };
  if (!isRecord(given)) throw new Error("stroke is an object: color, width (px); or null for none.");
  return { color: color(given.color, base.color, "stroke.color"), width: number(given.width, base.width, 0, 60, "stroke.width") };
}

/**
 * One layer as given, over what it was (`before`, for a change): checked, its
 * leftovers the defaults. `sources` are the pictures it may show.
 */
export function layerOf(given: unknown, before: Layer | undefined, sources: Set<string>): Layer {
  if (!isRecord(given)) throw new Error("A layer is an object.");
  const kind = given.kind ?? before?.kind;
  if (kind !== "image" && kind !== "text") throw new Error('A layer\'s kind is "image" (a picture or overlay) or "text".');
  if (before !== undefined && before.kind !== kind) throw new Error(`Layer ${before.id} is ${before.kind === "image" ? "a picture" : "text"}: remove it and add another instead.`);
  const id = typeof given.id === "string" && /^[\w-]{1,40}$/.test(given.id) ? given.id : (before?.id ?? newId());
  const name = typeof given.name === "string" && given.name.trim() !== "" ? given.name.trim().slice(0, 60) : before?.name;
  const opacity = number(given.opacity, before?.opacity ?? 100, 0, 100, "opacity");
  const hidden = typeof given.hidden === "boolean" ? given.hidden : before?.hidden;
  if (kind === "image") {
    const was = before as ImageLayer | undefined;
    const source = typeof given.source === "string" ? given.source.trim() : was?.source;
    if (source === undefined || source === "") throw new Error("A picture layer needs its source: one of the thumbnail's images (its id) or a library overlay (asset:<id>).");
    if (!sources.has(source)) throw new Error(`There's no picture ${source}: use one of the thumbnail's images (by id) or a library overlay (asset:<id>).`);
    const fit = given.fit ?? was?.fit ?? (assetOf(source) !== null ? "stretch" : "cover");
    if (fit !== "cover" && fit !== "contain" && fit !== "stretch") throw new Error('fit is "cover", "contain" or "stretch".');
    const layer: ImageLayer = {
      id,
      kind: "image",
      name: name ?? (assetOf(source) !== null ? assetOf(source)! : "picture"),
      opacity,
      ...(hidden ? { hidden } : {}),
      source,
      x: number(given.x, was?.x ?? 0, -WIDTH * 2, WIDTH * 3, "x"),
      y: number(given.y, was?.y ?? 0, -HEIGHT * 2, HEIGHT * 3, "y"),
      width: number(given.width, was?.width ?? WIDTH, 1, WIDTH * 4, "width"),
      height: number(given.height, was?.height ?? HEIGHT, 1, HEIGHT * 4, "height"),
      fit,
    };
    const zoom = number(given.zoom, was?.zoom ?? 1, 1, 8, "zoom");
    if (zoom !== 1) layer.zoom = zoom;
    const focusX = number(given.focusX, was?.focusX ?? 0.5, 0, 1, "focusX");
    const focusY = number(given.focusY, was?.focusY ?? 0.5, 0, 1, "focusY");
    if (focusX !== 0.5) layer.focusX = focusX;
    if (focusY !== 0.5) layer.focusY = focusY;
    const flip = typeof given.flip === "boolean" ? given.flip : was?.flip;
    if (flip) layer.flip = true;
    const rotation = number(given.rotation, was?.rotation ?? 0, -360, 360, "rotation");
    if (rotation !== 0) layer.rotation = rotation;
    const adjust = adjustOf(given.adjust, was?.adjust);
    if (adjust !== undefined && Object.values(adjust).some((one) => one !== 0)) layer.adjust = adjust;
    const shadow = shadowOf(given.shadow, was?.shadow);
    if (shadow !== undefined) layer.shadow = shadow;
    return layer;
  }
  const was = before as TextLayer | undefined;
  const text = typeof given.text === "string" ? given.text : was?.text;
  if (text === undefined || text.trim() === "") throw new Error("A text layer needs its text.");
  if (text.length > 300) throw new Error("A thumbnail's text is at most 300 characters.");
  const align = given.align ?? was?.align ?? "center";
  if (align !== "left" && align !== "center" && align !== "right") throw new Error('align is "left", "center" or "right".');
  const box = boxOf(given.box, was?.box);
  // A box is the black-box caption (Avant Garde). No box is white and red (Arabic-font-2013).
  const font = typeof given.font === "string" && given.font.trim() !== "" ? given.font.trim().slice(0, 60) : (was?.font ?? (box !== undefined ? BLACK_BOX_FONT : WHITE_RED_FONT));
  if (/["\\;{}]/.test(font)) throw new Error("font is a font's name (Arabic-font-2013, ITC Avant Garde Gothic, Montserrat).");
  const layer: TextLayer = {
    id,
    kind: "text",
    name: name ?? text.slice(0, 30),
    opacity,
    ...(hidden ? { hidden } : {}),
    text,
    x: number(given.x, was?.x ?? WIDTH / 2, -WIDTH, WIDTH * 2, "x"),
    y: number(given.y, was?.y ?? HEIGHT / 2, -HEIGHT, HEIGHT * 2, "y"),
    width: number(given.width, was?.width ?? 900, 40, WIDTH * 2, "width"),
    font,
    weight: Math.round(number(given.weight, was?.weight ?? 700, 100, 900, "weight") / 100) * 100,
    size: number(given.size, was?.size ?? 72, 8, 400, "size"),
    color: color(given.color, was?.color ?? "#ffffff", "color"),
    align,
    lineHeight: number(given.lineHeight, was?.lineHeight ?? 1.05, 0.6, 3, "lineHeight"),
  };
  // Lower case unless asked otherwise. An older layer's `uppercase` still means capitals.
  const casing = given.casing === "lower" || given.casing === "upper" || given.casing === "keep" ? given.casing : typeof given.uppercase === "boolean" ? (given.uppercase ? "upper" : "lower") : was?.casing ?? (was?.uppercase ? "upper" : "lower");
  if (casing === "upper" || casing === "keep") layer.casing = casing;
  const italic = typeof given.italic === "boolean" ? given.italic : was?.italic;
  if (italic) layer.italic = true;
  const rotation = number(given.rotation, was?.rotation ?? 0, -360, 360, "rotation");
  if (rotation !== 0) layer.rotation = rotation;
  if (box !== undefined) layer.box = box;
  // White and red (no box) never has a stroke. The black edge is the drop
  // shadow. A stroke on an older caption, or one sent with the layer, is dropped.
  const stroke = box === undefined ? undefined : strokeOf(given.stroke, was?.stroke);
  if (stroke !== undefined) layer.stroke = stroke;
  let shadow = shadowOf(given.shadow, was?.shadow);
  if (shadow === undefined && was === undefined && box === undefined && given.shadow !== null && given.shadow !== false) shadow = { ...HOUSE_SHADOW };
  // A box-less caption still carrying an older house shadow (opacity 70, size
  // 20, angle 120, and the rest of those) takes the current one. One someone
  // set themselves is left alone. `shadow: null` stays off.
  if (box === undefined && shadow !== undefined) shadow = captionShadow({ shadow }) ?? shadow;
  if (shadow !== undefined) layer.shadow = { ...shadow };
  return layer;
}

/**
 * One editable layer per thing: a copy stacked in the same place as a layer
 * already there (the same picture in the same box, the same words in the same
 * place) is never a change, it's a duplicate the next edit trips over. Change
 * the layer that's there, by id, instead.
 */
export function checkStacked(layers: Layer[]): void {
  for (let at = 0; at < layers.length; at++) {
    const one = layers[at]!;
    if (one.hidden) continue;
    for (const other of layers.slice(at + 1)) {
      if (other.hidden || other.kind !== one.kind) continue;
      if (one.kind === "image" && other.kind === "image" && one.source === other.source && Math.round(one.x) === Math.round(other.x) && Math.round(one.y) === Math.round(other.y) && Math.round(one.width) === Math.round(other.width) && Math.round(one.height) === Math.round(other.height))
        throw new Error(`"${other.name}" stacks the same picture in the same place as layer ${one.id}: change that layer instead (its adjustments live on it), or remove it first.`);
      if (one.kind === "text" && other.kind === "text" && one.text.trim().replace(/\s+/g, " ").toLowerCase() === other.text.trim().replace(/\s+/g, " ").toLowerCase() && Math.round(one.x) === Math.round(other.x) && Math.round(one.y) === Math.round(other.y))
        throw new Error(`"${other.text}" is already a caption in that place (layer ${one.id}): change that layer's words, colour or style instead of adding another on top.`);
    }
  }
}

/** A whole design as given: its layers, bottom first, each checked; ids kept apart. */
export function designOf(given: unknown, before: Design, sources: Set<string>): Design {
  const layers = isRecord(given) ? given.layers : given;
  if (!Array.isArray(layers)) throw new Error("layers is a list, bottom first.");
  if (layers.length > 40) throw new Error("At most 40 layers.");
  const byId = new Map(before.layers.map((one) => [one.id, one]));
  const seen = new Set<string>();
  const out = layers.map((one) => {
    const was = isRecord(one) && typeof one.id === "string" ? byId.get(one.id) : undefined;
    const layer = layerOf(one, was !== undefined && was.kind === (isRecord(one) ? (one.kind ?? was.kind) : was.kind) ? was : undefined, sources);
    if (seen.has(layer.id)) layer.id = newId();
    seen.add(layer.id);
    return layer;
  });
  checkStacked(out);
  return { layers: out };
}

/** The layers in a line each, for Claude: what's where. */
export function describe(design: Design): string {
  if (design.layers.length === 0) return "No layers yet: the canvas is black.";
  return design.layers
    .map((layer, index) => {
      const at = `${index + 1}. ${layer.id} "${layer.name}"${layer.hidden ? " (hidden)" : ""}${layer.opacity < 100 ? ` at ${layer.opacity}%` : ""}`;
      if (layer.kind === "image") {
        const extra = [layer.zoom ? `zoom ${layer.zoom}` : "", layer.adjust ? `adjust ${JSON.stringify(Object.fromEntries(Object.entries(layer.adjust).filter(([, value]) => value !== 0)))}` : "", layer.shadow ? "shadow" : ""].filter(Boolean).join(", ");
        return `${at}: picture ${layer.source}, ${layer.fit}, box ${Math.round(layer.x)},${Math.round(layer.y)} ${Math.round(layer.width)}×${Math.round(layer.height)}${extra ? `, ${extra}` : ""}`;
      }
      const casing = layer.casing === "upper" || (layer.casing === undefined && layer.uppercase) ? ", capitals" : layer.casing === "keep" ? ", as written" : "";
      return `${at}: text “${layer.text}”, ${layer.font} ${layer.weight} ${layer.size}px ${layer.color}${casing}, centred at ${Math.round(layer.x)},${Math.round(layer.y)} (wraps at ${Math.round(layer.width)})${layer.box ? `, box ${layer.box.color}` : ""}${layer.stroke ? `, stroke ${layer.stroke.width}px` : ""}${layer.shadow ? `, shadow spread ${layer.shadow.spread} size ${layer.shadow.size}` : ""}`;
    })
    .join("\n");
}

/** What a change to the layout did, in a few words, for undo ("changed “She smiled”", "added REC overlay"). */
export function labelOf(before: Design, after: Design): string {
  const name = (layer: Layer) => (layer.kind === "text" ? `“${layer.text.replace(/^["“”']+|["“”']+$/g, "").slice(0, 24)}”` : layer.name);
  const was = new Map(before.layers.map((one) => [one.id, one]));
  const now = new Map(after.layers.map((one) => [one.id, one]));
  const added = after.layers.filter((one) => !was.has(one.id));
  const removed = before.layers.filter((one) => !now.has(one.id));
  const changed = after.layers.filter((one) => was.has(one.id) && canonical(was.get(one.id)) !== canonical(one));
  const parts = [
    ...added.map((one) => `added ${name(one)}`),
    ...removed.map((one) => `removed ${name(one)}`),
    ...changed.map((one) => `changed ${name(one)}`),
  ];
  if (parts.length === 0) return "reordered the layers";
  return parts.length > 3 ? `${parts.slice(0, 2).join(", ")} and ${parts.length - 2} more` : parts.join(", ");
}

/** A value as JSON with its keys in order: Convex keeps an object's keys sorted, so a design read back isn't written as it was saved. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : inner,
  );
}

/** How many steps back undo can go. */
export const KEPT_STEPS = 40;

/**
 * A new layout for the thumbnail, the one before it kept for undo (redo's
 * steps dropped, as any editor does). False when nothing changed.
 */
export function record(thumb: Thumbnail, next: Design, by: string): boolean {
  if (canonical(thumb.design) === canonical(next)) return false;
  thumb.history = [...(thumb.history ?? []), { design: thumb.design, by, at: Date.now(), label: labelOf(thumb.design, next) }].slice(-KEPT_STEPS);
  thumb.future = [];
  thumb.design = next;
  thumb.render = null;
  syncVersion(thumb);
  return true;
}

/** The layout showing kept in its version's slot, once the thumbnail has versions. */
export function syncVersion(thumb: Thumbnail): void {
  if (thumb.versions === undefined || thumb.activeVersion === undefined) return;
  const active = thumb.versions.find((one) => one.id === thumb.activeVersion);
  if (active !== undefined) active.design = thumb.design;
}

/**
 * A new version (the person's "make another version", or Claude's): the layout
 * as it stands becomes a version if it isn't one yet (V1), and a copy of it
 * starts as the next, showing. Each keeps its own layers from there.
 */
export function makeVersion(thumb: Thumbnail, by: string): ThumbVersion {
  const versions = thumb.versions ?? [];
  if (versions.length === 0) {
    const first: ThumbVersion = { id: newId(), name: "V1", design: structuredClone(thumb.design), at: Date.now(), by };
    versions.push(first);
    thumb.finalVersion ??= first.id;
    // What was said about the thumbnail before it had versions was said about this one.
    for (const comment of thumb.comments ?? []) comment.version ??= first.id;
  }
  const made: ThumbVersion = { id: newId(), name: `V${versions.length + 1}`, design: structuredClone(thumb.design), at: Date.now(), by };
  thumb.versions = [...versions, made];
  thumb.activeVersion = made.id;
  thumb.history = [];
  thumb.future = [];
  thumb.render = null;
  return made;
}

/**
 * Remove a version (Sphe, Nov 4: "if version 1 is removed, version 2 becomes
 * version 1, and version 3 becomes version 2"): the ones after it move down a
 * number. If it was showing, the one after it shows (the one before, if it
 * was last); if it was final, the one now showing is. Down to one, the
 * thumbnail has no versions again: its layout is that one.
 */
export function removeVersion(thumb: Thumbnail, wanted: string): { removed: string; renamed: [string, string][]; showing: string | null; final: string | null } {
  syncVersion(thumb);
  const versions = thumb.versions ?? [];
  const at = versions.findIndex((one) => one.id === wanted || one.name.toLowerCase() === wanted.trim().toLowerCase());
  if (at < 0) throw new Error(`There's no version ${wanted}: ${versions.map((one) => one.name).join(", ") || "this thumbnail has one version"}.`);
  const removed = versions[at]!;
  const left = versions.filter((one) => one !== removed);
  if (thumb.activeVersion === removed.id) {
    const next = left[Math.min(at, left.length - 1)]!;
    thumb.activeVersion = next.id;
    thumb.design = structuredClone(next.design);
    thumb.history = [];
    thumb.future = [];
    thumb.render = null;
  }
  if (thumb.finalVersion === removed.id) thumb.finalVersion = thumb.activeVersion;
  // Its open comments are settled with it (kept, as every settled one is).
  for (const comment of thumb.comments ?? []) if (comment.version === removed.id && comment.settled === undefined) comment.settled = { by: "Edit", at: Date.now(), note: `${removed.name} was removed.` };
  const renamed: [string, string][] = [];
  left.forEach((one, index) => {
    const name = `V${index + 1}`;
    if (one.name !== name) renamed.push([one.name, name]);
    one.name = name;
  });
  const showing = left.find((one) => one.id === thumb.activeVersion)?.name ?? null;
  const final = left.find((one) => one.id === thumb.finalVersion)?.name ?? null;
  if (left.length <= 1) {
    for (const comment of thumb.comments ?? []) if (comment.version === left[0]?.id) delete comment.version;
    delete thumb.versions;
    delete thumb.activeVersion;
    delete thumb.finalVersion;
  } else thumb.versions = left;
  return { removed: removed.name, renamed, showing, final };
}

/** Take a version as the final one (what ships), whichever is showing. */
export function takeFinal(thumb: Thumbnail, wanted: string): ThumbVersion | null {
  const target = (thumb.versions ?? []).find((one) => one.id === wanted || one.name.toLowerCase() === wanted.trim().toLowerCase());
  if (target === undefined) return null;
  thumb.finalVersion = target.id;
  return target;
}

/** Show another version: the one left keeps its layout, the one taken gets its own undo timeline from here. */
export function switchVersion(thumb: Thumbnail, wanted: string): ThumbVersion | null {
  syncVersion(thumb);
  const target = (thumb.versions ?? []).find((one) => one.id === wanted || one.name.toLowerCase() === wanted.trim().toLowerCase());
  if (target === undefined || target.id === thumb.activeVersion) return null;
  thumb.design = structuredClone(target.design);
  thumb.activeVersion = target.id;
  thumb.history = [];
  thumb.future = [];
  thumb.render = null;
  return target;
}

/** One step back (undo) or forward (redo): the step taken, or null when there's none. */
export function step(thumb: Thumbnail, back: boolean): Step | null {
  const from = back ? (thumb.history ?? []) : (thumb.future ?? []);
  const taken = from.at(-1);
  if (taken === undefined) return null;
  const rest = from.slice(0, -1);
  // The layout left goes on the other side, under the same label, so the step can be taken again the other way.
  const left: Step = { design: thumb.design, by: taken.by, at: taken.at, label: taken.label };
  if (back) {
    thumb.history = rest;
    thumb.future = [...(thumb.future ?? []), left].slice(-KEPT_STEPS);
  } else {
    thumb.future = rest;
    thumb.history = [...(thumb.history ?? []), left].slice(-KEPT_STEPS);
  }
  thumb.design = taken.design;
  thumb.render = null;
  syncVersion(thumb);
  return taken;
}

// ---------------------------------------------------------------- comments

/** The open comments on the version showing (all of them while it has no versions), oldest first. */
export function openComments(thumb: Thumbnail): ThumbComment[] {
  return (thumb.comments ?? []).filter((one) => one.settled === undefined && one.version === thumb.activeVersion);
}

/** A comment pinned where the person clicked, on the version showing. */
export function addComment(thumb: Thumbnail, at: { x: number; y: number }, text: string, by: string): ThumbComment {
  const words = text.trim().slice(0, 2000);
  if (words === "") throw new Error("Write the comment.");
  if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) throw new Error("Pin the comment somewhere on the thumbnail.");
  const comments = thumb.comments ?? [];
  const comment: ThumbComment = {
    id: newId(),
    n: comments.reduce((most, one) => Math.max(most, one.n), 0) + 1,
    x: Math.round(Math.min(WIDTH, Math.max(0, at.x))),
    y: Math.round(Math.min(HEIGHT, Math.max(0, at.y))),
    text: words,
    by,
    at: Date.now(),
    ...(thumb.activeVersion !== undefined ? { version: thumb.activeVersion } : {}),
  };
  thumb.comments = [...comments, comment];
  return comment;
}

/** A comment by its number (#3, "3") or id. */
export function commentOf(thumb: Thumbnail, wanted: unknown): ThumbComment {
  const key = (typeof wanted === "string" || typeof wanted === "number" ? String(wanted) : "").trim().replace(/^#/, "");
  const found = (thumb.comments ?? []).find((one) => one.id === key || String(one.n) === key);
  if (found === undefined) throw new Error(`There's no comment ${key || "given"}: ${(thumb.comments ?? []).filter((one) => one.settled === undefined).map((one) => `#${one.n}`).join(", ") || "none open"}.`);
  return found;
}

/** The comments as Claude's message lists them: each open one, its version, where it is, what it says and the replies. */
export function describeComments(thumb: Thumbnail): string {
  const open = (thumb.comments ?? []).filter((one) => one.settled === undefined);
  if (open.length === 0) return "";
  const name = (version: string | undefined) => (version === undefined ? "" : `${thumb.versions?.find((one) => one.id === version)?.name ?? "?"}${version === thumb.activeVersion ? ", showing" : ""}; `);
  return open
    .map((one) => {
      const replies = (one.replies ?? []).map((reply) => `\n  ↳ ${reply.by === "claude" ? "you" : reply.by}: ${reply.text}`).join("");
      return `- #${one.n} (${name(one.version)}pinned at ${one.x}, ${one.y}) ${one.by}: ${one.text}${replies}`;
    })
    .join("\n");
}
