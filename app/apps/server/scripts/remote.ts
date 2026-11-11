// Reaching the team's Macs from this one (Sphe, Nov 4: "give yourself as MUCH
// control and info as needed to be able to diagnose issues that come up on
// other people's Macs"): straight to the team's Convex and relay, as the
// admin signed in to a data folder here (`--home`, ~/.edit-dev by default),
// with no Edit running. A Mac is named as its report names it (a part of
// "mathiass-macbook-pro" will do). Questions are read-only (remote_ask.ts);
// the commands that change something say so.
//
//   bun apps/server/scripts/remote.ts devices                    every Mac: build, last report, id
//   bun apps/server/scripts/remote.ts latest [mac]                its latest report (or every Mac's first lines)
//   bun apps/server/scripts/remote.ts ask <mac> <question…>       read-only: help, log, system, ps, net, work, project, ls, file, get
//   bun apps/server/scripts/remote.ts diagnostics <mac>           a fresh full report
//   bun apps/server/scripts/remote.ts probe <mac> <id>            one import's whole error and its files
//   bun apps/server/scripts/remote.ts history <mac>               the commands sent to it and how they went
//   bun apps/server/scripts/remote.ts reports [days]              the team's sent problem reports
//   changes something: unstick | restart | update-when-idle | update <mac>, resume <mac> <id>
//
// Answers are printed and kept in /tmp/edit-remote/. `--dev` asks dev's devices instead (the dev server here).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The team's relay (prod), whatever this shell points dev at; `--dev`: dev's (the dev server on :7700 is a device there).
const DEV_RELAY = "https://edit-relay-dev.sphe-g-personal.workers.dev";
if (process.argv.includes("--dev")) {
  process.argv.splice(process.argv.indexOf("--dev"), 1);
  process.env.EDIT_RELAY_URL = DEV_RELAY;
} else {
  delete process.env.EDIT_RELAY_URL;
}

// The server's modules in the order the server loads them (cli.ts is its entry; importing it starts nothing): started
// from accounts.ts, reviews.ts ran before busy.ts had finished and the script died on start (Nov 11, "Cannot access
// 'others' before initialization").
await import("../src/cli.ts");
const { ConvexClient } = await import("convex/browser");
const { makeFunctionReference } = await import("convex/server");
const accounts = await import("../src/accounts.ts");
const cloud = await import("../src/cloud.ts");
const problemReports = await import("../src/problem_reports.ts");
const relay = await import("../src/relay.ts");
const { authTokenFetcher } = await import("../src/remote_support.ts");
const { encodeAsk } = await import("../src/remote_ask.ts");

const OUT = path.join(os.tmpdir(), "edit-remote");
fs.mkdirSync(OUT, { recursive: true });

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const at = argv.indexOf(name);
  if (at < 0) return fallback;
  const value = argv[at + 1] ?? fallback;
  argv.splice(at, 2);
  return value;
};
const home = flag("--home", path.join(os.homedir(), ".edit-dev"));
const waitSeconds = Number(flag("--wait", "180"));
const [command = "help", ...rest] = argv;

function fail(message: string): never {
  console.error(`remote: ${message}`);
  process.exit(2);
}

if (command === "help" || command === "--help") {
  console.log(fs.readFileSync(import.meta.path, "utf8").split("\n").filter((line) => line.startsWith("//")).map((line) => line.slice(3)).join("\n"));
  process.exit(0);
}

await accounts.renew(home);
const status = accounts.status() as { signed_in?: boolean; admin?: boolean; person?: { email?: string } | null };
if (status.signed_in !== true) fail(`nobody is signed in to ${home}: sign in to Edit there (or give --home)`);
if (status.admin !== true) fail(`${status.person?.email ?? "this sign-in"} isn't an admin`);

const query = (name: string) => makeFunctionReference<"query">(`editSupport:${name}`);
const mutation = (name: string) => makeFunctionReference<"mutation">(`editSupport:${name}`);

let client: InstanceType<typeof ConvexClient> | null = null;
async function convex(): Promise<InstanceType<typeof ConvexClient>> {
  if (client !== null) return client;
  // The relay now and then doesn't answer one call (Nov 4, dev's: a 30 s hang, then fine): asked again.
  let config: { url: string } | null = null;
  for (let tries = 1; config === null; tries++) {
    try {
      config = await relay.json<{ url: string }>("POST", "/v1/cloud/support-config", {}, "remote support", 15);
    } catch (error) {
      if (tries >= 3) throw error;
      console.error(`remote: the relay didn't answer (${error instanceof Error ? error.message : String(error)}); asking again`);
    }
  }
  const c = new ConvexClient(new URL(config.url).origin, { initialAuthTokenReuse: true });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Convex didn't take the sign-in in 20 s")), 20_000);
    c.setAuth(authTokenFetcher(home), (authenticated) => {
      if (authenticated) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  client = c;
  return c;
}

interface Device {
  deviceId: string;
  label: string;
  build: string;
  enabled: boolean;
  updatedAt: number;
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "mac";

/** Every Mac's latest report: its sender and when it came (a Mac sends one at least hourly while Edit is open). */
async function latestReports(): Promise<Map<string, { from: string; sent: string; path: string }>> {
  const out = new Map<string, { from: string; sent: string; path: string }>();
  for (const one of await problemReports.latest(path.join(OUT, "home"))) out.set(slug(one.mac), { from: one.from, sent: one.sent, path: one.path });
  return out;
}

const ago = (iso: string | number) => {
  const ms = Date.now() - (typeof iso === "number" ? iso : Date.parse(iso));
  if (!Number.isFinite(ms)) return "never";
  return ms < 3_600_000 ? `${Math.round(ms / 60_000)} min ago` : ms < 172_800_000 ? `${(ms / 3_600_000).toFixed(1)} h ago` : `${Math.round(ms / 86_400_000)} days ago`;
};

async function devices(): Promise<Device[]> {
  return ((await (await convex()).query(query("devices"), {})) as Device[]).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The Mac `name` names: its id, its label or a part of it; the latest started of those that share it. */
async function find(name: string | undefined): Promise<Device> {
  if (name === undefined) fail("name a Mac (devices lists them)");
  const all = await devices();
  const wanted = name.toLowerCase();
  const exact = all.filter((one) => one.deviceId === name || slug(one.label) === slug(name));
  const found = exact.length > 0 ? exact : all.filter((one) => one.label.toLowerCase().includes(wanted) || one.deviceId.startsWith(name));
  const labels = new Set(found.map((one) => slug(one.label)));
  if (found.length === 0) fail(`no Mac is called ${name}: ${[...new Set(all.map((one) => one.label))].join(", ")}`);
  if (labels.size > 1) fail(`${name} could be ${[...labels].join(" or ")}`);
  return found[0]!;
}

/** Sends a command and waits for its outcome; the outcome's words. */
async function send(device: Device, kind: "update" | "diagnostics" | "resume", target?: string): Promise<string> {
  const c = await convex();
  const commandId = crypto.randomUUID();
  if (kind === "update") await c.mutation(mutation("requestUpdate"), { deviceId: device.deviceId, commandId });
  else await c.mutation(mutation("requestAction"), { deviceId: device.deviceId, commandId, kind, ...(target ? { projectId: target } : {}) });
  const began = Date.now();
  let last = "";
  while (Date.now() - began < waitSeconds * 1000) {
    const history = (await c.query(query("history"), { deviceId: device.deviceId })) as { commandId: string; state: string; detail?: string }[];
    const ours = history.find((one) => one.commandId === commandId);
    if (ours !== undefined && ours.state !== last) {
      last = ours.state;
      if (ours.state === "claimed") console.error(`remote: ${device.label} took it (${Math.round((Date.now() - began) / 1000)} s)`);
    }
    if (ours?.state === "complete") return ours.detail ?? "";
    if (ours?.state === "failed") fail(`${device.label}: ${ours.detail ?? "failed"}`);
    await Bun.sleep(2000);
  }
  const reports = await latestReports();
  const seen = reports.get(slug(device.label));
  fail(`${device.label} didn't ${last === "claimed" ? "finish" : "take"} it in ${waitSeconds} s: is Edit open there? Its last report came ${seen ? ago(seen.sent) : "never"}. The command waits 10 minutes (history shows it).`);
}

/** Prints what an outcome points at (a report it sent up), else the outcome itself. */
async function show(device: Device, detail: string): Promise<void> {
  const key = /edit\/reports\/[^\s]+\.txt/.exec(detail)?.[0];
  if (key === undefined) {
    console.log(detail);
    return;
  }
  const local = path.join(OUT, `${slug(device.label)}-${Date.now()}.txt`);
  for (let tries = 1; ; tries++) {
    try {
      await cloud.download(key, local);
      break;
    } catch (error) {
      if (tries >= 3) throw new Error(`the answer is at ${key}, but it couldn't be fetched: ${error instanceof Error ? error.message : String(error)}`);
      console.error("remote: fetching the answer failed; asking again");
    }
  }
  console.log(fs.readFileSync(local, "utf8"));
  console.error(`remote: kept in ${local}`);
}

try {
  switch (command) {
    case "devices": {
      const reports = await latestReports();
      for (const one of await devices()) {
        const report = reports.get(slug(one.label));
        console.log(`${one.label.padEnd(30)} ${one.build.padEnd(12)} started ${ago(one.updatedAt).padEnd(12)} last report ${report ? ago(report.sent) : "never"}${report ? ` (${report.from})` : ""}  ${one.enabled ? "" : "[off] "}${one.deviceId}`);
      }
      break;
    }
    case "latest": {
      const reports = await latestReports();
      if (rest[0] === undefined) {
        for (const [mac, one] of reports) {
          const lines = fs.readFileSync(one.path, "utf8").split("\n");
          const attention = lines.slice(lines.indexOf("Needs attention:") + 1, lines.indexOf("Machine:")).filter((line) => line.trim() !== "");
          console.log(`${mac} · ${one.from} · ${ago(one.sent)}\n  ${attention.join("\n  ")}`);
        }
      } else {
        const one = [...reports].find(([mac]) => mac.includes(slug(rest[0]!)));
        if (one === undefined) fail(`no latest report from ${rest[0]}: ${[...reports.keys()].join(", ")}`);
        console.log(fs.readFileSync(one[1].path, "utf8"));
      }
      break;
    }
    case "ask": {
      const device = await find(rest[0]);
      const question = rest.slice(1).join(" ") || "help";
      await show(device, await send(device, "resume", encodeAsk(question)));
      break;
    }
    case "diagnostics": {
      const device = await find(rest[0]);
      await show(device, await send(device, "diagnostics"));
      break;
    }
    case "probe":
    case "resume": {
      const device = await find(rest[0]);
      if (rest[1] === undefined) fail(`${command} needs a project or script id`);
      await show(device, await send(device, "resume", command === "probe" ? `probe-${rest[1]}` : rest[1]));
      break;
    }
    case "unstick":
    case "restart":
    case "update-when-idle": {
      const device = await find(rest[0]);
      console.log(await send(device, "resume", command));
      break;
    }
    case "update": {
      const device = await find(rest[0]);
      console.log(await send(device, "update"));
      break;
    }
    case "history": {
      const device = await find(rest[0]);
      const history = (await (await convex()).query(query("history"), { deviceId: device.deviceId })) as { commandId: string; kind: string; projectId?: string; state: string; detail?: string; createdAt: number }[];
      for (const one of history) console.log(`${new Date(one.createdAt).toISOString()} ${one.kind}${one.projectId ? ` ${one.projectId.slice(0, 40)}` : ""} · ${one.state}${one.detail ? ` · ${one.detail.slice(0, 200)}` : ""}`);
      break;
    }
    case "reports": {
      for (const one of await problemReports.pull(path.join(OUT, "home"), Number(rest[0] ?? 7))) console.log(`${one.sent} · ${one.mac} · ${one.from}\n  ${one.summary}\n  ${one.path}`);
      break;
    }
    default:
      fail(`unknown command ${command}: bun apps/server/scripts/remote.ts help`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
await (client as InstanceType<typeof ConvexClient> | null)?.close();
process.exit(0);
