// The macOS Keychain, for the one secret Edit keeps: the refresh token from
// accounts.spheceo.com. Through `security`, with the secret on its stdin
// (`security -i` reads commands there), never in a process's arguments,
// where `ps` would show it. Each Edit home keeps its own item (the account
// is a hash of the home), so the dev server and Edit.app on one Mac are
// signed in apart: a refresh token rotates on every use, and two processes
// sharing one would sign each other out.
//
// Off macOS, or with `EDIT_KEYCHAIN_FILE` (tests), a file of mode 600.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";

const SERVICE = "Edit (accounts.spheceo.com)";

/** What a stored secret may hold: the opaque token characters, nothing `security -i` would read as more. */
const SAFE = /^[A-Za-z0-9._~+/=-]{8,4096}$/u;

function account(home: string): string {
  return `home-${createHash("sha256").update(home).digest("hex").slice(0, 16)}`;
}

function file(): string | null {
  const given = process.env.EDIT_KEYCHAIN_FILE;
  return given !== undefined && given !== "" ? given : null;
}

function run(args: string[], input: string | null): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
    child.stdin.end(input ?? "");
  });
}

function readFileStore(path: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeFileStore(path: string, values: Record<string, string>): void {
  fs.writeFileSync(path, JSON.stringify(values), { mode: 0o600 });
  fs.chmodSync(path, 0o600);
}

/** This home's stored secret, or null. */
export async function get(home: string): Promise<string | null> {
  const store = file();
  if (store !== null) return readFileStore(store)[account(home)] ?? null;
  if (process.platform !== "darwin") return null;
  const { code, out } = await run(["find-generic-password", "-s", SERVICE, "-a", account(home), "-w"], null);
  const value = out.trim();
  return code === 0 && value !== "" ? value : null;
}

/** Keeps this home's secret (replacing what was there). */
export async function set(home: string, value: string): Promise<void> {
  if (!SAFE.test(value)) throw new Error("the sign-in token has characters the Keychain can't be given safely");
  const store = file();
  if (store !== null) {
    writeFileStore(store, { ...readFileStore(store), [account(home)]: value });
    return;
  }
  if (process.platform !== "darwin") throw new Error("keeping the sign-in needs the macOS Keychain");
  // One command on stdin: `-U` updates the item if it's there.
  const { code } = await run(["-i"], `add-generic-password -U -s "${SERVICE}" -a "${account(home)}" -w "${value}"\n`);
  if (code !== 0) throw new Error("the Keychain refused to keep the sign-in");
}

/** Forgets this home's secret. */
export async function remove(home: string): Promise<void> {
  const store = file();
  if (store !== null) {
    const values = readFileStore(store);
    delete values[account(home)];
    writeFileStore(store, values);
    return;
  }
  if (process.platform !== "darwin") return;
  await run(["delete-generic-password", "-s", SERVICE, "-a", account(home)], null);
}
