// This computer, as accounts.spheceo.com's Fixing page knows it: a stable id
// and its name. The id hashes the Mac's hardware UUID (`IOPlatformUUID`), so
// Edit and Writer on one Mac are one computer; Writer works it out the same
// way (`src-tauri/src/machine.rs`). Linux (`edit serve`) uses /etc/machine-id;
// failing both, the host name. Only the hash leaves it.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { hostname } from "node:os";

let cached: string | null = null;

/** The computer's id: the first 24 hex characters of SHA-256 of `spheceo-machine:<hardware id>`. */
export function id(): string {
  cached ??= hashed(hardwareId());
  return cached;
}

/** The computer's own name ("Sphe's MacBook Pro"), else its host name. */
export function name(): string {
  try {
    const named = execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (named !== "") return named.slice(0, 80);
  } catch {
    // Not a Mac.
  }
  return hostname().slice(0, 80) || "this computer";
}

export function hashed(hardware: string): string {
  return createHash("sha256").update(`spheceo-machine:${hardware}`).digest("hex").slice(0, 24);
}

/** `"IOPlatformUUID" = "…"` in ioreg's answer. */
export function platformUuid(ioreg: string): string | null {
  const line = ioreg.split("\n").find((one) => one.includes('"IOPlatformUUID"'));
  const value = line?.split("=")[1]?.trim().replace(/^"|"$/g, "");
  return value ? value : null;
}

function hardwareId(): string {
  try {
    const uuid = platformUuid(execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    if (uuid !== null) return uuid;
  } catch {
    // Not a Mac.
  }
  try {
    const machine = fs.readFileSync("/etc/machine-id", "utf8").trim();
    if (machine !== "") return machine;
  } catch {
    // No machine-id.
  }
  return hostname() || "unknown";
}
