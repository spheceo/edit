// Rust's `Path` semantics, which the server leans on: `starts_with` and
// `strip_prefix` compare whole components (so /a/bc doesn't start with /a/b),
// and `join` doesn't resolve `..` the way Node's path.join does (a joined
// name stays the name it was).

import * as fs from "node:fs";
import * as nodePath from "node:path";

/** A path's components: "/" first for an absolute path, `.` and empty parts dropped. */
export function components(path: string): string[] {
  const parts = path.split("/").filter((part, index) => part !== "" && !(part === "." && index > 0));
  return path.startsWith("/") ? ["/", ...parts] : parts;
}

/** Whether `path` is `prefix` or inside it, component by component. */
export function startsWith(path: string, prefix: string): boolean {
  const a = components(path);
  const b = components(prefix);
  return b.length <= a.length && b.every((part, index) => a[index] === part);
}

/** `path` relative to `prefix` ("" when they're the same), or null when it isn't inside it. */
export function stripPrefix(path: string, prefix: string): string | null {
  if (!startsWith(path, prefix)) return null;
  return components(path).slice(components(prefix).length).join("/");
}

/** `base` joined with `parts` as Rust joins: an absolute part replaces what came before. */
export function join(base: string, ...parts: string[]): string {
  let out = base;
  for (const part of parts) {
    if (part === "") {
      if (!out.endsWith("/")) out += "/";
      continue;
    }
    if (part.startsWith("/")) out = part;
    else out = out === "" ? part : out.endsWith("/") ? out + part : `${out}/${part}`;
  }
  return out;
}

/** The last component (`file_name`), or null for "/" or "". */
export function fileName(path: string): string | null {
  const parts = components(path);
  const last = parts[parts.length - 1];
  return last === undefined || last === "/" || last === ".." ? null : last;
}

/** Everything but the last component (`parent`), or null at the root. */
export function parent(path: string): string | null {
  const parts = components(path);
  if (parts.length === 0 || (parts.length === 1 && parts[0] === "/")) return null;
  const rest = parts.slice(0, -1);
  if (rest.length === 0) return "";
  if (rest[0] === "/") return `/${rest.slice(1).join("/")}`;
  return rest.join("/");
}

/** The extension (`extension`): after the last dot of the file name, not for dotfiles. */
export function extension(path: string): string | null {
  const name = fileName(path);
  if (name === null) return null;
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? null : name.slice(dot + 1);
}

/** The file name without its extension (`file_stem`). */
export function fileStem(path: string): string | null {
  const name = fileName(path);
  if (name === null) return null;
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

/** `path` with its extension replaced (`with_extension`; "" removes it). */
export function withExtension(path: string, ext: string): string {
  const name = fileName(path);
  if (name === null) return path;
  const dot = name.lastIndexOf(".");
  const stem = dot <= 0 ? name : name.slice(0, dot);
  const dir = path.slice(0, path.length - name.length - (path.endsWith("/") ? 1 : 0));
  return `${dir}${stem}${ext === "" ? "" : `.${ext}`}`;
}

/** `canonicalize`, else the path as given (as media_drive's `canonical`). */
export function canonical(path: string): string {
  try {
    return fs.realpathSync(path);
  } catch {
    return path;
  }
}

export function isAbsolute(path: string): boolean {
  return nodePath.isAbsolute(path);
}

export function isFile(path: string): boolean {
  try {
    return fs.statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDir(path: string): boolean {
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function exists(path: string): boolean {
  try {
    fs.statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The user's home folder ($HOME, else "."). */
export function userHome(): string {
  const home = process.env.HOME;
  return home !== undefined && home !== "" ? home : ".";
}

/** A `~/…` path in the user's home; anything else as it is. */
export function expandHome(path: string): string {
  if (path.startsWith("~/")) return join(process.env.HOME ?? "", path.slice(2));
  return path;
}
