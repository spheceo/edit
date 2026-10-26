// An operator's client for an Edit the owner already shared over Tailscale.
// This creates no listener, pairing, login, shell access or background job.
import * as fs from "node:fs";
import { scrub } from "./diag.ts";

export const HELP = `edit support — help an owner-shared Edit over Tailscale

USAGE
  edit support status --url https://<device>.<tailnet>.ts.net
  edit support projects --url <url>
  edit support diagnostics --url <url>
  edit support chat <project id> --url <url>
  edit support ask <project id> --url <url> --message-file <text file>
  edit support stop <project id> --url <url>

The owner must share this HTTPS endpoint and grant your device access through
Tailscale. This command does not establish access or pair devices. Requests use
the running Edit's normal account permissions and cloud-project locks. Ask sends
one explicit message to that project's existing agent on the owner's Mac; it
does not retry on a dropped connection. Check chat before deciding to send again.
Output is JSON with URLs, tokens and credential fields redacted. No settings,
updates, login actions, shell commands or automatic repairs are exposed here.
`;

type Command = "status" | "projects" | "diagnostics" | "chat" | "ask" | "stop";
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Only an explicitly shared standard Tailscale HTTPS endpoint, never userinfo,
 * a proxy path, query credentials, an arbitrary LAN host or a redirect target. */
export function supportUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("--url must be the owner's HTTPS Tailscale endpoint"); }
  if (url.protocol !== "https:" || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ts\.net$/iu.test(url.hostname)
    || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("--url must be https://<device>.<tailnet>.ts.net without credentials, a path or a query");
  }
  return url.origin;
}

/** Diagnostics and agent replies can contain old logs; redact their values too,
 * rather than relying solely on the remote server's version of log scrubbing. */
export function redactSupport(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSupport);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /authorization|token|password|cookie|secret|credential|api.?key|auth.?url|device.?code/iu.test(key) ? "[redacted]" : redactSupport(item)]));
  }
  if (typeof value !== "string") return value;
  return scrub(value)
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/giu, "$1: [redacted]")
    .replace(/\bBearer\s+[^\s,;"']+/giu, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted]")
    .replace(/\b(?:sk-ant-|sk-proj-|sk-)[A-Za-z0-9_-]{10,}/gu, "[redacted]")
    .replace(/\b((?:access[_ -]?token|refresh[_ -]?token|api[_ -]?key|password|secret|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, "$1[redacted]");
}

interface Options { command: Command; url: string; project?: string; messageFile?: string }

function parse(args: string[]): Options {
  const rest = [...args];
  const command = rest.shift() as Command;
  if (!["status", "projects", "diagnostics", "chat", "ask", "stop"].includes(command)) throw new Error(`unknown support command; see edit support help`);
  const needsProject = ["chat", "ask", "stop"].includes(command);
  const project = needsProject ? rest.shift() : undefined;
  if (needsProject && (!project || !/^[a-zA-Z0-9_-]{1,120}$/u.test(project))) throw new Error("give the exact project id from support projects");
  const flags = new Map<string, string>();
  while (rest.length) {
    const name = rest.shift()!;
    const value = rest.shift();
    if (!["--url", "--message-file"].includes(name) || value === undefined || value.startsWith("--") || flags.has(name)) throw new Error("expected --url <url> and, for ask only, --message-file <text file>");
    flags.set(name, value);
  }
  if (!flags.has("--url")) throw new Error("give the owner's shared endpoint with --url");
  if ((command === "ask") !== flags.has("--message-file")) throw new Error("--message-file is required for ask and only accepted by ask");
  return { command, url: supportUrl(flags.get("--url")!), project, messageFile: flags.get("--message-file") };
}

/** One bounded HTTP attempt per action. Fetch/read injection keeps tests offline. */
export async function runSupport(args: string[], options: { fetch?: Fetch; read?: (path: string) => string } = {}): Promise<string> {
  if (!args.length || ["help", "--help", "-h"].includes(args[0]!)) return HELP;
  const given = parse(args);
  const fetcher = options.fetch ?? fetch;
  // Read/validate the explicit prompt before even looking up the remote project.
  let message: string | undefined;
  if (given.messageFile !== undefined) {
    const path = given.messageFile;
    if (!options.read) {
      const file = fs.statSync(path);
      if (!file.isFile() || file.size > 64 * 1024) throw new Error("the support message must be a regular text file of at most 64 KiB");
    }
    message = (options.read ?? ((path) => fs.readFileSync(path, "utf8")))(path).trim();
    if (!message || Buffer.byteLength(message) > 64 * 1024) throw new Error("the support message must be nonempty and at most 64 KiB");
  }
  const request = async (path: string, payload?: unknown): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetcher(`${given.url}${path}`, { method: payload === undefined ? "GET" : "POST", redirect: "error",
        signal: AbortSignal.timeout(30_000), headers: { accept: "application/json", ...(payload === undefined ? {} : { "content-type": "application/json" }) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    } catch {
      throw new Error(payload === undefined ? "The shared Edit could not be reached. Check the endpoint, Tailscale access and that Edit is open."
        : "No acknowledgement from the remote Edit. The command may have arrived; inspect support chat before sending again. Nothing was retried.");
    }
    let value: unknown;
    try { value = await response.json(); } catch { throw new Error(`The shared endpoint did not return Edit JSON (${response.status}). Check that Tailscale Serve points at Edit.`); }
    if (!response.ok) {
      const error = value !== null && typeof value === "object" && "error" in value ? String(value.error) : `request refused (${response.status})`;
      throw new Error(String(redactSupport(error)));
    }
    return value;
  };
  if (given.project !== undefined) {
    // Do not open the project: GET /api/projects/{id} would change the owner's
    // active UI project. The visible list honors the owner's normal grants.
    const visible = await request("/api/projects") as { projects?: { id?: string }[] };
    if (!Array.isArray(visible.projects) || !visible.projects.some((project) => project.id === given.project)) throw new Error("That project is not in the remote account's visible project list.");
  }
  const project = encodeURIComponent(given.project ?? "");
  const value = given.command === "status" ? { health: await request("/api/health"), agent: await request("/api/agent") }
    : given.command === "projects" ? await request("/api/projects")
    : given.command === "diagnostics" ? await request("/api/diagnostics")
    : given.command === "chat" ? await request(`/api/projects/${project}/agent`)
    : given.command === "ask" ? await request(`/api/projects/${project}/agent`, { text: message })
    : await request(`/api/projects/${project}/agent/stop`, {});
  return JSON.stringify(redactSupport(value), null, 2);
}
