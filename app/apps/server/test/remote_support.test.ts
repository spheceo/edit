import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import type { ConvexClient } from "convex/browser";
import { getFunctionName } from "convex/server";
import type { App } from "../src/app.ts";
import { authTokenFetcher, disable, execute, recover, routes } from "../src/remote_support.ts";
import { Router } from "../src/http/router.ts";
import { listen, respond } from "../src/http/server.ts";
import { RemoteCommandReceipts } from "../src/remote_commands.ts";
const NEXT = "nightly-99999";
const item = (id = "cmd1") => ({ commandId: id, deviceId: "device1", kind: "update" as const, expiresAt: Date.now() + 60_000 });

function fixture(running = false) {
  const home = fs.mkdtempSync(join(os.tmpdir(), "edit-support-"));
  fs.writeFileSync(join(home, "remote-support.json"), JSON.stringify({ device: "device1", enabled: true }));
  const calls: Record<string, unknown>[] = [];
  let installs = 0;
  const cloud = { state: "pending", loseClaim: false, loseFinish: false, refuseInstall: false, waitForClaim: null as Promise<void> | null, canRestart: undefined as (() => boolean) | undefined };
  const app = { store: { home }, agents: { hasRunningTurns: () => running }, exports: { running: () => false }, updater: {
    status: async () => ({ enabled: true, phase: installs ? "downloading" : "idle", latest: NEXT }),
    install: async (canRestart?: () => boolean) => { if (cloud.refuseInstall) throw new Error("Cannot install update"); cloud.canRestart = canRestart; installs++; return {}; },
  } } as unknown as App;
  const c = {
    mutation: async (ref: Parameters<typeof getFunctionName>[0], args: Record<string, unknown>) => {
      calls.push(args);
      if (getFunctionName(ref).endsWith(":claim")) {
        if (cloud.state !== "pending") return false;
        cloud.state = "claimed";
        if (cloud.waitForClaim) await cloud.waitForClaim;
        if (cloud.loseClaim) throw new Error("Claim acknowledgement lost");
        return true;
      }
      if (cloud.loseFinish) { cloud.loseFinish = false; throw new Error("Receipt acknowledgement lost"); }
      cloud.state = String(args.state);
    },
    query: async () => cloud.state === "claimed" ? [item()] : [],
  } as unknown as ConvexClient;
  let signedIn = true;
  const send = (command = item()) => execute(app, c, command, () => signedIn);
  return { home, app, c, calls, cloud, send, signOut: () => { signedIn = false; }, installs: () => installs,
    intent: () => JSON.parse(fs.readFileSync(join(home, "remote-update.json"), "utf8")),
    clean: async () => {
      if (fs.existsSync(join(home, "remote-update.json"))) await recover(app, c, NEXT);
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test("an update is claimed once and confirmed after restart", async () => {
  const f = fixture();
  try {
    const item = { commandId: "cmd1", deviceId: "device1", kind: "update" as const, expiresAt: Date.now() + 60_000 };
    await f.send(item);
    await f.send(item);
    expect(f.installs()).toBe(1);
    expect(new RemoteCommandReceipts(f.home, "device1").read("cmd1")?.state).toBe("claimed");
    await recover(f.app, f.c, NEXT);
    expect(new RemoteCommandReceipts(f.home, "device1").read("cmd1")?.state).toBe("complete");
    expect(f.calls.some(call => call.state === "complete")).toBe(true);
  } finally { await f.clean(); }
});

test("a remote update refuses to interrupt an agent", async () => {
  const f = fixture(true);
  try {
    await f.send({ commandId: "cmd2", deviceId: "device1", kind: "update", expiresAt: Date.now() + 60_000 });
    expect(f.installs()).toBe(0);
    expect(f.calls.some(call => call.state === "failed" && String(call.detail).includes("agent turn"))).toBe(true);
    expect(new RemoteCommandReceipts(f.home, "device1").read("cmd2")?.state).toBe("failed");
  } finally { await f.clean(); }
});

test("a second command cannot overwrite the running update's recovery record", async () => {
  const f = fixture();
  try {
    await f.send();
    await f.send(item("cmd2"));
    expect(f.intent().commandId).toBe("cmd1");
    expect(f.calls.filter(call => call.state === undefined)).toHaveLength(1);
  } finally { await f.clean(); }
});

test("remote updates recheck activity at restart, including work begun during download", async () => {
  const f = fixture();
  try {
    await f.send();
    expect(f.cloud.canRestart?.()).toBe(true);
    f.app.exports.running = () => true;
    expect(f.cloud.canRestart?.()).toBe(false);
    f.app.exports.running = () => false;
    Object.assign(f.app.agents, { hasRunningTurns: () => true });
    expect(f.cloud.canRestart?.()).toBe(false);
  } finally { await f.clean(); }
});

test("a lost claim acknowledgement remains recoverable without executing the command", async () => {
  const f = fixture();
  try {
    f.cloud.loseClaim = true;
    await expect(f.send()).rejects.toThrow("Claim acknowledgement lost");
    expect(f.intent().commandId).toBe("cmd1");
    await recover(f.app, f.c, NEXT);
    expect(f.installs()).toBe(0);
    expect(f.cloud.state).toBe("failed");
  } finally { await f.clean(); }
});

test("an unacknowledged failure never becomes success after an unrelated upgrade", async () => {
  const f = fixture();
  try {
    f.cloud.refuseInstall = true;
    f.cloud.loseFinish = true;
    await expect(f.send()).rejects.toThrow("Receipt acknowledgement lost");
    expect(f.intent().outcome.state).toBe("failed");
    await recover(f.app, f.c, NEXT);
    expect(f.cloud.state).toBe("failed");
    expect(f.calls.at(-1)?.detail).toContain("Cannot install update");
  } finally { await f.clean(); }
});

test("old cloud claims without a local journal are surfaced as interrupted", async () => {
  const f = fixture();
  try {
    f.cloud.state = "claimed";
    await recover(f.app, f.c);
    expect(f.cloud.state).toBe("failed");
    expect(f.installs()).toBe(0);
  } finally { await f.clean(); }
});

for (const revoke of ["disable", "sign out"] as const) {
  test(`${revoke} while a claim is in flight prevents installation`, async () => {
    const f = fixture();
    let release!: () => void;
    f.cloud.waitForClaim = new Promise<void>(resolve => { release = resolve; });
    try {
      const sending = f.send();
      if (revoke === "disable") {
        const value = disable(f.app);
        expect(value.enabled).toBe(false);
        expect(value.pendingDisable).toBe(true);
        expect(fs.statSync(join(f.home, "remote-support.json")).mode & 0o777).toBe(0o600);
      } else f.signOut();
      release();
      await sending;
      expect(f.installs()).toBe(0);
      expect(f.cloud.state).toBe("failed");
    } finally { release(); await f.clean(); }
  });
}

test("Convex can force token renewal before the cached access token expires", async () => {
  let token = "cached";
  let refreshes = 0;
  const fetchToken = authTokenFetcher("test-home", {
    accessToken: () => token,
    renew: async () => { refreshes++; token = "fresh"; },
  });
  expect(await fetchToken({ forceRefreshToken: false })).toBe("cached");
  expect(refreshes).toBe(0);
  expect(await fetchToken({ forceRefreshToken: true })).toBe("fresh");
  expect(refreshes).toBe(1);
});

test("the operator API refuses tailnet peers, proxies, browsers and unknown peers", async () => {
  const f = fixture();
  f.app.allowedHosts = ["127.0.0.1"];
  const router = new Router<App>();
  routes(router);
  try {
    const read = async (peer: string | null, extra: Record<string, string> = {}) => {
      const request = new Request("http://127.0.0.1/api/remote-support", { headers: { host: "127.0.0.1", ...extra } });
      const server = peer === null ? null : { requestIP: () => ({ address: peer }) } as unknown as Parameters<typeof respond>[3];
      return (await respond(f.app, router, request, server))!.status;
    };
    expect(await read("127.0.0.1")).toBe(200);
    expect(await read("100.64.0.2")).toBe(403);
    expect(await read("127.0.0.1", { "x-forwarded-for": "100.64.0.2" })).toBe(403);
    expect(await read("127.0.0.1", { origin: "http://127.0.0.1" })).toBe(403);
    expect(await read(null)).toBe(403);
  } finally { await f.clean(); }
});

test("a real loopback connection can reach the local CLI endpoint", async () => {
  const f = fixture();
  f.app.allowedHosts = ["127.0.0.1"];
  const router = new Router<App>();
  routes(router);
  const server = listen(f.app, router, "127.0.0.1", 0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/remote-support`, { signal: AbortSignal.timeout(2000) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ device: "device1", enabled: true });
  } finally { server.stop(true); await f.clean(); }
});
