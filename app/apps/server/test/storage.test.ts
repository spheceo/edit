import { expect, test } from "bun:test";
import * as fs from "node:fs";

import { exportConfirmations, localBudgetBytes, storageReport, verifyExports } from "../src/storage.ts";
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

test("migrateMediaFiles deletes only size-verified copies with a known cloud original", async () => {
  const { migrateMediaFiles } = await import("../src/storage.ts");
  const { dir, cleanup } = fixtureHome("migrate");
  try {
    const verified = `${dir}/a.mp4`; write(verified, Buffer.alloc(10));
    const wrong = `${dir}/b.mp4`; write(wrong, Buffer.alloc(10));
    const unknown = `${dir}/c.mp4`; write(unknown, Buffer.alloc(10));
    const keys = new Map([[verified, "edit/originals/sha256/a/a.mp4"], [wrong, "edit/originals/sha256/b/b.mp4"]]);
    const head = async (key: string) => ({ size: key.endsWith("a/a.mp4") ? 10 : 11 });
    const dry = await migrateMediaFiles([verified, wrong, unknown], (p) => keys.get(p) ?? null, head, true);
    expect(dry.deletedBytes).toBe(10);
    expect(fs.existsSync(verified)).toBe(true);
    const done = await migrateMediaFiles([verified, wrong, unknown], (p) => keys.get(p) ?? null, head, false);
    expect(done.deleted).toEqual([verified]);
    expect(done.kept.length).toBe(2);
    expect(fs.existsSync(verified)).toBe(false);
    expect(fs.existsSync(wrong)).toBe(true);
    expect(fs.existsSync(unknown)).toBe(true);
  } finally { cleanup(); }
});

test("the cache's budget is a quarter of the disk's room, 400 MB to 50 GB, leaving 1 GB free; EDIT_CACHE_BUDGET_MB overrides", () => {
  const was = process.env.EDIT_CACHE_BUDGET_MB;
  delete process.env.EDIT_CACHE_BUDGET_MB;
  try {
    const GB = 1e9;
    // This M1 on Nov 2: 15 GB free, a 6.7 GB cache.
    expect(localBudgetBytes({ freeBytes: 15 * GB, cacheBytes: 6.7 * GB })).toBe(Math.floor(21.7 * GB * 0.25));
    expect(localBudgetBytes({ freeBytes: 0.2 * GB, cacheBytes: 0 })).toBe(400_000_000);
    expect(localBudgetBytes({ freeBytes: 1000 * GB, cacheBytes: 0 })).toBe(50 * GB);
    expect(localBudgetBytes()).toBe(400_000_000);
    process.env.EDIT_CACHE_BUDGET_MB = "1234";
    expect(localBudgetBytes({ freeBytes: 15 * GB, cacheBytes: 0 })).toBe(1_234_000_000);
  } finally {
    if (was === undefined) delete process.env.EDIT_CACHE_BUDGET_MB;
    else process.env.EDIT_CACHE_BUDGET_MB = was;
  }
});
