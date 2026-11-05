// last_run.ts's tests: a run that didn't quit is said at the next start, with macOS's crash report for it.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import * as diag from "../src/diag.ts";
import * as lastRun from "../src/last_run.ts";

/** A crash report as macOS writes one: a header line, then the report. */
function report(pid: number): string {
  const header = JSON.stringify({ app_name: "edit", bug_type: "309", name: "edit" });
  const body = {
    pid,
    procName: "edit",
    exception: { type: "EXC_CRASH", signal: "SIGABRT" },
    termination: { indicator: "Abort trap: 6" },
    asi: { "libsystem_c.dylib": ["abort() called"] },
    faultingThread: 1,
    usedImages: [{ name: "libsystem_kernel.dylib" }, { name: "edit-native.node" }, { name: "edit" }],
    threads: [
      { frames: [{ imageIndex: 2, symbol: "main" }] },
      { frames: [{ imageIndex: 0, symbol: "__pthread_kill" }, { imageIndex: 1, symbol: "edit_engine::mix::render_kept" }, { imageIndex: 2, imageOffset: 4096 }] },
    ],
  };
  return `${header}\n${JSON.stringify(body)}`;
}

const said = () => diag.lines(50).filter((line) => line.message.includes("stopped without quitting")).map((line) => line.message);

test("a run that didn't quit is said at the next start, with its crash; one that quit, or execs in place, isn't", () => {
  const home = fs.mkdtempSync(join(os.tmpdir(), "last-run-"));
  const reports = join(home, "reports");
  fs.mkdirSync(reports);
  try {
    const before = said().length;
    // The first start: nothing to say.
    lastRun.begin(home, reports);
    expect(said().length).toBe(before);
    const mark = join(home, "logs", "running.json");
    expect(JSON.parse(fs.readFileSync(mark, "utf8")).pid).toBe(process.pid);
    // An update's restart execs in place: the same process, not a stop.
    lastRun.begin(home, reports);
    expect(said().length).toBe(before);
    // Quit: the mark goes.
    lastRun.quitting();
    expect(fs.existsSync(mark)).toBe(false);
    lastRun.begin(home, reports);
    expect(said().length).toBe(before);
    // Another process's mark left behind, and macOS's report of its crash (an older report of the same pid isn't it).
    fs.writeFileSync(mark, JSON.stringify({ pid: 4242, started: Date.now() - 60_000, build: "nightly-58" }));
    fs.writeFileSync(join(reports, "edit-2026-11-06-030721.ips"), report(4242));
    fs.writeFileSync(join(reports, "edit-2026-11-01-000000.ips"), report(4242));
    fs.utimesSync(join(reports, "edit-2026-11-01-000000.ips"), new Date(Date.now() - 86_400_000), new Date(Date.now() - 86_400_000));
    lastRun.begin(home, reports);
    const lines = said().slice(before);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("the last run (nightly-58, started");
    expect(lines[0]).toContain("EXC_CRASH SIGABRT; abort() called; at edit_engine::mix::render_kept in edit-native.node < +0x1000 in edit (edit-2026-11-06-030721.ips)");
    // No report: said as such.
    fs.writeFileSync(mark, JSON.stringify({ pid: 4343, started: Date.now(), build: "nightly-58" }));
    lastRun.begin(home, reports);
    expect(said().at(-1)).toContain("macOS kept no crash report for it");
  } finally {
    lastRun.quitting();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a run macOS stopped for memory is said so", () => {
  const reports = fs.mkdtempSync(join(os.tmpdir(), "jetsam-"));
  try {
    const event = { processes: [{ pid: 7, name: "edit" }, { pid: 9, name: "edit", reason: "per-process-limit" }] };
    fs.writeFileSync(join(reports, "JetsamEvent-2026-11-06-030721.ips"), `{"bug_type":"298"}\n${JSON.stringify(event)}`);
    expect(lastRun.crashOf(reports, 9, 0)).toBe("macOS stopped it for memory (per-process-limit) (JetsamEvent-2026-11-06-030721.ips)");
    // Listed but not stopped by it.
    expect(lastRun.crashOf(reports, 7, 0)).toBeNull();
  } finally {
    fs.rmSync(reports, { recursive: true, force: true });
  }
});
