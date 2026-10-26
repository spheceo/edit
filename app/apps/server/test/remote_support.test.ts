import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import type { ConvexClient } from "convex/browser";
import type { App } from "../src/app.ts";
import { execute, recover } from "../src/remote_support.ts";
import { RemoteCommandReceipts } from "../src/remote_commands.ts";
import { BUILD } from "../src/version.ts";

function fixture(running = false) {
  const home = fs.mkdtempSync(join(os.tmpdir(), "edit-support-"));
  fs.writeFileSync(join(home, "remote-support.json"), JSON.stringify({ device: "device1", enabled: true }));
  const calls: Record<string, unknown>[] = [];
  let installs = 0;
  const app = { store: { home }, agents: { hasRunningTurns: () => running }, exports: { running: () => false }, updater: {
    status: async () => ({ enabled: true, phase: installs ? "downloading" : "idle", latest: BUILD }),
    install: async () => { installs++; return {}; },
  } } as unknown as App;
  const c = { mutation: async (_name: unknown, args: Record<string, unknown>) => { calls.push(args); return true; } } as unknown as ConvexClient;
  return { home, app, c, calls, installs: () => installs, clean: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test("an update is claimed once and confirmed after restart", async () => {
  const f = fixture();
  try {
    const item = { commandId: "cmd1", deviceId: "device1", kind: "update" as const, expiresAt: Date.now() + 60_000 };
    await execute(f.app, f.c, item);
    await execute(f.app, f.c, item);
    expect(f.installs()).toBe(1);
    expect(new RemoteCommandReceipts(f.home, "device1").read("cmd1")?.state).toBe("claimed");
    await recover(f.app, f.c);
    expect(new RemoteCommandReceipts(f.home, "device1").read("cmd1")?.state).toBe("complete");
    expect(f.calls.some(call => call.state === "complete")).toBe(true);
  } finally { f.clean(); }
});

test("a remote update refuses to interrupt an agent", async () => {
  const f = fixture(true);
  try {
    await execute(f.app, f.c, { commandId: "cmd2", deviceId: "device1", kind: "update", expiresAt: Date.now() + 60_000 });
    expect(f.installs()).toBe(0);
    expect(f.calls.some(call => call.state === "failed" && String(call.detail).includes("agent turn"))).toBe(true);
    expect(new RemoteCommandReceipts(f.home, "device1").read("cmd2")?.state).toBe("failed");
  } finally { f.clean(); }
});
