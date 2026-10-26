// Owner-enabled remote update receiver. Commands arrive over Convex's live
// query, authenticated as this Edit's signed-in person, never the relay key.
import * as fs from "node:fs";
import { join } from "node:path";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { App } from "./app.ts";
import * as accounts from "./accounts.ts";
import * as diag from "./diag.ts";
import { bad, json } from "./http/errors.ts";
import { readJson, type Router } from "./http/router.ts";
import * as relay from "./relay.ts";
import { RemoteCommandReceipts } from "./remote_commands.ts";
import { installUpdate } from "./routes.ts";
import { BUILD } from "./version.ts";

const query = (name: string) => makeFunctionReference<"query">(`editSupport:${name}`);
const mutation = (name: string) => makeFunctionReference<"mutation">(`editSupport:${name}`);
type Settings = { device: string; enabled: boolean };
type Pending = { commandId: string; deviceId: string; expiresAt: number; kind: "update" };
type Intent = { commandId: string; device: string; expected: string };
const clients = new WeakMap<App, ConvexClient>();
const subscriptions = new WeakMap<App, () => void>();
const starting = new WeakMap<App, Promise<ConvexClient>>();
const handling = new WeakSet<App>();

function settingsPath(app: App) { return join(app.store.home, "remote-support.json"); }
function intentPath(app: App) { return join(app.store.home, "remote-update.json"); }
function settings(app: App): Settings {
  try {
    const value = JSON.parse(fs.readFileSync(settingsPath(app), "utf8")) as Settings;
    if (/^[a-zA-Z0-9_-]{1,120}$/u.test(value.device) && typeof value.enabled === "boolean") return value;
  } catch { /* Not enabled yet. */ }
  return { device: crypto.randomUUID(), enabled: false };
}
function save(app: App, value: Settings) {
  fs.mkdirSync(app.store.home, { recursive: true });
  fs.writeFileSync(settingsPath(app), JSON.stringify(value), { mode: 0o600 });
}

async function client(app: App): Promise<ConvexClient> {
  const existing = clients.get(app); if (existing) return existing;
  const flight = starting.get(app); if (flight) return flight;
  const make = (async () => {
    if (!accounts.accessToken()) await accounts.renew(app.store.home);
    if (!accounts.accessToken()) throw new Error("Sign in to Edit first.");
    const config = await relay.json<{ url: string }>("POST", "/v1/cloud/support-config", {}, "remote support", 30);
    const url = new URL(config.url);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".convex.cloud") || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid Convex support endpoint.");
    const connection = new ConvexClient(url.origin);
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Remote support authentication timed out.")), 20_000);
        connection.setAuth(async () => {
          if (!accounts.accessToken()) await accounts.renew(app.store.home);
          return accounts.accessToken();
        }, authenticated => {
          if (authenticated) { clearTimeout(timeout); resolve(); }
        });
      });
    } catch (error) { await connection.close(); throw error; }
    clients.set(app, connection); return connection;
  })();
  starting.set(app, make);
  try { return await make; } finally { starting.delete(app); }
}

async function finish(app: App, c: ConvexClient, intent: Intent, state: "complete" | "failed", detail: string) {
  await c.mutation(mutation("finish"), { deviceId: intent.device, commandId: intent.commandId, state, detail, build: BUILD });
  const receipts = new RemoteCommandReceipts(app.store.home, intent.device);
  if (receipts.read(intent.commandId)?.state === "claimed") receipts.finish(intent.commandId, state, detail);
  fs.rmSync(intentPath(app), { force: true });
}

export async function recover(app: App, c: ConvexClient) {
  let intent: Intent;
  try { intent = JSON.parse(fs.readFileSync(intentPath(app), "utf8")) as Intent; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  await finish(app, c, intent, BUILD === intent.expected ? "complete" : "failed", BUILD === intent.expected ? `Running ${BUILD}` : `Restart did not reach ${intent.expected}; running ${BUILD}`);
}

export async function execute(app: App, c: ConvexClient, item: Pending) {
  if (handling.has(app)) return;
  handling.add(app);
  try {
    const setting = settings(app);
    if (!setting.enabled || setting.device !== item.deviceId || item.expiresAt <= Date.now()) return;
    if (!(await c.mutation(mutation("claim"), { deviceId: setting.device, commandId: item.commandId }))) return;
    const receipts = new RemoteCommandReceipts(app.store.home, setting.device);
    if (!receipts.claim({ id: item.commandId, device: item.deviceId, kind: item.kind, expiresAt: item.expiresAt })) return;
    let intent: Intent = { commandId: item.commandId, device: setting.device, expected: "" };
    fs.writeFileSync(intentPath(app), JSON.stringify(intent), { mode: 0o600 });
    try {
      const status = await app.updater.status() as { enabled?: boolean; latest?: string | null; phase?: string };
      if (!status.enabled) throw new Error("This build cannot update itself.");
      if (status.phase !== "idle") throw new Error("An update is already running.");
      if ((app.agents as { hasRunningTurns?: () => boolean }).hasRunningTurns?.()) throw new Error("An agent turn is running; request the update after it finishes.");
      if (!status.latest) throw new Error("No newer verified release is available.");
      intent = { ...intent, expected: status.latest };
      fs.writeFileSync(intentPath(app), JSON.stringify(intent), { mode: 0o600 });
      await installUpdate(app);
      // The updater is asynchronous; errors remain visible without waiting for a restart.
      const timer = setInterval(() => void (async () => {
        const current = await app.updater.status() as { phase?: string; error?: string | null };
        if (current.phase === "idle" && current.error) { await finish(app, c, intent, "failed", current.error); clearInterval(timer); }
      })().catch(error => diag.warn("remote", diag.messageOf(error))), 2000);
      timer.unref();
    } catch (error) { await finish(app, c, intent, "failed", diag.messageOf(error)); }
  } finally { handling.delete(app); }
}

async function connect(app: App) {
  const setting = settings(app);
  if (!setting.enabled || subscriptions.has(app)) return;
  const c = await client(app);
  await c.mutation(mutation("register"), { deviceId: setting.device, label: app.machine, build: BUILD, enabled: true });
  await recover(app, c);
  const sub = c.onUpdate(query("pending"), { deviceId: setting.device }, (items: Pending[]) => {
    for (const item of items) void execute(app, c, item).catch(error => diag.warn("remote", diag.messageOf(error)));
  }, error => diag.warn("remote", diag.messageOf(error)));
  subscriptions.set(app, sub);
}

/** Called after startup; an offline account retries without starting any work. */
export function start(app: App) {
  if (!settings(app).enabled) return;
  const attempt = () => void connect(app).catch(error => { diag.warn("remote", diag.messageOf(error)); const timer = setTimeout(attempt, 60_000); timer.unref(); });
  attempt();
}

export function routes(router: Router<App>) {
  router.get("/api/remote-support", ({ app }) => json(settings(app)));
  router.post("/api/remote-support", async context => {
    const given = await readJson<{ action?: string; device?: string }>(context);
    const app = context.app; const action = given.action;
    try {
      const c = await client(app);
      if (action === "enable" || action === "disable") {
        const value = { ...settings(app), enabled: action === "enable" };
        await c.mutation(mutation("register"), { deviceId: value.device, label: app.machine, build: BUILD, enabled: value.enabled });
        save(app, value);
        if (value.enabled) await connect(app); else { subscriptions.get(app)?.(); subscriptions.delete(app); }
        return json(value);
      }
      if (action === "devices") return json(await c.query(query("devices"), {}));
      if ((action === "update" || action === "history") && typeof given.device === "string") {
        if (action === "history") return json(await c.query(query("history"), { deviceId: given.device }));
        const commandId = crypto.randomUUID();
        await c.mutation(mutation("requestUpdate"), { deviceId: given.device, commandId });
        return json({ commandId });
      }
      throw new Error("Choose enable, disable, devices, update or history.");
    } catch (error) { throw bad(diag.messageOf(error)); }
  });
}
