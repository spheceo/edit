// Takes the MCP tool list and instructions from a running Rust server, so the
// TS server's schemas and text match by construction (plan §0, "MCP"):
//
//     edit serve --home "$(mktemp -d)" --port 7811 &
//     bun apps/server/scripts/dump-tools.ts http://127.0.0.1:7811
//
// Writes src/mcp/tools.json (tools/list's `tools`, keys as serde wrote them:
// sorted) and src/mcp/instructions.ts (initialize's `instructions`).

import * as fs from "node:fs";
import * as path from "node:path";

const base = process.argv[2] ?? "http://127.0.0.1:7811";
const dir = path.join(import.meta.dir, "../src/mcp");

async function rpc(method: string, params: unknown = {}): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method}: ${response.status} ${await response.text()}`);
  const answer = (await response.json()) as { result?: Record<string, unknown>; error?: unknown };
  if (answer.result === undefined) throw new Error(`${method}: ${JSON.stringify(answer.error)}`);
  return answer.result;
}

const tools = (await rpc("tools/list")).tools as unknown[];
const init = await rpc("initialize", { protocolVersion: "2025-06-18" });
const instructions = init.instructions as string;

fs.writeFileSync(path.join(dir, "tools.json"), `${JSON.stringify(tools, null, 2)}\n`);

// A template literal keeps the text readable; only backslashes, backticks and
// `${` need escaping.
const escaped = instructions.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
fs.writeFileSync(
  path.join(dir, "instructions.ts"),
  `// The MCP server's instructions (mcp.rs INSTRUCTIONS), taken from the Rust server by
// scripts/dump-tools.ts: the core house style every agent gets at initialize.
// Edit the Rust original while it's the parity reference, then dump again.

export const INSTRUCTIONS = \`${escaped}\`;
`,
);
console.log(`${tools.length} tools, ${instructions.length} characters of instructions from ${base}`);
