// A live turn's "Working for _" (agentTurns.ts): when it shows, and how it reads.

import { expect, test } from "vitest";

import type { AgentEntry } from "./agent";
import { buildTurns, callTitle, editWorked, formatSpan, formatWorking, groupSummary, isWorking, shortSpan, shownText, thinkingWord } from "./agentTurns";

test("a turn is working once it calls a tool or a few seconds in", () => {
  expect(isWorking(1200, false)).toBe(false);
  expect(isWorking(1200, true)).toBe(true);
  expect(isWorking(5000, false)).toBe(true);
});

test("a picture's placeholder text is not shown; its words are", () => {
  expect(shownText("[Image: image.png; ref=image_c0a2255e-e6ec-4af2-9baf-0b98ead27093]")).toBe("");
  expect(shownText("Use this one [Image: a.jpg; ref=x]\n\nand make it pop")).toBe("Use this one\n\nand make it pop");
  expect(shownText("An [Image] is worth a thousand words")).toBe("An [Image] is worth a thousand words");
});

test("a live thumbnail turn shows reasoning between the words and the tool still running", () => {
  const entries: AgentEntry[] = [
    { id: "u", kind: "user", text: "Lighten him", at: 1 },
    { id: "think", kind: "thinking", text: "The officer is still too dark.", status: "done", at: 2 },
    { id: "said", kind: "assistant", text: "I'm still on it.", at: 3 },
    { id: "tool", kind: "tool", tool: "make_picture", text: "Lighten him", status: "running", at: 4 },
    { id: "again", kind: "thinking", text: "", status: "running", at: 5 },
  ];
  const turn = buildTurns(entries, true)[0]!;
  expect(turn.live).toBe(true);
  expect(turn.parts.map((part) => part.kind)).toEqual(["thinking", "entry", "group", "thinking"]);
  const running = turn.parts.find((part) => part.kind === "group");
  expect(running?.kind === "group" && running.calls[0]?.status).toBe("running");
  expect(callTitle({ id: "tool", kind: "tool", tool: "make_picture", text: "", status: "running" })).toBe("Making a picture on OpenArt");
  expect(callTitle({ id: "tool", kind: "tool", tool: "Read", text: "", status: "done" })).toBe("Looked at a picture");
  expect(groupSummary([
    { id: "a", kind: "tool", tool: "Read", text: "" },
    { id: "b", kind: "tool", tool: "Read", text: "" },
    { id: "c", kind: "tool", tool: "Read", text: "" },
    { id: "d", kind: "tool", tool: "make_picture", text: "" },
  ])).toBe("Looked at 3 pictures, made a picture");
});

test("working reads to the second", () => {
  expect(formatWorking(8400)).toBe("Working for 8s");
  expect(formatWorking(72_000)).toBe("Working for 1m 12s");
  expect(formatWorking(3_840_000)).toBe("Working for 1h 4m");
  expect(formatWorking(-50)).toBe("Working for 0s");
});

test("an edit's agent time adds up every turn, the live one to now, and none of the waits between", () => {
  // JJ, Nov 3: "Is it possible to get some kind of tracker on how long each edit takes?"
  const at = (id: string, kind: "user" | "tool" | "assistant", ms: number, updated = ms) => ({ id, kind, text: "", at: ms, updated }) as never;
  const entries = [
    at("u1", "user", 0), at("t1", "tool", 1000, 20 * 60_000), at("a1", "assistant", 25 * 60_000),
    // An hour later: an automatic follow-up.
    at("u2", "user", 90 * 60_000), at("t2", "tool", 91 * 60_000, 100 * 60_000),
  ];
  expect(editWorked(buildTurns(entries, false), 0)).toEqual({ ms: 35 * 60_000, turns: 2 });
  // The second still running: counted to now.
  expect(editWorked(buildTurns(entries, true), 110 * 60_000)).toEqual({ ms: 45 * 60_000, turns: 2 });
  expect(formatSpan(45 * 60_000)).toBe("45m");
  expect(formatSpan(72 * 60_000)).toBe("1h 12m");
  expect(formatSpan(8_000)).toBe("8s");
});

test("between its steps Claude's word moves on every few seconds, not the same Thinking", () => {
  const first = thinkingWord(0, 0);
  expect(thinkingWord(0, 3000)).toBe(first);
  expect(thinkingWord(0, 3600)).not.toBe(first);
  expect(new Set(Array.from({ length: 30 }, (_, step) => thinkingWord(0, step * 3500))).size).toBeGreaterThan(10);
  expect(shortSpan(72_000)).toBe("1m 12s");
});
