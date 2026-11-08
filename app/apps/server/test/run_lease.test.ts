// Ideas' and Thumbnails' runs: who holds one (a lease renewed while it runs)
// and how its ending reaches the cloud (noted first, saved until it lands).
// Both runs use these; ideas.test.ts drives them end to end.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

import * as jobs from "../src/jobs.ts";
import * as runLease from "../src/run_lease.ts";

const run = (over: Partial<{ state: string; holder: string; startedAt: number; renewedAt: number }> = {}) => ({ state: "running", holder: "JJ's Mac", startedAt: Date.now(), ...over });

test("another Mac's run is theirs while its lease holds, however long the turn; lapsed, it's anyone's, and shown stopped", () => {
  const now = Date.now();
  expect(runLease.heldElsewhere(run({ startedAt: now - 40 * 60_000, renewedAt: now - 30_000 }), "Sphe's Mac", now)).toBe(true);
  expect(runLease.heldElsewhere(run({ renewedAt: now - runLease.lease.ms - 1 }), "Sphe's Mac", now)).toBe(false);
  expect(runLease.heldElsewhere(run({ renewedAt: now }), "JJ's Mac", now)).toBe(false);
  expect(runLease.heldElsewhere(run({ state: "done", renewedAt: now }), "Sphe's Mac", now)).toBe(false);
  // From a build before leases: theirs for 20 minutes from its start, as before.
  expect(runLease.heldElsewhere(run({ startedAt: now - 10 * 60_000 }), "Sphe's Mac", now)).toBe(true);
  expect(runLease.heldElsewhere(run({ startedAt: now - 25 * 60_000 }), "Sphe's Mac", now)).toBe(false);
  expect(runLease.stale(run({ renewedAt: now - runLease.lease.ms - 1 }), now)).toMatchObject({ state: "stopped", error: "JJ's Mac stopped answering before Claude finished. Ask again." });
  expect(runLease.stale(run({ renewedAt: now }), now).state).toBe("running");
});

test("an ending that never lands is kept failed, with why, after its tries; one with nowhere to go is dropped", async () => {
  const home = fs.mkdtempSync(`${os.tmpdir()}/edit-lease-`);
  const { tries, retryMs } = runLease.lease;
  runLease.lease.tries = 3;
  runLease.lease.retryMs = () => 5;
  try {
    const key = jobs.begin(home, "thumbnail", "t1", { holder: "Sphe's Mac", by: "Sphe", startedAt: 1 });
    runLease.ended(home, key, { state: "done", text: "Done." });
    let attempts = 0;
    expect(await runLease.land(home, key, async () => {
      attempts++;
      throw new Error("the cloud is down");
    }, "thumbnails")).toBe(false);
    for (let wait = 0; wait < 100 && jobs.get(home, key)?.state !== "failed"; wait++) await Bun.sleep(5);
    expect(attempts).toBe(3);
    expect(jobs.get(home, key)).toMatchObject({ state: "failed", error: "how it ended never reached the cloud: the cloud is down" });
    // Nowhere to go (deleted, or a newer turn took its place): crossed off.
    const other = jobs.begin(home, "thumbnail", "t2", {});
    runLease.ended(home, other, { state: "done", text: "Done." });
    expect(await runLease.land(home, other, async () => false, "thumbnails")).toBe(true);
    expect(jobs.get(home, other)).toBeUndefined();
  } finally {
    runLease.lease.tries = tries;
    runLease.lease.retryMs = retryMs;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
