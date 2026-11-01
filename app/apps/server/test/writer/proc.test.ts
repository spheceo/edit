import { expect, test } from "bun:test";
import { run } from "../../src/writer/proc.ts";

test("output, lines, failure, timeout, stop, and the whole group ended on stop", async () => {
  expect(await run("sh", ["-c", "echo hi; echo there"])).toBe("hi\nthere\n");
  const lines: string[] = [];
  await run("sh", ["-c", "printf 'a\\r\\nb\\rc\\nlast'"], { onLine: (line) => lines.push(line) });
  expect(lines).toEqual(["a", "b\rc", "last"]);
  await expect(run("sh", ["-c", "echo nope >&2; echo worse >&2; exit 3"])).rejects.toThrow("worse");
  await expect(run("/no/such/program", [])).rejects.toThrow("failed to start");
  await expect(run("sleep", ["5"], { timeoutMs: 200 })).rejects.toThrow("sleep took too long and was stopped.");
  expect(await run("cat", [], { stdin: "fed" })).toBe("fed");
  expect(await run("sh", ["-c", "echo $ONLY_THIS-$HOME"], { env: { ONLY_THIS: "x", PATH: process.env.PATH } })).toBe("x-\n");
  // A program with a child of its own (yt-dlp and its FFmpeg): a stop ends both.
  const marker = `/tmp/proc-child-${process.pid}`;
  const stop = new AbortController();
  const running = run("sh", ["-c", `sleep 30 & echo $! > ${marker}; wait`], { signal: stop.signal });
  await Bun.sleep(300);
  const child = Number((await Bun.file(marker).text()).trim());
  stop.abort();
  await expect(running).rejects.toThrow("Stopped by you. Completed work is saved.");
  await Bun.sleep(300);
  let alive = true;
  try { process.kill(child, 0); } catch { alive = false; }
  expect(alive).toBe(false);
});
