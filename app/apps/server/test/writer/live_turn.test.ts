import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import * as chat from "../../src/writer/chat.ts";
import * as live from "../../src/writer/live.ts";

// The user, Oct 30: the script's chat as Repack's, with the tools Claude ran.
// A job's turn collects Claude's words and tools; its answer keeps the tools
// and how long it worked, and a run that failed is saved as stopped early.
test("a job's turn records its tools and the answer keeps them", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "edit-live-turn-"));
  const turn: live.Turn = { text: "", trace: [], startedAt: Date.now() - 65_000 };
  await live.within(turn, async () => {
    live.said("Reading the plan first.");
    live.tool({ id: "a", tool: "read_plan", label: "", state: "running" });
    live.tool({ id: "b", tool: "set_outline", label: "", state: "running" });
    live.tool({ id: "a", label: "", state: "done", detail: "12 sections" });
    live.said("Now the sections.");
    live.tool({ id: "c", tool: "add_section", label: "", state: "running" });
    expect(turn.trace.map((group) => group.calls.map((call) => call.tool))).toEqual([["read_plan", "set_outline"], ["add_section"]]);
    expect(turn.trace[0]!.calls[0]).toMatchObject({ state: "done", detail: "12 sections", tool: "read_plan" });
    chat.add(dir, "editor", "Built the script.", 1.2);
  });
  const saved = chat.read(dir).at(-1)!;
  expect(saved.trace?.length).toBe(1);
  expect(saved.trace?.flatMap((group) => group.calls.map((call) => call.state))).toEqual(["done", "done", "done"]);
  expect(saved.workedMs).toBeGreaterThanOrEqual(65_000);
  expect(saved.partial).toBeUndefined();

  await live.within({ text: "", trace: [], startedAt: Date.now() }, async () => {
    live.tool({ id: "d", tool: "add_section", label: "", state: "running" });
    chat.add(dir, "editor", "Claude stopped: \"Stopped by you.\"", null, true);
  });
  const stopped = chat.read(dir).at(-1)!;
  expect(stopped.partial).toBe(true);
  expect(stopped.trace?.[0]?.calls[0]?.state).toBe("error");
});

test("a tool's row says what it did, not what it tells Claude next", () => {
  expect(live.detailOf("Outline set: 6 sections. End your turn now.")).toBe("Outline set: 6 sections.");
  expect(live.detailOf("5 added (5 items in the plan now):\n- clip 1")).toBe("5 added (5 items in the plan now)");
  expect(live.detailOf("Saved. The script is done: end your turn now.")).toBe("Saved.");
  expect(live.detailOf('{"items": []}')).toBeUndefined();
});
