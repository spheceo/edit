// Problem reports in the team's cloud: each Mac's latest, kept up to date by
// Edit itself, so an admin reads what failed on a Mac that's since been closed
// (the user, Oct 30: "even when their computers are off we know what failed
// for them").

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";

import * as accounts from "../src/accounts.ts";
import * as cloud from "../src/cloud.ts";
import { latest, publishLatest } from "../src/problem_reports.ts";
import { scratch } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;
const home = scratch("reports");

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  cloud.timing.sleep = async () => {};
});

afterAll(() => {
  accounts.resetForTests();
  restore();
  mock.stop();
  home.cleanup();
});

test("each Mac's latest report replaces the one before, and only an admin reads them", async () => {
  accounts.signedInForTests(["use"]);
  await publishLatest(home.dir, "kenobi", "Needs attention:\nthe first");
  await publishLatest(home.dir, "kenobi", "Needs attention:\nthe second");
  await publishLatest(home.dir, "JJ's MacBook Pro", "Needs attention:\nScript 3e4f: its import stopped");
  await expect(latest(home.dir)).rejects.toThrow(/admin/u);

  accounts.signedInForTests(["use"], true);
  const reports = await latest(home.dir);
  expect(reports.map((report) => report.mac).sort()).toEqual(["JJ's MacBook Pro", "kenobi"]);
  const kenobi = reports.find((report) => report.mac === "kenobi")!;
  expect(fs.readFileSync(kenobi.path, "utf8")).toContain("the second");
  expect(kenobi.from).toBe("Test Person <test@example.com>");
});
