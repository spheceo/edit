// A thumbnail drawn: the one drawing the editor shows and Claude looks at (the
// server's headless Chrome runs this same file, transpiled, so what Claude
// sees is what the person sees). Canvas 2D only, and no imports but types:
// the server hands it to Chrome as it is.

import type { Adjust, Design, ImageLayer, Layer, Mask, Shadow, TextLayer } from "./thumbnails";

/** A picture to draw from: an <img>, a bitmap, a canvas. */
export type Picture = { width: number; height: number };

/** A canvas's pixels (ImageData). */
type Pixels = { data: Uint8ClampedArray; width: number; height: number };

/**
 * What the drawing uses of a canvas's 2D context: the browser's
 * CanvasRenderingContext2D, said here without the DOM so the server (which
 * hands this file to Chrome as text) checks it too.
 */
export interface Context {
  canvas?: unknown;
  globalAlpha: number;
  globalCompositeOperation: string;
  filter: string;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineJoin: string;
  miterLimit: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  save(): void;
  restore(): void;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  drawImage(image: Picture | Canvas, dx: number, dy: number): void;
  drawImage(image: Picture | Canvas, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
  getImageData(x: number, y: number, width: number, height: number): Pixels;
  putImageData(image: Pixels, x: number, y: number): void;
  measureText(text: string): { width: number };
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void;
  ellipse(x: number, y: number, radiusX: number, radiusY: number, rotation: number, startAngle: number, endAngle: number): void;
  closePath(): void;
  fill(): void;
}

/** A canvas (an HTMLCanvasElement or OffscreenCanvas). */
export interface Canvas {
  width: number;
  height: number;
  getContext(kind: "2d"): unknown;
}

export interface Surfaces {
  /** A picture by its source (an image id, `asset:<id>`), or null while it isn't loaded. */
  picture(source: string): Picture | null;
  /** A blank canvas to work on. */
  canvas(width: number, height: number): Canvas;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

const touched = (adjust: Adjust | undefined): adjust is Adjust => adjust !== undefined && Object.values(adjust).some((value) => typeof value === "number" && value !== 0);

/** Draws the design on a canvas the size of the thumbnail. */
export function drawThumbnail(context: Context, design: Design, surfaces: Surfaces, width: number, height: number): void {
  context.save();
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);
  for (const layer of design.layers) {
    if (layer.hidden || layer.opacity <= 0) continue;
    drawLayer(context, layer, surfaces, width, height);
  }
  context.restore();
}

function drawLayer(context: Context, layer: Layer, surfaces: Surfaces, width: number, height: number): void {
  // Each layer drawn on a canvas of its own (its adjustments and shadow need one), then put down at its opacity.
  const own = surfaces.canvas(width, height);
  const ownContext = own.getContext("2d") as Context | null;
  if (ownContext === null) return;
  if (layer.kind === "image") {
    if (!drawPicture(ownContext, layer, surfaces, width, height)) return;
    if (layer.mask !== undefined) keepOval(ownContext, layer.mask, surfaces, width, height);
  } else drawText(ownContext, layer);
  context.save();
  context.globalAlpha = clamp(layer.opacity, 0, 100) / 100;
  const shadow = layer.kind === "text" ? captionShadow(layer) : layer.shadow;
  if (shadow !== undefined && shadow.opacity > 0) dropShadow(context, own, shadow, surfaces, width, height);
  context.drawImage(own, 0, 0);
  context.restore();
}

/**
 * Only the oval of what's drawn stays, its edge fading over `feather` px (the
 * fade sits inside the box: the oval is solid in its middle and gone at the
 * box's edge).
 */
function keepOval(context: Context, mask: Mask, surfaces: Surfaces, width: number, height: number): void {
  const shape = surfaces.canvas(width, height);
  const shapeContext = shape.getContext("2d") as Context | null;
  if (shapeContext === null) return;
  const feather = clamp(mask.feather, 0, Math.min(mask.width, mask.height) / 2);
  const blurHere = feather > 0 && !canvasBlurs(surfaces);
  shapeContext.filter = feather > 0 && !blurHere ? `blur(${(feather / 2).toFixed(2)}px)` : "none";
  shapeContext.fillStyle = "#fff";
  shapeContext.beginPath();
  shapeContext.ellipse(mask.x + mask.width / 2, mask.y + mask.height / 2, Math.max(1, mask.width / 2 - feather / 2), Math.max(1, mask.height / 2 - feather / 2), 0, 0, Math.PI * 2);
  shapeContext.fill();
  if (blurHere) blurAlpha(shapeContext, width, height, feather / 2);
  context.save();
  context.globalCompositeOperation = "destination-in";
  context.drawImage(shape, 0, 0);
  context.restore();
}

/** The picture in its box, adjusted. False when it isn't loaded. */
function drawPicture(context: Context, layer: ImageLayer, surfaces: Surfaces, width: number, height: number): boolean {
  const picture = surfaces.picture(layer.source);
  if (picture === null || picture.width === 0 || picture.height === 0) return false;
  const box = { x: layer.x, y: layer.y, w: Math.max(1, layer.width), h: Math.max(1, layer.height) };
  let sx = 0;
  let sy = 0;
  let sw = picture.width;
  let sh = picture.height;
  let dx = box.x;
  let dy = box.y;
  let dw = box.w;
  let dh = box.h;
  if (layer.fit === "cover") {
    const zoom = Math.max(1, layer.zoom ?? 1);
    const scale = Math.max(box.w / picture.width, box.h / picture.height) * zoom;
    sw = box.w / scale;
    sh = box.h / scale;
    sx = clamp((layer.focusX ?? 0.5) * picture.width - sw / 2, 0, picture.width - sw);
    sy = clamp((layer.focusY ?? 0.5) * picture.height - sh / 2, 0, picture.height - sh);
  } else if (layer.fit === "contain") {
    const scale = Math.min(box.w / picture.width, box.h / picture.height);
    dw = picture.width * scale;
    dh = picture.height * scale;
    dx = box.x + (box.w - dw) / 2;
    dy = box.y + (box.h - dh) / 2;
  }
  context.save();
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  context.translate(cx, cy);
  if (layer.rotation) context.rotate((layer.rotation * Math.PI) / 180);
  if (layer.flip) context.scale(-1, 1);
  context.translate(-cx, -cy);
  context.drawImage(picture, sx, sy, sw, sh, dx, dy, dw, dh);
  context.restore();
  if (touched(layer.adjust)) adjustPixels(context, layer.adjust, width, height);
  return true;
}

/**
 * Photoshop's few, on the pixels: exposure in stops, contrast about the middle,
 * saturation against the luminance, vibrance on the muted pixels, warmth
 * (orange up, blue down), shadows and highlights by how dark or bright each
 * pixel is, a vignette, an unsharp mask.
 */
export function adjustPixels(context: Context, adjust: Adjust, width: number, height: number): void {
  const image = context.getImageData(0, 0, width, height);
  const data = image.data;
  const gain = Math.pow(2, adjust.exposure);
  const contrast = adjust.contrast >= 0 ? 1 + adjust.contrast / 50 : 1 + adjust.contrast / 100;
  const saturation = adjust.saturation >= 0 ? 1 + adjust.saturation / 50 : 1 + adjust.saturation / 100;
  const warmth = adjust.warmth * 0.35;
  const lift = adjust.shadows / 100;
  const push = adjust.highlights / 100;
  const vignette = adjust.vignette / 100;
  const cx = width / 2;
  const cy = height / 2;
  const reach = Math.hypot(cx, cy);
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    let r = data[index]! / 255;
    let g = data[index + 1]! / 255;
    let b = data[index + 2]! / 255;
    r *= gain;
    g *= gain;
    b *= gain;
    let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (lift !== 0 || push !== 0) {
      const dark = Math.pow(clamp(1 - luma, 0, 1), 2);
      const bright = Math.pow(clamp(luma, 0, 1), 2);
      const shift = lift * dark * 0.5 + push * bright * 0.5;
      r += shift;
      g += shift;
      b += shift;
      luma += shift;
    }
    r = (r - 0.5) * contrast + 0.5;
    g = (g - 0.5) * contrast + 0.5;
    b = (b - 0.5) * contrast + 0.5;
    luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = luma + (r - luma) * saturation;
    g = luma + (g - luma) * saturation;
    b = luma + (b - luma) * saturation;
    if (adjust.vibrance !== 0) {
      // Vibrance: the muted pixels take the push, the vivid ones (skin above
      // all) are already there. How vivid this one is, 0…1 from its spread.
      const vivid = Math.max(r, g, b) - Math.min(r, g, b);
      const pushVibrance = 1 + (adjust.vibrance / 100) * clamp(1 - vivid, 0, 1);
      const grey = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = grey + (r - grey) * pushVibrance;
      g = grey + (g - grey) * pushVibrance;
      b = grey + (b - grey) * pushVibrance;
    }
    if (warmth !== 0) {
      r += warmth / 255;
      g += (warmth * 0.25) / 255;
      b -= warmth / 255;
    }
    if (vignette > 0) {
      const pixel = index / 4;
      const x = pixel % width;
      const y = (pixel - x) / width;
      const away = Math.hypot(x - cx, y - cy) / reach;
      const dim = 1 - vignette * 0.75 * Math.pow(clamp((away - 0.35) / 0.65, 0, 1), 1.6);
      r *= dim;
      g *= dim;
      b *= dim;
    }
    data[index] = clamp(Math.round(r * 255), 0, 255);
    data[index + 1] = clamp(Math.round(g * 255), 0, 255);
    data[index + 2] = clamp(Math.round(b * 255), 0, 255);
  }
  if (adjust.sharpen > 0) sharpen(data, width, height, adjust.sharpen / 100);
  context.putImageData(image, 0, 0);
}

/** An unsharp mask over the 3×3 neighbours. */
function sharpen(data: Uint8ClampedArray, width: number, height: number, amount: number): void {
  const source = new Uint8ClampedArray(data);
  const strength = amount * 1.5;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const at = (y * width + x) * 4;
      if (source[at + 3] === 0) continue;
      for (let channel = 0; channel < 3; channel++) {
        const centre = source[at + channel]!;
        const around =
          (source[at - 4 + channel]! + source[at + 4 + channel]! + source[at - width * 4 + channel]! + source[at + width * 4 + channel]!) / 4;
        data[at + channel] = clamp(Math.round(centre + (centre - around) * strength), 0, 255);
      }
    }
  }
}

/** The words as drawn: lower case unless asked otherwise. */
export function shownText(layer: Pick<TextLayer, "text" | "uppercase" | "casing">): string {
  const casing = layer.casing ?? (layer.uppercase ? "upper" : "lower");
  if (casing === "upper") return layer.text.toUpperCase();
  if (casing === "keep") return layer.text;
  return layer.text.toLowerCase();
}

/**
 * The house drop shadow for white and red (Nov 4): opacity 100, spread 36,
 * size 32, angle 90. Angle 90 is the light from above, so the shadow falls
 * straight down; distance 6 is how far. The drawing turns Size and Spread
 * into Photoshop's solid edge and blur.
 */
export const HOUSE_SHADOW: Shadow = { color: "#000000", opacity: 100, angle: 90, distance: 6, spread: 36, size: 32 };

/**
 * What a box-less caption used to be given, before those numbers. One still
 * carrying any of these is drawn with `HOUSE_SHADOW`. A shadow someone set
 * themselves, and a black box's shadow, stay as they are.
 */
const EARLIER_SHADOWS: readonly Shadow[] = [
  { color: "#000000", opacity: 70, angle: 120, distance: 6, spread: 20, size: 20 },
  { color: "#000000", opacity: 75, angle: 120, distance: 6, spread: 20, size: 18 },
  { color: "#000000", opacity: 100, angle: 120, distance: 6, spread: 36, size: 32 },
];

const sameShadow = (a: Shadow, b: Shadow): boolean => a.color.toLowerCase() === b.color.toLowerCase() && a.opacity === b.opacity && a.angle === b.angle && a.distance === b.distance && a.spread === b.spread && a.size === b.size;

/** The shadow a caption is drawn with. A box-less one still on an older house shadow takes the current one. */
export function captionShadow(layer: Pick<TextLayer, "box" | "shadow">): Shadow | undefined {
  const shadow = layer.shadow;
  if (shadow === undefined || layer.box !== undefined) return shadow;
  return EARLIER_SHADOWS.some((one) => sameShadow(shadow, one)) ? HOUSE_SHADOW : shadow;
}

/**
 * Photoshop's drop shadow as a solid spread (px) and the Gaussian sigma that
 * canvas `blur()` takes. Spread is the share of Size that stays solid; the
 * rest is the blur. Photoshop's Size is a little tighter than a CSS box-shadow
 * of the same radius (about 1.136×), and a box-shadow radius is twice the sigma.
 */
export function shadowMetrics(shadow: Shadow): { spread: number; sigma: number } {
  const spread = (shadow.size * clamp(shadow.spread, 0, 100)) / 100;
  const blur = Math.max(0, shadow.size - spread);
  return { spread, sigma: blur / (2 * 1.136364) };
}

/** The text's lines, wrapped at its width. */
export function linesOf(context: Context, layer: TextLayer): string[] {
  context.font = fontOf(layer);
  const text = shownText(layer);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const next = line === "" ? word : `${line} ${word}`;
      if (line !== "" && context.measureText(next).width > layer.width) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

export const fontOf = (layer: TextLayer): string => `${layer.italic ? "italic " : ""}${Math.round(layer.weight)} ${layer.size}px "${layer.font}", "Helvetica Neue", Arial, sans-serif`;

/** The text's box on the canvas (before rotation): for the editor's handles and the box behind it. */
export function textBounds(context: Context, layer: TextLayer): { x: number; y: number; width: number; height: number; lines: string[] } {
  const lines = linesOf(context, layer);
  const step = layer.size * layer.lineHeight;
  const widest = Math.max(1, ...lines.map((line) => context.measureText(line).width));
  const tall = step * (lines.length - 1) + layer.size;
  const left = layer.align === "left" ? layer.x - layer.width / 2 : layer.align === "right" ? layer.x + layer.width / 2 - widest : layer.x - widest / 2;
  return { x: left, y: layer.y - tall / 2, width: widest, height: tall, lines };
}

function drawText(context: Context, layer: TextLayer): void {
  const { x, y, width, height, lines } = textBounds(context, layer);
  context.save();
  if (layer.rotation) {
    context.translate(layer.x, layer.y);
    context.rotate((layer.rotation * Math.PI) / 180);
    context.translate(-layer.x, -layer.y);
  }
  if (layer.box !== undefined && layer.box.opacity > 0) {
    context.save();
    context.globalAlpha = clamp(layer.box.opacity, 0, 100) / 100;
    context.fillStyle = layer.box.color;
    roundRect(context, x - layer.box.padX, y - layer.box.padY, width + layer.box.padX * 2, height + layer.box.padY * 2, layer.box.radius);
    context.fill();
    context.restore();
  }
  context.font = fontOf(layer);
  context.textBaseline = "middle";
  context.textAlign = "left";
  const step = layer.size * layer.lineHeight;
  lines.forEach((line, index) => {
    const lineWidth = context.measureText(line).width;
    const left = layer.align === "left" ? x : layer.align === "right" ? x + width - lineWidth : x + (width - lineWidth) / 2;
    const middle = y + layer.size / 2 + step * index;
    // White and red (no box) has no stroke. The black edge is the drop shadow.
    // A stroke left on an older caption is not drawn.
    if (layer.box !== undefined && layer.stroke !== undefined && layer.stroke.width > 0) {
      context.lineJoin = "round";
      context.miterLimit = 2;
      context.lineWidth = layer.stroke.width * 2;
      context.strokeStyle = layer.stroke.color;
      context.strokeText(line, left, middle);
    }
    context.fillStyle = layer.color;
    context.fillText(line, left, middle);
  });
  context.restore();
}

function roundRect(context: Context, x: number, y: number, width: number, height: number, radius: number): void {
  const r = clamp(radius, 0, Math.min(width, height) / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

/**
 * Photoshop's drop shadow under what `own` holds: the shape's silhouette in the
 * shadow's colour, choked solid by the spread (a share of the size), blurred by
 * the rest of the size, and moved `distance` away from the light's angle.
 */
function dropShadow(context: Context, own: Canvas, shadow: Shadow, surfaces: Surfaces, width: number, height: number): void {
  const { spread, sigma } = shadowMetrics(shadow);
  const silhouette = surfaces.canvas(width, height);
  const paint = silhouette.getContext("2d") as Context | null;
  if (paint === null) return;
  // Spread: the shape drawn round a circle of that radius, so it grows solid before it softens.
  const rings = spread <= 0 ? [[0, 0]] : ringOf(spread);
  for (const [ox, oy] of rings) paint.drawImage(own, ox!, oy!);
  // A canvas that doesn't blur with `filter` (WebKit's, in the desktop window) has it blurred here instead.
  const blurHere = sigma > 0.05 && !canvasBlurs(surfaces);
  if (blurHere) blurAlpha(paint, width, height, sigma);
  paint.globalCompositeOperation = "source-in";
  paint.fillStyle = shadow.color;
  paint.fillRect(0, 0, width, height);
  const radians = (shadow.angle * Math.PI) / 180;
  const dx = -Math.cos(radians) * shadow.distance;
  const dy = Math.sin(radians) * shadow.distance;
  context.save();
  context.globalAlpha *= clamp(shadow.opacity, 0, 100) / 100;
  if (sigma > 0.05 && !blurHere) context.filter = `blur(${sigma.toFixed(2)}px)`;
  context.drawImage(silhouette, dx, dy);
  context.restore();
}

function ringOf(radius: number): number[][] {
  const out: number[][] = [];
  const steps = Math.max(8, Math.min(48, Math.ceil(radius * 3)));
  for (let ring = radius; ring > 0; ring -= Math.max(1, radius / 3)) {
    for (let index = 0; index < steps; index++) {
      const angle = (index / steps) * Math.PI * 2;
      out.push([Math.cos(angle) * ring, Math.sin(angle) * ring]);
    }
  }
  out.push([0, 0]);
  return out;
}

// ── A blur where the canvas won't (Nov 5, the desktop window) ──
//
// WebKit, which shows Edit's desktop window, ignores a 2D canvas's `filter`:
// a shadow there was its silhouette drawn hard, an outline instead of a soft
// shadow, on screen and in a download made from the window. Chrome (the
// browser, the server's renderer) blurs it itself.

/** Whether this browser's canvas blurs with `filter`: one blurred pixel, its neighbour read. Asked once. */
let blurs: boolean | null = null;
function canvasBlurs(surfaces: Surfaces): boolean {
  if (blurs !== null) return blurs;
  const test = surfaces.canvas(9, 1).getContext("2d") as Context | null;
  if (test === null) return (blurs = true);
  test.filter = "blur(2px)";
  test.fillStyle = "#000";
  test.fillRect(4, 0, 1, 1);
  test.filter = "none";
  blurs = test.getImageData(2, 0, 1, 1).data[3]! > 0;
  return blurs;
}

/** A Gaussian blur (`sigma` px) of what's drawn, by its alpha: three box blurs each way, the edges fading into nothing. */
function blurAlpha(context: Context, width: number, height: number, sigma: number): void {
  const pixels = context.getImageData(0, 0, width, height);
  blurPixelsAlpha(pixels, sigma);
  context.putImageData(pixels, 0, 0);
}

/** `blurAlpha` on the pixels themselves (their colour left as it is; a fill after gives it). */
export function blurPixelsAlpha(pixels: Pixels, sigma: number): void {
  const { width, height, data } = pixels;
  const alpha = new Float32Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3]!;
  const scratch = new Float32Array(alpha.length);
  for (const radius of boxesFor(sigma)) {
    boxBlur(alpha, scratch, width, height, radius, true);
    boxBlur(scratch, alpha, width, height, radius, false);
  }
  for (let i = 0; i < alpha.length; i++) data[i * 4 + 3] = alpha[i]!;
}

/** The three box radii whose blurs together make a Gaussian of `sigma`. */
function boxesFor(sigma: number): number[] {
  const ideal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower--;
  const upper = lower + 2;
  const lowers = Math.round((12 * sigma * sigma - 3 * lower * lower - 12 * lower - 9) / (-4 * lower - 4));
  return [0, 1, 2].map((index) => ((index < lowers ? lower : upper) - 1) / 2);
}

/** One box blur of `radius` along rows (or columns), from `from` into `to`. */
function boxBlur(from: Float32Array, to: Float32Array, width: number, height: number, radius: number, rows: boolean): void {
  const [lines, length, step, stride] = rows ? [height, width, 1, width] : [width, height, width, 1];
  const size = 2 * radius + 1;
  for (let line = 0; line < lines; line++) {
    const start = line * stride;
    const at = (index: number) => (index >= 0 && index < length ? from[start + index * step]! : 0);
    let sum = 0;
    for (let index = -radius; index <= radius; index++) sum += at(index);
    for (let index = 0; index < length; index++) {
      to[start + index * step] = sum / size;
      sum += at(index + radius + 1) - at(index - radius);
    }
  }
}
