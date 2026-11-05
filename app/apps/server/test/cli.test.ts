import { expect, test } from "bun:test";

import * as nodePath from "node:path";

import { HELP, mcpText } from "../src/cli.ts";
import { VERSION } from "../src/version.ts";

const MAIN = nodePath.join(import.meta.dir, "../src/main.ts");

function edit(args: string[], env: Record<string, string> = {}) {
  // The words, not the terminal: a parent FORCE_COLOR makes Bun color console.error, and the help is compared byte for byte.
  const { FORCE_COLOR: _forced, ...plain } = process.env;
  const run = Bun.spawnSync([process.execPath, MAIN, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...plain, NO_COLOR: "1", ...env },
  });
  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

test("edit --version, help, mcp and refusals print what they should", () => {
  expect(edit(["--version"])).toEqual({ code: 0, stdout: `edit v${VERSION}\n`, stderr: "" });
  expect(edit(["-V"]).stdout).toBe(`edit v${VERSION}\n`);
  expect(edit(["help"]).stdout).toBe(HELP);
  expect(edit(["mcp", "--port", "7701"]).stdout).toBe(`${mcpText("7701")}\n`);
  expect(mcpText("7701")).toContain("claude mcp add --transport http edit http://127.0.0.1:7701/mcp");
  expect(edit(["nope"])).toEqual({ code: 2, stdout: "", stderr: `edit: unknown command nope\n\n${HELP}\n` });
  expect(edit(["serve", "--port", "x"])).toMatchObject({ code: 2, stderr: "edit: --port must be a number\n" });
  expect(edit(["cloud", "backfill", "../x"])).toMatchObject({
    code: 2,
    stderr: "edit: usage: edit cloud backfill <project id> [--port N]\n",
  });
  // A dev build never updates itself.
  expect(edit(["update"]).stdout).toBe(`This build of Edit (v${VERSION}) doesn't update itself; pull and rebuild.\n`);
}, 30_000);
