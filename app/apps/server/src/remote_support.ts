// Every signed-in Edit can be reached by an admin, always: it registers itself
// at every start, as the person signed in, and there is no switch to turn it
// off (Sphe, Nov 1: "ALL MACHINES SHOULD HAVE IT ON BY DEFAULT ALWAYS"). A
// device the cloud doesn't know is made again, a disable an older build saved
// is turned back on, and another account's device gets a new identity. (The
// day it was written, the team's Macs looked unreachable only because the
// `edit remote` CLI asked the dev server on :7700, so dev's list; prod's had
// them all.) Commands arrive over Convex's live query
// as this Edit's signed-in person, never the relay key.
import * as fs from "node:fs";
import { join } from "node:path";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { App } from "./app.ts";
import * as accounts from "./accounts.ts";
import * as diag from "./diag.ts";
import { writeAtomic } from "./files.ts";
import { ApiError, bad, json } from "./http/errors.ts";
import { readJson, type RouteContext, type Router } from "./http/router.ts";
import * as relay from "./relay.ts";
import * as planUse from "./plan_use.ts";
import * as actions from "./remote_actions.ts";
import { RemoteCommandReceipts } from "./remote_commands.ts";
import { installUpdate } from "./routes.ts";
import { BUILD } from "./version.ts";

const query = (name: string) => makeFunctionReference<"query">(`editSupport:${name}`);
const mutation = (name: string) => makeFunctionReference<"mutation">(`editSupport:${name}`);
/** This Mac's device; `enabled` is false only before anyone signed in here (older builds also saved a disable, now turned back on). */
type Settings = { device: string; enabled: boolean; owner?: string; pendingDisable?: boolean; enrolling?: boolean };
type Pending = { commandId: string; deviceId: string; expiresAt: number; kind: actions.Kind; projectId?: string };
type Outcome = { state: "complete" | "failed"; detail: string };
type Intent = { commandId: string; device: string; expected: string; outcome?: Outcome };
const clients = new WeakMap<App, ConvexClient>();
const subscriptions = new WeakMap<App, () => void>();
const starting = new WeakMap<App, Promise<ConvexClient>>();
const handling = new WeakSet<App>();
const activeUpdates = new WeakMap<App, string>();
const monitors = new WeakMap<App, ReturnType<typeof setInterval>>();
const connectionOwners = new WeakMap<App, string>();
const generations = new WeakMap<App, number>();
const observed = new WeakSet<App>();
const connecting = new WeakMap<App, Promise<void>>();
const retries = new WeakMap<App, ReturnType<typeof setTimeout>>();
const deliveries = new WeakMap<App, Pending[]>();

function generation(app: App) { return generations.get(app) ?? 0; }
function authorized(app: App): boolean {
  const owner = connectionOwners.get(app);
  return owner !== undefined && accounts.creator()?.sub === owner && accounts.accessToken() !== null;
}
function close(app: App): void {
  generations.set(app, generation(app) + 1);
  subscriptions.get(app)?.(); subscriptions.delete(app);
  deliveries.delete(app);
  const c = clients.get(app);
  clients.delete(app); connectionOwners.delete(app);
  if (c) void c.close().catch(error => diag.warn("remote", diag.messageOf(error)));
}

function observe(app: App) {
  if (observed.has(app)) return;
  observed.add(app);
  accounts.onSessionChange(() => {
    const owner = connectionOwners.get(app);
    if (!accounts.creator() || (owner && accounts.creator()?.sub !== owner)) close(app);
    if (accounts.creator()) start(app);
  });
}

/** Convex must be able to force a fresh token, even while the cached one is valid. */
export function authTokenFetcher(home: string, session: Pick<typeof accounts, "accessToken" | "renew"> = accounts) {
  return async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
    if (forceRefreshToken || !session.accessToken()) await session.renew(home);
    return session.accessToken();
  };
}

function settingsPath(app: App) { return join(app.store.home, "remote-support.json"); }
function intentPath(app: App) { return join(app.store.home, "remote-update.json"); }
function settings(app: App): Settings {
  try {
    const value = JSON.parse(fs.readFileSync(settingsPath(app), "utf8")) as Settings;
    if (/^[a-zA-Z0-9_-]{1,120}$/u.test(value.device) && typeof value.enabled === "boolean" &&
      (value.owner === undefined || typeof value.owner === "string") &&
      (value.pendingDisable === undefined || typeof value.pendingDisable === "boolean") &&
      (value.enrolling === undefined || typeof value.enrolling === "boolean")) return value;
  } catch { /* Not enabled yet. */ }
  return { device: crypto.randomUUID(), enabled: false };
}
function save(app: App, value: Settings) {
  fs.mkdirSync(app.store.home, { recursive: true });
  writeAtomic(settingsPath(app), JSON.stringify(value), 0o600);
}

/**
 * This Mac's identity for the person signed in, kept before the first network
 * call: its saved device when it's theirs, else a new one (no file, an
 * unreadable one, or another person's device: a device belongs to one
 * account). Always on: a saved disable from older builds is turned back on.
 * Signed out (`owner` null): nothing is written.
 */
export function prepareEnrollment(app: App, owner: string | null): Settings {
  const saved = settings(app);
  if (owner === null) return saved;
  const theirs = fs.existsSync(settingsPath(app)) && (saved.owner === undefined || saved.owner === owner);
  const value: Settings = { device: theirs ? saved.device : crypto.randomUUID(), enabled: true, owner };
  if (JSON.stringify(value) !== JSON.stringify(saved)) save(app, value);
  return value;
}

/**
 * Registers this Mac at every start (on, with its name and build): a device
 * the cloud doesn't know (lost in a move, never acknowledged) is made again,
 * one turned off is turned back on, and one another account holds gets a new
 * identity for this person.
 */
export async function registerAutomatically(app: App, c: ConvexClient, isCurrent: () => boolean): Promise<void> {
  const owner = accounts.creator()?.sub ?? settings(app).owner ?? null;
  let value = prepareEnrollment(app, owner);
  const register = () => rpc(c.mutation(mutation("register"), { deviceId: value.device, label: app.machine, build: BUILD, enabled: true }));
  try {
    await register();
  } catch (error) {
    if (!/another account/i.test(diag.messageOf(error)) || !isCurrent()) throw error;
    value = { device: crypto.randomUUID(), enabled: true, ...(owner === null ? {} : { owner }) };
    save(app, value);
    await register();
  }
}

function journal(app: App, intent: Intent) {
  writeAtomic(intentPath(app), JSON.stringify(intent), 0o600);
}

/** A lost acknowledgement is ambiguous; the durable journal prevents replay. */
async function rpc<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("No acknowledgement from Convex. The request may have arrived; inspect its history before sending another.")), 25_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}


async function client(app: App): Promise<ConvexClient> {
  observe(app);
  const existing = clients.get(app); if (existing) return existing;
  const flight = starting.get(app); if (flight) return flight;
  const make = (async () => {
    if (!accounts.accessToken()) await accounts.renew(app.store.home);
    if (!accounts.accessToken()) throw new Error("Sign in to Edit first.");
    const owner = accounts.creator()?.sub;
    if (!owner) throw new Error("Sign in to Edit first.");
    const version = generation(app);
    const config = await relay.json<{ url: string }>("POST", "/v1/cloud/support-config", {}, "remote support", 30);
    const url = new URL(config.url);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".convex.cloud") || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid Convex support endpoint.");
    const connection = new ConvexClient(url.origin, { initialAuthTokenReuse: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Remote support authentication timed out.")), 20_000);
        connection.setAuth(authTokenFetcher(app.store.home), authenticated => {
          if (authenticated) { clearTimeout(timeout); resolve(); }
        });
      });
    } catch (error) { await connection.close(); throw error; }
    if (generation(app) !== version || accounts.creator()?.sub !== owner) {
      await connection.close(); throw new Error("The remote support session changed.");
    }
    connectionOwners.set(app, owner);
    clients.set(app, connection); return connection;
  })();
  starting.set(app, make);
  try { return await make; } finally { starting.delete(app); }
}

async function finish(app: App, c: ConvexClient, intent: Intent, state: "complete" | "failed", detail: string) {
  // Persist the outcome before its acknowledgement can be lost. A later boot
  // must report this result, never infer success from an unrelated upgrade.
  journal(app, { ...intent, outcome: { state, detail } });
  try {
    await rpc(c.mutation(mutation("finish"), { deviceId: intent.device, commandId: intent.commandId, state, detail, build: BUILD }));
  } catch (error) { retry(app); throw error; }
  const receipts = new RemoteCommandReceipts(app.store.home, intent.device);
  if (receipts.read(intent.commandId)?.state === "claimed") receipts.finish(intent.commandId, state, detail);
  fs.rmSync(intentPath(app), { force: true });
  activeUpdates.delete(app);
  const timer = monitors.get(app);
  if (timer) clearInterval(timer);
  monitors.delete(app);
  drain(app, c);
}

export async function recover(app: App, c: ConvexClient, currentBuild = BUILD) {
  let intent: Intent | null = null;
  try { intent = JSON.parse(fs.readFileSync(intentPath(app), "utf8")) as Intent; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (intent) {
    const outcome = intent.outcome ?? (currentBuild === intent.expected
      ? { state: "complete" as const, detail: `Running ${currentBuild}` }
      : { state: "failed" as const, detail: `Restart did not reach ${intent.expected || "a verified update"}; running ${currentBuild}` });
    await finish(app, c, intent, outcome.state, outcome.detail);
  }
  // Older receivers claimed in the cloud before saving anything locally.
  // Surface those interrupted requests instead of leaving them stuck forever.
  const claimed = await rpc(c.query(query("claimed"), { deviceId: settings(app).device })) as Pending[];
  for (const item of claimed) {
    await finish(app, c, { commandId: item.commandId, device: item.deviceId, expected: "" }, "failed", "The previous process ended before confirming this update. Nothing was replayed.");
  }
}

/**
 * A command that isn't an update (diagnostics, resume): claimed, carried out
 * and reported at once. Nothing restarts, so no journal: the receipt keeps it
 * from running twice.
 */
async function executeAction(app: App, c: ConvexClient, item: Pending, ownsSession: () => boolean) {
  const setting = settings(app);
  if (!ownsSession() || !setting.enabled || setting.device !== item.deviceId || item.expiresAt <= Date.now()) return;
  const receipts = new RemoteCommandReceipts(app.store.home, setting.device);
  if (!(await rpc(c.mutation(mutation("claim"), { deviceId: setting.device, commandId: item.commandId })))) return;
  let state: "complete" | "failed" = "complete";
  let detail: string;
  try {
    if (!receipts.claim({ id: item.commandId, device: item.deviceId, kind: item.kind, expiresAt: item.expiresAt })) throw new Error("This command was already received or expired. Nothing was replayed.");
    if (item.kind === "diagnostics") detail = `Sent: ${await actions.diagnostics(app)}`;
    else if (item.kind === "resume") {
      if (!item.projectId) throw new Error("No project was named.");
      detail = await actions.resume(app, item.projectId);
    } else throw new Error(`This build doesn't know "${item.kind}".`);
  } catch (error) {
    state = "failed";
    detail = diag.messageOf(error);
  }
  await rpc(c.mutation(mutation("finish"), { deviceId: setting.device, commandId: item.commandId, state, detail, build: BUILD }));
  if (receipts.read(item.commandId)?.state === "claimed") receipts.finish(item.commandId, state, detail);
}

export async function execute(app: App, c: ConvexClient, item: Pending, ownsSession = () => authorized(app)) {
  if (item.kind !== "update") {
    if (handling.has(app)) return;
    handling.add(app);
    try { await executeAction(app, c, item, ownsSession); } finally { handling.delete(app); }
    return;
  }
  if (handling.has(app) || activeUpdates.has(app) || fs.existsSync(intentPath(app))) return;
  handling.add(app);
  try {
    const setting = settings(app);
    if (!ownsSession() || !setting.enabled || setting.device !== item.deviceId || item.expiresAt <= Date.now()) return;
    let intent: Intent = { commandId: item.commandId, device: setting.device, expected: "" };
    // Save before asking Convex to claim: even a lost claim acknowledgement
    // leaves enough information to fail the command safely on the next boot.
    journal(app, intent);
    if (!(await rpc(c.mutation(mutation("claim"), { deviceId: setting.device, commandId: item.commandId })))) {
      fs.rmSync(intentPath(app), { force: true }); return;
    }
    const receipts = new RemoteCommandReceipts(app.store.home, setting.device);
    try {
      if (!receipts.claim({ id: item.commandId, device: item.deviceId, kind: item.kind, expiresAt: item.expiresAt })) throw new Error("This command was already received or expired. Nothing was replayed.");
      const status = await app.updater.status() as { enabled?: boolean; latest?: string | null; phase?: string };
      if (!status.enabled) throw new Error("This build cannot update itself.");
      if (status.phase !== "idle") throw new Error("An update is already running.");
      if (!status.latest) throw new Error("No newer verified release is available.");
      intent = { ...intent, expected: status.latest };
      journal(app, intent);
      if (!ownsSession() || !settings(app).enabled) throw new Error("Remote support was disabled or the account signed out.");
      activeUpdates.set(app, item.commandId);
      await installUpdate(app, true);
      // The updater is asynchronous; errors remain visible without waiting for a restart.
      let checking = false;
      const timer = setInterval(() => void (async () => {
        if (checking) return;
        checking = true;
        try {
          const current = await app.updater.status() as { phase?: string; error?: string | null };
          if (current.phase === "idle" && current.error) { await finish(app, c, intent, "failed", current.error); clearInterval(timer); }
        } finally { checking = false; }
      })().catch(error => diag.warn("remote", diag.messageOf(error))), 2000);
      monitors.set(app, timer);
      timer.unref();
    } catch (error) { await finish(app, c, intent, "failed", diag.messageOf(error)); }
  } finally {
    handling.delete(app);
    if (!activeUpdates.has(app) && fs.existsSync(intentPath(app))) retry(app);
  }
}

async function connectOnce(app: App) {
  let setting = settings(app);
  if (subscriptions.has(app)) {
    const c = clients.get(app);
    if (c) drain(app, c);
    return;
  }
  if (!setting.enabled) return;
  const version = generation(app);
  const c = await client(app);
  if (generation(app) !== version) return;
  // Registered at every start (made again if the cloud lost it, on, as whoever is signed in).
  await registerAutomatically(app, c, () => generation(app) === version && authorized(app));
  if (generation(app) !== version || !authorized(app)) return;
  setting = settings(app);
  if (!activeUpdates.has(app)) await recover(app, c);
  if (generation(app) !== version || !settings(app).enabled || !authorized(app)) return;
  const sub = c.onUpdate(query("pending"), { deviceId: setting.device, kinds: [...actions.KINDS] }, (items: Pending[]) => {
    deliveries.set(app, items);
    drain(app, c);
  }, error => diag.warn("remote", diag.messageOf(error)));
  subscriptions.set(app, sub);
}

/** Retain delivered commands during an auth refresh or another in-flight
 * callback. Token renewal need not cause Convex to send identical data again. */
function drain(app: App, c: ConvexClient) {
  if (!authorized(app) || handling.has(app) || activeUpdates.has(app) || fs.existsSync(intentPath(app))) return;
  const items = deliveries.get(app);
  const item = items?.shift();
  if (!item) return;
  void execute(app, c, item).catch(error => diag.warn("remote", diag.messageOf(error))).finally(() => drain(app, c));
}

async function connect(app: App) {
  const previous = connecting.get(app);
  if (previous) {
    await previous;
    if (connecting.get(app) === previous) connecting.delete(app);
    return connect(app);
  }
  const flight = connectOnce(app);
  connecting.set(app, flight);
  try { await flight; } finally { if (connecting.get(app) === flight) connecting.delete(app); }
}

function retry(app: App) {
  if (retries.has(app)) return;
  const timer = setTimeout(() => {
    retries.delete(app);
    // A persisted outcome may need reporting while the live subscription is
    // still active. Never reinterpret a running installation as interrupted.
    void (async () => {
      if (accounts.creator() && fs.existsSync(intentPath(app))) {
        const intent = JSON.parse(fs.readFileSync(intentPath(app), "utf8")) as Intent;
        if (intent.outcome && authorized(app)) await finish(app, await client(app), intent, intent.outcome.state, intent.outcome.detail);
        else if (!activeUpdates.has(app) && authorized(app)) await recover(app, await client(app));
      }
      await connect(app);
    })().catch(error => { diag.warn("remote", diag.messageOf(error)); retry(app); });
  }, 60_000);
  timer.unref(); retries.set(app, timer);
}

/** Called after startup; an offline account retries without starting any work. */
export function start(app: App) {
  observe(app);
  actions.keepLatest(app);
  // The Claude plan's meter, read every 15 minutes, for the report's "Claude plan".
  planUse.start(app.store.home);
  // An update asked for "when idle" waits across restarts.
  actions.watchIdle(app);
  const account = accounts.status();
  const allowed = account.admin === true || (Array.isArray(account.perms) && account.perms.includes("use"));
  const owner = allowed ? accounts.creator()?.sub ?? null : null;
  if (owner === null && !fs.existsSync(intentPath(app))) return;
  prepareEnrollment(app, owner);
  void connect(app).catch(error => { diag.warn("remote", diag.messageOf(error)); retry(app); });
}

/** These routes delegate the host's account. Only the CLI on that Mac may use
 * them: a Tailscale visitor or a reverse-proxied/browser request is not that
 * operator, even when it presents an allowed Host header. */
function requireLocalCli(context: RouteContext<App>) {
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(context.peerAddress ?? "");
  const proxied = [...context.request.headers.keys()].some(name => name === "forwarded" || name.startsWith("x-forwarded-") || name.startsWith("tailscale-"));
  if (!loopback || proxied || context.request.headers.has("origin") || context.request.headers.has("sec-fetch-site"))
    throw new ApiError(403, "Use edit remote on the Mac running this Edit.");
}

export function routes(router: Router<App>) {
  router.get("/api/remote-support", context => { requireLocalCli(context); return json(settings(context.app)); });
  // This Mac's own report, as an admin would get it (nothing sent).
  router.get("/api/remote-support/report", async context => { requireLocalCli(context); return new Response(diag.scrub(await actions.report(context.app)), { headers: { "content-type": "text/plain; charset=utf-8" } }); });
  router.post("/api/remote-support", async context => {
    requireLocalCli(context);
    const given = await readJson<{ action?: string; device?: string; project?: string }>(context);
    const app = context.app; const action = given?.action;
    if (action === "disable") throw bad("Remote support is always on: every signed-in Edit can be reached by an admin, so problems can be fixed from afar.");
    if (!action || !["enable", "devices", "history", "update", "diagnostics", "resume"].includes(action)) throw bad("Choose enable, devices, update, diagnostics, resume or history.");
    if (["history", "update", "diagnostics", "resume"].includes(action) && (typeof given.device !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/u.test(given.device))) throw bad("Give a valid device id.");
    if (action === "resume" && (typeof given.project !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/u.test(given.project))) throw bad("Give a valid project id.");
    try {
      const c = await client(app);
      // Always on: "enable" registers this Mac again now, as a start does.
      if (action === "enable") {
        await registerAutomatically(app, c, () => authorized(app));
        await connect(app);
        return json(settings(app));
      }
      if (action === "devices") return json(await rpc(c.query(query("devices"), {})));
      if ((action === "update" || action === "history") && typeof given.device === "string") {
        if (action === "history") return json(await rpc(c.query(query("history"), { deviceId: given.device })));
        const commandId = crypto.randomUUID();
        await rpc(c.mutation(mutation("requestUpdate"), { deviceId: given.device, commandId }));
        return json({ commandId });
      }
      if ((action === "diagnostics" || action === "resume") && typeof given.device === "string") {
        const commandId = crypto.randomUUID();
        await rpc(c.mutation(mutation("requestAction"), { deviceId: given.device, commandId, kind: action, ...(action === "resume" ? { projectId: given.project } : {}) }));
        return json({ commandId });
      }
      throw new Error("Choose enable, devices, update, diagnostics, resume or history.");
    } catch (error) { throw bad(diag.messageOf(error)); }
  });
}
