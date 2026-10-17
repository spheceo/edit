// The server's shared state, handed to every route and tool (server.rs App).
// One per server; tests make their own over a fixture home. The renderer that
// was `App.frames` is the addon's (its queue lives there: `native.renderFrames`).

import * as os from "node:os";

import { Processor } from "./media.ts";
import { native, type Native } from "./native/index.ts";
import {
  unportedServices,
  type Agents,
  type Exports,
  type Library,
  type ScriptJobs,
  type Updater,
  type Voices,
} from "./seams.ts";
import { Store } from "./store.ts";

export interface App {
  store: Store;
  media: Processor;
  native: Native;
  exports: Exports;
  /** Host names a request may name (DNS-rebinding guard; `http/host.ts`). */
  allowedHosts: string[];
  /** Short host name of the machine running Edit (shown in the UI). */
  machine: string;
  /** The port the server listens on (the agent's MCP URL, map pages). */
  port: number;
  agents: Agents;
  scripts: ScriptJobs;
  library: Library;
  updater: Updater;
  voices: Voices;
}

export interface AppOptions {
  store: Store;
  port?: number;
  allowedHosts?: string[];
  machine?: string;
  /** The services other packages make; "not ported" stubs until they land. */
  services?: Partial<Pick<App, "exports" | "agents" | "scripts" | "library" | "updater" | "voices">>;
}

export function createApp(options: AppOptions): App {
  const services = { ...unportedServices(options.store.home), ...options.services };
  return {
    store: options.store,
    media: new Processor(options.store),
    native: native(),
    exports: services.exports,
    allowedHosts: options.allowedHosts ?? ["localhost", "127.0.0.1", "::1"],
    machine: options.machine ?? hostname() ?? "this machine",
    port: options.port ?? 7700,
    agents: services.agents,
    scripts: services.scripts,
    library: services.library,
    updater: services.updater,
    voices: services.voices,
  };
}

/** This machine's short host name, lowercase (`hostname -s`), or null. */
export function hostname(): string | null {
  const name = os.hostname().split(".")[0]?.trim().toLowerCase() ?? "";
  return name === "" ? null : name;
}
