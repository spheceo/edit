// Starting the server (main.rs `start`): the log, FFmpeg, the store and the
// addon, the data folder's lock, the hosts it answers to, the App with every
// package's services, the speaker watcher, cloud projects, Ctrl-C, and one
// listener per address `bindAddresses` gives.

import type { Server } from "bun";

import { createApp, hostname, type App } from "./app.ts";
import { setListening } from "./broll.ts";
import * as diag from "./diag.ts";
import { registerEditingTools } from "./edit_tools.ts";
import { ExportRegistry } from "./exports.ts";
import { listen } from "./http/server.ts";
import { registerMediaTools } from "./media_tools.ts";
import { allowedHosts } from "./http/host.ts";
import { holdLock } from "./media_drive/layout.ts";
import { initNative } from "./native/index.ts";
import { buildRouter } from "./routes.ts";
import * as seams from "./seams.ts";
import { Store } from "./store.ts";
import * as tools from "./tools.ts";
import * as update from "./update.ts";

/** A place to listen: an IP and port, as Rust's SocketAddr shows it ("127.0.0.1:7700", "[::1]:7700"). */
export interface Address {
  ip: string;
  port: number;
  v6: boolean;
}

export function showAddress(address: Address): string {
  return address.v6 ? `[${address.ip}]:${address.port}` : `${address.ip}:${address.port}`;
}

/** `text` as Rust parses a SocketAddr: `a.b.c.d:port` or `[v6]:port`; null otherwise (a host name, say). */
export function parseSocketAddr(text: string): Address | null {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(text);
  if (v4 !== null) {
    const parts = v4.slice(1, 5).map(Number);
    const port = Number(v4[5]);
    if (parts.some((part, index) => part > 255 || (v4[index + 1]!.length > 1 && v4[index + 1]!.startsWith("0")))) {
      return null;
    }
    if (port > 65535) return null;
    return { ip: parts.join("."), port, v6: false };
  }
  const v6 = /^\[([0-9A-Fa-f:.]+)\]:(\d{1,5})$/.exec(text);
  if (v6 !== null && v6[1]!.includes(":") && Number(v6[2]) <= 65535) {
    return { ip: v6[1]!, port: Number(v6[2]), v6: true };
  }
  return null;
}

/** Where to listen: the address asked for, else 127.0.0.1 and this machine's Tailscale IP. */
export function bindAddresses(host: string | null, port: number, tailscale: string | null = tailscaleIp()): Address[] {
  if (host !== null) {
    const parsed = parseSocketAddr(`${host}:${port}`);
    return parsed === null ? [] : [parsed];
  }
  const out: Address[] = [{ ip: "127.0.0.1", port, v6: false }];
  if (tailscale !== null) out.push({ ip: tailscale, port, v6: tailscale.includes(":") });
  return out;
}

const TAILSCALE = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

function run(binary: string, args: string[]): string | null {
  try {
    const output = Bun.spawnSync([binary, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5000 });
    return output.stdout.toString();
  } catch {
    return null;
  }
}

/** This machine's Tailscale IPv4 address, if Tailscale runs. */
export function tailscaleIp(): string | null {
  for (const binary of TAILSCALE) {
    const first = run(binary, ["ip", "-4"])?.split("\n")[0]?.trim();
    if (first !== undefined && parseSocketAddr(`${first}:0`) !== null) return first;
  }
  return null;
}

/** This machine's Tailscale DNS name (lowercase, no trailing dot), if Tailscale runs. */
export function tailscaleName(): string | null {
  for (const binary of TAILSCALE) {
    const out = run(binary, ["status", "--json"]);
    if (out === null) continue;
    try {
      const status = JSON.parse(out) as { Self?: { DNSName?: unknown } };
      const name = status.Self?.DNSName;
      if (typeof name !== "string") continue;
      const trimmed = name.replace(/\.+$/, "").toLowerCase();
      if (trimmed !== "") return trimmed;
    } catch {
      continue;
    }
  }
  return null;
}

/** main.rs fail: "edit: <why>" on stderr, exit 2. */
export function fail(message: string): never {
  console.error(`edit: ${message}`);
  process.exit(2);
}

/** Opens the store and starts listening. */
export function start(home: string, host: string | null, port: number): { app: App; servers: Server<unknown>[] } {
  diag.open(home);
  for (const [tool, path] of [
    ["ffmpeg", tools.ffmpeg()],
    ["ffprobe", tools.ffprobe()],
  ] as const) {
    let found = false;
    try {
      Bun.spawnSync([path, "-version"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      found = true;
    } catch {
      found = false;
    }
    if (!found) diag.warn("edit", `${tool} not found; importing and export need FFmpeg`);
  }
  diag.info("edit", `FFmpeg: ${tools.ffmpeg()} (${tools.bundled() ? "shipped with Edit" : "from PATH"})`);
  let store: Store;
  try {
    store = Store.open(home);
  } catch (error) {
    fail(`${home}: ${diag.messageOf(error)}`);
  }
  initNative({
    home: store.layout().home,
    cacheDir: store.cacheDir(),
    ffmpeg: tools.ffmpeg(),
    ffprobe: tools.ffprobe(),
    mediaFolders: store.layout().known,
  });
  store.publishLayout();
  holdLock(home);
  try {
    const drive = store.layout().drive();
    if (drive !== null) diag.info("media", `media drive: ${drive}`);
  } catch (error) {
    diag.warn("media", diag.messageOf(error));
  }
  const ip = tailscaleIp();
  const app = createApp({
    store,
    port,
    allowedHosts: allowedHosts({ host, tailscale: [ip, tailscaleName()] }),
    machine: hostname() ?? "this machine",
    services: { exports: new ExportRegistry(), updater: new update.Updater(home) },
  });
  // Tools register here; WP5's and WP6's register as their modules load (through seams).
  registerEditingTools();
  registerMediaTools();
  seams.speakers.watch(app);
  // Cloud projects (Settings → Cloud): sync, locks, and letting them go on the way out.
  optional("cloud", () => seams.cloudProjects.start(app));
  process.on("SIGINT", () => {
    void (async () => {
      try {
        await seams.cloudProjects.shutdown();
      } catch (error) {
        if (!seams.isNotPorted(error)) diag.warn("cloud", `on the way out: ${diag.messageOf(error)}`);
      }
      process.exit(130);
    })();
  });
  const router = buildRouter();
  const servers: Server<unknown>[] = [];
  for (const address of bindAddresses(host, port, ip)) {
    const shown = showAddress(address);
    try {
      servers.push(listen(app, router, address.ip, address.port) as Server<unknown>);
      console.log(`edit: http://${shown}`);
      // The first address is where map pages reach this server (main.rs set broll::LISTENING once).
      if (servers.length === 1) setListening(address.ip, address.port);
    } catch (error) {
      console.error(`edit: could not bind ${shown}: ${diag.messageOf(error)}`);
    }
  }
  if (servers.length === 0) fail(`nothing to listen on (is port ${port} taken?)`);
  console.log(`edit: data in ${home}`);
  if (update.enabled()) {
    void update
      .check()
      .then((release) => {
        if (release !== null) {
          console.log(
            `edit: ${release.tag} is out (this is ${update.VERSION}); update from the editor or run \`edit update\``,
          );
        }
      })
      .catch(() => {});
  }
  return { app, servers };
}

/** Runs a package's start-up step, which may not be ported yet (then it's skipped, quietly). */
function optional(area: string, work: () => void): void {
  try {
    work();
  } catch (error) {
    if (!seams.isNotPorted(error)) diag.warn(area, diag.messageOf(error));
  }
}
