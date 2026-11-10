// Getting ready for a restart Edit makes itself (an update): paid requests in
// flight are answered and kept first, new ones wait, and every program this
// run started is stopped before the new run starts its own.

import { afterEach, expect, test } from "bun:test";

import * as paid from "../src/paid.ts";
import { stopChildren } from "../src/serve.ts";

afterEach(() => paid.reset());

test("a restart waits for the paid requests in flight, and holds new ones", async () => {
  let answer!: () => void;
  const inFlight = paid.paid(() => new Promise<void>((resolve) => (answer = resolve)));
  await Bun.sleep(1);
  expect(paid.count()).toBe(1);
  const settling = paid.settle(5_000);
  let started = false;
  void paid.paid(async () => {
    started = true;
  });
  await Bun.sleep(20);
  // Not yet: one is still being answered, and the new one waits.
  expect(started).toBe(false);
  answer();
  await inFlight;
  expect(await settling).toBe(true);
  expect(started).toBe(false);
});

test("a restart doesn't wait for ever on a request that never answers", async () => {
  void paid.paid(() => new Promise<void>(() => {}));
  await Bun.sleep(1);
  expect(await paid.settle(50)).toBe(false);
});

test("every program this run started, and theirs, is stopped before the restart", async () => {
  const child = Bun.spawn(["/bin/sh", "-c", "sleep 30 & sleep 30; wait"], { stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(200);
  const stopped = await stopChildren(1_000);
  expect(stopped).toContain("sh");
  expect(stopped.filter((name) => name === "sleep").length).toBe(2);
  await child.exited;
  const left = Bun.spawnSync(["/bin/ps", "-axo", "ppid=,command="]).stdout.toString();
  expect(left.split("\n").some((line) => line.trim().startsWith(`${child.pid} `))).toBe(false);
});
