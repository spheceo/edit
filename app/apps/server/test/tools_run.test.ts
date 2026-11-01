// tools.run in Effect: its output, why it failed, a stuck tool ended at its time (its children too),
// a stop ending it, and each failure's kind.

import { expect, test } from "bun:test";

import { failureKind } from "../src/effect/proc.ts";
import { kindOf } from "../src/effect/service.ts";
import * as jobs from "../src/jobs.ts";
import { run } from "../src/tools.ts";
import { scratch } from "./helpers/home.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a tool's output comes back as bytes; a failure says its last line, and a missing tool says so", async () => {
  expect(new TextDecoder().decode(await run(["sh", "-c", "printf 'pcm'"]))).toBe("pcm");
  const failed = await run(["sh", "-c", "echo first >&2; echo 'Invalid data found when processing input' >&2; exit 1"]).catch((error: unknown) => error);
  expect((failed as Error).message).toBe("Invalid data found when processing input");
  expect(kindOf(failed)).toBe("permanent");
  await expect(run(["/no/such/ffmpeg"])).rejects.toThrow(/^ffmpeg is not available/);
});

test("a tool that runs past its time is ended with the children it started, and said to have timed out", async () => {
  const marker = `/tmp/tools-child-${process.pid}`;
  const failed = await run(["sh", "-c", `sleep 30 & echo $! > ${marker}; wait`], { timeoutMs: 300 }).catch((error: unknown) => error);
  expect((failed as { _tag: string })._tag).toBe("ProcessTimedOut");
  expect(kindOf(failed)).toBe("temporary");
  await Bun.sleep(300);
  expect(alive(Number((await Bun.file(marker).text()).trim()))).toBe(false);

  const stop = new AbortController();
  const running = run(["sh", "-c", `sleep 30 & echo $! > ${marker}-2; wait`], { signal: stop.signal });
  await Bun.sleep(300);
  stop.abort();
  await expect(running).rejects.toBeDefined();
  await Bun.sleep(300);
  expect(alive(Number((await Bun.file(`${marker}-2`).text()).trim()))).toBe(false);
});

test("a network read that dropped is temporary; a damaged file is permanent", () => {
  expect(failureKind("https://r2.example/x.mp4: Connection reset by peer")).toBe("temporary");
  expect(failureKind("Server returned 503 Service Unavailable")).toBe("temporary");
  expect(failureKind("[tcp @ 0x1] Connection timed out")).toBe("temporary");
  expect(failureKind("moov atom not found")).toBe("permanent");
  expect(failureKind("Invalid data found when processing input")).toBe("permanent");
});

test("a job that hangs as it's started again doesn't hold up the others", async () => {
  const { dir, cleanup } = scratch("jobs-resume");
  const before = jobs.RESUME_MS.value;
  jobs.RESUME_MS.value = 200;
  try {
    jobs.begin(dir, "export", "p1", {});
    jobs.begin(dir, "upload", "p2", {});
    jobs.begin(dir, "smooth", "p3", {});
    const started: string[] = [];
    await jobs.resume(dir, {
      export: () => new Promise(() => started.push("export")),
      upload: () => {
        started.push("upload");
        throw new Error("no file");
      },
      smooth: () => void started.push("smooth"),
    });
    expect(started).toEqual(["export", "upload", "smooth"]);
  } finally {
    jobs.RESUME_MS.value = before;
    cleanup();
  }
});
