// Comparing what the two servers said: JSON with key order ignored, floats
// within 1e-4 relative, MCP text content parsed, images by their decoded
// bytes, and each side's own volatile parts (its home, ports, project ids,
// timestamps, durations) replaced by placeholders first.

import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import type { Side } from "./servers.ts";

/** Keys whose values are clocks or timings: shown as "<t>" when present. */
const VOLATILE_KEYS = new Set([
  "uptime",
  "timings",
  "took",
  "took_ms",
  "elapsed",
  "elapsed_ms",
  "ms",
  "updated",
  "updatedAt",
  "updated_at",
  "started",
  "started_at",
  "finished",
  "finished_at",
  "created",
  "createdAt",
  "modified",
  "mtime",
  "expires",
  "expiresAt",
  "lease",
  "heartbeat",
  "since",
  "checked",
  "wall_ms",
  "seconds_taken",
]);

/** Keys dropped entirely (logs, versions, per-machine noise). */
const DROPPED_KEYS = new Set(["lines", "version", "ffmpeg"]);

export interface Context {
  side: Side;
  /** Strings to replace, longest first (the home, the user, the mock, the port, ids). */
  replacements: [string, string][];
}

export function contextOf(side: Side, mock: string, ids: Map<string, string>, runDir?: string): Context {
  const replacements: [string, string][] = [];
  const add = (from: string, to: string) => {
    if (from !== "") replacements.push([from, to]);
  };
  for (const path of [side.home, side.user]) {
    const label = path === side.home ? "<home>" : "<user>";
    add(path, label);
    try {
      add(fs.realpathSync(path), label);
    } catch {
      // not there yet
    }
    if (path.startsWith("/tmp/")) add(`/private${path}`, label);
  }
  if (runDir !== undefined) {
    // Each side's own export and media-drive folders.
    for (const folder of ["export", "drive"]) {
      const path = `${runDir}/${folder}-${side.name}`;
      add(path, `<${folder}>`);
      if (path.startsWith("/tmp/")) add(`/private${path}`, `<${folder}>`);
    }
  }
  add(mock, "<mock>");
  add(mock.replace("http://", ""), "<mock-host>");
  add(`127.0.0.1:${side.port}`, "<server>");
  add(`localhost:${side.port}`, "<server>");
  for (const [id, label] of ids) add(id, label);
  replacements.sort((a, b) => b[0].length - a[0].length);
  return { side, replacements };
}

export function replaceText(text: string, context: Context): string {
  let out = text;
  for (const [from, to] of context.replacements) out = out.split(from).join(to);
  // Clocks inside strings: ISO times and ms since the epoch.
  out = out.replace(/\b20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)?/g, "<iso>");
  out = out.replace(/(?<![0-9])1[789]\d{11}(?![0-9])/g, "<ms>");
  return out;
}

const isTime = (value: number) => value > 1.6e12 && value < 2.2e12;

/** `value` with this side's volatile parts replaced (JSON in strings parsed when `parseText`). */
export function normalize(value: unknown, context: Context, key = ""): unknown {
  if (typeof value === "string") {
    const text = replaceText(value, context);
    if (VOLATILE_KEYS.has(key)) return "<t>";
    return text;
  }
  if (typeof value === "number") {
    if (VOLATILE_KEYS.has(key) || isTime(value)) return "<t>";
    return value;
  }
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map((item) => normalize(item, context));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [field, item] of Object.entries(value)) {
      if (DROPPED_KEYS.has(field)) continue;
      if (VOLATILE_KEYS.has(field) && item !== null && typeof item !== "object") {
        out[field] = "<t>";
        continue;
      }
      if (field === "stamps" && item !== null && typeof item === "object") {
        // A preview file's version (its size and mtime): only whether it's there.
        out[field] = Object.fromEntries(Object.entries(item).map(([name, stamp]) => [name, stamp === null ? null : "<stamp>"]));
        continue;
      }
      out[replaceText(field, context)] = normalize(item, context, field);
    }
    return out;
  }
  return value;
}

/** MCP content: text parsed as JSON where it is JSON (whole, or after a "label: " prefix). */
export function parseText(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { json: JSON.parse(trimmed) };
    } catch {
      // not JSON
    }
  }
  // "label: {json}" (also "[3] update_clip: updated c1: {json}"): the first ": {" / ": [" whose rest parses.
  for (let at = trimmed.indexOf(": "); at >= 0 && at < 400; at = trimmed.indexOf(": ", at + 1)) {
    const rest = trimmed.slice(at + 2);
    if (!rest.startsWith("{") && !rest.startsWith("[")) continue;
    try {
      return { prefix: trimmed.slice(0, at), json: JSON.parse(rest) };
    } catch {
      // not JSON from here
    }
  }
  return { text };
}

export interface Image {
  image: Uint8Array;
  mime: string;
}

export function isImage(value: unknown): value is Image {
  return value !== null && typeof value === "object" && (value as Image).image instanceof Uint8Array;
}

/** An MCP tools/call result made comparable: texts parsed, images kept as bytes. */
export function mcpResult(result: unknown): unknown {
  if (result === null || typeof result !== "object") return result;
  const { content, ...rest } = result as { content?: unknown[] };
  if (!Array.isArray(content)) return result;
  return {
    ...rest,
    content: content.map((item) => {
      const part = item as { type?: string; text?: string; data?: string; mimeType?: string };
      if (part.type === "text") return parseText(part.text ?? "");
      if (part.type === "image") return { image: new Uint8Array(Buffer.from(part.data ?? "", "base64")), mime: part.mimeType ?? "" };
      return part;
    }),
  };
}

export interface Difference {
  path: string;
  rust: unknown;
  ts: unknown;
  note?: string;
}

function close(a: number, b: number): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= Math.max(1e-4 * scale, 1e-9);
}

function short(value: unknown): unknown {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return value;
  return text.length > 400 ? `${text.slice(0, 400)}… (${text.length} chars)` : value;
}

/** Decoded pixels of an encoded image (ffmpeg to RGBA), for images whose bytes differ. */
function pixels(image: Uint8Array): { width: number; height: number; data: Uint8Array } | null {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "parity-image-"));
  try {
    const file = nodePath.join(dir, "in");
    fs.writeFileSync(file, image);
    const size = Bun.spawnSync(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]);
    const [width, height] = size.stdout.toString().trim().split(",").map(Number);
    const raw = Bun.spawnSync(["ffmpeg", "-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
    if (raw.exitCode !== 0 || !width || !height) return null;
    return { width, height, data: new Uint8Array(raw.stdout) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function compareImages(a: Image, b: Image, path: string, out: Difference[]): void {
  if (a.mime !== b.mime) out.push({ path: `${path}.mime`, rust: a.mime, ts: b.mime });
  if (Buffer.from(a.image).equals(Buffer.from(b.image))) return;
  const pa = pixels(a.image);
  const pb = pixels(b.image);
  if (pa === null || pb === null) {
    out.push({ path, rust: `${a.image.length} bytes`, ts: `${b.image.length} bytes`, note: "an image didn't decode" });
    return;
  }
  if (pa.width !== pb.width || pa.height !== pb.height) {
    out.push({ path, rust: `${pa.width}×${pa.height}`, ts: `${pb.width}×${pb.height}`, note: "image sizes differ" });
    return;
  }
  let differing = 0;
  let most = 0;
  for (let index = 0; index < pa.data.length; index++) {
    const delta = Math.abs(pa.data[index]! - pb.data[index]!);
    if (delta !== 0) differing++;
    if (delta > most) most = delta;
  }
  if (differing > 0) {
    out.push({
      path,
      rust: `${pa.width}×${pa.height}`,
      ts: `${pb.width}×${pb.height}`,
      note: `decoded pixels differ: ${differing} of ${pa.data.length} bytes, by up to ${most}`,
    });
  }
}

/** Every difference between `a` (Rust's, normalized) and `b` (TS's). */
export function compare(a: unknown, b: unknown, path = "", out: Difference[] = []): Difference[] {
  if (isImage(a) && isImage(b)) {
    compareImages(a, b, path, out);
    return out;
  }
  if (typeof a === "number" && typeof b === "number") {
    if (!close(a, b)) out.push({ path, rust: a, ts: b });
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push({ path: `${path}.length`, rust: a.length, ts: b.length });
    }
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index++) compare(a[index], b[index], `${path}[${index}]`, out);
    if (a.length !== b.length) {
      const extra = a.length > b.length ? a.slice(length) : b.slice(length);
      out.push({ path: `${path}[${length}…]`, rust: a.length > b.length ? short(extra) : undefined, ts: a.length > b.length ? undefined : short(extra) });
    }
    return out;
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of [...keys].sort()) {
      const left = (a as Record<string, unknown>)[key];
      const right = (b as Record<string, unknown>)[key];
      if (!(key in a)) out.push({ path: `${path}.${key}`, rust: "(missing)", ts: short(right) });
      else if (!(key in b)) out.push({ path: `${path}.${key}`, rust: short(left), ts: "(missing)" });
      else compare(left, right, `${path}.${key}`, out);
    }
    return out;
  }
  if (a !== b) out.push({ path, rust: short(a), ts: short(b) });
  return out;
}

/** Texts (project files) compared byte for byte; the first differing line shown. */
export function compareText(a: string, b: string, path: string, out: Difference[]): void {
  if (a === b) return;
  const left = a.split("\n");
  const right = b.split("\n");
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if (left[index] !== right[index]) {
      out.push({
        path: `${path}:${index + 1}`,
        rust: short(left.slice(Math.max(0, index - 1), index + 3).join("\n")),
        ts: short(right.slice(Math.max(0, index - 1), index + 3).join("\n")),
        note: `${left.length} vs ${right.length} lines`,
      });
      return;
    }
  }
}
