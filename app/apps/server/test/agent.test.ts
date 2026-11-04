// agent.ts's own helpers: a ready status kept a while, tool arguments in one
// line, and which failures are a busy model's. The turns themselves are
// claude.test.ts's.

import { expect, test } from "bun:test";

import { busyModel, READY_FOR_MS, stillReady, summarizeArgs } from "../src/agent.ts";

test("a_ready_status_is_kept_for_a_while", () => {
  const found = 1000;
  const status = { ready: true, state: "ready" };
  const cached: [number, unknown] = [found, status];
  expect(stillReady(cached, found)).toEqual(status);
  expect(stillReady(cached, found + READY_FOR_MS - 1000)).toEqual(status);
  expect(stillReady(cached, found + READY_FOR_MS)).toBeNull();
  expect(stillReady(null, found)).toBeNull();
});

test("tool arguments read as one short line; a busy model is tried again", () => {
  expect(summarizeArgs({ text: "Your title", start: 2, project_id: "p" })).toBe("start: 2 · text: Your title");
  expect(summarizeArgs("x")).toBe("");
  expect(summarizeArgs({ a: "x".repeat(200), b: "y".repeat(200) }).length).toBe(129);
  expect(summarizeArgs({ a: "x".repeat(200), b: "y".repeat(200), c: "z".repeat(10) })).toBe(`a: ${"x".repeat(60)} · b: ${"y".repeat(60)} · c: zzzzz…`);
  expect(busyModel("The model is at capacity")).toBe(true);
  expect(busyModel('API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}')).toBe(true);
  expect(busyModel("API Error: 529 overloaded_error")).toBe(true);
  expect(busyModel("API Error: Connection error.")).toBe(true);
  expect(busyModel("stream disconnected before completion")).toBe(true);
  expect(busyModel("Invalid request")).toBe(false);
  expect(busyModel("Claude Code stopped: it reached its limit of turns.")).toBe(false);
  expect(busyModel("prompt is too long: 1500000 tokens")).toBe(false);
});
