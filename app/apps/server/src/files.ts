// Writing files safely (atomic writes and friends), apart from the
// store so the media drive's layout can use them without importing it.

import * as fs from "node:fs";

let nextId = 0;

/** A number no other file this process makes has (temporary names, project ids). */
export function nextFileId(): number {
  return nextId++;
}

/** Milliseconds since the Unix epoch. */
export function nowMs(): number {
  return Date.now();
}

/**
 * Writes through a temporary file, so a crash mid-write leaves the old file
 * whole. Synchronous: a project's commit must land before anything else can
 * read or write it.
 */
export function writeAtomic(path: string, bytes: string | Uint8Array): void {
  const tmp = `${path}.${process.pid}-${nextFileId()}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "wx");
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, path);
  } catch (error) {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * `std::fs::copy` as it is on macOS (fclonefileat, else fcopyfile with
 * COPYFILE_ALL): the copy keeps the original's times, so a file copied again
 * unchanged keeps its media key (size and mtime) and the analysis made for it.
 * Node's copyFileSync gives the copy the time of copying.
 */
export function copyFile(from: string, to: string): void {
  fs.copyFileSync(from, to);
  const touched = Bun.spawnSync(["touch", "-r", from, to], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  if (touched.exitCode !== 0) {
    const stat = fs.statSync(from);
    fs.utimesSync(to, stat.atime, stat.mtime);
  }
}

/** The message of a Node file error, as Rust's io::Error shows it ("No such file or directory (os error 2)"). */
export function ioMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    const errno = (error as NodeJS.ErrnoException).errno;
    const described = IO_TEXT[code ?? ""];
    if (described !== undefined && errno !== undefined) return `${described} (os error ${Math.abs(errno)})`;
    return error.message;
  }
  return String(error);
}

const IO_TEXT: Record<string, string> = {
  ENOENT: "No such file or directory",
  EACCES: "Permission denied",
  EEXIST: "File exists",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  ENOSPC: "No space left on device",
  EROFS: "Read-only file system",
  ENOTEMPTY: "Directory not empty",
  EXDEV: "Cross-device link",
  EPERM: "Operation not permitted",
  EBUSY: "Resource busy",
};

/**
 * A state file's JSON (`reviews.json`, `cloud/projects.json`, `jobs.json`…):
 * undefined when there's none. One that won't read or parse is set aside
 * (`<path>.broken-<ms>`, a warning to `warn`) rather than read as empty, so
 * the next write never replaces what it held (the audit, Oct 23).
 */
export function readState(path: string, warn: (message: string) => void = () => {}): unknown {
  let text: string;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    setAside(path, `couldn't be read (${ioMessage(error)})`, warn);
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    setAside(path, `isn't valid JSON (${(error as Error).message})`, warn);
    return undefined;
  }
}

function setAside(path: string, why: string, warn: (message: string) => void): void {
  const aside = `${path}.broken-${nowMs()}`;
  try {
    fs.renameSync(path, aside);
    warn(`${path} ${why}: kept as ${aside}, starting it again`);
  } catch (error) {
    warn(`${path} ${why}, and couldn't be set aside (${ioMessage(error)})`);
    throw new Error(`${path} ${why}: Edit won't write over it; move it away and restart`);
  }
}
