// The macOS Keychain, for the one secret Edit keeps: the refresh token from
// accounts.spheceo.com. Through `security`, with the secret on its stdin
// (`security -i` reads commands there), never in a process's arguments,
// where `ps` would show it. Each Edit home keeps its own item (the account
// is a hash of the home), so the dev server and Edit.app on one Mac are
// signed in apart: a refresh token rotates on every use, and two processes
// sharing one would sign each other out.
//
// A build signed by Edit's team keeps its item through Security.framework
// (the addon, mac_media.m), made to trust only that program: through the
// `security` tool, which the item then trusted, any process running as the
// user could read it without a prompt (the audit, Oct 23). An item from
// before moves over the first time it's read. A build signed ad hoc (dev)
// keeps using the tool: its signature changes with every build, so an item
// trusting it would be lost on the next.
//
// Off macOS, `sign-in.json` (mode 600) in the Edit home: a Linux desktop's
// keyring is open to every process of the user too, and a server has none.
// `EDIT_KEYCHAIN_FILE` names the file instead (tests).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join } from "node:path";

import * as diag from "./diag.ts";
import { native } from "./native/index.ts";
import { EDIT_TEAM, teamOf } from "./update.ts";

const SERVICE = "Edit (accounts.spheceo.com)";

/** What a stored secret may hold: the opaque token characters, nothing `security -i` would read as more. */
const SAFE = /^[A-Za-z0-9._~+/=-]{8,4096}$/u;

function account(home: string): string {
  return `home-${createHash("sha256").update(home).digest("hex").slice(0, 16)}`;
}

function file(home: string): string | null {
  const given = process.env.EDIT_KEYCHAIN_FILE;
  if (given !== undefined && given !== "") return given;
  return process.platform === "darwin" ? null : join(home, "sign-in.json");
}

function run(args: string[], input: string | null): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let settled = false;
    // A hung `security` must not wedge sign-in forever.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("security took too long"));
    }, 15_000);
    timer.unref?.();
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    child.stderr.resume();
    child.on("error", (error) => done(() => reject(error)));
    child.on("close", (code) => done(() => resolve({ code: code ?? 1, out })));
    // Writing to a dead child's stdin raises EPIPE: that is its exit, not a crash.
    child.stdin.on("error", () => undefined);
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

/** Written beside and renamed over: a token rotated and then half written would sign the person out. */
function writeFileStore(path: string, values: Record<string, string>): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  const next = `${path}.${process.pid}.next`;
  fs.writeFileSync(next, JSON.stringify(values), { mode: 0o600 });
  fs.chmodSync(next, 0o600);
  fs.renameSync(next, path);
}

/** An item this program isn't trusted for (made by the `security` tool): errSecInteractionNotAllowed, errSecAuthFailed. */
const notOurs = (status: number) => status === -25308 || status === -25293;

let own: boolean | null = null;
/** Whether this Edit keeps its item itself: signed by Edit's team, on macOS. */
export function ownItems(): boolean {
  own ??= process.platform === "darwin" && file("") === null && teamOf(process.execPath) === EDIT_TEAM;
  return own;
}

async function toolGet(home: string): Promise<string | null> {
  const { code, out } = await run(["find-generic-password", "-s", SERVICE, "-a", account(home), "-w"], null);
  const value = out.trim();
  return code === 0 && value !== "" ? value : null;
}

async function toolSet(home: string, value: string): Promise<void> {
  // One command on stdin: `-U` updates the item if it's there.
  const { code } = await run(["-i"], `add-generic-password -U -s "${SERVICE}" -a "${account(home)}" -w "${value}"\n`);
  if (code !== 0) throw new Error("the Keychain refused to keep the sign-in");
}

async function toolRemove(home: string): Promise<void> {
  await run(["delete-generic-password", "-s", SERVICE, "-a", account(home)], null);
}

/**
 * Keeps `value` as Edit's own item. One the tool made is removed first: an
 * update over it keeps its old access, which trusts the tool.
 */
async function ownSet(home: string, value: string): Promise<void> {
  if (notOurs(native().keychainGet(SERVICE, account(home)).status)) await toolRemove(home);
  const status = native().keychainSet(SERVICE, account(home), value);
  if (status !== 0) {
    diag.warn("accounts", `the Keychain refused Edit's own item (${status}); kept through the security tool`);
    await toolSet(home, value);
  }
}

/** This home's stored secret, or null. */
export async function get(home: string): Promise<string | null> {
  const store = file(home);
  if (store !== null) return readFileStore(store)[account(home)] ?? null;
  if (ownItems()) {
    const answer = native().keychainGet(SERVICE, account(home));
    if (answer.status === 0) return answer.value ?? null;
    // Never the tool on an item of Edit's own: it would ask the user. Only one the tool made.
    if (!notOurs(answer.status)) {
      diag.warn("accounts", `reading the Keychain: ${answer.status}`);
      return null;
    }
    // An item from before: read through the tool once, then kept as Edit's own.
    const old = await toolGet(home);
    if (old !== null) await ownSet(home, old);
    return old;
  }
  return toolGet(home);
}

/** Keeps this home's secret (replacing what was there). */
export async function set(home: string, value: string): Promise<void> {
  if (!SAFE.test(value)) throw new Error("the sign-in token has characters the Keychain can't be given safely");
  const store = file(home);
  if (store !== null) {
    writeFileStore(store, { ...readFileStore(store), [account(home)]: value });
    return;
  }
  if (ownItems()) await ownSet(home, value);
  else await toolSet(home, value);
}

/** Forgets this home's secret. */
export async function remove(home: string): Promise<void> {
  const store = file(home);
  if (store !== null) {
    const values = readFileStore(store);
    delete values[account(home)];
    writeFileStore(store, values);
    return;
  }
  // Edit's own item, else one the tool made.
  if (!ownItems() || notOurs(native().keychainDelete(SERVICE, account(home)))) await toolRemove(home);
}
