// Problem reports sent from Report a problem: the person presses Send and
// their report (what went wrong, Edit's recent log, how long things took)
// goes to the team's cloud, so nobody copies and pastes an error into a chat
// any more (the user, Oct 28: "if you click report a problem and it gets
// stored, so on this very machine we can pull the problems people have, that
// would be great"). Kept under `edit/reports/<day>/` on R2: anyone signed in
// sends, only an admin reads or lists (the relay holds that line). A copy
// stays on the sender's Mac too.

import * as fs from "node:fs";

import * as accounts from "./accounts.ts";
import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";
import { join } from "./paths.ts";
import { BUILD } from "./version.ts";

const PREFIX = "edit/reports/";
/** Reports are text; anything longer is cut (a runaway log). */
const MAX_BYTES = 2_000_000;

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "mac";
}

/** Sends a report to the team (and keeps a copy here); where it went. */
export async function send(home: string, machine: string, report: string): Promise<{ key: string }> {
  const text = report.trim();
  if (text === "") throw new Error("the report is empty");
  const person = accounts.status() as { signed_in?: boolean; person?: { name?: string; email?: string } | null };
  if (person.signed_in !== true) throw new Error("Sign in to Edit to send a report.");
  const now = Date.now();
  const from = person.person ? `${person.person.name ?? ""} <${person.person.email ?? ""}>` : "unknown";
  const body = `From: ${from}\nMac: ${machine}\nEdit: ${BUILD}\nSent: ${new Date(now).toISOString()}\n\n${text}`.slice(0, MAX_BYTES);
  const key = `${PREFIX}${day(now)}/${slug(machine)}-${now}.txt`;
  const dir = join(home, "reports-sent");
  fs.mkdirSync(dir, { recursive: true });
  const local = join(dir, `${day(now)}-${now}.txt`);
  fs.writeFileSync(local, body);
  await cloud.uploadFile(local, key);
  diag.info("reports", `sent a problem report (${body.length} characters)`);
  return { key };
}

export interface Pulled {
  key: string;
  from: string;
  mac: string;
  sent: string;
  /** Its first lines: what went wrong. */
  summary: string;
  /** Where it is on this Mac. */
  path: string;
}

/**
 * The team's reports of the last `days` days, newest first, fetched to
 * `<home>/reports-inbox/` (each once). Only an admin may: the relay refuses
 * anyone else.
 */
export async function pull(home: string, days: number): Promise<Pulled[]> {
  const status = accounts.status() as { admin?: boolean };
  if (status.admin !== true) throw new Error("Only an admin can read the team's problem reports.");
  const inbox = join(home, "reports-inbox");
  fs.mkdirSync(inbox, { recursive: true });
  const out: Pulled[] = [];
  for (let back = 0; back < Math.max(1, Math.min(days, 60)); back++) {
    const objects = await cloud.list(`${PREFIX}${day(Date.now() - back * 86_400_000)}/`);
    for (const object of objects) {
      const path = join(inbox, object.key.slice(PREFIX.length).replace(/\//g, "_"));
      if (!fs.existsSync(path)) await cloud.download(object.key, path);
      const text = fs.readFileSync(path, "utf8");
      const field = (name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(text)?.[1] ?? "";
      const rest = text.split("\n\n").slice(1).join("\n\n");
      out.push({ key: object.key, from: field("From"), mac: field("Mac"), sent: field("Sent"), summary: rest.split("\n").filter((line) => line.trim() !== "").slice(0, 3).join(" ").slice(0, 300), path });
    }
  }
  return out.sort((a, b) => (a.sent < b.sent ? 1 : -1));
}
