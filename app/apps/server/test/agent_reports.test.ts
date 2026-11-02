import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as nodePath from "node:path";

import { forgetFiled, hooks, problemFrom } from "../src/agent_reports.ts";
import { dispatch } from "../src/mcp/index.ts";
import { fixtureHome } from "./helpers/home.ts";

test("report_problem files the failure with the diagnostics, once a day per tool and error", async () => {
  const { app, cleanup } = fixtureHome("agent-reports");
  forgetFiled();
  hooks.diagnostics = async () => "Diagnostics with the agent's report.\nNeeds attention:\nnothing found";
  try {
    const id = app.store.create("Kroger", { width: 1920, height: 1080, fps: 30 }).project.id;
    const call = async (args: Record<string, unknown>) =>
      ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "report_problem", arguments: { project_id: id, ...args } } }, null)) as { result: { content: { text: string }[]; isError: boolean } }).result;
    const args = { tool: "place_label", error: "place_label needs map: the map's clip id", asked: '{"text":"Kroger"}', instead: "nothing: the label is left out" };
    // Not signed in here: kept on this Mac, and said so.
    const first = await call(args);
    expect(first.isError).toBe(false);
    expect(first.content[0]!.text).toStartWith("couldn't send it to the team (Sign in to Edit to send a report.); kept on this Mac at ");
    const dir = nodePath.join(app.store.home, "reports-sent");
    const [file] = fs.readdirSync(dir);
    const kept = fs.readFileSync(nodePath.join(dir, file!), "utf8");
    expect(kept).toStartWith(`Filed by the in-app agent on "Kroger" (${id}).\nTool: place_label\nError: place_label needs map: the map's clip id\nAsked: {"text":"Kroger"}\nDid instead: nothing: the label is left out\n`);
    expect(kept).toContain("Needs attention:");
    // The same wall again: nothing new filed.
    expect((await call(args)).content[0]!.text).toStartWith("already reported today");
    expect(fs.readdirSync(dir)).toHaveLength(1);
    expect((await call({ tool: "Place Label", error: "x" })).content[0]!.text).toBe("tool: the name of the tool that failed (map_view, place_label…)");
    expect(problemFrom({ tool: "map_view" })).toBe("error: what the tool said, word for word");
  } finally {
    cleanup();
  }
});
