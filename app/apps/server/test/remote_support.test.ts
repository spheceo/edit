import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import type { ConvexClient } from "convex/browser";
import { getFunctionName } from "convex/server";
import type { App } from "../src/app.ts";
import { authTokenFetcher, disable, execute, prepareEnrollment, recover, registerAutomatically, routes } from "../src/remote_support.ts";
import { Router } from "../src/http/router.ts";
import { listen, respond } from "../src/http/server.ts";
import { RemoteCommandReceipts } from "../src/remote_commands.ts";
import { BUILD } from "../src/version.ts";
const NEXT = "nightly-99999";
const item = (id = "cmd1") => ({ commandId: id, deviceId: "device1", kind: "update" as const, expiresAt: Date.now() + 60_000 });

function fixture(running = false) {
  const home = fs.mkdtempSync(join(os.tmpdir(), "edit-support-"));
  fs.writeFileSync(join(home, "remote-support.json"), JSON.stringify({ device: "device1", enabled: true }));
  const calls: Record<string, unknown>[] = [];
  let installs = 0;
  const cloud = { state: "pending", loseClaim: false, loseFinish: false, refuseInstall: false, waitForClaim: null as Promise<void> | null, canRestart: undefined as (() => boolean) | undefined };
  const app = { machine: "Test Mac", store: { home }, agents: { hasRunningTurns: () => running }, exports: { running: () => false }, updater: {
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

test("first sign-in persists one device before registration; signed-out startup does nothing", async () => {
  const f = fixture();
  const path = join(f.home, "remote-support.json");
  try {
    fs.rmSync(path);
    expect(prepareEnrollment(f.app, null).enabled).toBe(false);
    expect(fs.existsSync(path)).toBe(false);
    const first = prepareEnrollment(f.app, "owner");
    expect(first).toMatchObject({ enabled: true, owner: "owner", enrolling: true });
    expect(fs.statSync(path).mode & 0o777).toBe(0o600);
    expect(prepareEnrollment(f.app, "owner")).toEqual(first);
    const calls: unknown[] = [];
    const c = { mutation: async (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
      expect(getFunctionName(ref)).toBe("editSupport:register");
      expect(JSON.parse(fs.readFileSync(path, "utf8")).device).toBe(first.device);
      calls.push(args);
      return { enabled: true };
    } } as unknown as ConvexClient;
    await registerAutomatically(f.app, c, () => true);
    expect(calls).toEqual([{ deviceId: first.device, label: "Test Mac", build: BUILD, enabled: true, onlyIfNew: true }]);
    expect(prepareEnrollment(f.app, "owner")).toMatchObject({ enabled: true, enrolling: false, device: first.device });
    await registerAutomatically(f.app, c, () => true);
    expect(calls).toHaveLength(1);
  } finally { await f.clean(); }
});

test("automatic enrollment never replaces a saved disable, another owner or a corrupt preference", async () => {
  const f = fixture();
  const path = join(f.home, "remote-support.json");
  try {
    disable(f.app);
    const off = fs.readFileSync(path, "utf8");
    expect(prepareEnrollment(f.app, "new-owner").enabled).toBe(false);
    expect(fs.readFileSync(path, "utf8")).toBe(off);
    fs.writeFileSync(path, JSON.stringify({ device: "device1", owner: "old-owner", enabled: true }));
    expect(prepareEnrollment(f.app, "new-owner").owner).toBe("old-owner");
    fs.writeFileSync(path, "invalid saved preference");
    expect(prepareEnrollment(f.app, "owner").enabled).toBe(false);
    expect(fs.readFileSync(path, "utf8")).toBe("invalid saved preference");
  } finally { await f.clean(); }
});

test("lost automatic registration acknowledgement retries the same identity and honors cloud revocation", async () => {
  const f = fixture();
  const path = join(f.home, "remote-support.json");
  try {
    fs.rmSync(path);
    const first = prepareEnrollment(f.app, "owner");
    let attempts = 0;
    const c = { mutation: async (_ref: unknown, args: { deviceId: string; onlyIfNew: boolean }) => {
      expect(args.deviceId).toBe(first.device);
      expect(args.onlyIfNew).toBe(true);
      if (++attempts === 1) throw new Error("Registration acknowledgement lost");
      return { enabled: false };
    } } as unknown as ConvexClient;
    await expect(registerAutomatically(f.app, c, () => true)).rejects.toThrow("Registration acknowledgement lost");
    expect(prepareEnrollment(f.app, "owner")).toEqual(first);
    await registerAutomatically(f.app, c, () => true);
    expect(prepareEnrollment(f.app, "owner")).toMatchObject({ enabled: false, enrolling: false, device: first.device });
    await registerAutomatically(f.app, c, () => true);
    expect(attempts).toBe(2);
  } finally { await f.clean(); }
});

for (const revoke of ["disable", "sign out"] as const) {
  test(`${revoke} while automatic registration is in flight cannot enable the receiver`, async () => {
    const f = fixture();
    const path = join(f.home, "remote-support.json");
    let release!: (value: { enabled: boolean }) => void;
    try {
      fs.rmSync(path);
      const first = prepareEnrollment(f.app, "owner");
      const c = { mutation: () => new Promise(resolve => { release = resolve; }) } as unknown as ConvexClient;
      let current = true;
      const registering = registerAutomatically(f.app, c, () => current);
      if (revoke === "disable") disable(f.app);
      else current = false;
      release({ enabled: true });
      await registering;
      expect(prepareEnrollment(f.app, "owner")).toMatchObject(revoke === "disable"
        ? { enabled: false, enrolling: false, pendingDisable: true }
        : first);
    } finally { release?.({ enabled: true }); await f.clean(); }
  });
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
