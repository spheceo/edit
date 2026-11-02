// Connects the team's OpenArt account to the relay (Nov 2: "the team shares
// one team account… add the account as mamagi-openart-1… we save the auth
// details to infisical and we use that"). Thumbnails make their pictures on
// OpenArt through its MCP server; the relay holds the sign-in and every Edit
// reaches OpenArt through it (`/v1/openart/mcp`), so no install ever has it.
//
//   bun scripts/openart-connect.ts [--env dev|prod] [--label mamagi-openart-1]
//
// Registers a client with OpenArt (OAuth 2.1, PKCE, its dynamic
// registration), prints the link to sign in with, and waits on this Mac
// (http://127.0.0.1:8799/callback) for OpenArt to send the browser back.
// Opened on another computer, the page back won't load: paste its whole
// address into this terminal instead. The client id, the refresh token and the
// account's label go to Infisical (Platform, `/edit-relay`, that environment)
// through files, never an argument or a log; then push them to the Worker:
//
//   bun scripts/push-secrets.ts --yes --only OPENART_CLIENT_ID,OPENART_REFRESH_TOKEN,OPENART_ACCOUNT

import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const PROJECT = "979fe56c-c4d0-4809-b64f-5ebc75eeaf05";
const FOLDER = "/edit-relay";
const MCP_URL = "https://mcp.openart.ai/mcp";
const PORT = 8799;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? (args[at + 1] ?? fallback) : fallback;
};
const environment = flag("--env", "dev");
const label = flag("--label", "mamagi-openart-1");
if (environment !== "dev" && environment !== "prod") throw new Error("--env must be dev or prod");

type Metadata = { issuer: string; authorization_endpoint: string; token_endpoint: string; registration_endpoint: string };
const metadata = (await (await fetch("https://openart.ai/.well-known/oauth-authorization-server")).json()) as Metadata;
for (const url of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint]) {
  if (new URL(url).hostname !== "openart.ai") throw new Error(`unexpected OpenArt endpoint ${url}`);
}

const registered = await fetch(metadata.registration_endpoint, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify({ client_name: `Edit (${label})`, redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", application_type: "native" }),
});
if (!registered.ok) throw new Error(`OpenArt refused the client (${registered.status}): ${await registered.text()}`);
const clientId = ((await registered.json()) as { client_id: string }).client_id;

const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const verifier = random();
const state = random();
const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
const link = new URL(metadata.authorization_endpoint);
for (const [key, value] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state, scope: "full_access", resource: MCP_URL })) link.searchParams.set(key, value);

console.log(`\nSign in to the team's OpenArt account (${label}) here:\n\n${link}\n`);
console.log(`Waiting for OpenArt on ${REDIRECT}… (or paste the page's whole address here)\n`);

const code = await new Promise<string>((resolve, reject) => {
  const take = (address: string): string | null => {
    const url = new URL(address);
    if (url.searchParams.get("error")) {
      reject(new Error(`OpenArt said ${url.searchParams.get("error")}: ${url.searchParams.get("error_description") ?? ""}`));
      return null;
    }
    if (url.searchParams.get("state") !== state) return null;
    return url.searchParams.get("code");
  };
  const server = Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    fetch(request) {
      const found = take(request.url);
      if (found === null) return new Response("Not this one.", { status: 400 });
      setTimeout(() => server.stop(), 100);
      resolve(found);
      return new Response("<p style='font:16px system-ui'>OpenArt is connected to Edit. You can close this tab.</p>", { headers: { "content-type": "text/html" } });
    },
  });
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    const line = chunk.trim();
    if (!line.startsWith("http")) return;
    const found = take(line);
    if (found !== null) {
      server.stop();
      resolve(found);
    }
  });
});
process.stdin.pause();

const exchanged = await fetch(metadata.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, resource: MCP_URL }),
});
if (!exchanged.ok) throw new Error(`OpenArt refused the code (${exchanged.status}): ${await exchanged.text()}`);
const tokens = (await exchanged.json()) as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
if (!tokens.refresh_token) throw new Error("OpenArt gave no refresh token: the relay couldn't keep the sign-in.");
console.log(`Signed in (access token for ${tokens.expires_in ?? "?"} s, scope ${tokens.scope ?? "?"}).`);

// Each value from a file only this user can read, removed after.
const dir = fs.mkdtempSync(join(os.tmpdir(), "openart-"));
try {
  const values: Record<string, string> = { OPENART_CLIENT_ID: clientId, OPENART_REFRESH_TOKEN: tokens.refresh_token, OPENART_ACCOUNT: label };
  const pairs = Object.entries(values).map(([key, value]) => {
    const path = join(dir, key);
    fs.writeFileSync(path, value, { mode: 0o600 });
    return `${key}=@${path}`;
  });
  const set = spawnSync("infisical", ["secrets", "set", ...pairs, `--projectId=${PROJECT}`, `--env=${environment}`, `--path=${FOLDER}`, "--silent"], { stdio: ["ignore", "ignore", "inherit"] });
  if (set.status !== 0) throw new Error("Infisical refused the secrets: is `infisical login` done?");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`Saved OPENART_CLIENT_ID, OPENART_REFRESH_TOKEN and OPENART_ACCOUNT (${label}) to Infisical ${environment} ${FOLDER}.`);
console.log(`Now: bun scripts/push-secrets.ts${environment === "prod" ? " --env prod" : ""} --yes --only OPENART_CLIENT_ID,OPENART_REFRESH_TOKEN,OPENART_ACCOUNT`);
