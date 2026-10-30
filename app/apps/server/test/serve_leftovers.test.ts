import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { endLeftovers } from "../src/serve.ts";

test("a restart ends the agent's processes the last run left under this process, nothing else", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "edit-leftovers-"));
  // A stand-in `claude` that keeps its name (no exec), as the agent's does while it works.
  fs.writeFileSync(join(dir, "claude"), "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
  const claude = Bun.spawn([join(dir, "claude"), "--output-format", "stream-json"], { stdout: "ignore", stderr: "ignore" });
  const other = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(300);
  try {
    expect(endLeftovers()).toEqual(["claude"]);
    expect(await Promise.race([claude.exited, Bun.sleep(2000).then(() => "still running")])).not.toBe("still running");
    expect(other.exitCode).toBeNull();
  } finally {
    claude.kill();
    other.kill();
  }
});
