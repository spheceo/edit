// A headless Chrome that Edit drives over the DevTools protocol: started on a
// profile of its own, one page, commands sent and answered by id. The one
// place for it from Nov 10 (effects.ts is its first user); the two older
// copies of this handshake (thumbnails/render.ts, evidence_capture.ts) are to
// move onto it.

import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import * as diag from "./diag.ts";
import * as seams from "./seams.ts";

export interface Page {
  /** One DevTools command and its answer (`waitMs`: how long before it's given up on, a minute unless said). */
  call(method: string, params?: Record<string, unknown>, waitMs?: number): Promise<Record<string, unknown>>;
  /** A JavaScript expression's value in the page, its promise waited for; what the page threw is the error. */
  evaluate<T>(expression: string, waitMs?: number): Promise<T>;
  /** Chrome went away (it was closed, it crashed, its connection dropped). */
  readonly closed: boolean;
  /** Chrome stopped and its profile removed. */
  close(): void;
}

export interface Opening {
  /** The profile folder's prefix under the temp folder ("edit-effect-"): names whose Chrome it is. */
  profile: string;
  /** The page's size in CSS pixels, drawn one device pixel each. */
  width: number;
  height: number;
  /** Draw on the graphics card (Metal on a Mac, Vulkan on Linux, where headless Chrome otherwise draws on the CPU). */
  gpu?: boolean;
  /** What it's for, in an error's words: "Looking at an effect". */
  what: string;
}

/** The Chromes this Edit started and hasn't closed: leaving closes them (an exit handler can't wait on a promise). */
const started = new Set<ReturnType<typeof Bun.spawn>>();
process.on("exit", () => {
  for (const child of started) child.kill();
});

const swept = new Set<string>();

/**
 * Chromes an Edit before this one left running on `profile` (a restart that
 * couldn't say goodbye: a crash, `bun --watch`, an update's exec): whatever
 * has nobody left to answer to is closed, its profile gone. Once a prefix.
 */
function sweepOrphans(profile: string): void {
  if (swept.has(profile)) return;
  swept.add(profile);
  try {
    const listed = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="]).stdout.toString();
    for (const line of listed.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match === null || match[2] !== "1" || !match[3]!.includes(`--user-data-dir=${join(os.tmpdir(), profile)}`)) continue;
      process.kill(Number(match[1]));
      const dir = /--user-data-dir=(\S+)/.exec(match[3]!)?.[1];
      if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
      diag.info("chrome", `closed a Chrome an earlier Edit left running (pid ${match[1]}, ${profile})`);
    }
  } catch (error) {
    diag.warn("chrome", `looking for Chromes left running: ${diag.messageOf(error)}`);
  }
}

/** A Chrome with one blank page, ready for commands. */
export async function open(opening: Opening): Promise<Page> {
  const binary = seams.broll.chrome();
  if (binary === null) throw new Error(`${opening.what} needs Google Chrome installed.`);
  sweepOrphans(opening.profile);
  const profile = fs.mkdtempSync(join(os.tmpdir(), opening.profile));
  const gpu = opening.gpu !== true ? [] : process.platform === "darwin" ? ["--use-angle=metal"] : process.platform === "linux" ? ["--use-angle=vulkan"] : [];
  const child = Bun.spawn(
    [
      binary,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--mute-audio",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      // Room for the page at full size: a headless window loses some height to the browser's own frame.
      `--window-size=${opening.width + 64},${opening.height + 200}`,
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      ...gpu,
      "about:blank",
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  started.add(child);
  void child.exited.then(() => started.delete(child));
  const stop = () => {
    child.kill();
    fs.rmSync(profile, { recursive: true, force: true });
  };
  try {
    return await connect(profile, opening, stop);
  } catch (error) {
    // A Chrome that never got as far as its page goes, with its profile: none is left running.
    stop();
    throw error;
  }
}

async function connect(profile: string, opening: Opening, stop: () => void): Promise<Page> {
  const until = Date.now() + 15_000;
  const portFile = join(profile, "DevToolsActivePort");
  while (!fs.existsSync(portFile) && Date.now() < until) await Bun.sleep(50);
  const port = Number(fs.existsSync(portFile) ? fs.readFileSync(portFile, "utf8").split("\n")[0] : 0);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`${opening.what}: Chrome didn't start.`);
  const tabs = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const target = tabs.find((one) => one.type === "page");
  if (target === undefined) throw new Error(`${opening.what}: Chrome has no page.`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${opening.what}: Chrome's connection timed out.`)), 5000);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`${opening.what}: Chrome's connection failed.`));
    };
  });
  let next = 0;
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  socket.onmessage = (event) => {
    let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
    try {
      message = JSON.parse(String(event.data)) as typeof message;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const own = pending.get(message.id);
    if (own === undefined) return;
    pending.delete(message.id);
    clearTimeout(own.timer);
    if (message.error) own.reject(new Error(message.error.message ?? "Chrome refused"));
    else own.resolve(message.result ?? {});
  };
  const state = { closed: false };
  socket.onclose = () => {
    state.closed = true;
    for (const one of pending.values()) {
      clearTimeout(one.timer);
      one.reject(new Error("Chrome closed"));
    }
    pending.clear();
  };
  const call: Page["call"] = (method, params = {}, waitMs = 60_000) =>
    new Promise((resolve, reject) => {
      if (state.closed) return reject(new Error("Chrome closed"));
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Chrome ${method} timed out`));
      }, waitMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate: Page["evaluate"] = async <T>(expression: string, waitMs?: number) => {
    const answer = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, waitMs);
    const thrown = answer.exceptionDetails as { text?: string; exception?: { description?: string; value?: unknown } } | undefined;
    if (thrown !== undefined) {
      const value = thrown.exception?.value;
      throw new Error(thrown.exception?.description ?? (value === undefined ? undefined : JSON.stringify(value)) ?? thrown.text ?? "the page threw");
    }
    return (answer.result as { value?: T } | undefined)?.value as T;
  };
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: opening.width, height: opening.height, deviceScaleFactor: 1, mobile: false });
  return {
    call,
    evaluate,
    get closed() {
      return state.closed;
    },
    close() {
      state.closed = true;
      try {
        socket.close();
      } catch {}
      stop();
    },
  };
}
