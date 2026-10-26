import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { RemoteCommandReceipts } from "../src/remote_commands.ts";

test("remote commands are claimed once, including across restarts", () => {
  const home = fs.mkdtempSync(join(os.tmpdir(), "edit-remote-"));
  try {
    const command = { id: "command-1", device: "device-1", kind: "update" as const, expiresAt: 100 };
    const first = new RemoteCommandReceipts(home, "device-1");
    expect(first.claim(command, 1)).toBe(true);
    const restarted = new RemoteCommandReceipts(home, "device-1");
    expect(restarted.claim(command, 1)).toBe(false);
    expect(restarted.read(command.id)?.state).toBe("claimed");
    restarted.finish(command.id, "complete");
    expect(first.read(command.id)?.state).toBe("complete");
    expect(() => restarted.finish(command.id, "complete")).toThrow();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("expired, wrong-device and agent commands never claim work", () => {
  const home = fs.mkdtempSync(join(os.tmpdir(), "edit-remote-"));
  try {
    const receipts = new RemoteCommandReceipts(home, "device-1");
    const command = { id: "one", device: "device-1", kind: "update" as const, expiresAt: 100 };
    expect(receipts.claim(command, 100)).toBe(false);
    expect(receipts.claim({ ...command, device: "another" }, 1)).toBe(false);
    expect(receipts.claim({ ...command, kind: "agent" }, 1)).toBe(false);
    expect(() => receipts.claim({ ...command, id: "../bad" }, 1)).toThrow();
    expect(receipts.read(command.id)).toBeNull();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
