// Pushes edit-relay's secrets from Infisical to the Worker (`wrangler secret put`).
//
// Infisical is where every app's configuration lives: the platform's
// project ("Platform"), folder `/edit-relay` (copied from Repack's project
// on 2026-10-30): CONVEX_URL and CONVEX_SERVICE_TOKEN reference prod's
// `/mamagi`; the rest are values of their own, the shared ones copied from
// Repack's root, so a rotation there is made here too. This reads it
// into memory (`infisical export`) and hands each value to wrangler on its
// stdin: never in an argument, a file or a log. It prints names only.
//
//   bun scripts/push-secrets.ts                 what would be pushed (names), nothing sent
//   bun scripts/push-secrets.ts --yes           push them all
//   bun scripts/push-secrets.ts --yes --only A,B   push only these (the rest of the Worker's untouched)
//   --env prod                                  Infisical prod → the live Worker, edit-relay (nightlies and releases)
//   --env dev (the default)                     Infisical dev → edit-relay-dev (`just dev`, agents; wrangler's [env.dev])
//
// Each Infisical environment has its own Worker (Oct 31): dev never reaches
// what the team's installs use.
//
// A Worker secret that isn't in the folder is left as it is (never deleted).

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

// The platform's own Infisical project ("Platform"), not Repack's: /edit-relay moved there on 2026-10-30.
const PROJECT = "979fe56c-c4d0-4809-b64f-5ebc75eeaf05";
const FOLDER = "/edit-relay";
const RELAY = join(dirname(new URL(import.meta.url).pathname), "..");

const args = process.argv.slice(2);
const yes = args.includes("--yes");
const envAt = args.indexOf("--env");
const environment = envAt >= 0 ? (args[envAt + 1] ?? "dev") : "dev";
// `--only A,B` (or the names given bare): just these.
// Infisical's MODAL_TOKEN_* sign the Mac's own Modal calls in; the Worker never needs them.
const NOT_THE_WORKERS = new Set(["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "MODAL_IMAGE_BUILDER_VERSION"]);
if (environment !== "dev" && environment !== "prod") throw new Error("--env must be dev or prod");
const WORKER = environment === "prod" ? "edit-relay" : "edit-relay-dev";
const WRANGLER_ENV = environment === "prod" ? [] : ["--env", "dev"];
const only = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--env").flatMap((arg) => arg.split(",")).filter(Boolean);

function run(command: string, argv: string[], input: string | null, cwd?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    // wrangler's and infisical's own messages could echo what they were given: kept quiet.
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
    child.stdin.end(input ?? "");
  });
}

const exported = await run("infisical", ["export", `--projectId=${PROJECT}`, `--env=${environment}`, `--path=${FOLDER}`, "--format=json"], null);
if (exported.code !== 0) {
  console.error(`couldn't read ${FOLDER} from Infisical (${environment}): is \`infisical login\` done?`);
  process.exit(1);
}
const secrets = (JSON.parse(exported.out) as { key: string; value: string }[]).filter((one) => (only.length === 0 ? !NOT_THE_WORKERS.has(one.key) : only.includes(one.key)));
const unresolved = secrets.filter((one) => one.value === "" || one.value.startsWith("${"));
if (unresolved.length > 0) {
  console.error(`not resolved in Infisical (fix the reference first): ${unresolved.map((one) => one.key).join(", ")}`);
  process.exit(1);
}
const missing = only.filter((name) => !secrets.some((one) => one.key === name));
if (missing.length > 0) console.error(`not in ${FOLDER}: ${missing.join(", ")}`);
if (!yes) {
  console.log(`would push to ${WORKER} (Infisical ${environment}): ${secrets.map((one) => one.key).sort().join(", ")}`);
  console.log("nothing sent: add --yes to push");
  process.exit(0);
}
let failed = 0;
for (const one of secrets.sort((a, b) => a.key.localeCompare(b.key))) {
  const done = await run("npx", ["wrangler", "secret", "put", one.key, ...WRANGLER_ENV], one.value, RELAY);
  if (done.code === 0) console.log(`pushed ${one.key} to ${WORKER}`);
  else {
    failed += 1;
    console.error(`couldn't push ${one.key} (wrangler exited ${done.code})`);
  }
}
process.exit(failed === 0 ? 0 : 1);
