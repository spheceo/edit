import { expect, test } from "bun:test";
import * as fs from "node:fs";

import { exportConfirmations, storageReport, verifyExports } from "../src/storage.ts";
import { fixtureHome, write } from "./helpers/home.ts";

test("storage report breaks the home into sections and flags local-only exports", () => {
  const { home, cleanup } = fixtureHome("storage");
  try {
    write(`${home}/cache/cloud/proxies/drive/a.mp4`, Buffer.alloc(100));
    write(`${home}/projects/p1.json`, Buffer.alloc(10));
    const exported = `${home}/out.mp4`;
    write(exported, Buffer.alloc(50));
    fs.writeFileSync(`${home}/exports.json`, JSON.stringify({ p1: [{ path: exported, bytes: 50 }] }));
    const report = storageReport(home);
    expect(report.totalBytes).toBeGreaterThanOrEqual(160);
    expect(report.budgetBytes).toBeGreaterThan(0);
    expect(report.sections.find((s) => s.name === "cache")?.bytes).toBe(100);
    expect(report.exports).toEqual([{ path: exported, bytes: 50, missing: false, cloudKey: null, status: "local-only" }]);
  } finally { cleanup(); }
});

test("an export is confirmed only when the cloud object matches its size exactly", async () => {
  const { home, cleanup } = fixtureHome("storage-verify");
  try {
    const exported = `${home}/out.mp4`;
    write(exported, Buffer.alloc(50));
    fs.writeFileSync(`${home}/exports.json`, JSON.stringify({ p1: [{ path: exported, bytes: 50, cloudKey: "edit/exports/p1/out.mp4" }] }));
    expect(exportConfirmations(home)[0]!.status).toBe("confirmed");
    const ok = await verifyExports(home, async () => ({ size: 50 }));
    expect(ok[0]!.status).toBe("confirmed");
    const wrongSize = await verifyExports(home, async () => ({ size: 51 }));
    expect(wrongSize[0]!.status).toBe("local-only");
    const gone = await verifyExports(home, async () => null);
    expect(gone[0]!.status).toBe("local-only");
    const down = await verifyExports(home, async () => { throw new Error("offline"); });
    expect(down[0]!.status).toBe("local-only");
  } finally { cleanup(); }
});
