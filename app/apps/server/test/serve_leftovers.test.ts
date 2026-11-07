import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { endLeftovers } from "../src/serve.ts";

test("a restart ends the agent's processes the last run left under this process, nothing else", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "edit-leftovers-"));
  // A stand-in `claude` that keeps its name (no exec), as the agent's does while it works.
  fs.writeFileSync(join(dir, "claude"), "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
  // Both under a parent of their own standing in for the server: under the test
  // runner itself, other tests' FFmpeg would be ended too (and counted).
  const parent = Bun.spawn(["/bin/sh", "-c", `"${join(dir, "claude")}" --output-format stream-json & sleep 30 & echo started; wait`], { stdout: "pipe", stderr: "ignore" });
  const reader = parent.stdout.getReader();
  await reader.read();
  await Bun.sleep(300);
  const children = () =>
    new TextDecoder()
      .decode(Bun.spawnSync(["/bin/ps", "-axo", "ppid=,command="], { stdout: "pipe" }).stdout)
      .split("\n")
      .filter((line) => Number(line.trim().split(/\s+/)[0]) === parent.pid);
  try {
    expect(children().some((line) => line.includes("sleep 30") && !line.includes("claude"))).toBe(true);
    expect(endLeftovers(parent.pid)).toEqual(["claude"]);
    await Bun.sleep(500);
    const left = children();
    expect(left.some((line) => line.includes("claude"))).toBe(false);
    expect(left.some((line) => line.includes("sleep 30"))).toBe(true);
  } finally {
    parent.kill();
    Bun.spawnSync(["/usr/bin/pkill", "-P", String(parent.pid)]);
  }
});
