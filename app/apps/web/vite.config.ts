import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { createServer as createHttpServer, request as createRequest, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";

const server = process.env.EDIT_SERVER ?? "http://127.0.0.1:7700";

let lastReport = 0;
/** Tells Edit's log (Report a problem shows it) which request the proxy lost, at most once a second. */
function reportProxyReset(request: { method?: string; url?: string }) {
  if (Date.now() - lastReport < 1000) return;
  lastReport = Date.now();
  const body = JSON.stringify({ level: "warn", message: `dev proxy: connection to Edit reset on ${request.method ?? "?"} ${request.url ?? "?"} (answered 503)` });
  const post = createRequest(`${server}/api/diagnostics/client`, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } });
  post.on("error", () => {});
  post.end(body);
}

/**
 * While `edit serve` restarts (cargo watch), answer quietly instead of
 * logging a stack per request: 503 + `restarting` tells the client to retry.
 * Must run before Vite's own error listener, which logs everything.
 */
const quietWhileRestarting = {
  target: server,
  configure(proxy: { emit: (event: string, ...args: unknown[]) => boolean }) {
    const emit = proxy.emit.bind(proxy);
    proxy.emit = (event, ...args) => {
      const code = (args[0] as NodeJS.ErrnoException | undefined)?.code;
      if (event !== "error" || (code !== "ECONNREFUSED" && code !== "ECONNRESET")) return emit(event, ...args);
      const target = args[2] as ServerResponse | Socket;
      // A reset (not a restart: then Edit refuses outright) is worth seeing in Edit's log.
      if (code === "ECONNRESET") reportProxyReset((args[1] as { method?: string; url?: string } | undefined) ?? {});
      if ("req" in target) {
        if (!target.headersSent) target.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
        target.end(JSON.stringify({ error: "Edit's server is restarting", restarting: true }));
      } else {
        target.destroy();
      }
      return true;
    };
  },
};

/**
 * WebGPU only runs on secure pages, so serve the dev UI over HTTPS with this
 * machine's Tailscale certificate (a real Let's Encrypt cert for
 * <machine>.<tailnet>.ts.net). Falls back to plain HTTP if Tailscale isn't
 * available. EDIT_HTTPS=0 disables it.
 */
function tailscaleHttps(): { cert: Buffer; key: Buffer; name: string } | undefined {
  if (process.env.EDIT_HTTPS === "0") return undefined;
  const binary = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"].find((candidate) => {
    try {
      execFileSync(candidate, ["version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  if (!binary) return undefined;
  try {
    const status = JSON.parse(execFileSync(binary, ["status", "--json"], { encoding: "utf8" }));
    const name = String(status.Self?.DNSName ?? "").replace(/\.$/, "");
    if (!name.endsWith(".ts.net")) return undefined;
    const dir = join(process.env.EDIT_HOME ?? join(homedir(), ".edit"), "certs");
    const cert = join(dir, `${name}.crt`);
    const key = join(dir, `${name}.key`);
    // Certs last ~90 days; refresh weekly so dev never hits an expired one.
    const stale = !existsSync(cert) || Date.now() - statSync(cert).mtimeMs > 7 * 24 * 3600 * 1000;
    if (stale) {
      mkdirSync(dir, { recursive: true });
      execFileSync(binary, ["cert", "--cert-file", cert, "--key-file", key, name], { stdio: "ignore" });
    }
    return { cert: readFileSync(cert), key: readFileSync(key), name };
  } catch (error) {
    console.warn(`edit: Tailscale HTTPS unavailable, serving plain HTTP (${(error as Error).message})`);
    return undefined;
  }
}

const https = tailscaleHttps();
if (https) console.log(`\n  Edit (secure, WebGPU on): https://${https.name}:5173  (http://${hostname().split(".")[0].toLowerCase()}:5173 redirects here)\n`);

/**
 * Lets plain-HTTP visits (e.g. typing `kenobi:5173`) share the HTTPS port and
 * get redirected to the secure ts.net address. TLS connections start with a
 * 0x16 handshake byte; anything else is HTTP.
 */
function httpRedirect(secureName: string): Plugin {
  return {
    name: "edit-http-redirect",
    configureServer(server) {
      const tlsServer = server.httpServer;
      if (!tlsServer) return;
      // Vite serves HTTP/2 over TLS, and Node's HTTP/2 compat layer can lose a
      // large upload's end-of-stream under backpressure, leaving the proxied
      // request open forever. Offer only HTTP/1.1 (length-prefixed ALPN list).
      (tlsServer as unknown as { ALPNProtocols: Buffer }).ALPNProtocols = Buffer.from("\x08http/1.1", "latin1");
      const redirect = createHttpServer((request, response) => {
        response.writeHead(307, { location: `https://${secureName}:${request.socket.localPort}${request.url ?? "/"}` });
        response.end();
      });
      const tlsHandlers = tlsServer.listeners("connection") as ((socket: Socket) => void)[];
      tlsServer.removeAllListeners("connection");
      tlsServer.on("connection", (socket: Socket) => {
        socket.once("data", (chunk: Buffer) => {
          socket.pause();
          socket.unshift(chunk);
          if (chunk[0] === 0x16) for (const handler of tlsHandlers) handler.call(tlsServer, socket);
          else redirect.emit("connection", socket);
          process.nextTick(() => socket.resume());
        });
      });
    },
  };
}

/**
 * src/lib holds the app's live singletons (preview engine, playhead, stores,
 * the events socket) and src/engine the WASM build. Hot-swapping them leaves
 * two copies alive (a reset timeline zoom, a detached preview), so reload the
 * page instead. Components still Fast Refresh.
 */
function reloadOnCoreChange(): Plugin {
  return {
    name: "edit-reload-on-core-change",
    handleHotUpdate({ file, server }) {
      if (!/\/src\/(lib|engine)\//.test(file)) return;
      server.ws.send({ type: "full-reload" });
      return [];
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), reloadOnCoreChange(), ...(https ? [httpRedirect(https.name)] : [])],
  // The relay's code is tested here too; the Workers runtime's modules aren't.
  resolve: {
    alias: {
      "cloudflare:workers": join(import.meta.dirname, "../relay/src/runtime-stub.ts"),
      "cloudflare:workflows": join(import.meta.dirname, "../relay/src/runtime-stub.ts"),
    },
  },
  server: {
    port: 5173,
    // Reachable over Tailscale (and LAN) for remote dev; names below are allowed Host headers.
    host: "0.0.0.0",
    allowedHosts: [hostname().split(".")[0].toLowerCase(), ".ts.net"],
    https: https && { cert: https.cert, key: https.key },
    proxy: {
      "/api": { ...quietWhileRestarting, ws: true },
      "/fonts": quietWhileRestarting,
      "/mcp": quietWhileRestarting,
    },
  },
  build: {
    // Function names survive minifying, so an error's stack (and React's component stack) names the code it came from.
    rolldownOptions: { output: { minify: { compress: { keepNames: { function: true, class: true } }, mangle: { keepNames: true } } } },
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
});
