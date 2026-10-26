// Durable, at-most-once execution for future remote support commands. Nothing
// subscribes to or executes commands until the device transport is configured.
import * as fs from "node:fs";
import { join } from "node:path";

export type RemoteCommand = {
  id: string;
  device: string;
  expiresAt: number;
  kind: "update" | "agent";
};

export type Receipt = {
  id: string;
  kind: RemoteCommand["kind"];
  state: "claimed" | "complete" | "failed";
  detail?: string;
};

/** A claimed command is never replayed, including after a process crash. */
export class RemoteCommandReceipts {
  private readonly dir: string;

  constructor(home: string, private readonly device: string) {
    this.dir = join(home, "remote-commands");
  }

  private path(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,120}$/u.test(id)) throw new Error("invalid remote command id");
    return join(this.dir, `${id}.json`);
  }

  read(id: string): Receipt | null {
    try {
      return JSON.parse(fs.readFileSync(this.path(id), "utf8")) as Receipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** Claim on disk before performing work. A repeated or expired command is refused. */
  claim(command: RemoteCommand, now = Date.now()): boolean {
    const path = this.path(command.id);
    if (command.device !== this.device || !Number.isFinite(command.expiresAt) || command.expiresAt <= now) return false;
    // Remote agent work stays disabled until its spending limit is implemented.
    if (command.kind !== "update") return false;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(path, JSON.stringify({ id: command.id, kind: command.kind, state: "claimed" } satisfies Receipt), { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  finish(id: string, state: "complete" | "failed", detail?: string): void {
    const receipt = this.read(id);
    if (receipt === null || receipt.state !== "claimed") throw new Error("remote command was not claimed");
    const path = this.path(id);
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ ...receipt, state, ...(detail === undefined ? {} : { detail }) } satisfies Receipt), { flag: "wx", mode: 0o600 });
      fs.renameSync(temp, path);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
}
