// Starting and talking to one server of the pair (Rust on :7801, TS on :7802):
// the process, its log, HTTP and MCP calls, and its websocket events.

import * as fs from "node:fs";
import * as nodePath from "node:path";

import type { Subprocess } from "bun";

export type SideName = "rust" | "ts";

export interface ServerConfig {
  side: SideName;
  port: number;
  home: string;
  /** The HOME the server sees (shared by both: /api/fs, default export folders). */
  user: string;
  env: Record<string, string>;
  rust: string;
  native: string;
  web: string;
  repo: string;
  log: string;
}

/** An HTTP exchange as a step sees it. */
export interface Reply {
  status: number;
  type: string;
  /** Parsed JSON, else the text, else null for bytes. */
  body: unknown;
  bytes: Uint8Array;
  headers: Record<string, string>;
}

export class Side {
  readonly name: SideName;
  readonly port: number;
  readonly home: string;
  readonly user: string;
  /** Values steps keep (a created project's id, a revision). */
  readonly vars: Record<string, unknown> = {};
  /** Every websocket message since the start, parsed. */
  readonly events: Record<string, unknown>[] = [];
  /** Routes ("GET /api/x/{id}") and tools this side was asked for. */
  readonly asked = new Set<string>();
  private process: Subprocess | null = null;
  private socket: WebSocket | null = null;
  private nextId = 1;

  constructor(readonly config: ServerConfig) {
    this.name = config.side;
    this.port = config.port;
    this.home = config.home;
    this.user = config.user;
  }

  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    const { config } = this;
    fs.mkdirSync(nodePath.dirname(config.log), { recursive: true });
    const out = fs.openSync(config.log, "a");
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: config.user,
      CODEX_HOME: nodePath.join(config.user, ".codex"),
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      LANG: "en_US.UTF-8",
      ...config.env,
    };
    const args = ["serve", "--port", String(config.port), "--home", config.home];
    const command =
      config.side === "rust"
        ? [config.rust, ...args]
        : [process.execPath, nodePath.join(config.repo, "apps/server/src/main.ts"), ...args];
    if (config.side === "ts") {
      env.EDIT_NATIVE = config.native;
      env.EDIT_WEB_DIST = config.web;
    }
    this.process = Bun.spawn(command, { env, stdin: "ignore", stdout: out, stderr: out, cwd: config.user });
    const started = Date.now();
    for (;;) {
      if (this.process.exitCode !== null) throw new Error(`${this.name} exited (${this.process.exitCode}); see ${config.log}`);
      try {
        const response = await fetch(`${this.base}/api/health`);
        if (response.ok) break;
      } catch {
        // not up yet
      }
      if (Date.now() - started > 60_000) throw new Error(`${this.name} didn't answer in 60 s; see ${config.log}`);
      await Bun.sleep(100);
    }
    await this.listen();
  }

  private async listen(): Promise<void> {
    const socket = new WebSocket(`ws://127.0.0.1:${this.port}/api/ws`);
    socket.onmessage = (message) => {
      try {
        this.events.push(JSON.parse(String(message.data)) as Record<string, unknown>);
      } catch {
        this.events.push({ unparsed: String(message.data) });
      }
    };
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error(`${this.name}: websocket didn't open`));
    });
    this.socket = socket;
    this.asked.add("GET /api/ws");
  }

  async stop(): Promise<void> {
    this.socket?.close();
    this.socket = null;
    const child = this.process;
    this.process = null;
    if (child === null || child.exitCode !== null) return;
    child.kill("SIGINT");
    const deadline = Date.now() + 10_000;
    while (child.exitCode === null && Date.now() < deadline) await Bun.sleep(50);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }

  get running(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  async http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    this.asked.add(`${method} ${path.split("?")[0]}`);
    const init: RequestInit = { method, headers: { ...headers } };
    if (body instanceof Uint8Array) {
      init.body = body;
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["content-type"] = "application/json";
    }
    const response = await fetch(`${this.base}${path}`, init);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const type = response.headers.get("content-type") ?? "";
    let parsed: unknown = null;
    if (type.includes("json") || type.startsWith("text/")) {
      const text = new TextDecoder().decode(bytes);
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    const kept: Record<string, string> = {};
    for (const [key, value] of response.headers) kept[key] = value;
    return { status: response.status, type, body: parsed, bytes, headers: kept };
  }

  /** A JSON-RPC call to /mcp (scoped to `project` when given). */
  async rpc(method: string, params: unknown, project?: string): Promise<Reply> {
    const id = this.nextId++;
    return this.http("POST", project === undefined ? "/mcp" : `/mcp?project=${project}`, { jsonrpc: "2.0", id, method, params });
  }

  /** tools/call `name` with `args`: the reply's result (content, isError), or the JSON-RPC error. */
  async tool(name: string, args: Record<string, unknown>, project?: string): Promise<{ status: number; result: unknown; error: unknown }> {
    this.asked.add(`tool ${name}`);
    const reply = await this.rpc("tools/call", { name, arguments: args }, project);
    const body = reply.body as { result?: unknown; error?: unknown } | string | null;
    if (body === null || typeof body !== "object") return { status: reply.status, result: body, error: null };
    return { status: reply.status, result: body.result ?? null, error: body.error ?? null };
  }

  /** Waits until `check` is true (polling), up to `ms`. */
  async until(check: () => Promise<boolean> | boolean, ms = 120_000, every = 250): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await check()) return true;
      await Bun.sleep(every);
    }
    return false;
  }

  /** Waits for the event stream to be quiet for `quiet` ms (at most `ms`). */
  async settle(quiet = 400, ms = 30_000): Promise<void> {
    const deadline = Date.now() + ms;
    let seen = this.events.length;
    let since = Date.now();
    while (Date.now() < deadline) {
      await Bun.sleep(100);
      if (this.events.length !== seen) {
        seen = this.events.length;
        since = Date.now();
      } else if (Date.now() - since >= quiet) {
        return;
      }
    }
  }
}
