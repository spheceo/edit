import { expect, test } from "bun:test";

import { dispatch, INSTRUCTIONS, registerTool, targetProject, text, toolReference, TOOLS } from "../src/mcp/index.ts";
import { handlerFor, unregisterTool, unported } from "../src/mcp/registry.ts";
import { stableStringify } from "../src/stable.ts";
import { fixtureHome } from "./helpers/home.ts";

test("a_scoped_chat_reads_another_project_but_never_edits_it_or_answers_for_it", () => {
  const own = "p1";
  expect(targetProject(own, null, "apply_edit_plan")).toBe(own);
  expect(targetProject(own, "p1", "apply_edit_plan")).toBe(own);
  expect(targetProject(own, "", "get_edit_context")).toBe(own);
  // Reading the reference edit reads the reference, not its own project.
  expect(targetProject(own, "p2", "get_edit_context")).toBe("p2");
  expect(targetProject(own, "p2", "get_project")).toBe("p2");
  let refused = "";
  try {
    targetProject(own, "p2", "apply_edit_plan");
  } catch (error) {
    refused = (error as Error).message;
  }
  expect(refused).toContain("p1");
  expect(refused).toContain("p2");
  // Unscoped (an outside MCP client): whatever it names.
  expect(targetProject(null, "p2", "delete_clips")).toBe("p2");
  expect(targetProject(null, null, "delete_clips")).toBeNull();
});

test("tool_reference_is_one_short_line_per_tool", () => {
  const reference = toolReference();
  expect(reference.trimEnd().split("\n").length).toBe(TOOLS.length);
  expect(reference).toContain("- apply_edit_plan(base_rev: integer, operations: array, ");
  expect(reference.length).toBeLessThan(16_000);
});

test("the tools and instructions are the Rust server's", () => {
  expect(TOOLS.length).toBe(56);
  for (const tool of TOOLS) {
    expect(tool.inputSchema.type).toBe("object");
    // Every tool takes project_id, as mcp.rs's `tool` adds it.
    expect(tool.inputSchema.properties.project_id).toEqual({
      description: "Defaults to the project open in the UI.",
      type: "string",
    });
  }
  expect(INSTRUCTIONS.startsWith("Edit is a local video editor.")).toBe(true);
  expect(INSTRUCTIONS).toContain("- final-pass: The last review of a whole edit and the fixes it finds.");
  expect(unported()).not.toContain("list_projects");
});

// While the Rust server is the parity reference, its mcp.rs is where tools are
// written; tools.json and instructions.ts are dumped from it
// (scripts/dump-tools.ts). This catches an edit there that wasn't dumped again.
const MCP_RS = `${import.meta.dir}/../../../crates/edit/src/mcp.rs`;

test.skipIf(!(await Bun.file(MCP_RS).exists()))("tools.json and the instructions match mcp.rs", async () => {
  const source = await Bun.file(MCP_RS).text();
  for (const tool of TOOLS) {
    expect(source).toContain(`"${tool.name}"`);
    // Rust string escapes are JSON's for what descriptions use (\" and \\).
    expect(source).toContain(JSON.stringify(tool.description).slice(1, -1));
  }
  const start = source.indexOf('pub const INSTRUCTIONS: &str = r#"') + 'pub const INSTRUCTIONS: &str = r#"'.length;
  expect(source.slice(start, source.indexOf('"#;', start))).toBe(INSTRUCTIONS);
});

test("JSON-RPC: initialize, ping, tools/list, notifications and unknown methods", async () => {
  const { app, cleanup } = fixtureHome("mcp-rpc");
  try {
    const init = (await dispatch(app, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, null)) as {
      result: { protocolVersion: string; serverInfo: { name: string }; instructions: string; capabilities: unknown };
    };
    expect(init.result.protocolVersion).toBe("2025-03-26");
    expect(init.result.serverInfo.name).toBe("edit");
    expect(init.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(init.result.instructions).toBe(INSTRUCTIONS);
    const old = (await dispatch(app, { id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }, null)) as {
      result: { protocolVersion: string };
    };
    expect(old.result.protocolVersion).toBe("2025-06-18");
    expect(await dispatch(app, { id: "x", method: "ping" }, null)).toEqual({ jsonrpc: "2.0", id: "x", result: {} });
    expect(await dispatch(app, { method: "notifications/initialized" }, null)).toBeNull();
    expect(await dispatch(app, { id: 3, method: "resources/list" }, null)).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32601, message: "unknown method resources/list" },
    });
    const listed = (await dispatch(app, { id: 4, method: "tools/list" }, null)) as { result: { tools: unknown[] } };
    expect(listed.result.tools).toEqual(TOOLS);
  } finally {
    cleanup();
  }
});

test("tools/call: the project preamble, errors as content, and registered handlers", async () => {
  const { app, store, cleanup } = fixtureHome("mcp-call");
  try {
    const call = async (name: string, args: Record<string, unknown> = {}, scope: string | null = null) =>
      (await dispatch(app, { id: 1, method: "tools/call", params: { name, arguments: args } }, scope)) as {
        result: { content: { type: string; text: string }[]; isError: boolean };
      };
    // No projects yet: list_projects still answers; anything else says why.
    expect((await call("list_projects")).result).toEqual({ content: [{ type: "text", text: "[]" }], isError: false });
    expect((await call("get_edit_context")).result).toEqual({
      content: [{ type: "text", text: "no projects yet; create one in the UI first" }],
      isError: true,
    });
    const id = store.create("p", { width: 1920, height: 1080, fps: 30 }).project.id;
    // A declared tool no package has registered yet says so (packages register theirs as they land).
    const waiting = unported()[0];
    if (waiting !== undefined) expect((await call(waiting)).result.content[0]!.text).toBe(`${waiting} is not ported yet`);
    expect((await call("no_such_tool")).result.content[0]!.text).toBe("unknown tool no_such_tool");
    expect((await call("delete_clips", { project_id: "p2" }, id)).result.content[0]!.text).toBe(
      `this chat works on project ${id} only: delete_clips can't touch p2 (get_edit_context and get_project can read it)`,
    );
    // These tools' own handlers (WP7's) step aside while the test's stand in.
    const own = new Map(["markers", "tidy_tracks"].map((name) => [name, handlerFor(name)]));
    for (const name of own.keys()) unregisterTool(name);
    registerTool("markers", ({ projectId, args }) => text(stableStringify({ project: projectId, args })));
    try {
      expect((await call("markers", { b: 1, a: 2 })).result).toEqual({
        content: [{ type: "text", text: `{"args":{"a":2,"b":1},"project":"${id}"}` }],
        isError: false,
      });
      expect(() => registerTool("markers", () => [])).toThrow("tool markers is registered twice");
    } finally {
      unregisterTool("markers");
    }
    expect(() => registerTool("not_declared", () => [])).toThrow("tool not_declared isn't declared in tools.json");
    // A bug in a tool is reported as one, and the server carries on.
    registerTool("tidy_tracks", () => {
      const nothing = undefined as unknown as { here: string };
      return text(nothing.here);
    });
    try {
      const crashed = (await call("tidy_tracks")).result;
      expect(crashed.isError).toBe(true);
      expect(crashed.content[0]!.text).toMatch(/^tool tidy_tracks crashed \(.*\); this is a bug in Edit$/);
    } finally {
      unregisterTool("tidy_tracks");
      for (const [name, before] of own) {
        if (before !== undefined) registerTool(name, before.handler, { noProject: before.noProject });
      }
    }
  } finally {
    cleanup();
  }
});

test("stableStringify sorts keys at every depth, as serde_json's maps", () => {
  expect(stableStringify({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null }, "10": 0, "2": 0 })).toBe(
    '{"10":0,"2":0,"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}',
  );
  expect(stableStringify({ b: [], a: {} }, 2)).toBe('{\n  "a": {},\n  "b": []\n}');
  expect(stableStringify({ a: undefined, b: [undefined] })).toBe('{"b":[null]}');
});
