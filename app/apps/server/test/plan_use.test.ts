// plan_use.ts: the Claude plan's meter lined up with what spent it, Edit or
// not (Sphe, Nov 5: "see how much is used by what … and if something isn't
// even from Edit").

import { afterEach, beforeEach, expect, test } from "bun:test";

import * as fs from "node:fs";
import * as os from "node:os";

import * as claudeUsage from "../src/claude_usage.ts";
import { join } from "../src/paths.ts";
import * as planUse from "../src/plan_use.ts";
import { THIS_MACHINE } from "../src/machine.ts";

let home = "";
let projects = "";

beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), "plan-use-"));
  projects = join(home, "projects");
  fs.mkdirSync(projects);
  claudeUsage.use(home);
  planUse.use(home, projects);
  planUse.reset();
});

afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const T = Date.UTC(2026, 10, 5, 10, 0);
const MIN = 60_000;

function reply(id: string, at: number, cwd: string, model = "claude-opus-5-5", output = 1000, entrypoint = "cli"): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date(at).toISOString(),
    cwd,
    entrypoint,
    sessionId: "s",
    message: { id, model, role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
}

test("a message is priced from its tokens, a cache written for an hour at twice the input", () => {
  // Opus 5.5: $4 in, $20 out, $0.20 cache reads.
  expect(planUse.priceOf("claude-opus-5-5", { input_tokens: 1e6, output_tokens: 1e6 })).toBeCloseTo(24);
  expect(planUse.priceOf("claude-opus-5-5", { cache_read_input_tokens: 1e6 })).toBeCloseTo(0.2);
  expect(planUse.priceOf("claude-opus-5-5", { cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_1h_input_tokens: 1e6 } })).toBeCloseTo(8);
  expect(planUse.priceOf("claude-opus-5-5", { cache_creation_input_tokens: 1e6 })).toBeCloseTo(5);
  expect(planUse.priceOf("claude-sonnet-5-5", { output_tokens: 1e6 })).toBeCloseTo(10);
  expect(planUse.priceOf("claude-fable-5-1", { output_tokens: 1e6 })).toBeCloseTo(50);
  expect(planUse.priceOf("someone-else", { output_tokens: 1e6 })).toBe(0);
});

test("only an assistant's reply is a message; where it ran is said plainly", () => {
  const found = planUse.messageOf(reply("m1", T, join(os.homedir(), "code", "site")));
  expect(found?.[0]).toBe("m1");
  expect(found?.[1].source).toBe("Terminal in ~/code/site");
  expect(found?.[1].usd).toBeCloseTo(0.02004);
  expect(planUse.messageOf(JSON.stringify({ type: "user", message: { content: "usage" } }))).toBeNull();
  expect(planUse.messageOf(reply("m2", T, "/tmp", "<synthetic>"))).toBeNull();
  expect(planUse.sourceOf("sdk-ts", "/private/var/folders/bd/x/T/t3code-claude-title-7J8lgd")).toBe("an app on the Agent SDK in a temporary folder (t3code-claude-title)");
  expect(planUse.sourceOf("claude-desktop", "/Volumes/Work")).toBe("the Claude app in /Volumes/Work");
});

test("Claude Code outside Edit is read from its transcripts, a message once, Edit's own folders skipped, and only what's new read again", async () => {
  const outside = join(projects, "-Users-someone-code-site");
  fs.mkdirSync(outside);
  const ownSlug = home.replace(/[^A-Za-z0-9]/g, "-");
  fs.mkdirSync(join(projects, `${ownSlug}-agent-workspace`));
  fs.writeFileSync(join(projects, `${ownSlug}-agent-workspace`, "edit.jsonl"), reply("edit-1", T, join(home, "agent-workspace")) + "\n");
  const file = join(outside, "a.jsonl");
  // A reply's blocks are lines of their own, each with the reply's usage.
  fs.writeFileSync(file, [reply("o1", T - 30 * MIN, "/Users/someone/code/site"), reply("o1", T - 30 * MIN, "/Users/someone/code/site"), ""].join("\n"));
  await planUse.scan(T);
  expect(planUse.outsideBetween(T - 60 * MIN, T).map((message) => message.source)).toEqual(["Terminal in /Users/someone/code/site"]);
  // The session moves to another folder: it stays under the one it began in; a half-written line waits.
  fs.appendFileSync(file, reply("o2", T - 10 * MIN, "/Users/someone/code/site/src") + "\n" + reply("o3", T - 5 * MIN, "/x").slice(0, 40));
  await planUse.scan(T);
  const seen = planUse.outsideBetween(T - 60 * MIN, T);
  expect(seen.map((message) => message.source)).toEqual(["Terminal in /Users/someone/code/site", "Terminal in /Users/someone/code/site"]);
});

test("Edit's call is spread over the time it ran", () => {
  // A 20-minute build that cost $4, finished at T.
  claudeUsage.record("Claude opus writing the script", 4, T, 20 * MIN);
  expect(claudeUsage.spentBetween(T - 20 * MIN, T - 10 * MIN)).toBeCloseTo(2);
  expect(claudeUsage.spentBetween(T - 60 * MIN, T - 20 * MIN)).toBe(0);
  claudeUsage.record("Claude opus naming", 0.5, T);
  expect(claudeUsage.spentBetween(T - MIN, T)).toBeCloseTo(0.5 + 0.2);
});

test(`each rise of the 5-hour meter goes to what spent meanwhile: Edit, other Claude Code here, or nothing on ${THIS_MACHINE}`, async () => {
  const resets = new Date(T + 4 * 60 * MIN).toISOString();
  const at = (minutes: number, five: number, nextWindow = false) =>
    planUse.keep({ at: T + minutes * MIN, five, fiveResets: nextWindow ? new Date(T + 9 * 60 * MIN).toISOString() : resets, week: 20, weekResets: null, split: { "Claude Code": 90, Chats: 10 } });
  at(0, 10);
  at(15, 20); // Edit: $10 in this stretch
  at(30, 25); // Terminal: $5
  at(45, 30); // nothing on this Mac
  claudeUsage.record("Claude opus writing the script", 10, T + 14 * MIN, 10 * MIN);
  const outside = join(projects, "-Users-someone-code-site");
  fs.mkdirSync(outside);
  fs.writeFileSync(join(outside, "a.jsonl"), reply("o1", T + 20 * MIN, "/Users/someone/code/site", "claude-opus-5-5", 250_000) + "\n");
  await planUse.scan(T + 50 * MIN);
  const split = planUse.attribute(planUse.stretches(T - MIN, T + 50 * MIN));
  expect(split.rose).toBe(20);
  expect(split.edit).toBeCloseTo(10);
  expect(split.outside).toBeCloseTo(5);
  expect(split.nothing).toBe(5);
  expect(split.nothingStretches).toBe(1);
  // $15 moved the meter 15 points: a window holds about $100.
  expect(split.window).toBeCloseTo(100, 0);
  // A new window counts from 0.
  at(60, 4, true);
  expect(planUse.stretches(T + 44 * MIN, T + 61 * MIN)[0]?.rose).toBe(4);
  const lines = await planUse.reportLines(8, T + 61 * MIN);
  expect(lines[0]).toContain("5-hour 4%");
  expect(lines[0]).toContain("Claude Code 90%, Chats 10%");
  expect(lines.join("\n")).toContain(`nothing running on ${THIS_MACHINE}`);
  expect(lines.join("\n")).toContain("Terminal in /Users/someone/code/site $5.00 ×1 (opus-5-5)");
  expect(planUse.timeline(24, T + 61 * MIN).filter((line) => line.endsWith(`← nothing on ${THIS_MACHINE}`))).toHaveLength(2);
});

test("a resumed session's cost counts only what it added: Claude Code's total is the session's so far", () => {
  // JJ's Mac, Nov 5: one chat's turns read $15.85, $16.02, $16.16 … each counted whole.
  expect(claudeUsage.record("edit chat claude-sonnet-5-5", 15.85, T, 0, "chat-1")).toBeCloseTo(15.85);
  expect(claudeUsage.record("edit chat claude-sonnet-5-5", 16.02, T + MIN, 0, "chat-1")).toBeCloseTo(0.17);
  expect(claudeUsage.record("Claude opus writing section 1 of 8", 2.5, T + MIN, 0, "section-1")).toBeCloseTo(2.5);
  // Kept across a restart; a session counting afresh (a total lower than before) counts whole.
  claudeUsage.use(home);
  expect(claudeUsage.record("edit chat claude-sonnet-5-5", 16.16, T + 2 * MIN, 0, "chat-1")).toBeCloseTo(0.14);
  expect(claudeUsage.record("edit chat claude-sonnet-5-5", 0.4, T + 3 * MIN, 0, "chat-1")).toBeCloseTo(0.4);
  expect(claudeUsage.daysKept().at(-1)?.rows.find(([label]) => label.startsWith("edit chat"))?.[1]).toBeCloseTo(15.85 + 0.17 + 0.14 + 0.4);
});

test("a reset time a little different at each reading is the same window, not a new one", () => {
  // JJ's Mac, Nov 5: 15:20:00.179913, 15:20:00.070624, 15:19:59.887857: each counted as a new window, 533% in a day.
  const keep = (minutes: number, five: number, resets: string) => planUse.keep({ at: T + minutes * MIN, five, fiveResets: resets, week: 20, weekResets: null, split: null });
  keep(0, 32, "2026-11-05T15:20:00.179913+00:00");
  keep(15, 40, "2026-11-05T15:20:00.070624+00:00");
  keep(30, 44, "2026-11-05T15:19:59.887857+00:00");
  expect(planUse.stretches(T - MIN, T + 31 * MIN).map((stretch) => stretch.rose)).toEqual([8, 4]);
});
